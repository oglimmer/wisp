import path from 'path';
import fs from 'fs';
import { isInside, assertReadableFile, MAX_TEXT_BYTES } from './guards.mjs';
import { isIgnored } from './tree.mjs';

const fsp = fs.promises;

// ---- Markdown references ----
//
// Notes point at other files — images above all — with ordinary Markdown refs,
// and two conventions are in the wild. A ref can be relative to the note that
// holds it (what this app writes), or relative to the vault root: Obsidian's
// "relative to vault root" setting writes `./dir/img.png` from a note sitting in
// a subfolder, which resolves nowhere note-relative. Both are resolved, and
// `move-path` rewrites a ref in whichever convention it already used rather than
// silently converting the vault to one of them.

// Files that can hold a ref worth rewriting. Every text file is a note here, so
// this is about skipping binaries, not about Markdown in particular.
const TEXT_REF_EXT = new Set(['.md', '.markdown', '.mdown', '.txt']);

// Inline links and images: `](target)`, `](<target>)`, `](target "title")`. The
// target group stops at whitespace, so the title (and the closing paren) stay in
// the trailing group and are put back untouched — and an unescaped space ends the
// target, which is what marked does too: `](./a b.png)` isn't a link at all.
// One level of *balanced* parens is allowed, because marked accepts those
// (`./a%20(1).png`); the refs this app writes escape them either way.
const MD_REF_RE = /(\]\(\s*)(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)([^)\n]*\))/g;

// A ref as a plain relative path, or null for anything that doesn't name a file
// on disk: a URL scheme, a protocol-relative or absolute URL, a bare anchor. A
// query or fragment is refused too — it would be dropped by a rewrite.
function refToRelPath(ref) {
  let value = String(ref).trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!value || value.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (value.includes('#') || value.includes('?')) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // A stray `%` that isn't an escape — take the ref literally.
  }
  if (!value || value.includes('\0') || path.isAbsolute(value)) return null;
  return value;
}

// Resolve a ref to the file it names inside the vault: note-relative first, then
// vault-root-relative. `exists` decides which candidate wins, so a ref is only
// ever claimed by a convention that actually finds a file, and `style` reports
// the one that hit so a rewrite can stay in it.
/** @param {(abs: string) => boolean} [exists] */
export function resolveVaultRef(baseFolder, noteDir, ref, exists = fs.existsSync) {
  const rel = refToRelPath(ref);
  if (rel === null) return null;
  const base = path.resolve(baseFolder);
  const candidates = [
    { abs: path.resolve(noteDir, rel), style: 'note' },
    { abs: path.resolve(base, rel), style: 'root' },
  ];
  for (const cand of candidates) {
    if (!isInside(base, cand.abs)) continue;
    if (exists(cand.abs)) return cand;
  }
  return null;
}

// Percent-encode a path for a Markdown ref, segment by segment so the separators
// survive: spaces (a ref ends at the first one) and the parens that would close
// `](…)` early.
function encodeRef(rel) {
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
}

// The ref text for `target`, written from `noteDir` in `style` — the convention
// the ref being replaced already used.
function refFor(baseFolder, noteDir, target, style) {
  const from = style === 'root' ? path.resolve(baseFolder) : noteDir;
  let rel = path.relative(from, target).split(path.sep).join('/');
  if (!rel) return null;
  if (!rel.startsWith('.')) rel = './' + rel;
  return encodeRef(rel);
}

// Rewrite every ref in `text` that a move invalidated. `mapTarget` maps a
// pre-move absolute path to its post-move one (identity for anything the move
// didn't touch), and `noteOldDir`/`noteNewDir` differ when the note itself moved
// — a note that changed folder has to re-aim even refs whose target stayed put.
//
// A ref whose target and note both stayed put is left exactly as written: this
// runs over every note in the vault, and re-encoding refs that nothing happened
// to would turn one move into a diff across the whole vault.
function rewriteMovedRefs(baseFolder, text, noteOldDir, noteNewDir, mapTarget) {
  let changed = 0;
  const out = text.replace(MD_REF_RE, (whole, open, ref, tail) => {
    // Existence is tested at the post-move location: the rename has already
    // happened, so a moved file is only findable through mapTarget.
    const hit = resolveVaultRef(baseFolder, noteOldDir, ref, (abs) =>
      fs.existsSync(mapTarget(abs))
    );
    if (!hit) return whole;
    const target = mapTarget(hit.abs);
    const targetMoved = target !== hit.abs;
    const noteMoved = hit.style === 'note' && noteNewDir !== noteOldDir;
    if (!targetMoved && !noteMoved) return whole;
    const next = refFor(baseFolder, noteNewDir, target, hit.style);
    if (!next || next === ref) return whole;
    changed++;
    return open + next + tail;
  });
  return { text: out, changed };
}

// Every text file in the vault, as absolute paths. Uses the same isIgnored() as
// the tree, so a move never rewrites anything the app doesn't show.
async function gatherTextFiles(baseFolder) {
  /** @type {string[]} */
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && TEXT_REF_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(baseFolder);
  return out;
}

// Keep the vault's Markdown refs true across a completed move (a rename is one
// too — of a folder, or of an image every note points at). Runs *after* the
// rename, so each ref is validated against where its target now is, and covers
// both directions: a note that moved re-aims its own refs, and a note that
// pointed at something moved follows it.
//
// Returns how many notes were rewritten. A ref-rewrite failure never fails the
// move itself — the files are already where the user asked for them, and an
// unreadable or oversized note is skipped rather than taking the move down.
export async function updateRefsAfterMove(baseFolder, src, dest) {
  // Pre-move ↔ post-move. The walk finds notes at their new paths, but their refs
  // were written relative to where they used to sit.
  const remap = (abs, from, to) => {
    if (abs === from) return to;
    const rel = path.relative(from, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(to, rel) : abs;
  };
  const mapTarget = (/** @type {string} */ abs) => remap(abs, src, dest);

  let updated = 0;
  for (const file of await gatherTextFiles(baseFolder)) {
    let text;
    try {
      assertReadableFile(file, MAX_TEXT_BYTES, 'File');
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const wasAt = remap(file, dest, src);
    const res = rewriteMovedRefs(
      baseFolder,
      text,
      path.dirname(wasAt),
      path.dirname(file),
      mapTarget
    );
    if (!res.changed) continue;
    try {
      await fsp.writeFile(file, res.text, 'utf8');
      updated++;
    } catch {
      // Read-only note, vanished mid-walk — leave it as it was.
    }
  }
  return updated;
}
