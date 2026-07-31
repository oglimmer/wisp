import fs from 'fs';
import { handle } from './ipc.mjs';
import { claudeEnv, hostCommand, hostCliEnv } from './host.mjs';
import { sendToWindow } from './window.mjs';

// ---- The terminal pane ----
//
// The pane at the bottom of the editor runs `claude` interactively, which is a
// different thing from the one-shot `runClaude()` calls smart insert makes: the
// CLI is a full-screen TUI, so it needs a real pty — its own tty, raw keystrokes,
// a SIGWINCH when the pane is resized — rather than pipes it would see as a
// non-interactive stream. node-pty provides that, and ships N-API prebuilds, so
// nothing has to be rebuilt against Electron's ABI (`scripts/pty-permissions.js`
// covers the one thing those prebuilds get wrong).
//
// **The renderer never names the program.** `term-start` always spawns `claude`
// in the open vault, and `term-input` only ever writes to that process's tty:
// there is deliberately no channel here that runs an arbitrary command, which is
// the same reason git is only ever driven through `spawn('git', …)` below.
//
// One session at a time, for the one window. Starting a second replaces the
// first, and the window going away kills it — an orphaned `claude` holding a pty
// nobody can see would keep running (and keep spending) invisibly.

/** @type {import('node-pty').IPty | null} */
let ptyProcess = null;
/** @type {typeof import('node-pty') | null | undefined} */
let ptyModule; // undefined = not tried yet, null = unavailable

// Imported on first use rather than at startup: a missing or unloadable native
// prebuild has to degrade to a terminal pane that says so, not take the app down
// before the window exists.
async function loadPty() {
  if (ptyModule === undefined) {
    try {
      const mod = await import('node-pty');
      ptyModule = mod.default ?? mod;
    } catch (err) {
      ptyModule = null;
      console.error('node-pty is unavailable, the terminal pane is disabled:', err);
    }
  }
  return ptyModule;
}

// A pty size arrives from the renderer's fit calculation, so it is only ever as
// trustworthy as any other renderer input; the ioctl behind it takes 16-bit
// values, and 0 columns makes the TUI unrenderable.
function ptyDimension(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 && n <= 1000 ? n : fallback;
}

// Clears `ptyProcess` *before* killing, so the dying session's onExit — which is
// how the renderer learns claude stopped — can tell it is not the current one and
// stay quiet. Otherwise a restart reports the old session's exit over the new one.
export function killPty() {
  const doomed = ptyProcess;
  ptyProcess = null;
  if (!doomed) return;
  try {
    doomed.kill();
  } catch {}
}

handle('term-start', async (baseFolder, cols, rows) => {
  const pty = await loadPty();
  if (!pty) return { ok: false, error: 'The terminal is unavailable in this build.' };
  if (typeof baseFolder !== 'string' || !fs.existsSync(baseFolder)) {
    return { ok: false, error: 'No folder is open.' };
  }
  killPty();

  // claudeEnv() for the same reason every other spawn uses it: a bundled .app
  // launched from Finder has a bare PATH and would not find `claude` at all.
  // TERM is what makes the CLI draw its full-screen UI rather than fall back to
  // line-at-a-time output, and it has to match what xterm.js can actually paint.
  const env = { ...claudeEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const command = hostCommand('claude', [], baseFolder, hostCliEnv(env));
  const child = pty.spawn(command.command, command.args, {
    name: 'xterm-256color',
    cols: ptyDimension(cols, 80),
    rows: ptyDimension(rows, 24),
    cwd: command.cwd,
    env,
  });
  ptyProcess = child;

  // Both callbacks check they still own the session: a replaced pty can emit a
  // last chunk (or its exit) after `term-start` has handed the pane to a new one.
  child.onData((data) => {
    if (ptyProcess === child) sendToWindow('term-data', data);
  });
  child.onExit(({ exitCode, signal }) => {
    if (ptyProcess !== child) return;
    ptyProcess = null;
    sendToWindow('term-exit', { exitCode, signal });
  });

  return { ok: true, pid: child.pid };
});

// Keystrokes, straight through to the tty. A write to a session that has already
// exited is an ordinary race (the user typed into a pane whose claude just quit),
// not an error worth surfacing.
handle('term-input', async (data) => {
  if (!ptyProcess) return { ok: false, error: 'No session is running.' };
  if (typeof data !== 'string') throw new Error('Invalid terminal input.');
  ptyProcess.write(data);
  return { ok: true };
});

// The pane was resized: tell the tty, so the TUI reflows instead of drawing to a
// width that no longer exists.
// Under Flatpak this resizes the pty but the TUI does not reflow, and cannot:
// TIOCSWINSZ signals the foreground process group of the pty's session, and
// `flatpak-spawn --host` started the program in the host's PID namespace, so it
// is not that group. Measured against an in-sandbox control that does receive
// the signal; flatpak-spawn has no signal forwarding, and --share-pids /
// --expose-pids do not apply to --host. The *size* still reads correctly through
// the forwarded fd, so a session opens at the right size and only later resizes
// go unnoticed. The smoke run asserts the session survives a resize, not that it
// reflows.
handle('term-resize', async (cols, rows) => {
  if (!ptyProcess) return { ok: false, error: 'No session is running.' };
  ptyProcess.resize(ptyDimension(cols, 80), ptyDimension(rows, 24));
  return { ok: true };
});

handle('term-stop', async () => {
  killPty();
  return { ok: true };
});
