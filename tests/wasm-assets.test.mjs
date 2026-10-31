import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { embeddedAssets, normalizeInlineScript } from "../dist/embedded-assets-plugin.js";
import { createHash } from "node:crypto";
import { compactConfig, viteStaticCopy } from "../dist/native-vite-plugin.js";
import { binaryFile, engineAsset, engineFileName, claimAsset } from "../dist/asset-policy.js";
import { embedPublicFiles } from "../dist/no-public.js";
import { build } from "vite";

const call = (hook, context, ...args) => (typeof hook === "function" ? hook : hook.handler).call(context, ...args);
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

test('binary policy handles URL suffixes without treating path punctuation as a URL', () => {
  for (const name of ['C:/project # 100%/file.tar?url', '/project/hash#name/module.WASM?url#x', '/project/notes#1/file.gz']) {
    assert.ok(engineAsset(name));
    assert.ok(binaryFile(name).endsWith(name.includes('WASM') ? '.WASM' : name.includes('.tar') ? '.tar' : '.gz'));
  }
  assert.equal(binaryFile('/project/directory.tar#1/main.js'), undefined);
  assert.match(engineFileName('model.tar', Buffer.from([0,255])), /^assets\/model-[a-f0-9]{16}\.tar$/);
});

test("inline CSP hashes survive HTML newline normalization and trailing-text trimming", () => {
  const input = '// helper\r\nparent.postMessage({type:"ready"},location.origin);\r\n';
  const code = normalizeInlineScript(input);
  assert.equal(code, '// helper\nparent.postMessage({type:"ready"},location.origin);');
  const digest = value => createHash("sha256").update(value).digest("base64");
  assert.notEqual(digest(input.replace(/\r\n/g, "\n")), digest(code));
  assert.equal(digest(code), digest(code.trimEnd()));
  assert.equal(normalizeInlineScript('const end="</script>";\n'), 'const end="<\\/script>";');
});

test("native forced-inline engines are outlined at every size, including archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vitality-engine-sizes-'));
  try {
    const config = compactConfig({ root, publicDir: false }, '/site/');
    const ctx = context(), plugin = config.plugins[0], worker = config.worker.plugins().at(-1);
    await call(plugin.buildStart, ctx);
    for (const [type, extension] of [['wasm', 'wasm'], ['gzip', 'gz'], ['x-tar', 'tar']]) {
      const bytes = Buffer.from([0, 255, 1]);
      const output = call(worker.renderChunk, ctx, `export const file="data:application/${type};base64,${bytes.toString('base64')}";`, {fileName:'worker.js'});
      assert.ok(output.code.includes('__vitalityNative.asset('));
      assert.ok(!output.code.includes('data:application/'));
    }
    const entry = {type:'chunk',isEntry:true,code:'const assets="__VITALITY_NATIVE_ASSETS__";'};
    call(plugin.generateBundle, ctx, {}, {'assets/index-abcd.js':entry});
    assert.deepEqual(ctx.emitted.map(item => path.extname(item.fileName)).sort(), ['.gz','.tar','.wasm']);
    for (const item of ctx.emitted) assert.deepEqual(item.source, Buffer.from([0,255,1]));
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("static-copy resource ownership stays with its config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vitality-copy-ownership-'));
  try {
    await writeFile(path.join(root, 'first.tar'), 'first');
    await writeFile(path.join(root, 'second.gz'), 'second');
    const first = viteStaticCopy({targets:[{src:'first.tar',dest:'models'}]});
    const second = viteStaticCopy({targets:[{src:'second.gz',dest:'languages'}]});
    for (const [selected, expected, excluded] of [[first,'.tar','.gz'],[second,'.gz','.tar']]) {
      const config = compactConfig({root,publicDir:false,plugins:[Promise.resolve([selected])]}, '/site/');
      const ctx = context(), plugin = config.plugins[0];
      await call(plugin.buildStart, ctx);
      const entry = {type:'chunk',isEntry:true,code:'const assets="__VITALITY_NATIVE_ASSETS__";'};
      call(plugin.generateBundle, ctx, {}, {'assets/index-abcd.js':entry});
      assert.equal(ctx.emitted.length, 1);
      assert.equal(path.extname(ctx.emitted[0].fileName), expected);
      assert.ok(!entry.code.includes(excluded));
    }
  } finally { await rm(root, {recursive:true,force:true}); }
});
function context() {
  const emitted = [];
  return { emitted, emitFile: file => (emitted.push(file), String(emitted.length)), addWatchFile() {}, info() {}, error(message) { throw new Error(message); } };
}

test("compact emission compares bytes across collectors and compiler-owned sidecars", async () => {
  const sources = new Map();
  assert.equal(claimAsset(sources, 'same.bin', 'same'), true);
  assert.equal(claimAsset(sources, 'same.bin', Buffer.from('same')), false);
  const padded = Buffer.from('!same!');
  assert.equal(claimAsset(sources, 'same.bin', padded.subarray(1, 5)), false);
  assert.throws(() => claimAsset(sources, 'same.bin', Buffer.from('else')), /Conflicting emitted asset bytes: same.bin/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'vitality-emission-ownership-'));
  try {
    await mkdir(path.join(root, 'public'));
    await writeFile(path.join(root, 'public/model.wasm'), wasm);
    const config = compactConfig({root}, '/site/'), plugin = config.plugins[0];
    const ctx = context(), name = engineFileName('model.wasm', wasm);
    await call(plugin.buildStart, ctx);
    const bundle = source => ({'assets/index-abcd.js':{type:'chunk',isEntry:true,code:'const assets="__VITALITY_NATIVE_ASSETS__";'},[name]:{type:'asset',fileName:name,source}});
    call(plugin.generateBundle, ctx, {}, bundle(new Uint8Array(wasm)));
    assert.equal(ctx.emitted.length, 0, 'compiler-owned identical bytes are reused');
    assert.throws(() => call(plugin.generateBundle, ctx, {}, bundle(Buffer.from('wrong'))), /Conflicting emitted asset bytes/);

    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/embedded-files.json'), JSON.stringify({'model.wasm':'public/model.wasm'}));
    await writeFile(path.join(root, 'src/embedded-scripts.json'), '{}');
    const embedded = embeddedAssets(root), embeddedContext = context();
    call(embedded.configResolved, embeddedContext, {base:'/site/'});
    call(embedded.buildStart, embeddedContext);
    await call(embedded.load, embeddedContext, '\0vitality-assets');
    await call(embedded.generateBundle, embeddedContext, {}, {[name]:{type:'asset',fileName:name,source:wasm,names:[]}});
    assert.equal(embeddedContext.emitted.length, 1);
    await assert.rejects(call(embedded.generateBundle, embeddedContext, {}, {[name]:{type:'asset',fileName:name,source:Buffer.from('wrong'),names:[]}}), /Conflicting emitted asset bytes/);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("copied URL-script aliases keep one browser identity and stay out of the main graph", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vitality-script-identities-'));
  try {
    await mkdir(path.join(root, 'src/app/vendor'), {recursive:true});
    await writeFile(path.join(root, 'package.json'), JSON.stringify({type:'module',vitality:{}}));
    await writeFile(path.join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>');
    await writeFile(path.join(root, 'src/main.ts'), 'import "./app/main.ts";');
    await writeFile(path.join(root, 'src/app/main.ts'), 'globalThis.parserURL=()=>new URL("./vendor/parser.js",import.meta.url);globalThis.workerURL=()=>new Worker(new URL("./vendor/worker.js",import.meta.url),{type:"module"});');
    await writeFile(path.join(root, 'src/app/vendor/parser.js'), 'export function parse(){return eval("PARSER_BODY_MUST_STAY_IN_SCRIPT");}');
    await writeFile(path.join(root, 'src/app/vendor/worker.js'), 'self.onmessage=()=>self.postMessage("WORKER_BODY_MUST_STAY_IN_SCRIPT");export {};');
    await embedPublicFiles(root, '/site/', [], root, undefined, new Map([['src/app/vendor/parser.js','vendor/renamed.mjs']]));
    const scripts = JSON.parse(await readFile(path.join(root, 'src/embedded-scripts.json'), 'utf8'));
    assert.deepEqual(Object.keys(scripts).sort(), ['vendor/renamed.mjs','vendor/worker.js']);
    const runtime = await readFile(path.join(root, 'src/inline-runtime.ts'), 'utf8');
    assert.ok(!runtime.includes('import("./app/vendor/parser.js")'));
    assert.ok(!runtime.includes('import("./app/vendor/worker.js")'));
    assert.ok(runtime.includes('"vendor/parser.js": () => import(/* @vite-ignore */ globalThis.__vitalityEmbedded.script("vendor/renamed.mjs"))'));
    // Windows temp paths can use an 8.3 user alias; match Vite's real input root.
    const buildRoot = await realpath(root);
    const result = await build({root:buildRoot,base:'/site/',configFile:false,publicDir:false,logLevel:'silent',plugins:[embeddedAssets(buildRoot)],build:{write:false,target:'esnext',modulePreload:false,cssCodeSplit:false,rolldownOptions:{input:path.join(buildRoot,'index.html'),output:{codeSplitting:false,entryFileNames:'assets/index.js',assetFileNames:'assets/[name][extname]'}}}});
    const entry = result.output.find(item=>item.type==='chunk');
    assert.ok(entry);
    assert.ok(!entry.code.includes('eval('));
    assert.ok(!entry.code.includes('PARSER_BODY_MUST_STAY_IN_SCRIPT'));
    assert.ok(!entry.code.includes('WORKER_BODY_MUST_STAY_IN_SCRIPT'));
  } finally { await rm(root, {recursive:true,force:true}); }
});

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
    assert.doesNotThrow(() => new Function(entry.code));
    assert.equal(ctx.emitted.length, 2);
    assert.deepEqual(ctx.emitted.find(file => file.fileName.startsWith("assets/model-")).source, wasm);
    assert.deepEqual(ctx.emitted.find(file => file.fileName.startsWith("assets/module-")).source, large);
    assert.ok(entry.code.includes('"model.wasm":'));
    assert.ok(entry.code.includes('"assets/model.wasm":'));
    assert.ok(entry.code.includes("/new/assets/model-"));
    assert.ok(!entry.code.includes("data:application/wasm"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
