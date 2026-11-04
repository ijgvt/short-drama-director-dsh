/**
 * Persistent state for the plugin: known ComfyUI instances, short-drama projects
 * and mode, plus the workflow index.
 *
 * The point of this module is that opening the agent must not cost anything. A
 * status answer comes from one small JSON file, never from scanning a drive,
 * walking a workflow directory, or probing a GPU.
 *
 * @module dsh-plugin-short-drama-director/lib/state
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.js';

/** Monotonic suffix so two writes in the same millisecond still differ. */
let tempCounter = 0;
import { dirname, join } from 'node:path';

/** Bump when the shape changes so an old file is migrated instead of misread. */
export const STATE_VERSION = 1;

const MODES = new Set(['general', 'drama']);

/** Recognised levels of hand-holding. `unknown` means "do not assume yet". */
const USER_LEVELS = new Set(['unknown', 'beginner', 'experienced', 'creator']);

/** The empty panel/director focus. Kept beside mode so both halves resume the same place. */
export function emptyDirectorContext() {
  return {
    episodeNumber: null,
    sourceId: null,
    shotId: null,
    updatedAt: null,
  };
}

/** Coerce a persisted focus record without trusting values from an older state file. */
function normalizeDirectorContext(raw) {
  const base = emptyDirectorContext();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    ...base,
    episodeNumber: Number.isInteger(raw.episodeNumber) && raw.episodeNumber > 0 ? raw.episodeNumber : null,
    // H3 English is removed. A project resumed from an old English focus lands on the Chinese H3
    // instead of steering the next director turn toward a file the workflow no longer uses.
    sourceId: raw.sourceId === 'h3-en'
      ? 'h3-zh'
      : (typeof raw.sourceId === 'string' && raw.sourceId.length <= 64 ? raw.sourceId : null),
    shotId: typeof raw.shotId === 'string' && raw.shotId.length <= 200 ? raw.shotId : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/** Resolve the state directory, following DSH_HOME when it is set. */
export function stateDir(env = process.env) {
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home.trim().length > 0) return join(home.trim(), 'short-drama');
  const userProfile = env.USERPROFILE ?? env.HOME;
  if (typeof userProfile === 'string' && userProfile.trim().length > 0) {
    return join(userProfile.trim(), '.dsh', 'short-drama');
  }
  throw new Error('cannot locate a state directory: DSH_HOME, USERPROFILE and HOME are all unset');
}

/** Absolute path of the state file. */
export function statePath(env = process.env) {
  return join(stateDir(env), 'state.json');
}

/** The shape a fresh install starts from. */
export function emptyState() {
  return {
    schemaVersion: STATE_VERSION,
    mode: 'general',
    /**
     * How much hand-holding the user wants. `unknown` until something is learned:
     * guessing "beginner" and over-explaining annoys an expert, guessing "expert"
     * and under-explaining loses a beginner.
     */
    userLevel: 'unknown',
    activeProject: null,
    activeContext: emptyDirectorContext(),
    projects: [],
    comfy: {
      lastUsed: null,
      local: { launcher: null, workspace: null, lastStartedAt: null },
      cloud: { tunnelScript: null, localPort: null, note: 'cloud coordinates live in the user\'s own script; read them, never hardcode them' },
      hardware: null,
    },
    workflows: { indexedAt: null, dir: null, count: 0, items: [] },
    /**
     * Global generation preferences. They are not project data: the same workflows and
     * video sampling values apply whichever storyboard the user opens next.
     */
    generation: {
      tasks: { local: {}, cloud: {}, endpoints: {} },
      video: null,
      /**
       * Which prompt document drives 剧本 → 视频提示词. Built-in ids are stable;
       * uploaded documents live under the plugin's DSH_HOME directory.
       */
      promptSources: { selected: 'builtin-general', custom: [] },
    },
  };
}

/** Coerce whatever was on disk into the current shape. */
function migrate(raw) {
  const base = emptyState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const merged = {
    ...base,
    ...raw,
    schemaVersion: STATE_VERSION,
    comfy: { ...base.comfy, ...(raw.comfy ?? {}), local: { ...base.comfy.local, ...(raw.comfy?.local ?? {}) }, cloud: { ...base.comfy.cloud, ...(raw.comfy?.cloud ?? {}) } },
    workflows: { ...base.workflows, ...(raw.workflows ?? {}) },
    generation: {
      ...base.generation,
      ...(raw.generation ?? {}),
      tasks: {
        local: { ...base.generation.tasks.local, ...(raw.generation?.tasks?.local ?? {}) },
        cloud: { ...base.generation.tasks.cloud, ...(raw.generation?.tasks?.cloud ?? {}) },
        endpoints: { ...base.generation.tasks.endpoints, ...(raw.generation?.tasks?.endpoints ?? {}) },
      },
      promptSources: {
        ...base.generation.promptSources,
        ...(raw.generation?.promptSources ?? {}),
        custom: Array.isArray(raw.generation?.promptSources?.custom)
          ? raw.generation.promptSources.custom
          : base.generation.promptSources.custom,
      },
    },
  };
  if (!MODES.has(merged.mode)) merged.mode = 'general';
  if (!USER_LEVELS.has(merged.userLevel)) merged.userLevel = 'unknown';
  merged.activeContext = normalizeDirectorContext(merged.activeContext);
  if (!Array.isArray(merged.projects)) merged.projects = [];
  if (!Array.isArray(merged.workflows.items)) merged.workflows.items = [];
  return merged;
}

/**
 * Read the state file.
 *
 * A missing file is a normal first run and returns the empty state; a corrupt
 * file is preserved beside the new one rather than silently discarded.
 */
export async function readState(env = process.env) {
  const path = statePath(env);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { state: emptyState(), path, existed: false };
  }
  try {
    return { state: migrate(JSON.parse(raw)), path, existed: true };
  } catch {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try {
      await rename(path, quarantine);
    } catch {
      // Quarantine is best effort; the caller still gets a usable state.
    }
    return { state: emptyState(), path, existed: false, quarantined: quarantine };
  }
}

/**
 * Read the mode without awaiting anything.
 *
 * Activation needs the mode before it registers its first tool, and registration is
 * synchronous: an `await` there would leave a window in which the plugin is active with
 * no tools at all, and any caller that inspects the registry right after `apply` would
 * see an empty one. Only the mode is read this way - a few hundred bytes, once per mode
 * change - so the cost is negligible and the alternative (assuming `general` and fixing it
 * up later) would briefly expose the wrong tool set.
 *
 * Never throws: a missing or unreadable file means general mode.
 *
 * @returns `general` or `drama`.
 */
export function readModeSync(env = process.env) {
  try {
    const raw = readFileSync(statePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.mode === 'drama' ? 'drama' : 'general';
  } catch {
    return 'general';
  }
}

/**
 * Write the state file atomically, so an interrupted write cannot truncate it.
 *
 * The temporary name carries pid, a counter and a random suffix. A fixed `${path}.tmp` is
 * shared by every writer, so two concurrent updates interleave their bytes into one file
 * and the rename publishes the mixture - a corrupt state file produced by a *successful*
 * save, which is the worst kind of bug because nothing reports an error.
 */
export async function writeState(state, env = process.env) {
  const path = statePath(env);
  await mkdir(dirname(path), { recursive: true });
  tempCounter += 1;
  const temp = `${path}.${process.pid}.${tempCounter}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

/** Apply one mutation to the persisted state and save it. */
export async function updateState(mutate, env = process.env) {
  const path = statePath(env);
  return await withFileLock(`${path}.lock`, async () => {
    const { state } = await readState(env);
    const next = (await mutate(state)) ?? state;
    next.schemaVersion = STATE_VERSION;
    const written = await writeState(next, env);
    return { state: next, path: written };
  });
}

/**
 * Record or refresh a short-drama project entry.
 *
 * @returns the updated state.
 */
export function upsertProject(state, project) {
  const now = new Date().toISOString();
  const projectChanged = state.activeProject !== project.root;
  const existing = state.projects.find((entry) => entry.root === project.root);
  if (existing === undefined) {
    state.projects.push({ createdAt: now, ...project, lastOpenedAt: now });
  } else {
    Object.assign(existing, project, { lastOpenedAt: now });
  }
  state.activeProject = project.root;
  if (projectChanged) state.activeContext = emptyDirectorContext();
  return state;
}

/** Mark which entry the drama flow is currently working on. */
export function setActiveProject(state, root) {
  const known = state.projects.find((entry) => entry.root === root);
  if (known === undefined) return state;
  known.lastOpenedAt = new Date().toISOString();
  if (state.activeProject !== root) state.activeContext = emptyDirectorContext();
  state.activeProject = root;
  return state;
}

/**
 * Record where the user is working inside the active project.
 *
 * Panel navigation is deliberately persisted: reopening the panel or starting a new agent
 * conversation must answer "which episode and shot were we looking at?" without guessing from
 * the first folder in the project.
 */
export function setDirectorContext(state, context = {}) {
  const current = normalizeDirectorContext(state.activeContext);
  const next = { ...current };

  if (context.episodeNumber !== undefined) {
    next.episodeNumber = Number.isInteger(context.episodeNumber) && context.episodeNumber > 0
      ? context.episodeNumber
      : null;
    if (next.episodeNumber !== current.episodeNumber) next.shotId = null;
  }
  if (context.sourceId !== undefined) {
    next.sourceId = typeof context.sourceId === 'string' && context.sourceId.length <= 64 && context.sourceId.length > 0
      ? context.sourceId
      : null;
    if (next.sourceId !== current.sourceId) next.shotId = null;
  }
  if (context.shotId !== undefined) {
    next.shotId = typeof context.shotId === 'string' && context.shotId.length <= 200 && context.shotId.length > 0
      ? context.shotId
      : null;
  }

  next.updatedAt = new Date().toISOString();
  state.activeContext = next;
  return state;
}
