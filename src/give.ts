import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyProject, publishTemporary, removeTemporary, temporarySibling } from "./copy.js";
import { updateGitignore, writeWrapperPackage } from "./package-file.js";
import { generatedReadme, generatedTsconfig, renderViteConfig } from "./templates.js";
import { copyComposition } from "./composed-project.js";
import type { GiveOptions, ScaffoldReport } from "./types.js";

export async function give(options: GiveOptions): Promise<ScaffoldReport> {
  const started = performance.now();
  const temporary = temporarySibling(options.source, options.output);
  let published = false;
  try {
    const copied = options.composition
      ? await copyComposition(options.source, temporary, options.composition, options.base, options.inlineAssets)
      : await copyProject(
      options.siteRoot,
      options.sourceIndex,
      options.output,
      temporary,
    );
    await mkdir(path.join(temporary, "src"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(temporary, "vite.config.ts"),
        "config" in copied ? String(copied.config) : renderViteConfig(options.base, options.inlineAssets, copied.pages),
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
    if (options.composition) {
      const file = path.join(temporary, "package.json");
      const pkg = JSON.parse(await readFile(file, "utf8"));
      // The wrapper owns its Vite commands; source build scripts are not needed.
      for (const name of Object.keys(pkg.scripts)) if (name.startsWith("source:")) delete pkg.scripts[name];
      await writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
    }
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
