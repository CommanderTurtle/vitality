import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('y/n preserves manifest modules, worker graphs and directory-addressed engines', { timeout: 30_000 }, async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'vitality-public-runtime-'));
  const run = (args, cwd) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  try {
    for (const dir of ['assets', 'extensions', 'workers', 'engines', 'unrelated']) await mkdir(path.join(source, dir));
    await writeFile(path.join(source, 'index.html'), '<html><head><link rel="stylesheet" href="./assets/style.css"></head><body><script type="module" src="./assets/main.js"></script></body></html>');
    await writeFile(path.join(source, 'assets/style.css'), 'body{color:green}');
    await writeFile(path.join(source, 'config.json'), '{"extension":"/extensions/custom.mjs"}');
    await writeFile(path.join(source, 'assets/main.js'), `
      import { shared } from '../extensions/shared.mjs?v=1';
      import sourceText from '../extensions/shared.mjs?raw';
      const response = await fetch(new URL('config.json', new URL('../', import.meta.url)));
      const config = await response.json();
      const extension = await import(new URL(config.extension, response.url).href);
      globalThis.publicAnswer = shared + extension.answer;
      globalThis.sharedSource = sourceText;
      globalThis.engineDirectory = new URL('../engines/', import.meta.url).href;
      globalThis.sidecar = new URL('../engines/core.wasm?raw=1#binary', import.meta.url).href;
      new Worker(new URL('../workers/renderer.mjs', import.meta.url), {type:'module'});
    `);
    const extension = `import { shared } from './shared.mjs'; export const answer = shared + 1; export const wasm = new URL('../engines/core.wasm', import.meta.url).href;`;
    const worker = `import { shared } from '../extensions/shared.mjs'; self.postMessage(shared);`;
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    await writeFile(path.join(source, 'extensions/custom.mjs'), extension);
    await writeFile(path.join(source, 'extensions/shared.mjs'), 'export const shared = 20;');
    await writeFile(path.join(source, 'workers/renderer.mjs'), worker);
    await writeFile(path.join(source, 'engines/core.wasm'), wasm);
    await writeFile(path.join(source, 'engines/model.bin'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(source, 'unrelated/unused.wasm'), wasm);
    for (const [index, base] of ['/nested/', './'].entries()) {
      const wrapper = path.join(source, 'wrap-' + index);
      run([path.join(repo, 'dist/cli.js'), 'give', '-d', source, '-o', wrapper, '-b', base, '--inline', 'y', '--no-public', 'n'], repo);
      assert.equal(await readFile(path.join(wrapper, 'public/extensions/custom.mjs'), 'utf8'), extension);
      assert.equal(await readFile(path.join(wrapper, 'public/workers/renderer.mjs'), 'utf8'), worker);
      assert.deepEqual(await readFile(path.join(wrapper, 'public/engines/core.wasm')), wasm);
      assert.equal(JSON.parse(await readFile(path.join(wrapper, 'public/config.json'), 'utf8')).extension,
        base === './' ? './extensions/custom.mjs' : '/nested/extensions/custom.mjs');
      await assert.rejects(readFile(path.join(wrapper, 'public/unrelated/unused.wasm')));
      const installed = spawnSync('bun', ['install', '--ignore-scripts'], { cwd: wrapper, encoding: 'utf8', windowsHide: true });
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const server = await createServer({ root: wrapper, logLevel: 'silent', server: { middlewareMode: true, watch: null, hmr: false } });
      try {
        const served = await server.transformRequest('/src/app/assets/main.ts');
        assert.ok(served?.code.includes((base === './' ? '/' : base) + 'extensions/shared.mjs?v=1'), served?.code);
        assert.doesNotMatch(served.code, /from ["'][^"']*public\/extensions\/shared\.mjs\?v=1/);
      } finally { await server.close(); }
      const built = run([path.join(repo, 'node_modules/vite/bin/vite.js'), 'build'], wrapper);
      assert.doesNotMatch(built.stderr, /remain unchanged|unresolved|can't be bundled/i);
      const code = await readFile(path.join(wrapper, 'dist/assets/index.js'), 'utf8');
      assert.ok(code.includes(base === './' ? '../extensions/shared.mjs?v=1' : '/nested/extensions/shared.mjs?v=1'), code);
      assert.ok(code.includes('engines/core.wasm?raw=1#binary'));
      assert.ok(code.includes('engines/'));
      assert.ok(code.includes('workers/renderer.mjs'));
      assert.ok(code.includes('export const shared = 20;'));
      assert.ok(!code.includes('__vitalityEmbedded') && !code.includes('__vitalityNative'));
      assert.equal(await readFile(path.join(wrapper, 'dist/extensions/custom.mjs'), 'utf8'), extension);
      assert.deepEqual(await readFile(path.join(wrapper, 'dist/engines/core.wasm')), wasm);
      assert.deepEqual(await readdir(path.join(wrapper, 'dist/engines')), ['core.wasm', 'model.bin']);
    }
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('no-public resolves a built-site extension discovered only through JSON', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'vitality-manifest-'));
  const wrapper = path.join(source, 'mywrap');
  const run = (args, cwd) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    await mkdir(path.join(source, 'assets'));
    await mkdir(path.join(source, 'extensions'));
    await writeFile(path.join(source, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'"><script type="module" src="./assets/main.js"></script></head><body></body></html>`);
    await writeFile(path.join(source, 'config.json'), '{"extension":"/nested/extensions/custom.js"}');
    await writeFile(path.join(source, 'assets/main.js'), `
      globalThis.helperURL = new URL('helper.html', new URL('../', import.meta.url)).href;
      globalThis.aboutURL = new URL('about.html', new URL('../', import.meta.url)).href;
      const config = await fetch(new URL('config.json', new URL('../', import.meta.url))).then(r => r.json());
      const extension = await import(new URL(config.extension, location.href).href);
      globalThis.manifestAnswer = extension.answer;
    `);
    await writeFile(path.join(source, 'extensions/custom.js'), 'export const answer = 42;');
    await writeFile(path.join(source, 'helper.html'), '<html><head><script defer src="./assets/helper.js"></script></head><body>Static helper</body></html>');
    await writeFile(path.join(source, 'assets/helper.js'), 'globalThis.helperLoaded = true;');
    await writeFile(path.join(source, 'about.html'), '<html><head></head><body>Static information</body></html>');
    run([path.join(repo, 'dist/cli.js'), 'give', '-d', source, '-b', '/nested/', '--inline', 'y', '--no-public', 'y'], repo);
    assert.match(await readFile(path.join(wrapper, 'src/inline-runtime.ts'), 'utf8'), /"extensions\/custom\.js": \(\) => import/);
    // Exercise the generated package, avoiding Bun's Windows mkdir-through-junction issue.
    const installed = spawnSync('bun', ['install', '--ignore-scripts'], { cwd: wrapper, encoding: 'utf8', windowsHide: true });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    run([path.join(repo, 'node_modules/vite/bin/vite.js'), 'build'], wrapper);
    const helper = await readFile(path.join(wrapper, 'dist/helper.html'), 'utf8');
    assert.match(helper, /Static helper/);
    assert.doesNotMatch(helper, /src=["'](?:\.\/|\/)?assets\/helper\.js/);
    assert.match(await readFile(path.join(wrapper, 'dist/about.html'), 'utf8'), /Static information/);
    run(['-e', `globalThis.window=globalThis;globalThis.location=new URL('https://example.test/nested/');await import('./dist/assets/index.js');if(globalThis.manifestAnswer!==42)throw Error('Manifest extension did not execute');if(globalThis.helperURL!=='https://example.test/nested/helper.html')throw Error('Helper escaped the deployment base: '+globalThis.helperURL);`], wrapper);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
