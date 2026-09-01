import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "./args.js";
const viteVersion = "8.2.2";
const typescriptVersion = "7.0.2";
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function objectProperty(source, key) {
    return isObject(source[key]) ? { ...source[key] } : {};
}
function availableScriptName(scripts, initial) {
    if (!(initial in scripts))
        return initial;
    for (let suffix = 2;; suffix += 1) {
        const candidate = `${initial}:${suffix}`;
        if (!(candidate in scripts))
            return candidate;
    }
}
function wrapperName(original, directory) {
    const fallback = path.basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-") || "webapp";
    const name = typeof original === "string" && original.trim() !== "" ? original : fallback;
    if (name.startsWith("@") && name.includes("/")) {
        const slash = name.indexOf("/");
        return `${name.slice(0, slash + 1)}${name.slice(slash + 1)}-vitality`;
    }
    return `${name}-vitality`;
}
export async function writeWrapperPackage(wrapper, base, inlineAssets) {
    const packagePath = path.join(wrapper, "package.json");
    let original = {};
    try {
        const parsed = JSON.parse(await readFile(packagePath, "utf8"));
        if (!isObject(parsed))
            throw new UsageError("source package.json must contain a JSON object");
        original = parsed;
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            if (error instanceof UsageError)
                throw error;
            throw new UsageError(`source package.json is not valid JSON: ${error.message}`);
        }
    }
    const scripts = objectProperty(original, "scripts");
    for (const reserved of ["dev", "serve", "build", "preview"]) {
        const existing = scripts[reserved];
        if (typeof existing === "string" && existing !== "") {
            scripts[availableScriptName(scripts, `source:${reserved}`)] = existing;
        }
    }
    scripts.dev = "vite --config vitality.config.mts";
    scripts.serve = "vite --config vitality.config.mts";
    scripts.build = "vite build --config vitality.config.mts";
    scripts.preview = "vite preview --config vitality.config.mts";
    const dependencies = objectProperty(original, "dependencies");
    delete dependencies.vite;
    const devDependencies = objectProperty(original, "devDependencies");
    devDependencies.vite = viteVersion;
    devDependencies.typescript ??= typescriptVersion;
    const generated = {
        ...original,
        name: wrapperName(original.name, wrapper),
        private: true,
        scripts,
        dependencies,
        devDependencies,
        packageManager: "bun@1.4.0",
        vitality: {
            schemaVersion: 1,
            base,
            assetsInlineLimit: inlineAssets ? "Infinity" : "vite-default",
            generatedConfig: "vitality.config.mts",
        },
    };
    if (Object.keys(dependencies).length === 0)
        delete generated.dependencies;
    await writeFile(packagePath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
}
export async function updateGitignore(wrapper) {
    const ignorePath = path.join(wrapper, ".gitignore");
    let content = "";
    try {
        content = await readFile(ignorePath, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const required = ["node_modules/", "dist/", ".vite/"];
    const existing = new Set(content.split(/\r?\n/u).map((line) => line.trim()));
    const missing = required.filter((line) => !existing.has(line));
    if (missing.length === 0)
        return;
    const prefix = content === "" || content.endsWith("\n") ? content : `${content}\n`;
    await writeFile(ignorePath, `${prefix}\n# Generated Vite workspace\n${missing.join("\n")}\n`, "utf8");
}
//# sourceMappingURL=package-file.js.map