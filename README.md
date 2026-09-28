# Vitality

Vitality turns an already working browser project into a conventional,
unbuilt TypeScript/Vite source project. It is a source giver: it does not
install dependencies, run the source, or create `dist/`.

```text
vitality give --dir "some\path\regex-safe"
```

The command asks:

```text
Public base path [/]:
Inline every imported asset (assetsInlineLimit: Infinity)? [y/N]:
```

It then creates `SOURCE/mywrap` with this shape:

```text
mywrap/
├── index.html
├── src/
│   ├── main.ts
│   └── app/
├── vite.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

If `SOURCE/index.html` does not exist, Vitality searches for nested site roots.
The unique shallowest `index.html` becomes the entry, so repository layouts
such as `docs/index.html` can still be given from the repository root. A root
entry always wins. If two equally shallow candidates exist, Vitality refuses
to guess; point `--dir` directly at the intended site directory. Bun projects
with no unique HTML entry have an additional fallback (see below).

Local ES-module graphs are moved beneath `src/app/`. Detected `.js`, `.jsx`,
and `.mjs` modules become `.ts`, `.tsx`, and `.mts`; their local imports and
HTML entry references are rewritten to the new literal paths. Existing
TypeScript, CSS, JSON, images, framework dependencies, and other runtime assets
remain available to Vite.

Only secondary HTML reachable from the root runtime graph becomes a Vite page
entry. Such pages retain their original routes. Documentation, tests, archived
demos, and orphan `index.html` files are not copied as production pages.
Client-side routers—including React Router—remain ordinary application code and
are not mistaken for filesystem pages.

When ready, the user explicitly runs:

```bash
cd "some/path/regex-safe/mywrap"
bun install
bun run serve
bun run build
```

For a single-page source, the generated production configuration converges to
the normal compact topology:

```text
dist/
├── index.html
└── assets/
    ├── index.js
    └── index.css
```

A genuinely multi-page source additionally emits only its routable HTML pages
and the chunks those pages require. Vitality never mirrors the source repository
into `dist/`.

## Install Vitality

From this checkout:

```bash
bun install
bun run build
bun link
vitality --version
```

`bun link` places the executable shim in Bun's global bin directory. On Windows
that directory is normally `%USERPROFILE%\.bun\bin`, but a Winget installation
of Bun may not add it to `PATH` automatically.

For the current PowerShell session:

```powershell
$bunBin = Join-Path $HOME ".bun\bin"
$env:Path = "$bunBin;$env:Path"
vitality --version
```

To add it to the Windows user `PATH` once:

```powershell
$bunBin = Join-Path $HOME ".bun\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $bunBin) {
  [Environment]::SetEnvironmentVariable("Path", "$bunBin;$userPath", "User")
}
$env:Path = "$bunBin;$env:Path"
```

On Bash-compatible shells, use `export PATH="$HOME/.bun/bin:$PATH"` if needed.

## Public base

The base is written directly to Vite's shared `base` option. Supported forms
include `/`, `/project/`, `./`, an empty base, and absolute HTTP(S) bases. This
is what makes a generated `dist/` suitable for a domain root, a GitHub Pages
repository path, or an embedded relative directory without post-build editing.

## Asset inlining

The inline question controls exactly one Vite option:

```ts
assetsInlineLimit: Number.POSITIVE_INFINITY
```

Answering No leaves Vite's default threshold. Vitality does not implement an
asset registry, Blob protocol, repository copier, or alternate embedding
system. Imported-asset behavior remains Vite's behavior.

When a reachable JSON manifest resolves sibling files by URL at runtime,
Vitality places that minimal relational JSON graph in Vite's ordinary
`public/` directory. This preserves browser URL semantics and the configured
base without turning the rest of the repository into public build output.
Classic non-module scripts use the same path, with `%BASE_URL%` references in
generated HTML. Static-host control files at the selected site root (`404.html`,
`CNAME`, `.nojekyll`, `_headers`, and `_redirects`) are preserved there too.

## Detection and preservation

Vitality:

- treats source paths as literal filesystem paths, never regular expressions;
- refuses to overwrite an existing wrapper;
- publishes through a temporary sibling so a failed conversion leaves no
  partial destination;
- excludes dependency, VCS, cache, coverage, prior-build, docs, and test trees;
- recognizes a unique nested deployment root before applying those exclusions;
- omits `.env*` files;
- preserves the source package's runtime dependencies;
- records displaced `dev`, `serve`, `build`, and `preview` scripts under
  `source:*` names; and
- supplies its own pinned Vite and TypeScript toolchain rather than relying on
  a global or source-local Vite installation.

The source directory is never changed.

## Bun project fallback

Root HTML and unique nested-site detection take precedence, including for
projects with build scripts. Only when those checks cannot choose an entry,
Vitality recognizes a Bun project by its build command, `packageManager`, or
`bunfig.toml`, and preserves its package build recipe. Both Bun evidence and a
build script are required. This supports projects that assemble multiple HTML
inputs, extensions and local TypeScript without changing ordinary conversion.

`give` copies the inputs into `mywrap`, omitting existing build output, caches,
dependencies and secrets. It does not run the builder or require a `dist/`.
Original source paths and configs are preserved; Vitality adds
`vite.vitality.config.ts` and keeps the build command under `source:build`
(or a numbered alias if that name is already taken).

Inside the wrapper, run `bun install`, then `bun run build`, then optionally
`bun run serve`. The manual build runs the preserved builder there and packages
its output for the selected base. The original project is not built or changed.
Output is expected in `dist/index.html`; use `--build-output DIR` if the source
builder writes elsewhere. The wrapper's final output is always `dist/`.

Native compiled modules, workers and URL-loaded assets retain their filenames
and are not re-bundled or inlined. Only literal root URLs naming emitted files
are rebased; API and remote URLs are left alone. The builder also receives
`VITALITY_BASE` and `BASE_PATH`. Dynamically constructed absolute URLs still
need support from the source builder. HTML-only conversion remains unchanged.

## Options

```text
vitality give --dir PATH
  --output PATH
  --base /project/
  --inline yes|no
  --build-output DIR
  --dry-run
```

`--output` defaults to `SOURCE/mywrap`. `--base` and `--inline` skip their
questions when supplied. `--no-inline` keeps Vite's default asset threshold.
No install option exists because generation never installs.

## Verification

```bash
bun run check
bun run test
```

The tests cover literal Windows-safe paths, base normalization, uninstalled
generation, JS/JSX/MJS-to-TypeScript entry mapping, reachable versus orphan
HTML, multi-page routing, source-script preservation, large-asset inlining,
secret exclusion, exact single-page `dist/` topology, transactional output, and
deferred package builds with preserved inputs and deployment-base rewriting.

## License

[GNU Affero General Public License v3.0 only](./LICENSE).
