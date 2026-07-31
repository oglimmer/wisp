// Reminders: the model, its storage, and the date maths.

import { api } from './api.js';
import { renderReminders, startReminderTicker } from './reminders-ui.js';
import { state } from './state.js';
import { setStatus } from './util.js';

// The list lives in `.wisp-reminders.json` at the vault root and is held here in
// memory; every change rewrites the whole file (it's small, and it keeps the file
// and the UI trivially in sync). A reminder is one date, one title and one list:
// it does not repeat, and completing it is the end of it.
//
// **A reminder is due on a day, not at a moment.** `due` is a plain local
// calendar date, `YYYY-MM-DD`. That is a deliberate narrowing of an earlier
// design that stored an instant: nothing here fires at a time — the list is
// something you read — so a time of day was a field to fill in that changed
// nothing, and storing an instant made the date itself fragile, since the same
// moment is two different days either side of a timezone. As strings these dates
// also compare and sort exactly as dates, so the ordering below is a plain string
// comparison with no parsing and no clock in it.

// The **list** a reminder belongs to — "todo", "shopping", "work". It is a plain
// free-text label rather than a fixed set: the editor offers the ones already in
// use and takes anything else typed in, so the vocabulary is whatever the vault
// grew, and there is nothing to configure and nothing to keep in sync when the
// last reminder in a list is completed (the list simply stops being offered).
export const DEFAULT_LIST = 'todo';

// The list only has to notice the day rolling over, so it re-reads the clock
// about once a minute rather than every 15 seconds as it did when a due time
// could pop an alert.
export const REMINDER_TICK_MS = 60000;
// "Extend due to": push a reminder's due date out by a fixed step. The label is
// the bare duration — the row menu writes it as `Extend by 1 day`. The steps are
// whole days and months because the due date is a day; `months` is clamped to the
// target month's last day.
export const EXTEND_OPTIONS = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '1 month', months: 1 },
];

// The list itself. Only this module reassigns it, so importers get a live view
// of it for free.
export let reminders = [];

export function newReminderId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---- Dates ----
// One representation throughout: a `YYYY-MM-DD` string on the way in and out, a
// local-midnight `Date` for the arithmetic in between.

/** A local Date (midnight) as `YYYY-MM-DD`. */
export function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` as a local-midnight Date, or null if it isn't one. */
export function parseDate(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject a date that doesn't exist (31 Feb rolls over into March).
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

export function today() {
  return dateKey(new Date());
}

// New reminders default to today.
export function defaultDue() {
  return today();
}

// Whatever a stored file holds, as a date. A reminder written by an earlier
// version is a UTC ISO *instant*, so it is read back in local time and reduced to
// the day it fell on — which is the day it was set for.
export function toDueDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const plain = parseDate(value.slice(0, 10));
  if (plain) return dateKey(plain);
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : dateKey(at);
}

// Whole days between two `YYYY-MM-DD` dates.
function dayDelta(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function formatDue(due) {
  const d = parseDate(due);
  if (!d) return '—';
  const now = new Date();
  const days = dayDelta(dateKey(now), due);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  /** @type {Intl.DateTimeFormatOptions} */
  const opts =
    d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

// ---- Buckets ----
// What the list groups by, and the difference "today" makes: an entry due today
// is the one thing the list exists to put in front of you, so it gets a group and
// a row style of its own rather than being the near end of "this week".
//
// **Weeks start on Monday.** Chromium can report the locale's own first day
// (`Intl.Locale.prototype.getWeekInfo`), but a list that regroups itself by where
// the app is running is harder to reason about than one that simply says Monday,
// and the boundary only ever moves a row between two adjacent groups.
export const BUCKET_LABELS = {
  overdue: 'Overdue',
  today: 'Today',
  thisWeek: 'This week',
  nextWeek: 'Next week',
  later: 'Later',
};

function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function startOfWeek(d) {
  return addDays(d, -((d.getDay() + 6) % 7)); // Sunday is 0, so shift to Monday-first
}

// Which group a due date falls in. `now` is passed in so a whole render shares
// one day — a list rendered across midnight would otherwise be grouped against a
// date that moved mid-loop.
export function dueBucket(due, now = today()) {
  const d = parseDate(due);
  if (!d) return 'later';
  if (due < now) return 'overdue';
  if (due === now) return 'today';
  const week = startOfWeek(parseDate(now));
  if (due < dateKey(addDays(week, 7))) return 'thisWeek';
  return due < dateKey(addDays(week, 14)) ? 'nextWeek' : 'later';
}

// `months` on from `d`, clamped to the target month's last day, so extending a
// month-end date doesn't skip a month (31 Jan + 1 month is 28 Feb, not 3 Mar).
function addMonths(d, months) {
  const out = new Date(d);
  const day = out.getDate();
  out.setDate(1); // avoid setMonth overflowing on the way past
  out.setMonth(out.getMonth() + months);
  out.setDate(Math.min(day, new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()));
  return out;
}

// A list name as stored: trimmed, and never empty — an entry that predates lists
// (or was hand-written without one) belongs to the default rather than to a
// nameless list of its own.
export function normalizeList(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || DEFAULT_LIST;
}

// Every list in use, plus the default so the editor and the filter can always
// offer it. Deduplicated case-insensitively — "Work" and "work" are one list, and
// the first spelling alphabetically is the one shown.
export function reminderLists() {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const name of [DEFAULT_LIST, ...reminders.map((r) => r.list)]) {
    const key = name.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined || name < prev) seen.set(key, name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Tolerate a hand-edited reminders file: drop anything without a usable title/date.
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const due = toDueDate(r.due);
  if (!title || !due) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newReminderId(),
    title,
    due,
    list: normalizeList(r.list),
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
  sortReminders();
  renderReminders();
  startReminderTicker();
}

function sortReminders() {
  // `YYYY-MM-DD` sorts chronologically as a string; the title breaks the tie so
  // two reminders on the same day don't swap places on every rewrite.
  reminders.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.title.localeCompare(b.title)));
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

// Completing a reminder and deleting it are now the same operation: without a
// repeat rule there is nothing to roll a completed one forward to, so the ✓
// button and the menu's Delete both land here rather than pretending otherwise.
export async function removeReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  reminders.splice(i, 1);
  await persistReminders();
}

// Push a reminder's due date out by a fixed step, measured from whichever is
// later — today, or its own due date. Both readings of "extend" are the right one
// somewhere: a pending reminder moves by the step the user asked for, while an
// overdue one lands the step from today rather than somewhere still in the past.
export async function extendReminder(id, step) {
  const rem = reminders.find((r) => r.id === id);
  if (!rem) return;
  const due = extendedDue(rem.due, step);
  if (!due) return;
  rem.due = due;
  await persistReminders();
}

// The date `extendReminder` would land on, so the UI can show it before committing.
export function extendedDue(due, step) {
  const now = today();
  const from = parseDate(due && due > now ? due : now);
  if (!from) return null;
  return dateKey(step.months ? addMonths(from, step.months) : addDays(from, step.days));
}
