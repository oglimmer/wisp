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
// Usage: node scripts/smoke.js [--out <dir>] [--vault <dir>]
//        [--app <dir|bin> | --flatpak <app-id>] [--repo] [--host-tools] [--keep]
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
  const out = {
    out: path.join(APP_DIR, 'smoke'),
    vault: '',
    app: '',
    flatpak: '',
    repo: false,
    hostTools: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[(i += 1)]);
    else if (a === '--vault') out.vault = path.resolve(argv[(i += 1)]);
    else if (a === '--app') out.app = path.resolve(argv[(i += 1)]);
    else if (a === '--flatpak') out.flatpak = argv[(i += 1)];
    else if (a === '--repo') out.repo = true;
    else if (a === '--host-tools') out.hostTools = true;
    else if (a === '--keep') out.keep = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.app && out.flatpak) throw new Error('--app and --flatpak are mutually exclusive');
  if (out.flatpak && !/^[A-Za-z0-9._-]+$/.test(out.flatpak)) {
    throw new Error(`invalid Flatpak app id: ${out.flatpak}`);
  }
  if (!out.vault) {
    out.vault = out.flatpak
      ? path.join(os.homedir(), '.cache', 'wisp-smoke-vault')
      : path.join(os.tmpdir(), 'wisp-smoke-vault');
  }
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

// Playwright needs to start Electron itself so it can inject its debugging
// flags. A tiny executable wrapper puts the Flatpak app id before those flags,
// leaving `flatpak run` to forward them to Wisp's Electron binary.
function flatpakLauncher(appId, out) {
  const launcher = path.join(out, 'run-flatpak-smoke');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec flatpak run ${appId} "$@"\n`, { mode: 0o755 });
  return launcher;
}

const args = parseArgs(process.argv.slice(2));

// The mirror hands us a userData dir of its own, so a smoke run never reads or
// writes the config.json and localStorage of an interactive session.
//
// **A Flatpak gets a *private* /tmp**, so anything the sandboxed app has to read
// back — the seeded config.json above all — is invisible there no matter how the
// host driver writes it. The vault already defaults out of /tmp for --flatpak
// (parseArgs); the userData dir has to move with it, or the app opens with no
// vault and the run dies as a bare "waiting for .node-row" timeout 20s later,
// which says nothing about the cause. CI only escapes it by accident: its --out
// happens to resolve inside the workspace rather than /tmp.
const USER_DATA = process.env.WISP_USER_DATA
  || (args.flatpak
    ? path.join(os.homedir(), '.cache', 'wisp-smoke-user-data')
    : path.join(args.out, 'user-data'));

// The two paths above can still be pointed into /tmp explicitly (--vault, or
// WISP_USER_DATA from the mirror). Say so here rather than let it surface as
// that same unexplained timeout.
if (args.flatpak) {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const [what, dir] of [['--vault', args.vault], ['the userData dir', USER_DATA]]) {
    if (path.resolve(dir) === tmp || path.resolve(dir).startsWith(tmp + path.sep)) {
      throw new Error(
        `${what} is ${dir}, under ${tmp} — a Flatpak has its own private /tmp and `
        + 'cannot see it. Point it somewhere under $HOME instead.',
      );
    }
  }
}

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
// is visible byte-for-byte), a bullet list right under a heading (turndown writes
// `-   item` and a new block after a heading grew a blank line, so an edit to one
// item was visible on every other line of the list), frontmatter because marked
// reads it as a heading, and a nested folder so the tree has something to expand.
const HELLO = `# Hello

A **linux** smoke test with a [link](https://example.com) and some snake_case text.

| left  | right |
| ----- | ----- |
| one   | two   |

## List
- alpha
- beta
- gamma
`;

const FRONTMATTER = `---
title: Fixture
tags: [smoke, linux]
---

Body text under the frontmatter.
`;

// Longer than any pane, so a scroll offset means something, and numbered so a block
// can be identified from either side: paragraph N is the only text saying so, in the
// source and in each rendering of it. Paragraph N starts on line 2N.
const PARAGRAPHS = 40;
const LONG =
  '# Long note\n\n'
  + Array.from(
    { length: PARAGRAPHS },
    (_, i) =>
      `Paragraph ${i + 1} of the long note, with enough words in it to wrap in the raw pane and take a line of its own in the rendered ones.`,
  ).join('\n\n')
  + '\n';

function writeVault(vault) {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'hello.md'), HELLO);
  fs.writeFileSync(path.join(vault, 'meta.md'), FRONTMATTER);
  fs.writeFileSync(path.join(vault, 'long.md'), LONG);
  fs.writeFileSync(path.join(vault, 'nested', 'deep.md'), '# Deep\n\nInside a folder.\n');
}

// Where paragraph N sits in the source: the offset of its first character, and the
// line it is on. Both are read out of the fixture rather than assumed, so the checks
// stay true if the note above is edited.
function paragraphAt(n) {
  const offset = LONG.indexOf(`Paragraph ${n} of`);
  return { offset, line: LONG.slice(0, offset).split('\n').length - 1 };
}

// The pane child at the top of the viewport, and the block the caret is in — the two
// questions every one of the position checks below asks of a rendered pane.
const PANE_PROBE = (id) => {
  const pane = document.getElementById(id);
  const kids = [...pane.children];
  const edge = pane.getBoundingClientRect().top;
  const first = kids.find((el) => el.getBoundingClientRect().bottom > edge + 1);
  const sel = window.getSelection();
  let node = sel && sel.focusNode;
  while (node && node.parentNode !== pane) node = node.parentNode;
  return {
    top: first ? first.textContent.slice(0, 24) : null,
    caret: node ? node.textContent.slice(0, 24) : null,
    offset: sel ? sel.focusOffset : null,
  };
};

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
  if (args.repo) execFileSync('git', ['init', '-q', vault]);
  fs.mkdirSync(out, { recursive: true });

  // No folder picker in headless, and no gesture to drive it — seed the config
  // the app reads on startup, which is the same path a second launch takes.
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ baseFolder: vault }));

  // chrome-sandbox is not setuid in a container, and the userData dir is the
  // mirror's so a run can't disturb an interactive session's config.
  const electronArgs = [
    ...(args.flatpak ? [] : ['--no-sandbox']),
    `--user-data-dir=${USER_DATA}`,
  ];
  const packaged = args.app
    ? { executablePath: appBinary(args.app), args: electronArgs }
    : args.flatpak
      ? { executablePath: flatpakLauncher(args.flatpak, out), args: electronArgs }
      : { args: [...electronArgs, APP_DIR], cwd: APP_DIR };
  const app = await electron.launch(
    packaged,
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
  if (args.repo) {
    await win.waitForFunction(() => getComputedStyle(document.getElementById('git-bar')).display !== 'none');
    check('git bar detects a repository through the packaged process bridge', await visible(win, '#git-bar'));
  } else {
    check('git bar is hidden for a plain folder', !(await visible(win, '#git-bar')));
  }
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

  // --- the fold: editing one list item leaves the rest of the list alone ----
  // A whole list is one block, so an edit inside it *is* re-emitted by turndown —
  // which writes `-   item` and, as a new block after a heading, used to gain a
  // blank line. Both showed up as a rewrite of every line of a list nobody edited.
  await win.evaluate(() => {
    const li = document.querySelectorAll('#wysiwyg li')[1];
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(li);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await win.keyboard.type(' two');
  const list = await waitForDisk(vault, 'hello.md', (c) => c.includes('beta two'));
  checkEqual(
    'only the edited list item is rewritten',
    list.slice(list.indexOf('## List')),
    '## List\n- alpha\n- beta two\n- gamma\n',
  );

  // --- Raw: input → autosave → write-file ---------------------------------
  await setView(win, 'view-raw-btn');
  await win.click('#editor');
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\nA line typed in Raw view.\n');
  const typed = await waitForDisk(vault, 'hello.md', (c) => c.includes('A line typed in Raw view.'));
  check('a Raw edit autosaves to disk', typed.includes('A line typed in Raw view.'));
  checkEqual('status line reports the save', (await text(win, '#status'))?.trim(), 'Saved');

  // --- paste: an inlined image becomes a file and a reference --------------
  // Several note apps put `![](data:image/…;base64,…)` on the clipboard, and a
  // screenshot arrives as bytes with no path at all. Either way the base64 must
  // not reach the note — it is imported into images/ and referenced like every
  // other picture. A .bmp deliberately: Claude cannot read one, so the import
  // never spawns the CLI for a description and the run stays hermetic.
  const PASTED =
    'data:image/bmp;base64,Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAA////AA==';
  await win.evaluate((url) => {
    const el = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', `\n![shot](${url})\n`);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PASTED);
  const pasted = await waitForDisk(vault, 'hello.md', (c) => c.includes('![shot]('));
  const shown = pasted.slice(pasted.indexOf('![shot]'), pasted.indexOf('![shot]') + 80);
  // A clipboard image has no name of its own, so it is named after the moment it
  // was pasted — which is also what keeps two of them apart.
  const ref = /!\[shot\]\((images\/pasted-\d{8}-\d{6}\.bmp)\)/.exec(pasted);
  check('the note references the pasted image by date and time', !!ref, shown);
  check(
    'a pasted image is written into images/',
    !!ref && fs.existsSync(path.join(vault, ref[1])),
    'no file was imported',
  );
  check('the base64 is not in the note', !pasted.includes('data:image'), shown);

  // --- frontmatter is not read as a heading -------------------------------
  await openNote(win, vault, 'meta.md');
  await setView(win, 'view-md-btn');
  const fm = await win.evaluate(() => {
    const r = document.getElementById('rendered');
    return { pre: !!r.querySelector('pre'), h2: r.querySelector('h2')?.textContent ?? null };
  });
  check('frontmatter is shown verbatim, not as a heading', fm.pre && fm.h2 === null, JSON.stringify(fm));

  // --- positions: the same place in the file in every view ------------------
  // The panes lay the same note out completely differently, so a view switch has to
  // *map* the place the reader is at rather than reuse an offset. Two things only a
  // running window can show: that a round trip comes back to the exact pixel and
  // caret it left, and that a one-way switch lands on the block the reader was on.
  await setView(win, 'view-raw-btn');
  await openNote(win, vault, 'long.md');

  const twenty = paragraphAt(20);
  const rawBefore = await win.evaluate((at) => {
    const e = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
    e.focus();
    e.setSelectionRange(at, at); // scrolls the caret into view, so scroll after it
    e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) * 0.4);
    return { top: e.scrollTop, start: e.selectionStart };
  }, twenty.offset);
  await win.waitForTimeout(200);
  check('the raw pane has something to scroll', rawBefore.top > 0, `scrollTop is ${rawBefore.top}`);

  await setView(win, 'view-md-btn');
  await setView(win, 'view-raw-btn');
  const rawAfter = await win.evaluate(() => {
    const e = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
    return { top: e.scrollTop, start: e.selectionStart };
  });
  check(
    'Raw → Preview → Raw comes back to the same scroll offset',
    Math.abs(rawAfter.top - rawBefore.top) <= 2,
    `was ${rawBefore.top}, came back ${rawAfter.top}`,
  );
  checkEqual('Raw → Preview → Raw keeps the caret', rawAfter.start, rawBefore.start);

  // Raw → Editor: the caret is carried by line, so it must land in the block that
  // line renders to rather than at the top of the pane.
  await setView(win, 'view-wys-btn');
  const intoEditor = await win.evaluate(PANE_PROBE, 'wysiwyg');
  check(
    'Raw → Editor puts the caret in the same paragraph',
    (intoEditor.caret || '').startsWith('Paragraph 20'),
    `the caret landed in ${JSON.stringify(intoEditor.caret)}`,
  );

  // Editor → Raw, the same thing backwards: a caret in the pane's own DOM becomes a
  // line and column in the source.
  const thirty = paragraphAt(30);
  await win.evaluate(() => {
    const pane = document.getElementById('wysiwyg');
    const p = [...pane.children].find((el) => el.textContent.startsWith('Paragraph 30'));
    const range = document.createRange();
    range.setStart(p.firstChild, 5);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await win.waitForTimeout(200);
  await setView(win, 'view-raw-btn');
  const backToRaw = await win.evaluate(() => {
    const e = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
    const at = e.selectionStart;
    return { at, line: e.value.slice(0, at).split('\n').length - 1 };
  });
  checkEqual('Editor → Raw puts the caret on the same line', backToRaw.line, thirty.line);
  check(
    'Editor → Raw puts the caret at the same column',
    Math.abs(backToRaw.at - (thirty.offset + 5)) <= 2,
    `expected offset ${thirty.offset + 5}, got ${backToRaw.at}`,
  );

  // Preview → Editor: two rendered panes, so the block at the top of one has to be
  // the block at the top of the other.
  await setView(win, 'view-md-btn');
  await win.evaluate(() => {
    const pane = document.getElementById('rendered');
    const p = [...pane.children].find((el) => el.textContent.startsWith('Paragraph 25'));
    pane.scrollTop += p.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
  await win.waitForTimeout(200);
  await setView(win, 'view-wys-btn');
  const intoWys = await win.evaluate(PANE_PROBE, 'wysiwyg');
  check(
    'Preview → Editor keeps the same block at the top',
    (intoWys.top || '').startsWith('Paragraph 25'),
    `the pane opens on ${JSON.stringify(intoWys.top)}`,
  );
  await win.screenshot({ path: path.join(out, '5-position.png') });

  // --- a nested folder expands ---------------------------------------------
  await setView(win, 'view-raw-btn');
  await openNote(win, vault, 'nested/deep.md');
  checkEqual('a note inside a folder opens', await win.inputValue('#editor'), '# Deep\n\nInside a folder.\n');

  // --- the recency list: the same files, flat and newest first --------------
  // The sidebar's second view. hello.md is the only note this run has edited, so it
  // must be at the top whatever order the fixture was written in — which is also
  // what shows the list is ordered by the mtime read on each refresh rather than by
  // anything the tree already had. The other three checks are what the flat list
  // has to add for itself: no folders, the folder a file sits in, and how long ago.
  await win.click('#tree-mode-recent-btn');
  await win.waitForTimeout(300);
  const recent = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree .node-row')];
    return {
      names: rows.map((r) => r.querySelector('.node-label')?.textContent ?? null),
      arrows: rows.filter((r) => r.querySelector('.node-arrow')).length,
      dirs: rows.map((r) => r.querySelector('.node-dir')?.textContent ?? null),
      when: rows[0]?.querySelector('.node-time')?.textContent ?? null,
      active: document.querySelector('#tree .node-row.active')?.dataset.path ?? null,
    };
  });
  // The four fixture notes plus the image the paste imported — every *file*,
  // wherever it lives, which is what the flat view is for.
  checkEqual('recency list holds every file, flat', recent.names.length, 5);
  checkEqual('recency list is newest first', recent.names[0], 'hello.md');
  check(
    'recency list holds no folder rows',
    recent.arrows === 0 && !recent.names.includes('nested'),
    JSON.stringify(recent.names),
  );
  check('a nested file says which folder it is in', recent.dirs.includes('nested/'), JSON.stringify(recent.dirs));
  check('the newest row says how long ago it changed', !!recent.when, 'no relative time', recent.when);
  checkEqual(
    'the open file stays highlighted across the rebuild',
    recent.active,
    path.join(vault, 'nested', 'deep.md'),
  );
  await win.screenshot({ path: path.join(out, '4-recent.png') });
  // Back to the tree: the mode is persisted, and a smoke run should not decide
  // which view an interactive one opens in.
  await win.click('#tree-mode-tree-btn');

  // A Flatpak has no direct view of host-installed programs. Exercise the
  // non-interactive Claude path separately from the pty path below when CI has
  // installed its controlled host stub.
  if (args.hostTools) {
    await win.fill('#smart-input', 'Does the host Claude bridge work?');
    await win.click('#smart-lookup-btn');
    await win.waitForFunction(
      () => document.getElementById('smart-status')?.textContent === 'Answered.',
      undefined,
      { timeout: 30_000 },
    );
    const answer = await text(win, '#smart-preview');
    check(
      'smart lookup reaches the host Claude CLI',
      answer?.includes('Flatpak host lookup works.'),
      JSON.stringify(answer),
    );
  }

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
    if (args.hostTools) {
      check('terminal pane finds the required host Claude CLI', false, 'the `claude` CLI is not on PATH here');
    } else {
      skip('terminal pane spawns a pty', 'the `claude` CLI is not on PATH here');
    }
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

    // Resizing the window fits the pane, which is what reaches `term-resize`.
    // What is asserted is that the session *survives* it, not that the TUI
    // reflows: under Flatpak it does not, and cannot — node-pty's TIOCSWINSZ
    // signals the foreground process group of the pty's session, and the
    // program on the other end was started by flatpak-session-helper in the
    // host's PID namespace, so it is not that group. Measured, with an
    // in-sandbox control that does receive the signal. The size itself is read
    // correctly (TIOCGWINSZ works on the forwarded fd), so a session opens at
    // the right size and only later resizes go unnoticed. flatpak-spawn has no
    // signal forwarding, and neither --share-pids nor --expose-pids applies to
    // --host, so there is nothing to fix on this side.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const [width, height] = w.getSize();
      w.setSize(width, Math.max(600, height - 160));
    });
    await win.waitForTimeout(1500);
    const afterResize = await win.evaluate(() => {
      const el = document.getElementById('terminal-status');
      return {
        running: el.classList.contains('running'),
        drawn: (document.querySelector('.xterm-rows')?.innerText || '').trim().length,
      };
    });
    check(
      'the pty survives a resize',
      afterResize.running && afterResize.drawn > 0,
      JSON.stringify(afterResize),
      `still live, ${afterResize.drawn} chars`,
    );
    await win.screenshot({ path: path.join(out, '5-terminal.png') });
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
        `${args.app ? `packaged build ${appBinary(args.app)}` : args.flatpak ? `Flatpak ${args.flatpak}` : 'the source tree'}, ` +
        `screenshots in ${args.out}`,
    );
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    for (const c of checks) console.log(`${c.ok === 'pass' ? '  ok' : c.ok}  ${c.name}`);
    console.error(`\nsmoke run threw: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
