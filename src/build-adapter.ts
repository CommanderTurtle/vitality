import path from "node:path";
import { readFile, readdir, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { Plugin } from "vite";

export const projectBuildEntry = "\0vitality-project";

function rebaseOutput(text: string, fileName: string, base: string, files: Map<string, Buffer>): string {
  if (!base || base === "./") return text;
  const local = (target: string): boolean => {
    try { return files.has(decodeURIComponent(target)); } catch { return false; }
  };
  // Change only literal URLs naming emitted files; leave APIs and remote URLs alone.
  let result = text.replace(/(["'])\/(?!\/)([^"'\s?#]+)([?#][^"'\s]*)?\1/g,
    (whole, quote: string, target: string, suffix = "") =>
      local(target) ? quote + base + target + suffix + quote : whole);
  if (/\.css$/i.test(fileName)) {
    result = result.replace(/(url\(\s*)\/(?!\/)([^)\s?#]+)([?#][^)\s]*)?(\s*\))/gi,
      (whole, prefix: string, target: string, suffix = "", end: string) =>
        local(target) ? prefix + base + target + suffix + end : whole);
  }
  if (/\.html?$/i.test(fileName)) {
    // Keep each page's relative URLs anchored at its own output directory.
    const directory = path.posix.dirname(fileName);
    const documentBase = base + (directory === "." ? "" : directory + "/");
    const tag = '<base href="' + documentBase.replaceAll("&", "&amp;").replaceAll('"', "&quot;") + '">';
    if (/<base\b[^>]*>/i.test(result)) {
      result = result.replace(/(<base\b[^>]*\bhref\s*=\s*["'])\/(?!\/)/i, (_match, prefix: string) => prefix + base);
    } else {
      result = result.replace(/<head\b[^>]*>/i, (match) => match + tag);
    }
  }
  return result;
}

export function projectBuildPlugin(options: { root: string; script: string; outDir: string; base: string }): Plugin {
  return {
    name: "vitality-project-build",
    apply: "build",
    resolveId(id) { if (id === projectBuildEntry) return id; },
    load(id) { if (id === projectBuildEntry) return "export {};"; },
    async buildStart() {
      // No source command runs during give or package installation.
      const result = spawnSync("bun", ["run", options.script], {
        cwd: options.root, stdio: "inherit",
        env: { ...process.env, VITALITY_BASE: options.base, BASE_PATH: options.base },
      });
      if (result.error || result.status !== 0) {
        throw result.error ?? new Error("Source build failed with exit code " + result.status);
      }
      const output = path.resolve(options.root, options.outDir);
      try {
        const metadata = await lstat(output);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid output directory");
        await readFile(path.join(output, "index.html"));
      }
      catch {
        throw new Error("Source build did not produce a regular directory with " + options.outDir
          + "/index.html. Regenerate with --build-output DIR if the builder uses another directory.");
      }
      const files = new Map<string, Buffer>();
      const collect = async (directory: string): Promise<void> => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink() || item.name.startsWith(".env") || [".git", "node_modules"].includes(item.name)) continue;
          const file = path.join(directory, item.name);
          if (item.isDirectory()) await collect(file);
          else if (item.isFile()) files.set(path.relative(output, file).split(path.sep).join("/"), await readFile(file));
        }
      };
      await collect(output);
      for (const [fileName, bytes] of files) {
        const source = /\.(?:html?|[cm]?js|css|json)$/i.test(fileName)
          ? rebaseOutput(bytes.toString("utf8"), fileName, options.base, files) : bytes;
        // Native modules may be imported by computed URLs, extensions or workers.
        // Preserve that output graph rather than renaming its files a second time.
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && chunk.facadeModuleId === projectBuildEntry) delete bundle[name];
      }
    },
  };
}
