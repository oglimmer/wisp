import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import {
  vaultPath,
  assertTextContent,
  assertReadableFile,
  MAX_TEXT_BYTES,
  isInside,
} from './guards.mjs';
import { noteOwnWrite } from './watch.mjs';
import { updateRefsAfterMove } from './refs.mjs';

const fsp = fs.promises;

// ---- File create / read / write / delete inside the vault ----

// Read a file as raw UTF-8 text.
handle('read-file', async (baseFolder, filePath) => {
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  assertReadableFile(target, MAX_TEXT_BYTES, 'File');
  return { ok: true, content: await fsp.readFile(target, 'utf8') };
});

// Write raw text back to a file.
handle('write-file', async (baseFolder, filePath, content) => {
  const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
  assertTextContent(content);
  // Before the write, not after: the watcher can see the change while writeFile is
  // still settling, and an event that arrives first would be treated as somebody
  // else's edit and reload the buffer the user is typing into.
  noteOwnWrite(target);
  await fsp.writeFile(target, content, 'utf8');
  return { ok: true };
});

// Synchronous write for the renderer's beforeunload flush. Blocks the renderer
// briefly, but guarantees the last edit is on disk before the window closes.
// Sent rather than invoked, so it can't go through `handle()`.
ipcMain.on('write-file-sync', (e, baseFolder, filePath, content) => {
  try {
    const target = vaultPath(baseFolder, filePath, 'Outside the vault.');
    assertTextContent(content);
    noteOwnWrite(target);
    fs.writeFileSync(target, content, 'utf8');
    e.returnValue = { ok: true };
  } catch (err) {
    e.returnValue = { ok: false, error: String(err) };
  }
});

// Create a new file. name may include subfolders (created as needed).
handle('create-file', async (baseFolder, relPath) => {
  const target = vaultPath(baseFolder, relPath);
  if (fs.existsSync(target)) return { ok: false, error: 'File already exists' };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, '', 'utf8');
  return { ok: true, path: target };
});

// Create a new folder.
handle('create-folder', async (baseFolder, relPath) => {
  const target = vaultPath(baseFolder, relPath);
  if (fs.existsSync(target)) return { ok: false, error: 'Folder already exists' };
  await fsp.mkdir(target, { recursive: true });
  return { ok: true, path: target };
});

// Delete a file or folder (must live inside the base folder). The vault root
// itself is inside the vault, so it needs ruling out separately.
// follow: false so a symlink that points outside can still be removed (rm acts
// on the entry; it does not delete the outside target).
handle('delete-path', async (baseFolder, target) => {
  const abs = vaultPath(baseFolder, target, 'Invalid path', { follow: false });
  // vaultPath has already thrown unless baseFolder is a string, which the type
  // checker can't see through — hence the cast rather than a second check.
  if (abs === path.resolve(/** @type {string} */ (baseFolder))) {
    return { ok: false, error: 'Invalid path' };
  }
  await fsp.rm(abs, { recursive: true, force: true });
  return { ok: true };
});

// Rename / move a file or folder within the base folder.
// follow: false on both ends: rename moves the directory entry (including a
// symlink) without writing through it.
handle('rename-path', async (baseFolder, oldPath, newName) => {
  if (typeof newName !== 'string' || !newName || newName.includes('\0')) {
    return { ok: false, error: 'Invalid name' };
  }
  const source = vaultPath(baseFolder, oldPath, 'Invalid path', { follow: false });
  const target = vaultPath(
    baseFolder,
    path.join(path.dirname(source), newName),
    'Invalid path',
    { follow: false }
  );
  if (fs.existsSync(target)) return { ok: false, error: 'Target already exists' };
  await fsp.rename(source, target);
  const updated = await updateRefsAfterMove(baseFolder, source, target);
  return { ok: true, path: target, updated };
});

// Move a file or folder into another folder in the vault — the tree's drag & drop.
//
// The move itself is a rename; the work is keeping the notes' references true
// (see updateRefsAfterMove). follow: false for the source, like rename-path — the
// directory entry moves rather than being written through. The destination is
// resolved with the default follow: true, because we write *into* it: a vault
// folder that symlinks outside must not be able to accept a move.
handle('move-path', async (baseFolder, target, destDir) => {
  const src = vaultPath(baseFolder, target, 'Invalid path', { follow: false });
  // vaultPath has already thrown unless baseFolder is a string, which the type
  // checker can't see through — hence the cast rather than a second check.
  const root = path.resolve(/** @type {string} */ (baseFolder));
  if (src === root) return { ok: false, error: 'Cannot move the vault itself' };

  const dir = vaultPath(baseFolder, destDir, 'Invalid destination');
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, error: 'Destination folder not found' };
  }
  if (!st.isDirectory()) return { ok: false, error: 'Destination is not a folder' };
  if (dir === path.dirname(src)) return { ok: false, error: 'Already in that folder' };
  // Covers dropping a folder on itself (isInside is true for an equal path) as
  // well as on anything below it, either of which would move it out of existence.
  if (isInside(src, dir)) return { ok: false, error: 'Cannot move a folder into itself' };

  const dest = vaultPath(baseFolder, path.join(dir, path.basename(src)), 'Invalid path', {
    follow: false,
  });
  if (fs.existsSync(dest)) return { ok: false, error: 'Target already exists' };

  await fsp.rename(src, dest);
  const updated = await updateRefsAfterMove(baseFolder, src, dest);
  return { ok: true, path: dest, updated };
});
