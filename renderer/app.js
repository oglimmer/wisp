// Opening a vault and the startup path.

import { api } from './api.js';
import { currentFileEl, editorEl, vaultNameEl, welcomeEl, workspaceEl } from './dom.js';
import { resetGitState } from './git.js';
import { restoreRowDividers } from './layout.js';
import { loadPositions } from './positions.js';
import { loadReminders } from './reminders.js';
import { resetSmartPanel } from './smart.js';
import { state } from './state.js';
import { expanded, refreshTree } from './tree.js';
import { applyView } from './views.js';

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
}

export async function chooseFolder() {
  const folder = await api.chooseFolder();
  if (folder) {
    expanded.clear();
    await openFolder(folder);
  }
}
