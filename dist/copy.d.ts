export interface CopySummary {
    copiedFiles: number;
    copiedBytes: number;
    excludedEntries: number;
    skippedLinks: number;
    pages: string[];
}
export interface SourceEntry {
    index: string;
    root: string;
    relative: string;
}
export declare function resolveSourceEntry(source: string): Promise<SourceEntry>;
export declare function temporarySibling(source: string, output: string): string;
export declare function copyProject(sourceRoot: string, sourceIndex: string, output: string, temporary: string): Promise<CopySummary>;
export declare function publishTemporary(temporary: string, output: string): Promise<void>;
export declare function removeTemporary(temporary: string, output: string): Promise<void>;
//# sourceMappingURL=copy.d.ts.map