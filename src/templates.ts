export function renderViteConfig(base: string, inlineAssets: boolean): string {
  return `import { realpathSync } from "node:fs";
import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  defineConfig,
  loadConfigFromFile,
  mergeConfig,
  type ConfigEnv,
  type UserConfig,
} from "vite";
import {
  discoverHtmlEntries,
  preserveRelationalRuntimeUrls,
  preserveStandaloneFiles,
} from "./.vitality/standalone.mts";

// Vite canonicalizes module IDs. Canonicalize the wrapper root too so Windows
// 8.3 aliases (for example TURTLE~1) cannot break containment checks.
const root = realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
const base = ${JSON.stringify(base)};
const inlineAssets = ${inlineAssets ? "true" : "false"};

async function firstOriginalConfig(): Promise<string | undefined> {
  for (const name of [
    "vite.config.js", "vite.config.mjs", "vite.config.cjs",
    "vite.config.ts", "vite.config.mts", "vite.config.cts",
  ]) {
    const candidate = path.join(root, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // This project did not have this optional configuration filename.
    }
  }
  return undefined;
}

async function loadOriginal(env: ConfigEnv): Promise<UserConfig> {
  const candidate = await firstOriginalConfig();
  if (!candidate) return {};
  const loaded = await loadConfigFromFile(env, candidate, root);
  return loaded?.config ?? {};
}

export default defineConfig(async (env) => {
  const original = await loadOriginal(env);
  const htmlEntries = await discoverHtmlEntries(root, path.join(root, "dist"));
  const generated: UserConfig = {
    root,
    base,
    plugins: [
      preserveRelationalRuntimeUrls({ root }),
      preserveStandaloneFiles({ root, output: path.join(root, "dist") }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      write: true,
      watch: null,
      ...(inlineAssets ? { assetsInlineLimit: Number.POSITIVE_INFINITY } : {}),
    },
  };

  const originalBuild = original.build;
  const originalInput = original.input
    ?? originalBuild?.rolldownOptions?.input
    ?? originalBuild?.rollupOptions?.input;
  if (originalInput === undefined && htmlEntries.length > 0) {
    generated.input = htmlEntries.length === 1 ? htmlEntries[0] : htmlEntries;
  }
  return mergeConfig(original, generated);
});
`;
}

export const standaloneHelper = `import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

interface PreserveOptions {
  root: string;
  output: string;
}

interface RootOptions {
  root: string;
}

const ignoredDirectories = new Set([
  ".git", ".hg", ".svn", ".github", ".vitality", ".cache", ".tmp", ".vite",
  "node_modules", "coverage", "dist", "build", "test", "tests", "__tests__", "public",
]);

const ignoredRootFiles = [
  /^package(?:-lock)?\\.json$/u,
  /^(?:bun\\.lockb?|pnpm-lock\\.yaml|yarn\\.lock)$/u,
  /^vitality\\.config\\.(?:ts|mts)$/u,
  /^vite\\.config\\.(?:js|mjs|cjs|ts|mts|cts)$/u,
  /^tsconfig(?:\\.[^.]+)?\\.json$/u,
  /^\\.(?:gitignore|gitattributes|npmrc)$/u,
  /^(?:README|LICENSE|LICENCE|CHANGELOG)(?:\\..*)?$/iu,
];

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep)
    && relative !== ".." && !path.isAbsolute(relative));
}

function webPath(value: string): string {
  return value.split(path.sep).join("/");
}

function collectPathLikeStrings(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (value.length <= 512
        && !/^(?:[a-z]+:|\\/|#)/iu.test(value)
        && /(?:^|\\/)[^/]+\\.(?:html?|json|qml)$/iu.test(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeStrings(item, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectPathLikeStrings(item, found);
  }
}

async function relationalJson(file: string, root: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return false;
  }
  const candidates = new Set<string>();
  collectPathLikeStrings(parsed, candidates);
  for (const candidate of candidates) {
    const clean = candidate.split(/[?#]/u, 1)[0];
    if (!clean) continue;
    const referenced = path.resolve(path.dirname(file), clean);
    if (!inside(root, referenced)) continue;
    try {
      await access(referenced);
      return true;
    } catch {
      // The string looked like a path but is not part of this standalone.
    }
  }
  return false;
}

export function preserveRelationalRuntimeUrls(options: RootOptions): Plugin {
  const manifestCache = new Map<string, Promise<boolean>>();
  const urlPattern = /new\\s+URL\\(\\s*(["'\x60])([^"'\x60]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)/gu;
  return {
    name: "vitality:preserve-relational-runtime-urls",
    apply: "build",
    enforce: "pre",
    async transform(code, identifier) {
      const file = identifier.split("?", 1)[0];
      if (!file || !/\\.[cm]?[jt]sx?$/iu.test(file) || !inside(options.root, file)) return null;
      const matches = [...code.matchAll(urlPattern)];
      if (matches.length === 0) return null;
      let cursor = 0;
      let changed = false;
      let transformed = "";
      for (const match of matches) {
        const full = match[0];
        const literal = match[2];
        const index = match.index;
        if (full === undefined || literal === undefined || index === undefined
            || /^(?:[a-z]+:|\\/|#)/iu.test(literal)) continue;
        const clean = literal.split(/[?#]/u, 1)[0];
        if (!clean) continue;
        const target = path.resolve(path.dirname(file), clean);
        if (!inside(options.root, target)) continue;
        const extension = path.extname(clean).toLowerCase();
        let preserve = extension === ".html" || extension === ".htm" || extension === ".qml";
        if (extension === ".json") {
          let pending = manifestCache.get(target);
          if (!pending) {
            pending = relationalJson(target, options.root);
            manifestCache.set(target, pending);
          }
          preserve = await pending;
        }
        if (!preserve) continue;
        const rootRelative = webPath(path.relative(options.root, target));
        transformed += code.slice(cursor, index);
        transformed += "new URL(import.meta.env.BASE_URL + " + JSON.stringify(rootRelative)
          + ", globalThis.document?.baseURI ?? globalThis.location.href)";
        cursor = index + full.length;
        changed = true;
      }
      if (!changed) return null;
      transformed += code.slice(cursor);
      return { code: transformed, map: null };
    },
  };
}

function ignored(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  if (relative === "") return false;
  const parts = relative.split(path.sep);
  if (parts.slice(0, -1).some((part) => ignoredDirectories.has(part))) return true;
  const name = parts.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".map")) return true;
  return parts.length === 1 && ignoredRootFiles.some((pattern) => pattern.test(name));
}

async function walkFiles(root: string, output: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (absolute === output || inside(output, absolute) || ignored(root, absolute)) continue;
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export async function discoverHtmlEntries(root: string, output: string): Promise<string[]> {
  return (await walkFiles(root, output))
    .filter((file) => file.toLowerCase().endsWith(".html"))
    .map((file) => webPath(path.relative(root, file)));
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export function preserveStandaloneFiles(options: PreserveOptions): Plugin {
  return {
    name: "vitality:preserve-standalone-files",
    apply: "build",
    enforce: "post",
    async closeBundle() {
      const files = await walkFiles(options.root, options.output);
      let cursor = 0;
      let copied = 0;
      let bytes = 0;
      const workers = Array.from({ length: Math.min(32, Math.max(1, files.length)) }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const source = files[index];
          if (!source) return;
          const relative = path.relative(options.root, source);
          const destination = path.join(options.output, relative);
          if (await exists(destination)) continue;
          await mkdir(path.dirname(destination), { recursive: true });
          try {
            await copyFile(source, destination, constants.COPYFILE_EXCL);
            copied += 1;
            bytes += (await stat(source)).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      });
      await Promise.all(workers);
      if (copied > 0) {
        const kibibytes = (bytes / 1024).toFixed(1);
        console.log("[vitality] preserved " + copied + " runtime file(s), " + kibibytes + " KiB");
      }
    },
  };
}
`;

export const generatedReadme = `# Generated by Vitality

This directory contains the TypeScript configuration that lets Vite build an
ordinary standalone webapp without changing the copied source.

- \`../vitality.config.mts\` owns the selected public base and inline policy.
- \`standalone.mts\` discovers additional HTML entries and preserves files that
  are loaded at runtime rather than through static imports.
- Existing \`vite.config.*\` files are loaded and merged before Vitality's
  deployment settings are applied.

Do not place secrets here. Source \`.env*\` files are never copied into \`dist/\`.
`;
