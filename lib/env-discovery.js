/**
 * Where things live on THIS machine, discovered rather than assumed.
 *
 * The plugin ships to other people's computers. Every absolute path compiled into it is
 * therefore a claim about a machine it has never seen -- and a wrong claim is worse than no
 * claim: with `D:\ComfyUI\ComfyUI_windows_portable` as a default, a fresh install on a
 * machine without a D: drive reports "ComfyUI is not installed" while a perfectly good copy
 * sits on C:, and the user is told to download a hundred gigabytes they already have.
 *
 * So nothing here names a drive. The order is always:
 *
 *   1. what the user configured explicitly (profile config);
 *   2. what the user's environment says (`COMFYUI_HOME`, `COMFYUI_PATH`);
 *   3. what a previous session learned and recorded in the plugin state;
 *   4. siblings of any of the above, because people keep two copies (portable + 绘世);
 *   5. conventional per-user locations, as a last resort.
 *
 * Every function returns evidence (`source`) alongside the answer, so the caller can say WHY
 * a path was chosen instead of presenting it as fact.
 *
 * @module dsh-plugin-short-drama-director/lib/env-discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';

/** Candidate directories a ComfyUI install or an integrated package can live in. */
const INSTALL_NAME_HINTS = /comfy|绘世|aki|complete|整合/iu;

/** True when a path is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when a path is a file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether one directory is a usable ComfyUI, and which layout it uses.
 *
 * Two shipped layouts matter and they START differently:
 * - `portable`: a `run_*.bat` (or `python_embeded/`) beside `ComfyUI/main.py`.
 * - `integrated`: an own interpreter at `python/python.exe` beside `ComfyUI/main.py`
 *   (绘世/Aki and similar packages). These have no `run_*.bat` at all.
 *
 * A bare git checkout counts as a `source` layout but is reported as usable ONLY when it was
 * named explicitly. Seeing `main.py` alone is not evidence that anything can be run: a
 * checkout with no models, no custom nodes and no workflow folder is common and useless, and
 * calling it "the install" would send the user to a copy that cannot generate anything.
 *
 * @returns `{ usable, layout, script, workflowRoot }` - `usable: false` when neither holds.
 */
export async function inspectInstall(path, { allowSource = false } = {}) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { usable: false, layout: null, path: null, script: null, workflowRoot: null };
  }
  const root = path.trim();
  const nestedScript = join(root, 'ComfyUI', 'main.py');
  const directScript = join(root, 'main.py');

  // An integrated package: root has its own interpreter and the backend under ComfyUI/.
  if (await isFile(nestedScript) && await isFile(join(root, 'python', 'python.exe'))) {
    return { usable: true, layout: 'integrated', path: root, script: nestedScript, workflowRoot: join(root, 'ComfyUI', 'user', 'default', 'workflows') };
  }
  // A portable build: ComfyUI/ beside python_embeded/ or a launcher.
  if (await isFile(nestedScript)) {
    return { usable: true, layout: 'portable', path: root, script: nestedScript, workflowRoot: join(root, 'ComfyUI', 'user', 'default', 'workflows') };
  }
  // A bare clone. Only trusted when the caller named it, and only if it at least has the
  // user-data folder a run would create.
  if (await isFile(directScript)) {
    const workflowRoot = join(root, 'user', 'default', 'workflows');
    const usable = allowSource && await isDirectory(workflowRoot);
    return { usable, layout: 'source', path: root, script: directScript, workflowRoot };
  }
  return { usable: false, layout: null, path: root, script: null, workflowRoot: null };
}

/** Read the plugin state file, tolerating every kind of failure. */
async function readStateSafe(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0) return undefined;
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Parent directory of a path, or `undefined` for a drive root. */
function parentOf(path) {
  if (typeof path !== 'string') return undefined;
  const parent = dirname(path);
  if (parent === path) return undefined;
  // `dirname('D:\\')` is `'D:\\'`; a drive root has no useful parent to scan.
  if (parent.length <= 3 && /^[a-z]:[\\/]$/iu.test(parent)) return undefined;
  return parent;
}

/**
 * Every plausible ComfyUI installation on this machine, best first.
 *
 * The sibling scan is what makes a real setup findable: a person commonly has
 * `D:\ComfyUI\ComfyUI_windows_portable` and `D:\comfyui专属\ComfyUI-aki-v3.2` side by side,
 * and only one of them is the copy they actually run now. Scanning one level around any
 * known-good root finds the other without naming either.
 *
 * @param config - plugin config (`comfyuiPortablePath`, `deployPackPath` are hints only).
 * @param options.statePath - the plugin state file, for paths a previous session learned.
 * @param options.env - environment, injectable for tests.
 * @returns `{ installs, hints, source }` - `installs` are `inspectInstall` results.
 */
export async function discoverInstallations(config = {}, { statePath = undefined, env = process.env } = {}) {
  const hints = [];
  // Paths are normalised before comparison. A JavaScript literal like 'D:\\ComfyUI\\x' is the
  // same directory as `D:\ComfyUI\x`, but comparing the raw strings treats them as two
  // installs, and the report then lists the same copy twice under different spellings.
  const canonical = (path) => normalize(path.trim());
  const addHint = (value, source) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const path = canonical(value);
    if (hints.some((hint) => hint.path.toLowerCase() === path.toLowerCase())) return;
    hints.push({ path, source });
  };

  addHint(config.comfyuiPortablePath, 'config.comfyuiPortablePath');
  addHint(config.comfyPath, 'config.comfyPath');
  addHint(env.COMFYUI_HOME, 'env.COMFYUI_HOME');
  addHint(env.COMFYUI_PATH, 'env.COMFYUI_PATH');

  const state = await readStateSafe(statePath);
  addHint(state?.comfy?.local?.workspace, 'recorded by a previous session');

  // Conventional per-user locations, last: these are the defaults people rarely change.
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (typeof home === 'string' && home.length > 0) {
    for (const name of ['ComfyUI', join('Documents', 'ComfyUI'), join('comfyui', 'ComfyUI')]) {
      const candidate = join(home, name);
      if (await isDirectory(candidate)) addHint(candidate, 'a conventional user location');
    }
  }

  // Inspect the hints, then one level of siblings around each existing one. An explicitly
  // named hint may be a bare clone (a developer's checkout); a DISCOVERED sibling may not,
  // because a stray checkout is not something the user runs.
  const seen = new Set();
  const installs = [];
  const inspected = [];
  const consider = async (path, source, { explicit = false } = {}) => {
    // Compare canonical forms, so two spellings of one directory are one candidate.
    const key = normalize(path).toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const result = await inspectInstall(path, { allowSource: explicit });
    inspected.push({ path, source, ...result });
    // A sibling is only worth reporting when it can actually generate; otherwise the answer
    // lists folders that merely contain a main.py.
    if (result.usable) installs.push({ ...result, source });
    return result;
  };

  for (const hint of hints) {
    // A configured path, an environment variable or a recorded path is a deliberate choice, so
    // a source clone there is trusted. The conventional user locations are guesses.
    const explicit = !hint.source.includes('conventional');
    await consider(hint.path, hint.source, { explicit });
    if (!await isDirectory(hint.path)) continue;
    const parent = parentOf(hint.path);
    if (parent === undefined) continue;
    let entries = [];
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!INSTALL_NAME_HINTS.test(entry.name)) continue;
      const sibling = join(parent, entry.name);
      if (sibling.toLowerCase() === hint.path.toLowerCase()) continue;
      await consider(sibling, `a sibling of ${hint.source}`);
    }
  }

  // Last resort, and the only step that looks at the machine without being told anything: scan
  // drive roots for directories that look like ComfyUI. This is what makes a fresh install work
  // with no configuration at all. It reads directory listings only - no process, no network, no
  // GPU.
  //
  // Two levels, because the shallow one is usually not the install itself:
  //   D:\ComfyUI\ComfyUI_windows_portable        (a namespace folder, then the build)
  //   D:\comfyui专属\ComfyUI-aki-v3.2             (a Chinese-named folder, then the package)
  // Descending only into entries whose NAME already looks like ComfyUI keeps this cheap: every
  // directory under a drive is not walked, only the plausibly-ComfyUI ones.
  //
  // The whole search runs to completion rather than stopping at the first hit. Stopping early
  // was a real bug: on the machine this was found, `D:\ComfyUI\ComfyUI_windows_portable` (1
  // workflow) sorted before `D:\comfyui专属\ComfyUI-aki-v3.2` (20 workflows), so the plugin
  // confidently indexed the copy nobody uses. Ranking happens afterwards instead.
  // Then the search roots. These are scanned even when a hint already produced an install:
  // knowing one path says nothing about whether a second, better-equipped copy exists, and
  // "first hit wins" is exactly how the wrong copy gets indexed. When nothing at all has been
  // found this is also the only step that looks at the machine without being told anything.
  //
  // Two levels, because the shallow one is usually not the install itself:
  //   D:\ComfyUI\ComfyUI_windows_portable        (a namespace folder, then the build)
  //   D:\comfyui专属\ComfyUI-aki-v3.2             (a Chinese-named folder, then the package)
  // Under a DRIVE ROOT every directory is inspected (a drive can hold one non-obviously named
  // folder); below that, only names that already look like ComfyUI, which keeps it cheap.
  for (const drive of await candidateDriveRoots(env, config)) {
    let top = [];
    try {
      top = await readdir(drive, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of top) {
      if (!entry.isDirectory()) continue;
      const first = join(drive, entry.name);
      await consider(first, `found under ${drive}`);
      let children = [];
      try {
        children = await readdir(first, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (!INSTALL_NAME_HINTS.test(child.name)) continue;
        await consider(join(first, child.name), `found under ${first}`);
      }
    }
  }

  await rankInstalls(installs);
  return { installs, hints, inspected };
}

/**
 * Order installations so the one the user actually runs comes first.
 *
 * Signals, strongest first:
 *  1. **How much the install actually contains.** A copy with 20 workflows, a populated model
 *     folder and a user database is the one in use; a leftover has an almost empty workflow
 *     folder. This is the signal that separates the two copies on the machine this was found
 *     on, where directory timestamps pointed the wrong way - the stale copy's folder had been
 *     touched more recently while holding 1 workflow against the live copy's 20.
 *  2. **An integrated package ahead of a portable build** as the tie-break, because 绘世-style
 *     packages are the newer distribution style and are what a user who just switched runs.
 *  3. **Recency** only as the last tie-break, between installs that look equally equipped.
 *
 * Cheap on purpose: one directory listing and two existence checks per install.
 */
async function rankInstalls(installs) {
  if (installs.length <= 1) return;
  const scored = [];
  for (const install of installs) {
    let workflowCount = 0;
    let mtime = 0;
    if (install.workflowRoot !== null) {
      try {
        workflowCount = await countWorkflowFiles(install.workflowRoot);
        mtime = (await stat(install.workflowRoot)).mtimeMs ?? 0;
      } catch {
        workflowCount = 0;
      }
    }
    // A user database is written the first time the instance is really opened in the UI.
    const hasUserDb = install.path === null ? false : await isFile(join(install.path, 'ComfyUI', 'user', 'comfyui.db'))
      || await isFile(join(install.path, 'user', 'comfyui.db'));
    // A populated models folder means the user has actually downloaded and wired things up.
    const modelsDir = install.path === null ? null : join(install.path, 'ComfyUI', 'models');
    const hasModels = modelsDir === null ? false : await isDirectory(modelsDir);
    scored.push({
      install,
      workflowCount,
      mtime,
      score: workflowCount * 10 + Number(hasUserDb) * 25 + Number(hasModels) * 15 + Number(install.layout === 'integrated') * 5,
    });
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.workflowCount !== left.workflowCount) return right.workflowCount - left.workflowCount;
    return right.mtime - left.mtime;
  });
  installs.length = 0;
  for (const entry of scored) installs.push(entry.install);
}

/** Count runnable workflow JSON recursively so a subfolder is not mistaken for an empty install. */
async function countWorkflowFiles(root) {
  let total = 0;
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()
        && /\.json$/iu.test(entry.name)
        && !/\.bak|\.backup|\.old|\.orig|~$/iu.test(entry.name)
        && !entry.name.startsWith('.')) {
        total += 1;
      }
    }
  };
  await walk(root);
  return total;
}

/**
 * Roots worth scanning for an install, cheaply and without naming any of them.
 *
 * `config.comfyuiSearchPaths` and `COMFYUI_SEARCH_PATHS` (separated by the platform path
 * delimiter) come first and REPLACE the conventional list when given: someone who says where
 * to look should not also pay for a scan of every drive. Otherwise every existing drive letter
 * is offered, starting with the one the system is on, so nothing is assumed about which exists.
 */
async function candidateDriveRoots(env, config = {}) {
  const configured = [];
  for (const entry of Array.isArray(config.comfyuiSearchPaths) ? config.comfyuiSearchPaths : []) {
    if (typeof entry === 'string' && entry.trim().length > 0) configured.push(entry.trim());
  }
  for (const entry of String(env.COMFYUI_SEARCH_PATHS ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry.trim().length > 0) configured.push(entry.trim());
  }
  const roots = configured.length > 0 ? configured : [];
  if (roots.length === 0) {
    const system = typeof env.SystemDrive === 'string' ? env.SystemDrive.replace(/[\\/]+$/u, '') : 'C:';
    if (process.platform === 'win32') {
      roots.push(`${system}\\`);
      for (const letter of 'CDEFGH'.split('')) {
        if (`${letter}:`.toLowerCase() === system.toLowerCase()) continue;
        roots.push(`${letter}:\\`);
      }
    } else {
      roots.push('/', join(homedir(), 'opt'));
    }
  }
  // Only keep roots that exist; `readdir` on a missing drive is the common case on Windows.
  const usable = [];
  for (const root of roots) {
    if (await isDirectory(root)) usable.push(root);
  }
  return usable;
}

/**
 * Backwards-compatible single-directory view of the workflow locations.
 *
 * New callers should use `resolveWorkflowDirectories`; this function returns the first
 * resolved directory for older call sites that only need a display path.
 *
 * @returns `{ dir, source }`; `dir` is `null` when nothing could be resolved.
 */
export async function resolveWorkflowsDir(config = {}, options = {}) {
  const resolved = await resolveWorkflowDirectories(config, options);
  return { dir: resolved.dir, source: resolved.source };
}

/**
 * Every workflow directory this machine can contribute, not just the winner.
 *
 * A user can keep the 绘世 install and a portable install side by side, with different
 * workflows in each. Ranking one install is useful for choosing a launcher, but using that
 * rank to HIDE the other install's workflows makes half the user's library disappear.
 * Explicit directories stay first; discovered installs follow; duplicates are removed.
 */
export async function resolveWorkflowDirectories(config = {}, options = {}) {
  const directories = [];
  const seen = new Set();
  const add = (dir, source) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) return;
    const path = dir.trim();
    const key = normalize(path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    directories.push({ dir: path, source });
  };

  const configured = typeof config.workflowsDir === 'string' ? config.workflowsDir.trim() : '';
  let explicitDirectories = 0;
  if (configured.length > 0 && await isDirectory(configured)) {
    add(configured, 'config.workflowsDir');
    explicitDirectories += 1;
  }
  for (const entry of Array.isArray(config.workflowSearchPaths) ? config.workflowSearchPaths : []) {
    if (typeof entry === 'string' && entry.trim().length > 0 && await isDirectory(entry.trim())) {
      add(entry, 'config.workflowSearchPaths');
      explicitDirectories += 1;
    }
  }

  // Explicit workflow locations are a deliberate boundary. When none are configured, merge
  // every installed ComfyUI this machine exposes; when some are named, do not surprise the
  // user by adding unrelated folders from other installs.
  if (explicitDirectories === 0) {
    const { installs } = await discoverInstallations(config, options);
    for (const install of installs) {
      if (install.workflowRoot !== null && await isDirectory(install.workflowRoot)) {
        add(install.workflowRoot, `derived from ${install.layout} install at ${install.path}`);
      }
    }

    // A deployment package ships its own workflows under a known sub-path.
    if (typeof config.deployPackPath === 'string' && config.deployPackPath.trim().length > 0) {
      const candidate = join(config.deployPackPath.trim(), 'ComfyUI_windows_portable', 'ComfyUI', 'user', 'default', 'workflows');
      if (await isDirectory(candidate)) add(candidate, 'config.deployPackPath');
    }
  }

  if (directories.length === 0) {
    return {
      dir: configured.length > 0 ? configured : null,
      source: configured.length > 0 ? 'config.workflowsDir (not found on disk yet)' : 'nothing found',
      directories: [],
      unresolved: configured.length > 0 ? [{ dir: configured, source: 'config.workflowsDir (not found on disk yet)' }] : [],
    };
  }
  return {
    dir: directories[0].dir,
    source: directories.length === 1
      ? directories[0].source
      : `${String(directories.length)} workflow directories: ${directories.map((entry) => entry.dir).join('; ')}`,
    directories,
    unresolved: [],
  };
}

/**
 * The root a session may write in, without naming a drive.
 *
 * Order: explicit config, `DSH_WORKSPACE_ROOT`, the system drive, then the user's home. The
 * system drive is preferred over home for the same reason the design root prefers a data
 * drive: video work is large, and a home folder is often on a smaller partition.
 */
export function resolveWorkspaceRoot(config = {}, env = process.env) {
  const configured = typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : '';
  if (configured.length > 0) return { root: configured, source: 'config.workspaceRoot' };
  const fromEnv = typeof env.DSH_WORKSPACE_ROOT === 'string' ? env.DSH_WORKSPACE_ROOT.trim() : '';
  if (fromEnv.length > 0) return { root: fromEnv, source: 'env.DSH_WORKSPACE_ROOT' };
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const system = typeof env.SystemDrive === 'string' && env.SystemDrive.trim().length > 0 ? env.SystemDrive.trim() : null;
  if (system !== null) {
    // Keep an existing legacy output directory readable, but never make the whole system drive
    // the default working root for a fresh install.
    const legacy = join(`${system.replace(/[\\/]+$/u, '')}${sep}`, '通用生成');
    if (existsSync(legacy)) return { root: legacy, source: 'the existing legacy output directory' };
  }
  if (typeof home === 'string' && home.length > 0) {
    return { root: join(home, 'DSH-Workspace'), source: 'the user home directory' };
  }
  return { root: process.cwd(), source: 'the process working directory' };
}

/**
 * Which directory the media service may serve from.
 *
 * Both the design root and the workspace root are legitimate: projects live in the former,
 * and a user may point the tool at a folder inside the latter. Nothing broader is granted -
 * granting a whole drive root would expose every unrelated file on it.
 */
export function mediaRootsFor(config = {}, env = process.env, { designRootDir = null } = {}) {
  const roots = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const root = value.trim();
    if (roots.some((existing) => existing.toLowerCase() === root.toLowerCase())) return;
    roots.push(root);
  };
  add(designRootDir ?? null);
  const workspace = resolveWorkspaceRoot(config, env).root;
  if (/^[a-z]:[\\/]?$/iu.test(workspace)) {
    // A bare drive is not a safe media grant. General-generation output lives one level below it.
    add(join(workspace, '通用生成'));
  } else {
    add(workspace);
  }
  return roots;
}
