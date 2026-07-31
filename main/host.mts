import { app } from 'electron';
import path from 'path';
import { execFileSync } from 'child_process';

// Flatpak cannot see programs installed on the host. Keep the command itself
// fixed in each caller, but cross the sandbox boundary when this build is
// running there so git and the user's Claude installation remain available.
export function hostCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  unset: string[] = [],
) {
  if (!process.env.FLATPAK_ID) return { command, args, cwd };
  const search = hostSearchPath();
  const envArgs = Object.entries(search ? { ...env, PATH: search } : env)
    .filter((entry) => typeof entry[1] === 'string')
    .map(([name, value]) => `--env=${name}=${value}`);
  return {
    command: 'flatpak-spawn',
    args: [
      '--host',
      '--watch-bus',
      `--directory=${cwd}`,
      ...envArgs,
      ...unset.map((name) => `--unset-env=${name}`),
      command,
      ...args,
    ],
    cwd,
  };
}

// **PATH is the one variable that must not simply be forwarded.** Inside the
// sandbox it describes the sandbox (`/app/bin:/usr/bin`), so passing it on
// replaces the host session's own PATH with one that means nothing there — and
// a `claude` installed through nvm, mise, asdf or pnpm stops resolving, while
// the AppImage finds it. So ask the host what its PATH is and append the usual
// install locations to *that*. No answer means no `--env=PATH` at all, which
// leaves flatpak-spawn resolving against the host's PATH unaided: less than the
// augmentation, but still the right search path rather than the wrong one.
//
// Memoized, because runGit runs on every tree refresh and this is a spawn.
let hostSearchPathCache: string | null | undefined;
function hostSearchPath() {
  if (hostSearchPathCache !== undefined) return hostSearchPathCache;
  hostSearchPathCache = null;
  let base = '';
  try {
    base = execFileSync('flatpak-spawn', ['--host', 'printenv', 'PATH'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch (err) {
    console.error('could not read the host PATH:', err);
  }
  if (base) {
    const current = base.split(path.delimiter).filter(Boolean);
    hostSearchPathCache = current
      .concat(cliPathExtras().filter((p) => !current.includes(p)))
      .join(path.delimiter);
  }
  return hostSearchPathCache;
}

// Preserve only the caller-controlled CLI settings when crossing to the host.
// In particular, forwarding Flatpak's XDG_* variables would make host Claude
// read configuration from the app sandbox instead of the user's normal config.
// PATH is deliberately not among them — hostCommand() sets it from the host's,
// see hostSearchPath().
export function hostCliEnv(env: NodeJS.ProcessEnv) {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      name === 'TERM'
      || name === 'COLORTERM'
      || name.startsWith('ANTHROPIC_')
      || name.startsWith('CLAUDE_')
    ) {
      out[name] = value;
    }
  }
  return out;
}

// The usual places an npm/bun/brew-installed CLI ends up. Shared with
// hostSearchPath(), which appends this same list to the *host's* PATH when the
// build is running inside Flatpak — one list, so the two cannot drift.
function cliPathExtras() {
  const home = app.getPath('home');
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    // Version managers, which put the CLI behind a shim directory that a bare
    // PATH never has: normal for a Node tool, and the case a hard-coded host
    // PATH would miss even where hostSearchPath() cannot reach the host's own.
    path.join(home, '.volta', 'bin'),
    path.join(home, '.nix-profile', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
  ];
}

// A bundled .app launched from Finder/Dock inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) rather than the login shell's, so `claude`
// would be ENOENT even when it works fine from a terminal. Append the usual
// install locations instead of shelling out to the user's shell for its PATH.
export function claudeEnv() {
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = current.concat(cliPathExtras().filter((p) => !current.includes(p)));
  return { ...process.env, PATH: merged.join(path.delimiter) };
}
