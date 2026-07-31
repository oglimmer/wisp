import path from 'path';
import fs from 'fs';
import { handle } from './ipc.mjs';
import { vaultPath, isInside, assertReadableFile, assertTextContent, formatBytesLimit, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } from './guards.mjs';
import { isIgnored } from './tree.mjs';
import { runClaude, readClaudeJson } from './claude.mjs';

const fsp = fs.promises;

// The image types the `claude` CLI can actually look at (what its Read tool
// accepts as an image). The rest still import fine — they just skip analysis
// rather than having Claude read e.g. an .svg as source text and describe markup.
const ANALYZABLE_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// ---- Smart insert (Claude-powered "file this note") ----

// Gather every (non-ignored) file as { rel, content }. To let Claude decide in a
// single turn (no Read round-trips) we inline the text of small files; larger
// files, or files past a total budget, are listed by name only and can be Read.
const INLINE_FILE_MAX = 16 * 1024; // don't inline a single file bigger than this
const INLINE_TOTAL_MAX = 96 * 1024; // stop inlining once we've included this much
async function gatherFiles(baseFolder) {
  const out = [];
  let budget = INLINE_TOTAL_MAX;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(baseFolder, full);
      /** @type {string | null} */
      let content = null;
      try {
        const stat = await fsp.stat(full);
        if (stat.size <= INLINE_FILE_MAX && budget - stat.size >= 0) {
          content = await fsp.readFile(full, 'utf8');
          budget -= stat.size;
        }
      } catch {}
      out.push({ rel, content });
    }
  }
  await walk(baseFolder);
  return out;
}

// Human-readable local "now", so Claude can resolve relative dates in a note
// ("tomorrow", "next Friday", "in two weeks") into an absolute reminder time.
function describeNow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `${stamp} (${day})`;
}

// Build the instruction we hand to the `claude` CLI. It must reply with a single
// JSON object describing where the note goes, the file's full new content, and
// whether the note implies a reminder.
function buildInsertPrompt(files, text, currentRel) {
  let filesSection;
  if (!files.length) {
    filesSection = '(the vault is empty — you will be creating the first file)';
  } else {
    filesSection = files
      .map((f) => {
        if (f.content === null) {
          return `### ${f.rel}\n(large file — read it if you need its contents)`;
        }
        return `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``;
      })
      .join('\n\n');
  }
  const openHint = currentRel
    ? `\nThe user currently has this file open: ${currentRel}. Only prefer it if the note genuinely belongs there.\n`
    : '';
  return [
    'You are helping file a short note into a plain-text / Markdown notes vault.',
    'The vault root is your current working directory. Here are the existing files and their contents:',
    '',
    filesSection,
    '',
    'The note the user wants to add:',
    '"""',
    text,
    '"""',
    openHint,
    'Decide the single best destination for this note:',
    '- Choose an existing file if the note clearly belongs with its content, otherwise propose a new file with a sensible .md name.',
    '- Decide exactly where inside the file the note should go and integrate it naturally, matching the existing formatting and heading structure.',
    '- You may lightly adjust wording for fit, but never invent unrelated content or delete existing content.',
    '- Contents above are provided inline; only use Read for files marked as large.',
    '',
    `The current local date and time is ${describeNow()}.`,
    'Then decide whether this note also warrants a reminder:',
    '- Create one only for a genuine time-bound commitment: a deadline, appointment, booking,',
    '  renewal, follow-up, or an explicit "remind me" / "don\'t forget".',
    '- A plain fact, idea or reference needs no reminder — use null in that case.',
    '- "due" must be an absolute LOCAL date-time in "YYYY-MM-DDTHH:mm" form, resolved against',
    '  the current date and time above, and it must be in the future.',
    '- If the note implies a day but no time of day, use 09:00.',
    '- For something recurring, set "repeat" to daily, weekly, monthly or yearly; otherwise "none".',
    '- "title" is a short imperative label (e.g. "Renew passport"), not the whole note.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"targetFile":"<relative path>","isNew":<true|false>,"reason":"<one short sentence>",' +
      '"newContent":"<the complete new content of the target file>",' +
      '"reminder":{"title":"<short label>","due":"<YYYY-MM-DDTHH:mm>","repeat":"<none|daily|weekly|monthly|yearly>","reason":"<why this needs a reminder>"}}',
    'Set "reminder" to null when no reminder is warranted.',
  ].join('\n');
}

// Validate the reminder Claude proposed. Anything malformed (or in the past) is
// dropped rather than surfaced — a bogus alarm is worse than no alarm.
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);
function sanitizeReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const due = typeof raw.due === 'string' ? raw.due.trim() : '';
  if (!title || !due) return null;
  // "YYYY-MM-DDTHH:mm" with no zone is parsed as local time, which is what we want.
  const when = new Date(due);
  if (Number.isNaN(when.getTime())) return null;
  return {
    title,
    due: when.toISOString(),
    repeat: REPEATS.has(raw.repeat) ? raw.repeat : 'none',
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
  };
}

// Ask Claude where a note should go. Returns a plan (target + proposed new content
// + the current content, so the renderer can preview the change) but writes nothing.
handle('smart-check', async (baseFolder, currentFile, text) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!text || !text.trim()) return { ok: false, error: 'Nothing to add.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildInsertPrompt(files, text, currentRel));
  if (!res.ok) return res;

  const read = readClaudeJson('smart-check', res.stdout, (v) => {
    if (!v || typeof v !== 'object') return 'Claude’s answer wasn’t a filing plan.';
    if (!v.targetFile) return 'Claude didn’t say which file to file this into.';
    if (typeof v.newContent !== 'string') return 'Claude didn’t include the file’s new content.';
    return null;
  });
  if (!read.ok) return read;
  const plan = read.value;

  let target;
  try {
    target = vaultPath(baseFolder, plan.targetFile, 'Claude chose a path outside the vault.');
  } catch {
    return { ok: false, error: 'Claude chose a path outside the vault.' };
  }
  if (typeof plan.newContent === 'string' && Buffer.byteLength(plan.newContent, 'utf8') > MAX_TEXT_BYTES) {
    return { ok: false, error: `Proposed content is too large (max ${formatBytesLimit(MAX_TEXT_BYTES)}).` };
  }
  const exists = fs.existsSync(target);
  let oldContent = '';
  if (exists) {
    try {
      assertReadableFile(target, MAX_TEXT_BYTES, 'File');
      oldContent = await fsp.readFile(target, 'utf8');
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Could not read target file.' };
    }
  }

  return {
    ok: true,
    plan: {
      targetFile: path.relative(baseFolder, target),
      isNew: !exists,
      reason: typeof plan.reason === 'string' ? plan.reason : '',
      newContent: plan.newContent,
      oldContent,
      reminder: sanitizeReminder(plan.reminder),
    },
  };
});

// ---- Smart lookup (Claude-powered "answer from my notes") ----

// The other direction to smart insert: instead of filing text into the vault, read
// the vault to answer a question. Same inlined-files trick, so the usual question
// is answered in one turn.
function buildLookupPrompt(files, question, currentRel) {
  let filesSection;
  if (!files.length) {
    filesSection = '(the vault is empty)';
  } else {
    filesSection = files
      .map((f) => {
        if (f.content === null) {
          return `### ${f.rel}\n(large file — read it if you need its contents)`;
        }
        return `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``;
      })
      .join('\n\n');
  }
  const openHint = currentRel ? `\nThe user currently has this file open: ${currentRel}.\n` : '';
  return [
    'You are answering a question using only a plain-text / Markdown notes vault.',
    'The vault root is your current working directory. Here are the existing files and their contents:',
    '',
    filesSection,
    '',
    'The question:',
    '"""',
    question,
    '"""',
    openHint,
    `The current local date and time is ${describeNow()}.`,
    'Answer it from the notes:',
    '- Use only what the notes actually say. Never fill gaps with outside knowledge or guesses.',
    '- If the notes do not answer the question, say so plainly and leave "sources" empty.',
    '- If they answer it only partly, give what is there and say what is missing.',
    '- Contents above are provided inline; only use Read for files marked as large.',
    '- Keep "answer" to a few sentences of plain prose — no Markdown, no lists, no line breaks.',
    '- List every file you drew on in "sources", most relevant first, with a short note on',
    '  what that file contributed. Cite only files you actually used.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"answer":"<a few sentences>","sources":[{"file":"<relative path>","detail":"<what this file contributed>"}]}',
  ].join('\n');
}

// Keep only sources that name a real file inside the vault — a made-up citation is
// worse than none, and the renderer turns each one into a click that opens the file.
function sanitizeSources(raw, baseFolder) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!file) continue;
    let target;
    try {
      target = vaultPath(baseFolder, file, 'Outside the vault.');
    } catch {
      continue;
    }
    if (!fs.existsSync(target)) continue;
    const rel = path.relative(baseFolder, target).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({
      file: rel,
      detail: typeof item.detail === 'string' ? item.detail.trim() : '',
    });
  }
  return out;
}

// Ask Claude a question about the vault. Read-only: nothing is written.
handle('smart-lookup', async (baseFolder, currentFile, question) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  if (!question || !question.trim()) return { ok: false, error: 'Nothing to look up.' };

  const files = await gatherFiles(baseFolder);
  const currentRel =
    currentFile && isInside(baseFolder, currentFile)
      ? path.relative(baseFolder, currentFile)
      : null;

  const res = await runClaude(baseFolder, buildLookupPrompt(files, question, currentRel));
  if (!res.ok) return res;

  const read = readClaudeJson('smart-lookup', res.stdout, (v) => {
    if (!v || typeof v !== 'object') return 'Claude’s answer wasn’t in the expected shape.';
    if (typeof v.answer !== 'string' || !v.answer.trim()) return 'Claude didn’t answer the question.';
    return null;
  });
  if (!read.ok) return read;
  const parsed = read.value;

  return {
    ok: true,
    result: {
      question,
      answer: parsed.answer.trim(),
      sources: sanitizeSources(parsed.sources, baseFolder),
    },
  };
});

// ---- Image analysis (Claude-powered alt text + description) ----

function buildImagePrompt(rel) {
  return [
    'Read the image file below and describe what it actually shows.',
    '',
    rel,
    '',
    'It has just been added to a plain-text notes vault (your working directory). The',
    'description is stored in the note next to the image and is what the user will search',
    'later, so be concrete and factual.',
    '- "alt": one short line naming what the image is, under 100 characters, for the',
    '  Markdown alt text (e.g. "a bar chart of Q3 revenue by region").',
    '- "description": a fuller account in plain prose — the kind of image it is, its key',
    '  elements, and any text, numbers or labels visible in it, transcribed accurately.',
    '  A few sentences, at most about 150 words. One paragraph: no lists, no line breaks,',
    '  no Markdown or HTML formatting.',
    '- Describe only what you can actually see. Never guess at anything else.',
    '- Do not open any other file; the image above is all you need.',
    '',
    'Respond with ONLY a JSON object (no prose, no code fence) of exactly this shape:',
    '{"alt":"<one short line>","description":"<a few sentences>"}',
  ].join('\n');
}

// Escape text that will be embedded in the note's HTML <details> block, so a model
// description can only ever be read as text — never as markup the preview renders.
function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Keep only a well-formed { alt, description }: both single-line (the block is
// written without blank lines so it stays one HTML block) and length-capped.
function sanitizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flatten = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  // `]` would close the Markdown alt early; brackets add nothing to a description.
  let alt = flatten(raw.alt).replace(/[[\]]/g, '').slice(0, 120).trim();
  let description = escapeHtmlText(flatten(raw.description)).slice(0, 2000).trim();
  if (!alt && !description) return null;
  if (!alt) alt = description.slice(0, 100).trim();
  return { alt, description };
}

// Describe a freshly-imported image with Claude. Returns { alt, description } for
// the renderer to fold into the note; writes nothing itself. `skipped` marks an
// image type Claude can't look at, which is not an error worth reporting.
handle('analyze-image', async (baseFolder, imagePath) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: false, error: 'No folder open.' };
  const target = vaultPath(baseFolder, imagePath || '', 'Image is outside the vault.');
  if (!ANALYZABLE_IMAGE.has(path.extname(target).toLowerCase())) {
    return { ok: false, skipped: true, error: 'Claude can’t read this image type.' };
  }
  try {
    assertReadableFile(target, MAX_IMAGE_BYTES, 'Image');
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Image not found.' };
  }

  const rel = path.relative(baseFolder, target).split(path.sep).join('/');
  const res = await runClaude(baseFolder, buildImagePrompt(rel));
  if (!res.ok) return res;

  const read = readClaudeJson('analyze-image', res.stdout, (v) =>
    sanitizeAnalysis(v) ? null : 'Claude didn’t describe the image.'
  );
  if (!read.ok) return read;
  // Re-run rather than thread the value out of `describe`: it is the sanitizer that
  // decides what a usable description is, and one caller of it means one answer.
  const analysis = sanitizeAnalysis(read.value);
  if (!analysis) return { ok: false, error: 'Claude didn’t describe the image.' };
  return { ok: true, ...analysis };
});

// Apply a previously-checked plan: write the new content (creating parent dirs).
handle('smart-apply', async (baseFolder, relPath, content) => {
  const target = vaultPath(baseFolder, relPath);
  assertTextContent(content);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, 'utf8');
  return { ok: true, path: target };
});
