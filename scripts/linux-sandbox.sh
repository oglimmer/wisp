#!/usr/bin/env bash
#
# linux-sandbox.sh — run and test Wisp on Linux without touching the repo's
# node_modules.
#
# The repo is normally checked out on the mac that signs the macOS build — often
# bind-mounted into a Linux container, which is where this comes in. Three
# dependencies carry platform-specific binaries: `electron/dist` (an `Electron.app`
# bundle vs an ELF executable), `node-pty` (a Mach-O vs an ELF .node, plus its
# `spawn-helper`), and typescript 7, whose compiler is now a native binary shipped
# as one optional dependency per platform. Everything else — marked, turndown,
# DOMPurify, xterm — is pure JavaScript.
#
# So a plain `npm install` on the Linux side would overwrite the mac's binaries
# with Linux ones and break the app on the host, outside the container, where the
# damage survives everything. This script keeps a **second tree** instead:
#
#   $WISP_LINUX_DIR (default ~/.cache/wisp-linux)
#     ├── <the repo's sources, mirrored on every run>
#     └── node_modules/   ← linux, built here, never shared with the repo
#
# It is a copy rather than a directory of symlinks on purpose. Node resolves a
# module's realpath, so a symlinked `main.js` would report `__dirname` back inside
# the repo — the app:// scheme would serve from there and `require('node-pty')`
# would find the mac's binary. And index.html loads marked/turndown/xterm by
# relative `node_modules/...` path, so the directory Electron is pointed at has to
# own its own. The sources are ~2MB; the mirror costs nothing.
#
#   ./oglimmer.sh linux run      launch the app (headless, under xvfb)
#   ./oglimmer.sh linux smoke    drive the sources with scripts/smoke.js
#   ./oglimmer.sh linux checks   run ./oglimmer.sh test inside the mirror
#   ./oglimmer.sh linux verify   package, then drive the packaged build
#   ./oglimmer.sh linux build    package a linux artifact into the mirror's dist/
#   ./oglimmer.sh linux libs     install the system libraries Electron needs
#   ./oglimmer.sh linux flatpak-deps
#                                install Flatpak's builder + pinned runtimes
#   ./oglimmer.sh linux prebuilds [dir]
#                                drop node-pty's darwin/win32 prebuilds, which a
#                                linux artifact must not carry
#   ./oglimmer.sh linux status   where the mirror is and what is installed
#   ./oglimmer.sh linux clean    remove the mirror
#
# **Local builds are for this machine's architecture only.** The published linux
# target is x86_64 (see package.json's `build.linux`), but building it anywhere
# else is a cross build, and @electron/rebuild would have to compile node-pty with
# a toolchain that isn't here — it fails at node-gyp rather than quietly shipping a
# foreign binary. So the x86_64 artifact comes from CI (`.github/workflows/
# release.yml`, which runs `libs` and `smoke.js` from this repo on an x64 runner),
# and what you get locally is the same packaging config exercised on your own arch.
# See CLAUDE.md, "Testing on Linux".

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TREE=${WISP_LINUX_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/wisp-linux}

# --- output (same shape as oglimmer.sh, which shells out to this) ------------

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

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# --- guards -----------------------------------------------------------------

require_linux() {
  [ "$(uname -s)" = "Linux" ] ||
    die "this is the Linux mirror; on this host use './oglimmer.sh run' and './oglimmer.sh build'"
}

# The mirror is wiped and rebuilt on every sync, so being wrong about where it is
# would delete the repo. Refuse anything that isn't a private directory of its own.
guard_tree() {
  case "$TREE" in
    /*) ;;
    *) die "WISP_LINUX_DIR must be an absolute path (got '$TREE')" ;;
  esac
  if [ "$TREE" = "/" ] || [ "$TREE" = "$HOME" ]; then
    die "refusing to use '$TREE' as the mirror"
  fi
  case "$TREE/" in
    "$ROOT"/*) die "the mirror must live outside the repo — '$TREE' is inside '$ROOT'" ;;
  esac
}

electron_bin() { printf '%s\n' "$TREE/node_modules/electron/dist/electron"; }

# --- system libraries -------------------------------------------------------

# Ubuntu 24.04 renamed the 64-bit-time_t libraries (libasound2 → libasound2t64,
# libgtk-3-0 → libgtk-3-0t64) and the old names are not installable there, so a
# hard-coded list works on Debian or on the CI runner but not both. Ask apt which
# name has a candidate. LC_ALL=C because apt-cache translates its field labels —
# on a German desktop the candidate line reads "Installationskandidat:", so
# without it the t64 rename is never detected and the un-installable name is the
# one reported to the user.
apt_package() {
  if LC_ALL=C apt-cache policy "$1" 2>/dev/null | grep -q '^  Candidate: [^(]'; then
    printf '%s\n' "$1"
  elif LC_ALL=C apt-cache policy "${1}t64" 2>/dev/null | grep -q '^  Candidate: [^(]'; then
    printf '%s\n' "${1}t64"
  else
    printf '%s\n' "$1" # let apt report it rather than guessing further
  fi
}

# Electron is a full desktop app: it links GTK, and a container image built for
# headless Chromium does not have it (chromium's headless shell doesn't need it).
# Without these it dies before any of our code runs, with a bare
# "error while loading shared libraries: libgtk-3.so.0". CI calls this too — one
# list, so the sandbox and the runner can't drift.
ensure_system_libs() {
  local -A libs=(
    [libgtk-3.so.0]=libgtk-3-0
    [libnotify.so.4]=libnotify4
    [libnss3.so]=libnss3
    [libXss.so.1]=libxss1
    [libXtst.so.6]=libxtst6
    [libatspi.so.0]=libatspi2.0-0
    [libsecret-1.so.0]=libsecret-1-0
    [libasound.so.2]=libasound2
    [libgbm.so.1]=libgbm1
    [libdrm.so.2]=libdrm2
    [libxkbcommon.so.0]=libxkbcommon0
  )
  local cache missing=() so
  # ldconfig lives in /sbin, which is not on a non-root PATH on some images
  # (GitHub's runners among them) — so it is found rather than required.
  if command -v ldconfig >/dev/null 2>&1; then
    cache=$(ldconfig -p)
  elif [ -x /sbin/ldconfig ]; then
    cache=$(/sbin/ldconfig -p)
  else
    die "ldconfig not found — cannot tell which libraries are installed"
  fi
  # A herestring rather than a pipe: `grep -q` exits at the first match and
  # closes the pipe, `printf` then dies of SIGPIPE, and `set -o pipefail` reads
  # that 141 as the pipeline's status — so a library that *is* installed gets
  # counted as missing, racily, depending on whether printf had finished writing.
  # Only visible where the libraries are already present (a desktop); on a CI
  # runner they really are absent, so the wrong answer was the right one.
  for so in "${!libs[@]}"; do
    grep -qF "$so" <<<"$cache" || missing+=("${libs[$so]}")
  done
  # Two binaries rather than libraries: a file manager for shell.showItemInFolder(),
  # and the X server everything here runs under.
  command -v xdg-open >/dev/null 2>&1 || missing+=(xdg-utils)
  command -v xvfb-run >/dev/null 2>&1 || missing+=(xvfb)
  if [ ${#missing[@]} -eq 0 ]; then
    ok "the libraries Electron needs are installed"
    return 0
  fi

  command -v apt-get >/dev/null 2>&1 || die "install these first: ${missing[*]}"
  local pkgs=() p
  for p in "${missing[@]}"; do pkgs+=("$(apt_package "$p")"); done
  say "installing the system libraries Electron needs: ${pkgs[*]}"
  if [ "$(id -u)" = 0 ]; then
    apt-get update -qq && apt-get install -y -qq "${pkgs[@]}"
  elif sudo -n true 2>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "${pkgs[@]}"
  else
    die "install these first (needs root): ${pkgs[*]}"
  fi
  ok "system libraries installed"
}

# electron-builder produces a single-file bundle, but flatpak-builder still
# needs the target runtime, SDK and Electron BaseApp installed while assembling
# it. Pin all three together so a runtime update cannot make the build drift.
ensure_flatpak_deps() {
  local missing=()
  command -v flatpak >/dev/null 2>&1 || missing+=(flatpak)
  command -v flatpak-builder >/dev/null 2>&1 || missing+=(flatpak-builder)
  command -v dbus-run-session >/dev/null 2>&1 || missing+=(dbus-daemon)
  if [ ${#missing[@]} -gt 0 ]; then
    command -v apt-get >/dev/null 2>&1 || die "install these first: ${missing[*]}"
    say "installing Flatpak build tools: ${missing[*]}"
    if [ "$(id -u)" = 0 ]; then
      apt-get update -qq && apt-get install -y -qq "${missing[@]}"
    elif sudo -n true 2>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq "${missing[@]}"
    else
      die "install these first (needs root): ${missing[*]}"
    fi
  fi

  flatpak remote-add --user --if-not-exists \
    flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  say "installing Flatpak 25.08 build runtimes"
  flatpak install --user --noninteractive -y flathub \
    org.freedesktop.Platform//25.08 \
    org.freedesktop.Sdk//25.08 \
    org.electronjs.Electron2.BaseApp//25.08
  ok "Flatpak build tools and 25.08 runtimes are ready"
}

# --- foreign prebuilds ------------------------------------------------------

# node-pty ships darwin and win32 prebuilds and no linux one, so on linux they are
# all dead weight — but a fresh tree packages `prebuilds/darwin-arm64` into the
# artifact: ~1MB of Mach-O, plus a `spawn-helper` for an OS this build cannot run
# on. (@electron/rebuild deletes `prebuilds/` when it rebuilds node-pty from
# source, so a tree that has already been built once looks clean — CI's never has.)
#
# electron-builder's `files` allowlist cannot express "and drop this on linux": a
# platform-specific `files` entry is a second, independent group, and a group with
# only negations means "everything", so putting the exclusion in `linux.files`
# packaged the whole repo instead. Repeating the allowlist per platform would put
# the *signed* mac list one edit away from drifting. So it happens here, where the
# platform is not in question. CI runs this too.
drop_foreign_prebuilds() {
  local dir="${1:-$TREE}/node_modules/node-pty/prebuilds"
  [ -d "$dir" ] || return 0
  rm -rf "$dir"
  ok "dropped node-pty's darwin/win32 prebuilds — this is a linux build"
}

# --- mirroring the sources --------------------------------------------------

# git decides what a source file is: tracked, plus untracked-and-not-ignored, so a
# module that has not been added yet is still tested and node_modules/dist (both
# gitignored) can never be swept in. The mirror's own node_modules and build
# output are the expensive part and are kept across syncs.
sync_sources() {
  guard_tree
  need git
  need tar
  mkdir -p "$TREE"
  find "$TREE" -mindepth 1 -maxdepth 1 \
    ! -name node_modules ! -name dist ! -name smoke ! -name 'user-data*' \
    -exec rm -rf {} +

  local list count
  list=$(mktemp)
  # A tracked file deleted from the worktree is still listed; tar would abort on
  # it, so the list is filtered down to what actually exists.
  while IFS= read -r -d '' f; do
    [ -e "$ROOT/$f" ] && printf '%s\0' "$f" >>"$list"
  done < <(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard)
  tar -C "$ROOT" --null -T "$list" -cf - | tar -xf - -C "$TREE"
  count=$(tr -cd '\0' <"$list" | wc -c)
  rm -f "$list"
  ok "mirrored $count source files to $TREE"
}

# --- dependencies -----------------------------------------------------------

ensure_deps() {
  need npm
  need node
  sync_sources
  ensure_system_libs

  # The stamp is the lockfile the mirror was installed from, so a dependency bump
  # in the repo reinstalls here and nothing else does.
  local stamp="$TREE/node_modules/.wisp-linux-lock"
  if [ ! -d "$TREE/node_modules" ] || ! cmp -s "$TREE/package-lock.json" "$stamp"; then
    say "npm ci in the mirror (the repo's node_modules is not touched)"
    (cd "$TREE" && npm ci)
    cp "$TREE/package-lock.json" "$stamp"
    ok "linux dependencies installed"
  fi

  # electron's own postinstall does not reliably land the binary here — the
  # package is installed but dist/ is absent — so run it explicitly. It is a
  # no-op once ~/.cache/electron holds the zip.
  if [ ! -x "$(electron_bin)" ]; then
    say "fetching the linux electron binary"
    (cd "$TREE" && node node_modules/electron/install.js)
    [ -x "$(electron_bin)" ] || die "electron's binary still isn't at $(electron_bin)"
    ok "electron $(node -p "require('$TREE/node_modules/electron/package.json').version") ready"
  fi

  # node-pty publishes darwin and win32 prebuilds only, so npm builds it from
  # source here. It is N-API, so the binary node-gyp produced against Node loads
  # under Electron unchanged — the same property the mac path relies on.
  local pty="$TREE/node_modules/node-pty/build/Release/pty.node"
  if ! head -c 4 "$pty" 2>/dev/null | grep -qa ELF; then
    say "building node-pty from source"
    (cd "$TREE" && npm rebuild node-pty --build-from-source)
    head -c 4 "$pty" 2>/dev/null | grep -qa ELF || die "node-pty did not build a linux binary"
    ok "node-pty built for linux"
  fi
}

# Playwright drives the smoke test and is deliberately not a dependency of the
# package: its postinstall downloads browser engines that every `npm install` on a
# dev machine would then pay for, and _electron.launch() uses the app's own
# Electron rather than any of them.
ensure_playwright() {
  [ -d "$TREE/node_modules/playwright" ] && return 0
  say "installing playwright into the mirror (not saved to package.json)"
  (cd "$TREE" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save --no-audit --no-fund playwright)
  ok "playwright installed"
}

# --- running ----------------------------------------------------------------

# There is no display and chrome-sandbox is not setuid in a container, hence xvfb
# and --no-sandbox. The container also has no session bus, and Electron logs a
# wall of dbus failures about it on every start; that is the only thing filtered.
run_electron() {
  local bin
  bin=$(electron_bin)
  (
    cd "$TREE"
    NO_AT_BRIDGE=1 xvfb-run -a "$bin" --no-sandbox "--user-data-dir=$TREE/user-data" . "$@"
  ) 2>&1 | grep -v -e 'dbus/bus.cc' -e 'dbus/object_proxy.cc' -e 'Failed to connect to the bus' || true
}

cmd_run() {
  require_linux
  need xvfb-run
  ensure_deps
  say "launching Wisp (headless — screenshots only, no window to look at)"
  run_electron "$@"
}

run_smoke() {
  local out="$TREE/smoke"
  mkdir -p "$out"
  local rc=0
  (
    cd "$TREE"
    NO_AT_BRIDGE=1 WISP_USER_DATA="$TREE/user-data-smoke" \
      xvfb-run -a node scripts/smoke.js --out "$out" "$@"
  ) || rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "smoke checks passed — screenshots in $out"
  else
    die "smoke checks failed — screenshots in $out"
  fi
}

cmd_smoke() {
  require_linux
  need xvfb-run
  ensure_deps
  ensure_playwright
  say "driving the sources with scripts/smoke.js"
  run_smoke "$@"
}

# `./oglimmer.sh test` needs a node_modules — tsc, the reachability scan — and it
# installs one when what it finds looks unrunnable. On a tree installed for macOS
# that install is refused (see assert_native_node_modules in oglimmer.sh), which
# would leave Linux with no way to run the static checks at all. So run them in the
# mirror, against a tree that is this platform's own.
cmd_checks() {
  require_linux
  ensure_deps
  say "running ./oglimmer.sh test inside the mirror"
  (cd "$TREE" && ./oglimmer.sh test)
}

# The published artifact, driven for real: node-pty is asarUnpack'ed and loaded by
# path, so a bundle can boot perfectly and still have no terminal. Nothing else
# tells you that before a user does.
cmd_verify() {
  require_linux
  need xvfb-run
  # A dist/ holding two architectures' unpacked trees is ambiguous, and smoke.js
  # refuses to guess which one to drive — so start from nothing.
  rm -rf "$TREE/dist"
  cmd_build dir
  ensure_playwright
  say "driving the packaged build with scripts/smoke.js"
  run_smoke --app "$TREE/dist"
}

# The published linux target is x86_64, but node-pty has to be compiled for the
# target and no cross toolchain is installed — @electron/rebuild fails at node-gyp,
# which is the honest outcome. So this always builds for the host and CI builds the
# artifact users download.
host_arch_flag() {
  case "$(uname -m)" in
    x86_64) printf '%s\n' --x64 ;;
    aarch64 | arm64) printf '%s\n' --arm64 ;;
    *) die "no electron-builder arch flag for $(uname -m)" ;;
  esac
}

cmd_build() {
  require_linux
  ensure_deps
  local target="${1:-dir}" arch
  if [ "$target" = flatpak ]; then ensure_flatpak_deps; fi
  arch=$(host_arch_flag)
  say "packaging for linux ($target, ${arch#--}) into $TREE/dist"
  if [ "$arch" != "--x64" ]; then
    warn "this is a ${arch#--} build — the published artifact is x86_64 and comes from CI"
  fi
  drop_foreign_prebuilds
  # electron-builder rebuilds node-pty against Electron here, the same step the mac
  # build does.
  (cd "$TREE" && npx electron-builder --linux "$target" "$arch")
  find "$TREE/dist" -maxdepth 1 -type f -exec du -h {} +
  ok "built in $TREE/dist"
}

cmd_status() {
  guard_tree
  printf 'mirror        %s\n' "$TREE"
  if [ ! -d "$TREE" ]; then
    printf 'state         not created yet — run ./oglimmer.sh linux smoke\n'
    return
  fi
  printf 'sources       %s\n' "$(du -sh --exclude=node_modules --exclude=dist "$TREE" 2>/dev/null | cut -f1)"
  printf 'node_modules  %s\n' "$([ -d "$TREE/node_modules" ] && du -sh "$TREE/node_modules" | cut -f1 || echo 'not installed')"
  printf 'electron      %s\n' "$([ -x "$(electron_bin)" ] && node -p "require('$TREE/node_modules/electron/package.json').version" || echo 'binary missing')"
  printf 'node-pty      %s\n' "$(head -c 4 "$TREE/node_modules/node-pty/build/Release/pty.node" 2>/dev/null | grep -qa ELF && echo 'built for linux' || echo 'not built')"
  # The point of the exercise: whatever the mirror holds, the repo's own binary is
  # still the host's. An `Electron.app/...` here means the mac install is intact.
  printf 'repo binary   %s\n' "$([ -f "$ROOT/node_modules/electron/path.txt" ] && cat "$ROOT/node_modules/electron/path.txt" || echo 'no electron installed')"
}

cmd_clean() {
  guard_tree
  [ -d "$TREE" ] || { ok "nothing to clean"; return; }
  say "removing $TREE"
  rm -rf "$TREE"
  ok "clean"
}

# The header comment is the help text — one place to keep current. Everything
# from the line after the shebang up to the first line that is not a comment.
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

main() {
  local cmd="${1:-smoke}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    sync) require_linux; sync_sources ;;
    deps) require_linux; ensure_deps ;;
    libs) require_linux; ensure_system_libs ;;
    flatpak-deps) require_linux; ensure_flatpak_deps ;;
    # Takes a directory so CI can point it at its own checkout rather than a mirror.
    prebuilds) require_linux; drop_foreign_prebuilds "${1:-$TREE}" ;;
    run) cmd_run "$@" ;;
    smoke) cmd_smoke "$@" ;;
    checks | test) cmd_checks ;;
    verify) cmd_verify "$@" ;;
    build | dist) cmd_build "$@" ;;
    status) cmd_status ;;
    clean) cmd_clean ;;
    help | -h | --help) usage ;;
    *) usage >&2; die "unknown linux command: $cmd" ;;
  esac
}

main "$@"
