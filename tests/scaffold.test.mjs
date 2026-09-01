import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repository, "dist", "cli.js");
const fixtures = path.join(repository, "tests", "fixtures");

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPage(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`development server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.text();
    } catch {
      // The server has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`development server did not answer ${url}`);
}

test("give produces an unbuilt, runnable wrapper and honors infinite inlining", { timeout: 30_000 }, async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality [literal] "));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source + regex[.]safe");
  await cp(path.join(fixtures, "standalone"), source, { recursive: true });
  await writeFile(
    path.join(source, "src", "large.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(7000)}--><rect width="10" height="10"/></svg>`,
  );

  const created = run(process.execPath, [
    cli, "give", "--dir", source, "--base", "/project", "--inline", "yes", "--no-install",
  ], repository);
  assert.match(created.stdout, /dist\s+not built/u);
  const wrapper = path.join(source, "mywrap");
  await assert.rejects(stat(path.join(wrapper, "dist")));
  assert.equal(await readFile(path.join(wrapper, "runtime", "data.json"), "utf8"),
    await readFile(path.join(source, "runtime", "data.json"), "utf8"));

  const packageFile = JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(packageFile.scripts.serve, "vite --config vitality.config.mts");
  assert.equal(packageFile.scripts.build, "vite build --config vitality.config.mts");
  assert.equal(packageFile.vitality.base, "/project/");
  assert.equal(packageFile.vitality.assetsInlineLimit, "Infinity");
  assert.match(await readFile(path.join(wrapper, "vitality.config.mts"), "utf8"),
    /assetsInlineLimit: Number\.POSITIVE_INFINITY/u);

  run("bun", ["install"], wrapper);
  const port = await freePort();
  const server = spawn("bun", [
    path.join(wrapper, "node_modules", "vite", "bin", "vite.js"),
    "--config", "vitality.config.mts", "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { cwd: wrapper, stdio: "ignore", windowsHide: true });
  try {
    const html = await waitForPage(`http://127.0.0.1:${port}/project/`, server);
    assert.match(html, /Vitality fixture/u);
  } finally {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }

  run("bun", ["run", "build"], wrapper);
  const builtHtml = await readFile(path.join(wrapper, "dist", "index.html"), "utf8");
  assert.match(builtHtml, /\/project\//u);
  const builtJavaScript = (await Promise.all(
    (await readdir(path.join(wrapper, "dist", "assets")))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(path.join(wrapper, "dist", "assets", name), "utf8")),
  )).join("\n");
  assert.match(builtJavaScript, /data:image\/svg\+xml/u);
  assert.match(builtJavaScript, /\/project\/runtime\/manifest\/index\.json/u);
  assert.doesNotMatch(builtJavaScript, /data:application\/json[^\n]+child\.json/u);
  await stat(path.join(wrapper, "dist", "nested", "index.html"));
  await stat(path.join(wrapper, "dist", "runtime", "data.json"));
  await stat(path.join(wrapper, "dist", "runtime", "manifest", "index.json"));
  await stat(path.join(wrapper, "dist", "runtime", "manifest", "child.json"));
  await assert.rejects(stat(path.join(wrapper, "dist", ".env.private")));
});

test("give preserves an existing config and its source serve command", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-config-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "configured");
  const wrapper = path.join(temporaryRoot, "new", "nested", "output");
  await cp(path.join(fixtures, "configured"), source, { recursive: true });

  run(process.execPath, [
    cli, "give", "--dir", source, "--output", wrapper, "--base", "/", "--no-inline", "--no-install",
  ], repository);
  const packageFile = JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8"));
  assert.equal(packageFile.scripts["source:serve"], "node legacy-server.js");
  run("bun", ["install"], wrapper);
  run("bun", ["run", "build"], wrapper);
  const html = await readFile(path.join(wrapper, "dist", "index.html"), "utf8");
  assert.match(html, /name="fixture-config" content="loaded"/u);
});

test("give refuses to overwrite an existing wrapper", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitality-existing-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = path.join(temporaryRoot, "source");
  await cp(path.join(fixtures, "configured"), source, { recursive: true });
  const first = run(process.execPath, [cli, "give", "--dir", source, "--no-install"], repository);
  assert.match(first.stdout, /Created/u);
  const second = spawnSync(process.execPath, [cli, "give", "--dir", source, "--no-install"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/u);
});
