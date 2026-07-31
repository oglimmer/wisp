import path from 'path';
import fs from 'fs';

// Caps so a huge file cannot balloon main/renderer memory (images become base64
// data URLs in the UI, so the in-memory cost is larger than the on-disk size).
export const MAX_TEXT_BYTES = 8 * 1024 * 1024; // notes opened / written as text
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // preview / import / analyze

export function formatBytesLimit(n) {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Guard against path-traversal: ensure `target` stays inside `base` (lexical —
// does not follow symlinks; see vaultPath for the symlink-aware check).
export function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Walk up from absPath until realpath succeeds. Returns the real path of the
// nearest existing ancestor and the missing basename segments below it (empty
// when absPath itself exists). Used so create/write into a not-yet-existing
// path still refuses a parent that symlinks out of the vault.
function realpathExisting(absPath) {
  let cursor = path.resolve(absPath);
  const missing = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(cursor), missing };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Symlink-aware containment. Lexical path must sit under baseFolder, and the
// realpath-resolved location must too.
//
// `follow` (default true) is for content access (read/write): the final resolved
// path must stay inside the vault, so a vault entry that is a symlink pointing
// outside cannot be used to read or overwrite files elsewhere.
//
// `follow: false` is for entry operations (delete, rename source): those act on
// the directory entry itself (removing a symlink does not touch its target), so
// only the parent directory must resolve inside the vault.
export function assertInsideVault(baseFolder, absPath, label = 'Invalid path', { follow = true } = {}) {
  const base = path.resolve(baseFolder);
  const abs = path.resolve(absPath);
  if (!isInside(base, abs)) throw new Error(label);

  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    throw new Error(label);
  }

  try {
    if (follow) {
      const { real, missing } = realpathExisting(abs);
      // basenames only in `missing` (from path.basename), so join cannot reintroduce `..`.
      const resolved = missing.length ? path.resolve(path.join(real, ...missing)) : real;
      if (!isInside(realBase, resolved)) throw new Error(label);
    } else {
      const parent = path.dirname(abs);
      const { real, missing } = realpathExisting(parent);
      const resolvedParent = missing.length ? path.resolve(path.join(real, ...missing)) : real;
      if (!isInside(realBase, resolvedParent)) throw new Error(label);
    }
  } catch (err) {
    if (err && err.message === label) throw err;
    throw new Error(label);
  }
  return abs;
}

// Refuse files that are not regular files or that exceed a byte budget *before*
// reading them into memory.
export function assertReadableFile(filePath, maxBytes, what = 'File') {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw new Error(`${what} not found.`);
  }
  if (!st.isFile()) throw new Error(`${what} is not a regular file.`);
  if (st.size > maxBytes) {
    throw new Error(`${what} is too large (max ${formatBytesLimit(maxBytes)}).`);
  }
  return st;
}

// Resolve a target the renderer supplied and refuse anything outside the vault.
// Throws rather than returning a value, so the guard cannot be written and then
// accidentally ignored — `handle()` turns it into the usual `{ ok: false }`.
// See assertInsideVault for the `follow` option (content vs entry ops).
export function vaultPath(baseFolder, target, label = 'Invalid path', opts) {
  if (typeof baseFolder !== 'string' || typeof target !== 'string') throw new Error(label);
  if (target.includes('\0')) throw new Error(label);
  const abs = path.resolve(baseFolder, target);
  return assertInsideVault(baseFolder, abs, label, opts);
}

// UTF-8 text payload for write handlers: type-check and size-cap before disk I/O.
export function assertTextContent(content, maxBytes = MAX_TEXT_BYTES) {
  if (typeof content !== 'string') throw new Error('Invalid content.');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`Content is too large (max ${formatBytesLimit(maxBytes)}).`);
  }
  return content;
}
