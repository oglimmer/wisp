import { ipcMain } from 'electron';
import type { IpcHandlers } from '../types/ipc';

// Every handler below answers `{ ok: true, … }` or `{ ok: false, error }` rather
// than rejecting — the renderer has one way to read a result, and a thrown error
// and a refused operation are the same thing to it. So the try/catch lives here
// once instead of being repeated (and eventually forgotten) in each handler.
// `_e` is never passed on: it carries a handle on the sender.
//
// Generic over the channel map in `types/ipc.d.ts`, so the channel name alone
// types each handler below: its parameters come from the declared signature,
// and a result the renderer isn't expecting is an error here rather than a
// missing property found later on the other side of the bridge.
export function handle<C extends keyof IpcHandlers>(channel: C, fn: IpcHandlers[C]) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      // The one cast in the file, and it is the boundary itself: `args` arrives off
      // the wire untyped, and `fn` is the union of every declared handler, which
      // nothing can be spread into. Each handler still declares what it takes, and
      // its own body — and every renderer call site — is checked against that.
      return await (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
