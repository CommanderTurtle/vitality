import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { parseArguments } from "../dist/args.js";
import { latestVite, updateVite, installedVite } from "../dist/doctor.js";
import { buildIdentity, cliLocation } from "../dist/version.js";
import { version as viteVersion } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("doctor is read-only unless --fix is explicit", () => {
  assert.equal(parseArguments(["doctor", "--dir", "mywrap"]).fix, undefined);
  assert.equal(parseArguments(["doctor", "--fix"]).fix, true);
  assert.throws(() => parseArguments(["give", "--fix"]), /only supported by doctor/);
  assert.throws(() => parseArguments(["doctor", "--base", "/comfy/"]), /accepts --dir/);
});

test("latest stable lookup is uncached, bounded, and rejects invalid responses", async () => {
  let request;
  const release = await latestVite(async (url, options) => {
    request = { url, options };
    return Response.json({ name: "vite", version: "8.3.5", engines: { node: ">=22" } });
  });
  assert.equal(release.version, "8.3.5");
  assert.equal(request.url, "https://registry.npmjs.org/vite/latest");
  assert.equal(request.options.headers["cache-control"], "no-cache");
  assert.ok(request.options.signal);
  await assert.rejects(latestVite(async () => new Response("unavailable", { status: 503 })), /HTTP 503/);
  await assert.rejects(latestVite(async () => Response.json({ name: "vite", version: "9.0.0-beta.1" })), /stable release/);
  await assert.rejects(latestVite(async () => Response.json({ name: "another-package", version: "8.3.5" })), /stable release/);
});

test("repair preserves source dependencies and native Vite placement", () => {
  const pkg = { dependencies: { vite: "7.0.0", other: "1.2.3" }, scripts: { build: "custom build" }, vitality: { nativeVite: true } };
  updateVite(pkg, "8.3.5");
  assert.deepEqual(pkg.dependencies, { vite: "8.3.5", other: "1.2.3" });
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts.build, "custom build");
  assert.equal(pkg.vitality.nativeVite, true);
  const bare = {};
  updateVite(bare, "8.3.5");
  assert.equal(bare.devDependencies.vite, "8.3.5");
});

test("version fingerprints running code and matches the installed toolchain", async () => {
  const identity = await buildIdentity();
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(identity.version, pkg.version);
  assert.match(identity.build, /^[a-f0-9]{12}$/);
  assert.equal(identity.vite, viteVersion);
  assert.match(await cliLocation(), /dist[\\/]cli\.js$/);
});

test("doctor does not mistake an ancestor installation for the wrapper's Vite", async () => {
  const temporary = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "doctor-local-"));
  try {
    assert.equal(await installedVite(directory), undefined);
    const vite = path.join(directory, "node_modules", "vite");
    await mkdir(vite, { recursive: true });
    await writeFile(`${vite}/package.json`, '{"version":"8.3.5"}');
    assert.equal(await installedVite(directory), "8.3.5");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
