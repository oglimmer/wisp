import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import { noteOwnWrite } from './watch.mjs';

const fsp = fs.promises;

// The reminder list lives in the vault root so it travels with the notes, but it
// is app state rather than a note — hidden from the tree (and from smart insert).
const REMINDERS_FILE = '.wisp-reminders.json';

// ---- Reminders ----

// The whole list is read and written as one JSON document — same philosophy as the
// tree (rebuild, don't mutate). It's small, and keeping it a single plain file means
// the vault stays self-describing with no index to fall out of sync.
handle('read-reminders', async (baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: true, reminders: [] };
  const file = path.join(baseFolder, REMINDERS_FILE);
  if (!fs.existsSync(file)) return { ok: true, reminders: [] };
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.reminders;
  return { ok: true, reminders: Array.isArray(list) ? list : [] };
});

handle('write-reminders', async (baseFolder, reminders) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  const file = path.join(baseFolder, REMINDERS_FILE);
  const body = JSON.stringify({ reminders: Array.isArray(reminders) ? reminders : [] }, null, 2);
  noteOwnWrite(file);
  await fsp.writeFile(file, body, 'utf8');
  return { ok: true };
});
