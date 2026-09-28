import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseArguments, parseBooleanWord, UsageError } from "../dist/args.js";
import { normalizeBase } from "../dist/base.js";
import { containsPath } from "../dist/paths.js";
import { resolveSourceEntry } from "../dist/copy.js";

test("parses the explicit give contract and literal path values", () => {
  const parsed = parseArguments([
    "give", "--dir", "some\\path[not-a-glob]", "--base=/project", "--inline", "yes",
  ]);
  assert.equal(parsed.command, "give");
  assert.equal(parsed.directory, "some\\path[not-a-glob]");
  assert.equal(parsed.base, "/project");
  assert.equal(parsed.inlineAssets, true);
  assert.equal("install" in parsed, false);
  assert.equal(parseArguments(["give", "--build-output=web"]).buildOutput, "web");
  assert.throws(() => parseArguments(["give", "--build-output"]), UsageError);
});

test("boolean parsing is strict but accepts shell-friendly spellings", () => {
  assert.equal(parseBooleanWord("Y"), true);
  assert.equal(parseBooleanWord("off"), false);
  assert.throws(() => parseBooleanWord("perhaps"), UsageError);
});

test("normalizes supported Vite bases", () => {
  assert.equal(normalizeBase("/"), "/");
  assert.equal(normalizeBase("/project"), "/project/");
  assert.equal(normalizeBase("./"), "./");
  assert.equal(normalizeBase("https://example.com/project"), "https://example.com/project/");
  assert.throws(() => normalizeBase("project"), UsageError);
  assert.throws(() => normalizeBase("/project/../escape"), UsageError);
});

test("path containment is segment-aware", () => {
  const root = path.resolve("alpha");
  assert.equal(containsPath(root, path.join(root, "child")), true);
  assert.equal(containsPath(root, path.resolve("alphabet")), false);
});

test("Bun fallback validates output paths and preserves root and nested HTML precedence", async (context) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vitality-build-entry-"));
  context.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "package.json"), '{"scripts":{"build":"bun build.ts"}}');
  const entry = await resolveSourceEntry(source, "output/site");
  assert.equal(entry.relative, "package.json#scripts.build");
  assert.equal(entry.sourceBuild.outDir, "output/site");
  for (const output of ["..", "../outside", ".git", "source", "SRC", "C:dist", "mywrap", "/tmp/output"]) {
    await assert.rejects(resolveSourceEntry(source, output), UsageError);
  }
  await mkdir(path.join(source, "nested"));
  await writeFile(path.join(source, "nested/index.html"), "nested");
  assert.equal((await resolveSourceEntry(source)).relative, "nested/index.html");
  assert.equal((await resolveSourceEntry(source)).sourceBuild, undefined);
  await writeFile(path.join(source, "index.html"), "root");
  assert.equal((await resolveSourceEntry(source)).relative, "index.html");
  assert.equal((await resolveSourceEntry(source)).sourceBuild, undefined);
});

test("generic build scripts and bunfig alone do not bypass ambiguous entry detection", async (context) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vitality-bun-fallback-"));
  context.after(() => rm(source, { recursive: true, force: true }));
  for (const directory of ["app", "docs"]) {
    await mkdir(path.join(source, directory));
    await writeFile(path.join(source, directory, "index.html"), directory);
  }
  await writeFile(path.join(source, "package.json"), '{"scripts":{"build":"tsc"}}');
  await assert.rejects(resolveSourceEntry(source), /multiple equally shallow/u);
  await writeFile(path.join(source, "bunfig.toml"), '[test]\nroot = "tests"\n');
  await writeFile(path.join(source, "package.json"), '{}');
  await assert.rejects(resolveSourceEntry(source), /multiple equally shallow/u);
  await writeFile(path.join(source, "package.json"), '{"scripts":{"build":"vite build"}}');
  assert.equal((await resolveSourceEntry(source)).relative, "package.json#scripts.build");
});
