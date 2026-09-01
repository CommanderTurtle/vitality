# Vitality

Vitality turns an ordinary standalone webapp directory into a self-contained
Vite project without requiring that source project to already use Vite.

```text
vitality give --dir "some\path\regex-safe"
```

The command asks two native terminal questions:

```text
Public base path [/]:
Inline every imported asset (assetsInlineLimit: Infinity)? [y/N]:
```

It then creates `some\path\regex-safe\mywrap`, copies the source into that
wrapper, writes the TypeScript Vite layer, and installs the wrapper's own pinned
toolchain. It intentionally does **not** build `dist/`.

```bash
cd "some/path/regex-safe/mywrap"
bun run serve
bun run build
```

`serve` is the Vite development server. `build` is the explicit production
step and writes `dist/`.

## Install Vitality

From this checkout:

```bash
bun install
bun run build
bun link
vitality --version
```

`bun link` registers the checkout and places its executable shim in Bun's
global bin directory. That directory is normally `~/.bun/bin`, but a Windows
Winget installation of Bun may not add it to `PATH` automatically.

For the current PowerShell session:

```powershell
$bunBin = Join-Path $HOME ".bun\bin"
$env:Path = "$bunBin;$env:Path"
vitality --version
```

To add it to the Windows user `PATH` once and also activate it immediately:

```powershell
$bunBin = Join-Path $HOME ".bun\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $bunBin) {
  [Environment]::SetEnvironmentVariable("Path", "$bunBin;$userPath", "User")
}
$env:Path = "$bunBin;$env:Path"
vitality --version
```

On Bash-compatible shells, use `export PATH="$HOME/.bun/bin:$PATH"` when the
directory is not already present.

Vitality requires Bun for wrapper dependency installation and a Vite-supported
Node runtime (`^20.19.0` or `>=22.12.0`). It ships its own pinned Vite and
TypeScript versions; it does not borrow the target project's global or local
Vite installation.

## Public bases

The base question accepts the same useful deployment forms as Vite, including:

- `/` for a domain root;
- `/project/` for a GitHub Pages-style subdirectory;
- `./` or an empty base for embedded relative deployment; and
- an absolute `http://` or `https://` base.

Vitality normalizes path bases with a trailing slash. The choice is recorded in
the generated `package.json` and `vitality.config.mts`.

## Asset inlining

Answering Yes configures an unlimited imported-asset policy. Ordinary imported
assets—including files larger than Vite's default threshold—are emitted as data
URLs. Vitality preserves addressable HTML, QML, and relational JSON manifests
when inlining them would break child paths loaded at runtime. This is the
correctness exception that lets plugin catalogs such as `plugins/catalog.json`
continue to resolve their sibling descriptors.

Answering No keeps Vite's normal asset threshold.

## Existing and non-Vite projects

For a plain static project, Vitality discovers every HTML entry and retains
files that are fetched or otherwise opened by name at runtime. For an existing
Vite project, it loads the first `vite.config.*` through Vite's public API and
merges it with Vitality's deployment settings. Any conflicting source scripts
are preserved as `source:serve`, `source:build`, and similar names.

The generated build:

- copies no `.git`, dependency, cache, coverage, or prior build trees;
- never places `.env` or `.env.*` files in `dist/`;
- refuses to overwrite an existing wrapper;
- writes through a temporary sibling and publishes only after generation
  succeeds;
- treats command-line paths as literal filesystem values, not regular
  expressions or shell globs; and
- preserves runtime-only files without overwriting assets Vite already built.

## Options

```text
vitality give --dir PATH
  --output PATH
  --base /project/
  --inline yes|no
  --install yes|no
  --dry-run
```

`--output` defaults to `SOURCE/mywrap`. `--base` and `--inline` skip their
questions when explicitly supplied. `--no-inline` and `--no-install` are
available for scripts. Boolean values accept `y/n`, `yes/no`, `true/false`,
`on/off`, and `1/0`.

Run `vitality --help` for the complete command reference.

## Verification

```bash
bun run check
bun run test
```

The tests exercise literal Windows-safe paths, native base normalization,
transactional generation, a live Vite development server, existing-config
merging, nested HTML entries, runtime files, secret exclusion, large-asset
inlining, relational JSON manifests, and real production builds.

Vitality is implemented against Vite's documented
[JavaScript API](https://vite.dev/guide/api-javascript),
[shared `base` option](https://vite.dev/config/shared-options), and
[`build.assetsInlineLimit`](https://vite.dev/config/build-options).

## License

[GNU Affero General Public License v3.0 only](./LICENSE).
