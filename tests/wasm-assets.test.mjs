import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { embeddedAssets } from "../dist/embedded-assets-plugin.js";
import { compactConfig } from "../dist/native-vite-plugin.js";

const call = (hook, context, ...args) => (typeof hook === "function" ? hook : hook.handler).call(context, ...args);
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
function context() {
  const emitted = [];
  return { emitted, emitFile: file => (emitted.push(file), String(emitted.length)), addWatchFile() {}, info() {}, error(message) { throw new Error(message); } };
}

test("static wrapper emits unchanged, hashed WASM and rewrites both aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vitality-wasm-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/model.wasm"), wasm);
    await writeFile(path.join(root, "src/core.wasm.js"), "globalThis.core = true;");
    await writeFile(path.join(root, "src/embedded-files.json"), JSON.stringify({"model.wasm": "src/model.wasm", "src/app/model.wasm": "src/model.wasm"}));
    await writeFile(path.join(root, "src/embedded-scripts.json"), "{}");
    await writeFile(path.join(root, "src/embedded-classic.json"), JSON.stringify({"core.wasm.js": "src/core.wasm.js"}));
    const plugin = embeddedAssets(root), ctx = context();
    call(plugin.configResolved, ctx, { base: "/demo/" });
    call(plugin.buildStart, ctx);
    const code = await call(plugin.load, ctx, "\0vitality-assets");
    const file = ctx.emitted.find(file => file.fileName.endsWith(".wasm"));
    assert.match(file.fileName, /^assets\/model-[a-f0-9]{16}\.wasm$/);
    assert.deepEqual(file.source, wasm);
    assert.equal(ctx.emitted.length, 2);
    assert.ok(code.includes("/demo/" + file.fileName));
    assert.ok(code.includes('"url:/demo/assets/core-'));
    assert.ok(!code.includes("data:application/wasm"));
    assert.ok(code.includes('"src/app/model.wasm":asset0'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native wrapper emits hashed files and handles forced-inline worker WASM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vitality-native-wasm-"));
  try {
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "public/model.wasm"), wasm);
    const config = compactConfig({ root, base: "/old/" }, "/new/");
    assert.equal(config.build.assetsInlineLimit("model.wasm"), false);
    assert.equal(config.build.assetsInlineLimit("image.png"), true);
    assert.equal(config.publicDir, false);
    const ctx = context(), plugin = config.plugins[0];
    await call(plugin.buildStart, ctx);
    const worker = config.worker.plugins().at(-1);
    const large = Buffer.alloc(256, 1);
    const code = `const bytes="data:application/wasm;base64,${large.toString("base64")}";new URL("/new/assets/other.wasm",import.meta.url);`;
    const transformed = call(worker.renderChunk, ctx, code, { fileName: "worker.js" });
    assert.ok(transformed.code.includes("__vitalityNative.asset("));
    assert.ok(transformed.code.includes("__vitalityNative.root"));
    assert.ok(!transformed.code.includes("data:application/wasm"));
    const entry = { type: "chunk", isEntry: true, code: 'const assets="__VITALITY_NATIVE_ASSETS__";' };
    call(plugin.generateBundle, ctx, {}, { "assets/index-abcd.js": entry });
    assert.equal(ctx.emitted.length, 2);
    assert.deepEqual(ctx.emitted.find(file => file.fileName.startsWith("assets/model-")).source, wasm);
    assert.deepEqual(ctx.emitted.find(file => file.fileName.startsWith("assets/module-")).source, large);
    assert.ok(entry.code.includes('"model.wasm":'));
    assert.ok(entry.code.includes('"assets/model.wasm":'));
    assert.ok(entry.code.includes("/new/assets/model-"));
    assert.ok(!entry.code.includes("data:application/wasm"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
