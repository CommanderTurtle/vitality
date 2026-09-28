import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UsageError } from "./args.js";
import { containsPath } from "./paths.js";

const excludedDirectoryNames = new Set([
  ".git", ".hg", ".svn", ".github", ".cache", ".tmp", ".vite", "node_modules",
  "coverage", "dist", "build", "test", "tests", "__tests__", "docs", "tools",
]);

const entrySearchExcludedDirectoryNames = new Set([
  ".git", ".hg", ".svn", ".github", ".cache", ".tmp", ".vite", "node_modules",
  "coverage", "dist", "build", "test", "tests", "__tests__", "tools",
]);

const deploymentPublicNames = new Set([
  ".nojekyll", "404.html", "CNAME", "_headers", "_redirects",
]);

const excludedRootFiles = [
  /^package(?:-lock)?\.json$/u,
  /^(?:bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/u,
  /^vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/u,
  /^tsconfig(?:\.[^.]+)?\.json$/u,
  /^\.(?:gitignore|gitattributes|npmrc)$/u,
  /^(?:README|LICENSE|LICENCE|CHANGELOG)(?:\..*)?$/iu,
];

const moduleScriptPattern = /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/giu;
const styleLinkPattern = /<link\b([^>]*)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/giu;
const inlineModulePattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const importPattern = /\b(?:import\s*(?:[^"'`]*?\sfrom\s*)?|export\s+[^"'`]*?\sfrom\s*|import\s*\()\s*(["'])([^"']+)\1/gu;
const quotedPathPattern = /(["'`])([^"'`\r\n]+)\1/gu;
const unquotedCssUrlPattern = /(url\(\s*)(?!["']|data:|#)([^)\s]+)(\s*\))/giu;
const importMetaUrlPattern = /new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/gu;

export interface CopySummary {
  copiedFiles: number;
  copiedBytes: number;
  excludedEntries: number;
  skippedLinks: number;
  pages: string[];
}

interface SourceInventory {
  files: string[];
  excludedEntries: number;
  skippedLinks: number;
}

export interface SourceEntry {
  index: string;
  root: string;
  relative: string;
  sourceBuild?: { outDir: string };
}

function webPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function resolveSourceEntry(source: string, buildOutput = "dist"): Promise<SourceEntry> {
  const rootIndex = path.join(source, "index.html");
  try {
    const metadata = await stat(rootIndex);
    if (!metadata.isFile()) throw new UsageError(`source index.html is not a file: ${rootIndex}`);
    return { index: rootIndex, root: source, relative: "index.html" };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new UsageError(`could not inspect source index.html: ${(error as Error).message}`);
    }
  }

  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new UsageError(`could not read source package.json: ${(error as Error).message}`);
    }
  }
  // Without a root HTML entry, a package builder owns assembly of the app.
  // Vendor HTML and stale output cannot substitute for that project recipe.
  if (typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim()) {
    if (path.isAbsolute(buildOutput) || /[:\0]/u.test(buildOutput) || buildOutput.split(/[\\/]/u).some((part) =>
      !part || part.startsWith(".") || ["node_modules", "src", "source", "scripts", "mywrap"].includes(part.toLowerCase()))) {
      throw new UsageError("--build-output must name a relative generated directory, not source, dependencies or a parent directory");
    }
    return { root: source, index: "", relative: "package.json#scripts.build", sourceBuild: { outDir: buildOutput } };
  }

  const candidates: string[] = [];
  const pending = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!entrySearchExcludedDirectoryNames.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === "index.html") candidates.push(absolute);
    }
  }

  if (candidates.length === 0) {
    throw new UsageError(`source directory contains no index.html: ${source}`);
  }
  candidates.sort((left, right) => left.localeCompare(right));
  const depth = (candidate: string): number => path.relative(source, candidate).split(path.sep).length;
  const shallowestDepth = Math.min(...candidates.map(depth));
  const shallowest = candidates.filter((candidate) => depth(candidate) === shallowestDepth);
  if (shallowest.length > 1) {
    const choices = shallowest.map((candidate) => `  - ${webPath(path.relative(source, candidate))}`).join("\n");
    throw new UsageError(
      `source has multiple equally shallow nested index.html entries:\n${choices}\n`
      + "point --dir at the intended site directory",
    );
  }

  const index = shallowest[0];
  if (index === undefined) throw new Error("nested index discovery returned no candidate");
  return {
    index,
    root: path.dirname(index),
    relative: webPath(path.relative(source, index)),
  };
}

function isRemoteReference(value: string): boolean {
  return value === "" || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(value);
}

function referenceParts(value: string): { pathname: string; suffix: string } {
  const boundary = value.search(/[?#]/u);
  return boundary < 0
    ? { pathname: value, suffix: "" }
    : { pathname: value.slice(0, boundary), suffix: value.slice(boundary) };
}

function resolveReference(
  file: string,
  value: string,
  known: Set<string>,
  sourceRoot: string,
): string | undefined {
  if (isRemoteReference(value)) return undefined;
  const { pathname } = referenceParts(value);
  if (pathname === "") return undefined;
  const direct = pathname.startsWith("/")
    ? path.resolve(sourceRoot, pathname.slice(1))
    : path.resolve(path.dirname(file), pathname);
  const candidates = path.extname(direct) === ""
    ? [
      direct,
      `${direct}.js`, `${direct}.jsx`, `${direct}.mjs`, `${direct}.ts`, `${direct}.tsx`, `${direct}.mts`,
      path.join(direct, "index.js"), path.join(direct, "index.jsx"), path.join(direct, "index.tsx"),
    ]
    : [direct];
  return candidates.find((candidate) => known.has(candidate));
}

async function inventory(source: string, output: string, temporary: string): Promise<SourceInventory> {
  const files: string[] = [];
  let excludedEntries = 0;
  let skippedLinks = 0;
  const pending = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (absolute === output || absolute === temporary
          || containsPath(output, absolute) || containsPath(temporary, absolute)) {
        excludedEntries += 1;
        continue;
      }
      const relative = path.relative(source, absolute);
      const parts = relative.split(path.sep);
      if (entry.isDirectory() && parts.some((part) => excludedDirectoryNames.has(part))) {
        excludedEntries += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (parts.length === 1 && excludedRootFiles.some((pattern) => pattern.test(entry.name))) {
        excludedEntries += 1;
        continue;
      }
      if (entry.name === ".env" || entry.name.startsWith(".env.")) {
        excludedEntries += 1;
        continue;
      }
      if (/\.md$/iu.test(entry.name) || /^(?:LICENSE|LICENCE|NOTICE)(?:\..*)?$/iu.test(entry.name)) {
        excludedEntries += 1;
        continue;
      }
      files.push(absolute);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, excludedEntries, skippedLinks };
}

function localModuleSources(
  html: string,
  htmlFile: string,
  known: Set<string>,
  sourceRoot: string,
): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(moduleScriptPattern)) {
    const before = match[1] ?? "";
    const after = match[4] ?? "";
    if (!/\btype\s*=\s*(["'])module\1/iu.test(`${before} ${after}`)) continue;
    const resolved = resolveReference(htmlFile, match[3] ?? "", known, sourceRoot);
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

async function discoverReachable(
  files: string[], sourceIndex: string, sourceRoot: string,
): Promise<Set<string>> {
  const known = new Set(files);
  const reachable = new Set<string>([sourceIndex]);
  const pending = [sourceIndex];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !isTextFile(current)) continue;
    const content = await readFile(current, "utf8");
    for (const match of content.matchAll(quotedPathPattern)) {
      const value = match[2] ?? "";
      const { pathname } = referenceParts(value);
      if (!pathname.startsWith(".") && !pathname.includes("/") && path.extname(pathname) === "") continue;
      const resolved = resolveReference(current, value, known, sourceRoot);
      if (resolved === undefined || reachable.has(resolved)) continue;
      reachable.add(resolved);
      pending.push(resolved);
    }
  }
  return reachable;
}

async function discoverModules(
  files: string[], reachable: Set<string>, sourceRoot: string,
): Promise<Set<string>> {
  const known = new Set(files);
  const modules = new Set<string>();
  for (const file of files.filter((candidate) => reachable.has(candidate) && /\.html?$/iu.test(candidate))) {
    const html = await readFile(file, "utf8");
    for (const module of localModuleSources(html, file, known, sourceRoot)) modules.add(module);
  }

  const pending = [...modules];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !/\.(?:[cm]?[jt]sx?)$/iu.test(current)) continue;
    const code = await readFile(current, "utf8");
    for (const match of code.matchAll(importPattern)) {
      const resolved = resolveReference(current, match[2] ?? "", known, sourceRoot);
      if (resolved === undefined || modules.has(resolved) || !/\.(?:[cm]?[jt]sx?)$/iu.test(resolved)) continue;
      modules.add(resolved);
      pending.push(resolved);
    }
  }
  return modules;
}

async function discoverClassicScripts(
  files: string[], reachable: Set<string>, sourceRoot: string,
): Promise<Set<string>> {
  const known = new Set(files);
  const scripts = new Set<string>();
  for (const file of files.filter((candidate) => reachable.has(candidate) && /\.html?$/iu.test(candidate))) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(moduleScriptPattern)) {
      const before = match[1] ?? "";
      const after = match[4] ?? "";
      if (/\btype\s*=\s*(["'])module\1/iu.test(`${before} ${after}`)) continue;
      const resolved = resolveReference(file, match[3] ?? "", known, sourceRoot);
      if (resolved !== undefined) scripts.add(resolved);
    }
  }
  return scripts;
}

function jsonStringReferences(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonStringReferences(item, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) jsonStringReferences(item, found);
  }
}

async function localJsonReferences(
  file: string, known: Set<string>, sourceRoot: string,
): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const values: string[] = [];
  jsonStringReferences(parsed, values);
  const found = new Set<string>();
  for (const value of values) {
    const { pathname } = referenceParts(value);
    if (!pathname.startsWith(".") && !pathname.includes("/") && path.extname(pathname) === "") continue;
    const resolved = resolveReference(file, value, known, sourceRoot);
    if (resolved !== undefined) found.add(resolved);
  }
  return [...found];
}

async function discoverPublicJson(
  files: string[], reachable: Set<string>, sourceRoot: string,
): Promise<Set<string>> {
  const known = new Set(files);
  const references = new Map<string, string[]>();
  for (const file of files.filter((candidate) => reachable.has(candidate) && candidate.endsWith(".json"))) {
    references.set(file, await localJsonReferences(file, known, sourceRoot));
  }
  const publicJson = new Set<string>();
  const pending: string[] = [];
  for (const [file, targets] of references) {
    if (targets.length === 0) continue;
    publicJson.add(file);
    pending.push(file);
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const target of references.get(current) ?? []) {
      if (!target.endsWith(".json") || publicJson.has(target)) continue;
      publicJson.add(target);
      pending.push(target);
    }
  }
  return publicJson;
}

function destinationFor(
  source: string,
  file: string,
  wrapperRoot: string,
  appRoot: string,
  modules: Set<string>,
  reachable: Set<string>,
  publicFiles: Set<string>,
): string {
  let relative = path.relative(source, file);
  if (publicFiles.has(file)) return path.join(wrapperRoot, "public", relative);
  if (/\.html?$/iu.test(relative)) {
    if (!reachable.has(file)) throw new Error(`unroutable HTML has no destination: ${relative}`);
    return path.join(wrapperRoot, relative);
  }
  if (modules.has(file)) {
    const extension = path.extname(relative).toLowerCase();
    if (extension === ".js") relative = `${relative.slice(0, -3)}.ts`;
    else if (extension === ".mjs") relative = `${relative.slice(0, -4)}.mts`;
    else if (extension === ".jsx") relative = `${relative.slice(0, -4)}.tsx`;
  }
  return path.join(appRoot, relative);
}

function rewrittenReference(
  value: string,
  sourceFile: string,
  destinationFile: string,
  known: Set<string>,
  destinations: Map<string, string>,
  sourceRoot: string,
  publicRoot: string,
): string | undefined {
  const { pathname, suffix } = referenceParts(value);
  if (!pathname.startsWith(".") && !pathname.includes("/") && path.extname(pathname) === "") {
    return undefined;
  }
  const target = resolveReference(sourceFile, value, known, sourceRoot);
  if (target === undefined) return undefined;
  const destination = destinations.get(target);
  if (destination === undefined) return undefined;
  if (containsPath(publicRoot, destination)) {
    if (!/\.html?$/iu.test(sourceFile)) return undefined;
    const relative = webPath(path.relative(publicRoot, destination));
    return `%BASE_URL%${relative}${suffix}`;
  }
  let relative = webPath(path.relative(path.dirname(destinationFile), destination));
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return `${relative}${suffix}`;
}

function rewriteLocalReferences(
  content: string,
  sourceFile: string,
  destinationFile: string,
  known: Set<string>,
  destinations: Map<string, string>,
  sourceRoot: string,
  publicRoot: string,
): string {
  let rewrittenContent = content.replace(quotedPathPattern, (whole, quote: string, value: string) => {
    const rewritten = rewrittenReference(
      value, sourceFile, destinationFile, known, destinations, sourceRoot, publicRoot,
    );
    return rewritten === undefined ? whole : `${quote}${rewritten}${quote}`;
  });
  if (path.extname(sourceFile).toLowerCase() === ".css") {
    rewrittenContent = rewrittenContent.replace(
      unquotedCssUrlPattern,
      (whole, prefix: string, value: string, suffix: string) => {
        const rewritten = rewrittenReference(
          value, sourceFile, destinationFile, known, destinations, sourceRoot,
          publicRoot,
        );
        return rewritten === undefined ? whole : `${prefix}${rewritten}${suffix}`;
      },
    );
  }
  if (/\.(?:[cm]?[jt]sx?)$/iu.test(sourceFile)) {
    rewrittenContent = rewrittenContent.replace(
      importMetaUrlPattern,
      (whole, _quote: string, value: string) => {
        const target = resolveReference(sourceFile, value, known, sourceRoot);
        const destination = target === undefined ? undefined : destinations.get(target);
        if (destination === undefined || !containsPath(publicRoot, destination)) return whole;
        const relative = webPath(path.relative(publicRoot, destination));
        return `new URL(import.meta.env.BASE_URL + ${JSON.stringify(relative)}, globalThis.location.href)`;
      },
    );
  }
  return rewrittenContent;
}

function isTextFile(file: string): boolean {
  return /\.(?:css|cjs|cts|html?|js|jsx|json|mjs|mts|qml|svg|ts|tsx|txt|xml)$/iu.test(file);
}

function rootEntry(
  sourceIndex: string,
  sourceRoot: string,
  wrapperIndex: string,
  original: string,
  known: Set<string>,
  destinations: Map<string, string>,
  publicRoot: string,
): { html: string; main: string } {
  const mainFile = path.join(path.dirname(wrapperIndex), "src", "main.ts");
  const imports: string[] = [];
  let html = original.replace(styleLinkPattern, (whole, before: string, _quote: string, href: string, after: string) => {
    if (!/\brel\s*=\s*(["'])stylesheet\1/iu.test(`${before} ${after}`)) return whole;
    const target = resolveReference(sourceIndex, href, known, sourceRoot);
    const destination = target === undefined ? undefined : destinations.get(target);
    if (destination === undefined) return whole;
    let relative = webPath(path.relative(path.dirname(mainFile), destination));
    if (!relative.startsWith(".")) relative = `./${relative}`;
    imports.push(`import ${JSON.stringify(relative)};`);
    return "";
  });

  html = html.replace(moduleScriptPattern, (whole, before: string, _quote: string, src: string, after: string) => {
    if (!/\btype\s*=\s*(["'])module\1/iu.test(`${before} ${after}`)) return whole;
    const target = resolveReference(sourceIndex, src, known, sourceRoot);
    const destination = target === undefined ? undefined : destinations.get(target);
    if (destination === undefined) return whole;
    let relative = webPath(path.relative(path.dirname(mainFile), destination));
    if (!relative.startsWith(".")) relative = `./${relative}`;
    imports.push(`import ${JSON.stringify(relative)};`);
    return "";
  });

  const inlineModules: string[] = [];
  html = html.replace(inlineModulePattern, (whole, attributes: string, body: string) => {
    if (!/\btype\s*=\s*(["'])module\1/iu.test(attributes)) return whole;
    inlineModules.push(body.trim());
    return "";
  });
  html = rewriteLocalReferences(
    html, sourceIndex, wrapperIndex, known, destinations, sourceRoot, publicRoot,
  );
  const entry = '    <script type="module" src="/src/main.ts"></script>\n';
  html = /<\/body\s*>/iu.test(html)
    ? html.replace(/<\/body\s*>/iu, `${entry}  </body>`)
    : `${html.trimEnd()}\n${entry}`;

  const header = "// Generated by Vitality from the source page's local entries.\n";
  const inline = inlineModules.length > 0 ? `\n\n${inlineModules.join("\n\n")}\n` : "\n";
  return { html, main: `${header}${imports.join("\n")}${inline}` };
}

export function temporarySibling(source: string, output: string): string {
  const outputParent = path.dirname(output);
  const temporaryParent = containsPath(source, outputParent) ? path.dirname(source) : outputParent;
  return path.join(
    temporaryParent,
    `.${path.basename(output)}.vitality-${process.pid}-${randomUUID()}`,
  );
}

export async function copyProject(
  sourceRoot: string,
  sourceIndex: string,
  output: string,
  temporary: string,
): Promise<CopySummary> {
  const found = await inventory(sourceRoot, output, temporary);
  const known = new Set(found.files);
  const reachable = await discoverReachable(found.files, sourceIndex, sourceRoot);
  const modules = await discoverModules(found.files, reachable, sourceRoot);
  const appRoot = path.join(temporary, "src", "app");
  const publicRoot = path.join(temporary, "public");
  const publicJson = await discoverPublicJson(found.files, reachable, sourceRoot);
  const classicScripts = await discoverClassicScripts(found.files, reachable, sourceRoot);
  const publicFiles = new Set([...publicJson, ...classicScripts]);
  for (const file of found.files) {
    if (path.dirname(file) === sourceRoot && deploymentPublicNames.has(path.basename(file))) {
      publicFiles.add(file);
    }
  }
  const destinations = new Map<string, string>();
  for (const file of found.files) {
    if (/\.html?$/iu.test(file) && !reachable.has(file) && !publicFiles.has(file)) continue;
    if (file !== sourceIndex) {
      destinations.set(
        file,
        destinationFor(sourceRoot, file, temporary, appRoot, modules, reachable, publicFiles),
      );
    }
  }

  await mkdir(appRoot, { recursive: true });
  let copiedFiles = 0;
  let copiedBytes = 0;
  for (const file of found.files) {
    if (file === sourceIndex) continue;
    const destination = destinations.get(file);
    if (destination === undefined) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    if (publicFiles.has(file)) {
      await writeFile(destination, await readFile(file));
    } else if (isTextFile(file)) {
      const sourceText = await readFile(file, "utf8");
      const rewritten = rewriteLocalReferences(
        sourceText, file, destination, known, destinations, sourceRoot, publicRoot,
      );
      await writeFile(destination, rewritten, "utf8");
    } else {
      await writeFile(destination, await readFile(file));
    }
    copiedFiles += 1;
    copiedBytes += (await stat(file)).size;
  }

  const wrapperIndex = path.join(temporary, "index.html");
  const entry = rootEntry(
    sourceIndex,
    sourceRoot,
    wrapperIndex,
    await readFile(sourceIndex, "utf8"),
    known,
    destinations,
    publicRoot,
  );
  await Promise.all([
    writeFile(wrapperIndex, entry.html, "utf8"),
    writeFile(path.join(temporary, "src", "main.ts"), entry.main, "utf8"),
  ]);
  copiedFiles += 1;
  copiedBytes += (await stat(sourceIndex)).size;

  return {
    copiedFiles,
    copiedBytes,
    excludedEntries: found.excludedEntries,
    skippedLinks: found.skippedLinks,
    pages: [...destinations.entries()]
      .filter(([sourceFile, destination]) => (
        /\.html?$/iu.test(sourceFile) && !containsPath(publicRoot, destination)
      ))
      .map(([, destination]) => webPath(path.relative(temporary, destination)))
      .sort((left, right) => left.localeCompare(right)),
  };
}

export async function publishTemporary(temporary: string, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await rename(temporary, output);
}

export async function removeTemporary(temporary: string, output: string): Promise<void> {
  const expectedPrefix = `.${path.basename(output)}.vitality-`;
  if (temporary === path.parse(temporary).root || !path.basename(temporary).startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove an unrecognized temporary path: ${temporary}`);
  }
  try {
    const metadata = await lstat(temporary);
    if (metadata.isDirectory()) await rm(temporary, { recursive: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
