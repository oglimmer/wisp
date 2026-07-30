#!/usr/bin/env bash
#
# oglimmer.sh — one entry point for the day-to-day Wisp tasks.
#
#   ./oglimmer.sh deps               install node_modules
#   ./oglimmer.sh run                launch the app (electron .)
#   ./oglimmer.sh test               static checks (no test suite exists yet)
#   ./oglimmer.sh build [--unsigned] package a macOS arm64 dmg + zip into dist/
#   ./oglimmer.sh release <version>  bump, tag and push — CI builds and publishes
#   ./oglimmer.sh clean              remove dist/ (and node_modules with --all)
#   ./oglimmer.sh linux <cmd>        run/smoke/build on Linux in a mirrored tree
#
# See ./oglimmer.sh help for the details of each command.

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"

# --- output -----------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); OFF=$(printf '\033[0m')
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; OFF=""
fi

say()  { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

confirm() {
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply || reply=""
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

pkg_version() { node -p "require('./package.json').version"; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# --- deps -------------------------------------------------------------------

# What OS this node_modules was installed for, read off the two dependencies that
# carry native binaries: `electron/path.txt` names the executable inside the
# platform's own layout, and node-pty's compiled binary is a Mach-O or an ELF.
# Prints `macos`, `linux` or `unknown` — unknown when neither signal is there,
# which is also what a half-installed tree looks like.
node_modules_platform() {
  if [ -f node_modules/electron/path.txt ]; then
    case "$(cat node_modules/electron/path.txt)" in
      Electron.app/*) printf 'macos\n'; return ;;
      electron) printf 'linux\n'; return ;;
    esac
  fi
  local pty=node_modules/node-pty/build/Release/pty.node
  if [ -f "$pty" ]; then
    case "$(head -c 4 "$pty" | od -An -tx1 | tr -d ' \n')" in
      7f454c46) printf 'linux\n'; return ;;
      cffaedfe | cefaedfe | feedfacf) printf 'macos\n'; return ;;
    esac
  fi
  printf 'unknown\n'
}

host_platform() {
  case "$(uname -s)" in
    Darwin) printf 'macos\n' ;;
    Linux) printf 'linux\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

# Refuse to install over a node_modules that belongs to another OS.
#
# This repo is often checked out on a mac and mounted into a Linux container, and
# an install on the Linux side replaces Electron's bundle and node-pty's binary
# *outside* the container, where the damage outlives it — the app on the host then
# fails with `spawn ENOEXEC` or a missing Electron. It is not hypothetical: `test`
# installs on its own initiative when tsc looks unrunnable, and a foreign tree is
# exactly what that looks like, so one `./oglimmer.sh test` in a container is
# enough to do it.
#
# On Linux the answer is `./oglimmer.sh linux <command>`, which keeps its own
# node_modules in a mirrored tree and never touches this one.
assert_native_node_modules() {
  [ -d node_modules ] || return 0
  local host tree
  host=$(host_platform)
  tree=$(node_modules_platform)
  # An explicit `if`, not `[ … ] && return 0`: under `set -e` a false AND-OR list
  # is the script's exit status, so the guard would abort silently on exactly the
  # case it exists to report.
  if [ "$tree" = unknown ] || [ "$host" = unknown ] || [ "$tree" = "$host" ]; then
    return 0
  fi
  warn "node_modules here was installed for $tree, and this is $host"
  warn "  installing would overwrite binaries the $tree host needs — and if this repo"
  warn "  is mounted from there, outside this container where the damage persists."
  if [ "$host" = linux ]; then
    die "use './oglimmer.sh linux <command>' (a mirrored tree with its own node_modules), or 'rm -rf node_modules' first if you really do mean to reinstall here"
  fi
  die "remove node_modules first if you really do mean to reinstall here"
}

# Electron ships a platform-specific native binary, so node_modules is never
# portable between machines or OSes — always install on the target host.
cmd_deps() {
  need npm
  assert_native_node_modules
  if [ -f package-lock.json ]; then
    say "npm ci"
    npm ci
  else
    say "npm install"
    npm install
  fi
  ok "dependencies installed"
}

ensure_deps() {
  if [ ! -d node_modules/electron ]; then
    warn "node_modules missing or incomplete — installing first"
    cmd_deps
  fi
}

# --- run --------------------------------------------------------------------

cmd_run() {
  need npm
  ensure_deps
  say "npm start"
  exec npm start -- "$@"
}

# --- test -------------------------------------------------------------------

# There is no unit-test suite in this repo. What this does instead is every
# cheap check that can fail a release: does the JS parse, are free identifiers
# bound (the module-split footgun), is the packaging metadata self-consistent,
# is the workflow valid YAML.
cmd_test() {
  need node
  local failed=0
  local version
  version=$(pkg_version)

  say "syntax-checking the app sources"
  local f
  for f in main.js preload.js renderer/*.js scripts/*.js; do
    if node --check "$f" >/dev/null; then
      ok "$f parses"
    else
      failed=1
    fi
  done

  say "checking renderer modules bind and are reachable"
  # Catches missing imports/exports left by the renderer.js → renderer/ split —
  # the kind of bug that only throws on the code path that hits it — and a module
  # nobody imports, which is quieter still: it is never fetched, so whatever it
  # registers at load time simply never happens.
  ensure_deps
  if node scripts/check-unbound.js; then
    ok "renderer/ binds and every module is reachable"
  else
    failed=1
  fi

  say "type-checking (tsc --noEmit against the JSDoc types)"
  # No build step and no .ts sources: tsconfig.json is checkJs + noEmit, so this
  # only reads the .js files the app already ships, plus the declarations in
  # types/. It is what keeps main.js, preload.js and the renderer agreeing about
  # the IPC contract — a three-file change nothing else verifies.
  #
  # tsc is a native binary delivered as a platform-specific optional dependency,
  # the same trap as Electron's — a node_modules predating this dependency, or
  # carried over from another OS, has the wrapper but not the binary. Probe for a
  # runnable tsc first, so that reads as "reinstall" rather than a Node stack
  # trace: ensure_deps can't see it, since node_modules/typescript is present.
  if ! npx --no-install tsc --version >/dev/null 2>&1; then
    warn "tsc is not runnable here — reinstalling dependencies"
    cmd_deps
  fi
  if npx --no-install tsc --noEmit; then
    ok "no type errors"
  else
    failed=1
  fi

  say "checking JSON is well-formed"
  for f in package.json package-lock.json; do
    if node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))"; then
      ok "$f parses"
    else
      failed=1
    fi
  done

  say "checking the electron-builder files allowlist"
  # The `files` list is hand-maintained; a new top-level source file that never
  # gets added is missing only from the packaged app, which is the worst place
  # to find out. node_modules is bundled by electron-builder automatically.
  local listed missing=""
  listed=$(node -p "require('./package.json').build.files.join('\n')")
  for f in *.js *.html *.css; do
    [ "$f" = "oglimmer.sh" ] && continue
    if ! printf '%s\n' "$listed" | grep -qx -- "$f"; then
      missing="$missing $f"
    fi
  done
  if [ -n "$missing" ]; then
    warn "not in package.json build.files:$missing"
    warn "  (fine if deliberate — tooling and scripts do not belong in the app)"
  else
    ok "every top-level source file is packaged"
  fi

  say "checking every Linux release target is published"
  local target ext
  for target in AppImage tar.gz deb flatpak; do
    if node -e '
      const want = process.argv[1];
      const targets = require("./package.json").build.linux.target;
      process.exit(targets.some((entry) => (entry.target || entry) === want) ? 0 : 1);
    ' "$target"; then
      ok "$target is configured"
    else
      printf '%serror:%s package.json does not configure Linux target %s\n' \
        "$RED" "$OFF" "$target" >&2
      failed=1
    fi
    ext=$target
    if ! grep -Fq "dist/*.$ext" .github/workflows/release.yml \
      || ! grep -Fq -- "-name '*.$ext'" .github/workflows/release.yml; then
      printf '%serror:%s release.yml does not upload and publish *.%s\n' \
        "$RED" "$OFF" "$ext" >&2
      failed=1
    fi
  done

  say "checking index.html references resolve"
  # The renderer loads marked/turndown by relative node_modules path; a rename
  # in a dependency shows up as a silently degraded UI, not an error.
  local ref
  while read -r ref; do
    [ -z "$ref" ] && continue
    if [ -e "$ref" ]; then
      ok "$ref"
    else
      printf '%serror:%s index.html references missing file: %s\n' "$RED" "$OFF" "$ref" >&2
      failed=1
    fi
  done < <(grep -oE '(src|href)="[^"]*node_modules/[^"]*"' index.html | sed -E 's/.*="([^"]*)"/\1/')

  say "checking the Homebrew cask tracks package.json"
  local cask_version
  cask_version=$(sed -nE 's/^[[:space:]]*version[[:space:]]+"(.*)"$/\1/p' Casks/wisp.rb)
  if [ "$cask_version" = "$version" ]; then
    ok "cask and package.json both at $version"
  else
    # Expected between a bump and the CI cask commit — not a failure.
    warn "cask is at $cask_version, package.json at $version (CI bumps the cask on release)"
  fi

  say "checking the workflow's script references resolve"
  # The release job shells out to scripts/ (libs, prebuilds). A path that is wrong,
  # or a script that lost its executable bit, fails on a release tag and nowhere
  # else — by which point the tag is already pushed.
  local script
  while read -r script; do
    [ -z "$script" ] && continue
    if [ -x "$script" ]; then
      ok "$script is executable"
    else
      printf '%serror:%s release.yml runs %s, which is missing or not executable\n' \
        "$RED" "$OFF" "$script" >&2
      failed=1
    fi
  done < <(grep -oE '\./scripts/[A-Za-z0-9_.-]+' .github/workflows/release.yml | sort -u)

  if command -v yamllint >/dev/null 2>&1; then
    say "yamllint .github/workflows"
    yamllint -d '{extends: relaxed, rules: {line-length: disable}}' .github/workflows/ || failed=1
    ok "workflows lint clean"
  else
    warn "yamllint not installed — skipping workflow lint"
  fi

  if command -v shellcheck >/dev/null 2>&1; then
    say "shellcheck the shell sources"
    shellcheck oglimmer.sh scripts/*.sh || failed=1
    ok "scripts lint clean"
  else
    warn "shellcheck not installed — skipping"
  fi

  echo
  if [ "$failed" -eq 0 ]; then
    ok "all checks passed"
  else
    die "checks failed"
  fi
}

# --- build ------------------------------------------------------------------

cmd_build() {
  local unsigned=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --unsigned) unsigned=1 ;;
      *) die "build: unknown option $1" ;;
    esac
    shift
  done

  need npx
  [ "$(uname -s)" = "Darwin" ] ||
    die "packaging needs a macOS host (electron-builder --mac); use 'release' to let CI build it"
  ensure_deps

  say "packaging Wisp $(pkg_version) for macOS arm64"
  if [ "$unsigned" -eq 1 ]; then
    # Same flags CI uses when no signing secrets are present. Produces a build
    # that only opens locally after stripping the quarantine attribute.
    warn "ad-hoc signature only — not notarized, macOS will block a downloaded copy"
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 \
      -c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false
  else
    # Signing and notarization read CSC_LINK / CSC_KEY_PASSWORD / APPLE_ID /
    # APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID from the environment; without
    # them electron-builder falls back to whatever identity is in the keychain.
    if [ -z "${APPLE_ID:-}" ]; then
      warn "APPLE_ID unset — notarization will fail; see docs/SIGNING.md, or use --unsigned"
    fi
    npm run dist
  fi

  say "built artifacts"
  ls -lh dist/*.dmg dist/*.zip 2>/dev/null || warn "no dmg/zip in dist/"
}

# --- linux ------------------------------------------------------------------

# Everything Linux-specific lives in scripts/linux-sandbox.sh: it mirrors the
# sources into a tree of its own so a linux `npm install` can never overwrite the
# mac binaries in this node_modules. See the header there, and CLAUDE.md's
# "Testing on Linux".
cmd_linux() {
  exec "$ROOT/scripts/linux-sandbox.sh" "$@"
}

# --- release ----------------------------------------------------------------

# Releasing is just: bump package.json, tag, push the tag. The tag push is what
# runs .github/workflows/release.yml, which builds signed + notarized, publishes
# the GitHub release and bumps Casks/wisp.rb on the default branch.
cmd_release() {
  local bump="" push=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-push) push=0 ;;
      -*) die "release: unknown option $1" ;;
      *) bump="$1" ;;
    esac
    shift
  done
  [ -n "$bump" ] || die "usage: $0 release <patch|minor|major|X.Y.Z> [--no-push]"

  need npm
  need git

  local branch default_branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  default_branch=${default_branch:-master}
  if [ "$branch" != "$default_branch" ]; then
    warn "on '$branch', not '$default_branch' — CI lands the cask bump on '$default_branch' regardless"
    confirm "Continue anyway?" || die "aborted"
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree is dirty — commit or stash first"
  fi

  say "running checks before tagging"
  cmd_test

  say "bumping version (was $(pkg_version))"
  npm version "$bump" --no-git-tag-version >/dev/null
  local version tag
  version=$(pkg_version)
  tag="v$version"

  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    git checkout -- package.json package-lock.json
    die "tag $tag already exists"
  fi

  git --no-pager diff --stat -- package.json package-lock.json
  echo
  say "about to commit '$tag', tag it, and push to origin"
  echo "    the tag push triggers a Linux x86_64 build, a signed and notarized"
  echo "    macOS build, one public GitHub release holding both, and a cask bump"
  echo "    on '$default_branch' — all visible to users."
  if ! confirm "Release $tag?"; then
    git checkout -- package.json package-lock.json
    die "aborted — version reverted"
  fi

  git commit -q -m "release $tag" -- package.json package-lock.json
  git tag -a "$tag" -m "Wisp $version"
  ok "committed and tagged $tag"

  if [ "$push" -eq 0 ]; then
    warn "--no-push: nothing sent to origin yet. When ready:"
    echo "    git push origin $default_branch && git push origin $tag"
    return
  fi

  say "pushing $branch and $tag"
  git push origin "HEAD:$branch"
  git push origin "$tag"
  ok "pushed — CI is building $tag"

  if command -v gh >/dev/null 2>&1; then
    echo "    watch it with: gh run watch \$(gh run list -w release.yml -L1 --json databaseId -q '.[0].databaseId')"
  fi
}

# --- clean ------------------------------------------------------------------

cmd_clean() {
  local all=0
  [ "${1:-}" = "--all" ] && all=1
  if [ -d dist ]; then
    say "removing dist/"
    rm -rf dist
  fi
  if [ "$all" -eq 1 ] && [ -d node_modules ]; then
    say "removing node_modules/"
    rm -rf node_modules
  fi
  ok "clean"
}

# --- dispatch ---------------------------------------------------------------

usage() {
  cat <<'EOF'
oglimmer.sh — build, run, test and release Wisp

USAGE
  ./oglimmer.sh <command> [options]

COMMANDS
  deps                 Install dependencies (npm ci when a lockfile is present).
                       Electron's binary is platform-specific — never copy
                       node_modules between machines, reinstall on the target.
                       Refuses to install over a node_modules belonging to
                       another OS: on Linux with a macOS tree (a container with
                       the repo mounted from a mac) that would break the app on
                       the host, so use `linux <command>` there instead.

  run                  Launch the app with `npm start`. Installs deps if missing.
                       Extra arguments are passed through to electron.

  test                 Every check that can fail a release, since there is no
                       unit-test suite: syntax-check main/preload/renderer/*,
                       unbound-name + reachability scan of renderer modules,
                       a tsc --noEmit
                       type-check against the JSDoc types, JSON validity,
                       the electron-builder `files` allowlist, the node_modules
                       paths index.html loads, cask/package version agreement,
                       yamllint on the workflows, shellcheck on self.

  build [--unsigned]   Package a macOS arm64 .dmg + .zip into dist/. macOS host
                       only. Signing and notarization come from the environment
                       (CSC_LINK, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
                       APPLE_TEAM_ID — see docs/SIGNING.md). --unsigned builds
                       ad-hoc for local smoke-testing, exactly as CI does when
                       no secrets are configured.

  release <version>    Bump package.json to <patch|minor|major|X.Y.Z>, run the
        [--no-push]    checks, commit, tag v<version> and push. The tag push is
                       what makes CI publish the signed release and bump the
                       Homebrew cask — it prompts before anything leaves the
                       machine. --no-push stops after tagging locally.

  clean [--all]        Remove dist/; --all also removes node_modules/.

  linux <command>      Run the app on Linux from a mirrored tree, so a linux
                       install never overwrites the mac binaries in this
                       node_modules. Linux host only. Builds here target the
                       host's architecture; the published x86_64 artifact comes
                       from CI, which cross-compiling node-pty would need a
                       toolchain for.
                         run        launch headless under xvfb
                         smoke      drive the sources with scripts/smoke.js
                         checks     run these static checks in the mirror
                         verify     package, then drive the packaged build
                         build      package into the mirror's dist/
                         libs       install the libraries Electron needs
                         prebuilds  drop node-pty's darwin/win32 prebuilds
                         status     where the mirror is, what is installed
                         clean      remove the mirror
                       See scripts/linux-sandbox.sh for the details.

EXAMPLES
  ./oglimmer.sh run
  ./oglimmer.sh test
  ./oglimmer.sh build --unsigned
  ./oglimmer.sh release patch
  ./oglimmer.sh linux smoke
EOF
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    deps | install) cmd_deps "$@" ;;
    run | start) cmd_run "$@" ;;
    test | check) cmd_test "$@" ;;
    build | dist) cmd_build "$@" ;;
    release) cmd_release "$@" ;;
    clean) cmd_clean "$@" ;;
    linux) cmd_linux "$@" ;;
    help | -h | --help) usage ;;
    *) usage >&2; die "unknown command: $cmd" ;;
  esac
}

main "$@"
