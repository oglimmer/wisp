#!/usr/bin/env node
'use strict';

// Compile the TypeScript sources in place: main/foo.mts -> main/foo.mjs,
// renderer/foo.ts -> renderer/foo.js, preload.ts -> preload.js.
//
// "In place" is the whole design. The runtime pins the layout — main/protocol.mjs
// computes APP_ROOT as one level above main/, main/window.mjs resolves the preload
// as ../preload.js, and index.html loads marked/turndown/xterm by relative
// node_modules/... path — so index.html, styles.css, renderer/, main/ and
// node_modules/ have to sit together at a fixed depth. Emitting beside the sources
// satisfies that by construction, which is why package.json's `main`, its
// build.files allowlist, the app:// handler and scripts/smoke.js are all unchanged
// from when the repo was plain JavaScript.
//
// The extensions are chosen so every *emitted* filename is byte-identical to the
// one it replaced. That is what lets scripts/check-unbound.js keep parsing the
// emitted output — which is literally what ships — and what keeps all 193 import
// specifiers untouched: they already say './state.js', and TypeScript resolves
// that to state.ts on its own.
//
// Two jobs beyond invoking tsc:
//
//   1. Skip tsc entirely while a tree still has no sources. tsc treats an include
//      that matches nothing as an error (TS18003), which would make `npm run
//      build` fail on a checkout mid-migration.
//   2. Delete stale output first. tsc overwrites what it emits, but it will not
//      remove the output of a source that has *gone* — and a leftover module is
//      quieter than a broken one: it is still packaged, and check-unbound.js still
//      parses it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The trees under compilation, and the extension pair each uses. `converted: true`
// means every source in that tree is TypeScript, so anything with the emitted
// extension and no source beside it is stale and gets removed. While a tree is
// half-migrated it stays false, because there a .js with no .ts sibling is a
// hand-written module that has not been converted yet — indistinguishable from an
// orphan by inspection, and deleting one would be deleting source.
//
// This table is the same information as tsconfig.build.json's `include` and the
// .gitignore rules for emitted output; the three move together, one tree at a time.
const TREES = [
  { dir: '.', src: '.mts', out: '.mjs', only: ['main.mts'], converted: true },
  { dir: 'main', src: '.mts', out: '.mjs', converted: true },
  { dir: 'renderer', src: '.ts', out: '.js', converted: true },
  { dir: '.', src: '.ts', out: '.js', only: ['preload.ts'], converted: true },
];

function listDir(dir) {
  try {
    return fs.readdirSync(path.join(ROOT, dir));
  } catch {
    return [];
  }
}

// The sources a tree actually has right now. `only` narrows a tree to named files,
// which is how the two root-level entries (main.mts, preload.ts) avoid claiming
// each other's extension or anything else that lands in the repo root.
function sourcesOf(tree) {
  const names = tree.only || listDir(tree.dir).filter((f) => f.endsWith(tree.src));
  return names.filter((f) => fs.existsSync(path.join(ROOT, tree.dir, f)));
}

function outputFor(tree, source) {
  return path.join(tree.dir, source.slice(0, -tree.src.length) + tree.out);
}

function rm(rel) {
  try {
    fs.unlinkSync(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// Everything emitted for one source: the JavaScript and its source map. Both are
// removed together, because a stale map is worse than a stale module — it is still
// served over `app://`, and it points DevTools at a version of the file that no
// longer exists.
function outputsFor(tree, source) {
  const out = outputFor(tree, source);
  return [out, `${out}.map`];
}

function clean() {
  let removed = 0;
  for (const tree of TREES) {
    const sources = sourcesOf(tree);
    // Output whose source is still here: remove it so a failed or partial compile
    // can never leave yesterday's version behind looking current.
    for (const source of sources) for (const out of outputsFor(tree, source)) if (rm(out)) removed++;

    // Output whose source has gone. Only safe once the tree holds no hand-written
    // JavaScript at all — see the note on `converted` above.
    if (!tree.converted) continue;
    const expected = new Set(sources.flatMap((s) => outputsFor(tree, s)));
    const candidates = tree.only
      ? tree.only.flatMap((f) => outputsFor(tree, f))
      : listDir(tree.dir)
          .filter((f) => f.endsWith(tree.out) || f.endsWith(`${tree.out}.map`))
          .map((f) => path.join(tree.dir, f));
    for (const out of candidates) {
      if (expected.has(out)) continue;
      if (rm(out)) {
        removed++;
        console.log(`  removed stale ${out} (no source)`);
      }
    }
  }
  return removed;
}

function main() {
  const sourceCount = TREES.reduce((n, tree) => n + sourcesOf(tree).length, 0);
  if (sourceCount === 0) {
    console.log('build: no TypeScript sources yet — nothing to compile');
    return;
  }

  clean();

  // --no-install so a missing tsc reads as "reinstall", the same way
  // oglimmer.sh's type-check step handles it: tsc is a native binary shipped as a
  // platform-specific optional dependency, so a node_modules carried over from
  // another OS has the wrapper but not the binary.
  execFileSync('npx', ['--no-install', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log(`build: compiled ${sourceCount} TypeScript source${sourceCount === 1 ? '' : 's'}`);
}

main();
