import { ipcMain } from 'electron';

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
/**
 * @template {keyof import('../types/ipc').IpcHandlers} C
 * @param {C} channel
 * @param {import('../types/ipc').IpcHandlers[C]} fn
 */
export function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      // The arguments arrive off the wire as `any[]`; each handler declares what
      // it actually takes, and its own body is checked against that.
      return await /** @type {(...a: any[]) => any} */ (fn)(...args);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
