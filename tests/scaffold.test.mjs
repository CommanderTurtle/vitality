import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repository, "dist", "cli.js");
const fixtures = path.join(repository, "tests", "fixtures");

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function allFiles(directory) {
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) result.push(path.relative(directory, absolute).split(path.sep).join("/"));
    }
  }
  return result.sort();
}

test("give creates an uninstalled TypeScript/Vite source project", { timeout: 30_000 }, async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality [literal] "));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source + regex[.]safe");
  await cp(path.join(fixtures, "standalone"), source, { recursive: true });
  await writeFile(
    path.join(source, "src", "large.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(7000)}--><rect width="10" height="10"/></svg>`,
  );

  const created = run(process.execPath, [
    cli, "give", "--dir", source, "--base", "/project", "--inline", "yes",
  ], repository);
  assert.match(created.stdout, /dependencies not installed/u);
  assert.match(created.stdout, /dist\s+not built/u);
  const wrapper = path.join(source, "mywrap");
  await assert.rejects(stat(path.join(wrapper, "dist")));
  await assert.rejects(stat(path.join(wrapper, "node_modules")));

  const main = await readFile(path.join(wrapper, "src", "main.ts"), "utf8");
  assert.match(main, /import "\.\/app\/src\/main\.ts"/u);
  await stat(path.join(wrapper, "src", "app", "src", "main.ts"));
  await stat(path.join(wrapper, "src", "app", "src", "style.css"));
  await stat(path.join(wrapper, "src", "app", "src", "helper.mts"));
  await stat(path.join(wrapper, "src", "app", "src", "component.tsx"));
  await assert.rejects(stat(path.join(wrapper, "src", "app", "src", "main.js")));
  await stat(path.join(wrapper, "nested", "index.html"));
  await assert.rejects(stat(path.join(wrapper, "orphan", "index.html")));
  await stat(path.join(wrapper, "src", "app", "nested", "nested.ts"));
  await stat(path.join(wrapper, "public", "runtime", "manifest", "index.json"));
  await stat(path.join(wrapper, "public", "runtime", "manifest", "child.json"));
  await stat(path.join(wrapper, "src", "app", "runtime", "data.json"));
  await assert.rejects(stat(path.join(wrapper, ".env.private")));
  const convertedModule = await readFile(path.join(wrapper, "src", "app", "src", "main.ts"), "utf8");
  assert.match(convertedModule, /import\.meta\.env\.BASE_URL/u);

  const packageFile = JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(packageFile.scripts.serve, "vite");
  assert.equal(packageFile.scripts.build, "vite build");
  assert.equal(packageFile.vitality.base, "/project/");
  assert.equal(packageFile.vitality.assetsInlineLimit, "Infinity");
  assert.equal(packageFile.vitality.pages, 1);
  const config = await readFile(path.join(wrapper, "vite.config.ts"), "utf8");
  assert.match(config, /assetsInlineLimit: Number\.POSITIVE_INFINITY/u);
  assert.doesNotMatch(config, /preserve|copyFile|standalone/iu);

  run("bun", ["install"], wrapper);
  run("bun", ["run", "build"], wrapper);
  const built = await allFiles(path.join(wrapper, "dist"));
  assert.ok(built.includes("index.html"));
  assert.ok(built.includes("nested/index.html"));
  assert.equal(built.includes("orphan/index.html"), false);
  assert.equal(built.some((file) => file.endsWith(".md")), false);
  assert.ok(built.includes("runtime/manifest/index.json"));
  assert.ok(built.includes("runtime/manifest/child.json"));
  assert.match(await readFile(path.join(wrapper, "dist", "index.html"), "utf8"), /\/project\/assets\//u);
  const builtJavaScript = (await Promise.all(
    built.filter((file) => file.endsWith(".js"))
      .map((file) => readFile(path.join(wrapper, "dist", file), "utf8")),
  )).join("\n");
  assert.match(builtJavaScript, /data:image\/svg\+xml/u);
});

test("single-page output is one index, one JavaScript, and one CSS file", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-single-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "configured");
  const wrapper = path.join(temporaryRoot, "new", "nested", "output");
  await cp(path.join(fixtures, "configured"), source, { recursive: true });

  run(process.execPath, [
    cli, "give", "--dir", source, "--output", wrapper, "--base", "/", "--no-inline",
  ], repository);
  const packageFile = JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(packageFile.scripts["source:serve"], "node legacy-server.js");
  assert.equal(packageFile.vitality.pages, 0);
  await assert.rejects(stat(path.join(wrapper, "vite.config.js")));
  run("bun", ["install"], wrapper);
  run("bun", ["run", "check"], wrapper);
  run("bun", ["run", "build"], wrapper);
  assert.deepEqual(await allFiles(path.join(wrapper, "dist")), [
    "assets/index.css",
    "assets/index.js",
    "index.html",
  ]);
  const html = await readFile(path.join(wrapper, "dist", "index.html"), "utf8");
  assert.doesNotMatch(html, /fixture-config/u);
});

test("no-public also preserves ordinary source modules and relative JSON fetches", async context => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vitality-inline-"));
  context.after(() => rm(source, { recursive: true, force: true }));
  await cp(path.join(fixtures, "configured"), source, { recursive: true });
  await mkdir(path.join(source, "data"));
  await writeFile(path.join(source, "data/index.json"), '{"entry":"child.json"}');
  await writeFile(path.join(source, "data/child.json"), '{"answer":42}');
  await writeFile(path.join(source, "src/main.js"), `
    const response = await fetch(new URL('../data/index.json', import.meta.url));
    const manifest = await response.json();
    if (manifest.entry !== 'child.json') throw new Error('manifest identity changed');
    const child = await fetch(new URL(manifest.entry, response.url)).then(r => r.json());
    globalThis.inlineAnswer = child.answer;
  `);
  run(process.execPath, [cli, "give", "-d", source, "-b", "/nested/", "--no-public"], repository);
  const wrapper = path.join(source, "mywrap");
  await assert.rejects(stat(path.join(wrapper, "public")));
  run(process.execPath, ["install", "--ignore-scripts"], wrapper);
  run(process.execPath, ["run", "--bun", "build"], wrapper);
  assert.deepEqual(await allFiles(path.join(wrapper, "dist")), ["assets/index.css", "assets/index.js", "index.html"]);
  run(process.execPath, ["-e", `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');await import('./dist/assets/index.js');if(globalThis.inlineAnswer!==42)throw Error('JSON graph failed');`], wrapper);
});

test("give promotes a unique shallowest nested index as the site root", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-nested-root-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source");
  await cp(path.join(fixtures, "nested-root"), source, { recursive: true });

  const dryRun = run(process.execPath, [
    cli, "give", "--dir", source, "--base", "/", "--no-inline", "--dry-run",
  ], repository);
  assert.match(dryRun.stdout, /entry\s+docs\/index\.html/u);
  await assert.rejects(stat(path.join(source, "mywrap")));

  run(process.execPath, [
    cli, "give", "--dir", source, "--base", "/", "--no-inline",
  ], repository);
  const wrapper = path.join(source, "mywrap");
  const packageFile = JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(packageFile.vitality.schemaVersion, 3);
  assert.equal(packageFile.vitality.sourceEntry, "docs/index.html");
  assert.match(await readFile(path.join(wrapper, "src", "main.ts"), "utf8"), /\.\/app\/main\.ts/u);
  assert.match(await readFile(path.join(wrapper, "index.html"), "utf8"), /%BASE_URL%vendor\/legacy\.js/u);
  await assert.rejects(stat(path.join(wrapper, "src", "app", "docs")));

  run("bun", ["install"], wrapper);
  run("bun", ["run", "build"], wrapper);
  assert.deepEqual(await allFiles(path.join(wrapper, "dist")), [
    "404.html",
    "CNAME",
    "assets/index.css",
    "assets/index.js",
    "index.html",
    "vendor/legacy.js",
  ]);
});

test("give refuses to guess between equally shallow nested entries", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-ambiguous-root-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source");
  await mkdir(path.join(source, "app"), { recursive: true });
  await mkdir(path.join(source, "docs"), { recursive: true });
  await writeFile(path.join(source, "app", "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(source, "docs", "index.html"), "<!doctype html><title>docs</title>");

  const result = spawnSync(process.execPath, [
    cli, "give", "--dir", source, "--base", "/", "--no-inline",
  ], { cwd: repository, encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple equally shallow nested index\.html entries/u);
  assert.match(result.stderr, /app\/index\.html/u);
  assert.match(result.stderr, /docs\/index\.html/u);
  await assert.rejects(stat(path.join(source, "mywrap")));
});

test("give refuses to overwrite an existing wrapper", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-existing-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source");
  await cp(path.join(fixtures, "configured"), source, { recursive: true });
  const first = run(process.execPath, [cli, "give", "--dir", source], repository);
  assert.match(first.stdout, /Created/u);
  const second = spawnSync(process.execPath, [cli, "give", "--dir", source], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/u);
});
