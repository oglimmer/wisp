// Every element the UI holds on to, resolved once. Kept together so a renamed id
// in index.html breaks in one obvious place rather than wherever it was used.
//
// `getElementById` answers with the base `HTMLElement`, which has no `value`,
// `disabled` or `src`. The four helpers below state what index.html actually
// holds for that id, which is what makes `editorEl.value`, `findInputEl.value`
// and `viewRawBtn.disabled` checkable at every call site rather than only
// failing at runtime. Change a tag in index.html, change the helper here.

// Not `HTMLElement | null`: every id below is in index.html, and one that isn't
// is a broken build rather than a case the UI should be written to handle.
// Exported for the two modules that reach for an element by id at wire-up time
// rather than holding on to it (index.js, layout.js).
// One assertion, parameterised, rather than the six that laundered through `any`
// when these were JSDoc: the element is asserted to be what index.html holds for
// that id, which is exactly the claim each helper below is making.
const byTag = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const byId = (id: string): HTMLElement => byTag(id);
const el = byId;
const btn = (id: string) => byTag<HTMLButtonElement>(id);
const input = (id: string) => byTag<HTMLInputElement>(id);
const select = (id: string) => byTag<HTMLSelectElement>(id);
const textarea = (id: string) => byTag<HTMLTextAreaElement>(id);
const img = (id: string) => byTag<HTMLImageElement>(id);

export const welcomeEl = el('welcome');
export const workspaceEl = el('workspace');
export const treeEl = el('tree');
export const treeModeTreeBtn = btn('tree-mode-tree-btn');
export const treeModeRecentBtn = btn('tree-mode-recent-btn');
export const editorEl = textarea('editor');
export const currentFileEl = el('current-file');
export const statusEl = el('status');
export const vaultNameEl = el('vault-name');
export const smartInputEl = textarea('smart-input');
export const smartCheckBtn = btn('smart-check-btn');
export const smartAddBtn = btn('smart-add-btn');
export const smartLookupBtn = btn('smart-lookup-btn');
export const smartStatusEl = el('smart-status');
export const smartPreviewEl = el('smart-preview');
export const dividerPreviewEl = el('divider-preview');
export const renderedEl = el('rendered');
export const wysiwygEl = el('wysiwyg');
export const imageViewEl = el('image-view');
export const imageViewImgEl = img('image-view-img');
export const imageViewMetaEl = el('image-view-meta');
export const viewToggleEl = el('view-toggle');
export const viewRawBtn = btn('view-raw-btn');
export const viewWysBtn = btn('view-wys-btn');
export const viewMdBtn = btn('view-md-btn');
export const viewDiffBtn = btn('view-diff-btn');
export const diffModeToggleEl = el('diff-mode-toggle');
export const diffVisualBtn = btn('diff-visual-btn');
export const diffRawBtn = btn('diff-raw-btn');
export const diffViewEl = el('diff-view');
export const findBarEl = el('find-bar');
export const findInputEl = input('find-input');
export const findCountEl = el('find-count');
export const findCaseBtn = btn('find-case-btn');
export const findPrevBtn = btn('find-prev-btn');
export const findNextBtn = btn('find-next-btn');
export const findCloseBtn = btn('find-close-btn');
export const findReplaceRowEl = el('find-replace-row');
export const replaceInputEl = input('replace-input');
export const replaceBtn = btn('replace-btn');
export const replaceAllBtn = btn('replace-all-btn');
export const findHighlightsEl = el('find-highlights');
export const gitBarEl = el('git-bar');
export const gitBranchEl = el('git-branch');
export const gitSyncEl = el('git-sync');
export const gitDirtyEl = el('git-dirty');
export const gitDiffBtn = btn('git-diff-btn');
export const gitPullBtn = btn('git-pull-btn');
export const gitPushBtn = btn('git-push-btn');
export const terminalPaneEl = el('terminal-pane');
export const terminalBodyEl = el('terminal-body');
export const terminalToggleBtn = btn('terminal-toggle');
export const terminalCaretEl = el('terminal-caret');
export const terminalStatusEl = el('terminal-status');
export const terminalRestartBtn = btn('terminal-restart-btn');
export const dividerTerminalEl = el('divider-terminal');
export const reminderListEl = el('reminder-list');
export const reminderCountEl = el('reminder-count');
export const reminderFilterEl = select('reminder-filter');
export const newReminderBtn = btn('new-reminder-btn');
