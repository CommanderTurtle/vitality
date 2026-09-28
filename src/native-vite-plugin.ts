import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import ts from "typescript-parser";
import { glob } from "tinyglobby";
import type { Plugin, UserConfig } from "vite";

type CopyTarget = { src: string | string[]; dest: string; rename?: string | Function; transform?: Function | { encoding: BufferEncoding | "buffer"; handler: Function } };
type CopyOptions = { targets: CopyTarget[]; structured?: boolean };
const copies: CopyOptions[] = [];
// The copied config's normal targets/transforms become embedded resources, not loose files.
export function viteStaticCopy(options: CopyOptions): Plugin {
  copies.push(options);
  return { name: "vitality-static-copy" };
}

const mime: Record<string, string> = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain" };
const web = (value: string) => value.split(path.sep).join("/");
const ignored = /(?:^|\/)(?:licen[cs]e|notice|readme|changelog)(?:\.[^/]*)?$|\.map$/i;
const engineAsset = (name: string) => /(?:^|\/)wasm\/|\.wasm(?:\.js)?$|\.(?:data|sf2|gz|tar)$/i.test(web(name));

export function compactConfig(source: UserConfig, base: string): UserConfig {
  const root = path.resolve(source.root ?? process.cwd());
  const originalBase = source.base ?? "/";
  const publicDir = source.publicDir === false ? false : path.resolve(root, source.publicDir ?? "public");
  const assets: Record<string, string> = {};
  const emitted = new Map<string, Buffer>();
  function emitEngine(bytes: Buffer, name: string): string {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const suffix = name.endsWith(".wasm.js") ? ".wasm.js" : path.extname(name);
    const stem = path.basename(name, suffix).replace(/[^\w.-]/g, "-");
    const filename = `assets/${stem}-${hash}${suffix}`;
    emitted.set(filename, bytes);
    return base + filename;
  }
  const contentNames = new Map<string, string>();
  function register(data: string, requested?: string): string {
    const hash = createHash("sha256").update(data).digest("hex");
    const existing = contentNames.get(hash);
    const name = requested ?? existing ?? "__embedded/" + hash;
    assets[name] = existing ? assets[existing]! : data;
    if (!existing) contentNames.set(hash, name);
    return name;
  }
  let ready: Promise<void> | undefined;
  async function add(file: string, name: string, transform?: CopyTarget["transform"]) {
    name = web(name).replace(/^\.\//, "");
    if (name.startsWith("../") || path.isAbsolute(name)) throw new Error("Embedded destination escapes output: " + name);
    if (ignored.test(name)) return;
    const info = await stat(file);
    if (info.isDirectory()) {
      for (const entry of await readdir(file)) await add(path.join(file, entry), path.posix.join(name, entry), transform);
      return;
    }
    let bytes: Buffer = await readFile(file);
    if (transform) {
      const handler = typeof transform === "function" ? transform : transform.handler;
      const encoding = typeof transform === "function" ? "utf8" : transform.encoding;
      const changed = await handler(encoding === "buffer" ? bytes : bytes.toString(encoding), file);
      if (changed === null) return;
      bytes = Buffer.isBuffer(changed) ? changed : Buffer.from(changed);
    }
    if (engineAsset(name)) assets[name] = emitEngine(bytes, name);
    else register("data:" + (mime[path.extname(name)] ?? "application/octet-stream") + ";base64," + bytes.toString("base64"), name);
  }
  async function collect() {
    if (publicDir) {
      try { for (const entry of await readdir(publicDir)) await add(path.join(publicDir, entry), entry); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const options of copies) {
      if (options.structured) throw new Error("No-public does not yet support structured static-copy targets");
      for (const target of options.targets) {
        const matches = await glob(target.src, { cwd: root, onlyFiles: false, expandDirectories: false, absolute: true });
        if (!matches.length) throw new Error("Static-copy source is missing: " + target.src);
        for (const file of matches) {
          const ext = path.extname(file);
          const renamed = typeof target.rename === "function" ? await target.rename(path.basename(file, ext), ext.slice(1), file) : target.rename;
          if (renamed && typeof renamed !== "string") throw new Error("Unsupported static-copy rename");
          await add(file, path.posix.join(web(target.dest), renamed ?? path.basename(file)), target.transform);
        }
      }
    }
    // Preserve companion-file lookups made by copied Emscripten glue scripts.
    // Ambiguous basenames must not silently select the wrong engine.
    const aliases = new Map<string, string | null>();
    for (const [name, url] of Object.entries(assets)) if (engineAsset(name)) {
      const alias = "assets/" + path.posix.basename(name);
      aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== url ? null : url);
    }
    for (const [name, url] of aliases) if (url) assets[name] = url;
  }
  const ensure = () => ready ??= collect();
  const runtimeId = "virtual:vitality-native-runtime";
  const entryFiles = new Set<string>();
  const applyEdits = (code: string, edits: { start: number; end: number; text: string }[]) => {
    for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    return code;
  };
  function transforms(worker = false): Plugin {
    return {
      name: "vitality-native-transform", enforce: "pre",
      async transform(code, id) {
        if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id) || id.includes("vitality-inline")) return;
        const parsed = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, /\.tsx/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const edits: { start: number; end: number; text: string }[] = [];
        const imports: string[] = [];
        function visit(node: ts.Node) {
          if (ts.isStringLiteralLike(node) && /\?(?:worker|sharedworker)(?:&|$)/.test(node.text) && !/[?&]inline(?:&|$)/.test(node.text)) {
            edits.push({ start: node.getStart(parsed), end: node.end, text: JSON.stringify(node.text + "&inline") });
            return;
          }
          if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker") {
            const url = node.arguments?.[0];
            if (url && ts.isNewExpression(url) && url.expression.getText(parsed) === "URL" && url.arguments?.[1]?.getText(parsed) === "import.meta.url" && ts.isStringLiteralLike(url.arguments[0]!)) {
              const local = "__vitalityWorker" + imports.length;
              const specifier = url.arguments[0]!.text;
              // URL-relative basenames are not bare package imports.
              const relative = /^(?:\.|\/|[a-z][\w+.-]*:)/i.test(specifier) ? specifier : "./" + specifier;
              imports.push(`import ${local} from ${JSON.stringify(relative + (relative.includes("?") ? "&" : "?") + "worker&inline")};`);
              edits.push({ start: node.getStart(parsed), end: node.end, text: `new ${local}(${node.arguments?.[1]?.getText(parsed) ?? "{}"})` });
              return;
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(parsed);
        const entry = entryFiles.has(path.resolve(id.split("?")[0]!));
        if (!edits.length && !entry) return;
        return { code: (entry && !worker ? `import ${JSON.stringify(runtimeId)};\n` : "") + imports.join("\n") + "\n" + applyEdits(code, edits), map: null };
      },
      renderChunk: { order: "pre", handler(code, chunk) {
        const parsed = ts.createSourceFile(chunk.fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const edits: { start: number; end: number; text: string }[] = [];
        function visit(node: ts.Node) {
          if (ts.isStringLiteralLike(node) && node.text.length > 256 && /^data:[^,]+;base64,/.test(node.text)) {
            const name = register(node.text);
            // Vite can force worker assets inline; restore WASM as a hashed file.
            if (node.text.startsWith("data:application/wasm;base64,")) {
              assets[name] = emitEngine(Buffer.from(node.text.slice(node.text.indexOf(",") + 1), "base64"), "module.wasm");
            }
            edits.push({ start: node.getStart(parsed), end: node.end, text: `globalThis.__vitalityNative.asset(${JSON.stringify(name)})` });
            return;
          }
          if (worker && ts.isNewExpression(node) && node.expression.getText(parsed) === "URL" && node.arguments?.[1]?.getText(parsed) === "import.meta.url") {
            const arg = node.arguments[1];
            edits.push({ start: arg.getStart(parsed), end: arg.end, text: "globalThis.__vitalityNative.root" });
          }
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
            const arg = node.arguments[0];
            edits.push({ start: arg.getStart(parsed), end: arg.end, text: `globalThis.__vitalityNative.importURL(${arg.getText(parsed)}, import.meta.url)` });
            return;
          }
          ts.forEachChild(node, visit);
        }
        visit(parsed);
        return edits.length ? { code: applyEdits(code, edits), map: null } : null;
      } },
    };
  }
  const plugin: Plugin = {
    name: "vitality-native-assets", enforce: "pre",
    async buildStart() { await ensure(); },
    resolveId(id) { if (id === runtimeId || id === "/@vitality-runtime") return "\0" + runtimeId; },
    async load(id) {
      if (id !== "\0" + runtimeId) return;
      await ensure();
      // Keep large binaries out of Vite's JS parsers; splice them in after analysis.
      return `(${installNative.toString()})("__VITALITY_NATIVE_ASSETS__",new URL(${JSON.stringify(base)},location.href).href,${JSON.stringify(originalBase)});`;
    },
    transformIndexHtml: { order: "pre", async handler(html) {
      await ensure();
      for (const match of html.matchAll(/<script\b([^>]*?)src=["']([^"']+)["']([^>]*)>/gi)) {
        if (/\btype=["']module["']/.test(match[1]! + match[3]!)) entryFiles.add(path.resolve(root, match[2]!.replace(/^\//, "")));
      }
      return html.replace(/\b(src|href|poster)=(["'])([^"']+)\2/g, (whole, attr, quote, value: string) => {
        const name = value.startsWith(originalBase) ? value.slice(originalBase.length) : value.replace(/^\.?\//, "");
        return Object.hasOwn(assets, name) && !/\.[cm]?js$/.test(name) ? `${attr}=${quote}${assets[name]}${quote}` : whole;
      });
    } },
    augmentChunkHash() {
      const hash = createHash("sha256");
      for (const [name, data] of Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(data);
      return hash.digest("hex");
    },
    generateBundle: { order: "post", handler(_output, bundle) {
      for (const [fileName, source] of emitted) this.emitFile({ type: "asset", fileName, source });
      const extra = Object.keys(bundle).filter(name => !/^(?:index\.html|assets\/[^/]+-[\w-]+\.[\w.]+)$/.test(name));
      if (extra.length) this.error("No-public emitted unsupported extra files: " + extra.join(", "));
      const entries = Object.values(bundle).filter(item => item.type === "chunk" && item.isEntry);
      const entry = entries[0];
      const marker = /(["'`])__VITALITY_NATIVE_ASSETS__\1/;
      if (entries.length !== 1 || !entry || entry.type !== "chunk" || !marker.test(entry.code)) this.error("No-public requires one HTML module entry with an embedded runtime");
      const values = new Map<string, string>();
      const declarations: string[] = [];
      const fields = Object.entries(assets).map(([name, data]) => {
        if (!values.has(data)) {
          const symbol = "a" + values.size;
          values.set(data, symbol);
          declarations.push(`${symbol}=${JSON.stringify(data)}`);
        }
        return JSON.stringify(name) + ":" + values.get(data);
      });
      const payload = declarations.length ? `(()=>{const ${declarations.join(",")};return {${fields.join(",")}})()` : "{}";
      entry.code = entry.code.replace(marker, () => payload);
      this.info(`Mapped ${Object.keys(assets).length} resources; ${emitted.size} hashed engine assets; no public directory copied.`);
    } },
  };
  const workerPlugins = source.worker?.plugins;
  return {
    ...source, root, base, publicDir: false,
    plugins: [plugin, transforms(), ...(source.plugins ?? [])],
    worker: { ...source.worker, format: "es", plugins: () => [...(workerPlugins?.() ?? []), transforms(true)],
      rolldownOptions: { ...source.worker?.rolldownOptions, output: { codeSplitting: false } } },
    build: { ...source.build, outDir: "dist", emptyOutDir: true, target: "esnext", assetsInlineLimit: file => !engineAsset(file), cssCodeSplit: false, modulePreload: false,
      rolldownOptions: { ...source.build?.rolldownOptions, output: { codeSplitting: false, entryFileNames: "assets/index-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } } },
  };
}

// Self-contained so each inline worker can receive the same resource resolver.
function installNative(assets: Record<string, string>, rootHref: string, oldBase: string, scriptHref = rootHref) {
  const root = new URL(rootHref);
  const own = (name: string) => Object.prototype.hasOwnProperty.call(assets, name);
  function key(value: string | URL, from = scriptHref): string | undefined {
    // Bundled workers/modules have Blob URLs, which cannot resolve relative paths.
    let url: URL;
    try { url = new URL(String(value), /^(?:blob|data):/.test(from) ? scriptHref : from); }
    catch { return; }
    if (url.origin !== root.origin) return;
    for (const prefix of [root.pathname, new URL(oldBase, root).pathname, "/"]) {
      if (!url.pathname.startsWith(prefix)) continue;
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      if (own(name)) return name;
      const companion = name.replace(/-[a-f0-9]{16}(?=\.[\w.]+$)/, "");
      if (companion !== name && own(companion)) return companion;
    }
  }
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  const blobs = new Map<string, Blob>();
  const scripts = new Map<string, string>();
  let shared: Record<string, string> | undefined;
  function workerAssets() {
    if (shared) return shared;
    shared = {};
    const urls = new Map<string, string>();
    for (const [name, data] of Object.entries(assets)) {
      if (!data.startsWith("data:")) { shared[name] = new URL(data, root).href; continue; }
      if (!urls.has(data)) {
        const comma = data.indexOf(",");
        const bytes = Uint8Array.from(atob(data.slice(comma + 1)), c => c.charCodeAt(0));
        urls.set(data, create(new Blob([bytes], {type: data.slice(5, data.indexOf(";"))})));
      }
      shared[name] = urls.get(data)!;
    }
    return shared;
  }
  URL.createObjectURL = blob => { const url = create(blob); if (blob instanceof Blob) blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { blobs.delete(url); revoke(url); };
  function script(name: string) {
    if (!assets[name]!.startsWith("data:")) return new URL(assets[name]!, root).href;
    if (!scripts.has(name)) {
      const data = assets[name]!;
      scripts.set(name, create(new Blob([Uint8Array.from(atob(data.slice(data.indexOf(",") + 1)), c => c.charCodeAt(0))], {type: "text/javascript"})));
    }
    return scripts.get(name)!;
  }
  (globalThis as any).__vitalityNative = {
    root: root.href,
    asset(name: string) { if (!own(name)) throw new Error("Unknown embedded asset: " + name); return new URL(assets[name]!, root).href; },
    importURL(value: string | URL, from: string) { const name = key(value, from); return name ? script(name) : value; },
  };
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), scriptHref), init);
    const name = key(request.url);
    if (!name || !["GET", "HEAD"].includes(request.method)) return originalFetch(request);
    const response = await originalFetch(new URL(assets[name]!, root), { signal: request.signal });
    const result = request.method === "HEAD" ? new Response(null, {headers: response.headers}) : response;
    Object.defineProperty(result, "url", {value: request.url});
    return result;
  };
  if (typeof XMLHttpRequest !== "undefined") {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args: any[]) {
      const name = key(url);
      return (open as any).call(this, method, name ? new URL(assets[name]!, root).href : url, ...args);
    };
  }
  if (typeof (globalThis as any).importScripts === "function") {
    const original = (globalThis as any).importScripts.bind(globalThis);
    (globalThis as any).importScripts = (...urls: string[]) => original(...urls.map(url => { const name = key(url); return name ? script(name) : url; }));
  }
  if (typeof Worker !== "undefined") {
    const Original = Worker;
    globalThis.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        const name = key(url);
        const payload = name && assets[name]!.startsWith("data:") ? new Blob([Uint8Array.from(atob(assets[name]!.split(",")[1]!), c => c.charCodeAt(0))]) : blobs.get(String(url));
        if (payload || name) {
          const workerHref = name ? new URL(name, root).href : scriptHref;
          // Share browser-local resource URLs, not another base64 copy per worker.
          const prelude = "(" + installNative.toString() + ")(" + JSON.stringify(workerAssets()) + "," + JSON.stringify(rootHref) + "," + JSON.stringify(oldBase) + "," + JSON.stringify(workerHref) + ");\n";
          const body = payload ?? (options?.type === "module" ? "await import(" : "importScripts(") + JSON.stringify(script(name!)) + ");";
          const wrapped = create(new Blob([prelude, body], {type:"text/javascript"}));
          super(wrapped, options);
          // The browser takes ownership of the worker script at construction.
          setTimeout(() => revoke(wrapped), 0);
        } else super(url, options);
      }
    };
  }
  if (typeof HTMLScriptElement !== "undefined") {
    for (const proto of [HTMLScriptElement.prototype, HTMLImageElement.prototype]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
      if (descriptor?.set) Object.defineProperty(proto, "src", { ...descriptor, set(value) {
        const name = key(value);
        descriptor.set!.call(this, name ? /\.[cm]?js$/.test(name) ? script(name) : new URL(assets[name]!, root).href : value);
      } });
    }
  }
}
