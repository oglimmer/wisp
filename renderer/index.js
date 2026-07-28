// Entry point: wire the UI up, then start the app.

import { api } from './api.js';
import { chooseFolder, init } from './app.js';
import { dialogOpen } from './dialogs.js';
import { showChangedFiles } from './diff.js';
import { diffRawBtn, diffVisualBtn, editorEl, gitDiffBtn, gitPullBtn, gitPushBtn, newReminderBtn, renderedEl, smartAddBtn, smartCheckBtn, smartInputEl, smartLookupBtn, viewDiffBtn, viewMdBtn, viewRawBtn, viewWysBtn } from './dom.js';
import { cancelPendingSave, flushSave } from './editor.js';
import { closeFind, findOpen, findStep, openFind } from './find.js';
import { gitPull, refreshGit } from './git.js';
import { gitCommitPush } from './git-commit.js';
import { flushPositions } from './positions.js';
import { newReminder } from './reminders-ui.js';
import { invalidateSmartPlan, smartAdd, smartCheck, smartLookup } from './smart.js';
import { state } from './state.js';
import { runTableOp, tableOpFor } from './tables.js';
import { newFile, newFolder, refreshTree } from './tree.js';
import { setDiffMode, setViewMode, syncWysiwygToEditor } from './views.js';

// ---- Wire up buttons & shortcuts ----
document.getElementById('welcome-open-btn').addEventListener('click', chooseFolder);
document.getElementById('change-folder-btn').addEventListener('click', chooseFolder);
document.getElementById('refresh-btn').addEventListener('click', refreshTree);
document.getElementById('new-file-btn').addEventListener('click', newFile);
document.getElementById('new-folder-btn').addEventListener('click', newFolder);
smartCheckBtn.addEventListener('click', smartCheck);
smartAddBtn.addEventListener('click', smartAdd);
smartLookupBtn.addEventListener('click', smartLookup);
smartInputEl.addEventListener('input', invalidateSmartPlan);
newReminderBtn.addEventListener('click', () => newReminder(null));
// stopPropagation: this same click would otherwise reach the document-level
// listener that dismisses context menus, closing the list as soon as it opens.
gitDiffBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  showChangedFiles(gitDiffBtn);
});
viewDiffBtn.addEventListener('click', () => setViewMode('diff'));
diffVisualBtn.addEventListener('click', () => setDiffMode('visual'));
diffRawBtn.addEventListener('click', () => setDiffMode('raw'));
gitPullBtn.addEventListener('click', gitPull);
gitPushBtn.addEventListener('click', gitCommitPush);

// A vault can be changed from outside the app (a terminal `git` command, another
// editor), so re-read status whenever the window comes back to the front.
window.addEventListener('focus', () => {
  if (state.baseFolder) refreshGit();
});
viewRawBtn.addEventListener('click', () => setViewMode('raw'));
viewWysBtn.addEventListener('click', () => setViewMode('wysiwyg'));
viewMdBtn.addEventListener('click', () => setViewMode('preview'));
// Turndown powers WYSIWYG→Markdown; if it didn't load, don't offer the mode.
if (!window.TurndownService) viewWysBtn.classList.add('hidden');

// Links in the rendered Markdown must not navigate the app window. Open
// http(s)/mailto links in the real browser; ignore relative/in-vault links.
renderedEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href) api.openExternal(href);
});


window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') {
    e.preventDefault();
    flushSave();
    return;
  }

  // A modal or reminder popup owns the keyboard while it's up (they handle their
  // own Escape / Enter on the capture phase).
  if (dialogOpen()) return;

  const tableOp = tableOpFor(e);
  if (tableOp) {
    e.preventDefault();
    runTableOp(tableOp);
    return;
  }

  const key = e.key.toLowerCase();
  // ⌘⌥F opens replace on macOS, where ⌘H is taken by Hide; Ctrl+H is the
  // Windows/Linux equivalent.
  if (mod && key === 'f' && !e.shiftKey) {
    e.preventDefault();
    openFind(e.altKey);
  } else if (
    e.ctrlKey &&
    !e.metaKey &&
    api.platform !== 'darwin' &&
    key === 'h' &&
    !e.altKey &&
    !e.shiftKey
  ) {
    e.preventDefault();
    openFind(true);
  } else if ((mod && key === 'g') || e.key === 'F3') {
    e.preventDefault();
    if (findOpen) findStep(e.shiftKey ? -1 : 1);
    else openFind(false);
  } else if (e.key === 'Escape' && findOpen) {
    e.preventDefault();
    closeFind();
  }
});

// On close, flush synchronously so a pending edit can't be lost to the window
// going away before an async write finishes.
window.addEventListener('beforeunload', () => {
  cancelPendingSave();
  // Positions persist debounced; write out the last few seconds of reading too.
  flushPositions();
  if (state.currentFile && state.dirty) {
    syncWysiwygToEditor();
    const res = api.writeFileSync(state.baseFolder, state.currentFile, editorEl.value);
    if (res && res.ok) state.dirty = false;
  }
});

// Everything is wired; open the last vault (or the welcome screen).
init();
