// The keyboard-shortcut list and the dialog that shows it. The list lives beside
// the handlers it documents. Add a shortcut, add its row.

import { api } from './api.js';
import { dialogOpen, openModal } from './dialogs.js';

// Opened from Help ▸ Keyboard Shortcuts (⌘/ / Ctrl+/). The list lives here, next
// to the handlers it describes, rather than in the menu that opens it.

// macOS writes a chord as glyphs run together (⌘⇧T); everywhere else it's spelled
// out with pluses (Ctrl+Shift+T).
const MAC_KEYS = api.platform === 'darwin';
const K_MOD = MAC_KEYS ? '⌘' : 'Ctrl';
const K_ALT = MAC_KEYS ? '⌥' : 'Alt';
const K_SHIFT = MAC_KEYS ? '⇧' : 'Shift';

function chord(...keys) {
  return keys.join(MAC_KEYS ? '' : '+');
}

/** @type {Array<[string, Array<[string, string]>]>} */
const SHORTCUT_GROUPS = [
  [
    'Editing',
    [
      [chord(K_MOD, 'S'), 'Save now (edits also save themselves as you type)'],
      ['Tab', 'Indent: the lines the selection touches in Raw, the list item in the Editor'],
      [chord(K_SHIFT, 'Tab'), 'Outdent the same'],
      [`${chord(K_MOD, 'B')} / ${chord(K_MOD, 'I')}`, 'Bold / italic, in the Editor view'],
    ],
  ],
  [
    'Tables',
    [
      [chord(K_MOD, K_SHIFT, 'T'), 'Insert a 3×3 table'],
      [`${chord(K_MOD, K_ALT, '←')} / ${chord(K_MOD, K_ALT, '→')}`, 'Add a column left / right'],
      [`${chord(K_MOD, K_ALT, '↑')} / ${chord(K_MOD, K_ALT, '↓')}`, 'Add a row above / below'],
    ],
  ],
  [
    'Find & replace',
    [
      [chord(K_MOD, 'F'), 'Find in the open file, seeded from the selection'],
      [`${chord(K_MOD, 'G')} / F3`, `Next match (${K_SHIFT} for the previous one)`],
      [MAC_KEYS ? '⌘⌥F' : 'Ctrl+H', 'Replace — edits the source, so it opens the Raw view'],
      ['Esc', 'Close the find bar'],
    ],
  ],
  [
    'Terminal',
    [
      [chord(K_MOD, 'J'), 'Show or hide the Claude terminal (the session keeps running)'],
    ],
  ],
  ['Help', [[chord(K_MOD, '/'), 'This list']]],
];

function shortcutsModal() {
  if (dialogOpen()) return;

  // Enter closes too — there is nothing else to confirm.
  const { box, close } = openModal({
    boxClass: 'modal-box sc-box',
    onKey: (e, close) => {
      if (e.key !== 'Enter') return false;
      e.preventDefault();
      close();
      return true;
    },
  });

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Keyboard Shortcuts';
  box.appendChild(title);

  for (const [heading, rows] of SHORTCUT_GROUPS) {
    const group = document.createElement('div');
    group.className = 'sc-group';
    const label = document.createElement('div');
    label.className = 'sc-heading';
    label.textContent = heading;
    group.appendChild(label);
    for (const [keys, description] of rows) {
      const row = document.createElement('div');
      row.className = 'sc-row';
      const kbd = document.createElement('kbd');
      kbd.className = 'sc-keys';
      kbd.textContent = keys;
      const text = document.createElement('div');
      text.className = 'sc-text';
      text.textContent = description;
      row.appendChild(kbd);
      row.appendChild(text);
      group.appendChild(row);
    }
    box.appendChild(group);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.className = 'modal-primary';
  actions.appendChild(closeBtn);
  box.appendChild(actions);

  closeBtn.addEventListener('click', () => close());
  closeBtn.focus();
}

api.onShowShortcuts(shortcutsModal);

// A promise-based text-input dialog. Electron does NOT support window.prompt()
// (it silently returns null), so anything that needs typed input uses this.
// Resolves to the trimmed string, or null if cancelled / left empty.
