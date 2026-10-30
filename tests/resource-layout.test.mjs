import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript-parser';
import { detectLibraryPlan } from '../dist/composition.js';
import { publicRuntime } from '../dist/public-runtime.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(args, cwd = repo) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

function browserSource(code, url) {
  const parsed = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.getText(parsed) === 'import.meta.url') edits.push([node.getStart(parsed), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const [start, end] of edits.reverse()) code = code.slice(0, start) + JSON.stringify(url) + code.slice(end);
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}

for (const [inline, noPublic] of [['n', 'n'], ['y', 'n'], ['y', 'y']]) {
 for (const native of inline === 'n' ? [false] : [false, true]) {
  test(`prebuilt binary imports and worker URLs share one payload (${inline}/${noPublic}, native=${native})`, { timeout: 30_000 }, async context => {
    const source = await mkdtemp(path.join(tmpdir(), 'vitality-prebuilt-binaries-'));
    context.after(() => rm(source, { recursive: true, force: true }));
    await mkdir(path.join(source, 'assets'));
    for (const [name, bytes] of Object.entries(binaries)) await writeFile(path.join(source, 'assets', name), bytes);
    const imports = Object.keys(binaries).map((name, index) => `import binary${index} from './${name}?url';`).join('\n');
    const urls = 'export const urls=[' + Object.keys(binaries).map((name, index) => `binary${index}`).join(',') + '];';
    const urlFiles = 'globalThis.fileURLs=[' + Object.keys(binaries).map(name => `new URL(${JSON.stringify('./' + name)},import.meta.url).href`).join(',') + '];';
    const fetches = 'globalThis.payloads=await Promise.all(urls.map(url=>fetch(url).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))));';
    await writeFile(path.join(source, 'assets/main.js'), imports + urls + urlFiles + fetches + 'globalThis.spawn=()=>new Worker(new URL("./worker.js",import.meta.url),{type:"module"});');
    await writeFile(path.join(source, 'assets/worker.js'), imports + urls + urlFiles + 'self.postMessage(urls);');
    await writeFile(path.join(source, 'index.html'), '<script type="module" src="./assets/main.js"></script>');
    if (native) await writeFile(path.join(source, 'vite.config.js'), 'export default {build:{target:"esnext",modulePreload:false}};');
    const wrapper = path.join(source, 'mywrap');
    run(['dist/cli.js', 'give', '-d', source, '-b', '/nested/', '--inline', inline, '--no-public', noPublic]);
    run(['install', '--ignore-scripts'], wrapper);
    run(['run', '--bun', 'build'], wrapper);
    const emitted = await files(path.join(wrapper, 'dist'));
    const html = await readFile(path.join(wrapper, 'dist/index.html'), 'utf8');
    const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+)/)[1].replace(/^\/nested\//, '');
    const moduleURL = browserSource(await readFile(path.join(wrapper, 'dist', entry), 'utf8'), 'https://example.test/nested/' + entry);
    for (const [name, bytes] of Object.entries(binaries)) {
      const copies = [];
      for (const file of emitted.filter(file => file.endsWith(path.extname(name)))) if ((await readFile(path.join(wrapper, 'dist', file))).equals(bytes)) copies.push(file);
      assert.equal(copies.length, 1, name + ': ' + copies);
    }
    run(['-e', `
      import {readFile} from 'node:fs/promises';
      globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');
      globalThis.fetch=async input=>{
        const url=new URL(input instanceof Request?input.url:String(input),location);
        if(url.origin!==location.origin||!url.pathname.startsWith('/nested/'))throw Error('escaped deployment '+url);
        return new Response(await readFile('./dist/'+decodeURIComponent(url.pathname.slice('/nested/'.length))));
      };
      await import(${JSON.stringify(moduleURL)});
      if(JSON.stringify(globalThis.payloads)!==${JSON.stringify(JSON.stringify(Object.values(binaries).map(bytes => [...bytes])))})throw Error('binary payload mismatch');
      const byURL=await Promise.all(globalThis.fileURLs.map(url=>fetch(url).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))));
      if(JSON.stringify(byURL)!==JSON.stringify(globalThis.payloads))throw Error('URL and import graphs disagree');
    `], wrapper);
  });
 }
}
async function files(root, prefix = '') {
  const found = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, item.name);
    if (item.isDirectory()) found.push(...await files(root, name)); else found.push(name);
  }
  return found;
}

test('runtime discovery leaves malformed data strings alone while finding real resources', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'vitality-url-data-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'main.js'), asset = path.join(root, 'payload.tar');
  const data = ['\\\\[', '/\\[', ' \n//[', '\thttp://[', '%zz', 'https://[', '//[', '.', '..', '#['];
  const code = 'export const values=' + JSON.stringify(data) + ';export const payload=new URL("./payload.tar",import.meta.url);';
  await writeFile(file, code);
  await writeFile(asset, 'payload');
  const graph = await publicRuntime([file, asset], new Set([file]), root, '/site/', new Set());
  assert.ok(graph.files.has(asset));
  const output = graph.rewrite(code, file);
  assert.ok(output.includes(JSON.stringify(data)));
  assert.ok(output.includes('payload.tar'));
});

const binaries = {
  'module.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  'model.tar': Buffer.from('tar payload\0\xff\x80', 'latin1'),
  'language.gz': Buffer.from([31, 139, 8, 0, 255, 0, 7]),
};

test('recipe copies, removals and staging renames are read as one local layout', async context => {
  const source = await mkdtemp(path.join(tmpdir(), 'vitality-copy-plan-'));
  context.after(() => rm(source, {recursive:true,force:true}));
  await mkdir(path.join(source, 'models'));
  await writeFile(path.join(source, 'package.json'), JSON.stringify({type:'module',scripts:{build:'node build.mjs'}}));
  await writeFile(path.join(source, 'index.js'), 'export const answer=42;');
  for (const name of ['keep.tar','remove.gz','.env.private']) await writeFile(path.join(source, 'models', name), name);
  await writeFile(path.join(source, 'build.mjs'), `
    import {build} from 'vite';import {cp,rm,rename} from 'node:fs/promises';
    await build({build:{lib:{entry:'index.js',formats:['es'],fileName:()=> 'renamed.mjs'}}});
    await cp('models','dist/stage',{recursive:true});
    await rm('dist/stage/remove.gz');await rename('dist/stage','dist/models');
  `);
  const plan = detectLibraryPlan(source);
  assert.deepEqual([...plan.files.keys()], ['models/keep.tar']);
  assert.equal(await readFile(plan.files.get('models/keep.tar'), 'utf8'), 'keep.tar');
  await assert.rejects(stat(path.join(source, 'dist')));
  const script = await readFile(path.join(source, 'build.mjs'), 'utf8');
  await writeFile(path.join(source, 'build.mjs'), script.replace("'dist/stage'", "'../outside'"));
  assert.throws(() => detectLibraryPlan(source), /outside the project/);
});

for (const [inline, noPublic] of [['n', 'n'], ['y', 'n'], ['y', 'y']]) {
  for (const base of ['/nested/', './']) {
   for (const native of inline === 'n' ? [false] : [false, true]) {
    test(`unbuilt library output layout keeps binary bytes and URLs (${inline}/${noPublic}, ${base}, native=${native})`, { timeout: 30_000 }, async context => {
      const source = await mkdtemp(path.join(tmpdir(), 'vitality-binary-layout-'));
      context.after(() => rm(source, { recursive: true, force: true }));
      for (const dir of ['demo', 'src', 'scripts', '.cache/models']) await mkdir(path.join(source, dir), { recursive: true });
      for (const [name, bytes] of Object.entries(binaries)) await writeFile(path.join(source, '.cache/models', name), bytes);
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'binary-layout', type: 'module', scripts: { build: 'bun scripts/build.mjs' } }));
      await writeFile(path.join(source, 'scripts/build.mjs'), `
        import { build } from 'vite';
        import { fileURLToPath } from 'node:url';
        import { cp } from 'node:fs/promises';
        const root = new URL('../', import.meta.url);
        await neverRunPreparation();
        await build({configFile:false,root:fileURLToPath(root),build:{outDir:'dist',lib:{entry:fileURLToPath(new URL('src/index.js',root)),formats:['es'],fileName:()=> 'engine/renamed.mjs'}}});
        for (const name of ['module.wasm','model.tar','language.gz']) {
          const input = new URL('.cache/models/' + name, root);
          await cp(input, new URL('dist/engine/binaries/' + name, root));
        }
      `);
      await writeFile(path.join(source, 'src/index.js'), 'export { links } from "./helper.js";');
      await writeFile(path.join(source, 'src/helper.js'), 'export const links = ["module.wasm","model.tar","language.gz"].map(name=>new URL("./binaries/"+name,import.meta.url).href);');
      await writeFile(path.join(source, 'demo/index.html'), '<script type="module" src="./main.js"></script>');
      await writeFile(path.join(source, 'demo/main.js'), `import { links } from './engine/renamed.mjs';globalThis.resourceLinks=links;globalThis.payloads=await Promise.all(links.map(url=>fetch(url).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))));`);
      if (native) await writeFile(path.join(source, 'vite.config.js'), 'export default {root:"demo",build:{target:"esnext",modulePreload:false}};');
      const plan = detectLibraryPlan(source);
      assert.deepEqual([...plan.files.keys()].sort(), Object.keys(binaries).map(name => 'engine/binaries/' + name).sort());
      await assert.rejects(stat(path.join(source, 'dist')));
      const wrapper = path.join(source, 'mywrap');
      run(['dist/cli.js', 'give', '-d', source, '-b', base, '--inline', inline, '--no-public', noPublic]);
      const manifest = !native && noPublic === 'y' ? JSON.parse(await readFile(path.join(wrapper, 'src/embedded-files.json'), 'utf8')) : null;
      for (const [name, bytes] of Object.entries(binaries)) {
        const target = manifest?.['engine/binaries/' + name] ?? (native ? 'vitality-resources/' : 'public/') + 'engine/binaries/' + name;
        assert.deepEqual(await readFile(path.join(wrapper, target)), bytes);
      }
      run(['install', '--ignore-scripts'], wrapper);
      run(['run', '--bun', 'build'], wrapper);
      const emitted = await files(path.join(wrapper, 'dist'));
      const html = await readFile(path.join(wrapper, 'dist/index.html'), 'utf8');
      const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+)/)[1].replace(/^\/nested\//, '').replace(/^\.\//, '');
      const moduleURL = browserSource(await readFile(path.join(wrapper, 'dist', entry), 'utf8'), 'https://example.test/nested/' + entry);
      for (const [name, bytes] of Object.entries(binaries)) {
        const matches = [];
        for (const file of emitted.filter(file => file.endsWith(path.extname(name)))) {
          if ((await readFile(path.join(wrapper, 'dist', file))).equals(bytes)) matches.push(file);
        }
        assert.equal(matches.length, 1, name + ': ' + matches);
      }
      // A local fetch stub checks actual packaged paths, including the resolver
      // inside no-public output. Every unexpected/out-of-base request fails.
      run(['-e', `
        import {readFile} from 'node:fs/promises';
        globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');
        globalThis.fetch=async input=>{
          const url=new URL(input instanceof Request?input.url:String(input),location);
          if(url.origin!==location.origin||!url.pathname.startsWith('/nested/'))throw Error('escaped deployment '+url);
          return new Response(await readFile('./dist/'+decodeURIComponent(url.pathname.slice('/nested/'.length))));
        };
        await import(${JSON.stringify(moduleURL)});
        if(JSON.stringify(globalThis.payloads)!==${JSON.stringify(JSON.stringify(Object.values(binaries).map(bytes => [...bytes])))})throw Error('binary payload mismatch');
      `], wrapper);
    });
   }
  }
}
