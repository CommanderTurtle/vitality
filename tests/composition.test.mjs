import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectComposition, detectLibraryOutputs } from "../dist/composition.js";
import { resolveSourceEntry } from "../dist/copy.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(args, cwd = repository) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
async function fixture(context, prefix = "vitality-composed-") {
  const source = await mkdtemp(path.join(os.tmpdir(), prefix));
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

async function libraryFixture(context, name = 'problem.js', native = false) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'vitality-library café-'));
  context.after(() => rm(source, { recursive: true, force: true }));
  for (const dir of ['src', 'scripts', 'demo']) await mkdir(path.join(source, dir));
  await writeFile(path.join(source, 'package.json'), JSON.stringify({name:'library-recipe',type:'module',scripts:{build:'bun scripts/build.mjs'}}));
  await writeFile(path.join(source, 'scripts/paths.mjs'), `export const root = new URL('../', import.meta.url); export async function prepareModels() { throw Error('never execute preparation'); }`);
  await writeFile(path.join(source, 'scripts/build.mjs'), `
    import { build as bundle } from 'vite';
    import { fileURLToPath } from 'node:url';
    import { root, prepareModels } from './paths.mjs';
    await prepareModels();
    await bundle({ configFile: false, root: fileURLToPath(root), build: {
      outDir: 'dist', lib: { entry: fileURLToPath(new URL('src/index.js', root)), formats: ['es'], fileName: () => ${JSON.stringify(name)} }
    } });
  `);
  await writeFile(path.join(source, 'demo/index.html'), '<script type="module" src="./some.js"></script>');
  await writeFile(path.join(source, 'demo/some.js'), `import { createWorker } from './${name}'; globalThis.libraryAnswer = createWorker();
    globalThis.spawnLibrary = () => new Worker(new URL('./${name}', import.meta.url), {type:'module'});`);
  await writeFile(path.join(source, 'src/index.js'), `import { answer } from './helper.js'; export function createWorker() { return answer; }
    export function actualWorker() { return new Worker(new URL('./worker.js', import.meta.url), {type:'module'}); }`);
  await writeFile(path.join(source, 'src/helper.js'), 'export const answer = 42;');
  await writeFile(path.join(source, 'src/worker.js'), 'self.postMessage(42);');
  if (native) {
    await writeFile(path.join(source, 'index.html'), '<script type="module" src="./some.js"></script>');
    await writeFile(path.join(source, 'some.js'), await readFile(path.join(source, 'demo/some.js')));
    await writeFile(path.join(source, 'vite.config.js'), `export default {build:{target:'esnext',modulePreload:false}};`);
  }
  return source;
}

for (const [inline, noPublic] of [['n','n'], ['y','n'], ['y','y']]) {
  for (const name of ['problem.js', 'renamed/problem.mjs']) {
    test(`Vite library output aliases resolve from unbuilt source (${inline}/${noPublic}, ${name})`, {timeout:30_000}, async context => {
      const source = await libraryFixture(context, name);
      assert.equal(detectLibraryOutputs(source).get(name), path.join(source, 'src/index.js'));
      assert.equal((await resolveSourceEntry(source)).relative, 'demo/index.html');
      run(['dist/cli.js','give','-d',source,'-b','/nested/','--inline',inline,'--no-public',noPublic]);
      const wrapper = path.join(source, 'mywrap');
      const consumer = await readFile(path.join(wrapper, 'src/app/some.ts'), 'utf8');
      assert.match(consumer, /from ["']\.\/__vitality_sources__\/src\/index\.ts/);
      assert.doesNotMatch(consumer, /from ['"]\.\/problem\.js/);
      run(['install','--ignore-scripts'],wrapper);
      run(['run','--bun','build'],wrapper);
      run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');await import('./dist/assets/index.js');if(globalThis.libraryAnswer!==42)throw Error('library alias failed');`],wrapper);
      await assert.rejects(stat(path.join(source,'dist')));
      assert.match(await readFile(path.join(source,'demo/some.js'),'utf8'), /createWorker/);
    });
  }
}

for (const noPublic of ['n', 'y']) {
  test(`native Vite keeps source library aliases (no-public=${noPublic})`, {timeout:30_000}, async context => {
    const source = await libraryFixture(context, 'problem.js', true);
    run(['dist/cli.js','give','-d',source,'-b','/nested/','--inline','y','--no-public',noPublic]);
    const wrapper = path.join(source,'mywrap');
    assert.match(await readFile(path.join(wrapper,'some.js'),'utf8'), /from ["']\.\/src\/index\.js/);
    run(['install','--ignore-scripts'],wrapper);
    run(['run','--bun','build'],wrapper);
    const html = await readFile(path.join(wrapper, 'dist/index.html'), 'utf8');
    const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
    assert.ok(entry?.startsWith('/nested/assets/'));
    run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');await import(${JSON.stringify('./dist/'+entry.slice('/nested/'.length))});if(globalThis.libraryAnswer!==42)throw Error('native library alias failed');`],wrapper);
    await assert.rejects(stat(path.join(source,'dist')));
  });
}
test('source library aliases preserve existing files and work beside a root HTML entry', async context => {
  const source = await libraryFixture(context);
  await writeFile(path.join(source, 'demo/problem.ts'), 'export const createWorker = () => 7;');
  run(['dist/cli.js','give','-d',source,'--inline','n']);
  const wrapper = path.join(source, 'mywrap');
  assert.match(await readFile(path.join(wrapper, 'src/app/some.ts'), 'utf8'), /from ['"]\.\/problem\.ts/);
  run(['-e', `await import('./src/app/some.ts');if(globalThis.libraryAnswer!==7)throw Error('real file was overridden');`],wrapper);
  await writeFile(path.join(source, 'index.html'), '<script type="module" src="./some.js"></script>');
  await writeFile(path.join(source, 'some.js'), await readFile(path.join(source, 'demo/some.js')));
  run(['dist/cli.js','give','-d',source,'-o','root-wrap','--inline','n']);
  const rootWrapper = path.join(source, 'root-wrap');
  assert.match(await readFile(path.join(rootWrapper, 'src/app/some.ts'), 'utf8'), /from ['"]\.\/src\/index\.ts/);
  await assert.rejects(stat(path.join(source, 'dist')));
});

test('library output discovery preserves Vite string-name semantics and rejects escaping aliases', async context => {
  const source = await libraryFixture(context);
  const script = path.join(source, 'scripts/build.mjs');
  const original = await readFile(script, 'utf8');
  await writeFile(script, original.replace("fileName: () => \"problem.js\"", "fileName: 'literal'"));
  assert.equal(detectLibraryOutputs(source).get('literal.js'), path.join(source, 'src/index.js'));
  await writeFile(script, original.replace("fileName: () => \"problem.js\"", "fileName: () => '../outside.js'"));
  assert.throws(() => detectLibraryOutputs(source), /leaves its declared directory/);
  await writeFile(script, original.replace("'src/index.js'", "'../../outside.js'"));
  assert.throws(() => detectLibraryOutputs(source), /outside the project/);
  await assert.rejects(stat(path.join(source, 'dist')));
});

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

for (const noPublic of [false, true]) {
  test(`file-URL recipes trace renamed module outputs exactly (no-public=${noPublic})`, async context => {
    const source = await fixture(context, 'vitality-file-url # 100% café-');
    const original = 'export const answer = 42;';
    await writeFile(path.join(source, 'src/index.js'), original);
    await writeFile(path.join(source, 'source/native/assets/native.js'), `
      const entry = '/site/extensions/renamed.mjs';
      const module = await import(entry);
      globalThis.fileURLAnswer = module.answer;
    `);
    await writeFile(path.join(source, 'scripts/build.ts'), `
import { cp, mkdir, rename } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath as toPath } from 'node:url'
const root = ${noPublic ? "resolve(dirname(toPath(import.meta.url)), '..')" : "toPath(new URL('../', import.meta.url))"}
const stage = join(root, '.work/stage')
await mkdir(stage, { recursive: true })
await cp(join(root, 'source/native'), stage, { recursive: true })
const result = await Bun.build({ entrypoints: [toPath(new URL('../src/index.js', import.meta.url))], format: 'esm', target: 'browser' })
const from = toPath(new URL('../.work/stage/src/index.js', import.meta.url))
const fileName = () => 'renamed.mjs'
const to = toPath(new URL('../.work/stage/extensions/' + fileName(), import.meta.url).href)
await Bun.write(from, result.outputs[0])
await rename(from, to)
await rename(stage, join(root, 'dist'))
`);
    const plan = detectComposition(source);
    assert.equal(plan.files.get('extensions/renamed.mjs').module, path.join(source, 'src/index.js'));
    assert.equal(plan.files.has('src/index.js'), false);
    run(['dist/cli.js', 'give', '-d', source, '-b', '/site/', '--inline', 'y', '--no-public', noPublic ? 'y' : 'n']);
    const wrapper = path.join(source, 'mywrap');
    run(['install', '--ignore-scripts'], wrapper);
    run(['run', '--bun', 'build'], wrapper);
    if (noPublic) {
      assert.deepEqual(await readdir(path.join(wrapper, 'dist/assets')), ['index.js']);
      run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/site/');await import('./dist/assets/index.js');if(globalThis.fileURLAnswer!==42)throw Error('renamed module did not resolve');`], wrapper);
    } else {
      await stat(path.join(wrapper, 'dist/extensions/renamed.mjs'));
      await assert.rejects(stat(path.join(wrapper, 'dist/extensions/renamed.mjs.js')));
      run(['-e', `const module=await import('./dist/extensions/renamed.mjs');if(module.answer!==42)throw Error('renamed entry changed');`], wrapper);
    }
    assert.equal(await readFile(path.join(source, 'src/index.js'), 'utf8'), original);
    await assert.rejects(stat(path.join(source, 'dist')));
    await assert.rejects(stat(path.join(source, '.work')));
  });
}

for (const target of ['../../outside-project.js', 'https://example.invalid/never-read.js']) {
  test(`file-URL tracing rejects unsafe recipe targets: ${target}`, async context => {
    const source = await fixture(context);
    await writeFile(path.join(source, 'scripts/build.ts'), `
import { fileURLToPath } from 'node:url'
const entry = fileURLToPath(new URL(${JSON.stringify(target)}, import.meta.url))
await Bun.build({ entrypoints: [entry] })
`);
    assert.throws(() => detectComposition(source), /outside the project|project-local file URL/);
    await assert.rejects(stat(path.join(source, 'dist')));
  });
}

test("no-public preserves secondary page routes and embeds their CSS under their own CSP", async context => {
  const source = await fixture(context);
  await writeFile(path.join(source, 'source/native/assets/lazy.css'), '.dom-widget textarea { color: red; background: url(./pixel.svg) }');
  await writeFile(path.join(source, 'source/native/assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(source, 'source/native/assets/native.js'), `
    if (globalThis.title !== 'bootstrap') throw Error('bootstrap ran too late');
    const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = ['./unused.js', './lazy.css']))) => i.map(i => d[i]);
    const styles = __vite__mapDeps([0, 1]);
    if (styles.length !== 1 || !styles[0].startsWith('data:text/css;') || !styles[0].endsWith('.css')) throw Error('lazy CSS lost');
    const css = atob(styles[0].split(',')[1].split('#')[0]);
    if (!css.includes('.dom-widget textarea') || !css.includes('data:image/svg+xml;')) throw Error('widget CSS assets lost');
    const response = await fetch(new URL('../data/config.json', import.meta.url));
    if (!response.url.endsWith('/site/data/config.json')) throw Error('JSON URL changed');
    const config = await response.json();
    await import(config.extension);
    if (!globalThis.extensionLoaded) throw Error('lazy extension lost');
    globalThis.nativeReady = true;
  `);
  await writeFile(path.join(source, 'src/importer.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; connect-src https:"><link rel="stylesheet" href="./page.css"></head><body><script defer src="./importer.js"></script></body></html>');
  await writeFile(path.join(source, 'src/page.css'), 'body {color: green}');
  await writeFile(path.join(source, 'src/importer.ts'), 'window.parent.postMessage({ready:true},location.origin);');
  const script = path.join(source, 'scripts/build.ts');
  await writeFile(script, (await readFile(script, 'utf8'))
    .replace("['src/boot.ts', 'data/boot.js', 'iife']", "['src/importer.ts', 'tools/importer.js', 'iife'], ['src/boot.ts', 'data/boot.js', 'iife']")
    .replace("await Bun.write(join(stage, 'index.html'), html)", "await Bun.write(join(stage, 'index.html'), html)\nawait cp(join(root, 'src/importer.html'), join(stage, 'tools/importer.html'))\nawait cp(join(root, 'src/page.css'), join(stage, 'tools/page.css'))"));
  run(['dist/cli.js', 'give', '-d', source, '-b', '/site/', '--inline', 'y', '--no-public']);
  const wrapper = path.join(source, 'mywrap');
  const html = await readFile(path.join(wrapper, 'tools/importer.html'), 'utf8');
  assert.match(html, /type="module" src="\/src\/page-entry\/tools\/importer\.ts"/);
  assert.match(html, /href="%VITALITY_ASSET:/);
  assert.doesNotMatch(html, /href="\.\/page\.css"/);
  assert.match(html, /style-src 'self' data:/);
  assert.match(html, /connect-src https: data:/);
  assert.doesNotMatch(html, /connect-src 'self'/);
  assert.match(await readFile(path.join(wrapper, 'vite.config.ts'), 'utf8'), /"tools\/importer\.html"/);
  assert.match(await readFile(path.join(wrapper, 'vite.config.ts'), 'utf8'), /codeSplitting: false/);
  // Exercise the generated package, avoiding Bun's Windows mkdir-through-junction issue.
  const installed = spawnSync('bun', ['install', '--ignore-scripts'], { cwd: wrapper, encoding: 'utf8', windowsHide: true });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const built = run(['run', '--bun', 'build'], wrapper);
  assert.doesNotMatch(built.stderr, /remain unchanged|unresolved/i);
  assert.deepEqual(await readdir(path.join(wrapper, 'dist/assets')), ['index.js']);
  const page = await readFile(path.join(wrapper, 'dist/tools/importer.html'), 'utf8');
  assert.match(page, /href="data:text\/css;base64,/);
  assert.match(page, /<script type="module">[\s\S]*postMessage/);
  assert.match(page, /script-src 'self'\s+'sha256-/);
  assert.match(page, /connect-src https: data:/);
  assert.doesNotMatch(page, /src="[^\"]*\.js|%VITALITY_ASSET:/);
  const code = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.equal(code, code.trimEnd(), "serialized helper scripts must not lose a CSP-significant final newline");
  assert.ok(page.includes("'sha256-" + createHash('sha256').update(code).digest('base64') + "'"));
  const result = run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/site/');await import('./dist/assets/index.js');if(!globalThis.nativeReady)throw Error('not initialized');console.log('ordered, styled, extended');`], wrapper);
  assert.match(result.stdout, /ordered, styled, extended/);
});

test("ordinary source wrappers mark compiled helper scripts as modules with either inline setting", async context => {
  const source = await fixture(context);
  await writeFile(path.join(source, 'src/importer.html'), '<script defer src="./importer.js"></script>');
  await writeFile(path.join(source, 'src/importer.ts'), 'window.parent.postMessage({ready:true},location.origin);');
  const script = path.join(source, 'scripts/build.ts');
  await writeFile(script, (await readFile(script, 'utf8'))
    .replace("['src/boot.ts', 'data/boot.js', 'iife']", "['src/importer.ts', 'tools/importer.js', 'iife'], ['src/boot.ts', 'data/boot.js', 'iife']")
    .replace("await Bun.write(join(stage, 'index.html'), html)", "await Bun.write(join(stage, 'index.html'), html)\nawait cp(join(root, 'src/importer.html'), join(stage, 'tools/importer.html'))"));
  for (const inline of ['y', 'n']) {
    run(['dist/cli.js', 'give', '-d', source, '-o', 'wrap-' + inline, '-b', '/site/', '--inline', inline, '--no-public', 'n']);
    const wrapper = path.join(source, 'wrap-' + inline);
    assert.match(await readFile(path.join(wrapper, 'public/tools/importer.html'), 'utf8'), /<script type="module"\s+src="\.\/importer\.js">/);
    assert.match(await readFile(path.join(wrapper, 'src/main.ts'), 'utf8'), /boot\.ts[\s\S]*assets\/native\.js/);
  }
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
