// The parts of git that write: commit, push, and discarding changes.

import { api } from './api.js';
import { openModal } from './dialogs.js';
import { showDiffFor } from './diff.js';
import { cancelPendingSave, flushSave } from './editor.js';
import {
  GIT_LETTER,
  afterGitChange,
  gitBusy,
  gitEntryTitle,
  gitErrorLine,
  gitFileStatus,
  gitState,
  refreshGit,
  setGitBusy,
} from './git.js';
import { state } from './state.js';
import { setStatus } from './util.js';

export async function gitCommitPush() {
  if (!gitState || gitBusy) return;
  await flushSave();
  await refreshGit();
  if (!gitState) return;

  if (!gitState.files.length) {
    setStatus('Nothing to commit — the vault is clean.');
    return;
  }
  if (gitState.files.some((f) => f.kind === 'conflict')) {
    setStatus('Resolve the conflicted files before committing.', true);
    return;
  }

  const result = await commitModal(gitState.files, !!gitState.upstream);
  if (!result) return;
  // The user asked to see a file's changes instead: the diff opens in the editor
  // pane, and pressing ↑ again brings the dialog back with the draft intact.
  if (result.action === 'diff') {
    await showDiffFor(result.path);
    return;
  }

  setGitBusy(true, result.push ? 'Committing and pushing…' : 'Committing…');
  const res = await api.gitCommit(state.baseFolder, result.message, result.push);
  setGitBusy(false);

  if (!res.ok) {
    // A commit that landed but failed to push is a very different situation from
    // one that never happened — say which, so the user knows what to retry.
    const prefix = res.committed ? 'Committed, but push failed: ' : 'Commit failed: ';
    await afterGitChange(prefix + gitErrorLine(res.error), true);
  } else {
    await afterGitChange(res.pushed ? 'Committed and pushed.' : 'Committed.');
  }
}

// A message typed but not committed — because the user clicked through to review a
// diff, which closes the dialog. Restored the next time it opens so the review
// doesn't cost them what they had already written.
let commitDraft = '';

// What the message box starts with when there's no draft to restore. Pre-selected
// on open, so it's one keystroke to replace and zero to accept.
const DEFAULT_COMMIT_MESSAGE = 'Update';

// The commit dialog: the message, the exact list of files that will be included
// (each opening its diff on click), and whether to push afterwards.
function commitModal(files, hasUpstream) {
  const { box, close, promise } = openModal({
    boxClass: 'modal-box gc-box',
    // Plain Enter is a newline: a commit message has more than one line.
    onKey: (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault();
      submit();
      return true;
    },
    // Keep whatever was typed unless this was a real commit or an explicit cancel.
    onClose: (value) => {
      commitDraft = value && value.action === 'diff' ? msgInput.value : '';
    },
  });

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = `Commit ${files.length} change${files.length === 1 ? '' : 's'}`;
  box.appendChild(heading);

  const msgLabel = document.createElement('label');
  msgLabel.className = 'rm-label';
  msgLabel.textContent = 'Message';
  box.appendChild(msgLabel);

  const msgInput = document.createElement('textarea');
  msgInput.className = 'modal-input gc-message';
  msgInput.rows = 3;
  msgInput.placeholder = 'What changed?';
  msgInput.value = commitDraft || DEFAULT_COMMIT_MESSAGE;
  box.appendChild(msgInput);

  const listLabel = document.createElement('label');
  listLabel.className = 'rm-label gc-list-label';
  listLabel.textContent = 'Files — click one to review its diff';
  box.appendChild(listLabel);

  const list = document.createElement('div');
  list.className = 'gc-list';
  for (const file of files) {
    const row = document.createElement('button');
    row.className = 'gc-file';
    row.dataset.git = file.kind;
    const letter = document.createElement('span');
    letter.className = 'git-badge';
    letter.textContent = GIT_LETTER[file.kind] || 'M';
    const name = document.createElement('span');
    name.className = 'gc-file-path';
    name.textContent = file.rel;
    row.title = gitEntryTitle(file);
    row.appendChild(letter);
    row.appendChild(name);
    // The diff lives in the editor pane, so reviewing one means leaving this
    // dialog. The message typed so far is kept and restored when it reopens.
    row.addEventListener('click', () => close({ action: 'diff', path: file.path }));
    list.appendChild(row);
  }
  box.appendChild(list);

  const pushWrap = document.createElement('label');
  pushWrap.className = 'gc-push';
  const pushCheck = document.createElement('input');
  pushCheck.type = 'checkbox';
  pushCheck.checked = hasUpstream;
  const pushText = document.createElement('span');
  pushText.textContent = hasUpstream
    ? 'Push after committing'
    : 'Push after committing (publishes this branch)';
  pushWrap.appendChild(pushCheck);
  pushWrap.appendChild(pushText);
  box.appendChild(pushWrap);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.className = 'modal-primary';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  box.appendChild(actions);

  const syncOk = () => (okBtn.textContent = pushCheck.checked ? 'Commit & Push' : 'Commit');
  syncOk();
  pushCheck.addEventListener('change', syncOk);

  function submit() {
    const message = msgInput.value.trim();
    if (!message) {
      msgInput.classList.add('invalid');
      msgInput.focus();
      return;
    }
    close({ message, push: pushCheck.checked });
  }

  msgInput.addEventListener('input', () => msgInput.classList.remove('invalid'));
  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => close(null));
  msgInput.focus();
  msgInput.select();

  return promise;
}

// ---- Discard changes ----
// The counterpart to the diff: put a file (or a folder, or the vault) back to what
// git last committed. Irreversible for anything not committed, so it always names
// exactly which files it will touch before doing it.

// Everything a discard of `target` would affect. Untracked files are separated out
// rather than filtered away, so the dialog can say what it is *not* going to do.
function revertScope(target, scope) {
  const sep = state.baseFolder.includes('\\') ? '\\' : '/';
  const inScope = [...gitFileStatus.values()].filter((f) =>
    scope === 'file' ? f.path === target : f.path.startsWith(target + sep)
  );
  return {
    revertable: inScope.filter((f) => f.kind !== 'untracked'),
    untracked: inScope.filter((f) => f.kind === 'untracked'),
  };
}

export async function discardChanges(target, scope, label) {
  if (!gitState) return;
  // Act on what git says now, not on what the tree was last painted with.
  await refreshGit();
  if (!gitState) return;

  const { revertable, untracked } = revertScope(target, scope);
  if (!revertable.length) {
    setStatus(
      untracked.length
        ? 'Nothing to discard — those files are untracked, so git has no version to restore.'
        : 'Nothing to discard — no tracked changes here.'
    );
    return;
  }

  const notes = [];
  if (revertable.some((f) => f.kind === 'deleted')) notes.push('Deleted files will come back.');
  if (revertable.some((f) => f.kind === 'added')) {
    notes.push('Newly added files stay on disk; they are only un-staged.');
  }
  if (untracked.length) {
    notes.push(
      `${untracked.length} untracked file${untracked.length === 1 ? '' : 's'} will be left alone — ` +
        'git has no version to restore, so discarding would just delete them.'
    );
  }

  const confirmed = await confirmModal({
    title: `Discard changes in ${label}?`,
    message:
      revertable.length === 1
        ? '1 file will be put back to its last committed state. Any edit since then is lost.'
        : `${revertable.length} files will be put back to their last committed state. Any edit since then is lost.`,
    files: revertable,
    notes,
    confirmLabel: 'Discard changes',
  });
  if (!confirmed) return;

  // Discarding means throwing the buffer away rather than writing it: drop any
  // queued autosave (and the dirty flag) so nothing rewrites what we just restored.
  if (state.currentFile && revertable.some((f) => f.path === state.currentFile)) {
    cancelPendingSave();
    state.dirty = false;
  }

  setGitBusy(true, 'Discarding…');
  const res = await api.gitRevert(state.baseFolder, revertable.map((f) => f.path));
  setGitBusy(false);

  if (!res.ok) {
    await afterGitChange('Discard failed: ' + gitErrorLine(res.error), true);
    return;
  }
  const n = res.reverted;
  await afterGitChange(
    n ? `Discarded changes in ${n} file${n === 1 ? '' : 's'}.` : 'Nothing needed discarding.'
  );
}

// A yes/no dialog that shows exactly what is about to happen. Used for discarding,
// which is the one action here that destroys work with no undo.
function confirmModal({ title, message, files, notes, confirmLabel }) {
  const { box, close, promise } = openModal({
    boxClass: 'modal-box gc-box',
    cancelValue: false,
    onKey: (e, close) => {
      if (e.key !== 'Enter') return false;
      e.preventDefault();
      close(true);
      return true;
    },
  });

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = title;
  box.appendChild(heading);

  if (message) {
    const p = document.createElement('div');
    p.className = 'cf-message';
    p.textContent = message;
    box.appendChild(p);
  }

  if (files && files.length) {
    const list = document.createElement('div');
    list.className = 'gc-list';
    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'gc-file cf-static';
      row.dataset.git = file.kind;
      const letter = document.createElement('span');
      letter.className = 'git-badge';
      letter.textContent = GIT_LETTER[file.kind] || 'M';
      const name = document.createElement('span');
      name.className = 'gc-file-path';
      name.textContent = file.rel;
      row.title = gitEntryTitle(file);
      row.appendChild(letter);
      row.appendChild(name);
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  for (const note of notes || []) {
    const el = document.createElement('div');
    el.className = 'cf-note';
    el.textContent = note;
    box.appendChild(el);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.className = 'modal-danger';
  okBtn.textContent = confirmLabel || 'OK';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  box.appendChild(actions);

  okBtn.addEventListener('click', () => close(true));
  cancelBtn.addEventListener('click', () => close(false));
  // Cancel takes focus, not the destructive button.
  cancelBtn.focus();

  return promise;
}
