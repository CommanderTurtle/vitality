import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { UsageError } from "./args.js";
import { buildIdentity, cliLocation } from "./version.js";

type Package = { name?: string; vitality?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Release = { version: string; engines?: { node?: string } };

export async function latestVite(fetcher: typeof fetch = fetch): Promise<Release> {
  const response = await fetcher("https://registry.npmjs.org/vite/latest", {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Vite registry returned HTTP ${response.status}`);
  const release = await response.json() as Release & { name?: string };
  if (release.name !== "vite" || !/^\d+\.\d+\.\d+$/u.test(release.version)) {
    throw new Error("Vite registry did not return a stable release");
  }
  return release;
}

export function updateVite(pkg: Package, version: string): void {
  // Preserve a native project's dependency placement; never rewrite its config/plugins.
  if (pkg.dependencies?.vite !== undefined) pkg.dependencies.vite = version;
  if (pkg.devDependencies?.vite !== undefined || pkg.dependencies?.vite === undefined) {
    (pkg.devDependencies ??= {}).vite = version;
  }
}

export async function installedVite(directory: string): Promise<string | undefined> {
  try {
    // Do not mistake a parent checkout's Vite for this wrapper's installation.
    const pkg = JSON.parse(await readFile(path.join(directory, "node_modules", "vite", "package.json"), "utf8"));
    return pkg.version;
  } catch { return undefined; }
}

function runBun(directory: string, args: string[]): { ok: boolean; output: string } {
  const command = process.versions.bun ? process.execPath : "bun";
  const result = spawnSync(command, args, {
    cwd: directory, encoding: "utf8", windowsHide: true,
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: result.status === 0 && !result.error, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() };
}

export async function doctor(input: string, fix: boolean): Promise<number> {
  const directory = await realpath(path.resolve(input));
  const manifestPath = path.join(directory, "package.json");
  const original = await readFile(manifestPath, "utf8");
  const pkg = JSON.parse(original) as Package;
  if (pkg.name !== "vitality" && (!pkg.vitality || typeof pkg.vitality !== "object")) {
    throw new UsageError("doctor requires the Vitality checkout or a generated wrapper (--dir PATH)");
  }
  const identity = await buildIdentity();
  console.log(`Vitality ${identity.version} / build ${identity.build}`);
  console.log(`  executable   ${await cliLocation()}`);
  console.log(`  project      ${directory}`);
  console.log(`  generator    ${JSON.stringify(pkg.vitality ?? "Vitality source checkout")}`);
  const latest = await latestVite();
  console.log(`  Vite declared ${pkg.devDependencies?.vite ?? pkg.dependencies?.vite ?? "missing"}`);
  console.log(`  Vite installed ${await installedVite(directory) ?? "not installed"}`);
  console.log(`  Vite stable   ${latest.version} (Node ${latest.engines?.node ?? "see Vite documentation"})`);
  if (fix) {
    const backup = path.join(directory, ".vitality", `doctor-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, "package.json"), original);
    for (const name of ["bun.lock", "bun.lockb"]) {
      try { await writeFile(path.join(backup, name), await readFile(path.join(directory, name))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    console.log(`  backup       ${backup}`);
    updateVite(pkg, latest.version);
    await writeFile(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const install = runBun(directory, ["install", "--ignore-scripts"]);
    console.log(install.output);
    if (!install.ok) {
      console.error("Install failed. Backup retained; no build or lifecycle scripts were run.");
      return 1;
    }
    // Use Bun's maintained resolver, not a second advisory/override implementation.
    const repair = runBun(directory, ["audit", "fix", "--ignore-scripts"]);
    console.log(repair.output);
    if (!repair.ok) {
      console.error("Audit repair did not finish cleanly; inspect the report and retained backup.");
      return 1;
    }
  }
  const installed = await installedVite(directory);
  const audit = runBun(directory, ["audit"]);
  console.log(audit.output);
  const ok = installed === latest.version && audit.ok;
  console.log(`  result       ${ok ? "OK" : "ATTENTION"}`);
  if (!ok && !fix) console.log("Run vitality doctor --dir PATH --fix to update Vite and repair auditable dependencies.");
  if (fix) console.log("Build explicitly with bun run build; existing dist files were not rebuilt. Re-run Vitality after updating its own toolchain.");
  return ok ? 0 : 1;
}
