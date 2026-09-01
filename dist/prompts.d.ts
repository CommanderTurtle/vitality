import type { Readable, Writable } from "node:stream";
export declare class PromptSession {
    #private;
    constructor(input: Readable, output: Writable);
    text(label: string, defaultValue: string): Promise<string>;
    yesNo(label: string, defaultValue: boolean): Promise<boolean>;
    close(): void;
}
//# sourceMappingURL=prompts.d.ts.map