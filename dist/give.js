import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyProject, publishTemporary, removeTemporary, temporarySibling } from "./copy.js";
import { updateGitignore, writeWrapperPackage } from "./package-file.js";
import { generatedReadme, generatedTsconfig, renderViteConfig } from "./templates.js";
export async function give(options) {
    const started = performance.now();
    const temporary = temporarySibling(options.source, options.output);
    let published = false;
    try {
        const copied = await copyProject(options.source, options.output, temporary);
        await mkdir(path.join(temporary, "src"), { recursive: true });
        await Promise.all([
            writeFile(path.join(temporary, "vite.config.ts"), renderViteConfig(options.base, options.inlineAssets, copied.pages), "utf8"),
            writeFile(path.join(temporary, "tsconfig.json"), generatedTsconfig, "utf8"),
            writeFile(path.join(temporary, "README.md"), generatedReadme, "utf8"),
        ]);
        await writeWrapperPackage(options.source, temporary, options.base, options.inlineAssets, copied.pages.length);
        await updateGitignore(temporary);
        await publishTemporary(temporary, options.output);
        published = true;
        return {
            ...copied,
            elapsedMilliseconds: performance.now() - started,
        };
    }
    catch (error) {
        if (!published)
            await removeTemporary(temporary, options.output);
        throw error;
    }
}
//# sourceMappingURL=give.js.map