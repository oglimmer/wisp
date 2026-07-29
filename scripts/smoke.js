#!/usr/bin/env node
// smoke.js — drive the real app and check it works, end to end.
//
// There is no unit-test suite here, and `./oglimmer.sh test` is all static: it
// proves the sources parse, bind and type-check, never that the window comes up.
// This is the other half — Playwright launches the actual Electron app against a
// throwaway vault, clicks through the panes, edits a note and reads the file back
// off disk, so the paths nothing else covers (the app:// scheme, the preload
// bridge, the autosave, the WYSIWYG fold, node-pty) are exercised for real.
//
// It is **not** part of `test`, because it needs a display, a browser driver and
// a linux Electron binary — none of which the macOS release path has any business
// depending on. It runs from the sandbox mirror instead:
//
//   ./oglimmer.sh linux smoke
//
// Playwright is deliberately not a dependency of this package: its postinstall
// downloads browser engines, which every `npm install` on a dev machine would
// then pay for, and `_electron.launch()` needs none of them. The mirror installs
// it into its own tree with --no-save (see scripts/linux-sandbox.sh), which is
// also why tsconfig.json excludes this file — `require('playwright')` resolves
// there and nowhere else.
//
// Usage: node scripts/smoke.js [--out <dir>] [--vault <dir>] [--app <dir|bin>] [--keep]
//
// --app drives a *packaged* build instead of the sources — the artifact users
// actually download, asar and all. That is the only way to find out whether
// node-pty survived packaging: it is `asarUnpack`ed and loaded by path, so a
// bundle can boot perfectly and still have no terminal.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');

// ---- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: path.join(APP_DIR, 'smoke'), vault: '', app: '', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[(i += 1)]);
    else if (a === '--vault') out.vault = path.resolve(argv[(i += 1)]);
    else if (a === '--app') out.app = path.resolve(argv[(i += 1)]);
    else if (a === '--keep') out.keep = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.vault) out.vault = path.join(os.tmpdir(), 'wisp-smoke-vault');
  return out;
}

// electron-builder names the executable after the package, so `--app` takes the
// binary, its unpacked directory, or just `dist` — where the unpacked tree sits
// beside the artifacts as `linux-unpacked` (host arch) or `linux-<arch>-unpacked`.
function appBinary(target) {
  if (fs.statSync(target).isFile()) return target;
  const direct = path.join(target, 'wisp');
  if (fs.existsSync(direct)) return direct;
  const unpacked = fs
    .readdirSync(target)
    .filter((n) => /^linux(-[^-]+)?-unpacked$/.test(n))
    .map((n) => path.join(target, n, 'wisp'))
    .filter((p) => fs.existsSync(p));
  // Two unpacked trees means two architectures, and only one of them can run
  // here — guessing would report a pass for a build nobody asked about.
  if (unpacked.length > 1) throw new Error(`${target} holds more than one unpacked build: ${unpacked.join(', ')}`);
  if (!unpacked.length) throw new Error(`no packaged linux build under ${target}`);
  return unpacked[0];
}

const args = parseArgs(process.argv.slice(2));

// The mirror hands us a userData dir of its own, so a smoke run never reads or
// writes the config.json and localStorage of an interactive session.
const USER_DATA = process.env.WISP_USER_DATA || path.join(args.out, 'user-data');

// ---- checks ----------------------------------------------------------------

const checks = [];
let failed = 0;

// `detail` explains a failure and is printed only when there is one; `note` is a
// fact worth reporting either way (a count, a version). A passing run stays quiet.
function check(name, ok, detail, note) {
  checks.push({ name, ok: ok ? 'pass' : 'FAIL', detail: ok ? note : detail });
  if (!ok) failed += 1;
}

function checkEqual(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function skip(name, why) {
  checks.push({ name, ok: 'skip', detail: why });
}

// ---- the fixture vault -----------------------------------------------------

// A note per thing worth checking: inline markup and a table for the renderers,
// a padded table for the fold (turndown emits `| a | b |` unpadded, so a rewrite
// is visible byte-for-byte), frontmatter because marked reads it as a heading,
// and a nested folder so the tree has something to expand.
const HELLO = `# Hello

A **linux** smoke test with a [link](https://example.com) and some snake_case text.

| left  | right |
| ----- | ----- |
| one   | two   |
`;

const FRONTMATTER = `---
title: Fixture
tags: [smoke, linux]
---

Body text under the frontmatter.
`;

function writeVault(vault) {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'hello.md'), HELLO);
  fs.writeFileSync(path.join(vault, 'meta.md'), FRONTMATTER);
  fs.writeFileSync(path.join(vault, 'nested', 'deep.md'), '# Deep\n\nInside a folder.\n');
}

const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

// ---- helpers over the window ----------------------------------------------

// The tree keys rows by absolute path, so a vault-relative name is enough to
// pick one out. Ancestors are clicked first: a collapsed folder has no rows.
async function openNote(win, vault, rel) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const dir = path.join(vault, parts.slice(0, i + 1).join('/'));
    await win.click(`.node-row[data-path="${dir}"]`);
  }
  await win.click(`.node-row[data-path="${path.join(vault, rel)}"]`);
  await win.waitForFunction(
    (want) => document.getElementById('current-file')?.textContent === want,
    rel,
    { timeout: 10_000 },
  );
}

async function setView(win, id) {
  await win.click(`#${id}`);
  await win.waitForTimeout(300);
}

const text = (win, sel) => win.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const visible = (win, sel) =>
  win.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && getComputedStyle(el).display !== 'none';
  }, sel);

// The autosave clock is 400ms after the last input; give it room, then wait for
// the write to actually land rather than assuming the delay was enough.
async function waitForDisk(vault, rel, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let content = '';
    try {
      content = read(vault, rel);
    } catch {
      /* not written yet */
    }
    if (predicate(content)) return content;
    if (Date.now() > deadline) return content;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- the run ---------------------------------------------------------------

async function main() {
  const { vault, out } = args;
  writeVault(vault);
  fs.mkdirSync(out, { recursive: true });

  // No folder picker in headless, and no gesture to drive it — seed the config
  // the app reads on startup, which is the same path a second launch takes.
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ baseFolder: vault }));

  // chrome-sandbox is not setuid in a container, and the userData dir is the
  // mirror's so a run can't disturb an interactive session's config.
  const electronArgs = ['--no-sandbox', `--user-data-dir=${USER_DATA}`];
  const app = await electron.launch(
    args.app
      ? { executablePath: appBinary(args.app), args: electronArgs }
      : { args: [...electronArgs, APP_DIR], cwd: APP_DIR },
  );

  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await win.waitForLoadState('domcontentloaded');

  // --- startup: the vault reopens ------------------------------------------
  await win.waitForSelector('.node-row', { timeout: 20_000 });
  check('window opens and the saved vault reopens', await visible(win, '#workspace'));
  checkEqual('vault name in the sidebar', (await text(win, '#vault-name'))?.toLowerCase(), 'wisp-smoke-vault');
  const rows = await win.evaluate(() => document.querySelectorAll('.node-row').length);
  check('tree renders the vault entries', rows >= 3, `only ${rows} rows`, `${rows} rows`);
  check('git bar is hidden for a plain folder', !(await visible(win, '#git-bar')));
  check('reminder list shows its empty state', (await text(win, '#reminder-list'))?.includes('No reminders'));

  // --- Raw: the buffer is what is on disk ----------------------------------
  await openNote(win, vault, 'hello.md');
  const buffer = await win.inputValue('#editor');
  checkEqual('Raw buffer is the file, byte for byte', buffer, HELLO);
  await win.screenshot({ path: path.join(out, '1-raw.png') });

  // --- Preview: marked + DOMPurify through the app:// scheme ---------------
  await setView(win, 'view-md-btn');
  const preview = await win.evaluate(() => {
    const r = document.getElementById('rendered');
    return {
      h1: r.querySelector('h1')?.textContent,
      strong: r.querySelector('strong')?.textContent,
      href: r.querySelector('a')?.getAttribute('href'),
      cells: r.querySelectorAll('table td, table th').length,
    };
  });
  checkEqual('Preview renders the heading', preview.h1, 'Hello');
  checkEqual('Preview renders inline markup', preview.strong, 'linux');
  checkEqual('Preview keeps the link', preview.href, 'https://example.com');
  checkEqual('Preview renders the GFM table', preview.cells, 4);
  await win.screenshot({ path: path.join(out, '2-preview.png') });

  // --- Editor: turndown loaded, marked reprojected ------------------------
  await setView(win, 'view-wys-btn');
  const wys = await win.evaluate(() => {
    const w = document.getElementById('wysiwyg');
    return {
      editable: w.isContentEditable,
      h1: w.querySelector('h1')?.textContent,
      table: !!w.querySelector('table'),
      turndown: typeof window.TurndownService === 'function',
    };
  });
  check('Editor pane is contenteditable', wys.editable);
  check('turndown is available (the Editor pane is not degraded away)', wys.turndown);
  checkEqual('Editor pane renders the heading', wys.h1, 'Hello');
  check('Editor pane renders the table', wys.table);
  await win.screenshot({ path: path.join(out, '3-editor.png') });

  // --- the fold: an Editor edit rewrites only its own block ---------------
  // The whole point of foldToMarkdown(). Type into the paragraph and the table
  // must come back with its original padding — turndown alone emits `| a | b |`,
  // and the escape table alone would answer `snake\_case`.
  await win.evaluate(() => {
    const p = document.querySelector('#wysiwyg p');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await win.keyboard.type(' Edited in the Editor pane.');
  const folded = await waitForDisk(vault, 'hello.md', (c) => c.includes('Edited in the Editor pane.'));
  check('an Editor edit reaches disk', folded.includes('Edited in the Editor pane.'));
  check(
    'the table keeps its original padding',
    folded.includes('| left  | right |'),
    'the table was reformatted — the fold turned the whole pane down',
  );
  check('snake_case is not escaped', folded.includes('snake_case') && !folded.includes('snake\\_case'));
  checkEqual('the heading is untouched', folded.split('\n')[0], '# Hello');

  // --- Raw: input → autosave → write-file ---------------------------------
  await setView(win, 'view-raw-btn');
  await win.click('#editor');
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\nA line typed in Raw view.\n');
  const typed = await waitForDisk(vault, 'hello.md', (c) => c.includes('A line typed in Raw view.'));
  check('a Raw edit autosaves to disk', typed.includes('A line typed in Raw view.'));
  checkEqual('status line reports the save', (await text(win, '#status'))?.trim(), 'Saved');

  // --- frontmatter is not read as a heading -------------------------------
  await openNote(win, vault, 'meta.md');
  await setView(win, 'view-md-btn');
  const fm = await win.evaluate(() => {
    const r = document.getElementById('rendered');
    return { pre: !!r.querySelector('pre'), h2: r.querySelector('h2')?.textContent ?? null };
  });
  check('frontmatter is shown verbatim, not as a heading', fm.pre && fm.h2 === null, JSON.stringify(fm));

  // --- a nested folder expands ---------------------------------------------
  await setView(win, 'view-raw-btn');
  await openNote(win, vault, 'nested/deep.md');
  checkEqual('a note inside a folder opens', await win.inputValue('#editor'), '# Deep\n\nInside a folder.\n');

  // --- the terminal pane: node-pty under Electron --------------------------
  // The one native module. Skipped rather than failed when the CLI it spawns is
  // not installed — that is the environment, not the app.
  let hasClaude = true;
  try {
    execFileSync('/bin/sh', ['-c', 'command -v claude'], { stdio: 'ignore' });
  } catch {
    hasClaude = false;
  }
  if (!hasClaude) {
    skip('terminal pane spawns a pty', 'the `claude` CLI is not on PATH here');
  } else {
    await win.click('#terminal-toggle');
    let bytes = 0;
    try {
      await win.waitForFunction(
        () => (document.querySelector('.xterm-rows')?.innerText || '').trim().length > 0,
        undefined,
        { timeout: 30_000 },
      );
      bytes = (await text(win, '.xterm-rows'))?.trim().length ?? 0;
    } catch {
      /* reported by the check below */
    }
    check('terminal pane spawns a pty and streams output', bytes > 0, 'nothing was drawn', `${bytes} chars drawn`);
    const header = await win.evaluate(() => {
      const el = document.getElementById('terminal-status');
      return { text: el.textContent, running: el.classList.contains('running') };
    });
    check(
      'terminal header reports a live session',
      header.running && header.text.startsWith('claude ·'),
      JSON.stringify(header),
    );
    await win.screenshot({ path: path.join(out, '4-terminal.png') });
  }

  // --- nothing threw along the way ----------------------------------------
  check('no renderer errors', errors.length === 0, errors.join(' | ') || undefined);

  await app.close();
  if (!args.keep) fs.rmSync(vault, { recursive: true, force: true });
}

main()
  .then(() => {
    for (const c of checks) {
      const mark = c.ok === 'pass' ? '  ok' : c.ok === 'skip' ? 'skip' : 'FAIL';
      console.log(`${mark}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
    }
    console.log(
      `\n${checks.length} checks, ${failed} failed — ` +
        `${args.app ? `packaged build ${appBinary(args.app)}` : 'the source tree'}, ` +
        `screenshots in ${args.out}`,
    );
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    for (const c of checks) console.log(`${c.ok === 'pass' ? '  ok' : c.ok}  ${c.name}`);
    console.error(`\nsmoke run threw: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
