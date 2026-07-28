// Git status, the git bar, tree decoration, and pull. The vault is often but not
// always a repository, so all of this is conditional.

import { api } from './api.js';
import { renderDiffPane } from './diff.js';
import { gitBarEl, gitBranchEl, gitDiffBtn, gitDirtyEl, gitPullBtn, gitPushBtn, gitSyncEl, treeEl } from './dom.js';
import { flushSave, openFile } from './editor.js';
import { state } from './state.js';
import { refreshTree } from './tree.js';
import { setStatus } from './util.js';
import { effectiveViewMode } from './views.js';

// The vault is *often* a git repository, but never has to be: `gitState` is null
// for a plain folder and every piece of git UI hides itself. Status is read whole
// (like the tree and the reminder list) and re-applied to the rendered rows, so
// there is no incremental bookkeeping to fall out of sync with the repository.

// Single letter shown in the tree, and what the row's colour means.
export const GIT_LETTER = {
  modified: 'M',
  added: 'A',
  untracked: '?',
  deleted: 'D',
  renamed: 'R',
  conflict: '!',
};
const GIT_KIND_LABEL = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'Untracked',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflict: 'Conflicted',
};

// The LCS table is O(n×m); past this many cells the visual diff is refused and the
// viewer falls back to git's own patch, which costs nothing to display.
export const DIFF_MAX_CELLS = 1500000;
export const WORD_DIFF_MAX_CELLS = 40000;

export let gitState = null; // last git-info result; null when the folder isn't a repo
export const gitFileStatus = new Map(); // abs file path -> status entry
export const gitDirtyDirs = new Set(); // abs dir paths with a changed descendant
export let gitBusy = false; // a pull/commit is running; the bar's buttons are disabled
let gitRefreshing = false;
let gitRefreshQueued = false;
let gitRefreshPromise = null;
let gitRefreshTimer = null;

// Re-read status and repaint. Coalesces: a refresh asked for while one is in flight
// queues one more run rather than piling up (the tree refresh, the autosave and the
// git buttons all ask for one). A caller that awaits it always waits for a cycle
// that includes *its* request — the in-flight promise only settles once the queue
// has drained — so `await refreshGit()` never leaves `gitState` stale.
export function refreshGit() {
  if (!state.baseFolder) {
    gitState = null;
    renderGitBar();
    return Promise.resolve();
  }
  if (gitRefreshing) {
    gitRefreshQueued = true;
    return gitRefreshPromise;
  }
  gitRefreshing = true;
  gitRefreshPromise = (async () => {
    try {
      do {
        gitRefreshQueued = false;
        const folder = state.baseFolder;
        const info = await api.gitInfo(folder);
        if (folder !== state.baseFolder) return; // the vault changed under us
        gitState = info && info.ok && info.repo ? info : null;
        indexGitStatus();
        renderGitBar();
        applyGitDecorations();
        // The diff pane shows what git thinks; if that just changed, redraw it.
        if (effectiveViewMode() === 'diff') renderDiffPane();
      } while (gitRefreshQueued);
    } finally {
      gitRefreshing = false;
    }
  })();
  return gitRefreshPromise;
}

// Saving doesn't rebuild the tree, but it does change what git thinks — so nudge a
// refresh shortly after, debounced so a burst of autosaves costs one `git status`.
// Drop the previous vault's git state. Called before the new tree renders, so the
// old folder's decorations can't briefly appear against the new folder's files.
export function resetGitState() {
  gitState = null;
  gitFileStatus.clear();
  gitDirtyDirs.clear();
  renderGitBar();
}

export function scheduleGitRefresh() {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(() => {
    gitRefreshTimer = null;
    refreshGit();
  }, 600);
}

// Build the two lookups the tree decoration needs: per-file status, and the set of
// folders holding something changed (so a collapsed folder still shows it has).
function indexGitStatus() {
  gitFileStatus.clear();
  gitDirtyDirs.clear();
  if (!gitState) return;
  const sep = state.baseFolder.includes('\\') ? '\\' : '/';
  for (const file of gitState.files) {
    gitFileStatus.set(file.path, file);
    let dir = file.path;
    while (dir.length > state.baseFolder.length) {
      const cut = dir.lastIndexOf(sep);
      if (cut < 0) break;
      dir = dir.slice(0, cut);
      if (dir.length >= state.baseFolder.length) gitDirtyDirs.add(dir);
    }
  }
}

// What a status entry means in words, for the row's tooltip.
export function gitEntryTitle(entry) {
  const label = GIT_KIND_LABEL[entry.kind] || 'Changed';
  if (entry.kind === 'untracked') return 'Untracked — not in git yet';
  if (entry.kind === 'conflict') return 'Conflicted — resolve before committing';
  const staged = entry.index !== ' ' && entry.index !== '?';
  const unstaged = entry.work !== ' ' && entry.work !== '?';
  const where = staged && unstaged ? 'staged + unstaged' : staged ? 'staged' : 'not staged';
  const from = entry.from ? ` from ${entry.from}` : '';
  return `${label}${from} — ${where}`;
}

// Paint the current status onto the rendered tree. Kept separate from renderNode so
// a status refresh doesn't have to rebuild (and collapse) the tree.
export function applyGitDecorations() {
  for (const row of treeEl.querySelectorAll('.node-row[data-path]')) {
    const existing = row.querySelector('.git-badge');
    if (existing) existing.remove();
    row.removeAttribute('data-git');

    const entry = gitFileStatus.get(row.dataset.path);
    if (entry) {
      row.dataset.git = entry.kind;
      row.appendChild(gitBadge(GIT_LETTER[entry.kind] || 'M', gitEntryTitle(entry)));
    } else if (gitDirtyDirs.has(row.dataset.path)) {
      // A folder itself is never "modified"; the dot says something inside it is.
      row.dataset.git = 'dir';
      row.appendChild(gitBadge('•', 'Contains changes'));
    }
  }
}

function gitBadge(text, title) {
  const badge = document.createElement('span');
  badge.className = 'git-badge';
  badge.textContent = text;
  badge.title = title;
  return badge;
}

export function renderGitBar() {
  if (!gitState) {
    gitBarEl.classList.add('hidden');
    return;
  }
  gitBarEl.classList.remove('hidden');

  gitBranchEl.textContent = gitState.detached ? 'detached HEAD' : gitState.branch || '(unknown)';
  gitBranchEl.title = gitState.upstream
    ? `Tracking ${gitState.upstream}`
    : 'This branch has no upstream';

  // Behind first, then ahead — the order you'd act on them in.
  const sync = [];
  if (gitState.behind) sync.push('↓' + gitState.behind);
  if (gitState.ahead) sync.push('↑' + gitState.ahead);
  gitSyncEl.textContent = sync.join(' ');
  gitSyncEl.title = sync.length
    ? `${gitState.behind} to pull, ${gitState.ahead} to push`
    : '';

  const n = gitState.files.length;
  gitDirtyEl.textContent = n ? `${n} change${n === 1 ? '' : 's'}` : '';
  gitDirtyEl.classList.toggle('clean', n === 0);

  const conflicts = gitState.files.some((f) => f.kind === 'conflict');
  gitBarEl.classList.toggle('conflicted', conflicts);

  gitDiffBtn.disabled = gitBusy || n === 0;
  gitPullBtn.disabled = gitBusy || !gitState.upstream;
  gitPushBtn.disabled = gitBusy;
  gitPullBtn.title = gitState.upstream ? `Pull from ${gitState.upstream}` : 'No upstream to pull from';
}

export function setGitBusy(busy, message) {
  gitBusy = busy;
  gitBarEl.classList.toggle('busy', busy);
  if (message !== undefined) setStatus(message);
  renderGitBar();
}

// ---- Pull ----
export async function gitPull() {
  if (!gitState || gitBusy) return;
  // Land any pending edit first: a merge that touches the open file must not race
  // an autosave, and the reload below would otherwise drop the unsaved change.
  await flushSave();

  setGitBusy(true, 'Pulling…');
  const res = await api.gitPull(state.baseFolder);
  setGitBusy(false);

  if (res.ok) {
    await afterGitChange(summarizePull(res.output));
  } else if (res.conflict) {
    // The merge started and stopped on a conflict: the files are now marked in the
    // tree, so point at them rather than dumping git's output.
    await afterGitChange('Pull stopped on a conflict — resolve the marked files.', true);
  } else {
    await afterGitChange('Pull failed: ' + gitErrorLine(res.error), true);
  }
}

// A pull or a commit can rewrite files on disk, so rebuild the tree, re-read status
// and re-open the current file — what's on screen has to match what's on disk. The
// message is set *last* because re-opening the file reports its own 'Saved', which
// would otherwise be the only thing left of the result the user asked for.
export async function afterGitChange(message, isError) {
  const open = state.currentFile;
  await refreshTree();
  if (open) {
    const row = treeEl.querySelector(`[data-path="${cssEscape(open)}"]`);
    if (row) await openFile(open, row);
  }
  await refreshGit();
  if (message !== undefined) setStatus(message, isError);
}

// git prints the interesting part of a pull last ("3 files changed, …"); its first
// line is the near-useless "Updating abc1234..def5678".
function summarizePull(output) {
  const lines = String(output || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return (
    lines.find((l) => /files? changed/i.test(l)) ||
    lines.find((l) => /Already up to date/i.test(l)) ||
    lines[lines.length - 1] ||
    'Pulled.'
  );
}

// Conversely, git buries the actual failure under a pile of `hint:` lines.
export function gitErrorLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return (
    lines.find((l) => /^(fatal|error):/i.test(l)) ||
    lines.find((l) => !/^hint:/i.test(l)) ||
    lines[0] ||
    'unknown error'
  );
}
