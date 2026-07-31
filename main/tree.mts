import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import type { TreeNode } from '../types/ipc';

const fsp = fs.promises;

// Entries we never want to show in the tree. Anything dot-prefixed is treated as
// hidden — that covers VCS metadata, OS cruft, other editors' per-vault config
// folders (and the vault's own `.wisp-reminders.json`) — plus this explicit list
// of the rest.
const IGNORED = new Set(['node_modules']);

export function isIgnored(name: string) {
  return name.startsWith('.') || IGNORED.has(name);
}

// Last-modified time in epoch ms, or 0 for anything that can't be stat'd (a
// symlink to nowhere, an entry deleted between the readdir and here). The
// recency list sorts on this, and 0 sorts to the bottom rather than the top.
async function mtimeOf(filePath: string) {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

// Recursively build a folder/file tree rooted at dirPath.
async function buildTree(dirPath: string): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        type: 'dir',
        children: await buildTree(full),
      });
    } else if (entry.isFile()) {
      // `mtime` is what the sidebar's recency list sorts by. It is read here,
      // during the walk, rather than in a second pass: the tree is rebuilt whole
      // on every change anyway, so a stat per file is the cheapest place to get it
      // and both views then come out of one call.
      nodes.push({ name: entry.name, path: full, type: 'file', mtime: await mtimeOf(full) });
    }
  }

  // Folders first, then files, each alphabetical (case-insensitive).
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return nodes;
}

// Build the tree for a given base folder.
ipcMain.handle('read-tree', async (_e, baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return null;
  return {
    name: path.basename(baseFolder) || baseFolder,
    path: baseFolder,
    type: 'dir',
    children: await buildTree(baseFolder),
  };
});
