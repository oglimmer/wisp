// Small helpers with no home of their own.

import { statusEl } from './dom.js';
import { state } from './state.js';

export function setStatus(text: string, isError?: boolean) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff6b6b' : 'var(--text-dim)';
}

export function relativePath(filePath: string) {
  if (!state.baseFolder) return filePath;
  let rel = filePath.slice(state.baseFolder.length);
  rel = rel.replace(/^[\\/]/, '');
  return rel || filePath;
}

// Escape a path for use inside a double-quoted CSS attribute selector
// (e.g. `[data-path="${cssEscape(path)}"]`). Paths routinely contain characters
// that would otherwise break querySelector.
export function cssEscape(str: string) {
  return String(str).replace(/["\\]/g, '\\$&');
}
