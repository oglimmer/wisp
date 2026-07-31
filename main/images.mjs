import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import {
  vaultPath,
  assertInsideVault,
  assertReadableFile,
  formatBytesLimit,
  MAX_IMAGE_BYTES,
} from './guards.mjs';
import { resolveVaultRef } from './refs.mjs';
import { noteOwnWrite } from './watch.mjs';

const fsp = fs.promises;

// Image extensions we can embed (preview) and import (drag & drop), mapped to
// the MIME type used when inlining them as data URLs.
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

// The inverse map, for data URLs arriving from the clipboard: the MIME says what
// the bytes are, and the extension follows from it (the first spelling wins, so
// image/jpeg lands as `.jpg`).
const MIME_EXT = {};
for (const [ext, mime] of Object.entries(IMAGE_MIME)) {
  if (!MIME_EXT[mime]) MIME_EXT[mime] = ext;
}

// ---- Images ----

// Resolve a Markdown image reference (relative to the open file) and return it as
// a base64 data URL. The renderer swaps these in after rendering because the
// app's app:// origin + CSP won't load vault-relative image paths directly.
// Only local paths that stay inside the vault (after symlink resolution) are served.
handle('read-image', async (baseFolder, currentFile, src) => {
  if (!baseFolder || !src) return { ok: false };
  const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
  // Note-relative first, then vault-root-relative — an Obsidian-written ref from a
  // note in a subfolder is `./dir/img.png` and resolves nowhere note-relative. The
  // candidate has to *be* an image for the fallback to be taken, so the second
  // convention can't claim a ref the first one already answered.
  const hit = resolveVaultRef(
    baseFolder,
    fromDir,
    src,
    (abs) => !!IMAGE_MIME[path.extname(abs).toLowerCase()] && fs.existsSync(abs)
  );
  if (!hit) return { ok: false };
  const target = hit.abs;
  try {
    assertInsideVault(baseFolder, target, 'Outside the vault.');
    assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  } catch {
    return { ok: false };
  }
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return { ok: false };
  const buf = await fsp.readFile(target);
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
});

// Open an image file picked in the tree. Same idea as `read-image`, but the target
// is an absolute vault path rather than a Markdown reference resolved against the
// open note — the renderer shows the picture instead of the editor showing bytes.
handle('read-image-file', async (baseFolder, filePath) => {
  if (!baseFolder || !filePath) return { ok: false, error: 'No file.' };
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return { ok: false, error: 'Unsupported image type.' };
  const st = assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  const buf = await fsp.readFile(target);
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    size: st.size,
  };
});

// Where an imported image lands: `images/<url-safe name><ext>` inside the vault,
// deduped against what is already there. Shared by both import routes, so a
// dropped file and a pasted one are named and placed by the same rules.
async function imageDest(baseFolder, nameHint, ext) {
  const imagesDir = path.join(baseFolder, 'images');
  // Ensure images/ itself stays inside the vault even if baseFolder is odd.
  assertInsideVault(baseFolder, imagesDir, 'Outside the vault.');
  await fsp.mkdir(imagesDir, { recursive: true });

  // URL-safe base name (avoids escaping headaches in Markdown refs / data-url resolution).
  const base =
    path
      .basename(nameHint || '', path.extname(nameHint || ''))
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  let name = base + ext;
  let n = 1;
  while (fs.existsSync(path.join(imagesDir, name))) {
    name = `${base}-${n}${ext}`;
    n++;
  }
  return vaultPath(baseFolder, path.join('images', name), 'Outside the vault.');
}

// The Markdown reference the renderer inserts: relative to the open file, so it
// works in the raw source and the rendered preview alike and stays portable if
// the vault moves.
function refFor(baseFolder, currentFile, dest) {
  const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
  return path.relative(fromDir, dest).split(path.sep).join('/');
}

// Copy a dropped image file into the vault's `images/` folder and answer with a
// reference to it.
//
// The source is intentionally outside the vault (OS drag-and-drop). We still:
// refuse non-files / oversized inputs, and write the destination through vaultPath
// so a compromised renderer cannot use this channel to write outside the vault.
handle('import-image', async (baseFolder, currentFile, srcPath, originalName) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (typeof srcPath !== 'string' || !srcPath || srcPath.includes('\0')) {
    return { ok: false, error: 'Source file not found.' };
  }
  // Resolve the source for the size/type check (follows symlinks — importing a
  // link to a huge file should still hit the cap on the real target).
  let srcReal;
  try {
    srcReal = fs.realpathSync(srcPath);
    assertReadableFile(srcReal, MAX_IMAGE_BYTES, 'Image');
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Source file not found.' };
  }
  const ext = path.extname(originalName || srcPath).toLowerCase();
  if (!IMAGE_MIME[ext]) return { ok: false, error: 'Unsupported image type.' };

  const dest = await imageDest(baseFolder, originalName || srcPath, ext);
  noteOwnWrite(dest); // the vault watcher is not news about our own import
  await fsp.copyFile(srcReal, dest);
  return { ok: true, path: dest, ref: refFor(baseFolder, currentFile, dest) };
});

// A `data:image/…` URL, decoded and checked, or the reason it isn't one. The
// payload is *not* trusted: the MIME has to name an image type the app knows,
// base64 has to be base64, and the size cap is applied to the encoded length
// first so an oversized paste is refused before it is decoded into memory.
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[^,]*)*),([\s\S]*)$/i;
function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, error: 'Not an image.' };
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return { ok: false, error: 'Not a data URL.' };
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) return { ok: false, error: 'Unsupported image type.' };
  const tooBig = { ok: false, error: `Image is too large (max ${formatBytesLimit(MAX_IMAGE_BYTES)}).` };

  let buf;
  if (/(^|;)base64(;|$)/i.test(m[2])) {
    const b64 = m[3].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      return { ok: false, error: 'Malformed image data.' };
    }
    if ((b64.length / 4) * 3 > MAX_IMAGE_BYTES) return tooBig;
    buf = Buffer.from(b64, 'base64');
  } else {
    // The other data-URL form: percent-encoded text, which is how an SVG usually
    // arrives when it isn't base64'd.
    if (m[3].length > MAX_IMAGE_BYTES) return tooBig;
    try {
      buf = Buffer.from(decodeURIComponent(m[3]), 'utf8');
    } catch {
      return { ok: false, error: 'Malformed image data.' };
    }
  }
  if (!buf.length) return { ok: false, error: 'Empty image.' };
  if (buf.length > MAX_IMAGE_BYTES) return tooBig;
  return { ok: true, buf, ext };
}

// What a pasted image is called. It has no name of its own — a screenshot on the
// clipboard is bytes, and an inlined `data:` URL carries nothing but its MIME — so
// the one thing it can be named after is when it arrived: `pasted-20260731-142530`.
// Local time, like every other date in this app, and in a form that sorts by date
// and needs no escaping in a Markdown ref. Two in the same second are told apart by
// imageDest()'s dedupe, exactly as two files of the same name are.
function pastedName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `pasted-${day}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// The paste route: the same import as above, but from bytes rather than a path.
// An image on the clipboard has no file behind it (a screenshot, "Copy Image"),
// and Markdown pasted from another app carries its pictures inline as
// `![](data:image/png;base64,…)` — both become a file in images/ and an ordinary
// reference, because base64 written into the note is a megabyte on one line that
// no diff, search or WYSIWYG fold can do anything with.
//
// There is no name to pass in: the clipboard is the only source this channel has,
// so the name is stamped here rather than trusted from the renderer.
handle('import-image-data', async (baseFolder, currentFile, dataUrl) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  const decoded = decodeImageDataUrl(dataUrl);
  if (!decoded.ok) return { ok: false, error: decoded.error };

  const dest = await imageDest(baseFolder, pastedName(), decoded.ext);
  noteOwnWrite(dest);
  await fsp.writeFile(dest, decoded.buf);
  return { ok: true, path: dest, ref: refFor(baseFolder, currentFile, dest) };
});
