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
// Three jobs beyond invoking tsc:
//
//   1. Skip tsc entirely while a tree still has no sources. tsc treats an include
//      that matches nothing as an error (TS18003), which would make `npm run
//      build` fail on a checkout mid-migration.
//   2. Skip tsc when every emitted file is present and at least as new as its
//      source (and the configs that feed the compile). That is the "no-op when
//      the output is current" the rest of the tooling relies on.
//   3. Delete orphan output whose source has gone. tsc overwrites what it emits,
//      but it will not remove a module that no longer has a source — and a leftover
//      is quieter than a broken one: it is still packaged, and check-unbound.js
//      still parses it. Outputs of *existing* sources are left alone so a failed
//      compile keeps the last good app runnable.

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
/**
 * One tree under compilation.
 * @typedef {object} Tree
 * @property {string} dir directory, relative to the repo root
 * @property {string} src the source extension — `.mts` or `.ts`
 * @property {string} out what tsc emits for it — `.mjs` or `.js`
 * @property {string[]} [only] narrows the tree to these named files
 * @property {boolean} converted every source in the tree is TypeScript
 */

/** @type {Tree[]} */
const TREES = [
  { dir: '.', src: '.mts', out: '.mjs', only: ['main.mts'], converted: true },
  { dir: 'main', src: '.mts', out: '.mjs', converted: true },
  { dir: 'renderer', src: '.ts', out: '.js', converted: true },
  { dir: '.', src: '.ts', out: '.js', only: ['preload.ts'], converted: true },
];

// Inputs that are not listed as per-tree sources but still change what tsc emits
// or whether the program type-checks. A newer config or declaration must force a
// rebuild even when every .ts/.mts is older than its .js/.mjs.
const SHARED_INPUTS = [
  'tsconfig.json',
  'tsconfig.build.json',
  'scripts/build.js',
];

/** @param {string} dir */
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
/** @param {Tree} tree */
function sourcesOf(tree) {
  const names = tree.only || listDir(tree.dir).filter((f) => f.endsWith(tree.src));
  return names.filter((f) => fs.existsSync(path.join(ROOT, tree.dir, f)));
}

/** @param {Tree} tree @param {string} source */
function outputFor(tree, source) {
  return path.join(tree.dir, source.slice(0, -tree.src.length) + tree.out);
}

/** @param {string} rel */
function abs(rel) {
  return path.join(ROOT, rel);
}

/** @param {string} rel */
function mtimeMs(rel) {
  try {
    return fs.statSync(abs(rel)).mtimeMs;
  } catch {
    return null;
  }
}

/** @param {string} rel */
function rm(rel) {
  try {
    fs.unlinkSync(abs(rel));
    return true;
  } catch {
    return false;
  }
}

// Everything emitted for one source: the JavaScript and its source map. Both are
// removed together, because a stale map is worse than a stale module — it is still
// served over `app://`, and it points DevTools at a version of the file that no
// longer exists.
/** @param {Tree} tree @param {string} source */
function outputsFor(tree, source) {
  const out = outputFor(tree, source);
  return [out, `${out}.map`];
}

// Output whose source has gone. Only safe once the tree holds no hand-written
// JavaScript at all — see the note on `converted` above.
function removeOrphans() {
  let removed = 0;
  for (const tree of TREES) {
    if (!tree.converted) continue;
    const sources = sourcesOf(tree);
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

function declarationInputs() {
  const dir = path.join(ROOT, 'types');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.d.ts'))
      .map((f) => path.join('types', f));
  } catch {
    return [];
  }
}

// True when something is missing or older than an input that feeds the compile.
function needsCompile() {
  let newestShared = 0;
  for (const rel of [...SHARED_INPUTS, ...declarationInputs()]) {
    const t = mtimeMs(rel);
    if (t == null) continue;
    if (t > newestShared) newestShared = t;
  }

  for (const tree of TREES) {
    for (const source of sourcesOf(tree)) {
      const srcPath = path.join(tree.dir, source);
      const srcTime = mtimeMs(srcPath);
      if (srcTime == null) return true;
      const inputTime = Math.max(srcTime, newestShared);
      for (const out of outputsFor(tree, source)) {
        const outTime = mtimeMs(out);
        if (outTime == null || outTime < inputTime) return true;
      }
    }
  }
  return false;
}

function main() {
  const sourceCount = TREES.reduce((n, tree) => n + sourcesOf(tree).length, 0);
  if (sourceCount === 0) {
    console.log('build: no TypeScript sources yet — nothing to compile');
    return;
  }

  removeOrphans();

  if (!needsCompile()) {
    console.log(`build: up to date (${sourceCount} source${sourceCount === 1 ? '' : 's'})`);
    return;
  }

  // --no-install so a missing tsc reads as "reinstall", the same way
  // oglimmer.sh's type-check step handles it: tsc is a native binary shipped as a
  // platform-specific optional dependency, so a node_modules carried over from
  // another OS has the wrapper but not the binary.
  //
  // Existing outputs are not deleted first: tsc overwrites what it emits, and a
  // failed compile leaves the last good modules in place so the app stays runnable.
  execFileSync('npx', ['--no-install', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log(`build: compiled ${sourceCount} TypeScript source${sourceCount === 1 ? '' : 's'}`);
}

main();
