import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { build, type Plugin } from "vite";
import { binaryAssetGlobs, binaryAsset, binaryFile, engineAsset, engineFileName } from "./asset-policy.js";

// Copied into opt-in wrappers. This runs during the user's Vite command, never give.
export interface EmbeddedPage {
  name: string;
  entry: string;
  assets: string[];
  scripts: string[];
}

export function normalizeInlineScript(source: string): string {
  // HTML parsing normalizes newlines. Downstream HTML serializers may also
  // trim a text node's end: emit that canonical form before calculating CSP.
  return source.replace(/<\/script/gi, "<\\/script").replace(/\r\n?/g, "\n").trimEnd();
}

export function embeddedAssets(root: string, pages: EmbeddedPage[] = [], selected?: Pick<EmbeddedPage, "assets" | "scripts">): Plugin {
  const select = (values: Record<string, string>, names?: string[]) => names ? Object.fromEntries(names.filter(name => Object.hasOwn(values, name)).map(name => [name, values[name]!])) : values;
  const allFiles: Record<string, string> = JSON.parse(readFileSync(path.join(root, "src/embedded-files.json"), "utf8"));
  const files = select(allFiles, selected?.assets);
  const scripts = select(JSON.parse(readFileSync(path.join(root, "src/embedded-scripts.json"), "utf8")), selected?.scripts);
  const classicPath = path.join(root, "src/embedded-classic.json");
  const classic = select(existsSync(classicPath) ? JSON.parse(readFileSync(classicPath, "utf8")) : {}, selected?.scripts);
  const types: Record<string, string> = {
    ".json": "application/json", ".webmanifest": "application/manifest+json", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".webm": "video/webm", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".ogg": "audio/ogg", ".txt": "text/plain", ".html": "text/html",
  };
  let base = "/";
  const cache = new Map<string, string>();
  const active = new Set<string>();
  const emitted = new Set<string>();
  let emit: (fileName: string, source: Buffer) => void;
  function engineURL(name: string, bytes: Buffer): string {
    const fileName = engineFileName(name, bytes);
    if (!emitted.has(fileName)) { emit(fileName, bytes); emitted.add(fileName); }
    return base + fileName;
  }
  const builtURL = (filename: string, context: { hostType: string }) => context.hostType === "js" && engineAsset(filename)
    ? { runtime: `new URL(${JSON.stringify(filename)}, globalThis.__vitalityEmbedded.root).href` } : undefined;
  const binaryModule = (id: string, watch: (file: string) => void) => {
    const clean = binaryFile(id);
    if (!clean || !path.isAbsolute(clean) || /[?&](?:raw|init)(?:[=&]|$)/.test(id)) return;
    watch(clean);
    const url = engineURL(path.basename(clean), readFileSync(clean));
    return `export default new URL(${JSON.stringify(url)}, globalThis.__vitalityEmbedded.root).href;`;
  };
  function target(value: string, from: string): string | undefined {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) return;
    const clean = value.split(/[?#]/)[0] ?? "";
    const rootPath = clean.startsWith(base) ? clean.slice(base.length) : clean.replace(/^\//, "");
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    return [clean.startsWith("/") ? rootPath : relative, rootPath].find(name => Object.hasOwn(allFiles, name));
  }
  function encode(name: string): string {
    const old = cache.get(name);
    if (old) return old;
    const source = allFiles[name];
    if (!source) throw new Error("Missing embedded asset: " + name);
    if (active.has(name)) throw new Error("Cyclic embedded asset reference: " + name);
    const file = path.resolve(root, source);
    if (path.relative(root, file).split(path.sep).includes("..")) throw new Error("Asset escapes wrapper: " + source);
    active.add(name);
    let bytes = readFileSync(file);
    if (engineAsset(name)) {
      const url = engineURL(name, bytes);
      cache.set(name, url);
      active.delete(name);
      return url;
    }
    const ext = path.posix.extname(name).toLowerCase();
    const replace = (value: string) => {
      const found = target(value, name);
      return found ? encode(found) + (value.includes("#") ? "#" + value.split("#").slice(1).join("#") : "") : value;
    };
    if (ext === ".css") {
      const css = bytes.toString("utf8")
        .replace(/url\(\s*(["']?)([^()'"\s]+)\1\s*\)/g, (_all, _quote, value: string) => `url(${JSON.stringify(replace(value))})`)
        .replace(/(@import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, value: string) => prefix + JSON.stringify(replace(value)));
      bytes = Buffer.from(css);
    } else if (ext === ".json" || ext === ".webmanifest") {
      const data = JSON.parse(bytes.toString("utf8"));
      // Web manifests load outside fetch(), so their icon URLs must be embedded.
      // Ordinary JSON stays byte-for-byte intact: paths can be identifiers, and
      // local fetch responses retain their original URL for sibling resolution.
      if (data && Array.isArray(data.icons) && ("start_url" in data || ext === ".webmanifest")) {
        for (const icon of data.icons) if (typeof icon.src === "string") icon.src = replace(icon.src);
        for (const key of ["start_url", "scope"]) if (data[key] === "/") data[key] = base;
        bytes = Buffer.from(JSON.stringify(data));
      }
    }
    // The fragment preserves suffix tests used by prebuilt CSS preload helpers.
    const data = `data:${types[ext] ?? "application/octet-stream"};base64,${bytes.toString("base64")}${ext === ".css" ? "#" + encodeURIComponent(name) : ""}`;
    cache.set(name, data);
    active.delete(name);
    return data;
  }
  return {
    name: "vitality-embedded-assets",
    enforce: "pre",
    config() { return { assetsInclude: binaryAssetGlobs, experimental: { renderBuiltUrl: builtURL } }; },
    configResolved(config) { base = config.base; },
    buildStart() {
      cache.clear(); active.clear(); emitted.clear();
      emit = (fileName, source) => { this.emitFile({ type: "asset", fileName, source }); };
      for (const file of Object.values(files)) this.addWatchFile(path.resolve(root, file));
    },
    handleHotUpdate() { cache.clear(); active.clear(); },
    resolveId(id) { if (id === "virtual:vitality-assets") return "\0vitality-assets"; },
    async load(id) {
      // Imported binaries (including dependency/worker imports) need the same
      // file policy as manifest assets. Vite library builds otherwise force
      // these into data URLs even when assetsInlineLimit returns false.
      const binary = binaryModule(id, file => this.addWatchFile(file));
      if (binary) return binary;
      if (id !== "\0vitality-assets") return;
      const scriptData: Record<string, string> = {};
      for (const [name, file] of Object.entries(classic)) {
        this.addWatchFile(path.resolve(root, file));
        const bytes = readFileSync(path.resolve(root, file));
        scriptData[name] = engineAsset(name) ? "url:" + engineURL(name, bytes) : bytes.toString("base64");
      }
      for (const [name, file] of Object.entries(scripts)) {
        if (Object.hasOwn(scriptData, name)) continue;
        if (engineAsset(name)) { scriptData[name] = "url:" + engineURL(name, readFileSync(path.resolve(root, file))); continue; }
        this.addWatchFile(path.resolve(root, file));
        // URL-based workers/scripts need an independent bundle, embedded in the
        // main payload rather than emitted as a separate deployment file.
        const result = await build({ root, base, configFile: false, publicDir: false, logLevel: "error", assetsInclude: binaryAssetGlobs,
          plugins: [{ name: "vitality-script-binaries", enforce: "pre", load(id) { return binaryModule(id, file => this.addWatchFile(file)); } }],
          experimental: { renderBuiltUrl: builtURL },
          build: { write: false, target: "esnext", assetsInlineLimit: file => !engineAsset(file), modulePreload: false,
            rolldownOptions: { input: path.resolve(root, file), preserveEntrySignatures: "strict", output: { format: "es", codeSplitting: false,
              assetFileNames: asset => engineFileName(asset.names[0] ?? "binary", asset.source) } } } });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
        const chunks = outputs.filter(item => item.type === "chunk");
        if (chunks.length !== 1 || outputs.some(item => item.type === "asset" && !engineAsset(item.fileName))) {
          this.error("URL script needs additional output; cannot embed safely: " + name);
        }
        for (const item of outputs) if (item.type === "asset" && !emitted.has(item.fileName)) {
          this.emitFile({ type: "asset", fileName: item.fileName, source: item.source }); emitted.add(item.fileName);
        }
        scriptData[name] = Buffer.from(chunks[0]!.code).toString("base64");
      }
      // Original and copied paths can address the same binary; store its bytes once.
      const values = new Map<string, string>();
      const declarations: string[] = [];
      const entries = Object.keys(files).map(name => {
        const data = encode(name);
        let variable = values.get(data);
        if (!variable) {
          variable = "asset" + values.size;
          values.set(data, variable);
          declarations.push("const " + variable + " = " + JSON.stringify(data) + ";");
        }
        return JSON.stringify(name) + ":" + variable;
      });
      return "export const scripts = " + JSON.stringify(scriptData) + ";\n" + declarations.join("\n") + "\nexport default {" + entries.join(",") + "};";
    },
    transformIndexHtml: { order: "pre", handler(html) {
      return html.replace(/%VITALITY_ASSET:([^%]+)%/g, (_all, name: string) => encode(Buffer.from(name, "base64url").toString("utf8")));
    } },
    generateBundle: { order: "post", async handler(_options, bundle) {
      // Compiler-discovered sidecars use the same naming/byte policy as the
      // manifest; accept those too, without accepting arbitrary loose output.
      for (const item of Object.values(bundle)) if (item.type === "asset" && binaryAsset(item.fileName)
        && item.names.some(name => engineFileName(name, item.source) === item.fileName)) emitted.add(item.fileName);
      const unexpected = Object.keys(bundle).filter(name => {
        if (name.endsWith(".html") || emitted.has(name)) return false;
        return name !== "assets/index.js" && name !== "assets/index.css";
      });
      if (unexpected.length) this.error("No-public build emitted separate files: " + unexpected.join(", ") + ". Use an inline worker/asset import or disable --no-public.");
      // A helper document needs its own realm/CSP, not a second entry in the
      // main graph: multiple entries re-enable splitting of every lazy import.
      for (const page of pages) {
        const result = await build({ root, base, configFile: false, publicDir: false, logLevel: "error",
          plugins: [embeddedAssets(root, [], page)],
          build: { write: false, target: "esnext", assetsInlineLimit: Infinity, modulePreload: false, cssCodeSplit: false,
            lib: { entry: path.resolve(root, page.entry), formats: ["es"] },
            rolldownOptions: { output: { codeSplitting: false, entryFileNames: "assets/index.js",
              assetFileNames: asset => asset.names.some(name => name.endsWith(".css")) ? "assets/index.css" : "assets/[name][extname]" } } } });
        const output = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
        const chunks = output.filter(item => item.type === "chunk");
        if (chunks.length !== 1) this.error("Secondary page must have one independent script: " + page.name);
        // Escape HTML's raw-text end marker without changing JS string values.
        const code = normalizeInlineScript(chunks[0]!.code);
        const hash = "'sha256-" + createHash("sha256").update(code).digest("base64") + "'";
        let html = readFileSync(path.resolve(root, page.name), "utf8")
          .replace(/%VITALITY_ASSET:([^%]+)%/g, (_all, name: string) => encode(Buffer.from(name, "base64url").toString("utf8")))
          .replace(/<script\b[^>]*\bsrc=["']\/src\/page-entry\/[^"']+["'][^>]*>\s*<\/script\s*>/i,
            () => '<script type="module">' + code + '</script>')
          .replace(/(<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=)(["'])(.*?)\2/gi,
            (_all, prefix: string, quote: string, policy: string) => {
              if (/\bscript-src\s/.test(policy)) policy = policy.replace(/\bscript-src\s+([^;]*)/, (_all, values: string) => "script-src " + values.replace(/'none'\s*/g, "") + " " + hash);
              else policy += "; script-src " + hash;
              return prefix + quote + policy + quote;
            });
        for (const item of output) if (item.type === "asset") {
          if (item.fileName === "assets/index.css") {
            const css = Buffer.from(item.source).toString("base64");
            html = html.replace(/<\/head\s*>/i, () => '<link rel="stylesheet" href="data:text/css;base64,' + css + '"></head>');
          } else if (!bundle[item.fileName]) this.emitFile({ type: "asset", fileName: item.fileName, source: item.source });
        }
        this.emitFile({ type: "asset", fileName: page.name, source: html });
      }
    } },
  };
}
