import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import { isIgnored } from './tree.mjs';
import { sendToWindow } from './window.mjs';

// ---- Watching the vault ----
//
// The terminal makes something new possible: the vault changing *while the app is
// running*, from outside the app. Everything the renderer shows is read from disk
// once and rebuilt on demand, so without this a file claude just wrote is invisible
// until the user hits refresh — and the open buffer would be written back over it
// by the next autosave.
//
// It watches, rather than guessing from the terminal's output, because there is no
// "task finished" byte in a pty: claude prints continuously while it works, and a
// statusline keeps printing when it doesn't. A pause is not a signal; a write is.
// This also covers the cases the terminal can't — the pane collapsed, another
// editor, a `git` command in a real terminal.

let vaultWatcher: fs.FSWatcher | null = null;
let vaultChangeTimer: ReturnType<typeof setTimeout> | null = null;
// A burst of writes (claude editing five files, git checking out a branch) is one
// change as far as the UI is concerned — it rebuilds everything either way.
const VAULT_DEBOUNCE_MS = 400;
// The app's own writes are not news: the autosave already knows what it wrote, and
// a refresh per keystroke-burst would re-read the whole tree for nothing.
const OWN_WRITE_MS = 1500;
const recentWrites = new Map<string, number>();

export function noteOwnWrite(target: string) {
  const now = Date.now();
  recentWrites.set(target, now);
  if (recentWrites.size > 200) {
    for (const [p, t] of recentWrites) if (now - t > OWN_WRITE_MS) recentWrites.delete(p);
  }
}

function stopVaultWatch() {
  if (vaultChangeTimer) clearTimeout(vaultChangeTimer);
  vaultChangeTimer = null;
  if (!vaultWatcher) return;
  try {
    vaultWatcher.close();
  } catch {}
  vaultWatcher = null;
}

function onVaultEvent(root: string, filename: string | Buffer | null) {
  // macOS can report an event with no name; there is nothing to filter it by, so
  // treat it as noise rather than refreshing on it.
  if (!filename) return;
  const rel = String(filename);
  // The same isIgnored() the tree uses, per path segment: without this every commit
  // would fire dozens of times over .git, and none of it is anything the UI shows.
  if (rel.split(path.sep).some(isIgnored)) return;
  const written = recentWrites.get(path.join(root, rel));
  if (written !== undefined && Date.now() - written < OWN_WRITE_MS) return;
  if (vaultChangeTimer) clearTimeout(vaultChangeTimer);
  vaultChangeTimer = setTimeout(() => {
    vaultChangeTimer = null;
    sendToWindow('vault-changed');
  }, VAULT_DEBOUNCE_MS);
}

// Watch the open vault, replacing any previous watch. Called on every vault open,
// so there is exactly one watcher and it always points at what is on screen.
handle('watch-vault', async (baseFolder) => {
  stopVaultWatch();
  if (typeof baseFolder !== 'string' || !fs.existsSync(baseFolder)) {
    return { ok: false, error: 'No folder is open.' };
  }
  try {
    vaultWatcher = fs.watch(baseFolder, { recursive: true }, (_type, filename) =>
      onVaultEvent(baseFolder, filename)
    );
  } catch (err) {
    // A vault on a filesystem that can't be watched still works; it just doesn't
    // refresh itself, which is what the app did before this existed.
    return { ok: false, error: String(err) };
  }
  // The watcher must never take the app down: a vanished folder or an exhausted
  // handle limit arrives here as an error event, not a throw at the call site.
  vaultWatcher.on('error', () => stopVaultWatch());
  return { ok: true };
});
