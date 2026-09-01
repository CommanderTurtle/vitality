import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { parseArguments, parseBooleanWord, UsageError } from "../dist/args.js";
import { normalizeBase } from "../dist/base.js";
import { containsPath } from "../dist/paths.js";

test("parses the explicit give contract and literal path values", () => {
  const parsed = parseArguments([
    "give", "--dir", "some\\path[not-a-glob]", "--base=/project", "--inline", "yes", "--no-install",
  ]);
  assert.equal(parsed.command, "give");
  assert.equal(parsed.directory, "some\\path[not-a-glob]");
  assert.equal(parsed.base, "/project");
  assert.equal(parsed.inlineAssets, true);
  assert.equal(parsed.install, false);
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
