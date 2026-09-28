import { mkdir, readdir, readFile, writeFile, stat, cp } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-parser";
import { containsPath } from "./paths.js";
import type { GiveOptions, ScaffoldReport } from "./types.js";
import { writeWrapperPackage, updateGitignore } from "./package-file.js";

// Preserve an existing Vite project's sources and configuration. Never evaluate it here.
export async function copyNativeVite(options: GiveOptions, destination: string, configName: string): Promise<Omit<ScaffoldReport, "elapsedMilliseconds">> {
  const result = { copiedFiles: 0, copiedBytes: 0, excludedEntries: 0, skippedLinks: 0, pages: [] as string[] };
  const excluded = new Set([".git", "node_modules", "dist", "build", ".cache", ".vite", ".tmp", "coverage"]);
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
        await cp(source, output);
        result.copiedFiles++;
        result.copiedBytes += (await stat(source)).size;
      }
    }
  }
  await walk(options.source);
  const config = await readFile(path.join(options.source, configName), "utf8");
  const parsed = ts.createSourceFile(configName, config, ts.ScriptTarget.Latest, true);
  const edits: {start: number; end: number; text: string}[] = [];
  for (const node of parsed.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "vite-plugin-static-copy") {
    edits.push({ start: node.moduleSpecifier.getStart(parsed), end: node.moduleSpecifier.end, text: '"./vitality-inline.ts"' });
  }
  let copiedConfig = config;
  for (const edit of edits.reverse()) copiedConfig = copiedConfig.slice(0, edit.start) + edit.text + copiedConfig.slice(edit.end);
  const original = "vite.original" + path.extname(configName);
  await writeFile(path.join(destination, original), copiedConfig);
  // Overwrite the copied entry config with an adapter; sourceRoot remains untouched.
  await writeFile(path.join(destination, configName), `import sourceConfig from "./${original}";
import { compactConfig } from "./vitality-inline.ts";
export default async env => compactConfig(await (typeof sourceConfig === "function" ? sourceConfig(env) : sourceConfig), ${JSON.stringify(options.base)});
`);
  const helper = await readFile(new URL("./native-vite-plugin.js", import.meta.url), "utf8");
  await writeFile(path.join(destination, "vitality-inline.ts"), helper.replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, ""));
  await writeWrapperPackage(options.source, destination, options.base, true, 0, options.sourceEntry);
  const pkgPath = path.join(destination, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const originalPackage = JSON.parse(await readFile(path.join(options.source, "package.json"), "utf8"));
  // Match the source's Vite major/plugins instead of downgrading its toolchain.
  pkg.devDependencies.vite = originalPackage.devDependencies?.vite ?? originalPackage.dependencies?.vite ?? pkg.devDependencies.vite;
  pkg.devDependencies["typescript-parser"] = "npm:typescript@5.9.3";
  pkg.devDependencies.tinyglobby = "^0.2.15";
  pkg.vitality.noPublic = true;
  pkg.vitality.nativeVite = true;
  pkg.vitality.generatedConfig = configName;
  pkg.vitality.sourceRoot = ".";
  for (const name of Object.keys(pkg.scripts)) if (name.startsWith("source:")) delete pkg.scripts[name];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  await updateGitignore(destination);
  return result;
}
