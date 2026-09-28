export interface CliOptions {
  command?: "give";
  directory?: string;
  output?: string;
  base?: string;
  buildOutput?: string;
  inlineAssets?: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

export interface GiveOptions {
  source: string;
  siteRoot: string;
  sourceIndex: string;
  sourceEntry: string;
  output: string;
  base: string;
  inlineAssets: boolean;
  dryRun: boolean;
  sourceBuild?: { outDir: string };
}

export interface ScaffoldReport {
  copiedFiles: number;
  copiedBytes: number;
  excludedEntries: number;
  skippedLinks: number;
  pages: string[];
  elapsedMilliseconds: number;
}
