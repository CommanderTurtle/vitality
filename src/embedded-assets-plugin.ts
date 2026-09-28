import path from "node:path";
import { readFileSync } from "node:fs";
import { build, type Plugin } from "vite";

// Copied into opt-in wrappers. This runs during the user's Vite command, never give.
export function embeddedAssets(root: string): Plugin {
  const files: Record<string, string> = JSON.parse(readFileSync(path.join(root, "src/embedded-files.json"), "utf8"));
  const scripts: Record<string, string> = JSON.parse(readFileSync(path.join(root, "src/embedded-scripts.json"), "utf8"));
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
  function target(value: string, from: string): string | undefined {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) return;
    const clean = value.split(/[?#]/)[0] ?? "";
    const rootPath = clean.startsWith(base) ? clean.slice(base.length) : clean.replace(/^\//, "");
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    return [clean.startsWith("/") ? rootPath : relative, rootPath].find(name => Object.hasOwn(files, name));
  }
  function encode(name: string): string {
    const old = cache.get(name);
    if (old) return old;
    const source = files[name];
    if (!source) throw new Error("Missing embedded asset: " + name);
    if (active.has(name)) throw new Error("Cyclic embedded asset reference: " + name);
    const file = path.resolve(root, source);
    if (path.relative(root, file).split(path.sep).includes("..")) throw new Error("Asset escapes wrapper: " + source);
    active.add(name);
    let bytes = readFileSync(file);
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
    configResolved(config) { base = config.base; },
    buildStart() { cache.clear(); active.clear(); for (const file of Object.values(files)) this.addWatchFile(path.resolve(root, file)); },
    handleHotUpdate() { cache.clear(); active.clear(); },
    resolveId(id) { if (id === "virtual:vitality-assets") return "\0vitality-assets"; },
    async load(id) {
      if (id !== "\0vitality-assets") return;
      const scriptData: Record<string, string> = {};
      for (const [name, file] of Object.entries(scripts)) {
        this.addWatchFile(path.resolve(root, file));
        // URL-based workers/scripts need an independent bundle, embedded in the
        // main payload rather than emitted as a separate deployment file.
        const result = await build({ root, configFile: false, publicDir: false, logLevel: "error",
          build: { write: false, target: "esnext", assetsInlineLimit: Infinity, modulePreload: false,
            lib: { entry: path.resolve(root, file), formats: ["es"], fileName: "script" },
            rolldownOptions: { output: { codeSplitting: false } } } });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
        if (outputs.length !== 1 || outputs[0]?.type !== "chunk") {
          this.error("URL script needs additional output; cannot embed safely: " + name);
        }
        scriptData[name] = Buffer.from(outputs[0].code).toString("base64");
      }
      return "export const scripts = " + JSON.stringify(scriptData) + ";\nexport default " + JSON.stringify(Object.fromEntries(Object.keys(files).map(name => [name, encode(name)]))) + ";";
    },
    transformIndexHtml: { order: "pre", handler(html) {
      return html.replace(/%VITALITY_ASSET:([^%]+)%/g, (_all, name: string) => encode(Buffer.from(name, "base64url").toString("utf8")));
    } },
    generateBundle: { order: "post", handler(_options, bundle) {
      const unexpected = Object.keys(bundle).filter(name => !name.endsWith(".html") && name !== "assets/index.js" && name !== "assets/index.css");
      if (unexpected.length) this.error("No-public build emitted separate files: " + unexpected.join(", ") + ". Use an inline worker/asset import or disable --no-public.");
    } },
  };
}
