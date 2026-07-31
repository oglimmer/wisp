// The main process's entry: import every module so its side effects land (the
// privileged-scheme registration in protocol.mjs must evaluate before `ready`,
// so it is imported first), then start the app.

import { app, BrowserWindow } from 'electron';
import { registerAppProtocol } from './protocol.mjs';
import { buildMenu, createWindow } from './window.mjs';
import { killPty } from './terminal.mjs';
import './tree.mjs';
import './refs.mjs';
import './watch.mjs';
import './vault.mjs';
import './reminders.mjs';
import './images.mjs';
import './git.mjs';
import './smart.mjs';

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow(killPty);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(killPty);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Belt and braces with the window's own 'close': a quit that never closes a window
// (⌘Q from the menu while hidden) must not leave the terminal's claude behind.
app.on('before-quit', () => killPty());
