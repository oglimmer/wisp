// Reminders: the model, its storage, and the repeat maths.

import { api } from './api.js';
import { renderReminders, resetAlerts, startReminderTicker } from './reminders-ui.js';
import { state } from './state.js';
import { setStatus } from './util.js';

// The list lives in `.wisp-reminders.json` at the vault root and is held here in
// memory; every change rewrites the whole file (it's small, and it keeps the file
// and the UI trivially in sync). A ticker watches for due entries and raises a
// full-screen alert; each entry stores its *next* due time, so a repeating
// reminder is rolled forward rather than duplicated.

export const REPEAT_LABELS = {
  none: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};
export const REMINDER_TICK_MS = 15000;
export const SNOOZE_OPTIONS = [
  { label: 'Snooze 10 min', minutes: 10 },
  { label: 'Snooze 1 hour', minutes: 60 },
  { label: 'Snooze 1 day', minutes: 60 * 24 },
];

// The list itself. Only this module reassigns it, so importers get a live view
// of it for free; the alerting state that used to sit beside it belongs to the
// ticker and lives in reminders-ui.js.
export let reminders = [];

export function newReminderId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ISO ⇄ the local "YYYY-MM-DD" / "HH:mm" pair the date and time inputs speak.
export function toLocalParts(iso) {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

export function fromLocalParts(date, time) {
  if (!date) return null;
  const d = new Date(`${date}T${time || '09:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// New reminders default to the next whole hour.
export function defaultDue() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// Whole calendar days between two dates, ignoring the time of day.
function dayDelta(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function formatDue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = dayDelta(now, d);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  /** @type {Intl.DateTimeFormatOptions} */
  const opts =
    d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

// The nth occurrence after `start`, always recomputed from the original date so a
// month-end anchor (the 31st) doesn't drift forward through the short months.
function occurrenceAt(start, repeat, steps) {
  const d = new Date(start);
  if (repeat === 'daily') {
    d.setDate(d.getDate() + steps);
  } else if (repeat === 'weekly') {
    d.setDate(d.getDate() + 7 * steps);
  } else if (repeat === 'monthly' || repeat === 'yearly') {
    const months = (repeat === 'yearly' ? 12 : 1) * steps;
    const day = d.getDate();
    d.setDate(1); // avoid setMonth overflowing (31 Jan + 1 month → 3 Mar)
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else {
    return null;
  }
  return d;
}

// Roll a repeating reminder forward to its next occurrence strictly in the future.
// Returns null for one-off reminders (nothing to roll forward to).
function nextOccurrence(iso, repeat) {
  if (!repeat || repeat === 'none') return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;
  for (let steps = 1; steps <= 4000; steps++) {
    const d = occurrenceAt(start, repeat, steps);
    if (!d) return null;
    if (d.getTime() > Date.now()) return d.toISOString();
  }
  return null;
}

// Tolerate a hand-edited reminders file: drop anything without a usable title/date.
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const when = new Date(typeof r.due === 'string' ? r.due : '');
  if (!title || Number.isNaN(when.getTime())) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newReminderId(),
    title,
    due: when.toISOString(),
    repeat: REPEAT_LABELS[r.repeat] ? r.repeat : 'none',
    note: typeof r.note === 'string' ? r.note : '',
    file: typeof r.file === 'string' ? r.file : '',
  };
}

export async function loadReminders() {
  const res = await api.readReminders(state.baseFolder);
  // A failed read has no list at all — an unreadable file leaves the sidebar
  // empty rather than throwing on the way past.
  const stored = res.ok ? res.reminders : [];
  reminders = stored.map(normalizeReminder).filter(Boolean);
  resetAlerts();
  sortReminders();
  renderReminders();
  startReminderTicker();
}

function sortReminders() {
  reminders.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

async function persistReminders() {
  sortReminders();
  renderReminders();
  const res = await api.writeReminders(state.baseFolder, reminders);
  if (!res.ok) setStatus('Error saving reminders: ' + res.error, true);
}

// A reminder points at its note by vault-relative path, so a moved note has to
// take its reminders with it or the list's "open note" button goes nowhere. Same
// prefix rule as the positions store: a moved folder moves everything under it.
export async function remapReminderFiles(oldRel, newRel) {
  if (!oldRel || !newRel || oldRel === newRel) return;
  const sep = oldRel.includes('\\') ? '\\' : '/';
  const prefix = oldRel + sep;
  let touched = false;
  for (const rem of reminders) {
    if (rem.file === oldRel) rem.file = newRel;
    else if (rem.file.startsWith(prefix)) rem.file = newRel + sep + rem.file.slice(prefix.length);
    else continue;
    touched = true;
  }
  if (touched) await persistReminders();
}

export async function upsertReminder(rem) {
  const i = reminders.findIndex((r) => r.id === rem.id);
  if (i === -1) reminders.push(rem);
  else reminders[i] = rem;
  await persistReminders();
}

// Completing a repeating reminder rolls it forward; a one-off is done for good.
export async function completeReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  const next = nextOccurrence(reminders[i].due, reminders[i].repeat);
  if (next) reminders[i] = { ...reminders[i], due: next };
  else reminders.splice(i, 1);
  await persistReminders();
}

export async function snoozeReminder(id, minutes) {
  const rem = reminders.find((r) => r.id === id);
  if (!rem) return;
  rem.due = new Date(Date.now() + minutes * 60000).toISOString();
  await persistReminders();
}

export async function removeReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  reminders.splice(i, 1);
  await persistReminders();
}
