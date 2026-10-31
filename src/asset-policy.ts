import path from "node:path";
import { createHash } from "node:crypto";

// Runtime engines are files in every delivery mode, including inline builds.
// Vite's default asset list does not include archives such as TAR.
export const binaryAssetGlobs = ["wasm", "data", "sf2", "gz", "tar"]
  .map(extension => "**/*." + [...extension].map(letter => `[${letter}${letter.toUpperCase()}]`).join(""));
export function binaryAsset(name: string): boolean {
  return binaryFile(name) !== undefined;
}
export function binaryFile(id: string): string | undefined {
  const file = id.split("?")[0]!;
  const pattern = /\.(?:wasm|data|sf2|gz|tar)$/i;
  if (pattern.test(file)) return file;
  const hash = file.indexOf("#", Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  if (hash >= 0 && pattern.test(file.slice(0, hash))) return file.slice(0, hash);
}
// Self-contained because ordinary generated configs serialize this predicate.
export function engineAsset(name: string): boolean {
  const file = name.split("?")[0]!;
  const pattern = /(?:^|[\\/])wasm[\\/]|\.wasm(?:\.js)?$|\.(?:data|sf2|gz|tar)$/i;
  if (pattern.test(file)) return true;
  const hash = file.indexOf("#", Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return hash >= 0 && pattern.test(file.slice(0, hash));
}
// Both manifest and compiler graphs use byte identity, so a sidecar addressed
// through imports, workers and runtime URLs has one emitted file.
export function engineFileName(name: string, bytes: string | Uint8Array): string {
  const suffix = name.endsWith(".wasm.js") ? ".wasm.js" : path.extname(name);
  const stem = path.basename(name, suffix).replace(/[^\w.-]/g, "-");
  return `assets/${stem}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}${suffix}`;
}

// A hash-derived name is a claim, not proof that another producer supplied the
// same bytes. Compact collectors and compiler/worker graphs reconcile by bytes
// before deduplicating; a real conflict must never become last-writer-wins.
export function sameAssetSource(left: string | Uint8Array, right: string | Uint8Array): boolean {
  const bytes = (value: string | Uint8Array) => typeof value === "string" ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes(left).equals(bytes(right));
}
export function claimAsset(assets: Map<string, string | Uint8Array>, name: string, source: string | Uint8Array): boolean {
  const previous = assets.get(name);
  if (previous !== undefined) {
    if (!sameAssetSource(previous, source)) throw new Error("Conflicting emitted asset bytes: " + name);
    return false;
  }
  assets.set(name, source);
  return true;
}
