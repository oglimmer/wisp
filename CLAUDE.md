# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (Electron, `node-pty` and typescript 7 all ship platform-specific native binaries; **never copy `node_modules` between machines/OSes** — reinstall on the target, or you'll get `spawn ENOEXEC`). The `postinstall` hook is load-bearing, see **Packaging & release**.

**Installing from the wrong OS is the one mistake here that escapes the machine you make it on**, so `deps` refuses to. When this repo is mounted into a Linux container from a mac, an install on the Linux side replaces the *host's* Electron bundle and `node-pty` binary, and the damage outlives the container. It is not hypothetical, and the trap is `test` rather than `deps`: **typescript 7's compiler is a native binary** delivered as one optional dependency per platform, so on Linux a mac-installed tree's `tsc` cannot run — which is exactly the "tsc is not runnable, reinstall" case `cmd_test` handles by installing. One `./oglimmer.sh test` in a container was enough. `assert_native_node_modules()` now reads the platform off `electron/path.txt` and node-pty's binary magic and refuses the install with a pointer to `./oglimmer.sh linux`; `./oglimmer.sh linux checks` runs this same static suite inside the mirror, where the tree is the right platform's.
- `npm start` — launch the app (`electron .`).
- `npm run dist` — package a macOS arm64 `.dmg` + `.zip` into `dist/` via electron-builder (macOS host only).

There is no unit-test suite. `./oglimmer.sh test` (also run before `release`)
does the static checks: `node --check` on main.mjs/main/*/preload/renderer/*/scripts/*, an Acorn
unbound-name scan of renderer and main modules (`scripts/check-unbound.js` — catches
missing imports after the module splits, and any module that has dropped out
of the graph reachable from its tree's entry, which never runs at all),
`tsc --noEmit` (see **Types**),
packaging/HTML/cask consistency, yamllint, and shellcheck on `oglimmer.sh` + `scripts/*.sh`.

The *dynamic* half is `./oglimmer.sh linux smoke`, which launches the real app and
clicks through it — see **Testing on Linux**. It is deliberately not part of `test`.

**`.github/workflows/ci.yml` runs that same `./oglimmer.sh test` on every push and pull
request**, so there is no second CI checklist to keep in sync — a check added to the script
is a check that runs on every commit. It asserts yamllint and shellcheck are on `PATH`
first, because the script *warns and skips* when a linter is missing (right for a laptop,
and indistinguishable from a pass in CI). A same-repo pull request is skipped there: the
push that created it already covers the commit, and a check attaches to the SHA, so the
push run's result is what shows on the PR. The smoke test stays out of it — the release
workflow already gates every tag on it.

## Packaging & release

Two published platforms, from one `build` field in `package.json`: **macOS arm64** — signed, notarized,
and the only one the Homebrew cask serves — and **Linux x86_64** as AppImage, tar.gz, deb and a
single-file Flatpak bundle, unsigned because Gatekeeper has no Linux equivalent.
`build/entitlements.mac.plist` (+ `.inherit.`) carry the hardened-runtime entitlements Electron needs
(JIT, unsigned executable memory, library validation off).

**The linux target is x86_64 and nothing else, deliberately.** `linux.target` pins the arch rather
than leaving it to the host, because building for another one is a cross build and node-pty has to be
*compiled* for the target: `@electron/rebuild` fails at node-gyp for want of a cross toolchain, which
is the honest outcome but not a thing to hit on a release tag. It is also why a local
`./oglimmer.sh linux build` overrides the arch to the host's — see **Testing on Linux**. `desktopName`
(top level, read as package metadata) plus `linux.syncDesktopName` is what makes the `.desktop` entry
`com.oglimmer.wisp.desktop` with a matching `StartupWMClass`, which is how a desktop environment
associates the running window with its launcher. The reverse-DNS name is also required by Flatpak.

**App icon.** `build/` is `buildResources`, so the icon lives there. **`build/icon.icns` is the source
of truth** — `mac.icon` points at it, and electron-builder copies a supplied `.icns` into the bundle
verbatim rather than re-rendering it, which is the whole point: no resampling between the artwork and
the shipped app. It carries `icp4`/`icp5`/`ic07`/`ic08`/`ic09` (16/32/128/256/512); there is no `ic10`
(1024), so macOS upscales for 512pt Retina previews — add one if a 1024 render ever exists.
`build/icons/16x16.png` … `512x512.png` and `build/icon.png` (the 512) are *extracted from* the icns
for non-mac use, so regenerate them from it rather than editing them separately. The artwork already
carries the rounded-squircle mask and a transparent margin, so nothing masks or pads it; replacements
should come pre-masked the same way.

`.github/workflows/release.yml` runs on `v*` tags, as **three jobs: `linux` and `mac` in parallel,
`publish` after both**. The `linux` job installs the system libraries (`./scripts/linux-sandbox.sh
libs`) and pinned Flatpak 25.08 runtimes, drops node-pty's foreign prebuilds, builds x86_64, and then
**runs what it built** — `scripts/smoke.js --app dist` drives the packaged binary, then a second run
installs and drives the Flatpak with host git and Claude stubs — before uploading it as a workflow
artifact. The `mac` job does the mac half in parallel (checks the tag matches `package.json`'s
version, builds signed + notarized from repo secrets, verifies the result with `codesign`/`spctl`/
`stapler`) and uploads it. `publish` downloads both and publishes **everything in one `gh release
create`**, then rewrites `version`/`sha256` in `Casks/wisp.rb` on the default branch — that cask is
the tap users install from.

Four things about that shape are deliberate. **Publication is its own job** precisely so the two
builds need not wait for each other: a job that needs a failed job is skipped, so nothing is
published unless both halves built *and* the Linux one launched what it built — which is the gate
`needs: linux` on the mac job used to provide, minus the serialization. Overlapping the two saves
roughly linux's ~6 minutes against notarization's 15–50; what it costs is an artifact round-trip for
the `.dmg`/`.zip`, which no longer stay on the runner that produced them. **One `gh release create`**
means the release never appears half-populated, and **both platforms' assets are located with `find`
rather than by name** — electron-builder spells x64 differently per target (`x86_64` for AppImage),
and the mac assets now arrive through an artifact whose layout is `upload-artifact`'s to decide, so a
hardcoded path would fail at the one moment it must not. **The cask is untouched by any of it** — it
is macOS-only, and Linux has no signing to fail. `publish` runs on Linux (it is only `gh` and a
regex); the mac-only verification already ran in the job that produced the `.dmg`, and the bytes
hashed for the cask are the ones downloaded back and published, not a second copy.

Without signing secrets the mac build still happens, ad-hoc signed instead: a `workflow_dispatch` run
uploads both platforms as CI artifacts, a tag publishes them as a prerelease. Both skip the cask bump,
so `brew install` only ever serves a signed, notarized build. The linux artifact is unaffected either
way, and the prerelease notes say so.

Four packaging-specific gotchas worth remembering:

- **The renderer loads `marked`/`turndown`/DOMPurify/xterm by relative `node_modules/...` path** from
  `index.html`. That works inside `app.asar`, and electron-builder always bundles production
  dependencies, so the `files` allowlist only needs the app's own sources.
- **`node-pty` is the one native module** (the terminal pane's pty), and it needs three things the
  rest of the dependencies don't. It is in `asarUnpack`, because its `spawn-helper` is *exec'd by
  path* and a binary inside an asar has no path. `npm run postinstall` →
  `scripts/pty-permissions.js` sets that helper's executable bit, which node-pty's published tarball
  ships as `0644` — without it every `pty.spawn()` fails with a bare `posix_spawnp failed.`. And the
  `files` list drops the `win32-*`/`darwin-x64` prebuilds, so a mac-arm64 bundle doesn't carry
  foreign Mach-O and PE binaries into notarization. electron-builder rebuilds node-pty from source
  against Electron at package time (into `build/Release`, which node-pty prefers over `prebuilds/`),
  so the packaged app doesn't depend on the prebuild — but `npm start` does. **The linux build has the
  same problem mirrored** and the allowlist cannot express it (a platform-specific `files` entry is a
  second, independent group — see **Testing on Linux**), so `scripts/linux-sandbox.sh prebuilds`
  removes `prebuilds/` outright before packaging, in both CI and a local build.
- **A bundled `.app` launched from Finder gets a bare `PATH`** (`/usr/bin:/bin:/usr/sbin:/sbin`), which
  would make `spawn('claude', …)` fail with `ENOENT` even for users who have the CLI. `claudeEnv()` in
  `main/host.mjs` appends the usual install locations before spawning; extend that list rather than assuming
  the inherited environment.
- **The Flatpak is self-distributed as a single-file bundle, not published to Flathub.** It uses the
  Freedesktop Platform/SDK and Electron BaseApp pinned to 25.08. Wisp needs arbitrary vault access and
  its defining git/Claude integrations, so it deliberately has `--filesystem=host` and permission to
  call `org.freedesktop.Flatpak`. **Together those are a full escape hatch: the app can read the whole
  home directory and run any host program, so the Flatpak is a packaging format here, not a sandbox.**
  `hostCommand()` running only the fixed `git` and `claude` programs is the same convention as git being
  driven only through `spawn('git', …)` — an app-level rule, not a boundary the runtime enforces. It is
  also why this is self-distributed: Flathub would not accept these permissions. Keep the
  installed-Flatpak smoke run when changing this boundary — a
  bundle can launch perfectly while all three host-process paths are broken. **`PATH` is the one
  variable that cannot be forwarded across it**: inside the sandbox it describes the sandbox
  (`/app/bin:/usr/bin`), so passing it on *replaces* the host session's own — `git` still resolves from
  `/usr/bin` and so does a smoke stub in one of `cliPathExtras()`' locations, which is why a test cannot
  see this, but a `claude` installed through nvm, mise or pnpm stops resolving in the Flatpak while the
  AppImage finds it. `hostSearchPath()` reads the host's PATH once (memoized — `runGit` runs on every
  tree refresh) and appends `cliPathExtras()` to *that*; no answer means no `--env=PATH` at all, leaving
  flatpak-spawn to resolve against the host's own.

## Testing on Linux (the sandbox mirror)

Linux x86_64 is a published target (see **Packaging & release**), and the app also runs on whatever
arch the sandbox happens to be, which is what makes containers usable: `./oglimmer.sh linux smoke`
launches the real app headless and clicks through it, `./oglimmer.sh linux verify` does the same to a
*packaged* build. `scripts/linux-sandbox.sh` is the whole of it, and CI reuses three of its steps
(`libs`, `prebuilds`, and `smoke.js` itself) so the runner and the sandbox cannot drift.

**The rule it exists to enforce: the two platforms never share a `node_modules`.** The repo is
normally checked out on the mac that builds it and bind-mounted into the container, so a `npm
install` on the Linux side would overwrite the mac's binaries *outside* the sandbox, where the
damage survives everything. Only two dependencies are platform-specific — `electron/dist` (an
`Electron.app` bundle vs an ELF executable) and `node-pty` (a Mach-O vs an ELF `.node`, plus its
`spawn-helper`); marked, turndown, DOMPurify and xterm are pure JavaScript. So the script keeps a
second tree at `$WISP_LINUX_DIR` (default `~/.cache/wisp-linux`): the sources mirrored on every
run, with a linux `node_modules` of its own that the repo never sees. `./oglimmer.sh linux status`
prints both.

- **The mirror is a copy, not symlinks into the repo.** Node resolves a module's realpath, so a
  symlinked main-process module would report its real directory back inside the repo — the
  `app://` scheme would serve from there and `import('node-pty')` would find the mac's binary. And `index.html` loads
  marked/turndown/xterm by relative `node_modules/...` path, so whatever directory Electron is
  pointed at has to own its own. The sources are ~2MB, so the copy is free.
- **git decides what a source file is**: `git ls-files --cached --others --exclude-standard`, so a
  module that hasn't been added yet is still tested, and the gitignored `node_modules`/`dist` can
  never be swept in. The mirror's own `node_modules` and `dist` survive a sync — they're the
  expensive part.
- **Four things the sandbox needs that a desktop doesn't.** Electron links GTK, which an image
  built for headless Chromium doesn't carry (`ensure_system_libs` installs the eight libraries, or
  says which are missing); there is no display, so everything runs under `xvfb-run -a`;
  `chrome-sandbox` isn't setuid in a container, hence `--no-sandbox`; and `--user-data-dir` points
  the config and `localStorage` at the mirror so a smoke run can't disturb an interactive one.
- **Two install quirks are handled explicitly rather than trusted.** Electron's own postinstall
  doesn't reliably land the binary here — the package installs but `dist/` is absent — so the
  script runs `node node_modules/electron/install.js` and checks. And node-pty publishes darwin and
  win32 prebuilds only, so npm builds it from source into `build/Release`; because it is N-API, the
  binary node-gyp produced against Node loads under Electron unchanged, which is the same property
  the mac path relies on.

**`scripts/smoke.js` is the dynamic half of `test`, which is otherwise entirely static.** Playwright
drives the actual app against a throwaway vault and asserts the things only a running window can
show: the vault reopens from `config.json`, the tree renders, Preview renders marked's GFM through
DOMPurify, the Editor pane is live and turndown loaded, a Raw edit reaches disk through the autosave,
a pasted `data:` image is imported into `images/` and referenced rather than inlined,
frontmatter is shown verbatim instead of as a heading, the git bar hides itself for a plain folder,
the sidebar's recency list comes back flat with the note this run just edited at the top, and node-pty
spawns a pty that streams `claude`'s output back over the bridge. **The fold has four
checks of its own** — after typing into the Editor pane, the table must come back with its original
padding, `snake_case` must not have grown a backslash, and the heading must be untouched; then a second
edit *inside* a bullet list must leave every other line of it byte-for-byte, which is the one case where
turndown does run over lines nobody edited — because "only the edited block is rewritten" is exactly what
no static check can see. It screenshots each pane on the way through.

**The reading position has five checks of its own**, for the same reason: whether a view switch lands in
the right place is a question about laid-out geometry, which nothing static can answer. Against a note
longer than the pane, Raw → Preview → Raw must come back to the same scroll offset *and* caret, Raw ↔
Editor must put the caret in the paragraph it was in (by line, checked both ways against the fixture),
and Preview → Editor must keep the same block at the top. The **diff** pane's half is not covered there —
the smoke vault is deliberately not a repository — so it is worth driving by hand after touching
`positions.js`: with a repo vault, Raw at the top opens the diff at the top, and scrolling the diff to a
row then leaving for Preview lands on the paragraph that row's line belongs to.

**The terminal's resize behaviour differs between the two Linux artifacts, and only the weaker half is
asserted.** The smoke run checks that the pty survives a resize, because under Flatpak the TUI does not
reflow and cannot: `term-resize`'s TIOCSWINSZ signals the foreground process group of the pty's session,
and `flatpak-spawn --host` started `claude` in the host's PID namespace, so it is not that group.
Measured, against an in-sandbox control that does receive the signal — flatpak-spawn has no signal
forwarding and `--share-pids`/`--expose-pids` do not apply to `--host`. The size itself is read correctly
through the forwarded fd, so a session opens at the right size; only later resizes go unnoticed. In the
AppImage, tar.gz and deb builds `claude` is spawned directly and reflows normally, so this is a
Flatpak-only caveat to state rather than a bug to chase.

Playwright is deliberately **not** a dependency: its postinstall downloads browser engines that
every `npm install` on a dev machine would pay for, and `_electron.launch()` uses the app's own
Electron rather than any of them. The mirror installs it with `--no-save`, which is also why
`tsconfig.json` excludes `scripts/smoke.js` — `require('playwright')` resolves there and nowhere
else. `./oglimmer.sh test` still parses it.

**`linux build` and `linux verify` build for the host's architecture, not x86_64.** node-pty has to be
compiled for the target and there is no cross toolchain in a sandbox, so an x64 build on arm64 fails at
node-gyp; the arch is overridden to the host's and the published artifact comes from CI. What a local
build proves is the packaging config and the app inside it, which is the part that breaks.

**One electron-builder gotcha, earned the hard way: a platform-specific `files` list does not narrow
the top-level one, it adds a second, independent group** — and a group containing only negations means
"everything". Adding `linux.files: ["!…/prebuilds/darwin-arm64"]` to keep node-pty's Mach-O out of a
linux bundle therefore packaged `CLAUDE.md`, `Casks/`, `oglimmer.sh` and the smoke screenshots into it.
So there is **one** allowlist, at the top level, for both platforms — repeating it per platform would
put the *signed* list one edit away from drift, and `test`'s packaging check only knows about one — and
the platform-specific removal happens in the script instead (`drop_foreign_prebuilds`, run from both
`linux build` and CI). Worth knowing that the trap only shows up on a **fresh** tree: `@electron/rebuild`
deletes `prebuilds/` when it rebuilds node-pty from source, so the second build of a mirror looks clean
while CI's checkout never is.

## Architecture

Wisp is a single-window Electron app: a folder/file tree on the left, an editor on the right. Every text file is treated as Markdown. For Markdown files the editor pane offers a three-way view toggle (`viewMode`, persisted in `localStorage`): **Raw** (the plain-text source in a `<textarea>` — the canonical, always-available mode), **Editor** (a `contenteditable` WYSIWYG view), and **Preview** (read-only rendered Markdown). Non-Markdown files are always edited raw.

The whole app is built around Electron's **three-context security model**, and understanding the boundary between the contexts is the key to working here:

- **`main/` (main process, Node.js)** — owns all filesystem and OS access. Every filesystem operation lives here as a handler (`read-tree`, `read-file`, `write-file`, `create-file`, `create-folder`, `delete-path`, `rename-path`, `move-path`, `read-reminders`, `write-reminders`), plus git (`git-info`, `git-pull`, `git-commit`, `git-diff`, `git-revert` — the only place `git` is ever spawned), the terminal pane's pty
  (`term-start`, `term-input`, `term-resize`, `term-stop` — the only place a *process* is spawned
  interactively), watching the vault (`watch-vault`), folder picking (`choose-folder`), revealing an entry in the
  OS file manager (`reveal-path`) and config. The renderer has **no direct fs access** — anything touching disk must be added as a handler here.
- **`preload.js`** — the only bridge between the two worlds. Runs with `contextIsolation: true` / `nodeIntegration: false` and exposes a minimal, hand-listed API on `window.api` via `contextBridge`. A new main-process handler is invisible to the UI until a corresponding method is added here.
- **`renderer/` (renderer, browser context)** — all UI logic and state, split into ES modules with
  `renderer/index.js` as the entry point (see **The renderer's modules**). Talks to disk **only**
  through `window.api.*`, which it gets from `renderer/api.js`. It never `require`s Node modules.

So adding any file operation is always a three-file change: handler in a `main/` module → method in `preload.js` → call in a `renderer/` module.

### The main process's modules

The main process grew past the point where one file was reviewable, so it is split the same way
the renderer is: plain ES modules (`main/*.mjs`), no build step, one graph from `main/index.mjs`.
The root `main.mjs` is only the entry package.json points at — it forwards to `main/index.mjs`.
The `.mjs` extension, not `"type": "module"`, carries the module kind: preload.js and scripts/
stay CommonJS (a sandboxed preload cannot be ESM), and `.mjs` also marks "Node context" against
the renderer's browser-context `.js`. Handlers register at module load, exactly as they did when
they were sections of the old main.js — `main/index.mjs` imports each module once for that side
effect, and `scripts/check-unbound.js` fails the build on any module nothing imports (an
un-required module means missing IPC handlers — exactly what used to be impossible in one file).

| | |
|---|---|
| `index` | the entry: imports the rest (protocol first — its privileged-scheme registration must evaluate before `ready`), then the `whenReady` wiring; `killPty` is injected into `createWindow` here, which is what keeps `window` and `terminal` from importing each other |
| `ipc` | `handle()` — the generic wrapper every handler registers through, typed against `IpcHandlers` in `types/ipc.d.ts` (see **Types**) |
| `guards` | the path/size guards: `vaultPath`/`assertInsideVault` (the traversal guard that throws), `isInside`, `assertReadableFile`, `assertTextContent`, the byte caps |
| `config` | `config.json` persistence (last folder, window geometry) |
| `host` | Flatpak/PATH/env helpers (`hostCommand`, `hostCliEnv`, `claudeEnv`) — how a build running in a sandbox still reaches the host's git and claude |
| `protocol` | the `app://` scheme (registered at load time), serving the app's own directory and nothing else |
| `tree` | `isIgnored`, `buildTree` (one walk feeds the tree and the recency list), the `read-tree` handler |
| `refs` | Markdown refs: resolve (note-relative then vault-root) and `updateRefsAfterMove` — keeping every note's refs true across a move |
| `window` | the one window (geometry persistence, the menu, `sendToWindow`), plus the shell/dialog handlers: `choose-folder`, `get-last-folder`, `open-external`, `reveal-path` |
| `vault` | the CRUD handlers: read/write/create/delete/rename/move |
| `reminders` | the vault-root `.wisp-reminders.json` read/write |
| `watch` | `fs.watch` the vault, debounced, own writes suppressed via `noteOwnWrite` |
| `terminal` | the one pty session (`node-pty`, lazily imported), `killPty` |
| `git` | everything git: `runGit`, porcelain parsing, info/pull/commit/revert/diff |
| `images` | the image read/import handlers and the MIME table |
| `claude` | the one-shot `runClaude` and `readClaudeJson` — the CLI spawn and the reading of its reply, shared by all three Claude features |
| `smart` | the prompts, file gathering, sanitizers and the four handlers: smart-check/apply/lookup and analyze-image |

Traffic runs the other way for the app menu (see **Keyboard shortcuts help**), the terminal pane's
output and the vault watcher — and each crosses the same bridge: `webContents.send` in main, an
`ipcRenderer.on` subscription hand-listed in preload, a callback registered in the renderer. Preload
passes the payload on but never the event object, which carries a handle on the sender.

### The renderer's modules

`renderer/` is plain ES modules — no bundler, no build step. `index.html` loads
`renderer/index.js` with `type="module"` and the browser fetches the graph.

**This is why the window is served from a custom `app://` scheme rather than `loadFile()`.**
Chromium refuses a `<script type="module">` on a `file://` page: module fetches go through CORS
and a `file://` origin is opaque. So `main/protocol.mjs` registers `app` as a **standard, secure** scheme
(`standard` is what gives it real origin semantics — relative URLs resolve, and `localStorage`
works) and `protocol.handle` serves the app's own directory, refusing anything that resolves
outside it. Content types are stated rather than guessed, because a module script that doesn't
arrive as JavaScript is refused by Chromium's strict MIME check. `marked` and `turndown` stay
**classic** scripts so their globals exist synchronously; a module script is deferred, so the
renderer always runs after them.

*One-time cost of that move: `localStorage` is keyed by origin, so the view mode, diff mode and
the four divider positions reset once on the upgrade from a `file://` build. There is no way to
read the old origin's storage to migrate it.*

The modules, roughly bottom-up — `api`, `state`, `dom`, `util`, `lcs` and `dialogs` depend on
little or nothing; `index` depends on everything:

| | |
|---|---|
| `api` / `state` / `dom` | the preload bridge; shared mutable state; every element ref |
| `util` / `lcs` | `setStatus`/`relativePath`/`cssEscape`; the LCS core (lines *and* words) |
| `dialogs` | `openModal`, `dialogOpen`, `promptModal` |
| `markdown` | marked + DOMPurify one way, turndown + the GFM inverse rules + the block-level fold the other; the pipe-table syntax both panes share |
| `views` / `editor` / `tables` / `format` / `find` | the editor pane, its buffer, tables, block formatting, find & replace |
| `positions` | the per-file caret and per-pane scroll offsets |
| `tree` / `app` / `layout` | the file tree + the recency list + context menu; opening a vault; the dividers |
| `git` / `git-commit` / `diff` | status and pull; commit and discard; the diff view |
| `reminders` / `reminders-ui` | the model and the date maths; the grouped list and its editor |
| `smart` / `images` / `shortcuts` | Claude-backed filing and lookup; image import; the help list |
| `terminal` / `watch` | the `claude` pane; re-reading the vault when it changes underneath |
| `index` | wires the UI up, then calls `init()` |

Two things about module state are load-bearing:

- **An exported binding is read-only to importers.** `export let gitState` can be read live from
  anywhere but assigned only inside `git.js`. That is why the six values *more than one module
  writes* — `baseFolder`, `currentFile`, `dirty`, `viewMode`, `diffMode`, `diffOnlyFile` — live on
  the mutable object in `state.js` instead: `state.currentFile = x` works from anywhere. Everything
  else stays in the module that owns it. When another module needs to clear owned state, it calls
  an exported reset (`resetGitState`, `resetSmartPanel`) rather than assigning
  across the boundary — which would not even compile.
- **The graph has cycles and that is fine**, because nothing calls across one during module
  *evaluation*: cross-module calls all happen inside functions, and function declarations are
  hoisted before any module body runs. What would break is top-level code reaching into a cyclic
  dependency — so `init()` is called at the **end of `index.js`**, not where it used to sit at the
  top of the startup section. Under the old classic script hoisting made that work; under modules
  it would run before the other modules had wired themselves up.

### Types

The app is plain JavaScript and stays that way — there is no build step, and the `.js` files
Electron and the browser load are the files in the repo. Types are **JSDoc annotations checked by
`tsc --noEmit`**: `tsconfig.json` is `allowJs` + `checkJs` + `noEmit`, so TypeScript reads the same
sources and emits nothing. `./oglimmer.sh test` runs it; `npx tsc --noEmit` runs it alone.

**`types/ipc.d.ts` is the IPC contract, and it is the point of the exercise.** Adding a filesystem
operation is a three-file change — handler in a `main/` module, method in `preload.js`, call in a
`renderer/` module — and nothing else checks that the three agree. Each channel's signature is
declared there once and referred to from all three sides:

- `handle()` in `main/ipc.mjs` is **generic over `IpcHandlers`**, so the channel name types the callback's
  parameters *and* its return value. A handler that answers with a shape the renderer isn't expecting
  fails at its own registration.
- the object `preload.js` exposes is annotated `@type {WispApi}`, so a method that is missing,
  misspelled or wired to the wrong channel is an error there rather than an `undefined` the renderer
  trips over at runtime.
- `window.api` is declared as `WispApi`, so every renderer call site is checked — including the
  `{ ok }` **narrowing**: reading `res.content` without first checking `res.ok` doesn't compile.

Two settings are deliberate. **`strictNullChecks` is on and not optional** — without it TypeScript
doesn't narrow `if (!res.ok)`, which is the whole reason for typing the bridge. **`noImplicitAny` is
off**, so un-annotated parameters are checked where they can be rather than reported line by line;
turn it on a file at a time if it ever earns its keep. `strict` as a whole is not on.

Two conventions follow from the boundary itself. `baseFolder` is `VaultRoot` (`string | null`)
throughout, because the renderer passes `state.baseFolder` straight through and every handler is
already written for the null case — typing it `string` would only push a guard main already has into
25 call sites. And **`renderer/dom.js` states what each id actually is** (`btn`/`input`/`textarea`/
`img` helpers), which is what makes `editorEl.value` and `viewRawBtn.disabled` checkable everywhere
else; change a tag in `index.html`, change the helper there.

### Conventions that matter

- **Divider positions restore late, on purpose.** All five drag handles persist to `localStorage` (`rawNotes.sidebarWidth` / `inputHeight` / `previewHeight` / `remindersHeight` / `terminalHeight`). The sidebar width clamps against constants so it restores immediately, but each *row* divider clamps its saved height against its container's measured height — and `#workspace` is `display:none` until a folder opens, where every measurement reads 0. So `makeRowDivider()` registers a restore step instead of applying one, and `restoreRowDividers()` runs them from `openFolder()` once the workspace is on screen. Restoring any earlier clamps every panel to its minimum and throws the stored layout away.
- **Handlers are registered through `handle()`, not `ipcMain.handle` directly.** It wraps the call in
  the try/catch that turns a thrown error into the `{ ok: false, error }` every handler already
  answers with, so the renderer has one way to read a result and no handler can reject. The few that
  return a bare value rather than an `{ ok }` envelope (`get-last-folder`, `choose-folder`,
  `read-tree`, `open-external`) stay on `ipcMain.handle`, and the synchronous
  `write-file-sync` is an `ipcMain.on` because it answers via `e.returnValue`.
- **Path-traversal guard.** Any handler taking a target from the renderer resolves it through
  `vaultPath(baseFolder, target)`, which refuses anything outside the vault. It **throws** rather than
  returning a value — `handle()` turns that into the usual `{ ok: false }` — so the guard can't be
  written and then accidentally ignored on the success path. It takes relative and absolute targets
  alike. `isInside()` underneath is still used directly where the question is a test rather than a
  guard (which files a discard covers, whether a path is worth showing relative).
- **The tree is rebuilt, not mutated.** After any change, the renderer calls `refreshTree()` which re-reads the whole tree from the main process and re-renders from scratch. Expanded-folder state is preserved separately in the `expanded` Set (keyed by absolute path), not in the DOM. Two things a rebuild would otherwise throw away are put back explicitly: the sidebar's scroll offset (emptying it collapses its height, so the reader would be sent to the top) and the open file's `active` row, whose class went with the element the click put it on.
- **Persistence.** The last-opened base folder and the window's last geometry (`window`: bounds + `maximized`/`fullScreen`) are stored in `config.json` under Electron's `userData` dir (not in the vault). Geometry is saved debounced on move/resize and flushed on `close`; on restore the size is always reused but the *position* only if the frame still overlaps a live display, so unplugging a monitor can't strand the window off-screen. The window is created with `show: false` and maximized/fullscreened before `show()` so it doesn't visibly jump. Note contents are plain files in the user's chosen folder — there is no database or index.
- **Reading positions are captured continuously, not on close.** `renderer/positions.js` remembers where the reader is in each file under `rawNotes.positions:<vault>`, LRU-capped, keyed by vault-relative path. It records off the panes' own `scroll`/`selectionchange` events rather than at the moment a file closes, which is what lets **`applyView()` restore too**: a view switch re-renders the Preview/Editor panes from scratch (and a hidden pane loses its scroll anyway), so without it every toggle would bounce the reader to the top. **A file with no remembered position is explicitly put back at the top**, not left alone: assigning `editorEl.value` parks Chromium's caret at the *end* of the text, so doing nothing opens every new file at its bottom. `restorePosition()` runs *after* `focus()` in `openFile()` and `setViewMode()` (focusing scrolls the caret into view, undoing a restore that ran before it) and *before* `refreshFind()` in `applyView()` (an open find bar's match should win). Since `hydrateImages()` resolves pictures asynchronously, a pane holding them lays out short and clamps the restore — so the requested offset is re-applied on each image `load` (capture phase; `load` doesn't bubble) until it fits or the user scrolls somewhere themselves.
- **What is remembered is a place in the *source*, not a scroll offset.** The four panes lay the same file out completely differently, so one offset would be four different places in it and a per-pane offset means switching views lands wherever that pane was left — which for a pane you have not opened yet is the top. So the position is a **fractional source line** for the top of the viewport plus a **line/column caret**, and each pane maps into and out of its own geometry: the textarea through a measured mirror (it soft-wraps, so a line's position cannot be derived from a line height — hence `.text-metrics`, which shares the textarea's typography rule), the rendered panes through `blockLineRanges()` (marked's tokens carry their `raw`, so counting newlines while walking them says which lines each top-level child came from — no rendering, unlike the fold), and the diff through the working-tree line each row carries in `data-line`. A pane whose children don't line up with the ranges (WYSIWYG edits not yet folded back, an `html` block that rendered as several elements) is mapped by proportion instead.
  - **Each pane's exact offset is kept alongside the anchor**, stamped with the anchor it was recorded against (`seq`). A pane still matching the anchor is restored to its own offset byte-for-byte; only a pane the reader has since moved away from is mapped. That is what makes Raw → Preview → Raw come back to the same pixel *and* caret while Raw → Preview lands on the paragraph being read — mapping in both directions would drift, since a rendered block is coarser than a line. A restore that *cannot* map (the diff's rows don't exist until git answers) deliberately leaves the pane stale, so `renderDiffPane()` restoring again once they do still maps.
  - **Working the line out is deferred to `syncAnchor()`**, called from `setViewMode`, `openFile`, `openFolder` and `flushPositions` — measuring a pane needs it on screen (a hidden textarea has no width to wrap at), so it has to happen *before* the switch, not when the position is captured. It runs after the WYSIWYG fold, so the lines are the buffer's.
  - **A restore's own scroll and selection events are suppressed** (`appliedTop` / `appliedSelection` / `appliedCaret`, compared against the live values, since the events arrive a frame later). Treating them as the reader moving would bump the anchor's stamp on every view switch, and every pane would then be mapped rather than restored exactly.
  - **The caret is the lossy part, and only across panes.** A rendered block carries neither the markers nor the markup of its source lines, so the *line* crosses reliably and the column only as far as the line's own marker allows. Exact in Raw. Scrolling the Preview or the diff moves the reader, not the cursor, so those carry the caret through unchanged rather than dragging it to wherever the scroll ended up.
- **Ignored entries.** `isIgnored()` in `main/tree.mjs` hides every dot-prefixed entry (`.git`, `.DS_Store`, other editors' per-vault config folders, `.wisp-reminders.json`) plus the explicit `IGNORED` set (`node_modules`) during tree building — and, because `gatherFiles` calls the same helper, keeps them out of the smart-insert prompt too.

### The sidebar's two views (tree / recent)

The same files, two ways: the **folder tree**, or a **flat list of every file, most recently changed
first**. A two-button toggle above the tree switches them (`rawNotes.treeMode` in `localStorage`, so
the choice survives a restart). The tree answers "what is in this folder"; the recency list answers
"what have I been working on", which the tree cannot show at all — the note changed a minute ago is
wherever it happens to live, quite possibly inside a folder that is collapsed.

- **One tree read feeds both.** `buildTree()` in `main/tree.mjs` puts an `mtime` (epoch ms, `0` if it
  couldn't be stat'd) on every **file** node, read during the walk it is already doing rather than in
  a second pass. `refreshTree()` then either renders the nested tree or flattens the same children,
  sorts by `mtime` descending, and renders rows — so there is no second channel and no second model.
  The name is the sort's tie-break, because two files written in the same millisecond (a checkout, a
  copied folder) would otherwise swap places on every rebuild.
- **Folders are flattened away, not listed.** A folder's own mtime answers a different question —
  something was added to it, or removed — and "what did I change" is a question about notes.
- **Both views render the same `.node-row[data-path]` row** (`makeRow()`), which is what makes the
  recency list a *view* rather than a second widget: the git decorations, the drag & drop, the context
  menu, the active-file highlight and every `querySelector` by path elsewhere in the app all key off
  that row and work unchanged in either. What the flat row adds is the two things it has to say for
  itself — the folder the file sits in (there is no indentation to say it) and how long ago it changed.
  The folder span is the element that *grows*, always present even when empty, which is what keeps the
  time (and the git badge after it) pinned to the right edge.
- **A save re-sorts the list, in recent mode only.** Nothing else rebuilds the tree for a save — and in
  tree mode nothing needs to, since a save moves nothing — but the recency list is ordered by exactly
  what a save changes, so `scheduleRecentRefresh()` hangs off `saveCurrent()` beside
  `scheduleGitRefresh()`, debounced for the same reason. It is also why the rebuild restores the
  sidebar's scroll and the active row: in this mode it happens while the user is typing.

### View modes / WYSIWYG editor

The `<textarea>` (`editorEl`) holds the **canonical buffer** and is what gets saved — the other two panes are projections of it. `applyView()` shows exactly one pane for the active `viewMode`; `renderMarkdown()`/`renderWysiwyg()` reproject `editorEl.value` into the Preview/Editor panes on entry.

The WYSIWYG **Editor** pane is a `contenteditable` div. `marked` renders the source into it (Markdown→HTML); **turndown** (`node_modules/turndown`, loaded as a UMD global `window.TurndownService`) does the reverse on save. The key invariant: **edits only fold back to the buffer through `syncWysiwygToEditor()`, and only when `dirty`** — so a file the user merely *viewed* in Editor mode is never rewritten by turndown's normalisation (round-tripping is inherently lossy on formatting, so this guard matters). `saveCurrent()`, the pre-switch step in `setViewMode()`, drag & drop, and `beforeunload` all fold back through it before touching disk. If turndown fails to load, the Editor button is hidden and the mode degrades to Raw (edits could otherwise not be saved). Image round-trip: `hydrateImages()` stashes the original vault-relative path in `data-md-src` before swapping in the data URL, and a turndown `img` rule re-emits that path instead of the inlined base64.

**The fold is reconciled block by block, and that is what keeps a WYSIWYG edit from rewriting the whole
file.** Markdown → HTML → Markdown is lossy on *syntax*, not only on the GFM the inverse rules restore:
the DOM does not record whether a heading was `#` or underlined, which of `-`/`*`/`+` a bullet used,
where a paragraph's source lines were wrapped, how a table's columns were padded, or whether a bare URL
was written as one — and turndown escapes anything that could be read as markup, so `snake_case` comes
back as `snake\_case`. Handing it the whole pane therefore rewrote *every* block on the first keystroke,
which the 400ms autosave then put on disk: a whole-file diff that reads exactly like data loss even
where nothing was lost. So `foldToMarkdown()` re-renders each block of the **old source** on its own and
matches it, by canonicalised HTML, against the blocks now in the pane (`lcsOps` over the signatures, the
same LCS core the diff view uses). A block that still renders to what the pane holds is emitted as **its
original bytes**; only genuinely edited or new blocks go through turndown.

Five things make that safe to run over a whole note:

- **Every byte of the source is in exactly one block, and it's asserted.** Blocks come from
  `marked.lexer`, whose tokens carry `raw` — so `prefix` plus every `raw` must equal the body, or the
  fold refuses to run. A byte in no block would be a byte dropped from every save.
- **What the pane can't show is never compared.** A block that renders to nothing — a link definition, a
  comment DOMPurify strips — is *hidden*: it rides along verbatim rather than being matched against a
  pane node that was never there (and so deleted). Blank lines are hidden too, but held back as the
  pending separation, so deleting a block doesn't leave the separators from both its sides behind.
  Definitions are also in scope when each block is rendered, which is what keeps `[text][ref]` matching
  instead of being rewritten inline.
- **A new block is only separated where it has to be.** An edited block is emitted as an addition, so
  where the source had no blank line before it (a list right under its heading) the fold used to insert
  one — a change to a line nobody edited. `stillSeparate()` asks marked instead: the blank line goes in
  only if the previous block would otherwise swallow the new one as a lazy continuation. No marked, a
  lexer error or a `prev` that isn't one block all answer "not separate", which keeps the blank line.
- **Nothing inline is skipped.** `paneBlocks()` groups stray top-level text and inline elements — what a
  contenteditable can leave behind — into one paragraph. A skipped node is an edit thrown away.
- **Every uncertainty falls back to turning the whole pane down**: no marked, an unparseable buffer, an
  LCS table over `FOLD_MAX_CELLS`, a pane that folded to nothing. That is the old behaviour — reformatted
  but complete. The fallback may never be "drop the edit".

**A block that *does* go through turndown is written the way this app writes Markdown.** Four narrowings,
because "only the edited block is reformatted" is worth little if that block comes back mangled — and a
block can be a whole list or a whole table, so what turndown does to the lines *around* the edit is
exactly as visible as what it does to the edited one:

- **`narrowEscape` replaces turndown's escape table.** Stock turndown escapes every `*`, `_`, `[` and `]`
  in a text node unconditionally, so it answers with `5 \* 3`, `snake\_case`, `\[\[WikiLink\]\]` — none of
  which was markup, and none of which *can* become markup. Each is now escaped only where it would
  re-parse: `*` where it flanks a word or opens a line, `_` where it isn't inside a word (which is exactly
  CommonMark's own rule, and what makes `snake_case` safe), `[` only where a `]` follows with `(`/`[`/`:`
  behind it — and never `[^`, which is a footnote marked doesn't render. `]` needs no escape at all once
  the opening bracket has one. The line-anchored rules are turndown's own.
- **A bare URL stays bare.** It is a link only because marked speaks GFM; turndown answered `[url](url)`,
  growing a link out of text nobody wrote as one. The `bareLink` rule re-emits it as itself.
- **A list item opens with one space after its marker.** Stock turndown writes `-   item` (marker plus
  *three* spaces, `1.  ` for ordered), which nothing writes by hand — so editing one bullet rewrote the
  marker of every bullet in the list, since a whole list is one block. The `listItem` rule is turndown's
  own with the prefix narrowed to `- ` / `1. `, the continuation indent following the marker's width (so a
  nested list or a wrapped paragraph stays attached to its item), and blank lines left un-indented rather
  than padded out with trailing spaces. What it can't recover is *which* marker the source used: an edited
  `*` list still comes back as `-`.
- **Tables are re-padded through `formatTable`**, the Raw pane's own formatter — turndown emits
  `| a | b |` with no padding, so without it a one-cell edit rewrote every line of the table. This is why
  the pipe syntax (`splitRow`, `isDelimiterRow`, `parseTable`, `formatTable`) lives in `markdown.js` and
  `tables.js` imports it: one formatter, so the two panes can't drift into writing tables differently.

`canonicalHtml()` is what makes the comparison meaningful: marked's string and the live pane's own
serialization are both round-tripped through a detached element, and `hydrateImages()`' swaps are undone
(`data-md-src` back into `src`, the not-found marker off) so a resolved picture doesn't read as an edit.

**Frontmatter is split off before rendering and re-attached byte-for-byte.** marked has no idea what a
leading `---` block is: it reads one as a thematic break plus a setext heading, so both panes showed a
bogus heading at the top of the note — and the fold then wrote *that* back, turning the block into
`## title: … tags: \[…\]` permanently. `splitFrontmatter()` takes it off the front, `frontmatterNode()`
shows it verbatim in a `contenteditable="false"` `<pre>` (the buffer keeps the canonical copy, so an edit
made there could only be discarded — Raw view is where it's edited), a turndown `remove` rule drops the
node, and `foldToMarkdown()` puts the original text back on. It is also the one thing the fold restores
in the *fallback* path, so a frontmatter note is safe even when reconciliation bails.

**Tab types, it doesn't move focus.** Both editing panes take Tab over from the browser's focus
navigation: in Raw it inserts a tab, or indents/outdents (⇧) every line a multi-line selection touches;
in the Editor it nests/un-nests the list item the caret is in, and inserts a tab elsewhere. Every edit
goes through `document.execCommand('insertText', …)` rather than assigning `editorEl.value` — that
keeps the textarea's native undo stack and fires the `input` event the autosave clock hangs off.
`indent`/`outdent` are formatting commands rather than input, so the WYSIWYG path calls
`markBufferEdited()` itself.

**marked speaks GFM, turndown only CommonMark** — so anything GFM adds needs an explicit inverse rule
(`addGfmRules()`) or a WYSIWYG save silently destroys it: a table flattens into one paragraph per cell,
`~~strikethrough~~` and `- [ ]` checkboxes come back as bare text. Tables are the fiddly one. Cells emit
their own leading `|` and the row closes the last, so the pipes never depend on a cell's index among
sibling nodes — a contenteditable row can hold whitespace and stray nodes between its cells. The heading
row also emits the delimiter row (a GFM table *is* its delimiter row) carrying each column's alignment
from the `align` attribute marked wrote. Inside a cell, a literal `|` is escaped and a line break becomes
`<br>`, because a cell is one line of a pipe-delimited row and either would end it early. A table with
**no** heading row can't be expressed as GFM at all, so it's `keep`-ed as HTML rather than flattened.

### Tables

Five shortcuts, off the same window-level `keydown` listener as `⌘S`: `⌘⇧T`/`Ctrl+⇧T` inserts a 3×3
table (a heading row plus two body rows), and `⌘⌥`/`Ctrl+Alt` + an arrow grows the table the caret is
in by a row or a column in the arrow's direction. `runTableOp()` dispatches on `effectiveViewMode()`,
because the two editing panes are the same document in two representations and each has to be edited
in its own terms — Raw rewrites the pipe-delimited source, the Editor rearranges the live `<table>`.
Preview, diff and image views say so in the status line rather than silently doing nothing, and a
shortcut pressed while another text field (find, the smart-insert note) has focus is left alone.

**The pipe syntax itself lives in `markdown.js`, not here** (`splitRow`, `isTableLine`,
`isDelimiterRow`, `parseTable`, `formatTable`, `pipePositions`, `blockGap`): the WYSIWYG fold needs the
same formatter to re-pad a turned-down table, and two implementations would mean the two panes writing
tables differently. `tables.js` owns the *operations* — the caret, the blocks, the live `<table>`.
`blockGap` is there for the same reason: `format.js` inserts a code fence, which has to open its own
block on exactly the same terms a table does.

- **Raw parses, rewrites, and re-pads the whole table block.** `tableBlockAt()` walks out from the
  caret's line; `parseTable()` turns the lines into `{aligns, rows}` (the delimiter row isn't content,
  it's the alignments) with ragged rows padded so a column lands at the same index in each; and
  `formatTable()` writes it back with the columns aligned. Every operation rewrites all of a table's
  lines anyway — a new column touches each one — so the padding is free, and it's what keeps a table
  legible as source. **A table row is a line that opens with `|`.** GFM would also swallow a following
  paragraph line into the table, but reformatting prose as a row is a silent way to mangle a note, so
  the block stops where the pipes do.
- **The Editor edits the DOM directly**, so — like `indent`/`outdent` — no `input` event fires and
  `runTableOp()` calls `markBufferEdited()` itself. New cells match their row (`th` in the heading row,
  `td` elsewhere), so a new column stays a column after a save.
- **An empty cell has nothing to lay out**, so a fresh table would be a grid of slivers with no width
  to click into and a row barely taller than its border. `.wysiwyg th/td` carry a `min-width`, and an
  `:empty` cell gets a zero-width space as `::after` — generated content, so it gives the cell its line
  box back without ever reaching the `innerHTML` turndown reads on save. Chromium may also park its own
  placeholder `<br>` in an empty editable cell, which `cellText()` drops along with any other break at
  a cell's edge; left in, an empty cell would save as a literal `<br>`.
- **Nothing can go above the heading row**, in either pane: a GFM table *is* its delimiter row, and a
  second heading row can't be expressed. From the heading row both directions mean the same thing — the
  new row opens the body. In the Editor that's after the row rather than at the body's start whenever
  the heading row is *in* the body (which is where a browser parks a bare `<tr>`), or the table would
  come out with no heading at all.

### Block formatting

What *kind* of block the cursor is in, from the keyboard: `⌘⌥1`…`⌘⌥6` make it a heading, `⌘⌥0` plain
text again, `⌘⌥C` a fenced code block. `runFormatOp()` in `renderer/format.js` is shaped exactly like
`runTableOp()` — dispatched on `effectiveViewMode()`, carried out in each pane's own terms (Raw
rewrites the source's line markers, the Editor replaces the live block element), refused with a status
message in Preview/diff/image, and left alone while another text field has focus.

- **The chords are `⌘⌥` + a digit, and they are read off `e.code`.** `⌘0`/`⌘+`/`⌘-` — what most
  editors use for this — are the View menu's zoom accelerators, and a menu accelerator never reaches
  the page, so the plain-digit chords aren't available at all. `e.code` is the key's *position*:
  Option is a character modifier on macOS (`⌥1` types `¡`) and a digit isn't in the same place on
  every layout. It sits under the same modifier as the table chords on purpose — `⌘⌥` is "the block
  the cursor is in", by arrow or by level — and is checked *after* them in `index.js`, since an arrow
  is only ever a table's.
- **Every operation is absolute, not a toggle**: `⌘⌥2` on a bullet, a quote or an `h1` alike leaves an
  `h2`. Code is the exception, because a second `⌘⌥C` is the only way back out — and `⌘⌥0` unfences
  too, since plain text is what unfencing leaves.
- **Raw rewrites the marker a line opens with**, via one `LINE_PREFIX` that strips quote arrows, a
  bullet (with its task checkbox) and an ATX `#` run together — so `- item` becomes `## item` rather
  than `- ## item`. Two things the line alone doesn't say: a **setext** heading is two lines, so the
  underline is dropped with it (otherwise the line stays a heading and the shortcut looks broken), and
  **fenced code is a range**, so `fenceBlocks()` re-derives them the way marked reads them —
  including an unterminated fence, which runs to the end of the file in the panes too.
- **The Editor replaces the block element** rather than calling `formatBlock`, and **lifts it to the
  top level first** (`liftOut()` splits every list or quote around it): "make this a heading" on the
  third bullet means the bullet leaves the list and the list closes up either side of it. Keeping the
  children — rather than the text — is what carries the bold and the links through the change. A code
  block is the one conversion that goes by text, so unfencing gives a paragraph *per line* instead of
  one run-on line. Like the table ops it edits the DOM directly, so no `input` event fires and
  `runFormatOp()` marks the buffer itself.
- **A table row is refused in both panes**, with a message pointing at the table shortcuts: `# | a |
  b |` is not a heading, and a cell is not a block that can hold one.
- **A marker typed at the start of a block is honoured as one** (`bulletInputRule()`, off the Editor
  pane's own `keydown` in `editor.js`): `*` or `-` followed by a space starts a bullet list. In Raw
  that is what those characters already *are*; in the Editor nothing re-reads the pane as Markdown
  while it is being typed, so they would stay two literal characters. **The space is what commits
  it** — a bare `-` is a minus sign until one follows — so the space is consumed rather than typed.
  It applies to a plain paragraph only: a heading, a quote's text, a table cell and a code block keep
  the character, since converting there would throw away the block the user is in. Two details are
  what keep it from writing something nobody typed: Chromium makes its own `<ul>` rather than joining
  the one above, so the new item is **merged with the list before it** (two `<ul>`s turn down as two
  lists); and in a list item — where Enter has already made a bullet — the marker is **swallowed**
  instead of converted, or the note ends up holding `- \- eggs`.

### Keyboard shortcuts help

`Help ▸ Keyboard Shortcuts` (`⌘/` / `Ctrl+/`) opens a modal listing every shortcut, grouped. The list
(`SHORTCUT_GROUPS` in `renderer/shortcuts.js`) lives beside the handlers it documents rather than in the menu
that opens it — a shortcut and its help are one change, not two. `chord()` writes each combination the
way the host OS does: glyphs run together on macOS (`⌘⇧T`), spelled out with pluses elsewhere
(`Ctrl+Shift+T`). **Add a shortcut, add its row.**

**`buildMenu()` in `main/window.mjs` exists for that one item, but it has to rebuild the standard menu roles
around it.** Setting any application menu replaces Electron's default one, and on macOS ⌘C/⌘V/⌘Q are
menu accelerators rather than browser behaviour — a template without an Edit menu silently takes them
away. The dialog is a plain `.modal-overlay` like every other (see **Dialogs**), so the window-level
shortcuts stand down while it's up, and `dialogOpen()` keeps it from opening over another one.

### Dialogs

Every dialog is the same object — a full-screen overlay holding one box — built by **`openModal()`**,
which returns `{ box, close, promise }`: fill `box`, call `close(value)` to settle. It owns the parts
that are easy to get subtly wrong and were previously repeated six times: the keydown listener is
registered on the **capture** phase (so the window-level shortcuts, which stand down whenever
`dialogOpen()` is true, never see it) and is removed by the same `close` that removes the overlay,
**exactly once** however the dialog was dismissed. Escape is the built-in fallback; `onKey(e, close)`
is consulted first and returns true once it has handled the event. `onClose(value)` runs before the
promise settles — that's where `commitModal` stashes its draft message. Backdrop-click always cancels.

**A dialog at a time**, because two overlays would both answer the same Escape. `shortcutsModal()`
refuses to open over one, and the reminder list's day ticker skips a repaint while one is up rather
than rebuilding the list under it (nothing is lost: the day it rendered against is what it compares,
so the next tick repaints).

### Find & replace

The find bar (`#find-bar`, between the editor header and the panes) searches the **open file only** —
`⌘F`/`Ctrl+F` to open, `⌘G`/`F3` (+`⇧`) to step, `⌘⌥F`/`Ctrl+H` for replace, `Esc` to close. The
shortcuts hang off the same window-level `keydown` listener as `⌘S`, which bails out while a
`.modal-overlay` is up so dialogs keep the keyboard.

Highlighting takes two routes, because the panes are different beasts:

- **Raw view: a mirror div** (`#find-highlights`) sits behind the textarea holding a copy of its text
  with each match wrapped in a span — a textarea can't hold markup. The two must lay text out
  identically, so their typography lives in **one shared CSS rule**, the textarea is transparent with
  `z-index: 1` over the mirror, and `syncHighlightBox()` pins the mirror's width to
  `editorEl.clientWidth` (excludes any scrollbar) and its `scrollTop` to the textarea's.
- **WYSIWYG / preview: the CSS Custom Highlight API** (`CSS.highlights`, styled via `::highlight()`).
  It paints ranges without touching the DOM — wrapping matches in `<mark>`s would let highlights
  round-trip through turndown into the saved Markdown.

Matches are `{start, end}` offsets in raw mode and live `Range`s in the other two, so anything reading
`findMatches` has to know which mode it's in. `refreshFind()` re-scans and is called from `applyView()`
(a re-render invalidates every Range) and, debounced, after edits. **Replace is raw-only** — it edits
the Markdown source, and the other panes are projections of it, so `⌘⌥F` switches to Raw first.

### Images

Notes can embed images with normal Markdown (`![alt](images/foo.png)`). Two things make this work despite the app's `file://` origin + CSP:

- **Preview embeds via data URLs.** `marked` emits `<img src="…">` with vault-relative paths the page can't load directly. After every render, `hydrateImages()` (renderer) asks the `read-image` handler (main) to resolve each local `src` **relative to the open file**, then inlines it as a base64 `data:` URL. So CSP stays tight (`img-src 'self' data:`) and all disk access stays in main. Remote (`http(s)`/`data:`) sources are left untouched; unresolvable refs get an `.img-missing` marker.
- **Two ref conventions are resolved, note-relative first.** A ref can be relative
  to the note that holds it — what this app writes — or relative to the **vault
  root**, which is what Obsidian's "relative to vault root" setting produces:
  a note in `hiring/` refers to its own picture as `./hiring/images/x.png`, which
  resolves nowhere note-relative. `resolveVaultRef()` in `main/refs.mjs` tries the note
  first and the vault root second, and the fallback is only taken when the
  candidate **is** an image that exists — so the second convention can never
  claim a ref the first one already answered. It reports which one hit (`style`),
  which is what lets a move rewrite a ref *in the convention it already used*
  instead of quietly converting the vault to one of them.
- **Drag & drop imports.** Dropping image files onto the editor (or preview) copies each into the vault's `images/` folder via the `import-image` handler (name-deduped, path-guarded) and inserts a reference to the open file — at the cursor in Raw view; in the WYSIWYG **Editor** an `<img>` node is inserted at the drop point (`caretRangeFromPoint`) and hydrated in place; in read-only Preview (no cursor) the Markdown ref is appended to the buffer. Dropped `File`s are turned into absolute paths with `webUtils.getPathForFile` (Electron 32 removed `File.path`), exposed as `api.getPathForFile` from preload. A window-level `drop`/`dragover` `preventDefault` stops stray drops from navigating the app away.
- **Pasting is the same import, from bytes instead of a path.** Three things arrive on the clipboard
  as an image and all three end up as a file in `images/` with an ordinary ref: raw bytes (a
  screenshot, a browser's "Copy Image") as a `File` with nothing behind it, Markdown text carrying
  `![](data:image/png;base64,…)` — which is what several other note apps put on the clipboard — and
  HTML carrying `<img src="data:…">` pasted into the Editor pane. Left alone, the last two paste the
  base64 **into the note**: a megabyte on one line that bloats every save, reads as one unintelligible
  line in the diff, and rides through every WYSIWYG fold. `import-image-data` (main) is `import-image`
  from a data URL — same `images/` folder, same dedupe, same vault guard, sharing `imageDest()`/
  `refFor()` — and the payload is untrusted, so the MIME must name a known image type, base64 must be
  base64, and the size cap is applied to the *encoded* length before anything is decoded into memory.
  **The name is the one thing a paste can't supply**, so it is stamped in main rather than passed in:
  `pasted-20260731-142530.png`, local time like every other date here, sorting by date and needing no
  escaping in a ref. Two in the same second are told apart by the same dedupe as any other collision.
  A URL main refuses is left out of the paste rather than inlined; a paste with no data URL in it is
  the browser's business, untouched. Two details: the listeners are on the two editing panes only
  (a window-level one would take the paste out of the find bar, the smart-insert box and the
  terminal), and the HTML route rewrites `data-md-src` while **leaving the data URL in `src`** —
  the pane's pictures are hydrated anyway, and putting the ref there would send Chromium after a
  path the `app://` scheme has nothing at, blinking the image out until it resolved.
- **Clicking an image in the tree shows the picture.** An image file has no text behind it, so
  `openFile()` routes it past `read-file` to `read-image-file` (main resolves the absolute vault path
  to a data URL, same guard and MIME table as `read-image`) and shows it in the read-only `#image-view`
  pane. `effectiveViewMode()` reports `'image'` for it — that one derived mode hides the Raw/Editor/
  Preview toggle, keeps the buffer empty and the textarea disabled (so no autosave can write text over
  a `.png`), turns find into "no results", and refuses an image drop for want of a buffer to reference
  it from. `applyView()` drops the data URL whenever the pane goes away.
- **Every import is described by Claude.** After `import-image` copies a file in, the renderer calls
  `analyze-image` (main), which runs the same `claude` CLI as smart insert on the image and returns
  `{alt, description}`. The image is inserted **immediately** with the file name as alt so the drop
  never stalls; `analyseImported()` folds each result in when it lands (~8s, all images in parallel) —
  replacing the alt and appending a collapsed `<details>` block, which is what makes the picture's
  content findable via `⌘F` later. Anything that moved on in the meantime is dropped rather than
  forced: a different file open, or the `![…](ref)` reference no longer in the buffer. Only the types
  Claude can actually look at are sent (`ANALYZABLE_IMAGE` in `main/smart.mjs`); `.svg`/`.bmp`/`.ico`/`.avif`
  import as before, silently unanalysed. A failure (no `claude` on PATH, say) is a status-line
  message, never a lost image.

Two details keep the description block from corrupting the note:

- **It is written without blank lines**, because a blank line ends an HTML block in Markdown — so the
  model's description is collapsed to a single line in `sanitizeAnalysis()` (which also HTML-escapes
  it, so a description can only ever be read as text, never as markup the preview renders).
- **turndown re-emits it via a `detailsBlock` rule**, not `keep` — `<details>` isn't in turndown's
  block list, so a plain keep would splice it inline and it would stop being its own HTML block. The
  rule rebuilds the block instead of echoing `outerHTML` because turndown collapses whitespace before
  rules run, which would otherwise fold the block onto one line on every WYSIWYG save.

### Moving things (and keeping the refs true)

Dragging a tree row onto a folder moves it (`move-path`); dropping it on the tree's
**background** moves it to the vault root, which is the only way back out of a folder
when there is no other folder to aim at. A file row hands the drop on to the folder it
sits in, so dropping next to a note means "into that note's folder" rather than falling
through to the root. Refused combinations (into itself, into its own descendant, into
the folder it is already in) are simply not offered as drop targets — main refuses them
too, but a highlight that can only end in an error message is worse than no highlight.

**A move is a rename plus a ref rewrite, and the rewrite is the hard half.**
`updateRefsAfterMove()` in `main/refs.mjs` walks every text file in the vault and fixes both
directions, because a move breaks refs both ways: a note that moved has to re-aim its
own refs, and every note that pointed *at* something moved has to follow it. A moved
folder is both at once. `rename-path` goes through the same helper — renaming an image
every note references is the same problem wearing a different name — and both channels
report `updated`, the number of notes rewritten, which the status line shows.

Four things make it safe to run over a whole vault:

- **It runs *after* the rename**, and existence is tested at the ref's *post-move*
  location (`mapTarget`). That is what lets one pass validate refs to moved and unmoved
  files alike, rather than needing a pre-move snapshot.
- **A ref whose target and note both stayed put is left byte-for-byte alone.** The walk
  visits every note, so recomputing (and re-encoding) untouched refs would turn one move
  into a diff across the whole vault. Only `targetMoved || noteMoved` rewrites.
- **A ref that resolves to nothing is never touched** — a move must not "fix" a broken
  ref by pointing it somewhere new — and neither is a URL, a `data:`, a bare anchor, or
  a ref carrying a query/fragment (a rewrite would drop it).
- **`MD_REF_RE` matches what `marked` actually renders**, which is what decides whether
  a ref is visible in the app at all: an unescaped space ends a ref (`](./a b.png)` is
  not an image to marked either), the `<…>` form may contain one, and one level of
  balanced parens is allowed. `encodeRef()` escapes spaces *and* parens on the way back
  out, so a rewritten ref can't close its own `](…)` early.

**The renderer re-keys everything a move invalidates**, in `rekeyMovedPaths()`: the
`expanded` set (absolute paths — without this a moved folder comes back collapsed), the
reading positions and the reminders' `file` links (both vault-relative, both re-keyed by
prefix so a moved folder takes its children's state with it). Positions and reminders are
owned by their own modules, so each exports a remap (`remapPositions`,
`remapReminderFiles`) rather than being reached into from the tree.

**The open file is re-opened, not re-labelled** — after a move *or* a rename, and also
when it didn't move at all but `updated` is non-zero. Its refs may have just been
rewritten on disk, and a buffer one version behind is exactly what the next autosave
would write back over the rewrite.

### Git

The vault is **often, but not always** a git repository, so every part of this is
conditional: `git-info` answers `{ ok: true, repo: false }` for a plain folder rather than
failing, `gitState` in the renderer is `null`, and the whole `#git-bar` hides itself. Nothing
else in the app changes. Git is driven only through `spawn('git', […])` from main — never a
shell — via `runGit()`, which never rejects and always resolves `{ok, code, stdout, stderr}`.

- **The vault may be a subfolder of a larger repo.** `gitRoot()` resolves the real repo root
  and every path is translated through it, because `git status --porcelain` reports paths
  relative to the *root*, not the cwd. Status is read with a `-- <baseFolder>` pathspec and
  `git add -A -- <baseFolder>`, so Wisp only ever sees and commits its own files. The commit
  is scoped with a pathspec **only** when the vault isn't the repo root — a partial commit is
  refused during a merge, so the ordinary whole-index commit is used in the common case.
- **Status is parsed from `--porcelain=v1 -z`**, not the human format: `-z` makes each record
  NUL-terminated, so a filename containing a space, quote or newline survives intact (the
  non-`-z` format C-quotes it). A rename/copy entry is followed by one extra field, its old
  path — `parseStatus()` consumes it, or every subsequent record shifts by one.
- **`gitEnv()` disables credential prompting** (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`/
  `SSH_ASKPASS` deleted). There is no terminal to answer a password prompt, so a push that
  needs one must fail fast rather than hang the app forever. It also sets
  `GIT_OPTIONAL_LOCKS=0` so the status call that runs on every tree refresh doesn't fight a
  `git` command the user is running in a terminal.
- **Pull passes `--no-rebase`** unless `pull.rebase` / `branch.<n>.rebase` is configured. Since
  git 2.27 a bare `git pull` *refuses to run at all* once the branches have diverged — which is
  exactly the "same vault edited on two machines" case this feature exists for. A conflicted
  merge comes back as `{ok: false, conflict: true}`: a normal, recoverable state (the files are
  now marked in the tree) rather than a failure.
- **A commit that lands but fails to push is reported as such.** `git-commit` returns the step
  that failed plus `committed: true`, because "nothing happened" and "committed locally, retry
  the push" need different things from the user.
- **`git-revert` never deletes an untracked file.** Discarding restores from HEAD, so a file git
  has never seen has nothing to restore *to* — "discarding" it would be an unrecoverable delete
  wearing the name of an undo. Untracked entries are counted as `skipped` and reported to the
  user instead; the ordinary Delete menu item remains for anyone who does mean that. A
  staged-but-new file is only un-staged, so it survives on disk. It also re-reads status itself
  rather than trusting the renderer's last paint, because it destroys work.
- **Revert reads status over the whole vault and filters afterwards, not via a pathspec.** Git
  only detects a rename when *both* halves are in scope, so asking about just the new path
  reports a bare add and would silently leave the old path deleted.

Tree decoration is **rebuild-then-repaint**, matching how the tree and reminder list already
work: `refreshGit()` re-reads status whole, `indexGitStatus()` builds a path→status map plus a
set of folders containing something changed, and `applyGitDecorations()` walks the rendered
`.node-row[data-path]` elements. Keeping paint separate from `renderNode()` means a status
refresh doesn't rebuild (and collapse) the tree. `refreshTree()` repaints from cached state
first so a rebuild never flashes undecorated. Status is re-read after a tree refresh, after an
autosave (debounced — saving doesn't rebuild the tree but does change what git sees), and on
window focus (the vault can be changed from a terminal).

**`afterGitChange()` sets its status message last, on purpose.** It re-opens the current file so
the editor matches what a pull just wrote to disk — and `openFile()` ends by setting the status
to `Saved`, which would otherwise be all that's left of the pull's result.

### The diff view

The diff is the **fourth view of the open file**, in the editor pane beside Raw / Editor /
Preview — not a window of its own — so reviewing a change is the same gesture as reading the
file and the tree stays visible next to it. `viewMode` gains `'diff'`, but it is deliberately
*not* persisted (`STORED_VIEW_MODES`): it's a mode you step into to check something, not one
you want the app to reopen into. The three editing views belong to Markdown files and Diff
belongs to any text file in a repository, so `applyView()` shows each button on its own terms
and hides the shared group only when nothing is left in it.

A **deleted** file has nothing on disk to open, so it gets `diffOnlyFile`: `currentFile` points
at it, the buffer stays empty and disabled, the editing views hide, and opening anything else
clears it. It's reachable from the git bar's ◨ list (a plain popup menu, not a dialog) or by
discarding its parent folder's changes.

The same change is offered two ways:

- **Visual** — side-by-side, HEAD left / working tree right. Built from `diffOps()` (the LCS
  core `lineDiff` already used for smart insert, factored out as `lcsOps` so it works on lines
  *and* words), then `pairRows()` zips each changed block's deletions against its additions so a
  rewritten line sits opposite the line it replaced, then `condenseRows()` collapses distant
  context. `wordSegments()` runs the same LCS over words to pick out what actually changed
  inside a paired line — an O(n×m) table in the two versions of *one line*, so it keeps a size
  cap (`WORD_DIFF_MAX_CELLS`) past which the row renders as a plain whole-line change.
  Lines come from `splitLines()`, not a bare `split('\n')`: a trailing newline *terminates* the
  last line rather than starting an empty one, and empty text is no lines at all. Without both,
  every file grows a phantom blank line and a deleted file shows one empty line opposite its
  former contents.
- **The line diff is `diffOps`, not `lcsOps`, and the difference is the whole reason the view
  no longer refuses a large file.** A plain LCS table is O(n×m) in the *file*, so a ceiling on it
  (the old `DIFF_MAX_CELLS`) meant "This file is too large to diff side by side" for any note past
  ~1200 lines — a refusal about the file's size when the change in it was one paragraph. `diffOps`
  in `renderer/lcs.js` cuts the file into regions the exact table can afford instead: the common
  prefix and suffix are matched off first (which alone answers the ordinary case, exactly), a
  region still too big is split on the lines appearing exactly **once on each side** — patience
  diff's anchors, which can only correspond to their twin — and a region with no anchor at all is
  halved by proportion. Anchoring is deliberately *second*: committing to a fixed point can match
  a line or two fewer than the optimal LCS, so anything the table can still afford is diffed
  exactly, as it always was. **Nothing is refused for being large.** What is left is a rendering
  ceiling, `MAX_DIFF_ROWS` in `diff.js` — a cap on how much *changed*, since unchanged runs are
  already one row — and it cuts the rows off with a count of what it left rather than dropping the
  view.
- **Raw** — git's own unified patch, coloured by line kind. An untracked file is invisible to
  `git diff`, so main falls back to `git diff --no-index -- /dev/null <file>`.

Binary files are detected by a NUL byte in the first 8KB (git's own heuristic) and never handed
to the visual diff; `head`/`work` come back `null` so there is no text to lay out as lines.

### Reminders

The sidebar is split: the tree on top, a **reminder list** underneath, with a draggable `#divider-reminders` between them (height persisted in `localStorage`). **A reminder is one date, one title and one list.** It does not repeat, so the pane only ever contains pending entries and completing one is the end of it.

**A reminder is due on a day, it never repeats, and it is never announced.** All three are
narrowings of an earlier design, and each removed a whole mechanism:

- **`due` is a plain local calendar date, `YYYY-MM-DD` — not an instant.** Nothing fires at a time,
  so a time of day was a field to fill in that changed nothing; and storing an instant made the *date*
  fragile, since one moment is two different days either side of a timezone. As strings these dates
  compare and sort exactly as dates, so ordering and bucketing are string comparisons with no parsing
  and no clock in them. `parseDate`/`dateKey` are the only conversions, both local-midnight.
  **A file written by an older version is migrated on read**: `toDueDate()` takes an ISO instant back
  to the local day it fell on, and the next `persistReminders()` rewrites the file in the new form.
- **There is no popup, no window raise, no taskbar flash.** The `.alert-overlay` dialog, the
  `alerted`/queue machinery and the `alert-window` IPC channel are all gone — a reminder is something
  you *read* in the sidebar, and the app does not interrupt to say so.
- **The list a reminder belongs to is free text, not a fixed set** (`list`, defaulting to
  `DEFAULT_LIST` = `todo`). The editor's field is a `<datalist>` combobox rather than a select
  precisely so it can be both: it offers the lists already in use *and* takes anything else typed in,
  which is one control with no "new list…" mode to build or get out of. Nothing declares a list into
  existence and nothing has to clean one up — `reminderLists()` derives the vocabulary from the
  entries themselves, so a list stops being offered when its last reminder is completed.
  Deduplication is case-insensitive ("Work" and "work" are one list, first spelling alphabetically
  wins), and so is the filter's match, since only one of the two spellings is in the dropdown.
  `normalizeList()` is the one place an absent or blank list becomes the default, which is also what
  migrates every entry written before lists existed.
- **The pane filters by list**, from a `<select>` in its header rebuilt on every render from
  `reminderLists()`. The choice persists (`rawNotes.reminderList`, like the sidebar's tree/recent
  mode) — a filter that silently reset would leave entries the user believes they have looked at
  unseen. A filter pointing at a list with no entries left falls back to *All lists* rather than
  showing an empty pane with no way to tell why. Two things follow the filter: the header badge
  counts what is **on screen** (a count of entries the pane isn't showing would be a number with
  nothing behind it), and a row's meta line names its list only while unfiltered, since with a filter
  up every visible row has the same one. **A new reminder still defaults to `todo`**, not to the
  filtered list.
- **There is no repeat rule.** `RepeatRule`, `REPEAT_LABELS`, `occurrenceAt`/`nextOccurrence`, the
  editor's Repeat select and the field in the smart-insert prompt are gone with it, and so is
  `completeReminder()`: with nothing to roll a completed entry forward to, completing and deleting are
  the same operation, so the ✓ button and the menu's **Done** both call `removeReminder()`. A
  `repeat` left in a hand-edited (or older) file is ignored by `normalizeReminder()` and dropped on the
  next write. What survives it is `addMonths()`, still needed for the 1-month extend step.

- **Storage is one plain JSON file**, `.wisp-reminders.json` in the vault root, read and rewritten whole (`read-reminders` / `write-reminders`). Same philosophy as the tree: rebuild, don't mutate. The renderer holds the list in memory and calls `persistReminders()` after every change. `normalizeReminder()` drops malformed entries, so a hand-edited file can't break the app.
- **The list is grouped by how far off each entry is**: overdue / today / this week / next week / later (`dueBucket`, `BUCKET_LABELS`). The list is already sorted by due date, so each bucket is one contiguous run and `renderReminders()` emits a heading wherever it changes; the same class goes on the row, so an entry scrolled away from its heading still says where it sits. **Today's rows are a different object, not a differently-coloured one** — filled, outlined and rounded, where every other row is a flat line of text (overdue is the same treatment in red). With nothing popping up, the row *is* the notification. The header badge counts overdue + today for the same reason.
- **The day is the only clock.** Everything the list says about *when* derives from today's date, so one `today()` is taken per render and threaded through (a list rendered across midnight would otherwise be grouped against two different days), and the ticker — once every `REMINDER_TICK_MS`, now a minute rather than 15s — repaints when and only when that date changes. It skips a repaint while a dialog is up rather than rebuilding the list under one; it compares the day it rendered against, so the next tick catches up.
- **Weeks start on Monday.** Chromium can report the locale's own first day (`Intl.Locale.prototype.getWeekInfo`), but a list that regroups itself by where the app is running is harder to reason about, and the boundary only ever moves a row between two adjacent groups.
- **"Extend due to" replaced snooze, and moves the due date.** `EXTEND_OPTIONS` (1 day / 3 days / 1 week / 1 month — whole days and months, because the due date is a day) is offered on a row's context menu, each entry showing the date it would land on. `extendReminder()` measures the step from **whichever is later, today or the entry's own `due`**: a pending reminder moves by the step asked for, while an overdue one lands the step from today rather than somewhere still in the past. The month step goes through `addMonths()`, which clamps to the target month's last day (31 Jan + 1 month is 28 Feb, not 3 Mar).

### Smart insert (Claude-powered filing)

The panel at the top of the editor pane lets the user jot a note and have Claude file it into the right place. It shells out to the **`claude` CLI** from the main process (`spawn('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'])`, cwd = vault root). Two handlers back it: `smart-check` runs Claude and returns a *plan* (`targetFile`, `isNew`, `reason`, `newContent`, `oldContent`) without writing anything; `smart-apply` writes an approved plan (path-traversal-guarded, creates parent dirs).

- **Check previews, Add applies.** `renderer/smart.js` caches the plan in `smartPlan`/`smartPlanFor`; editing the note invalidates it so **Add** re-checks automatically rather than filing stale content. The preview shows the target file, a NEW/EXISTING badge, Claude's reason, and a collapsed line-diff (`lineDiff`/`condenseDiff`).
- **Every check also asks for a reminder.** The same single call returns an optional `reminder` alongside the filing plan (the prompt includes `describeNow()` so relative dates like "next Tuesday" resolve). *Checked* always, *created* only for a genuine time-bound commitment — a plain fact returns `null`. `sanitizeReminder()` in main drops anything malformed rather than surfacing a bogus reminder, and takes the proposed date **as written** — trimming a time off if the model added one — because `new Date('2026-08-03')` is UTC midnight, which is the day before west of Greenwich. The preview renders it as an opt-out card (`renderReminderProposal`) with an **Edit…** button into the normal reminder editor; **Add** writes the file and only then creates the reminder, linked to the file it filed into.
- **Prompt inlines small files.** `gatherFiles` embeds the contents of files under the size/total budget directly in the prompt so Claude usually decides in **one turn without `Read` round-trips** (large files are listed by name and read on demand). This is the difference between ~7s and Claude crawling the vault.
- **Flush before check/apply.** Both flows call `flushSave()` first so Claude reads the latest on-disk content and the post-apply `openFile()` can't clobber the AI's write with a stale editor buffer.
- **Reading the reply is `readClaudeJson()`, shared with lookup and image analysis, and the parsing is the fiddly half.** `--output-format json` wraps the model's text in a result envelope that also says how the run ended, so a CLI failure is reported *as itself*: `subtype`/`is_error` carry a usage limit or an exhausted turn budget, `api_error_status` an API error, and `stop_reason: max_tokens` a reply cut off mid-object. Reading only `result` turned all of those into one "could not understand Claude's response", which is the one thing they are not — and a parse failure leaves no other trace, so `logClaudeFailure()` puts the raw reply (head and tail, since the cut is only visible at the end) on the main process's console. **The model's JSON is found by scanning for balanced `{…}` spans that respect string literals** (`jsonSpans`), because `newContent` is a Markdown note and routinely contains braces and code fences: the old first-`{`-to-last-`}` slice broke on any prose brace, and stripping the first ``` fence truncated the JSON of every note that held one — reproducibly, which is what made the failure look intermittent.

### Smart lookup (the same box, read direction)

**Lookup**, the button at the far right of the smart bar, runs the panel's text the *other* way: instead of
filing it into the vault, `smart-lookup` (main) answers it **from** the vault and writes nothing. It reuses
`gatherFiles`/`runClaude`, so the usual question is answered in one turn, and returns
`{answer, sources:[{file, detail}]}`.

- **Sources are verified, not trusted.** `sanitizeSources()` drops any citation that isn't a real file
  inside the vault, so a hallucinated path can't reach the UI. The renderer turns each surviving one into a
  button that opens that note (via `openVaultNote`, shared with the reminder list), which is what makes an
  answer checkable against what the notes actually say.
- **Answers are plain text.** The prompt asks for prose with no Markdown, and `renderLookup` sets
  `textContent` — a model answer is never rendered as markup.
- **The preview pane holds one thing at a time.** A lookup answer and a filing plan share `#smart-preview`,
  so each clears the other: `renderPreview()` drops `smartLookupFor`, `smartLookup()` drops
  `smartPlan`/`smartPlanFor` (otherwise **Add** would apply a plan that's no longer on screen), and
  `invalidateSmartPlan()` clears whichever of the two the edited text has invalidated.

### The terminal pane (interactive claude)

Under the editor's view stack sits a collapsible pane running **`claude` interactively** at the vault
root — the third way the app talks to Claude, beside smart insert and image analysis, and the only one
that isn't a one-shot `runClaude()` call. `⌘J` / `Ctrl+J` toggles it; the header is also the toggle;
`⟳` restarts the session. Open/closed lives in `localStorage` (`rawNotes.terminalOpen`) and its height
in `rawNotes.terminalHeight`, resized by `#divider-terminal` — a *below*-style row divider, so
dragging up grows it.

- **It needs a real pty, which is why `node-pty` is here.** The CLI is a full-screen TUI: it wants its
  own tty, raw keystrokes and a SIGWINCH when the pane is resized, none of which a pipe provides.
  node-pty ships N-API prebuilds, so nothing needs rebuilding against Electron's ABI for `npm start`
  (see **Packaging & release** for the two things that *do* need arranging). The renderer draws it with
  **xterm.js** — a classic script like marked/turndown, so `window.Terminal` exists synchronously, and
  a build where it didn't load degrades to a header that says so rather than throwing on first expand.
- **The renderer never names the program.** `term-start` always spawns `claude`, in the open vault;
  `term-input` only ever writes to that process's tty. There is deliberately no channel that runs an
  arbitrary command — the same principle as git being driven only through `spawn('git', …)`.
- **One session per window, and it dies with the window.** Starting another replaces the first
  (`killPty()` clears `ptyProcess` *before* killing, so the dying session's `onExit` can tell it is no
  longer the current one and stay quiet — otherwise a restart reports the old exit over the new
  session). Both the window's `close` and `before-quit` kill it: an orphaned `claude` holding a pty
  nobody can see would keep running, and keep spending.
- **Collapsing does not stop the session**, because hiding a panel is a view change and killing a
  running agent is not. The header keeps reporting it. A vault change *does* replace it — the session's
  cwd is the vault and can't follow one — which is why `openFolder()` calls `terminalVaultChanged()`
  **last**: fitting the pane needs the workspace already on screen, the same reason the row dividers
  restore late.
- **While the terminal has focus, the editor's shortcuts stand down** (`terminalFocused()` in
  `index.js`'s keydown, right after the `dialogOpen()` check). ⌘F, Tab and the table chords are
  claude's keystrokes there. ⌘J is handled *before* that check, because it is the way back out.

### Watching the vault

The terminal makes something new possible: **the vault changing while the app is open.** Everything on
screen is read from disk once and rebuilt on demand, so without this a file claude just wrote is
invisible until the user hits refresh — and worse, the open buffer is a version behind, so the next
autosave writes it back over claude's work. `watch-vault` (main) watches the open folder with
`fs.watch(…, { recursive: true })` and sends one debounced `vault-changed`; `renderer/watch.js`
re-reads the tree, git status, the reminder list and the open file. `openFolder()` starts it, and each
call replaces the previous vault's watch.

- **It watches the filesystem rather than reading the terminal's output.** A pty carries bytes, not
  "the task finished": claude prints continuously while it works, and a statusline keeps printing when
  it doesn't — so a pause in the output is not a signal (an earlier version waited for one and never
  fired for anyone with a live statusline). Watching also covers what the terminal can't: the pane
  collapsed, another editor, a `git` command in a real terminal.
- **The app's own writes are not news.** `noteOwnWrite()` records each `write-file` /
  `write-file-sync` / `write-reminders` / `smart-apply` target *before* writing, and an event for a
  path written in the last 1.5s is dropped — otherwise every autosave would re-read the whole tree,
  and an event racing ahead of `writeFile` settling would reload the buffer the user is typing into.
  **Every handler that writes into the vault belongs on that list**: `smart-apply` was missing from it,
  and the renderer already rebuilds the tree and re-opens the note it filed into, so the watcher's
  refresh was a second one racing the explicit one.
- **`isIgnored()` filters events per path segment**, the same helper the tree uses. Without it a single
  commit would fire dozens of times over `.git`, none of it anything the UI shows.
- **A dirty buffer is never reloaded.** `openFile()` flushes before reading, so reloading an unsaved
  buffer would write the user's edits over the new content and then read that back as if it were the
  change — their edit wins, because it's the one they can see. A file whose content already matches is
  left alone (no status flicker), an unreadable one means deleted or moved (the rebuilt tree already
  says so), and the status line is set *last* because `openFile()` ends by reporting `Saved`.
