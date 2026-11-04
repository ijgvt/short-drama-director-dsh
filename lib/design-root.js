/**
 * The one directory short-drama projects live in.
 *
 * Every project sits directly under `<drive>:/DSH-Short-Drama-Project`, one folder per
 * script, and that folder is exactly the workspace the pipeline's first step creates.
 * Fixing the location is deliberate: it removes the two questions that otherwise cost
 * the user time - "which workspace am I in?" and "where did the project go?" - and it
 * means the storyboard panel and `drama_workspace` can never disagree about where a
 * project is, because both resolve it here.
 *
 * The location is chosen once, in this order:
 *   1. an explicit override;
 *   2. an existing non-system data drive on Windows;
 *   3. the user's home directory, never a bare system-drive root.
 *
 * @module dsh-plugin-short-drama-director/lib/design-root
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Folder name every project lives under. Not configurable: it is the contract. */
export const DESIGN_ROOT_NAME = 'DSH-Short-Drama-Project';

/** Resolved once per process: probing a drive on every call would be wasteful. */
let cached = null;

function defaultDesignRoot(env = process.env) {
  const explicit = typeof env.DSH_PROJECT_ROOT === 'string' ? env.DSH_PROJECT_ROOT.trim() : '';
  if (explicit.length > 0) {
    return {
      root: explicit.toLowerCase().endsWith(DESIGN_ROOT_NAME.toLowerCase()) ? explicit : join(explicit, DESIGN_ROOT_NAME),
      drive: explicit,
      source: 'env.DSH_PROJECT_ROOT',
    };
  }
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (process.platform === 'win32') {
    const system = `${(env.SystemDrive ?? 'C:').replace(/[\\/]+$/u, '')}\\`;
    // Preserve an existing legacy project root before choosing a new location.
    const legacy = join(system, DESIGN_ROOT_NAME);
    if (existsSync(legacy)) return { root: legacy, drive: system, source: `existing ${legacy}` };
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (`${letter}:`.toLowerCase() === system.replace(/[\\/]+$/u, '').toLowerCase()) continue;
      if (existsSync(drive)) return { root: join(drive, DESIGN_ROOT_NAME), drive, source: `found ${drive}` };
    }
  }
  if (typeof home !== 'string' || home.trim().length === 0) {
    return { root: join(process.cwd(), DESIGN_ROOT_NAME), drive: process.cwd(), source: 'the process working directory' };
  }
  return { root: join(home, DESIGN_ROOT_NAME), drive: home, source: `the user home ${home}` };
}

/**
 * The drive and folder projects live in.
 *
 * @param options.drive - an explicit `D:\`-style root, or a full directory to use as-is.
 * @returns `{ root, drive, source }`; `source` says why that drive won, so a caller can
 *   explain the choice instead of presenting it as arbitrary.
 */
export function designRoot(options = {}) {
  const explicit = typeof options.drive === 'string' ? options.drive.trim() : '';
  if (explicit.length > 0) {
    // A caller may pass either a drive (`D:\`) or the complete directory.
    const trimmed = explicit.replace(/[\\/]+$/u, '');
    const endsWithName = trimmed.toLowerCase().endsWith(DESIGN_ROOT_NAME.toLowerCase());
    return {
      root: endsWithName ? trimmed : join(trimmed, DESIGN_ROOT_NAME),
      drive: explicit,
      source: 'explicit',
    };
  }
  if (cached !== null) return cached;
  cached = defaultDesignRoot();
  return cached;
}

/** Forget the cached probe. Only used by tests that simulate different drives. */
export function resetDesignRootCache() {
  cached = null;
}

/**
 * The project folder for one script title, inside the design root.
 *
 * @param scriptName - the drama's title, used verbatim so the folder is recognisable.
 * @returns `{ root, projectRoot, folder }`; `folder` is the sanitized last segment.
 */
export function projectPathFor(scriptName, options = {}) {
  const { root } = designRoot(options);
  const raw = String(scriptName ?? '').trim();
  if (raw.length === 0) throw new Error('a project folder needs the script title');
  // Windows forbids these in a file name; the title itself is otherwise kept as written.
  const folder = raw.replace(/[\\/:*?"<>|]/gu, '_').replace(/\.+$/u, '').trim();
  if (folder.length === 0) throw new Error(`the script title ${JSON.stringify(raw)} cannot be used as a folder name`);
  return { root, projectRoot: join(root, folder), folder };
}
