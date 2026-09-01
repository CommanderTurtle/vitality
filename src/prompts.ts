import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseBooleanWord } from "./args.js";

export class PromptSession {
  readonly #interface: Interface;

  constructor(input: Readable, output: Writable) {
    this.#interface = createInterface({ input, output });
  }

  async text(label: string, defaultValue: string): Promise<string> {
    const response = (await this.#interface.question(`${label} [${defaultValue}]: `)).trim();
    return response === "" ? defaultValue : response;
  }

  async yesNo(label: string, defaultValue: boolean): Promise<boolean> {
    const marker = defaultValue ? "Y/n" : "y/N";
    for (;;) {
      const response = (await this.#interface.question(`${label} [${marker}]: `)).trim();
      if (response === "") return defaultValue;
      try {
        return parseBooleanWord(response, label);
      } catch {
        // Keep the prompt local and forgiving; command-line parsing remains fail-fast.
      }
    }
  }

  close(): void {
    this.#interface.close();
  }
}
