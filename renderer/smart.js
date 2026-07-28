// Smart insert and smart lookup: the same box, run into and out of the vault.

import { api } from './api.js';
import { dividerPreviewEl, smartAddBtn, smartCheckBtn, smartInputEl, smartLookupBtn, smartPreviewEl, smartStatusEl, treeEl } from './dom.js';
import { flushSave, openFile } from './editor.js';
import { lineDiff } from './lcs.js';
import { REPEAT_LABELS, formatDue, newReminderId, upsertReminder } from './reminders.js';
import { openVaultNote, reminderModal } from './reminders-ui.js';
import { state } from './state.js';
import { expandAncestors, refreshTree } from './tree.js';
import { cssEscape } from './util.js';

// was computed for. If the text changes, the plan is stale and Add re-checks.
/** @type {import('../types/ipc').SmartPlan | null} */
export let smartPlan = null;
/** @type {string | null} */
export let smartPlanFor = null;
// Whether the reminder Claude proposed alongside the plan will be created on Add
// (the checkbox in the preview). Reset every time a fresh plan is rendered.
export let smartReminderOn = false;
// Smart-lookup state: the question the answer shown in the preview was asked for,
// so a changed question drops it the same way a stale plan is dropped.
/** @type {string | null} */
export let smartLookupFor = null;

// ---- Smart insert ----

// Clear the panel and any preview carried over from a previous vault.
export function resetSmartPanel() {
  smartInputEl.value = '';
  smartPlan = null;
  smartPlanFor = null;
  smartReminderOn = false;
  smartLookupFor = null;
  hideSmartPreview();
  setSmartStatus('');
}

export function setSmartStatus(text, isError) {
  smartStatusEl.textContent = text || '';
  smartStatusEl.classList.toggle('error', !!isError);
}

// Show / hide the preview panel and its resize divider together.
function showSmartPreview() {
  smartPreviewEl.classList.remove('hidden');
  dividerPreviewEl.classList.remove('hidden');
}
export function hideSmartPreview() {
  smartPreviewEl.classList.add('hidden');
  dividerPreviewEl.classList.add('hidden');
}

// Toggle the busy state: disable inputs and show a message while Claude runs.
function smartBusy(busy, message) {
  smartInputEl.disabled = busy;
  smartCheckBtn.disabled = busy;
  smartAddBtn.disabled = busy;
  smartLookupBtn.disabled = busy;
  if (message) setSmartStatus(message);
}

// Ask Claude where the current note belongs. Renders a preview; writes nothing.
// Returns the plan on success, or null on failure / empty input.
export async function smartCheck() {
  const text = smartInputEl.value.trim();
  if (!text) {
    setSmartStatus('Type a note first.', true);
    return null;
  }
  // Make sure the open file's latest edits are on disk before Claude reads it.
  await flushSave();

  smartBusy(true, 'Checking…');
  let res;
  try {
    res = await api.smartCheck(state.baseFolder, state.currentFile, text);
  } finally {
    smartBusy(false);
  }

  if (!res.ok) {
    smartPlan = null;
    smartPlanFor = null;
    smartReminderOn = false;
    hideSmartPreview();
    setSmartStatus(res.error, true);
    return null;
  }
  smartPlan = res.plan;
  smartPlanFor = text;
  renderPreview(res.plan);
  setSmartStatus('Review below, then Add to apply.');
  return res.plan;
}

// File the note. Re-checks automatically if there's no fresh plan for this text.
export async function smartAdd() {
  const text = smartInputEl.value.trim();
  if (!text) {
    setSmartStatus('Type a note first.', true);
    return;
  }
  // Flush any pending editor change first so applying can't be clobbered by a
  // later autosave/flush of the currently-open file.
  await flushSave();

  let plan = smartPlan;
  if (!plan || smartPlanFor !== text) {
    plan = await smartCheck();
    if (!plan) return;
  }

  smartBusy(true, 'Adding…');
  let res;
  try {
    res = await api.smartApply(state.baseFolder, plan.targetFile, plan.newContent);
  } finally {
    smartBusy(false);
  }
  if (!res.ok) {
    setSmartStatus(res.error, true);
    return;
  }

  // The file landed; now create the reminder Claude proposed, if it's still ticked.
  let remNote = '';
  if (plan.reminder && smartReminderOn) {
    await upsertReminder({
      id: plan.reminder.id || newReminderId(),
      title: plan.reminder.title,
      due: plan.reminder.due,
      repeat: plan.reminder.repeat || 'none',
      note: typeof plan.reminder.note === 'string' ? plan.reminder.note : text,
      file: typeof plan.reminder.file === 'string' ? plan.reminder.file : plan.targetFile,
    });
    remNote = ' · reminder ' + formatDue(plan.reminder.due);
  }

  smartInputEl.value = '';
  smartPlan = null;
  smartPlanFor = null;
  smartReminderOn = false;
  hideSmartPreview();
  setSmartStatus('Added to ' + plan.targetFile + remNote);

  // Reveal and open the file we just wrote so the change is visible.
  expandAncestors(res.path);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(res.path)}"]`);
  await openFile(res.path, row);
}

// The other direction: read the vault instead of writing to it. Answers the text
// in the box from the notes and shows the answer, with its sources, in the preview.
export async function smartLookup() {
  const question = smartInputEl.value.trim();
  if (!question) {
    setSmartStatus('Type a question first.', true);
    return;
  }
  // Make sure the open file's latest edits are on disk before Claude reads it.
  await flushSave();

  smartBusy(true, 'Looking up…');
  let res;
  try {
    res = await api.smartLookup(state.baseFolder, state.currentFile, question);
  } finally {
    smartBusy(false);
  }

  if (!res.ok) {
    // Only drop what this feature owns — a filing plan below stays valid.
    if (smartLookupFor !== null) {
      smartLookupFor = null;
      hideSmartPreview();
    }
    setSmartStatus(res.error, true);
    return;
  }
  // The preview pane shows one thing at a time; an answer replaces any filing plan,
  // so drop the plan rather than leave Add pointing at something no longer shown.
  smartPlan = null;
  smartPlanFor = null;
  smartReminderOn = false;
  smartLookupFor = question;
  renderLookup(res.result);
  const n = res.result.sources.length;
  setSmartStatus(n ? `Answered from ${n} file${n === 1 ? '' : 's'}.` : 'Answered.');
}

// A checked plan is only valid for the text it was computed from; once the note
// changes, drop the stale preview (plan or lookup answer) so Add re-checks rather
// than mis-filing and a stale answer isn't read as an answer to the new question.
export function invalidateSmartPlan() {
  const text = smartInputEl.value.trim();
  if (smartPlanFor !== null && text !== smartPlanFor) {
    smartPlan = null;
    smartPlanFor = null;
    smartReminderOn = false;
    hideSmartPreview();
    setSmartStatus('');
  }
  if (smartLookupFor !== null && text !== smartLookupFor) {
    smartLookupFor = null;
    hideSmartPreview();
    setSmartStatus('');
  }
}

// Build a preview: target file, a NEW/EXISTING badge, Claude's reason, and a diff.
function renderPreview(plan) {
  smartPreviewEl.innerHTML = '';
  smartLookupFor = null; // the plan owns the preview pane now

  const head = document.createElement('div');
  head.className = 'sp-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge' + (plan.isNew ? ' sp-new' : '');
  badge.textContent = plan.isNew ? 'NEW FILE' : 'EXISTING';
  const pathEl = document.createElement('span');
  pathEl.className = 'sp-path';
  pathEl.textContent = plan.targetFile;
  head.appendChild(badge);
  head.appendChild(pathEl);
  smartPreviewEl.appendChild(head);

  if (plan.reason) {
    const reason = document.createElement('div');
    reason.className = 'sp-reason';
    reason.textContent = plan.reason;
    smartPreviewEl.appendChild(reason);
  }

  // Every check also asks Claude whether the note implies a reminder. When it
  // does, offer it here — opt-out, editable, and only created when Add is pressed.
  smartReminderOn = !!plan.reminder;
  if (plan.reminder) smartPreviewEl.appendChild(renderReminderProposal(plan));

  const diff = document.createElement('pre');
  diff.className = 'sp-diff';
  for (const line of lineDiff(plan.oldContent || '', plan.newContent || '')) {
    const el = document.createElement('div');
    el.className = 'sp-line sp-' + line.type;
    const prefix = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : line.type === 'gap' ? '' : '  ';
    el.textContent = prefix + line.text;
    diff.appendChild(el);
  }
  smartPreviewEl.appendChild(diff);
  showSmartPreview();
}

// The reminder card inside the smart-insert preview: a checkbox to include it,
// what it will fire as, and an Edit… button that opens the normal reminder editor.
function renderReminderProposal(plan) {
  const card = document.createElement('div');
  card.className = 'sp-reminder';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'sp-rem-check';
  check.checked = smartReminderOn;
  check.addEventListener('change', () => (smartReminderOn = check.checked));

  const body = document.createElement('div');
  body.className = 'sp-rem-body';

  const head = document.createElement('div');
  head.className = 'sp-rem-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge sp-rem-badge';
  badge.textContent = 'REMINDER';
  const title = document.createElement('span');
  title.className = 'sp-rem-title';
  title.textContent = plan.reminder.title;
  head.appendChild(badge);
  head.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'sp-rem-meta';
  const bits = [formatDue(plan.reminder.due)];
  if (plan.reminder.repeat && plan.reminder.repeat !== 'none') {
    bits.push(REPEAT_LABELS[plan.reminder.repeat]);
  }
  meta.textContent = bits.join(' · ');

  body.appendChild(head);
  body.appendChild(meta);
  if (plan.reminder.reason) {
    const why = document.createElement('div');
    why.className = 'sp-rem-why';
    why.textContent = plan.reminder.reason;
    body.appendChild(why);
  }

  const edit = document.createElement('button');
  edit.className = 'sp-rem-edit';
  edit.textContent = 'Edit…';
  edit.addEventListener('click', async () => {
    const res = await reminderModal({
      id: newReminderId(),
      title: plan.reminder.title,
      due: plan.reminder.due,
      repeat: plan.reminder.repeat,
      note: smartInputEl.value.trim(),
      file: plan.targetFile,
    });
    if (!res) return;
    if (res.action === 'delete') {
      plan.reminder = null;
      smartReminderOn = false;
    } else if (res.action === 'save') {
      plan.reminder = { ...res.reminder, reason: plan.reminder.reason };
    }
    renderPreview(plan);
  });

  card.appendChild(check);
  card.appendChild(body);
  card.appendChild(edit);
  return card;
}

// Render a lookup answer into the same preview pane: Claude's answer, then the
// files it drew on. Each source opens the note it names, so an answer stays
// checkable against what the vault actually says.
function renderLookup(result) {
  smartPreviewEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'sp-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge sp-lookup-badge';
  badge.textContent = 'ANSWER';
  const q = document.createElement('span');
  q.className = 'sp-path';
  q.textContent = result.question;
  head.appendChild(badge);
  head.appendChild(q);
  smartPreviewEl.appendChild(head);

  const answer = document.createElement('div');
  answer.className = 'sp-answer';
  answer.textContent = result.answer;
  smartPreviewEl.appendChild(answer);

  if (result.sources.length) {
    const label = document.createElement('div');
    label.className = 'sp-sources-label';
    label.textContent = 'Sources';
    smartPreviewEl.appendChild(label);
  }

  for (const src of result.sources) {
    const row = document.createElement('div');
    row.className = 'sp-source';

    const link = document.createElement('button');
    link.className = 'sp-source-file';
    link.textContent = src.file;
    link.title = 'Open ' + src.file;
    link.addEventListener('click', () => openVaultNote(src.file));
    row.appendChild(link);

    if (src.detail) {
      const detail = document.createElement('span');
      detail.className = 'sp-source-detail';
      detail.textContent = src.detail;
      row.appendChild(detail);
    }
    smartPreviewEl.appendChild(row);
  }
  showSmartPreview();
}

// Line-level diff via a longest-common-subsequence table, then collapse long
// runs of unchanged context so the preview stays focused on what changed.
