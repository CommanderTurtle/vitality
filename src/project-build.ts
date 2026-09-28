import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { containsPath } from "./paths.js";
import type { CopySummary } from "./copy.js";

export async function copyBuildInputs(source: string, output: string, temporary: string, outDir: string): Promise<CopySummary> {
  const excluded = new Set([".git", ".hg", ".svn", ".work", ".cache", ".tmp", ".vite", ".vitality", "node_modules", "mywrap", "coverage"]);
  const report: CopySummary = { copiedFiles: 0, copiedBytes: 0, excludedEntries: 0, skippedLinks: 0, pages: [] };
  const generated = [path.resolve(source, outDir), path.join(source, "dist"), path.join(source, "build"), output, temporary];
  await mkdir(temporary, { recursive: true });
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { report.skippedLinks++; continue; }
      if (excluded.has(entry.name) || entry.name.startsWith(".env") || generated.some((root) => containsPath(root, file))
          || (directory === source && ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"].includes(entry.name))) {
        report.excludedEntries++;
        continue;
      }
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) continue;
      const destination = path.join(temporary, path.relative(source, file));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file, destination);
      report.copiedFiles++;
      report.copiedBytes += (await lstat(file)).size;
    }
  }
  await visit(source);
  return report;
}
