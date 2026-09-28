import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import ts from "typescript-parser";
import type { Composition } from "./composition.js";
import { UsageError } from "./args.js";

const web = (file: string) => file.split(path.sep).join("/");
const moduleFile = /\.(?:[cm]?[jt]sx?)$/i;
const nonRuntime = /(?:^|\/)(?:LICENSE|LICENCE|NOTICE|README|CHANGELOG)(?:\.[^/]*)?$|\.map$/i;
async function inventory(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, file.name);
      if (file.isDirectory()) await walk(full);
      else if (file.isFile()) result.push(web(path.relative(root, full)));
    }
  }
  try { await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result.sort();
}

export async function embedPublicFiles(root: string, base: string, pages: string[], sourceRoot: string, plan?: Composition): Promise<void> {
  if (pages.length) throw new UsageError("--no-public currently requires a single-page entry; use normal mode for routable HTML pages");
  const publicFiles = await inventory(path.join(root, "public"));
  const modules = new Map<string, string>();
  const dynamicModules = new Set<string>();
  const assets: Record<string, string> = {};
  const originalNames = new Map<string, string>();
  const files = new Map<string, string>();
  for (const name of publicFiles) {
    const dest = "src/embedded/" + name;
    files.set(name, dest);
    if (nonRuntime.test(name)) continue;
    if (moduleFile.test(name)) { modules.set(name, dest); originalNames.set(dest, name); dynamicModules.add(name); }
    else assets[name] = dest;
  }
  if (publicFiles.length) await rename(path.join(root, "public"), path.join(root, "src/embedded"));
  const appFiles = await inventory(path.join(root, "src/app"));
  for (const file of appFiles) {
    const dest = "src/app/" + file;
    files.set(file, dest);
    // HTML has already been rebased to src/app by the ordinary copier.
    files.set(dest, dest);
    if (nonRuntime.test(file)) continue;
    if (moduleFile.test(file)) {
      modules.set(file, dest);
      const jsName = file.replace(/\.mts$/, ".mjs").replace(/\.tsx$/, ".jsx").replace(/\.ts$/, ".js");
      if (!modules.has(jsName)) modules.set(jsName, dest);
    } else {
      assets[file] = dest;
      assets[dest] = dest;
    }
  }
  for (const [name, item] of plan?.files ?? []) if ("module" in item) {
    const source = web(path.relative(sourceRoot, item.module)).replace(/\.js$/i, ".ts").replace(/\.mjs$/i, ".mts").replace(/\.jsx$/i, ".tsx");
    if (!appFiles.includes(source)) throw new UsageError("Cannot map source module for no-public output: " + name);
    modules.set(name, "src/app/" + source);
    dynamicModules.add(name);
    originalNames.set("src/app/" + source, name);
  }
  const resolve = (value: string, from = "index.html") => {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#|data:)/i.test(value)) return undefined;
    value = value.replace(/^%BASE_URL%/, base);
    const clean = value.split(/[?#]/)[0] ?? "";
    const rootName = base && clean.startsWith(base) ? clean.slice(base.length) : clean.replace(/^\//, "");
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    return [clean.startsWith("/") ? rootName : relative, rootName].find(name => files.has(name) || modules.has(name));
  };
  const scriptHashes: string[] = [];
  let html = await readFile(path.join(root, "index.html"), "utf8");
  html = await replaceAsync(html, /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi,
    async (whole, before: string, _quote: string, url: string, after: string) => {
      if (/\btype\s*=\s*(["'])module\1/i.test(before + after)) return whole;
      const name = resolve(url);
      if (!name || !files.has(name)) return whole;
      let script = await readFile(path.join(root, files.get(name)!), "utf8");
      script = script.replace(/\bdocument\.currentScript\b/g, `({src:new URL(${JSON.stringify(base + name)},location.href).href})`);
      if (/<\/script/i.test(script)) throw new UsageError("Classic script contains an HTML closing tag; cannot safely inline: " + name);
      modules.delete(name);
      originalNames.delete(files.get(name)!);
      scriptHashes.push("'sha256-" + createHash("sha256").update(script).digest("base64") + "'");
      return `<script${before}${after}>${script}</script>`;
    });
  html = html.replace(/<link\b[^>]*\brel\s*=\s*(["'])modulepreload\1[^>]*>/gi, "");
  html = html.replace(/\b(src|href|poster)\s*=\s*(["'])([^"']+)\2/gi, (whole, attribute: string, quote: string, value: string) => {
    const name = resolve(value);
    return name && Object.hasOwn(assets, name) ? `${attribute}=${quote}%VITALITY_ASSET:${Buffer.from(name).toString("base64url")}%${quote}` : whole;
  });
  html = html.replace(/(<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=)(["'])(.*?)\2/gi,
    (_whole, prefix: string, quote: string, policy: string) => {
      const directives = new Map(policy.split(";").map(part => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name!, values]));
      for (const [name, values] of [["script-src", scriptHashes], ["style-src", ["data:"]], ["img-src", ["data:"]], ["font-src", ["data:"]], ["connect-src", ["data:"]]] as const) {
        const existing = directives.get(name) ?? directives.get("default-src") ?? ["'self'"];
        directives.set(name, [...new Set([...existing.filter(v => v !== "'none'"), ...values])]);
      }
      return prefix + quote + [...directives].map(([name, values]) => [name, ...values].join(" ")).join("; ") + quote;
    });
  await writeFile(path.join(root, "index.html"), html);

  // Convert only known local URLs. API routes and unrecognized external URLs stay intact.
  const codeFiles = (await inventory(path.join(root, "src"))).map(name => "src/" + name).filter(name => moduleFile.test(name) && !nonRuntime.test(name));
  const scriptURLs: Record<string, string> = {};
  const classicScripts: Record<string, string> = {};
  const transformed = new Map<string, string>();
  for (const file of codeFiles) {
    if (file.startsWith("src/embedded/") && !originalNames.has(file)) continue; // inlined classic script
    let code = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const origin = originalNames.get(file) ?? file.replace(/^src\/app\//, "");
    if (!ts.isExternalModule(source) && /\.js$/i.test(file)) classicScripts[origin] = file;
    const sourceURL = `new URL(${JSON.stringify(origin)}, globalThis.__vitalityEmbedded.root).href`;
    const edits: { start: number; end: number; text: string }[] = [];
    const edit = (node: ts.Node, text: string) => edits.push({ start: node.getStart(source), end: node.end, text });
    const relativeModule = (name: string) => {
      const target = modules.get(name)!;
      const rel = path.posix.relative(path.posix.dirname(file), target);
      return rel.startsWith(".") ? rel : "./" + rel;
    };
    function visit(node: ts.Node): void {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        && node.left.getText(source) === "import.meta.env.BASE_URL" && ts.isStringLiteralLike(node.right)) {
        const name = resolve(node.right.text, origin);
        if (name && Object.hasOwn(assets, name)) {
          if (!/\.json$/i.test(name)) edit(node, `globalThis.__vitalityEmbedded.asset(${JSON.stringify(name)})`);
          return; // Existing base-prefixed JSON fetches must not get a second prefix.
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["URL", "Worker", "SharedWorker"].includes(node.expression.text)) {
        const arg = node.arguments?.[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const name = resolve(arg.text, origin);
          if (name && modules.has(name)) {
            scriptURLs[name] = modules.get(name)!;
            if (node.expression.text === "URL") {
              edit(node, `new URL(globalThis.__vitalityEmbedded.script(${JSON.stringify(name)}))`);
              return;
            }
            edit(arg, `globalThis.__vitalityEmbedded.script(${JSON.stringify(name)})`);
            for (const other of node.arguments?.slice(1) ?? []) visit(other);
            return;
          }
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (!arg) return;
        if (ts.isStringLiteralLike(arg)) {
          const name = resolve(arg.text, origin);
          if (name && modules.has(name)) edit(arg, JSON.stringify(relativeModule(name)));
          // Ordinary source imports remain ordinary imports for Vite to resolve.
          return;
        }
        edit(node, `globalThis.__vitalityEmbedded.import(${arg.getText(source)}, ${sourceURL}${node.arguments[1] ? ", " + node.arguments[1].getText(source) : ""})`);
        return;
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const name = resolve(node.moduleSpecifier.text, origin);
        if (name && modules.has(name)) edit(node.moduleSpecifier, JSON.stringify(relativeModule(name)));
        return;
      }
      if (ts.isPropertyAccessExpression(node) && node.getText(source) === "import.meta.url") {
        edit(node, sourceURL); return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "__vite__mapDeps") {
        // Vite will bundle the JS graph; only the original lazy CSS preloads remain useful.
        edits.push({ start: node.end, end: node.end, text: '.filter(value => value.endsWith(".css"))' });
      }
      if (ts.isStringLiteralLike(node)) {
        const parent = node.parent;
        if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return;
        const name = resolve(node.text, origin);
        if (name && Object.hasOwn(assets, name)) edit(node, /\.json$/i.test(name)
          ? `new URL(import.meta.env.BASE_URL + ${JSON.stringify(name)}, globalThis.location.href).href`
          : `globalThis.__vitalityEmbedded.asset(${JSON.stringify(name)})`);
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const item of edits.sort((a, b) => b.start - a.start || b.end - a.end)) code = code.slice(0, item.start) + item.text + code.slice(item.end);
    code = code.replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, "");
    transformed.set(file, code);
  }
  for (const [file, code] of transformed) await writeFile(path.join(root, file), code);
  await writeFile(path.join(root, "src/embedded-files.json"), JSON.stringify(assets, null, 2) + "\n");
  await writeFile(path.join(root, "src/embedded-scripts.json"), JSON.stringify(scriptURLs, null, 2) + "\n");
  await writeFile(path.join(root, "src/embedded-classic.json"), JSON.stringify(classicScripts, null, 2) + "\n");
  const loaders = [...modules].filter(([name]) => dynamicModules.has(name) && !Object.hasOwn(scriptURLs, name)).map(([name, file]) => `${JSON.stringify(name)}: () => import(${JSON.stringify("./" + path.posix.relative("src", file))})`).join(",\n");
  await writeFile(path.join(root, "src/inline-runtime.ts"), runtimeSource(loaders));
  const main = path.join(root, "src/main.ts");
  await writeFile(main, 'import "./inline-runtime";\n' + await readFile(main, "utf8"));
  const plugin = (await readFile(new URL("./embedded-assets-plugin.js", import.meta.url), "utf8")).replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, "");
  await writeFile(path.join(root, "inline-assets.ts"), plugin);
  await writeFile(path.join(root, "vite.config.ts"), `import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { embeddedAssets } from "./inline-assets.ts";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root, base: ${JSON.stringify(base)}, publicDir: false,
  plugins: [embeddedAssets(root)],
  build: {
    outDir: "dist", emptyOutDir: true, target: "esnext", cssCodeSplit: false,
    assetsInlineLimit: Number.POSITIVE_INFINITY, modulePreload: false,
    rolldownOptions: { output: { codeSplitting: false, entryFileNames: "assets/index.js",
      assetFileNames: asset => asset.names.some(name => name.endsWith(".css")) ? "assets/index.css" : "assets/[name][extname]" } },
  },
});
`);
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.vitality.noPublic = true;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(path.join(root, "README.md"), `# Vitified project

This unbuilt Vite wrapper uses no-public mode. Run \`bun install\`, then
\`bun run serve\` or \`bun run build\` yourself. The source project is untouched.

Runtime modules live in \`src/embedded\` and \`src/app\`. URL-addressed assets
are embedded as data URLs by \`inline-assets.ts\`. A small in-page adapter
resolves bundled module imports and local asset fetches; no server or service
worker is required. Unknown URLs retain their original behavior.

Production output is \`index.html\`, \`assets/index.js\`, and optional
\`assets/index.css\`. The build fails rather than silently emitting other files.
Source notices and source maps are kept in the wrapper, not deployed as assets.
The base \`${base}\` applies to any host serving that path; no domain is required.
`);
}

async function replaceAsync(text: string, regex: RegExp, replace: (...args: any[]) => Promise<string>): Promise<string> {
  const matches = [...text.matchAll(regex)];
  for (const match of matches.reverse()) text = text.slice(0, match.index) + await replace(...match) + text.slice(match.index! + match[0].length);
  return text;
}

function runtimeSource(loaders: string): string {
  return `import assets, { scripts } from "virtual:vitality-assets";
const root = new URL(import.meta.env.BASE_URL, location.href);
const modules: Record<string, () => Promise<unknown>> = {${loaders}};
function installEmbedded(assets, scripts, rootHref, modules = {}) {
const root = new URL(rootHref);
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function key(value: string | URL, from = root.href) {
  const url = new URL(String(value), from);
  if (url.origin !== root.origin) return undefined;
  return decodeURIComponent(url.pathname.startsWith(root.pathname) ? url.pathname.slice(root.pathname.length) : url.pathname.replace(/^\\//, ""));
}
const realFetch = globalThis.fetch.bind(globalThis);
const scriptURLs = new Map<string, string>();
globalThis.__vitalityEmbedded = {
  root: root.href,
  asset(name: string) { if (!own(assets, name)) throw new Error("Unknown embedded asset: " + name); return assets[name]; },
  script(name: string) {
    if (!own(scripts, name)) throw new Error("Unknown embedded script: " + name);
    if (!scriptURLs.has(name)) {
      const setup = "if(!globalThis.__vitalityEmbedded)(" + installEmbedded.toString() + ")(" + JSON.stringify(assets) + "," + JSON.stringify(scripts) + "," + JSON.stringify(root.href) + ");\\n";
      scriptURLs.set(name, URL.createObjectURL(new Blob([setup, Uint8Array.from(atob(scripts[name]), c => c.charCodeAt(0))], {type: "text/javascript"})));
    }
    return scriptURLs.get(name)!;
  },
  import(value: string | URL, from: string, options?: object) {
    const name = key(value, from);
    return name && own(modules, name) ? modules[name]() : import(/* @vite-ignore */ new URL(String(value), from).href, options);
  },
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
  const name = key(request.url);
  if (name && own(assets, name) && (request.method === "GET" || request.method === "HEAD")) {
    const response = await realFetch(assets[name], { signal: request.signal });
    const result = request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
    Object.defineProperty(result, "url", { value: request.url });
    return result;
  }
  return realFetch(input, init);
};
if (typeof globalThis.importScripts === "function") {
  const original = globalThis.importScripts.bind(globalThis);
  globalThis.importScripts = (...urls) => original(...urls.map(value => {
    const name = key(value);
    return name && own(scripts, name) ? globalThis.__vitalityEmbedded.script(name) : value;
  }));
}
if (typeof XMLHttpRequest !== "undefined") {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const name = key(url);
    return open.call(this, method, name && own(assets, name) ? assets[name] : url, ...args);
  };
}
}
installEmbedded(assets, scripts, root.href, modules);
`;
}
