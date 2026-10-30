import { mkdir, readdir, readFile, writeFile, stat, cp } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript-parser";
import { containsPath } from "./paths.js";
import type { GiveOptions, ScaffoldReport } from "./types.js";
import { writeWrapperPackage, updateGitignore } from "./package-file.js";

// Preserve an existing Vite project's sources and configuration. Never evaluate it here.
export async function copyNativeVite(options: GiveOptions, destination: string, configName: string): Promise<Omit<ScaffoldReport, "elapsedMilliseconds">> {
  const result = { copiedFiles: 0, copiedBytes: 0, excludedEntries: 0, skippedLinks: 0, pages: [] as string[] };
  const excluded = new Set([".git", "node_modules", "dist", "build", ".cache", ".vite", ".vitality", ".tmp", "coverage"]);
  const aliases = new Map([...options.libraryOutputs ?? []].map(([name, file]) => [path.resolve(options.siteRoot, name), file]));
  function bindLibraryReferences(file: string, code: string): string {
    if (!aliases.size) return code;
    const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
        const parent = node.parent;
        const module = ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
          || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node);
        const url = ts.isNewExpression(parent) && parent.expression.getText(parsed) === "URL"
          && parent.arguments?.[0] === node && parent.arguments[1]?.getText(parsed) === "import.meta.url";
        if (module || url) {
          const clean = node.text.split(/[?#]/)[0]!;
          const requested = path.resolve(path.dirname(file), clean);
          const alternatives = clean.endsWith(".js") ? [requested.slice(0, -3) + ".ts", requested.slice(0, -3) + ".tsx"]
            : clean.endsWith(".mjs") ? [requested.slice(0, -4) + ".mts"] : clean.endsWith(".cjs") ? [requested.slice(0, -4) + ".cts"] : [];
          const target = aliases.get(requested) ?? aliases.get(path.resolve(options.siteRoot, clean));
          if (target && ![requested, ...alternatives].some(item => existsSync(item))) {
            const relative = path.relative(path.dirname(file), target).split(path.sep).join("/");
            edits.push({ start: node.getStart(parsed), end: node.end,
              text: JSON.stringify((relative.startsWith(".") ? relative : "./" + relative) + node.text.slice(clean.length)) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    return code;
  }
  async function walk(dir: string, relative = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const source = path.join(dir, item.name);
      const name = path.join(relative, item.name);
      if (containsPath(options.output, source) || containsPath(destination, source)) continue;
      if (item.isSymbolicLink()) { result.skippedLinks++; continue; }
      if (item.isDirectory()) {
        let generated = false;
        try { generated = Boolean(JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).vitality); } catch { /* not a wrapper */ }
        if (excluded.has(item.name) || generated) { result.excludedEntries++; continue; }
        await walk(source, name);
      } else if (item.isFile() && !/^\.env(?:\.|$)/i.test(item.name)) {
        const output = path.join(destination, name);
        await mkdir(path.dirname(output), { recursive: true });
        if (aliases.size && /\.(?:[cm]?[jt]sx?)$/i.test(source)) await writeFile(output, bindLibraryReferences(source, await readFile(source, "utf8")));
        else await cp(source, output);
        result.copiedFiles++;
        result.copiedBytes += (await stat(source)).size;
      }
    }
  }
  await walk(options.source);
  const configFile = path.join(options.source, configName);
  const config = bindLibraryReferences(configFile, await readFile(configFile, "utf8"));
  const parsed = ts.createSourceFile(configName, config, ts.ScriptTarget.Latest, true);
  const edits: {start: number; end: number; text: string}[] = [];
  for (const node of parsed.statements) if (options.noPublic && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "vite-plugin-static-copy") {
    edits.push({ start: node.moduleSpecifier.getStart(parsed), end: node.moduleSpecifier.end, text: '"./vitality-inline.ts"' });
  }
  let copiedConfig = config;
  for (const edit of edits.reverse()) copiedConfig = copiedConfig.slice(0, edit.start) + edit.text + copiedConfig.slice(edit.end);
  const original = "vite.original" + path.extname(configName);
  await writeFile(path.join(destination, original), copiedConfig);
  // Overwrite the copied entry config with an adapter; sourceRoot remains untouched.
  await writeFile(path.join(destination, configName), options.noPublic ? `import sourceConfig from "./${original}";
import { compactConfig } from "./vitality-inline.ts";
export default async env => compactConfig(await (typeof sourceConfig === "function" ? sourceConfig(env) : sourceConfig), ${JSON.stringify(options.base)});
` : `import sourceConfig from "./${original}";
import { fileURLToPath } from "node:url";
export default async env => {
  const config = await (typeof sourceConfig === "function" ? sourceConfig(env) : sourceConfig);
  return { ...config, base: ${JSON.stringify(options.base)}, build: {
    ...config.build, outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true, assetsInlineLimit: Number.POSITIVE_INFINITY,
  } };
};
`);
  if (options.noPublic) {
    const helper = await readFile(new URL("./native-vite-plugin.js", import.meta.url), "utf8");
    await writeFile(path.join(destination, "vitality-inline.ts"), helper.replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, ""));
  }
  await writeWrapperPackage(options.source, destination, options.base, true, 0, options.sourceEntry);
  const pkgPath = path.join(destination, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const originalPackage = JSON.parse(await readFile(path.join(options.source, "package.json"), "utf8"));
  // Match the source's Vite major/plugins instead of downgrading its toolchain.
  pkg.devDependencies.vite = originalPackage.devDependencies?.vite ?? originalPackage.dependencies?.vite ?? pkg.devDependencies.vite;
  if (options.noPublic) {
    pkg.devDependencies["typescript-parser"] = "npm:typescript@5.9.3";
    pkg.devDependencies.tinyglobby = "^0.2.15";
  }
  pkg.vitality.noPublic = Boolean(options.noPublic);
  pkg.vitality.nativeVite = true;
  pkg.vitality.generatedConfig = configName;
  pkg.vitality.sourceRoot = ".";
  for (const name of Object.keys(pkg.scripts)) if (name.startsWith("source:")) delete pkg.scripts[name];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  await updateGitignore(destination);
  return result;
}
