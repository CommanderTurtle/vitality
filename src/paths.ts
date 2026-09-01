import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./args.js";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function canonicalPotentialPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...suffix);
}

export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveSourceDirectory(value: string, cwd: string): Promise<string> {
  const resolved = await canonicalPotentialPath(path.resolve(cwd, value));
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw new UsageError(`source directory does not exist: ${resolved}`);
  }
  if (!metadata.isDirectory()) throw new UsageError(`source is not a directory: ${resolved}`);
  return resolved;
}

export async function resolveWrapperDirectory(value: string | undefined, source: string): Promise<string> {
  const requested = value ?? "mywrap";
  return canonicalPotentialPath(path.isAbsolute(requested) ? requested : path.resolve(source, requested));
}

export async function validateWrapperLayout(source: string, output: string): Promise<void> {
  const outputRoot = path.parse(output).root;
  const home = await canonicalPotentialPath(os.homedir());
  if (output === outputRoot) throw new UsageError(`refusing to use a filesystem root: ${output}`);
  if (output === home) throw new UsageError(`refusing to use the home directory: ${output}`);
  if (output === source) throw new UsageError("wrapper output cannot be the source directory");
  if (containsPath(output, source)) throw new UsageError("wrapper output cannot contain the source directory");
  if (await exists(output)) throw new UsageError(`wrapper output already exists: ${output}`);
}
