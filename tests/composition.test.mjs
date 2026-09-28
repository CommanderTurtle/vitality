import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectComposition } from "../dist/composition.js";
import { resolveSourceEntry } from "../dist/copy.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(args, cwd = repository) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
async function fixture(context) {
  const source = await mkdtemp(path.join(os.tmpdir(), "vitality-composed-"));
  context.after(() => rm(source, { recursive: true, force: true }));
  for (const dir of ["scripts", "src", "source/native/assets", "source/unused"]) await mkdir(path.join(source, dir), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "composed", type: "module", scripts: { build: "bun scripts/build.ts" } }));
  await writeFile(path.join(source, "bunfig.toml"), '[test]\nroot="tests"');
  await writeFile(path.join(source, "source/native/index.html"), '<html><head></head><body><script type="module" src="./assets/native.js"></script></body></html>');
  await writeFile(path.join(source, "source/unused/index.html"), 'not the entry');
  await writeFile(path.join(source, "source/native/assets/native.js"), 'window.nativeReady = true;');
  await writeFile(path.join(source, "source/meta.json"), '{"version":"1.0"}');
  await writeFile(path.join(source, "src/data.ts"), 'const node = (name: string) => ({ name }); export const nodes = { Start: node("Start") };');
  await writeFile(path.join(source, "src/helper.ts"), 'export const title = "bootstrap";');
  await writeFile(path.join(source, "src/boot.ts"), 'import { title } from "./helper"; import logo from "./logo.svg"; (window as any).logo = logo; (window as any).title = title; (window as any).base = new URL("../", (document.currentScript as HTMLScriptElement).src);');
  await writeFile(path.join(source, "src/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><!--' + 'large'.repeat(2000) + '--><rect width="10" height="10"/></svg>');
  await writeFile(path.join(source, "src/extension.ts"), '(window as any).extensionLoaded = true; export const enabled = true;');
  await writeFile(path.join(source, "scripts/build.ts"), `
import { cp, mkdir, rm, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { nodes } from '../src/data'
const root = resolve(import.meta.dir, '..')
const source = join(root, 'source')
const stage = join(root, '.work/stage')
await mkdir(stage, { recursive: true })
await cp(join(source, 'native'), stage, { recursive: true })
const version = await Bun.file(join(source, 'meta.json')).json()
await Bun.write(join(stage, 'data/config.json'), JSON.stringify({ version: version.version, nodes, extension: '/extensions/extra.js' }))
for (const [entry, output, format] of [['src/boot.ts', 'data/boot.js', 'iife'], ['src/extension.ts', 'extensions/extra.js', 'esm']] as const) {
 const result = await Bun.build({ entrypoints: [join(root, entry)], format, target: 'browser' })
 await Bun.write(join(stage, output), result.outputs[0]!)
}
let html = await Bun.file(join(stage, 'index.html')).text()
html = html.replace('<head>', '<head><script src="./data/boot.js"></script>')
await Bun.write(join(stage, 'index.html'), html)
await rm(join(root, 'dist'), { recursive: true, force: true })
await rename(stage, join(root, 'dist'))
`);
  return source;
}

test("composed TS sources become Vite inputs without executing the source builder", async context => {
  const source = await fixture(context);
  await assert.rejects(resolveSourceEntry(source), /equally shallow/);
  const plan = detectComposition(source);
  assert.deepEqual(JSON.parse(plan.files.get('data/config.json').text).nodes, { Start: { name: "Start" } });
  await assert.rejects(stat(path.join(source, 'dist')));
  await assert.rejects(stat(path.join(source, '.work')));
  run(['dist/cli.js', 'give', '-d', source, '-b', '/site/', '--inline', 'y']);
  const wrapper = path.join(source, 'mywrap');
  const pkg = JSON.parse(await readFile(path.join(wrapper, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.equal(pkg.scripts['source:build'], undefined);
  const config = await readFile(path.join(wrapper, 'vite.config.ts'), 'utf8');
  assert.match(config, /Number.POSITIVE_INFINITY/);
  assert.doesNotMatch(config, /spawn|Bun\.build|source:build|scripts\/build/);
  const main = await readFile(path.join(wrapper, 'src/main.ts'), 'utf8');
  assert.ok(main.indexOf('boot.ts') < main.indexOf('assets/native.js'));
  assert.match(await readFile(path.join(wrapper, 'src/app/src/boot.ts'), 'utf8'), /import\.meta\.env\.BASE_URL/);
  assert.equal(await readFile(path.join(wrapper, 'src/app/src/helper.ts'), 'utf8'), await readFile(path.join(source, 'src/helper.ts'), 'utf8'));
  assert.match(await readFile(path.join(wrapper, 'public/data/config.json'), 'utf8'), /\/site\/extensions\/extra\.js/);
  for (const dir of ['dist', 'node_modules', 'scripts', '.vitality']) await assert.rejects(stat(path.join(wrapper, dir)));
  // Only this tiny fixture is built, proving generated output uses Vite alone.
  run(['install', '--ignore-scripts'], wrapper);
  run(['run', '--bun', 'build'], wrapper);
  await stat(path.join(wrapper, 'dist/extensions/extra.js'));
  assert.match(await readFile(path.join(wrapper, 'dist/index.html'), 'utf8'), /\/site\/assets\/index\.js/);
  const scripts = await Promise.all((await readdir(path.join(wrapper, 'dist/assets'))).filter(name => name.endsWith('.js'))
    .map(name => readFile(path.join(wrapper, 'dist/assets', name), 'utf8')));
  assert.match(scripts.join('\n'), /data:image\/svg\+xml/);
  await assert.rejects(stat(path.join(source, 'dist')));
  await assert.rejects(stat(path.join(source, '.work')));
});

test("unsupported source actions fail closed instead of executing", async context => {
  const source = await fixture(context);
  const script = path.join(source, 'scripts/build.ts');
  await writeFile(script, (await readFile(script, 'utf8')) + '\nawait fetch("https://example.invalid/never-execute");');
  assert.throws(() => detectComposition(source), /Unresolved source expression: fetch/);
  await assert.rejects(stat(path.join(source, 'dist')));
});

test("no-public embeds URL assets and keeps lazy extension/bootstrap order", async context => {
  const source = await fixture(context);
  await writeFile(path.join(source, 'source/native/index.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'; style-src \'self\'"><link rel="stylesheet" href="assets/style.css"></head><body><script src="assets/classic.js"></script><script type="module" src="./assets/native.js"></script></body></html>');
  await writeFile(path.join(source, 'source/native/assets/classic.js'), 'globalThis.classic = true;');
  await writeFile(path.join(source, 'source/native/assets/style.css'), 'body {background: url(./pixel.svg)}');
  await writeFile(path.join(source, 'source/native/assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(source, 'source/native/LICENSE'), 'kept in source, not published');
  await writeFile(path.join(source, 'source/native/assets/worker.js'), 'import { answer } from "./worker-helper.js"; self.postMessage?.(answer);');
  await writeFile(path.join(source, 'source/native/assets/worker-helper.js'), 'export const answer = "embedded-worker-ready";');
  await writeFile(path.join(source, 'source/native/assets/native.js'), `
    if (globalThis.title !== 'bootstrap') throw new Error('bootstrap ran too late');
    if (globalThis.extensionLoaded) throw new Error('extension ran too early');
    const response = await fetch(new URL('../data/config.json', import.meta.url));
    if (!response.url.endsWith('/site/data/config.json')) throw new Error('JSON response lost its original URL');
    const config = await response.json();
    await import(config.extension);
    globalThis.workerURL = new URL('./worker.js', import.meta.url).href;
    const worker = await fetch(globalThis.workerURL).then(r => r.text());
    if (!worker.includes('embedded-worker-ready') || /from[\\s]*['"]\\./.test(worker)) throw new Error('worker not self-contained');
    globalThis.nativeReady = true;
  `);
  await writeFile(path.join(source, 'src/extension.ts'), `
    if (globalThis.title !== 'bootstrap') throw new Error('extension before bootstrap');
    globalThis.extensionLoaded = true;
    export const enabled = true;
  `);
  run(['dist/cli.js', 'give', '-d', source, '-b', '/site/', '--inline', 'y', '--no-public']);
  const wrapper = path.join(source, 'mywrap');
  await assert.rejects(stat(path.join(wrapper, 'public')));
  await assert.rejects(stat(path.join(wrapper, 'dist')));
  await stat(path.join(wrapper, 'src/embedded/LICENSE'));
  run(['install', '--ignore-scripts'], wrapper);
  const built = run(['run', '--bun', 'build'], wrapper);
  assert.doesNotMatch(built.stderr, /can't be bundled|remain unchanged|unresolved/i);
  assert.deepEqual((await readdir(path.join(wrapper, 'dist'))).sort(), ['assets', 'index.html']);
  assert.deepEqual(await readdir(path.join(wrapper, 'dist/assets')), ['index.js']);
  const html = await readFile(path.join(wrapper, 'dist/index.html'), 'utf8');
  assert.match(html, /data:text\/css;base64/);
  assert.match(html, /sha256-/);
  assert.doesNotMatch(html, /src="[^"\n]*classic\.js/);
  const script = await readFile(path.join(wrapper, 'dist/assets/index.js'), 'utf8');
  assert.doesNotMatch(script, /kept in source, not published/);
  // Bun can execute this DOM-free fixture's bundle and detect premature evaluation.
  const result = run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/site/');await import('./dist/assets/index.js');if(!globalThis.nativeReady||!globalThis.extensionLoaded)throw Error('not initialized');console.log('ordered');`], wrapper);
  assert.match(result.stdout, /ordered/);
});
