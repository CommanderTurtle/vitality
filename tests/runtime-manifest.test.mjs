import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
