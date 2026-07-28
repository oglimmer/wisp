// Small helpers with no home of their own.

import { statusEl } from './dom.js';
import { state } from './state.js';

export function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff6b6b' : 'var(--text-dim)';
}

export function relativePath(filePath) {
  if (!state.baseFolder) return filePath;
  let rel = filePath.slice(state.baseFolder.length);
  rel = rel.replace(/^[\\/]/, '');
  return rel || filePath;
}

function cssEscape(str) {
  return str.replace(/["\\]/g, '\\$&');
}
