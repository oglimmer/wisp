// Reminders: the model, its storage, and the date maths.

import { api } from './api.js';
import { renderReminders, startReminderTicker } from './reminders-ui.js';
import { state } from './state.js';
import { setStatus } from './util.js';
import type { Reminder } from '../types/ipc';

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
/** One step of "extend due to": whole days, or whole months. Never both. */
export interface ExtendStep {
  label: string;
  days?: number;
  months?: number;
}

export const EXTEND_OPTIONS: ExtendStep[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '1 month', months: 1 },
];

// The list itself. Only this module reassigns it, so importers get a live view
// of it for free.
export let reminders: Reminder[] = [];

export function newReminderId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

// ---- Dates ----
// One representation throughout: a `YYYY-MM-DD` string on the way in and out, a
// local-midnight `Date` for the arithmetic in between.

/** A local Date (midnight) as `YYYY-MM-DD`. */
export function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` as a local-midnight Date, or null if it isn't one. */
export function parseDate(due: string | null | undefined) {
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
export function toDueDate(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const plain = parseDate(value.slice(0, 10));
  if (plain) return dateKey(plain);
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : dateKey(at);
}

// Whole days between two `YYYY-MM-DD` dates.
function dayDelta(from: string, to: string) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Takes the null `extendedDue()` answers with for a date it could not parse: the
// em dash this already shows for an unreadable date is the right thing there too.
export function formatDue(due: string | null) {
  const d = parseDate(due);
  if (!d) return '—';
  const now = new Date();
  // `dateKey(d)` rather than `due`: it is the same string for anything that
  // parsed, and it is the one the checker knows is a string.
  const days = dayDelta(dateKey(now), dateKey(d));
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions =
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
/** The groups the list renders under, nearest first. */
export type DueBucket = 'overdue' | 'today' | 'thisWeek' | 'nextWeek' | 'later';

export const BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  thisWeek: 'This week',
  nextWeek: 'Next week',
  later: 'Later',
};

function addDays(d: Date, days: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function startOfWeek(d: Date) {
  return addDays(d, -((d.getDay() + 6) % 7)); // Sunday is 0, so shift to Monday-first
}

// Which group a due date falls in. `now` is passed in so a whole render shares
// one day — a list rendered across midnight would otherwise be grouped against a
// date that moved mid-loop.
export function dueBucket(due: string, now = today()): DueBucket {
  const d = parseDate(due);
  if (!d) return 'later';
  if (due < now) return 'overdue';
  if (due === now) return 'today';
  // `now` comes from `today()` and always parses; an unparseable one has no week
  // to measure against, so it falls in with the undated entries.
  const nowDate = parseDate(now);
  if (!nowDate) return 'later';
  const week = startOfWeek(nowDate);
  if (due < dateKey(addDays(week, 7))) return 'thisWeek';
  return due < dateKey(addDays(week, 14)) ? 'nextWeek' : 'later';
}

// `months` on from `d`, clamped to the target month's last day, so extending a
// month-end date doesn't skip a month (31 Jan + 1 month is 28 Feb, not 3 Mar).
function addMonths(d: Date, months: number) {
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
export function normalizeList(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || DEFAULT_LIST;
}

// Every list in use, plus the default so the editor and the filter can always
// offer it. Deduplicated case-insensitively — "Work" and "work" are one list, and
// the first spelling alphabetically is the one shown.
export function reminderLists() {
  const seen: Map<string, string> = new Map();
  for (const name of [DEFAULT_LIST, ...reminders.map((r) => r.list)]) {
    const key = name.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined || name < prev) seen.set(key, name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Tolerate a hand-edited reminders file: drop anything without a usable title/date.
function normalizeReminder(r: unknown): Reminder | null {
  if (!r || typeof r !== 'object') return null;
  // The file is hand-editable, so every field is checked rather than trusted; the
  // cast only buys the right to *ask* about each one.
  const raw = r as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const due = toDueDate(raw.due);
  if (!title || !due) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newReminderId(),
    title,
    due,
    list: normalizeList(raw.list),
    note: typeof raw.note === 'string' ? raw.note : '',
    file: typeof raw.file === 'string' ? raw.file : '',
  };
}

export async function loadReminders() {
  const res = await api.readReminders(state.baseFolder);
  // A failed read has no list at all — an unreadable file leaves the sidebar
  // empty rather than throwing on the way past.
  const stored = res.ok ? res.reminders : [];
  reminders = stored.map(normalizeReminder).filter((r): r is Reminder => r !== null);
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
export async function remapReminderFiles(oldRel: string, newRel: string) {
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

export async function upsertReminder(rem: Reminder) {
  const i = reminders.findIndex((r) => r.id === rem.id);
  if (i === -1) reminders.push(rem);
  else reminders[i] = rem;
  await persistReminders();
}

// Completing a reminder and deleting it are now the same operation: without a
// repeat rule there is nothing to roll a completed one forward to, so the ✓
// button and the menu's Delete both land here rather than pretending otherwise.
export async function removeReminder(id: string) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  reminders.splice(i, 1);
  await persistReminders();
}

// Push a reminder's due date out by a fixed step, measured from whichever is
// later — today, or its own due date. Both readings of "extend" are the right one
// somewhere: a pending reminder moves by the step the user asked for, while an
// overdue one lands the step from today rather than somewhere still in the past.
export async function extendReminder(id: string, step: ExtendStep) {
  const rem = reminders.find((r) => r.id === id);
  if (!rem) return;
  const due = extendedDue(rem.due, step);
  if (!due) return;
  rem.due = due;
  await persistReminders();
}

// The date `extendReminder` would land on, so the UI can show it before committing.
export function extendedDue(due: string, step: ExtendStep) {
  const now = today();
  const from = parseDate(due && due > now ? due : now);
  if (!from) return null;
  // A step naming neither days nor months is no step at all, which leaves the due
  // date where it was — the only sane reading of an option with nothing in it.
  return dateKey(step.months ? addMonths(from, step.months) : addDays(from, step.days ?? 0));
}
