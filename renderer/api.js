// The preload bridge. Every call that touches disk, git, the OS or Claude goes
// through here — the renderer has no other way out (see CLAUDE.md).

export const api = window.api;
