import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { version as vite } from "vite";

export async function buildIdentity(): Promise<{ version: string; build: string; vite: string }> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // Fingerprint the code actually being executed, not HEAD in a possibly newer checkout.
  const directory = new URL("./", import.meta.url);
  const hash = createHash("sha256");
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".js")).sort()) {
    hash.update(name).update("\0").update(await readFile(new URL(name, directory))).update("\0");
  }
  return { version: pkg.version, build: hash.digest("hex").slice(0, 12), vite };
}

export function cliLocation(): Promise<string> {
  return realpath(fileURLToPath(new URL("./cli.js", import.meta.url)));
}
