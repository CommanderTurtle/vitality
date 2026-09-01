export class UsageError extends Error {
    name = "UsageError";
}
const booleanWords = new Map([
    ["1", true], ["true", true], ["yes", true], ["y", true], ["on", true],
    ["0", false], ["false", false], ["no", false], ["n", false], ["off", false],
]);
export function parseBooleanWord(value, optionName = "value") {
    const parsed = booleanWords.get(value.trim().toLowerCase());
    if (parsed === undefined) {
        throw new UsageError(`${optionName} expects yes or no, received ${JSON.stringify(value)}`);
    }
    return parsed;
}
function splitLongOption(argument) {
    const equals = argument.indexOf("=");
    return equals < 0
        ? { name: argument }
        : { name: argument.slice(0, equals), attached: argument.slice(equals + 1) };
}
function requireValue(arguments_, index, name, attached) {
    if (attached !== undefined) {
        if (attached === "")
            throw new UsageError(`${name} requires a value`);
        return { value: attached, nextIndex: index };
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-"))
        throw new UsageError(`${name} requires a value`);
    return { value, nextIndex: index + 1 };
}
function optionalBoolean(arguments_, index, name, attached) {
    if (attached !== undefined)
        return { value: parseBooleanWord(attached, name), nextIndex: index };
    const candidate = arguments_[index + 1];
    if (candidate !== undefined && booleanWords.has(candidate.toLowerCase())) {
        return { value: parseBooleanWord(candidate, name), nextIndex: index + 1 };
    }
    return { value: true, nextIndex: index };
}
export function parseArguments(arguments_) {
    const options = { dryRun: false, help: false, version: false };
    let index = 0;
    const first = arguments_[0];
    if (first === "give") {
        options.command = "give";
        index = 1;
    }
    else if (first !== undefined && !first.startsWith("-")) {
        throw new UsageError(`unknown command: ${first}`);
    }
    for (; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === undefined)
            continue;
        const { name, attached } = splitLongOption(argument);
        switch (name) {
            case "-h":
            case "--help":
                options.help = true;
                break;
            case "-v":
            case "--version":
                options.version = true;
                break;
            case "-d":
            case "--dir": {
                const found = requireValue(arguments_, index, name, attached);
                options.directory = found.value;
                index = found.nextIndex;
                break;
            }
            case "-o":
            case "--output":
            case "--out": {
                const found = requireValue(arguments_, index, name, attached);
                options.output = found.value;
                index = found.nextIndex;
                break;
            }
            case "-b":
            case "--base": {
                const found = requireValue(arguments_, index, name, attached);
                options.base = found.value;
                index = found.nextIndex;
                break;
            }
            case "--inline":
            case "--inline-assets": {
                const found = optionalBoolean(arguments_, index, name, attached);
                options.inlineAssets = found.value;
                index = found.nextIndex;
                break;
            }
            case "--no-inline":
            case "--no-inline-assets":
                options.inlineAssets = false;
                break;
            case "--install": {
                const found = optionalBoolean(arguments_, index, name, attached);
                options.install = found.value;
                index = found.nextIndex;
                break;
            }
            case "--no-install":
                options.install = false;
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            default:
                throw new UsageError(`unknown option: ${name}`);
        }
    }
    return options;
}
export const helpText = `Vitality — wrap a standalone webapp in a ready-to-run Vite project.

Usage:
  vitality give --dir PATH
  vitality give --dir PATH --base /project/ --inline yes

The default output is PATH/mywrap. The source is never modified, and no dist
bundle is created by give. Afterward:

  cd PATH/mywrap
  bun run serve        # Vite development server
  bun run build        # production bundle in dist/

Options:
  -d, --dir PATH           Source standalone directory (literal filesystem path)
  -o, --output PATH        Wrapper destination (default: SOURCE/mywrap)
  -b, --base PATH          Public base: /, /project/, ./, or an http(s) URL
      --inline [yes|no]    Generate assetsInlineLimit: Infinity (default: ask/No)
      --no-inline          Keep Vite's normal asset inline limit
      --install [yes|no]   Run bun install in the wrapper (default: yes)
      --no-install         Generate without installing dependencies
      --dry-run            Validate and show the operation without writing
  -h, --help               Show this help
  -v, --version            Show the Vitality and bundled Vite versions

Boolean options accept y/n, yes/no, true/false, on/off, or 1/0.`;
//# sourceMappingURL=args.js.map