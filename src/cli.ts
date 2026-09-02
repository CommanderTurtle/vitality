#!/usr/bin/env node
import process from "node:process";
import { version as viteVersion } from "vite";
import { helpText, parseArguments, UsageError } from "./args.js";
import { normalizeBase } from "./base.js";
import { resolveSourceEntry } from "./copy.js";
import { give } from "./give.js";
import {
  resolveSourceDirectory,
  resolveWrapperDirectory,
  validateWrapperLayout,
} from "./paths.js";
import { PromptSession } from "./prompts.js";
import type { CliOptions, GiveOptions } from "./types.js";

const vitalityVersion = "0.3.0";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function resolveGiveOptions(parsed: CliOptions): Promise<GiveOptions> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompt = interactive ? new PromptSession(process.stdin, process.stdout) : null;
  try {
    let directory = parsed.directory;
    if (directory === undefined) {
      if (!prompt) throw new UsageError("give requires --dir when input is not interactive");
      directory = await prompt.text("Source directory", ".");
    }
    const source = await resolveSourceDirectory(directory, process.cwd());
    const output = await resolveWrapperDirectory(parsed.output, source);
    await validateWrapperLayout(source, output);
    const entry = await resolveSourceEntry(source);

    let base = parsed.base;
    if (base === undefined) base = prompt ? await prompt.text("Public base path", "/") : "/";

    let inlineAssets = parsed.inlineAssets;
    if (inlineAssets === undefined) {
      inlineAssets = prompt
        ? await prompt.yesNo("Inline every imported asset (assetsInlineLimit: Infinity)?", false)
        : false;
    }
    return {
      source,
      siteRoot: entry.root,
      sourceIndex: entry.index,
      sourceEntry: entry.relative,
      output,
      base: normalizeBase(base),
      inlineAssets,
      dryRun: parsed.dryRun,
    };
  } finally {
    prompt?.close();
  }
}

function printOperation(options: GiveOptions): void {
  console.log("\nVitality give");
  console.log(`  source       ${options.source}`);
  console.log(`  entry        ${options.sourceEntry}`);
  console.log(`  wrapper      ${options.output}`);
  console.log(`  base         ${options.base === "" ? "(empty)" : options.base}`);
  console.log(`  asset inline ${options.inlineAssets ? "Infinity" : "Vite default"}`);
  console.log("  dependencies not installed");
  console.log("  dist         not built\n");
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.version) {
    console.log(`vitality ${vitalityVersion} (Vite ${viteVersion})`);
    return;
  }
  if (parsed.help) {
    console.log(helpText);
    return;
  }
  if (parsed.command !== "give") throw new UsageError("a command is required; use vitality give --dir PATH");

  const options = await resolveGiveOptions(parsed);
  printOperation(options);
  if (options.dryRun) {
    console.log("Dry run complete; no directory was created.");
    return;
  }

  const report = await give(options);
  console.log(`Created ${options.output}`);
  console.log(`Copied ${report.copiedFiles} source files (${formatBytes(report.copiedBytes)})`);
  if (report.excludedEntries > 0) console.log(`Excluded ${report.excludedEntries} generated/dependency tree(s)`);
  console.log(`Ready in ${(report.elapsedMilliseconds / 1000).toFixed(2)}s`);
  console.log("\nNext:");
  console.log(`  cd ${JSON.stringify(options.output)}`);
  console.log("  bun install");
  console.log("  bun run serve   # development");
  console.log("  bun run build   # writes dist/");
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`vitality: ${error.message}`);
    console.error("Run vitality --help for usage.");
  } else {
    console.error(`vitality: ${(error as Error).stack ?? String(error)}`);
  }
  process.exitCode = 1;
});
