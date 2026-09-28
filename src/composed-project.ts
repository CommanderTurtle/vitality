import path from "node:path";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { Composition } from "./composition.js";
import type { CopySummary } from "./copy.js";
import { containsPath } from "./paths.js";
import { UsageError } from "./args.js";

const web = (file: string) => file.split(path.sep).join("/");
const quotes = /(["'])([^"'\r\n]+)\1/g;
const imports = /\b(?:import\s*(?:[^"'`]*?\sfrom\s*)?|export\s+[^"'`]*?\sfrom\s*|import\s*\()\s*(["'])([^"']+)\1/g;

export async function copyComposition(root: string, wrapper: string, plan: Composition, base: string, inline: boolean, noPublic = false): Promise<CopySummary & { config: string }> {
  const modules = new Map([...plan.files].flatMap(([name, item]) => "module" in item ? [[name, item.module] as const] : []));
  const sourceFiles = new Map<string, string>();
  const sourceText = new Map<string, string>();
  const external = new Set<string>();
  let copiedFiles = 0, copiedBytes = 0;
  const relativeBase = !base || base === "./";
  const publicUrl = (name: string) => (relativeBase ? "./" : base) + name;
  const write = async (name: string, content: string | Buffer) => {
    const target = path.join(wrapper, name);
    if (!containsPath(wrapper, target)) throw new UsageError("Source output escapes wrapper: " + name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    copiedFiles++; copiedBytes += Buffer.byteLength(content);
  };
  const resolveImport = async (file: string, value: string): Promise<string | undefined> => {
    if (!value.startsWith(".")) return undefined;
    const direct = path.resolve(path.dirname(file), value);
    if (!containsPath(root, direct)) return undefined;
    const candidates = [direct, direct + ".ts", direct + ".tsx", direct + ".js", path.join(direct, "index.ts")];
    if (direct.endsWith(".js")) candidates.push(direct.slice(0, -3) + ".ts");
    for (const item of candidates) {
      try { if ((await stat(item)).isFile()) return item; } catch { /* unresolved local reference */ }
    }
  };
  const visit = async (file: string): Promise<void> => {
    if (sourceFiles.has(file)) return;
    if (!containsPath(root, await realpath(file))) throw new UsageError("Module reference leaves the project: " + file);
    const relative = web(path.relative(root, file)).replace(/\.js$/i, ".ts").replace(/\.mjs$/i, ".mts").replace(/\.jsx$/i, ".tsx");
    sourceFiles.set(file, "src/app/" + relative);
    if (!/\.(?:[cm]?[jt]sx?|css|json)$/i.test(file)) return;
    const text = await readFile(file, "utf8");
    sourceText.set(file, text);
    for (const match of text.matchAll(imports)) {
      const found = await resolveImport(file, match[2]!);
      if (found) await visit(found);
    }
  };
  for (const file of modules.values()) await visit(file);
  for (const [file, destination] of sourceFiles) {
    let text = sourceText.get(file);
    if (text === undefined) { await write(destination, await readFile(file)); continue; }
    const replacements = new Map<string, string>();
    for (const match of text.matchAll(quotes)) {
      const found = await resolveImport(file, match[2]!);
      const target = found ? sourceFiles.get(found) : undefined;
      if (target) {
        const relative = path.posix.relative(path.posix.dirname(destination), target);
        replacements.set(match[2]!, relative.startsWith(".") ? relative : "./" + relative);
      }
    }
    const outputName = [...modules].find(([, source]) => source === file)?.[0];
    if (outputName) {
      // A classic bootstrap becomes an ordinary TS module, but its own URL still
      // means the source recipe's browser URL, not the eventual bundled chunk.
      text = text.replace(/\bdocument\.currentScript\b/g,
        `({ src: new URL(import.meta.env.BASE_URL + ${JSON.stringify(outputName)}, globalThis.location.href).href })`);
      for (const match of text.matchAll(imports)) {
        const value = match[2]!;
        if (!value.startsWith(".") || replacements.has(value)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(outputName), value));
        if (plan.files.has(target) && !modules.has(target)) { replacements.set(value, publicUrl(target)); external.add(publicUrl(target)); }
      }
    }
    text = text.replace(quotes, (whole, quote: string, value: string) => replacements.has(value) ? quote + replacements.get(value) + quote : whole);
    await write(destination, text);
  }
  const rebase = (text: string) => relativeBase ? text : text.replace(/(["'])\/(?!\/)([^"'\s?#]+)([?#][^"'\s]*)?\1/g,
    (whole, quote: string, target: string, suffix = "") => plan.files.has(target) ? quote + base + target + suffix + quote : whole);
  const readItem = async (name: string): Promise<string | Buffer> => {
    const item = plan.files.get(name)!;
    if ("module" in item) throw new UsageError("Unexpected compiled input: " + name);
    return "text" in item ? item.text : await readFile(item.file);
  };
  let html = String(await readItem("index.html"));
  const startup: string[] = [];
  const eagerModules = new Set<string>();
  html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi,
    (whole, before: string, _quote: string, url: string, after: string) => {
      const name = url.replace(/^\.\//, "").replace(/^\//, "");
      const source = modules.get(name);
      if (source) {
        const target = sourceFiles.get(source)!;
        startup.push(`await import(${JSON.stringify("./" + path.posix.relative("src", target))});`);
        eagerModules.add(name);
        return "";
      }
      if (plan.files.has(name) && /\btype\s*=\s*(["'])module\1/i.test(before + after)) {
        startup.push(`await import(/* @vite-ignore */ new URL(import.meta.env.BASE_URL + ${JSON.stringify(name)}, globalThis.location.href).href);`);
        return "";
      }
      return whole;
    });
  html = html.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (whole, attribute: string, quote: string, value: string) => {
    const name = value.replace(/^\.\//, "").replace(/^\//, "");
    return plan.files.has(name) ? attribute + "=" + quote + "%BASE_URL%" + name + quote : whole;
  });
  const mainTag = '<script type="module" src="/src/main.ts"></script>';
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, mainTag + '</body>') : html + mainTag;
  await write("index.html", html);
  await write("src/main.ts", "// Source bootstraps run before the native module graph.\n" + startup.join("\n") + "\nexport {};\n");
  for (const [name, item] of plan.files) {
    if (name === "index.html" || "module" in item) continue;
    const content = await readItem(name);
    await write("public/" + name, !noPublic && /\.(?:html?|[cm]?js|json|css)$/i.test(name) ? rebase(String(content)) : content);
  }
  const input: Record<string, string> = { index: "index.html" };
  const routes: Record<string, string> = {};
  for (const [name, file] of modules) if (!eagerModules.has(name)) {
    input[name.replace(/\.js$/i, "")] = sourceFiles.get(file)!;
    routes[name] = sourceFiles.get(file)!;
  }
  const config = `import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const input = ${JSON.stringify(input, null, 2)};
const routes: Record<string, string> = ${JSON.stringify(routes, null, 2)};
const base = ${JSON.stringify(base)};
export default defineConfig({
  root, base, publicDir: "public",
  plugins: [{ name: "source-module-routes", configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const prefix = base.startsWith("/") ? base : "/";
      const url = (req.url ?? "").split("?")[0] ?? "";
      const name = url.startsWith(prefix) ? url.slice(prefix.length) : url.replace(/^\\//, "");
      if (routes[name]) req.url = prefix + routes[name];
      next();
    });
  } }],
  build: {
    outDir: "dist", emptyOutDir: true, modulePreload: false,
    ${inline ? "assetsInlineLimit: Number.POSITIVE_INFINITY," : "// assetsInlineLimit: Vite default,"}
    rolldownOptions: {
      input: Object.fromEntries(Object.entries(input).map(([name, file]) => [name, path.resolve(root, file)])),
      external: ${JSON.stringify([...external])},
      preserveEntrySignatures: "strict",
      output: { entryFileNames: chunk => chunk.name === "index" ? "assets/index.js" : "[name].js" },
    },
  },
});
`;
  return { copiedFiles, copiedBytes, excludedEntries: 0, skippedLinks: 0, pages: [], config };
}
