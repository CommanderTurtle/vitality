import path from "node:path";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import ts from "typescript-parser";
import { containsPath } from "./paths.js";
import { UsageError } from "./args.js";

export type ComposedFile = { file: string } | { text: string } | { module: string; format: string };
export interface Composition {
  script: string;
  files: Map<string, ComposedFile>;
}
type Value = any;
interface Scope { values: Map<string, Value>; parent?: Scope }
const callable = Symbol("static-operation");
const fileHandle = Symbol("source-file");
const returned = Symbol("return");
const native = (fn: (...args: Value[]) => Value) => ({ [callable]: fn });

// A small, closed expression reader: no eval, module execution, subprocesses, compilation,
// network, or source writes. Filesystem operations describe an in-memory overlay.
class Reader {
  readonly files = new Map<string, ComposedFile>();
  private readonly loaded = new Map<string, Scope>();
  private budget = 100_000;
  constructor(private readonly root: string) {}
  private safe(file: string): string {
    const absolute = path.resolve(file);
    if (!containsPath(this.root, absolute)
        || (existsSync(absolute) && !containsPath(this.root, realpathSync(absolute)))) {
      throw new UsageError("Source recipe references a file outside the project: " + file);
    }
    return absolute;
  }
  private read(file: string): string {
    const item = this.files.get(this.safe(file));
    if (item && "text" in item) return item.text;
    if (item && "module" in item) throw new UsageError("Compiled output cannot be read during source detection");
    return readFileSync(this.safe(item && "file" in item ? item.file : file), "utf8");
  }
  private lookup(scope: Scope, key: string): Value {
    if (scope.values.has(key)) return scope.values.get(key);
    if (scope.parent) return this.lookup(scope.parent, key);
    if (key === "undefined") return undefined;
    throw new UsageError("Unresolved source expression: " + key);
  }
  private assign(scope: Scope, key: string, value: Value): void {
    if (!scope.values.has(key) && scope.parent) this.assign(scope.parent, key, value);
    else scope.values.set(key, value);
  }
  private bind(name: ts.BindingName, value: Value, scope: Scope): void {
    if (ts.isIdentifier(name)) scope.values.set(name.text, value);
    else if (ts.isArrayBindingPattern(name)) name.elements.forEach((item, index) => {
      if (ts.isBindingElement(item)) this.bind(item.name, value[index], scope);
    });
    else throw this.unsupported(name);
  }
  private unsupported(node: ts.Node): UsageError {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    return new UsageError(`Cannot statically resolve ${path.relative(this.root, source.fileName)}:${line}: ${node.getText().slice(0, 100)}`);
  }
  private invoke(value: Value, args: Value[]): Value {
    if (!value || typeof value[callable] !== "function") throw new UsageError("Unsupported call in source recipe");
    return value[callable](...args);
  }
  private copy(from: string, to: string): void {
    this.safe(from); this.safe(to);
    if (lstatSync(from).isSymbolicLink()) throw new UsageError("Symlink in source recipe: " + from);
    if (lstatSync(from).isDirectory()) {
      for (const name of readdirSync(from)) {
        if ([".git", "node_modules"].includes(name) || name.startsWith(".env")) continue;
        this.copy(path.join(from, name), path.join(to, name));
      }
    } else this.files.set(to, { file: from });
  }
  private property(value: Value, key: string): Value {
    if (["constructor", "prototype", "__proto__"].includes(key)) throw new UsageError("Unsupported property in source recipe");
    if (value?.[fileHandle]) {
      const file = value[fileHandle] as string;
      if (key === "exists") return native(() => this.files.has(file) || existsSync(this.safe(file)));
      if (key === "text") return native(() => this.read(file));
      if (key === "json") return native(() => JSON.parse(this.read(file)));
    }
    if (typeof value === "string") {
      if (key === "replace" || key === "replaceAll") return native((pattern, replacement) => {
        const withValue = replacement?.[callable]
          ? (...args: Value[]) => this.invoke(replacement, args) : replacement;
        return key === "replace" ? value.replace(pattern, withValue) : value.replaceAll(pattern, withValue);
      });
      if (key === "trim") return native(() => value.trim());
    }
    if (Array.isArray(value)) {
      if (key === "push") return native((...items) => value.push(...items));
      if (key === "join") return native((separator) => value.join(separator));
      if (key === "map") return native((fn) => value.map((item, index) => this.invoke(fn, [item, index])));
    }
    if (value != null && (Object.hasOwn(value, key) || key === "length")) return value[key];
    throw new UsageError("Unsupported property in source recipe: " + key);
  }
  private expression(node: ts.Expression, scope: Scope): Value {
    if (--this.budget < 0) throw new UsageError("Source recipe exceeds static analysis limit");
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
        || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return this.expression(node.expression, scope);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isRegularExpressionLiteral(node)) {
      const end = node.text.lastIndexOf("/");
      return new RegExp(node.text.slice(1, end), node.text.slice(end + 1));
    }
    if (ts.isIdentifier(node)) return this.lookup(scope, node.text);
    if (ts.isMetaProperty(node) && node.getText() === "import.meta") return { dir: path.dirname(node.getSourceFile().fileName) };
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => String(this.expression(span.expression, scope)) + span.literal.text).join("");
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(item => ts.isSpreadElement(item)
      ? this.expression(item.expression, scope) : [this.expression(item as ts.Expression, scope)]);
    if (ts.isObjectLiteralExpression(node)) {
      const result = Object.create(null);
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) Object.assign(result, this.expression(item.expression, scope));
        else if (ts.isShorthandPropertyAssignment(item)) result[item.name.text] = this.lookup(scope, item.name.text);
        else if (ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name))) {
          result[item.name.text] = this.expression(item.initializer, scope);
        } else throw this.unsupported(item);
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node)) return this.property(this.expression(node.expression, scope), node.name.text);
    if (ts.isElementAccessExpression(node)) return this.property(this.expression(node.expression, scope), String(this.expression(node.argumentExpression, scope)));
    if (ts.isConditionalExpression(node)) return this.expression(this.expression(node.condition, scope) ? node.whenTrue : node.whenFalse, scope);
    if (ts.isPrefixUnaryExpression(node)) {
      const value = this.expression(node.operand, scope);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
      if (node.operator === ts.SyntaxKind.MinusToken) return -value;
      if (node.operator === ts.SyntaxKind.PlusToken) return +value;
    }
    if (ts.isPostfixUnaryExpression(node) && ts.isIdentifier(node.operand)) {
      const value = this.lookup(scope, node.operand.text);
      this.assign(scope, node.operand.text, value + (node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1));
      return value;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return native((...args) => {
      const local: Scope = { values: new Map(), parent: scope };
      node.parameters.forEach((parameter, index) => this.bind(parameter.name,
        args[index] === undefined && parameter.initializer ? this.expression(parameter.initializer, local) : args[index], local));
      if (!ts.isBlock(node.body)) return this.expression(node.body, local);
      const result = this.statements(node.body.statements, local);
      return result?.[returned];
    });
    if (ts.isCallExpression(node)) return this.invoke(this.expression(node.expression, scope),
      node.arguments.flatMap(item => ts.isSpreadElement(item) ? this.expression(item.expression, scope) : [this.expression(item, scope)]));
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error") {
      return new UsageError(String(node.arguments?.[0] ? this.expression(node.arguments[0], scope) : "Invalid source recipe"));
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const value = this.expression(node.right, scope); this.assign(scope, node.left.text, value); return value;
      }
      const left = this.expression(node.left, scope);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && this.expression(node.right, scope);
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || this.expression(node.right, scope);
      const right = this.expression(node.right, scope);
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
        case ts.SyntaxKind.LessThanToken: return left < right;
        case ts.SyntaxKind.GreaterThanToken: return left > right;
      }
    }
    throw this.unsupported(node);
  }
  private statement(node: ts.Statement, scope: Scope): Value {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        this.bind(declaration.name, declaration.initializer ? this.expression(declaration.initializer, scope) : undefined, scope);
      }
    } else if (ts.isExpressionStatement(node)) this.expression(node.expression, scope);
    else if (ts.isIfStatement(node)) {
      const branch = this.expression(node.expression, scope) ? node.thenStatement : node.elseStatement;
      if (branch) return this.statement(branch, scope);
    } else if (ts.isBlock(node)) return this.statements(node.statements, { values: new Map(), parent: scope });
    else if (ts.isReturnStatement(node)) return { [returned]: node.expression ? this.expression(node.expression, scope) : undefined };
    else if (ts.isThrowStatement(node)) throw this.expression(node.expression, scope);
    else if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const declaration = node.initializer.declarations[0]!;
      for (const value of this.expression(node.expression, scope)) {
        const local: Scope = { values: new Map(), parent: scope };
        this.bind(declaration.name, value, local);
        const result = this.statement(node.statement, local);
        if (result) return result;
      }
    } else if (!ts.isEmptyStatement(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) throw this.unsupported(node);
    return undefined;
  }
  private statements(nodes: ts.NodeArray<ts.Statement>, scope: Scope): Value {
    for (const node of nodes) { const result = this.statement(node, scope); if (result) return result; }
  }
  load(file: string): Scope {
    this.safe(file);
    if (this.loaded.has(file)) return this.loaded.get(file)!;
    const scope: Scope = { values: new Map() };
    this.loaded.set(file, scope);
    const fs = {
      mkdir: native(() => undefined),
      cp: native((from, to) => this.copy(this.safe(from), this.safe(to))),
      rm: native((target) => { this.safe(target); for (const key of this.files.keys()) if (containsPath(target, key)) this.files.delete(key); }),
      rename: native((from, to) => {
        this.safe(from); this.safe(to);
        for (const [key, value] of [...this.files]) if (containsPath(from, key)) {
          this.files.set(path.join(to, path.relative(from, key)), value); this.files.delete(key);
        }
      }),
    };
    const paths = { join: native((...items) => path.join(...items)), resolve: native((...items) => path.resolve(...items)) };
    scope.values.set("Bun", {
      file: native((name) => ({ [fileHandle]: this.safe(name) })),
      write: native((name, value) => {
        this.files.set(this.safe(name), value && typeof value.module === "string" ? value : { text: String(value) }); return 0;
      }),
      build: native((options) => ({ success: true, outputs: options.entrypoints.map((entry: string) => ({ module: this.safe(entry), format: options.format ?? "esm" })), logs: [] })),
    });
    scope.values.set("JSON", { stringify: native((value, replacer, space) => JSON.stringify(value, replacer, space)) });
    scope.values.set("Object", { keys: native((value) => Object.keys(value)) });
    scope.values.set("Number", { MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER });
    scope.values.set("Date", { now: native(() => 0) });
    scope.values.set("Promise", { all: native((values) => values) });
    scope.values.set("console", { log: native(() => undefined) });
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node)) { this.statement(node, scope); continue; }
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      let values: Map<string, Value>;
      if (specifier === "node:fs/promises") values = new Map(Object.entries(fs));
      else if (specifier === "node:path") values = new Map(Object.entries(paths));
      else if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const resolved = [target, target + ".ts", target + ".js"].find(item => existsSync(item) && lstatSync(item).isFile());
        if (!resolved) throw this.unsupported(node);
        values = this.load(resolved).values;
      } else throw this.unsupported(node);
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) throw this.unsupported(node);
      for (const element of bindings.elements) {
        const key = element.propertyName?.text ?? element.name.text;
        if (!values.has(key)) throw this.unsupported(element);
        scope.values.set(element.name.text, values.get(key));
      }
    }
    return scope;
  }
}

export function detectComposition(root: string): Composition | undefined {
  const packageFile = path.join(root, "package.json");
  if (!existsSync(packageFile)) return undefined;
  let pkg;
  try { pkg = JSON.parse(readFileSync(packageFile, "utf8")); }
  catch { return undefined; }
  const match = typeof pkg.scripts?.build === "string"
    ? /^bun\s+(?:run\s+)?["']?([^"'\s]+\.[cm]?[jt]s)["']?\s*$/.exec(pkg.scripts.build.trim()) : null;
  if (!match) return undefined;
  const script = path.resolve(root, match[1]!);
  if (!containsPath(root, script) || !existsSync(script)) return undefined;
  if (!/\bBun\.build\s*\(/.test(readFileSync(script, "utf8"))) return undefined;
  const reader = new Reader(root);
  reader.load(script);
  const indexes = [...reader.files.keys()].filter(file => path.basename(file) === "index.html")
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  const index = indexes[0];
  if (!index || ![...reader.files.values()].some(file => "module" in file)) throw new UsageError("Source recipe has no resolvable HTML/module composition");
  const output = path.dirname(index);
  return { script, files: new Map([...reader.files].filter(([file]) => containsPath(output, file))
    .map(([file, value]) => [path.relative(output, file).split(path.sep).join("/"), value])) };
}
