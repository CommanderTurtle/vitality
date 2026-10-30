# Vitality

### Identify and maintain the actual toolchain

`vitality --version` prints the package version, a fingerprint of the compiled
code actually running, and its installed Vite version. Doctor also prints the
resolved CLI path; a version number alone does not identify an older linked
checkout. Generated wrappers record this identity in `package.json`.

```bash
vitality doctor --dir /path/to/mywrap         # read-only: latest stable + audit
vitality doctor --dir /path/to/mywrap --fix   # back up, update Vite, install, audit fix
```

Doctor can target either a generated wrapper or the Vitality checkout itself.
`--fix` selects npm's current stable `vite` release (including a new major),
runs `bun install --ignore-scripts`, then `bun audit fix --ignore-scripts`.
Native Vite plugins/configuration are preserved, but major upgrades may require
their own compatibility changes; run your build afterwards. A registry error,
failed install, unresolved audit, or missing/outdated installed Vite is not a
clean doctor result. Backups live in `.vitality/doctor-*`; nothing is relinked
globally, no source build is run, and deployment output is not regenerated.

New static wrappers use the generator's installed Vite, not an independent
stale pin. Native Vite source wrappers retain their source project's declared
Vite until you explicitly repair them. Updating Vitality never retrofits an
existing wrapper's copied runtime helpers: generate a fresh wrapper for those.

To bypass a suspect global link, run `bun ./dist/cli.js doctor ...` or
`bun ./dist/cli.js give ...` from your freshly built Vitality checkout.

Secondary-page inline scripts use normalized line endings and no trailing
whitespace before their CSP hash is calculated. This keeps the hash valid when
another HTML serializer trims the script text's final newline. The emitted
document URLs still need to be preserved by any downstream packaging layer.

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
Embed URL-loaded files too (no public directory)? [y/N]:
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
to guess; point `--dir` directly at the intended site directory.

For TypeScript projects that assemble HTML through a Bun script instead of
Vite, Vitality can additionally read the script's local file mappings and data
expressions. This runs only when normal entry detection cannot resolve a site.
The source script is never executed, compiled, or retained as a build hook.
Unsupported expressions produce a diagnostic instead of running arbitrary code.
Project-local `fileURLToPath(new URL(..., import.meta.url))` paths are traced
through staged renames; declared module filenames, including `.mjs`, keep their
exact output URLs.

Programmatic Vite library recipes also contribute their declared `build.lib.entry`
and `fileName` mappings when an HTML entry is already present. A consumer's
missing `./library.js` import resolves to that recipe's source entry in every
wrapping mode. Existing source modules take precedence. Only the required path
declarations are read; build commands and preparation callbacks stay unevaluated.

The resulting `mywrap` uses ordinary TypeScript sources and Vite directly, with
the same `--base` and `--inline` options. Local bootstraps and extensions become
Vite module entries; existing URL-loaded vendor graphs keep their public paths.
Their filenames are preserved, while Vite minifies and bundles the editable
module graph and applies the selected inline limit to its imported assets.

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

`--base /comfy/` works on any domain serving that path, including
`https://app.shel.sh/comfy/`. It does not need a separate domain prompt.
Use `--base https://app.shel.sh/comfy/` only when URLs must name that host
explicitly. Supplying `--base` skips the base question.

## Asset inlining

The inline question controls Vite's threshold for ordinary imported assets:

```ts
assetsInlineLimit: file => engineAsset(file) ? false : true
```

Answering No leaves Vite's default threshold for ordinary assets. WASM, TAR,
GZ, DATA and SF2 sidecars remain byte-preserving files in every mode.
`public/` means the local deployment directory; its contents ship in `dist/`.
The n/n path uses the same content-hashed runtime asset names in the main and
worker builds, so shared WASM, module sidecars, and images emit once.

The y/n path also preserves an existing Vite project's source configuration,
plugins, aliases, and public-directory rules. Static-copy plugins keep their
normal output; the wrapper applies the selected base and imported-asset limit.

When a reachable JSON manifest resolves sibling files by URL at runtime,
Vitality places that minimal relational JSON graph in Vite's ordinary
`public/` directory. This preserves browser URL semantics and the configured
base without turning the rest of the repository into public build output.
Classic non-module scripts use the same path, with `%BASE_URL%` references in
generated HTML. Static-host control files at the selected site root (`404.html`,
`CNAME`, `.nojekyll`, `_headers`, and `_redirects`) are preserved there too.

In y/n static-folder wraps, URL-loaded JS/MJS modules, workers, and their local
dependencies retain their public paths. Explicit engine-directory URLs preserve
that directory's files, including WASM. Runtime references follow the selected
base; public module imports retain query strings and work with relative bases.

Unbuilt library recipes retain both their declared JS output names and explicit
local filesystem copies into that output. Vitality reads these declarations,
including finite copy loops, without running preparation or the source builder.
Library source imports use physical paths; runtime resource URLs use the declared
library location. The same layout feeds public and no-public delivery.

Resource handling has three boundaries: discovery/layout (`composition.ts`,
`copy.ts`), browser URL identity (`public-runtime.ts`, `no-public.ts`, native
adapter), and binary emission (`asset-policy.ts`, shared by both embed plugins).
A missing file, a wrong URL, and changed/duplicated bytes are separate failures.

### No-public mode

```sh
vitality give -d "PATH" -b "/comfy/" --inline y --no-public
```

For static projects, `--no-public` (also `--nopublic`) embeds URL-loaded
runtime assets as well. It implies Infinity and cannot be combined with
`--no-inline`. Existing behavior remains the default when it is not selected.

Existing Vite projects retain their source layout and plugins. Direct imports of
`vite-plugin-static-copy` in the entry config are adapted to embed their targets
and transformations; unsupported extra outputs fail explicitly. WASM and runtime
engine sidecars are copied byte-for-byte into `assets/` with content-hashed names;
their import, fetch, and worker references resolve to the renamed files.

The wrapper has `publicDir: false`. Native modules and editable TypeScript enter
the Vite graph; images, fonts, stylesheets, JSON, and other local resources are
embedded as data URLs, except WASM/engine files. Runtime-loaded modules resolve through a lazy import
table. URL-addressed worker scripts are bundled into the payload and exposed as
browser-local Blob URLs. There is no service worker, server, or upstream build
command. All compiling happens inside `mywrap`, when you run Vite yourself.

Classic HTML scripts keep classic scope; their content is inlined, with CSP
hashes when a policy exists. Sources, including notices, remain in the wrapper;
notices and source maps are not deployed as loose assets. The output is
`index.html`, one entry JS asset, optionally one CSS asset, and hashed engine
assets. Referenced helper documents (including in built static sites) retain their routes as self-contained
HTML with their own CSP; they do not enable splitting of the main bundle.
Native Vite wrappers retain hashed entry filenames. The build
fails if an additional file would be emitted instead of silently copying it.

Inlining trades away separate-file caching and lazy network downloads; a large
native frontend will produce a large main bundle. Each referenced helper page
keeps its own document and policy. Unknown URLs retain their original behavior: no-public is
not a replacement for a server API, nor a promise to infer remote resources or
files missing from the detected source graph. Host-specific control files
such as `_headers` and `CNAME` are not emitted in this compact mode.

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

## Options

```text
vitality give --dir PATH
  --output PATH
  --base /project/
  --inline yes|no
  --no-public [yes|no]
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
secret exclusion, exact single-page `dist/` topology, and transactional output.

## License

[GNU Affero General Public License v3.0 only](./LICENSE).
