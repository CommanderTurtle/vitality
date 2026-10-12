import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const noPublic of [false, true]) {
  test(`dot markers survive wrapping beside a matching module (no-public=${noPublic})`, async context => {
    const source = await mkdtemp(path.join(os.tmpdir(), "vitality-dot-markers-"));
    context.after(() => rm(source, { recursive: true, force: true }));
    await mkdir(path.join(source, "src/pacman"), { recursive: true });
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/pacman/maze.js"></script>');
    await writeFile(path.join(source, "src.js"), 'export const parent = "parent";');
    await writeFile(path.join(source, "src/pacman.js"), 'export const sibling = "sibling";');
    await writeFile(path.join(source, "src/pacman/maze.js"), `
      export { sibling } from ".";
      export { parent } from "..";
      export const load = () => import(".");
      export const markers = [".", '..', \`.\`];
      export const count = row => [...row].filter(c => c === ".").length;
      export function cell(c, present) {
        if (c === ".") return present ? "." : " ";
        return c;
      }
    `);
    const result = spawnSync(process.execPath, [
      path.join(repository, "dist/cli.js"), "give", "-d", source, "-b", "/game/", "--inline", "yes",
      ...(noPublic ? ["--no-public"] : []),
    ], { cwd: repository, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const file = path.join(source, "mywrap/src/app/src/pacman/maze.ts");
    const copied = await readFile(file, "utf8");
    assert.match(copied, /from "\.\.\/pacman\.ts"/u);
    assert.match(copied, /from "\.\.\/\.\.\/src\.ts"/u);
    const maze = await import(pathToFileURL(file).href);
    assert.deepEqual(maze.markers, [".", "..", "."]);
    assert.equal(maze.count("#..o..#"), 4);
    assert.equal(maze.cell(".", true), ".");
    assert.equal(maze.cell(".", false), " ");
    assert.equal(maze.sibling, "sibling");
    assert.equal(maze.parent, "parent");
    assert.equal((await maze.load()).sibling, "sibling");
  });
}
