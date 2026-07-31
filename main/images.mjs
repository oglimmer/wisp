import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import {
  vaultPath,
  assertInsideVault,
  assertReadableFile,
  MAX_IMAGE_BYTES,
} from './guards.mjs';
import { resolveVaultRef } from './refs.mjs';

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

// Copy a dropped image file into the vault's `images/` folder (deduping the name)
// and return a Markdown reference relative to the open file so it works both in
// the raw source and the rendered preview, and stays portable if the vault moves.
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

  const imagesDir = path.join(baseFolder, 'images');
  // Ensure images/ itself stays inside the vault even if baseFolder is odd.
  assertInsideVault(baseFolder, imagesDir, 'Outside the vault.');
  await fsp.mkdir(imagesDir, { recursive: true });

  // URL-safe base name (avoids escaping headaches in Markdown refs / data-url resolution).
  let base =
    path
      .basename(originalName || srcPath, path.extname(originalName || srcPath))
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  let name = base + ext;
  let n = 1;
  while (fs.existsSync(path.join(imagesDir, name))) {
    name = `${base}-${n}${ext}`;
    n++;
  }
  const dest = vaultPath(baseFolder, path.join('images', name), 'Outside the vault.');
  await fsp.copyFile(srcReal, dest);

  const fromDir = currentFile ? path.dirname(currentFile) : baseFolder;
  const ref = path.relative(fromDir, dest).split(path.sep).join('/');
  return { ok: true, path: dest, ref };
});
