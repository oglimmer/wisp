// The dialog scaffolding every modal in the app is built on. See the Dialogs
// section of CLAUDE.md for what openModal owns and why.

// Every dialog in the app is the same thing: a full-screen overlay holding one
// box, closed by Escape, by its own buttons, and by the backdrop. Only the
// contents differ, so the scaffolding lives here once. That includes the part
// that is easy to get subtly wrong: the keydown listener is registered on the
// *capture* phase (so the window-level shortcuts, which stand down while an
// overlay is up, never see it) and is removed by the same `close` that removes
// the overlay, exactly once however the dialog was dismissed.
//
// Returns `{ box, close, promise }`: fill `box`, call `close(value)` to settle.
// `onKey(e, close)` is consulted first and returns true once it has handled the
// event; Escape is the fallback. `onClose(value)` runs before the promise settles.
//
// `T` is what this dialog settles with. A dismissal — Escape, the backdrop, a
// Cancel button — settles with `null` unless the caller names another
// `cancelValue`, so `T` includes `null` for every dialog that can be dismissed.
export type CloseModal<T> = (value?: T) => void;

export interface ModalOptions<T> {
  boxClass?: string;
  /** What a dismissal settles with. Defaults to null. */
  cancelValue?: T;
  onKey?: (e: KeyboardEvent, close: CloseModal<T>) => boolean | void;
  onClose?: (value: T) => void;
}

export function openModal<T>(options: ModalOptions<T> = {}) {
  const { boxClass = 'modal-box', onKey, onClose } = options;
  // `in` rather than `?? null`: a dialog whose cancel value is deliberately
  // `undefined` is still the caller having named one.
  const cancelValue = ('cancelValue' in options ? options.cancelValue : null) as T;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = boxClass;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  let done = false;
  function close(value: T = cancelValue) {
    if (done) return;
    done = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    if (onClose) onClose(value);
    settle(value);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (onKey && onKey(e, close)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  document.addEventListener('keydown', onKeyDown, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  return { box, close, promise };
}

// A dialog at a time: two overlays would both answer the same Escape, and the
// window-level shortcuts stand down while one is up.
export function dialogOpen() {
  return !!document.querySelector('.modal-overlay');
}

export function promptModal(title: string, defaultValue = '') {
  const { box, close, promise } = openModal<string | null>({
    onKey: (e, close) => {
      if (e.key !== 'Enter') return false;
      e.preventDefault();
      close(input.value.trim() || null);
      return true;
    },
  });

  const label = document.createElement('div');
  label.className = 'modal-title';
  label.textContent = title;

  const input = document.createElement('input');
  input.className = 'modal-input';
  input.type = 'text';
  input.value = defaultValue;

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.textContent = 'OK';
  okBtn.className = 'modal-primary';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);

  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(actions);

  okBtn.addEventListener('click', () => close(input.value.trim() || null));
  cancelBtn.addEventListener('click', () => close(null));

  // Focus and preselect the base name (before the extension) for fast editing.
  input.focus();
  const dot = defaultValue.lastIndexOf('.');
  if (dot > 0) input.setSelectionRange(0, dot);
  else input.select();

  return promise;
}
