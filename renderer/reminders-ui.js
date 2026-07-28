// The reminder list, its editor dialog, and the due-reminder popup.

import { api } from './api.js';
import { dialogOpen, openModal } from './dialogs.js';
import { reminderCountEl, reminderListEl, treeEl } from './dom.js';
import { openFile } from './editor.js';
import { REMINDER_TICK_MS, REPEAT_LABELS, SNOOZE_OPTIONS, completeReminder, defaultDue, formatDue, fromLocalParts, newReminderId, reminders, removeReminder, snoozeReminder, toLocalParts, upsertReminder } from './reminders.js';

// The ticker's own state. It sits here rather than with the model because only
// the alerting path reads or writes it — and an ES module's exported binding is
// read-only to importers, so `overdueSig = …` has to happen where it is declared.
let reminderTicker = null;
// Which `id@due` pairs have already popped this session, so a reminder left
// overdue in the list doesn't re-alert every tick. A restart alerts again on
// purpose — an unhandled reminder should still be in your face.
const alerted = new Set();
const alertQueue = [];
let alertShowing = false;
let overdueSig = ''; // last-rendered set of overdue ids; drives re-renders

// Reloading the list invalidates every pending pop-up: the entries behind them
// may be gone, rescheduled, or already done.
export function resetAlerts() {
  alerted.clear();
  alertQueue.length = 0;
  overdueSig = '';
}
import { state } from './state.js';
import { expandAncestors, refreshTree, showContextMenu } from './tree.js';
import { cssEscape, relativePath } from './util.js';

export function renderReminders() {
  reminderListEl.innerHTML = '';
  const now = Date.now();
  let overdue = 0;

  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'reminder-empty';
    empty.textContent = 'No reminders. Use ＋ to add one.';
    reminderListEl.appendChild(empty);
  }

  for (const rem of reminders) {
    const isOverdue = Date.parse(rem.due) <= now;
    if (isOverdue) overdue++;

    const row = document.createElement('div');
    row.className = 'reminder-row' + (isOverdue ? ' overdue' : '');
    row.title = rem.note || rem.title;

    const icon = document.createElement('span');
    icon.className = 'reminder-icon';
    icon.textContent = isOverdue ? '🔔' : '⏰';

    const body = document.createElement('div');
    body.className = 'reminder-body';

    const title = document.createElement('div');
    title.className = 'reminder-title';
    title.textContent = rem.title;

    const meta = document.createElement('div');
    meta.className = 'reminder-meta';
    const bits = [formatDue(rem.due)];
    if (rem.repeat && rem.repeat !== 'none') bits.push(REPEAT_LABELS[rem.repeat]);
    if (rem.file) bits.push(rem.file);
    meta.textContent = bits.join(' · ');

    body.appendChild(title);
    body.appendChild(meta);

    const done = document.createElement('button');
    done.className = 'reminder-done';
    done.textContent = '✓';
    done.title = rem.repeat === 'none' ? 'Complete' : 'Complete this occurrence';
    done.addEventListener('click', (e) => {
      e.stopPropagation();
      completeReminder(rem.id);
    });

    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(done);

    row.addEventListener('click', () => editReminder(rem));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [{ label: 'Edit…', fn: () => editReminder(rem) }];
      if (rem.file) items.push({ label: 'Open note', fn: () => openVaultNote(rem.file) });
      items.push({ label: 'Complete', fn: () => completeReminder(rem.id) });
      items.push({ label: 'Delete', fn: () => removeReminder(rem.id) });
      showContextMenu(e, items);
    });

    reminderListEl.appendChild(row);
  }

  reminderCountEl.textContent = String(overdue);
  reminderCountEl.classList.toggle('hidden', overdue === 0);
}

// Open a note by its vault-relative path (reminders and lookup sources both use this).
export async function openVaultNote(rel) {
  if (!rel || !state.baseFolder) return;
  const sep = state.baseFolder.includes('\\') ? '\\' : '/';
  const full = state.baseFolder + sep + String(rel).split('/').join(sep);
  expandAncestors(full);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(full)}"]`);
  await openFile(full, row);
}

export async function newReminder(forFilePath) {
  const file = forFilePath || state.currentFile;
  const res = await reminderModal(null, file ? relativePath(file) : '');
  if (res && res.action === 'save') await upsertReminder(res.reminder);
}

async function editReminder(rem) {
  const res = await reminderModal(rem);
  if (!res) return;
  if (res.action === 'save') await upsertReminder(res.reminder);
  else if (res.action === 'delete') await removeReminder(rem.id);
  else if (res.action === 'open') await openVaultNote(rem.file);
}

// ---- Reminder editor ----
// Same promise-based pattern as promptModal (Electron has no window.prompt), but
// with the fields a reminder needs. Resolves to { action, reminder } or null.
export function reminderModal(existing, defaultFile = '') {
  const { box, close, promise } = openModal({
    boxClass: 'modal-box rm-box',
    // Enter saves — except in the details box, where it's a newline.
    onKey: (e) => {
      if (e.key !== 'Enter' || e.target === noteInput) return false;
      e.preventDefault();
      submit();
      return true;
    },
  });

  const base = existing || {
    id: newReminderId(),
    title: '',
    due: defaultDue(),
    repeat: 'none',
    note: '',
    file: defaultFile,
  };
  const parts = toLocalParts(base.due);

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = existing ? 'Edit reminder' : 'New reminder';
  box.appendChild(heading);

  // label + control, stacked
  const field = (labelText, control, className) => {
    const wrap = document.createElement('div');
    wrap.className = 'rm-field' + (className ? ' ' + className : '');
    const label = document.createElement('label');
    label.className = 'rm-label';
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    box.appendChild(wrap);
    return wrap;
  };

  const titleInput = document.createElement('input');
  titleInput.className = 'modal-input';
  titleInput.type = 'text';
  titleInput.value = base.title;
  titleInput.placeholder = 'What should you be reminded of?';
  field('Reminder', titleInput);

  // Date / time / repeat share one row.
  const whenRow = document.createElement('div');
  whenRow.className = 'rm-row';
  const dateInput = document.createElement('input');
  dateInput.className = 'modal-input';
  dateInput.type = 'date';
  dateInput.value = parts.date;
  const timeInput = document.createElement('input');
  timeInput.className = 'modal-input';
  timeInput.type = 'time';
  timeInput.value = parts.time;
  const repeatSelect = document.createElement('select');
  repeatSelect.className = 'modal-input';
  for (const [value, label] of Object.entries(REPEAT_LABELS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    repeatSelect.appendChild(opt);
  }
  repeatSelect.value = REPEAT_LABELS[base.repeat] ? base.repeat : 'none';

  const cell = (labelText, control) => {
    const wrap = document.createElement('div');
    wrap.className = 'rm-field';
    const label = document.createElement('label');
    label.className = 'rm-label';
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    whenRow.appendChild(wrap);
  };
  cell('Date', dateInput);
  cell('Time', timeInput);
  cell('Repeat', repeatSelect);
  box.appendChild(whenRow);

  const noteInput = document.createElement('textarea');
  noteInput.className = 'modal-input rm-note';
  noteInput.rows = 3;
  noteInput.value = base.note;
  noteInput.placeholder = 'Optional details shown in the popup';
  field('Details', noteInput);

  const fileInput = document.createElement('input');
  fileInput.className = 'modal-input';
  fileInput.type = 'text';
  fileInput.value = base.file;
  fileInput.placeholder = 'Optional — e.g. work/projects.md';
  field('Linked note', fileInput);

  const actions = document.createElement('div');
  actions.className = 'modal-actions rm-actions';
  if (existing) {
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'rm-danger';
    delBtn.addEventListener('click', () => close({ action: 'delete' }));
    actions.appendChild(delBtn);
  }
  if (existing && base.file) {
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open note';
    openBtn.addEventListener('click', () => close({ action: 'open' }));
    actions.appendChild(openBtn);
  }
  const spacer = document.createElement('div');
  spacer.className = 'rm-spacer';
  actions.appendChild(spacer);
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.textContent = 'Save';
  okBtn.className = 'modal-primary';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  box.appendChild(actions);

  function submit() {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.classList.add('invalid');
      titleInput.focus();
      return;
    }
    const due = fromLocalParts(dateInput.value, timeInput.value);
    if (!due) {
      dateInput.classList.add('invalid');
      dateInput.focus();
      return;
    }
    close({
      action: 'save',
      reminder: {
        id: base.id,
        title,
        due,
        repeat: repeatSelect.value,
        note: noteInput.value.trim(),
        file: fileInput.value.trim(),
      },
    });
  }

  box.addEventListener('input', (e) => e.target.classList.remove('invalid'));
  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => close(null));

  titleInput.focus();
  titleInput.select();

  return promise;
}

// ---- Due watching + the alert popup ----
export function startReminderTicker() {
  if (reminderTicker) clearInterval(reminderTicker);
  reminderTicker = setInterval(checkDueReminders, REMINDER_TICK_MS);
  checkDueReminders();
}

function checkDueReminders() {
  const now = Date.now();
  const due = [];
  for (const rem of reminders) {
    const t = Date.parse(rem.due);
    if (Number.isNaN(t) || t > now) continue;
    due.push(rem.id);
    const key = rem.id + '@' + rem.due;
    if (alerted.has(key)) continue;
    alerted.add(key);
    alertQueue.push(rem.id);
  }
  // Only repaint when the overdue set actually changed, so the list doesn't
  // flicker under the cursor every tick.
  const sig = due.join(',');
  if (sig !== overdueSig) {
    overdueSig = sig;
    renderReminders();
  }
  drainAlerts();
}

// Show queued alerts one at a time — several reminders can come due together.
// A dialog already up keeps the queue intact rather than stacking a second
// overlay on it: the ticker retries, so the alert is deferred, never dropped.
function drainAlerts() {
  if (alertShowing || dialogOpen()) return;
  while (alertQueue.length) {
    const rem = reminders.find((r) => r.id === alertQueue.shift());
    if (rem) {
      showReminderAlert(rem);
      return;
    }
  }
}

function showReminderAlert(rem) {
  alertShowing = true;
  api.alertWindow(); // bring the window forward / flash the taskbar

  // No backdrop dismissal: a reminder must not disappear to a stray click.
  // Escape does dismiss it — the entry stays in the list, overdue.
  const { box, close } = openModal({
    overlayClass: 'alert-overlay',
    boxClass: 'alert-box',
    dismissOnBackdrop: false,
    onClose: () => {
      alertShowing = false;
      renderReminders(); // the entry is overdue now — repaint it as such
      drainAlerts();
    },
  });

  const bell = document.createElement('div');
  bell.className = 'alert-bell';
  bell.textContent = '🔔';

  const kicker = document.createElement('div');
  kicker.className = 'alert-kicker';
  kicker.textContent = rem.repeat === 'none' ? 'Reminder' : REPEAT_LABELS[rem.repeat] + ' reminder';

  const title = document.createElement('div');
  title.className = 'alert-title';
  title.textContent = rem.title;

  const when = document.createElement('div');
  when.className = 'alert-when';
  when.textContent = formatDue(rem.due);

  box.appendChild(bell);
  box.appendChild(kicker);
  box.appendChild(title);
  box.appendChild(when);

  if (rem.note) {
    const note = document.createElement('div');
    note.className = 'alert-note';
    note.textContent = rem.note;
    box.appendChild(note);
  }

  const actions = document.createElement('div');
  actions.className = 'alert-actions';

  const mkBtn = (label, className, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };

  for (const opt of SNOOZE_OPTIONS) {
    mkBtn(opt.label, 'alert-snooze', () => {
      close();
      snoozeReminder(rem.id, opt.minutes);
    });
  }
  if (rem.file) {
    mkBtn('Open note', '', () => {
      close();
      openVaultNote(rem.file);
    });
  }
  const doneBtn = mkBtn(
    rem.repeat === 'none' ? 'Done' : 'Done — next ' + REPEAT_LABELS[rem.repeat].toLowerCase(),
    'alert-primary',
    () => {
      close();
      completeReminder(rem.id);
    }
  );

  box.appendChild(actions);
  doneBtn.focus();
}
