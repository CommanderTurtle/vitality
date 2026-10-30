import type { Composition } from "./composition.js";

export interface CliOptions {
  command?: "give" | "doctor";
  fix?: boolean;
  directory?: string;
  output?: string;
  base?: string;
  inlineAssets?: boolean;
  noPublic?: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

export interface GiveOptions {
  composition?: Composition;
  libraryOutputs?: ReadonlyMap<string, string>;
  libraryFiles?: ReadonlyMap<string, string>;
  source: string;
  siteRoot: string;
  sourceIndex: string;
  sourceEntry: string;
  output: string;
  base: string;
  inlineAssets: boolean;
  noPublic?: boolean;
  dryRun: boolean;
}

export interface ScaffoldReport {
  copiedFiles: number;
  copiedBytes: number;
  excludedEntries: number;
  skippedLinks: number;
  pages: string[];
  elapsedMilliseconds: number;
}
