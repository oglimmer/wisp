// The handful of values more than one module writes. They live on one mutable
// object rather than as exported `let`s because an ES module's exported binding
// is read-only to importers: `state.currentFile = x` works from anywhere,
// `currentFile = x` would not. State only one module writes stays in that module
// and is exported as a live binding instead.

export type ViewMode = 'raw' | 'wysiwyg' | 'preview' | 'diff';

/** How the Diff view draws: side-by-side, or git's own unified patch. */
export type DiffMode = 'visual' | 'raw';

export const VIEW_MODES: ViewMode[] = ['raw', 'wysiwyg', 'preview', 'diff'];
export const STORED_VIEW_MODES: ViewMode[] = ['raw', 'wysiwyg', 'preview'];

// How long after the last keystroke we flush to disk.
export const AUTOSAVE_MS = 400;

// Heading of the collapsed block holding Claude's description of an image.
export const IMAGE_SUMMARY = 'Image description';

const storedViewMode = localStorage.getItem('rawNotes.viewMode') || 'raw';

export interface AppState {
  /** Absolute path of the open vault. */
  baseFolder: string | null;
  /** Absolute path of the open file. */
  currentFile: string | null;
  dirty: boolean;
  viewMode: ViewMode;
  diffMode: DiffMode;
  diffOnlyFile: string | null;
}

export const state: AppState = {
  // The open vault, and the file being edited within it.
  baseFolder: null,
  currentFile: null,
  dirty: false,

  // Editor view for the open file: 'raw' shows the source textarea, 'wysiwyg' a
  // directly-editable formatted view, 'preview' read-only rendered Markdown. Only
  // applies to Markdown files; the choice persists.
  //
  // 'diff' is the fourth: this file's changes against git, read-only. Unlike the
  // other three it is deliberately *not* persisted (see STORED_VIEW_MODES) — it's a
  // mode you step into to check something, not one you want the app to reopen into.
  viewMode: STORED_VIEW_MODES.includes(storedViewMode as ViewMode)
    ? (storedViewMode as ViewMode)
    : 'raw',

  // How the Diff view draws: 'visual' side-by-side, or git's unified patch.
  diffMode: localStorage.getItem('rawNotes.diffMode') === 'raw' ? 'raw' : 'visual',

  // A deleted file has nothing left on disk to open, so it is shown as a diff on
  // its own: currentFile points at it, the buffer stays empty and disabled, and the
  // other views stay hidden until something else is opened.
  diffOnlyFile: null,
};
