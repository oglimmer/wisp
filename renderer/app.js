// Opening a vault and the startup path.

import { api } from './api.js';
import { currentFileEl, editorEl, vaultNameEl, welcomeEl, workspaceEl } from './dom.js';
import { resetGitState } from './git.js';
import { restoreRowDividers } from './layout.js';
import { loadPositions } from './positions.js';
import { loadReminders } from './reminders.js';
import { resetSmartPanel } from './smart.js';
import { state } from './state.js';
import { terminalVaultChanged } from './terminal.js';
import { expanded, refreshTree } from './tree.js';
import { applyView } from './views.js';
import { watchVault } from './watch.js';

export async function init() {
  const last = await api.getLastFolder();
  if (last) {
    await openFolder(last);
  } else {
    showWelcome();
  }
}

function showWelcome() {
  welcomeEl.classList.remove('hidden');
  workspaceEl.classList.add('hidden');
}

async function openFolder(folder) {
  state.baseFolder = folder;
  state.currentFile = null;
  // Before anything can open a file: caret/scroll positions are per vault.
  loadPositions(folder);
  state.diffOnlyFile = null;
  state.dirty = false;
  welcomeEl.classList.add('hidden');
  workspaceEl.classList.remove('hidden');
  restoreRowDividers();
  vaultNameEl.textContent = folder.split(/[\\/]/).pop() || folder;
  vaultNameEl.title = folder;
  currentFileEl.textContent = 'No file open';
  editorEl.value = '';
  editorEl.disabled = true;
  applyView();
  resetSmartPanel();
  resetGitState();
  await refreshTree();
  await loadReminders();
  // Watch this folder rather than the last one: the terminal below works in the
  // vault while the app is open, and so can anything else.
  watchVault();
  // Last, and not before: the terminal runs `claude` *in* the vault, so a new
  // vault is a new session — and fitting it needs the workspace already on screen,
  // same reason the row dividers restore late.
  await terminalVaultChanged();
}

export async function chooseFolder() {
  const folder = await api.chooseFolder();
  if (folder) {
    expanded.clear();
    await openFolder(folder);
  }
}
