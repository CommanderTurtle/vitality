import { createInterface } from "node:readline/promises";
import { parseBooleanWord } from "./args.js";
export class PromptSession {
    #interface;
    constructor(input, output) {
        this.#interface = createInterface({ input, output });
    }
    async text(label, defaultValue) {
        const response = (await this.#interface.question(`${label} [${defaultValue}]: `)).trim();
        return response === "" ? defaultValue : response;
    }
    async yesNo(label, defaultValue) {
        const marker = defaultValue ? "Y/n" : "y/N";
        for (;;) {
            const response = (await this.#interface.question(`${label} [${marker}]: `)).trim();
            if (response === "")
                return defaultValue;
            try {
                return parseBooleanWord(response, label);
            }
            catch {
                // Keep the prompt local and forgiving; command-line parsing remains fail-fast.
            }
        }
    }
    close() {
        this.#interface.close();
    }
}
//# sourceMappingURL=prompts.js.map