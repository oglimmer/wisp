#!/bin/bash
# Bring up a virtual X server, put a VNC server on it, expose that to a browser
# through noVNC, and run Wisp inside it. The app itself is untouched.
set -euo pipefail

GEOMETRY="${WISP_GEOMETRY:-1600x1000}"
VAULT="${WISP_VAULT:-/vault}"
DISPLAY_NUM="${WISP_DISPLAY:-:1}"
WEB_PORT="${WISP_WEB_PORT:-6080}"

say() { printf '\033[36m[wisp]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[wisp] %s\033[0m\n' "$*" >&2; exit 1; }

# Anything that fails before the first `say` would otherwise leave an empty log
# and a container restarting on a loop, with nothing to say why — which is
# exactly how this script's own SIGPIPE bug first presented.
trap 'printf "\033[31m[wisp] entrypoint failed at line %s (exit %s)\033[0m\n" "$LINENO" "$?" >&2' ERR

# --------------------------------------------------------------------- access
# The VNC protocol's own authentication takes a maximum of eight characters and
# silently truncates past that, so a longer password would be a false comfort —
# the generated one is exactly eight.
#
# This matters more here than it looks: the terminal pane runs `claude` at the
# vault root, so anyone who reaches this screen has a shell on the container.
# Publish the port to 127.0.0.1 or a private interface, never to 0.0.0.0 on a
# public host.
generated=0
if [ -z "${VNC_PASSWORD:-}" ]; then
  # Neither of these steps may be a pipeline whose *reader* stops early. Under
  # `set -o pipefail` the obvious `tr -dc … </dev/urandom | head -c 8` exits
  # 141: head has its eight bytes and closes the pipe, tr dies of SIGPIPE, and
  # pipefail reads that as the pipeline's status. So `head` is the producer
  # here — reading a fixed count from a file, with nothing upstream to kill —
  # and the filtering is bash's own parameter expansion rather than another
  # process. (The same trap is written up in scripts/linux-sandbox.sh.)
  raw=$(head -c 32 /dev/urandom | base64)
  raw=${raw//[^A-Za-z0-9]/}
  VNC_PASSWORD=${raw:0:8}
  generated=1
elif [ ${#VNC_PASSWORD} -gt 8 ]; then
  say "warning: VNC_PASSWORD is longer than 8 characters; only the first 8 are used"
fi

install -d -m 700 "$HOME/.vnc"
# A herestring rather than `printf … | vncpasswd`, for the same reason.
vncpasswd -f <<<"$VNC_PASSWORD" > "$HOME/.vnc/passwd"
chmod 600 "$HOME/.vnc/passwd"

# --------------------------------------------------------------------- vault
[ -d "$VAULT" ] || die "no vault at $VAULT — mount one with -v /path/to/notes:$VAULT"
[ -w "$VAULT" ] || say "warning: $VAULT is not writable by uid $(id -u); saves will fail"

# Seed the last-opened folder so a fresh container opens straight into the
# mounted vault rather than an empty window waiting for the folder picker. Only
# when absent — after that config.json is the app's to own (it also carries the
# window geometry), and rewriting it every start would undo that.
#
# The window is seeded maximized for the same reason: the app's own default is
# 1200x800, which on a browser-sized desktop leaves it floating with its right
# edge off-screen. `maximized` is a key the app already restores.
CONFIG_DIR="$HOME/.config/wisp"
install -d "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cat > "$CONFIG_DIR/config.json" <<EOF
{
  "baseFolder": "$VAULT",
  "window": {
    "width": ${GEOMETRY%x*},
    "height": ${GEOMETRY#*x},
    "maximized": true
  }
}
EOF
  say "opening $VAULT"
fi

# ------------------------------------------------------------------ X + VNC
# Xvnc is an X server and a VNC server in one, so there is no Xvfb/x11vnc pair
# to keep alive. -localhost confines the raw VNC port to the container: the only
# way in is websockify below, which is the port actually published.
say "starting X on $DISPLAY_NUM at $GEOMETRY"
Xvnc "$DISPLAY_NUM" \
  -geometry "$GEOMETRY" \
  -depth 24 \
  -rfbport 5900 \
  -rfbauth "$HOME/.vnc/passwd" \
  -SecurityTypes VncAuth \
  -localhost \
  -AlwaysShared \
  -AcceptSetDesktopSize \
  -desktop Wisp \
  >/tmp/xvnc.log 2>&1 &
XVNC_PID=$!

export DISPLAY="$DISPLAY_NUM"

# Poll for the socket rather than sleeping: the server is ready when it is, and
# a fixed sleep is either a stall or a race depending on the host.
for _ in $(seq 1 100); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  kill -0 "$XVNC_PID" 2>/dev/null || { cat /tmp/xvnc.log >&2; die "Xvnc exited"; }
  sleep 0.1
done
[ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] || { cat /tmp/xvnc.log >&2; die "X server never came up"; }

# A window manager, so the app's window can be resized, maximized and focused —
# without one Electron's window maps unmanaged and the geometry it persists is
# meaningless. openbox is the smallest thing that does the job properly.
openbox >/tmp/openbox.log 2>&1 &

# noVNC's page plus the WebSocket-to-VNC bridge, in one process.
say "serving noVNC on port $WEB_PORT"
websockify --web=/usr/share/novnc "$WEB_PORT" "localhost:5900" \
  >/tmp/websockify.log 2>&1 &

# ---------------------------------------------------------------- the app
if [ "$generated" = 1 ]; then
  printf '\n\033[32m[wisp]\033[0m open \033[1mhttp://localhost:%s\033[0m — password \033[1m%s\033[0m\n\n' \
    "$WEB_PORT" "$VNC_PASSWORD"
else
  printf '\n\033[32m[wisp]\033[0m open \033[1mhttp://localhost:%s\033[0m — password as configured\n\n' \
    "$WEB_PORT"
fi

command -v claude >/dev/null || say "warning: claude is not on PATH; the terminal and smart features will report it"
command -v git >/dev/null    || say "warning: git is not on PATH; the git bar will stay hidden"

# Docker creates a missing bind-mount source as a *directory*, so a host with no
# ~/.claude.json yet gets one mounted here as a folder — claude then starts
# unauthenticated with nothing to explain why. Say so rather than let it puzzle.
if [ -d "$HOME/.claude.json" ]; then
  say "warning: ~/.claude.json is mounted as a directory — the host file did not exist."
  say "         fix on the host with: rm -rf ~/.claude.json && touch ~/.claude.json"
fi

# --no-sandbox because chrome-sandbox cannot be setuid in a container. The
# binary is exec'd directly rather than through node_modules/.bin/electron (a
# node shim), so signals reach the app.
#
# The session bus is worth having — Electron waits on its absence and then logs
# about it — but dbus-daemon refuses to start for a uid with no passwd entry,
# which is exactly the case when the container is run as the host's own user to
# make a bind-mounted vault writable. So it is used when it can be and skipped
# when it cannot, rather than being a hard dependency that turns a permissions
# workaround into a crash loop.
cd /app
ELECTRON=./node_modules/electron/dist/electron

if getent passwd "$(id -u)" >/dev/null 2>&1; then
  exec dbus-run-session -- "$ELECTRON" . --no-sandbox "$@"
else
  say "uid $(id -u) has no passwd entry — starting without a session bus"
  exec "$ELECTRON" . --no-sandbox "$@"
fi
