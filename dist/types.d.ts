export interface CliOptions {
    command?: "give";
    directory?: string;
    output?: string;
    base?: string;
    inlineAssets?: boolean;
    install?: boolean;
    dryRun: boolean;
    help: boolean;
    version: boolean;
}
export interface GiveOptions {
    source: string;
    output: string;
    base: string;
    inlineAssets: boolean;
    install: boolean;
    dryRun: boolean;
}
export interface ScaffoldReport {
    copiedFiles: number;
    copiedBytes: number;
    excludedEntries: number;
    skippedLinks: number;
    elapsedMilliseconds: number;
    installed: boolean;
}
//# sourceMappingURL=types.d.ts.map