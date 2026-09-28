import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyProject, publishTemporary, removeTemporary, temporarySibling } from "./copy.js";
import { updateGitignore, writeWrapperPackage } from "./package-file.js";
import { generatedReadme, generatedTsconfig, renderViteConfig, renderProjectViteConfig, projectReadme } from "./templates.js";
import { copyBuildInputs } from "./project-build.js";
import type { GiveOptions, ScaffoldReport } from "./types.js";

export async function give(options: GiveOptions): Promise<ScaffoldReport> {
  const started = performance.now();
  const temporary = temporarySibling(options.source, options.output);
  let published = false;
  try {
    if (options.sourceBuild) {
      const copied = await copyBuildInputs(options.source, options.output, temporary, options.sourceBuild.outDir);
      const buildScript = await writeWrapperPackage(options.source, temporary, options.base, options.inlineAssets, 0, options.sourceEntry, true);
      await mkdir(path.join(temporary, ".vitality"), { recursive: true });
      const adapter = (await readFile(new URL("./build-adapter.js", import.meta.url), "utf8"))
        .replace(/^\/\/# sourceMappingURL=.*$/gm, "");
      const tsconfig = JSON.parse(generatedTsconfig);
      tsconfig.include = ["src", "scripts", ".vitality", "vite.vitality.config.ts"];
      await Promise.all([
        writeFile(path.join(temporary, ".vitality", "build-adapter.ts"), adapter, "utf8"),
        writeFile(path.join(temporary, "vite.vitality.config.ts"), renderProjectViteConfig(options.base, options.inlineAssets, options.sourceBuild.outDir, buildScript), "utf8"),
        writeFile(path.join(temporary, "tsconfig.vitality.json"), JSON.stringify(tsconfig, null, 2) + "\n", "utf8"),
        writeFile(path.join(temporary, "VITALITY.md"), projectReadme, "utf8"),
      ]);
      await updateGitignore(temporary);
      await publishTemporary(temporary, options.output);
      published = true;
      return { ...copied, elapsedMilliseconds: performance.now() - started };
    }
    const copied = await copyProject(
      options.siteRoot,
      options.sourceIndex,
      options.output,
      temporary,
    );
    await mkdir(path.join(temporary, "src"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(temporary, "vite.config.ts"),
        renderViteConfig(options.base, options.inlineAssets, copied.pages),
        "utf8",
      ),
      writeFile(path.join(temporary, "tsconfig.json"), generatedTsconfig, "utf8"),
      writeFile(path.join(temporary, "README.md"), generatedReadme, "utf8"),
    ]);
    await writeWrapperPackage(
      options.source,
      temporary,
      options.base,
      options.inlineAssets,
      copied.pages.length,
      options.sourceEntry,
    );
    await updateGitignore(temporary);
    await publishTemporary(temporary, options.output);
    published = true;
    return {
      ...copied,
      elapsedMilliseconds: performance.now() - started,
    };
  } catch (error) {
    if (!published) await removeTemporary(temporary, options.output);
    throw error;
  }
}
