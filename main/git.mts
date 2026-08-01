import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { handle } from './ipc.mjs';
import { claudeEnv, hostCommand } from './host.mjs';
import { vaultPath, isInside, isBinaryBuffer, MAX_TEXT_BYTES } from './guards.mjs';
import type { GitStatusKind } from '../types/ipc';

const fsp = fs.promises;

// ---- Git ----
//
// The vault is *often* a git repository, but never has to be: every handler here
// answers `{ ok: true, repo: false }` for a plain folder instead of failing, and
// the UI hides itself entirely in that case. Git is only ever driven through the
// porcelain-stable plumbing below — never by shelling out to a shell.

const GIT_TIMEOUT_MS = 120000;

// Same bare-PATH problem as `claude` (see claudeEnv): a bundled .app launched from
// Finder inherits /usr/bin:/bin:/usr/sbin:/sbin, which has git on macOS but not
// necessarily a user-installed one. Git must also never block on an interactive
// credential prompt — there is no terminal to answer it and the app would hang —
// so prompting is disabled and a fetch/push needing a password fails fast.
function gitEnv() {
  const env: NodeJS.ProcessEnv = {
    ...claudeEnv(),
    GIT_TERMINAL_PROMPT: '0',
    // Keep read-only calls (status runs on every tree refresh) from taking the
    // index lock and fighting a git command the user is running in a terminal.
    GIT_OPTIONAL_LOCKS: '0',
  };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
}

// What every git call answers with, however it ended. `buffer` is the raw stdout,
// kept for `git diff` — a diff is checked for a NUL byte before being treated as
// text, and that question cannot be asked of a string that has already been
// decoded as UTF-8. `missing`/`timedOut` distinguish "no git on PATH" and "killed
// after GIT_TIMEOUT_MS" from an ordinary non-zero exit.
interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  buffer?: Buffer;
  missing?: boolean;
  timedOut?: boolean;
}

// Run one git command. Never rejects: the caller always gets {ok, code, stdout, stderr}.
function runGit(cwd: string, args: string[], opts: { timeout?: number } = {}): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let child;
    try {
      const env = gitEnv();
      const command = hostCommand(
        'git',
        args,
        cwd,
        {
          GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT,
          GIT_OPTIONAL_LOCKS: env.GIT_OPTIONAL_LOCKS,
        },
        ['GIT_ASKPASS', 'SSH_ASKPASS']
      );
      child = spawn(command.command, command.args, { cwd: command.cwd, env });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err), missing: true });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (value: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, code: -1, stdout: '', stderr: 'git timed out.', timedOut: true });
    }, opts.timeout || GIT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        code: -1,
        stdout: '',
        stderr: e.code === 'ENOENT' ? 'git was not found on your PATH.' : String(e),
        missing: e.code === 'ENOENT',
      });
    });
    child.on('close', (code) => {
      const buffer = Buffer.concat(out);
      finish({
        ok: code === 0,
        code,
        buffer,
        stdout: buffer.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

// The repository the vault lives in, or null. The vault may be the repo root or a
// folder somewhere inside it, so every path below is translated through this.
async function gitRoot(baseFolder: string | null) {
  if (!baseFolder || !fs.existsSync(baseFolder)) return null;
  const res = await runGit(baseFolder, ['rev-parse', '--show-toplevel']);
  if (!res.ok) return null;
  const root = res.stdout.trim();
  return root ? path.resolve(root) : null;
}

// Repo-root-relative, forward-slashed — the form every git pathspec/rev wants.
function toRepoRel(root: string, target: string) {
  return path.relative(root, target).split(path.sep).join('/');
}

// Boil the two-letter status code down to the single thing worth showing.
// Order matters: a conflict outranks a deletion outranks everything else.
function statusKind(index: string, work: string): GitStatusKind {
  const code = index + work;
  if (code === '??') return 'untracked';
  if (index === 'U' || work === 'U' || code === 'AA' || code === 'DD') return 'conflict';
  if (index === 'D' || work === 'D') return 'deleted';
  if (index === 'R' || work === 'R') return 'renamed';
  if (index === 'A') return 'added';
  return 'modified';
}

// Parse `git status --porcelain=v1 -z -b`. Records are NUL-terminated, so a path
// containing a newline or a quote survives intact (the non-`-z` format would
// C-quote it). A rename/copy entry is followed by one extra field: its old path.
function parseStatus(raw: string) {
  const parts = raw.split('\0');
  const files: { index: string; work: string; repoRel: string; from: string | null; kind: GitStatusKind }[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  let noCommits = false;

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;

    if (rec.startsWith('## ')) {
      let head = rec.slice(3).trim();
      // "[ahead 1, behind 2]" — only present with an upstream that has diverged.
      const track = head.match(/\s\[([^\]]+)\]$/);
      if (track) {
        const a = track[1].match(/ahead (\d+)/);
        const b = track[1].match(/behind (\d+)/);
        if (a) ahead = Number(a[1]);
        if (b) behind = Number(b[1]);
        head = head.slice(0, track.index);
      }
      const dots = head.indexOf('...');
      if (dots !== -1) {
        upstream = head.slice(dots + 3).trim();
        head = head.slice(0, dots);
      }
      head = head.trim();
      if (head.startsWith('No commits yet on ')) {
        noCommits = true;
        head = head.slice('No commits yet on '.length).trim();
      }
      if (head === 'HEAD (no branch)') {
        detached = true;
        head = 'HEAD';
      }
      branch = head;
      continue;
    }

    if (rec.length < 3) continue;
    const index = rec[0];
    const work = rec[1];
    const repoRel = rec.slice(3);
    let from: string | null = null;
    if (index === 'R' || index === 'C' || work === 'R' || work === 'C') {
      from = parts[++i] || null; // the entry's old path, its own NUL-terminated field
    }
    files.push({ index, work, repoRel, from, kind: statusKind(index, work) });
  }

  return { branch, upstream, ahead, behind, detached, noCommits, files };
}

// Everything the UI needs to decorate the tree and label the git bar. Answers for a
// non-repository too, so the renderer can treat "not a repo" as an ordinary state.
handle('git-info', async (baseFolder) => {
  if (!baseFolder || !fs.existsSync(baseFolder)) return { ok: true, repo: false };
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: true, repo: false };

  // Scoped to the vault: if it's a subfolder of a bigger repo, the tree only
  // knows about its own files and Wisp only ever commits its own files.
  const res = await runGit(root, [
    'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--', baseFolder,
  ]);
  if (!res.ok) return { ok: false, repo: true, error: res.stderr.trim() || 'git status failed.' };

  const parsed = parseStatus(res.stdout);
  const files = parsed.files.map((f) => {
    const abs = path.resolve(root, f.repoRel);
    return {
      ...f,
      path: abs,
      rel: isInside(baseFolder as string, abs) ? toRepoRel(baseFolder as string, abs) : f.repoRel,
    };
  });

  return {
    ok: true,
    repo: true,
    root,
    isRoot: path.resolve(root) === path.resolve(baseFolder),
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    detached: parsed.detached,
    noCommits: parsed.noCommits,
    files,
  };
});

// Fetch + merge. --ff-only would be safer but leaves a diverged vault stuck with no
// way forward from the UI, so an ordinary merge is used and a conflict is reported
// as-is — the tree then shows the conflicted files and the user resolves them.
handle('git-pull', async (baseFolder) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };

  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    return { ok: false, error: 'This branch has no upstream to pull from.' };
  }

  // Since git 2.27 a bare `git pull` *refuses* to run once the branches have
  // actually diverged ("fatal: Need to specify how to reconcile divergent
  // branches") unless pull.rebase is configured. A vault edited on two machines
  // hits that constantly, so state the strategy — but only when the user hasn't,
  // so an explicit pull.rebase preference is still honoured.
  const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const prefs = [
    await runGit(root, ['config', '--get', 'pull.rebase']),
    await runGit(root, ['config', '--get', `branch.${branch}.rebase`]),
  ];
  const args = ['pull'];
  if (!prefs.some((p) => p.ok && p.stdout.trim())) args.push('--no-rebase');

  const res = await runGit(root, args);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  if (!res.ok) {
    // A merge that stopped on a conflict is a normal, recoverable state — the
    // files are now marked in the tree and the user resolves them — not the same
    // thing as a pull that could not start at all.
    const conflict = /CONFLICT|Automatic merge failed|fix conflicts/i.test(output);
    return {
      ok: false,
      conflict,
      error: output || `git pull exited with code ${res.code}`,
    };
  }
  return { ok: true, output: output || 'Already up to date.' };
});

// Stage everything under the vault, commit, and optionally push. Returns as soon as
// a step fails, naming the step, so the UI can say what actually happened — a commit
// that lands but fails to push must not read as "nothing happened".
handle('git-commit', async (baseFolder, message, push) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'A commit message is required.' };
  }

  // gitRoot() above only answers for a real folder, so baseFolder is a string here.
  const add = await runGit(root, ['add', '-A', '--', baseFolder as string]);
  if (!add.ok) {
    return { ok: false, step: 'add', error: add.stderr.trim() || 'git add failed.' };
  }

  // Scoping the commit to a pathspec is what keeps a vault-inside-a-bigger-repo from
  // sweeping up unrelated staged changes — but a partial commit is refused during a
  // merge, so the ordinary whole-index commit is used when the vault *is* the repo.
  // gitRoot() only answers for a real folder, so baseFolder is a string here.
  const vault = baseFolder as string;
  const scoped = path.resolve(root) !== path.resolve(vault);
  const commitArgs = ['commit', '-m', message.trim()];
  if (scoped) commitArgs.push('--', vault);
  const commit = await runGit(root, commitArgs);
  if (!commit.ok) {
    const text = [commit.stdout.trim(), commit.stderr.trim()].filter(Boolean).join('\n');
    if (/nothing to commit|no changes added/i.test(text)) {
      return { ok: false, step: 'commit', error: 'Nothing to commit.' };
    }
    return { ok: false, step: 'commit', error: text || 'git commit failed.' };
  }

  if (!push) return { ok: true, committed: true, pushed: false, output: commit.stdout.trim() };

  const pushRes = await gitPush(root);
  if (!pushRes.ok) {
    return { ok: false, step: 'push', committed: true, pushed: false, error: pushRes.error };
  }
  return { ok: true, committed: true, pushed: true, output: pushRes.output };
});

// Push the current branch. A branch with no upstream is published against the only
// remote if there is exactly one; with none or several, we say so rather than guess.
async function gitPush(
  root: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let args = ['push'];
  if (!upstream.ok) {
    const remotes = (await runGit(root, ['remote']))
      .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (remotes.length === 0) {
      return { ok: false, error: 'No remote is configured, so there is nothing to push to.' };
    }
    if (remotes.length > 1) {
      return { ok: false, error: `This branch has no upstream, and there are several remotes (${remotes.join(', ')}). Set one with \`git push -u\`.` };
    }
    const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (!branch || branch === 'HEAD') {
      return { ok: false, error: 'HEAD is detached, so there is no branch to push.' };
    }
    args = ['push', '-u', remotes[0], branch];
  }
  const res = await runGit(root, args);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  if (!res.ok) return { ok: false, error: output || `git push exited with code ${res.code}` };
  return { ok: true, output: output || 'Pushed.' };
}

// Throw local changes away, restoring the given paths from HEAD.
//
// Untracked files are deliberately never touched. They have no committed version to
// go back to, so "discarding" one would mean deleting work git has never seen — an
// unrecoverable delete wearing the name of an undo. The renderer says as much, and
// the ordinary Delete menu item is still there for anyone who does want that.
handle('git-revert', async (baseFolder, targets) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };

  const list = Array.isArray(targets) ? targets : [targets];
  const paths = list.map((target) => vaultPath(baseFolder, target, 'Outside the vault.'));
  if (!paths.length) return { ok: false, error: 'Nothing to discard.' };

  // Re-read status here rather than trusting what the renderer last saw: this
  // destroys work, so it must act on what the repository says right now.
  //
  // Scoped to the whole vault and filtered afterwards, NOT with the target paths
  // as a pathspec: git only detects a rename when both halves are in scope, so
  // asking about just the new path would report a bare add and quietly leave the
  // old path deleted.
  const res = await runGit(root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', baseFolder as string,
  ]);
  if (!res.ok) return { ok: false, error: res.stderr.trim() || 'git status failed.' };

  // A target may be a file or a folder; a deleted file isn't on disk at all, in
  // which case there is nothing under it and an exact match is the only sense.
  const wanted = paths.map((p) => ({
    path: p,
    isDir: fs.existsSync(p) && fs.statSync(p).isDirectory(),
  }));
  const inScope = (abs: string) =>
    wanted.some((w) => (w.isDir ? isInside(w.path, abs) : path.resolve(abs) === w.path));

  const restore = new Set<string>(); // has a HEAD version to come back to
  const unstage = new Set<string>(); // staged but new — un-add it, leave the file alone
  let skipped = 0;
  for (const entry of parseStatus(res.stdout).files) {
    if (!inScope(path.resolve(root, entry.repoRel))) continue;
    if (entry.kind === 'untracked') {
      skipped++;
      continue;
    }
    const inHead = await runGit(root, ['cat-file', '-e', `HEAD:${entry.repoRel}`]);
    (inHead.ok ? restore : unstage).add(entry.repoRel);
    // A rename's old path is the one HEAD knows; restoring it puts the file back.
    if (entry.from && (await runGit(root, ['cat-file', '-e', `HEAD:${entry.from}`])).ok) {
      restore.add(entry.from);
    }
  }

  if (!restore.size && !unstage.size) return { ok: true, reverted: 0, skipped };

  if (unstage.size) {
    const r = await runGit(root, ['restore', '--staged', '--', ...unstage]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git restore --staged failed.' };
  }
  if (restore.size) {
    const r = await runGit(root, [
      'restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore,
    ]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git restore failed.' };
  }
  return { ok: true, reverted: restore.size + unstage.size, skipped };
});

// A file's change against HEAD, in both forms the UI offers: the two texts (for the
// side-by-side visual diff) and git's own unified patch (for the raw view).
handle('git-diff', async (baseFolder, target) => {
  const root = await gitRoot(baseFolder);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const abs = vaultPath(baseFolder, target, 'Outside the vault.');
  const repoRel = toRepoRel(root, abs);

  // Missing from HEAD means the file is new (untracked or staged-as-added).
  const show = await runGit(root, ['show', `HEAD:${repoRel}`]);
  // `?? null` rather than just `show.buffer`: GitResult declares it optional (the
  // error and timeout paths never produce one), and every test below is `=== null`.
  const headBuf = show.ok ? show.buffer ?? null : null;

  let workBuf: Buffer | null = null;
  try {
    workBuf = await fsp.readFile(abs);
  } catch {} // absent on disk = deleted

  // Oversized text is treated like binary: the visual diff must not load multi-MB
  // buffers into the LCS path. The raw unified patch still comes from git.
  // `!!` because each half is `null` when its buffer is — and `binary` below is
  // reported over the bridge as a boolean, not a maybe-null one.
  const tooLarge = !!(
    (headBuf && headBuf.length > MAX_TEXT_BYTES) || (workBuf && workBuf.length > MAX_TEXT_BYTES)
  );
  const binary = isBinaryBuffer(headBuf) || isBinaryBuffer(workBuf) || tooLarge;

  let raw = (await runGit(root, ['diff', 'HEAD', '--', repoRel])).stdout;
  // An untracked file is invisible to `git diff`, so patch it against nothing.
  if (!raw.trim() && headBuf === null && workBuf !== null) {
    raw = (await runGit(root, ['diff', '--no-index', '--', '/dev/null', abs])).stdout;
  }

  return {
    ok: true,
    path: abs,
    // vaultPath above has already thrown unless baseFolder is a string, which the
    // type checker can't see through — hence the cast rather than a second check.
    rel: toRepoRel(baseFolder as string, abs),
    binary,
    head: binary || headBuf === null ? null : headBuf.toString('utf8'),
    work: binary || workBuf === null ? null : workBuf.toString('utf8'),
    isNew: headBuf === null,
    isDeleted: workBuf === null,
    raw: raw.trim() ? raw : '',
  };
});
