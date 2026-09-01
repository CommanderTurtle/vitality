export interface CliOptions {
    command?: "give";
    directory?: string;
    output?: string;
    base?: string;
    inlineAssets?: boolean;
    dryRun: boolean;
    help: boolean;
    version: boolean;
}
export interface GiveOptions {
    source: string;
    output: string;
    base: string;
    inlineAssets: boolean;
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
//# sourceMappingURL=types.d.ts.map