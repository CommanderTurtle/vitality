import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { containsPath } from "./paths.js";
const excludedDirectoryNames = new Set([
    ".git", ".hg", ".svn", ".cache", ".tmp", ".vite", "node_modules", "coverage", "dist", "build",
]);
function isExcluded(source, candidate, output, temporary) {
    if (candidate === source)
        return false;
    if (candidate === output || candidate === temporary
        || containsPath(output, candidate) || containsPath(temporary, candidate))
        return true;
    const relative = path.relative(source, candidate);
    const segments = relative.split(path.sep);
    return segments.some((segment) => excludedDirectoryNames.has(segment));
}
async function summarize(directory) {
    const summary = {
        copiedFiles: 0,
        copiedBytes: 0,
        excludedEntries: 0,
        skippedLinks: 0,
    };
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined)
            break;
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
                pending.push(absolute);
            else if (entry.isSymbolicLink())
                summary.skippedLinks += 1;
            else if (entry.isFile()) {
                summary.copiedFiles += 1;
                summary.copiedBytes += (await stat(absolute)).size;
            }
        }
    }
    return summary;
}
export function temporarySibling(source, output) {
    const outputParent = path.dirname(output);
    const temporaryParent = containsPath(source, outputParent) ? path.dirname(source) : outputParent;
    return path.join(temporaryParent, `.${path.basename(output)}.vitality-${process.pid}-${randomUUID()}`);
}
export async function copyProject(source, output, temporary) {
    await mkdir(path.dirname(temporary), { recursive: true });
    let excludedEntries = 0;
    await cp(source, temporary, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter(candidate) {
            const excluded = isExcluded(source, candidate, output, temporary);
            if (excluded)
                excludedEntries += 1;
            return !excluded;
        },
    });
    const result = await summarize(temporary);
    result.excludedEntries = excludedEntries;
    return result;
}
export async function publishTemporary(temporary, output) {
    await mkdir(path.dirname(output), { recursive: true });
    await rename(temporary, output);
}
export async function removeTemporary(temporary, output) {
    const expectedPrefix = `.${path.basename(output)}.vitality-`;
    if (temporary === path.parse(temporary).root || !path.basename(temporary).startsWith(expectedPrefix)) {
        throw new Error(`refusing to remove an unrecognized temporary path: ${temporary}`);
    }
    try {
        const metadata = await lstat(temporary);
        if (metadata.isDirectory())
            await rm(temporary, { recursive: true, force: false });
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
//# sourceMappingURL=copy.js.map