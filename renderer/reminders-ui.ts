// The reminder list and its editor dialog.

import type { Reminder } from '../types/ipc';
import { dialogOpen, openModal } from './dialogs.js';
import { reminderCountEl, reminderFilterEl, reminderListEl, treeEl } from './dom.js';
import { openFile } from './editor.js';
import { BUCKET_LABELS, DEFAULT_LIST, EXTEND_OPTIONS, REMINDER_TICK_MS, defaultDue, dueBucket, extendReminder, extendedDue, formatDue, newReminderId, normalizeList, parseDate, reminderLists, reminders, removeReminder, toDueDate, today, upsertReminder } from './reminders.js';
import { state } from './state.js';
import { expandAncestors, refreshTree, showContextMenu } from './tree.js';
import { cssEscape, relativePath } from './util.js';

// The ticker's own state: the day the list was last rendered against. Everything
// the list says about *when* — the groups, the row styling, the badge — derives
// from today's date and nothing else, so a repaint is needed exactly when that
// date changes, and never otherwise. (An ES module's exported binding is
// read-only to importers, so it has to live in the module that assigns it.)
let reminderTicker: ReturnType<typeof setInterval> | null = null;
let renderedDay = '';

// Which list the pane is showing, or ALL_LISTS for every one of them. It survives
// a restart like the sidebar's tree/recent choice does — a filter that silently
// reset would leave entries the user thinks they have looked at unseen. It is
// matched case-insensitively, because `reminderLists()` treats "Work" and "work"
// as one list and only one of the two spellings is in the dropdown.
const ALL_LISTS = '\u0000all';
let listFilter = localStorage.getItem('rawNotes.reminderList') || ALL_LISTS;

function inFilter(rem: Reminder) {
  return listFilter === ALL_LISTS || rem.list.toLowerCase() === listFilter.toLowerCase();
}

// Rebuild the header's filter dropdown from the lists actually in use. A filter
// pointing at a list that no longer has any entries falls back to all of them
// rather than showing an empty pane with no way to tell why.
function renderFilter(lists: string[]) {
  if (listFilter !== ALL_LISTS && !lists.some((n) => n.toLowerCase() === listFilter.toLowerCase())) {
    setListFilter(ALL_LISTS, false);
  }
  reminderFilterEl.innerHTML = '';
  const options: Array<[string, string]> = [
    [ALL_LISTS, 'All lists'],
    ...lists.map((n): [string, string] => [n, n]),
  ];
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    reminderFilterEl.appendChild(opt);
  }
  reminderFilterEl.value = listFilter;
}

function setListFilter(value: string, repaint = true) {
  listFilter = value;
  localStorage.setItem('rawNotes.reminderList', value);
  if (repaint) renderReminders();
}

reminderFilterEl.addEventListener('change', () => setListFilter(reminderFilterEl.value));

export function renderReminders() {
  reminderListEl.innerHTML = '';
  // One day for the whole render: an entry either side of a midnight that passed
  // mid-loop would otherwise be grouped against two different "today"s.
  const now = today();
  renderedDay = now;
  let pressing = 0; // overdue or due today — what the header badge counts
  let bucket = '';

  renderFilter(reminderLists());
  const shown = reminders.filter(inFilter);

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'reminder-empty';
    empty.textContent =
      listFilter === ALL_LISTS
        ? 'No reminders. Use ＋ to add one.'
        : `Nothing in ${listFilter}.`;
    reminderListEl.appendChild(empty);
  }

  // The badge counts what is on screen: with a filter up, a count of entries the
  // pane is not showing would be a number with nothing behind it.
  for (const rem of shown) {
    const b = dueBucket(rem.due, now);
    if (b === 'overdue' || b === 'today') pressing++;

    // The list is sorted by due date, so each bucket is one contiguous run and a
    // heading goes in wherever it changes.
    if (b !== bucket) {
      bucket = b;
      const head = document.createElement('div');
      head.className = 'reminder-group group-' + b;
      head.textContent = BUCKET_LABELS[b];
      reminderListEl.appendChild(head);
    }

    const row = document.createElement('div');
    row.className = 'reminder-row group-' + b;
    row.title = rem.note || rem.title;

    const icon = document.createElement('span');
    icon.className = 'reminder-icon';
    icon.textContent = b === 'overdue' ? '❗' : b === 'today' ? '🔔' : '⏰';

    const body = document.createElement('div');
    body.className = 'reminder-body';

    const title = document.createElement('div');
    title.className = 'reminder-title';
    title.textContent = rem.title;

    const meta = document.createElement('div');
    meta.className = 'reminder-meta';
    const bits = [formatDue(rem.due)];
    // The list is what every visible row has in common while a filter is up, so
    // it only earns its place in the meta line when they might differ.
    if (listFilter === ALL_LISTS) bits.push(rem.list);
    if (rem.file) bits.push(rem.file);
    meta.textContent = bits.join(' · ');

    body.appendChild(title);
    body.appendChild(meta);

    const done = document.createElement('button');
    done.className = 'reminder-done';
    done.textContent = '✓';
    done.title = 'Done';
    done.addEventListener('click', (e) => {
      e.stopPropagation();
      removeReminder(rem.id);
    });

    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(done);

    row.addEventListener('click', () => editReminder(rem));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [{ label: 'Edit…', fn: () => editReminder(rem) }];
      for (const opt of EXTEND_OPTIONS) {
        items.push({
          label: `Extend by ${opt.label} — ${formatDue(extendedDue(rem.due, opt))}`,
          fn: () => extendReminder(rem.id, opt),
        });
      }
      if (rem.file) items.push({ label: 'Open note', fn: () => openVaultNote(rem.file) });
      items.push({ label: 'Done', fn: () => removeReminder(rem.id) });
      showContextMenu(e, items);
    });

    reminderListEl.appendChild(row);
  }

  reminderCountEl.textContent = String(pressing);
  reminderCountEl.classList.toggle('hidden', pressing === 0);
}

// Open a note by its vault-relative path (reminders and lookup sources both use this).
export async function openVaultNote(rel: string) {
  if (!rel || !state.baseFolder) return;
  const sep = state.baseFolder.includes('\\') ? '\\' : '/';
  const full = state.baseFolder + sep + String(rel).split('/').join(sep);
  expandAncestors(full);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(full)}"]`);
  await openFile(full, row);
}

export async function newReminder(forFilePath: string | null) {
  const file = forFilePath || state.currentFile;
  const res = await reminderModal(null, file ? relativePath(file) : '');
  if (res && res.action === 'save') await upsertReminder(res.reminder);
}

async function editReminder(rem: Reminder) {
  const res = await reminderModal(rem);
  if (!res) return;
  if (res.action === 'save') await upsertReminder(res.reminder);
  else if (res.action === 'delete') await removeReminder(rem.id);
  else if (res.action === 'open') await openVaultNote(rem.file);
}

// ---- Reminder editor ----
// Same promise-based pattern as promptModal (Electron has no window.prompt), but
// with the fields a reminder needs.

/** What the reminder editor settles with — null if it was dismissed. */
export type ReminderResult =
  | { action: 'save'; reminder: Reminder }
  | { action: 'delete' }
  | { action: 'open' };

export function reminderModal(existing: Reminder | null, defaultFile = '', onSaved?: () => void) {
  const { box, close, promise } = openModal<ReminderResult | null>({
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
    list: DEFAULT_LIST,
    note: '',
    file: defaultFile,
  };

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = existing ? 'Edit reminder' : 'New reminder';
  box.appendChild(heading);

  // label + control, stacked
  const field = (labelText: string, control: HTMLElement, className?: string) => {
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

  // Date and list share one row. There is no time of day and no repeat: a
  // reminder is due on a day and happens once (see reminders.js). A proposal
  // Claude made may still carry an instant, so the date is fed through the same
  // reduction the store uses.
  const whenRow = document.createElement('div');
  whenRow.className = 'rm-row';
  const dateInput = document.createElement('input');
  dateInput.className = 'modal-input';
  dateInput.type = 'date';
  dateInput.value = toDueDate(base.due) || defaultDue();

  // A combobox, not a select: the lists already in use are offered, and anything
  // else typed in makes a new one. `<datalist>` is exactly that — the input keeps
  // taking free text, so there is no "new list…" mode to build or get out of. The
  // id is unique per dialog, since two openings would otherwise share one list.
  const listInput = document.createElement('input');
  listInput.className = 'modal-input';
  listInput.type = 'text';
  listInput.value = normalizeList(base.list);
  listInput.placeholder = DEFAULT_LIST;
  listInput.autocomplete = 'off';
  const listOptions = document.createElement('datalist');
  listOptions.id = 'rm-lists-' + base.id;
  for (const name of reminderLists()) {
    const opt = document.createElement('option');
    opt.value = name;
    listOptions.appendChild(opt);
  }
  listInput.setAttribute('list', listOptions.id);
  box.appendChild(listOptions);

  const cell = (labelText: string, control: HTMLElement) => {
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
  cell('List', listInput);
  box.appendChild(whenRow);

  const noteInput = document.createElement('textarea');
  noteInput.className = 'modal-input rm-note';
  noteInput.rows = 3;
  noteInput.value = base.note;
  noteInput.placeholder = 'Optional details shown in the list';
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
    // An empty date input reads as '', and a browser that lets one be typed can
    // hand back something that isn't a date at all.
    if (!parseDate(dateInput.value)) {
      dateInput.classList.add('invalid');
      dateInput.focus();
      return;
    }
    close({
      action: 'save',
      reminder: {
        id: base.id,
        title,
        due: dateInput.value,
        list: normalizeList(listInput.value),
        note: noteInput.value.trim(),
        file: fileInput.value.trim(),
      },
    });
  }

  box.addEventListener('input', (e) =>
    (e.target as Element).classList.remove('invalid')
  );
  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => close(null));

  titleInput.focus();
  titleInput.select();

  return promise;
}

// ---- The day ticker ----
// Reminders are read, not announced: nothing pops up, raises the window or
// interrupts. What the ticker is for is the one thing the list cannot notice by
// itself — the day rolling over underneath it, which moves entries between
// groups (and into Today) while the window just sits there.
export function startReminderTicker() {
  if (reminderTicker) clearInterval(reminderTicker);
  reminderTicker = setInterval(checkDay, REMINDER_TICK_MS);
}

function checkDay() {
  // A dialog is quite possibly the reminder editor, whose Save repaints anyway;
  // repainting the list underneath one is never urgent enough to risk it.
  if (dialogOpen() || today() === renderedDay) return;
  renderReminders();
}
