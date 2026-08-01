# syntax=docker/dockerfile:1
#
# Wisp, running headless behind a browser.
#
# The app is unchanged — this is the real Electron app on a virtual X server,
# with its pixels shipped to a browser over VNC/WebSocket. So the terminal pane,
# git and the Claude features all work exactly as they do on a desktop.
#
# Built from source rather than from a published artifact on purpose: the Linux
# releases are x86_64 only, and node-pty has to be *compiled* for its target, so
# building in-image is what makes this work on an arm64 host (an Apple-silicon
# Mac, a Pi, Graviton) as well as an x86_64 one.

# ---------------------------------------------------------------- build stage
# The full (non-slim) image, for the build-essential + python3 that node-pty's
# node-gyp needs: node-pty publishes darwin and win32 prebuilds only.
FROM node:22-bookworm AS build

WORKDIR /app

# Dependencies first, so a source edit doesn't re-run the install. The
# postinstall hook is load-bearing (it makes node-pty's spawn-helper executable)
# and runs from `npm ci`, so its script has to be in the context by then — it is
# copied on its own rather than with the sources so the install layer still
# caches against the lockfile alone.
COPY package.json package-lock.json ./
COPY scripts/pty-permissions.js ./scripts/
RUN npm ci

# electron is a devDependency but is the *runtime* here, so the tree is never
# pruned to production. Its postinstall doesn't reliably land the binary in a
# container — the package installs but dist/ is absent — so it is run explicitly
# and checked, the same way scripts/linux-sandbox.sh does.
RUN node node_modules/electron/install.js \
 && test -x node_modules/electron/dist/electron

COPY . .

# Compiles in place (main/*.mjs, renderer/*.js, preload.js) — the layout the
# app://-scheme and the preload path both pin.
RUN npm run build

# node-pty was just built from source into build/Release, which it prefers, so
# the foreign prebuilds are dead weight in the final image.
RUN rm -rf node_modules/node-pty/prebuilds

# -------------------------------------------------------------- runtime stage
# node again rather than debian-slim: the claude CLI installs through npm, and
# reusing the base keeps one node in the image instead of two.
FROM node:22-bookworm-slim

# Three groups: the eleven libraries Electron links (the list
# scripts/linux-sandbox.sh keeps), the X/VNC stack, and the two programs the app
# shells out to.
#
# The fonts are not optional and two of the three are not obvious. Without any
# font the whole UI renders as boxes; with DejaVu alone the *icons* still do.
# The tree's folder glyph is U+1F5C0, a pictograph no text font carries, which
# is fonts-symbola's job — and the new-file and new-reminder buttons are U+FF0B
# FULLWIDTH PLUS SIGN, which lives in the CJK compatibility range and needs a
# fallback with CJK coverage. fonts-droid-fallback is the small one (~4MB
# against fonts-noto-cjk's ~100MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 \
      libsecret-1-0 libasound2 libgbm1 libdrm2 libxkbcommon0 \
      tigervnc-standalone-server tigervnc-common tigervnc-tools \
      novnc websockify openbox \
      dbus-x11 xdg-utils \
      fonts-dejavu fonts-symbola fonts-droid-fallback \
      git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# The terminal pane, smart insert and image analysis all spawn this.
RUN npm install -g @anthropic-ai/claude-code && claude --version

# Debian ships noVNC's page as vnc.html; serve it at the root so the URL is just
# the host and port.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# The node image already owns uid 1000. Renaming it rather than adding a second
# user keeps the container's uid equal to the usual host one, which is what lets
# a bind-mounted vault be writable without a chown.
RUN usermod -l wisp -d /home/wisp -m node && groupmod -n wisp node

# Both mount points have to exist *and* be owned before the VOLUME declaration
# below, or Docker creates them root-owned and the app cannot write a note.
#
# The home directory is left group/other-writable so the image still works when
# run as some *other* uid — which is what a Linux host whose user isn't 1000 has
# to do (`user: "1000:1000"` in compose) to make its bind-mounted vault
# writable. Without this the entrypoint cannot create ~/.vnc and dies. It is a
# container-local home in a single-application image, so the mode costs nothing.
RUN install -d -o wisp -g wisp /vault /home/wisp/.config \
 && chmod 0777 /home/wisp /home/wisp/.config

COPY --from=build --chown=wisp:wisp /app /app
COPY docker/entrypoint.sh /usr/local/bin/wisp-entrypoint
RUN chmod +x /usr/local/bin/wisp-entrypoint

USER wisp
WORKDIR /app

# The vault, and the config that remembers it. Declared so a `docker run` with
# no -v still keeps its state for the life of the container.
VOLUME ["/vault", "/home/wisp/.config"]

# HOME is stated rather than inherited from /etc/passwd, because a container run
# as an arbitrary uid (`user: "1000:1000"`, the fix for a host user that isn't
# 1000) has no passwd entry and Docker falls back to HOME=/ — where neither
# ~/.vnc nor Electron's userData directory can be created.
ENV HOME=/home/wisp \
    WISP_VAULT=/vault \
    WISP_GEOMETRY=1600x1000 \
    NO_AT_BRIDGE=1

EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/wisp-entrypoint"]
