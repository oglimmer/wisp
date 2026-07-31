import { spawn } from 'child_process';
import { claudeEnv, hostCommand, hostCliEnv } from './host.mjs';

// ---- The claude CLI, non-interactively ----
//
// One-shot `claude -p … --output-format json` invocations back smart insert,
// smart lookup and image analysis (the interactive terminal pane is a different
// mechanism — see terminal.mjs). This module owns the spawn and the reading of
// the reply; the handlers and prompts live in smart.mjs.

// What one non-interactive run answers with: the raw stdout, or the reason there
// isn't any. Stated rather than inferred so callers can narrow on `ok`.
type ClaudeRun = { ok: true; stdout: string } | { ok: false; error: string };

// Run the `claude` CLI non-interactively and return its raw stdout.
export function runClaude(cwd: string, prompt: string): Promise<ClaudeRun> {
  return new Promise<ClaudeRun>((resolve) => {
    let child;
    try {
      const env = claudeEnv();
      const command = hostCommand(
        'claude',
        ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'],
        cwd,
        hostCliEnv(env)
      );
      child = spawn(command.command, command.args, { cwd: command.cwd, env });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'Claude timed out (over 3 minutes).' });
    }, 180000);

    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error:
          err.code === 'ENOENT'
            ? 'The `claude` CLI was not found on your PATH.'
            : String(err),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout) {
        resolve({ ok: false, error: stderr.trim() || `claude exited with code ${code}` });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// Every balanced `{…}` span in `text`, in order. The scan tracks JSON string
// literals, which is the whole point: a brace, or a ``` fence, inside a string is
// content — and `newContent` routinely carries both, since it is a Markdown note.
// The old first-`{`-to-last-`}` slice broke on prose that contained a brace, and
// stripping the first code fence truncated any reply whose JSON held one.
// `truncated` marks a span that opened and never closed — a reply cut off
// mid-object, which is a different problem from a reply that had no JSON in it.
function jsonSpans(text: string): { spans: string[]; truncated: boolean } {
  const spans: string[] = [];
  let truncated = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (escaped) {
        escaped = false;
      } else if (inString) {
        if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      // Nothing after an unclosed brace can balance either, so stop here.
      truncated = true;
      break;
    }
    spans.push(text.slice(i, j + 1));
    i = j; // a nested `{` is part of this span, not a candidate of its own
  }
  return { spans, truncated };
}

// Pull a JSON object out of arbitrary model text, and say why when there isn't one:
// `truncated` (cut off mid-object), `malformed` (something brace-shaped that won't
// parse) or `none` (prose, or an error message where JSON was asked for).
function parseModelJson(
  text: string,
): { value: any; reason: 'ok' | 'truncated' | 'malformed' | 'none' } {
  if (!text) return { value: null, reason: 'none' };
  const t = String(text).trim();
  try {
    return { value: JSON.parse(t), reason: 'ok' };
  } catch {}
  const { spans, truncated } = jsonSpans(t);
  for (const span of spans) {
    try {
      return { value: JSON.parse(span), reason: 'ok' };
    } catch {}
  }
  if (truncated) return { value: null, reason: 'truncated' };
  return { value: null, reason: spans.length ? 'malformed' : 'none' };
}

// Pull a JSON object out of arbitrary model text (tolerates code fences / stray prose).
export function extractJson(text: string) {
  return parseModelJson(text).value;
}

function firstLine(s: string, max = 200) {
  const line = String(s).split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// What the CLI itself reported. `--output-format json` always answers with a result
// envelope, and `subtype` is `success` only when the run actually finished — a
// usage limit, an API error or an exhausted turn budget all come back as a
// well-formed envelope whose `result` is an error message rather than the model's
// answer. Reading only `result` turned every one of those into "could not
// understand Claude's response", which is the one thing they are not.
// `envelope` is whatever JSON.parse returned, so it is genuinely `any` here — the
// shape is the CLI's to decide and every field below is probed before it is used.
function envelopeError(envelope: any) {
  if (!envelope || typeof envelope !== 'object' || envelope.type !== 'result') return null;
  if (envelope.subtype === 'success' && !envelope.is_error) return null;
  const detail =
    typeof envelope.result === 'string' && envelope.result.trim() ? firstLine(envelope.result) : '';
  if (envelope.api_error_status) {
    return `Claude’s API answered ${envelope.api_error_status}${detail ? `: ${detail}` : '.'}`;
  }
  if (envelope.subtype === 'error_max_turns') {
    return 'Claude ran out of turns before it answered.';
  }
  if (detail) return `Claude reported an error: ${detail}`;
  return `Claude reported an error (${envelope.subtype || 'no reason given'}).`;
}

// A parse failure is the one Claude problem that leaves no trace anywhere else —
// the renderer gets a one-line status and the reply itself is gone. So the raw
// text goes to the main process's console (head and tail, since a reply can be a
// whole file, and a truncation is only visible at the end) alongside the envelope
// fields that say how the run ended.
function logClaudeFailure(what: string, error: string, envelope: any, text: string) {
  const raw = String(text || '');
  const shown =
    raw.length > 2000 ? `${raw.slice(0, 1200)}\n…[${raw.length - 1700} chars]…\n${raw.slice(-500)}` : raw;
  const meta =
    envelope && typeof envelope === 'object'
      ? {
          subtype: envelope.subtype,
          is_error: envelope.is_error,
          stop_reason: envelope.stop_reason,
          api_error_status: envelope.api_error_status,
          num_turns: envelope.num_turns,
          permission_denials: envelope.permission_denials,
        }
      : '(the CLI did not answer with a result envelope)';
  console.error(`[${what}] ${error}`, meta);
  console.error(`[${what}] raw reply, ${raw.length} chars:\n${shown}`);
}

// Read what the `claude` CLI actually answered. All three Claude-backed handlers
// want the same thing — one JSON object of a known shape — and each used to answer
// every surprise with the same sentence. `describe` returns a message when the
// reply parsed but isn't usable, so "arrived in the wrong shape" reads differently
// from "never arrived", and both differ from the CLI failing outright.
export function readClaudeJson(
  what: string,
  stdout: string,
  describe: (value: any) => string | null,
): { ok: true; value: any } | { ok: false; error: string } {
  let envelope: any = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {}

  const reported = envelopeError(envelope);
  if (reported) {
    logClaudeFailure(what, reported, envelope, stdout);
    return { ok: false, error: reported };
  }

  const modelText =
    envelope && typeof envelope.result === 'string' ? envelope.result : stdout;
  const parsed = parseModelJson(modelText);
  const wrongShape = parsed.value ? describe(parsed.value) : null;
  if (parsed.value && !wrongShape) return { ok: true, value: parsed.value };

  // `stop_reason` says the model hit its output limit even where the JSON happens
  // to have survived it, so it is the more honest explanation when both apply.
  const cutOff = parsed.reason === 'truncated' || (envelope && envelope.stop_reason === 'max_tokens');
  let error;
  if (cutOff) {
    error = 'Claude’s reply was cut off before it finished. Try again, or with a shorter note.';
  } else if (wrongShape) {
    error = wrongShape;
  } else if (!envelope) {
    error = 'The `claude` CLI answered with something that wasn’t JSON.';
  } else {
    error = 'Claude answered in prose instead of the JSON it was asked for.';
  }
  logClaudeFailure(what, error, envelope, modelText);
  return { ok: false, error };
}
