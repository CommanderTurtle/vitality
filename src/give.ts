import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyProject, publishTemporary, removeTemporary, temporarySibling } from "./copy.js";
import { installWithBun } from "./install.js";
import { updateGitignore, writeWrapperPackage } from "./package-file.js";
import { generatedReadme, renderViteConfig, standaloneHelper } from "./templates.js";
import type { GiveOptions, ScaffoldReport } from "./types.js";

export async function give(options: GiveOptions): Promise<ScaffoldReport> {
  const started = performance.now();
  const temporary = temporarySibling(options.source, options.output);
  let published = false;
  try {
    const copied = await copyProject(options.source, options.output, temporary);
    const vitalityDirectory = path.join(temporary, ".vitality");
    await mkdir(vitalityDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(temporary, "vitality.config.mts"),
        renderViteConfig(options.base, options.inlineAssets),
        "utf8",
      ),
      writeFile(path.join(vitalityDirectory, "standalone.mts"), standaloneHelper, "utf8"),
      writeFile(path.join(vitalityDirectory, "README.md"), generatedReadme, "utf8"),
    ]);
    await writeWrapperPackage(temporary, options.base, options.inlineAssets);
    await updateGitignore(temporary);
    await publishTemporary(temporary, options.output);
    published = true;
    if (options.install) await installWithBun(options.output);
    return {
      ...copied,
      elapsedMilliseconds: performance.now() - started,
      installed: options.install,
    };
  } catch (error) {
    if (!published) await removeTemporary(temporary, options.output);
    throw error;
  }
}
