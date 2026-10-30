import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript-parser";

const web = (value: string) => value.split(path.sep).join("/");
const javascript = /\.(?:[cm]?[jt]sx?)$/i;
const browserModule = /\.(?:m?js)$/i;

interface RuntimeLayout {
  sourceNames?: ReadonlyMap<string, string>;
  files?: ReadonlyMap<string, string>;
  origins?: ReadonlyMap<string, string>;
  preserveCompilerURLs?: boolean;
}

function importSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
    || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node);
}

// Public runtime files keep their browser identities. Discover their local
// dependency closure instead of embedding them or copying the entire source tree.
export async function publicRuntime(
  inventory: string[], reachable: Set<string>, sourceRoot: string, base: string, initial: Set<string>,
  layout: RuntimeLayout = {},
): Promise<{ files: Set<string>; modules: string[]; rewrite: (code: string, file: string) => string; rewriteJSON: (code: string, file: string) => string }> {
  const origin = "https://vitality.invalid/";
  const root = new URL(base && base !== "./" ? base : "/", origin);
  const names = new Map(inventory.map(file => [layout.sourceNames?.get(file) ?? web(path.relative(sourceRoot, file)), file]));
  for (const [name, file] of layout.files ?? []) names.set(name, file);
  const namesByFile = new Map([...names].map(([name, file]) => [file, name]));
  const files = new Set(initial);
  const encode = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  const sourceURL = (file: string) => new URL(encode(layout.origins?.get(file) ?? namesByFile.get(file)!), root);
  const nameOf = (url: URL): string | undefined => {
    if (url.origin !== root.origin) return;
    try { return decodeURIComponent(url.pathname.startsWith(root.pathname)
      ? url.pathname.slice(root.pathname.length) : url.pathname.replace(/^\//, "")); }
    catch { return; }
  };
  const locate = (value: string, file: string): URL | undefined => {
    if (!value.trim() || value === "." || value === ".." || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) return;
    for (const from of [sourceURL(file), root]) {
      // This scanner visits data strings too, not just URL arguments. An
      // unparseable candidate is not a resource and must leave the source alone.
      let url: URL;
      try { url = new URL(value, from); } catch { continue; }
      const name = nameOf(url);
      if (name !== undefined && (names.has(name) || (name.endsWith("/") && [...names.keys()].some(item => item.startsWith(name))))) return url;
    }
  };
  const expressionURL = (node: ts.Node, file: string, source: ts.SourceFile): URL | undefined => {
    if (node.getText(source) === "import.meta.url") return sourceURL(file);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "href") return expressionURL(node.expression, file, source);
    if (ts.isNewExpression(node) && node.expression.getText(source) === "URL" && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const value = node.arguments[0].text;
      const from = node.arguments[1] ? expressionURL(node.arguments[1], file, source) : undefined;
      if (from) {
        try { return new URL(value, from); } catch { return; }
      }
      return locate(value, file);
    }
  };
  const pending = [...reachable];
  const inspected = new Map<string, boolean>();
  const add = (url: URL | undefined) => {
    if (!url) return;
    const name = nameOf(url);
    if (name === undefined || name === "") return;
    const targets = names.has(name) ? [names.get(name)!]
      : name.endsWith("/") ? [...names].filter(([item]) => item.startsWith(name)).map(([, file]) => file) : [];
    for (const file of targets) {
      reachable.add(file);
      if (!/\.html?$/i.test(file)) files.add(file);
      if (inspected.get(file) !== files.has(file)) pending.push(file);
    }
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (inspected.get(file) === files.has(file)) continue;
    inspected.set(file, files.has(file));
    if (javascript.test(file)) {
      const code = await readFile(file, "utf8");
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && node.expression.getText(source) === "URL") {
          // A nested URL is a base, not an instruction to publish its directory.
          if (!(ts.isNewExpression(node.parent) && node.parent.arguments?.[1] === node)) {
            const url = expressionURL(node, file, source);
            // In n/n Vite owns literal file URLs and worker bundles. Publishing
            // those too would restore the original + hashed duplicate defect.
            // Directory/computed/manifest URLs still need a public closure.
            const compilerFile = layout.preserveCompilerURLs && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])
              && node.arguments?.[1]?.getText(source) === "import.meta.url" && url && names.has(nameOf(url) ?? "");
            if (!compilerFile) add(url);
          }
        } else if (ts.isStringLiteralLike(node)) {
          if (!(ts.isNewExpression(node.parent) && node.parent.expression.getText(source) === "URL")
            && (files.has(file) || !importSpecifier(node))) add(locate(node.text, file));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    } else if (/\.html?$/i.test(file)) {
      const html = await readFile(file, "utf8");
      for (const match of html.matchAll(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi)) {
        if (!/\btype\s*=\s*(["'])module\1/i.test(match[1]! + match[4]!)) add(locate(match[3]!, file));
      }
    } else if (files.has(file) && /\.json$/i.test(file)) {
      let value: unknown;
      try { value = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
      const visit = (item: unknown) => {
        if (typeof item === "string") add(locate(item, file));
        else if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === "object") Object.values(item).forEach(visit);
      };
      visit(value);
    } else if (files.has(file) && /\.css$/i.test(file)) {
      const code = await readFile(file, "utf8");
      for (const match of code.matchAll(/(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1|url\(\s*([^"')\s]+)\s*\)/g)) add(locate(match[2] ?? match[3]!, file));
    }
  }
  const target = (url: URL | undefined): string | undefined => {
    if (!url) return;
    const name = nameOf(url);
    if (name === undefined) return;
    if (files.has(names.get(name)!)) return encode(name) + url.search + url.hash;
    if (name.endsWith("/") && [...files].some(file => namesByFile.get(file)?.startsWith(name))) return encode(name) + url.search + url.hash;
  };
  return {
    files,
    modules: [...files].filter(file => browserModule.test(file)).map(file => namesByFile.get(file)!),
    rewriteJSON(code, file) {
      // JSON URL references remain relative to the fetched manifest, including
      // when the original manifest used a root-relative deployment path.
      return code.replace(/"(?:\\.|[^"\\])*"(?=\s*[,}\]])/g, whole => {
        let value: string;
        try { value = JSON.parse(whole); } catch { return whole; }
        if (!value.startsWith("/") || value.startsWith("//")) return whole;
        const name = target(locate(value, file));
        if (name === undefined) return whole;
        if (base && base !== "./") return JSON.stringify(new URL(name, root).href.replace(origin.slice(0, -1), ""));
        const relative = path.posix.relative(path.posix.dirname(encode(namesByFile.get(file)!)), name.split(/[?#]/)[0]!);
        return JSON.stringify((relative.startsWith(".") ? relative : "./" + relative) + name.slice(name.search(/[?#]/) < 0 ? name.length : name.search(/[?#]/)));
      });
    },
    rewrite(code, file) {
      if (!javascript.test(file)) return code;
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
      const edits: { start: number; end: number; text: string }[] = [];
      const runtimeURL = (name: string) => !base || base === "./"
        ? `new URL(${JSON.stringify(name)}, import.meta.env.DEV ? new URL("/", globalThis.location.href) : new URL(/* @vite-ignore */ "../", import.meta.url))`
        : `new URL(import.meta.env.BASE_URL + ${JSON.stringify(name)}, globalThis.location.href)`;
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && node.expression.getText(source) === "URL") {
          const name = target(expressionURL(node, file, source));
          if (name !== undefined) {
            edits.push({ start: node.getStart(source), end: node.end, text: runtimeURL(name) });
            return;
          }
        }
        if (ts.isStringLiteralLike(node)) {
          const parent = node.parent;
          if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return;
          const name = target(locate(node.text, file));
          if (name !== undefined) {
            const boundary = name.search(/[?#]/);
            const pathname = boundary < 0 ? name : name.slice(0, boundary);
            const relative = path.posix.relative(path.posix.dirname("src/app/" + namesByFile.get(file)!), "public/" + pathname);
            const text = importSpecifier(node)
              ? JSON.stringify((relative.startsWith(".") ? relative : "./" + relative) + name.slice(pathname.length))
              : runtimeURL(name) + ".href";
            if (text !== undefined) edits.push({ start: node.getStart(source), end: node.end, text });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return code;
    },
  };
}
