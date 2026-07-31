// The IPC contract, in one place.
//
// Adding a filesystem operation is a three-file change — handler in a `main/`
// module, method in `preload.js`, call in a `renderer/` module — and nothing
// used to check that the three agreed. This file is what they agree *on*: each
// channel's signature is declared once as a named type, and both sides refer to it.
//
//   main/       `handle()` (ipc.mjs) is generic over `IpcHandlers`, so the channel name
//               types the callback's parameters and its return value.
//   preload.js  the exposed object is annotated `@type {WispApi}`, so a method
//               that is missing, misspelled or wired to the wrong channel is an
//               error rather than an `undefined` the renderer finds at runtime.
//   renderer/   `window.api` is declared below, so every call site is checked —
//               including the `{ ok }` narrowing that keeps a failure result
//               from being read as a successful one.
//
// It is a `.d.ts` because it declares types and nothing else: there is no build
// step and nothing here is emitted or loaded at runtime. See CLAUDE.md.

// ---- Result envelopes ----

/**
 * Every `handle()` channel answers with one of these rather than rejecting —
 * `handle()` turns a thrown error into `Fail`. Because the two halves differ on
 * the literal type of `ok`, a check like `if (!res.ok) return;` narrows the rest
 * of the function to the success shape.
 */
export type Fail = { ok: false; error?: string };
export type Ok = { ok: true };
export type Result<T> = ({ ok: true } & T) | Fail;

// ---- Shared shapes ----

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  /** Present on directories only. */
  children?: TreeNode[];
  /**
   * Last-modified time, epoch ms. Present on files only; 0 when it couldn't be
   * read. What the sidebar's recency list is ordered by.
   */
  mtime?: number;
}

/** A stored reminder, as `normalizeReminder()` in the renderer produces it. */
export interface Reminder {
  id: string;
  title: string;
  /** The local calendar date it is due on, `YYYY-MM-DD` — not an instant. */
  due: string;
  /** The list it belongs to — free text, never empty (see `DEFAULT_LIST`). */
  list: string;
  note: string;
  /** Vault-relative path of the note this reminder is attached to, or ''. */
  file: string;
}

/**
 * A reminder Claude proposed alongside a filing plan — no `id` yet, and a
 * `reason` the UI shows on the opt-out card. `null` when the note held no
 * time-bound commitment, which is the common case.
 */
export interface ReminderProposal {
  title: string;
  /** `YYYY-MM-DD`, as `sanitizeReminder()` in main/smart.mjs normalises it. */
  due: string;
  reason: string;
  // Absent as Claude proposes it, and present once the user has been through the
  // reminder editor from the preview card — which hands back a full reminder.
  id?: string;
  list?: string;
  note?: string;
  file?: string;
}

export type GitStatusKind =
  | 'untracked'
  | 'conflict'
  | 'deleted'
  | 'renamed'
  | 'added'
  | 'modified';

export interface GitFile {
  /** Porcelain status letters: index (staged) and work tree. */
  index: string;
  work: string;
  /** Path as git reports it — relative to the repo root, not the vault. */
  repoRel: string;
  /** A rename/copy's old path, else null. */
  from: string | null;
  kind: GitStatusKind;
  /** Absolute path. */
  path: string;
  /** Vault-relative where the file is inside the vault, else `repoRel`. */
  rel: string;
}

export interface SmartPlan {
  /** Vault-relative. */
  targetFile: string;
  isNew: boolean;
  reason: string;
  newContent: string;
  /** '' for a new file. */
  oldContent: string;
  reminder: ReminderProposal | null;
}

export interface LookupSource {
  /** Vault-relative, and verified to exist — see `sanitizeSources()`. */
  file: string;
  detail: string;
}

export interface LookupResult {
  question: string;
  answer: string;
  sources: LookupSource[];
}

// ---- Channel signatures ----
//
// One name per channel, referenced by both `IpcHandlers` (main) and `WispApi`
// (preload + renderer), so the two sides cannot describe the same call
// differently.

/**
 * The open vault, or null before one is opened. Every `baseFolder` parameter
 * below takes this rather than `string`: the renderer passes `state.baseFolder`
 * straight through, and each handler is written for the null case — it either
 * checks the folder itself or refuses through `vaultPath()`. Declaring it
 * `string` would only push a guard main already has into 25 call sites.
 */
export type VaultRoot = string | null;

export type RevealPath = (baseFolder: VaultRoot, target: string) => Promise<Ok | Fail>;
export type ReadFile = (
  baseFolder: VaultRoot,
  filePath: string
) => Promise<Result<{ content: string }>>;
export type WriteFile = (
  baseFolder: VaultRoot,
  filePath: string,
  content: string
) => Promise<Ok | Fail>;
export type CreateEntry = (
  baseFolder: VaultRoot,
  relPath: string
) => Promise<Result<{ path: string }>>;
export type DeletePath = (baseFolder: VaultRoot, target: string) => Promise<Ok | Fail>;
/** `updated` counts notes whose Markdown refs were rewritten to follow the move. */
export type RenamePath = (
  baseFolder: VaultRoot,
  oldPath: string,
  newName: string
) => Promise<Result<{ path: string; updated: number }>>;

/** Move an entry into `destDir` (a folder inside the vault, or the vault root). */
export type MovePath = (
  baseFolder: VaultRoot,
  target: string,
  destDir: string
) => Promise<Result<{ path: string; updated: number }>>;

/** Entries come off disk unvalidated; `normalizeReminder()` vets each one. */
export type ReadReminders = (baseFolder: VaultRoot) => Promise<Result<{ reminders: unknown[] }>>;
export type WriteReminders = (
  baseFolder: VaultRoot,
  reminders: Reminder[]
) => Promise<Ok | Fail>;

/** Named on its own because the renderer keeps it: `gitState` is this or null. */
export interface GitRepoInfo {
  ok: true;
  repo: true;
  root: string;
  /** False when the vault is a subfolder of a larger repository. */
  isRoot: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  noCommits: boolean;
  files: GitFile[];
}

/** `repo: false` is an ordinary answer — a plain folder, not a failure. */
export type GitInfoResult =
  | { ok: true; repo: false }
  | GitRepoInfo
  | { ok: false; repo?: boolean; error?: string };
export type GitInfo = (baseFolder: VaultRoot) => Promise<GitInfoResult>;

/** `conflict` marks a merge that stopped — recoverable, not a failed pull. */
export type GitPull = (
  baseFolder: VaultRoot
) => Promise<{ ok: true; output: string } | { ok: false; conflict?: boolean; error?: string }>;

/**
 * `committed` is what separates "nothing happened" from "committed locally, the
 * push failed" — the two need different things from the user.
 */
export type GitCommit = (
  baseFolder: VaultRoot,
  message: string,
  push: boolean
) => Promise<
  | { ok: true; committed: true; pushed: boolean; output: string }
  | {
      ok: false;
      step?: 'add' | 'commit' | 'push';
      committed?: boolean;
      pushed?: boolean;
      error?: string;
    }
>;

/** `skipped` counts untracked files, which a discard deliberately never deletes. */
export type GitRevert = (
  baseFolder: VaultRoot,
  targets: string | string[]
) => Promise<Result<{ reverted: number; skipped: number }>>;

/** `head`/`work` are null for a binary (or oversized) file, and for the side that doesn't exist. */
export type GitDiff = (
  baseFolder: VaultRoot,
  target: string
) => Promise<
  Result<{
    path: string;
    rel: string;
    binary: boolean;
    head: string | null;
    work: string | null;
    isNew: boolean;
    isDeleted: boolean;
    /** git's own unified patch, '' when there is none. */
    raw: string;
  }>
>;

export type ReadImage = (
  baseFolder: VaultRoot,
  currentFile: string | null,
  src: string
) => Promise<Result<{ dataUrl: string }>>;
export type ReadImageFile = (
  baseFolder: VaultRoot,
  filePath: string
) => Promise<Result<{ dataUrl: string; size: number }>>;
export type ImportImage = (
  baseFolder: VaultRoot,
  currentFile: string | null,
  srcPath: string,
  originalName: string
) => Promise<Result<{ path: string; ref: string }>>;
/**
 * The same import from bytes instead of a path — a pasted screenshot, or an
 * image a pasted note carries inline as `data:image/…;base64,…`. `dataUrl` is
 * untrusted: main checks the MIME, the encoding and the size before writing.
 * There is no name to pass: a clipboard image has none, so main names it after
 * the moment it was pasted.
 */
export type ImportImageData = (
  baseFolder: VaultRoot,
  currentFile: string | null,
  dataUrl: string
) => Promise<Result<{ path: string; ref: string }>>;

/** `skipped` marks an image type Claude can't look at — not an error worth reporting. */
export type AnalyzeImage = (
  baseFolder: VaultRoot,
  imagePath: string
) => Promise<
  | { ok: true; alt: string; description: string }
  | { ok: false; skipped?: boolean; error?: string }
>;

export type SmartCheck = (
  baseFolder: VaultRoot,
  currentFile: string | null,
  text: string
) => Promise<Result<{ plan: SmartPlan }>>;
export type SmartApply = (
  baseFolder: VaultRoot,
  relPath: string,
  content: string
) => Promise<Result<{ path: string }>>;
export type SmartLookup = (
  baseFolder: VaultRoot,
  currentFile: string | null,
  question: string
) => Promise<Result<{ result: LookupResult }>>;

// ---- The terminal pane ----
//
// One interactive `claude` session per window, in a pty. The renderer supplies a
// size and keystrokes and nothing else — there is no channel that takes a command
// to run, which is what keeps this from being a general-purpose shell.

/** Starts (or replaces) the session, at the vault root, sized to the pane. */
export type TermStart = (
  baseFolder: VaultRoot,
  cols: number,
  rows: number
) => Promise<Result<{ pid: number }>>;
/** Keystrokes for the tty. Fails only when no session is running. */
export type TermInput = (data: string) => Promise<Ok | Fail>;
export type TermResize = (cols: number, rows: number) => Promise<Ok | Fail>;
export type TermStop = () => Promise<Ok | Fail>;

/** claude stopped: either it exited on its own or the session was replaced. */
export interface TermExit {
  exitCode: number;
  signal?: number;
}

/**
 * Watch the open vault for changes made outside the app — the terminal's claude,
 * another editor, a `git` command. Replaces any previous watch, and fails (rather
 * than throwing) on a filesystem that can't be watched: the app then behaves as it
 * did before, refreshing only when asked.
 */
export type WatchVault = (baseFolder: VaultRoot) => Promise<Ok | Fail>;

// ---- Main process ----

/**
 * The channels registered through `handle()`. It is generic over this map, so
 * the channel name alone types each handler — a callback that takes the wrong
 * arguments, or returns a shape the renderer isn't expecting, is an error at
 * the point of registration.
 *
 * The handful of channels on bare `ipcMain.handle`/`ipcMain.on` (they answer
 * with a plain value rather than an `{ ok }` envelope, or reply via
 * `e.returnValue`) are annotated at their own registration instead.
 */
export interface IpcHandlers {
  'reveal-path': RevealPath;
  'read-file': ReadFile;
  'write-file': WriteFile;
  'create-file': CreateEntry;
  'create-folder': CreateEntry;
  'delete-path': DeletePath;
  'rename-path': RenamePath;
  'move-path': MovePath;
  'read-reminders': ReadReminders;
  'write-reminders': WriteReminders;
  'git-info': GitInfo;
  'git-pull': GitPull;
  'git-commit': GitCommit;
  'git-revert': GitRevert;
  'git-diff': GitDiff;
  'read-image': ReadImage;
  'read-image-file': ReadImageFile;
  'import-image': ImportImage;
  'import-image-data': ImportImageData;
  'analyze-image': AnalyzeImage;
  'smart-check': SmartCheck;
  'smart-apply': SmartApply;
  'smart-lookup': SmartLookup;
  'term-start': TermStart;
  'term-input': TermInput;
  'term-resize': TermResize;
  'term-stop': TermStop;
  'watch-vault': WatchVault;
}

// ---- The bridge ----

/** Exactly what `preload.js` puts on `window.api` — the renderer's whole way out. */
export interface WispApi {
  getLastFolder: () => Promise<string | null>;
  chooseFolder: () => Promise<string | null>;
  /** Null for a folder that no longer exists. */
  readTree: (baseFolder: VaultRoot) => Promise<TreeNode | null>;
  readFile: ReadFile;
  writeFile: WriteFile;
  /** Synchronous, for the `beforeunload` flush only. */
  writeFileSync: (baseFolder: VaultRoot, filePath: string, content: string) => Ok | Fail;
  createFile: CreateEntry;
  createFolder: CreateEntry;
  smartCheck: SmartCheck;
  smartApply: SmartApply;
  smartLookup: SmartLookup;
  deletePath: DeletePath;
  renamePath: RenamePath;
  movePath: MovePath;
  /** Only http(s)/mailto are opened; anything else is ignored. */
  openExternal: (url: string) => Promise<void>;
  /** Main → renderer: Help ▸ Keyboard Shortcuts was picked. */
  onShowShortcuts: (fn: () => void) => void;
  revealPath: RevealPath;
  platform: NodeJS.Platform;
  readImage: ReadImage;
  readImageFile: ReadImageFile;
  importImage: ImportImage;
  importImageData: ImportImageData;
  /** Electron 32 removed `File.path`; `webUtils` is the replacement. */
  getPathForFile: (file: File) => string;
  analyzeImage: AnalyzeImage;
  readReminders: ReadReminders;
  writeReminders: WriteReminders;
  gitInfo: GitInfo;
  gitPull: GitPull;
  gitCommit: GitCommit;
  gitDiff: GitDiff;
  gitRevert: GitRevert;
  termStart: TermStart;
  termInput: TermInput;
  termResize: TermResize;
  termStop: TermStop;
  /** Main → renderer: bytes from the pty, to be written into xterm.js verbatim. */
  onTermData: (fn: (data: string) => void) => void;
  onTermExit: (fn: (info: TermExit) => void) => void;
  watchVault: WatchVault;
  /** Main → renderer: something outside the app changed the vault (debounced). */
  onVaultChanged: (fn: () => void) => void;
}

declare global {
  interface Window {
    api: WispApi;
    /** `marked`, `turndown` and DOMPurify load as classic scripts, so their globals exist synchronously. */
    marked?: typeof import('marked');
    TurndownService?: typeof import('turndown');
    DOMPurify?: (typeof import('dompurify'))['default'];
    /** xterm.js and its fit addon, loaded the same way, for the terminal pane. */
    Terminal?: typeof import('@xterm/xterm').Terminal;
    FitAddon?: typeof import('@xterm/addon-fit');
  }
}
