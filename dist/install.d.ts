export declare class InstallError extends Error {
    readonly wrapper: string;
    name: string;
    constructor(wrapper: string, message: string);
}
export declare function installWithBun(wrapper: string): Promise<void>;
//# sourceMappingURL=install.d.ts.map