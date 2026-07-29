#!/usr/bin/env node
// Make node-pty's prebuilt `spawn-helper` executable.
//
// node-pty ships N-API prebuilds, which is what lets the terminal pane work under
// Electron with no rebuild against its ABI — but the published tarball carries
// `prebuilds/<platform>-<arch>/spawn-helper` as 0644. On Unix node-pty execs that
// helper by path to hand the child its tty, so without the executable bit every
// `pty.spawn()` fails with a bare `posix_spawnp failed.` — a runtime error, in the
// one part of the app that has no other way to work.
//
// This runs from the root package's `postinstall`, so it applies to a plain
// `npm install`, to `npm ci` in CI, and before electron-builder copies the file
// into the bundle (the mode is preserved from here on).
//
// Usage: node scripts/pty-permissions.js

'use strict';

const fs = require('fs');
const path = require('path');

const PREBUILDS = path.resolve(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

// Windows has no executable bit and no spawn-helper; there is nothing to do.
if (process.platform === 'win32') process.exit(0);

let dirs;
try {
  dirs = fs.readdirSync(PREBUILDS);
} catch {
  // No prebuilds directory: either node-pty isn't installed yet or it was built
  // from source into build/Release, where npm's own scripts set the mode.
  process.exit(0);
}

for (const dir of dirs) {
  const helper = path.join(PREBUILDS, dir, 'spawn-helper');
  try {
    if ((fs.statSync(helper).mode & 0o111) !== 0) continue;
    fs.chmodSync(helper, 0o755);
    console.log(`chmod +x ${path.relative(path.resolve(__dirname, '..'), helper)}`);
  } catch {
    // Not every prebuild directory has one (Windows), and a read-only install is
    // not this script's problem to report.
  }
}
