import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// Simple config persistence (remembers the last base folder), in config.json
// under Electron's userData dir — never the vault.
const configPath = () => path.join(app.getPath('userData'), 'config.json');

/**
 * The window's saved geometry. Position, maximized and fullScreen are all
 * optional: a frame that no longer overlaps a live display is restored at its
 * size but not its position, so unplugging a monitor can't strand it off-screen.
 */
export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
  fullScreen?: boolean;
}

/** Everything in `config.json` (under Electron's userData dir, never the vault). */
export interface Config {
  baseFolder?: string;
  window?: WindowState;
}

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}
