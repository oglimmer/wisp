// Re-reading the vault when something outside the app changes it.
//
// The terminal pane is what makes this necessary — claude works in the vault while
// the app is open — but nothing here is specific to it: an edit from another editor
// or a `git checkout` in a real terminal arrives the same way. main watches the
// folder and sends one debounced `vault-changed`; this decides what to re-read.
//
// **Not driven by the terminal's output.** A pty carries bytes, not "the task
// finished": claude prints continuously while it works, and a statusline keeps
// printing when it doesn't, so a pause in the output is not a signal — and waiting
// for one would miss every change made with the pane collapsed.

import { api } from './api.js';
import { editorEl, treeEl } from './dom.js';
import { openFile } from './editor.js';
import { refreshGit } from './git.js';
import { loadReminders } from './reminders.js';
import { state } from './state.js';
import { refreshTree } from './tree.js';
import { cssEscape, relativePath, setStatus } from './util.js';
import { isImage } from './views.js';

let syncing = false;
let queued = false;

// Start (or move) the watch. Called from openFolder once the vault is open, and it
// replaces the previous vault's watch in main.
export function watchVault() {
  if (state.baseFolder) api.watchVault(state.baseFolder);
}

// Everything the UI reads from disk, read again. Same shape as the rest of the app:
// rebuild whole, don't patch — the tree, git status and the reminder list are all
// re-read rather than reconciled against what changed.
async function syncVault() {
  if (!state.baseFolder) return;
  // A change landing mid-sync queues one more pass rather than interleaving with
  // this one: claude writing five files must not start five overlapping rebuilds.
  if (syncing) {
    queued = true;
    return;
  }
  syncing = true;
  try {
    do {
      queued = false;
      await refreshTree();
      await refreshGit();
      await loadReminders();
      await reloadOpenFile();
    } while (queued);
  } finally {
    syncing = false;
  }
}

// The open buffer is the one thing a rebuild can't fix: it was read before the
// change, and the next autosave would write it back over what just landed.
async function reloadOpenFile() {
  const open = state.currentFile;
  // A dirty buffer is left alone: re-opening it flushes the user's unsaved edits
  // over the new content first, so the reload would save the very thing it is
  // supposed to be replacing. Their own edit wins; it is the one they can see.
  // An image has no text to compare, and the tree refresh already re-read it.
  if (!open || state.dirty || isImage(open)) return;
  const res = await api.readFile(state.baseFolder, open);
  // Unreadable now means deleted or moved — the rebuilt tree already says so, and
  // there is nothing to reload it to.
  if (!res.ok || res.content === editorEl.value) return;
  const row = treeEl.querySelector(`[data-path="${cssEscape(open)}"]`);
  await openFile(open, row || null);
  // Last: openFile ends by reporting 'Saved', which would otherwise be all that was
  // left of the reload the user didn't ask for.
  setStatus(`Reloaded ${relativePath(open)} — changed on disk`);
}

api.onVaultChanged(() => syncVault());
