# Wisp in a browser

The real Electron app, running on a virtual X server in a container, with its
pixels shipped to a browser over VNC. **No application code changes** — the
terminal pane, git, the vault watcher and the Claude features all behave exactly
as they do on a desktop, because it *is* the desktop app.

```sh
cd docker
WISP_VAULT=~/Notes docker compose up --build
```

Then open <http://localhost:6080>. The password is printed on the first start
unless you set `VNC_PASSWORD`.

## What it is, and what it isn't

This is a remote desktop, not a web port. Scrolling and typing go over the wire,
so it feels like VNC because it is VNC. What it buys is that everything works on
day one: `node-pty` has a real tty, `git` and `claude` are ordinary child
processes, and `fs.watch` sees the vault.

If the feel matters more than the effort, the alternative is a headless server
speaking the same `types/ipc.d.ts` contract with the renderer served over HTTP —
a much larger job, and a different document.

## Read this before exposing it

**Anyone who reaches this screen has a shell on the container.** The terminal
pane runs `claude` at the vault root, and `claude` runs programs. Compose binds
the port to `127.0.0.1` deliberately.

To reach it from another machine, put it behind something that authenticates:
Tailscale, WireGuard, an SSH tunnel (`ssh -L 6080:localhost:6080 host`), or a
reverse proxy doing real auth. Do not change the port binding to `0.0.0.0` on a
host with a public interface.

The VNC password is a second lock, not the lock: the protocol's own
authentication takes **eight characters maximum** and silently truncates past
that, so a longer one is a false comfort. The generated default is exactly eight.

## Configuration

| Variable | Default | |
|---|---|---|
| `WISP_VAULT` | *(required)* | Host path to the notes folder |
| `VNC_PASSWORD` | generated | Max 8 characters, printed at startup when generated |
| `WISP_GEOMETRY` | `1600x1000` | Desktop size; noVNC's *Remote Resizing* setting adjusts it live |

Three mounts matter:

- **the vault** at `/vault` — your notes;
- **`wisp-config`** at `/home/wisp/.config` — `config.json` (last folder, window
  geometry) plus the renderer's `localStorage`, so the view mode, tree/recent
  choice and the five divider positions survive a rebuild;
- **`~/.claude` and `~/.claude.json`** — the CLI's credentials. **Both must
  already exist on the host**, or Docker helpfully creates them as *directories*
  and `claude` starts unauthenticated:

  ```sh
  mkdir -p ~/.claude && touch ~/.claude.json
  ```

  Without them the app still runs; `claude` shows its first-run login instead.

## If your host user isn't uid 1000

The container runs as uid 1000, which is the usual single-user host's, so a
bind-mounted vault is writable with no `chown`. If yours differs the entrypoint
says so at startup — `warning: /vault is not writable by uid 1000` — and the fix
is to run as yourself. Compose does not run a shell over that field, so the
values have to come from the environment:

```sh
export UID GID=$(id -g)      # UID is already set by the shell
```

then uncomment `user: "${UID}:${GID}"` in `compose.yml`.

Two things in the image exist to make that work, both verified: `HOME` is set
explicitly (an arbitrary uid has no `/etc/passwd` entry, and Docker would
otherwise hand it `HOME=/`, where neither `~/.vnc` nor Electron's userData can be
created), and the session bus is started only when there *is* a passwd entry —
`dbus-daemon` refuses to run without one, which would otherwise turn this
permissions workaround into a crash loop.

## Caveats worth knowing

- **The vault watcher may not fire for host-side edits on macOS.** `fs.watch`
  works on a native Linux filesystem (verified — an out-of-band write reloads the
  open note), but Docker Desktop's virtiofs does not reliably propagate inotify
  events from the host. Edits made *inside* the container — by the terminal pane,
  by `claude` — are seen normally, which is the case the watcher exists for.
  A host-side edit may need the ⟳ refresh.
- **Rendering is software.** There is no GPU in the container, so Chromium
  rasterizes on the CPU. Fine for a text editor; do not expect smooth scrolling
  through a note full of large images.
- **Clipboard is noVNC's, not the browser's.** Use the clipboard button in the
  noVNC control bar to move text in and out.
- **⌘ shortcuts are Ctrl here.** The app is running on Linux, so it uses the
  Linux chords regardless of what machine your browser is on. A Mac keyboard's
  ⌘ will not reach it as ⌘.
- **The image builds from source, not from a release**, because the published
  Linux artifacts are x86_64 only and `node-pty` must be *compiled* for its
  target. This is what makes the image work on arm64 (Apple silicon, a Pi,
  Graviton) as well as x86_64 — verified on `aarch64`.

## If the container restarts on a loop

`docker compose logs` first. The entrypoint reports the line number and exit
status of anything that fails before it gets to the app, so an empty log is
itself information — it means the process died without the trap running.

The restart policy is bounded at five attempts on purpose: a misconfiguration is
permanent, and an unbounded policy just scrolls the reason off the screen.

## Rebuilding

The image is pinned to nothing but your checkout, so `docker compose build`
after a `git pull` is the upgrade path. The dependency layer caches against
`package-lock.json` alone, so an ordinary source change rebuilds in seconds.
