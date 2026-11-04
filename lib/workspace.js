/**
 * Short-drama project workspace layout.
 *
 * The tree the user specified:
 *
 *   <root>/                                   folder named after the script
 *     剧本.<ext>
 *     资产/
 *       人物资产/<角色名（身份）>/            one folder per character
 *       场景资产/                             scene images (16:9)
 *       道具资产/                             prop images
 *       资产盘点稿/资产盘点稿.md
 *       资产提示词/资产提示词.md
 *     剧集/
 *       第N集/
 *         第N集剧本.txt                      episode script, first three sections = cast/scene/props
 *         本集所需资产/                       copies of every asset the episode uses
 *         dataset.json                        machine-readable record used by sync_asset
 *         <episode>视频提示词.txt
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Asset subtree names, keyed by the kind the tools accept. */
const ASSET_DIRS = { 人物: '人物资产', 场景: '场景资产', 道具: '道具资产' };

/** Strip characters Windows forbids in a file or folder name. */
export function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\r\n]+/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim();
}

/** Character folder name: `名字（身份）`. */
export function characterFolderName(name, relation) {
  const cleanName = sanitizeName(name);
  const cleanRelation = sanitizeName(relation);
  if (cleanRelation.length === 0) return cleanName;
  return `${cleanName}（${cleanRelation}）`;
}

/** Episode folder name: `第N集`. */
export function episodeFolderName(episode) {
  const number = Number(episode);
  if (!Number.isInteger(number) || number < 1) throw new Error(`episode must be a positive integer, got ${String(episode)}`);
  return `第${number}集`;
}

/** True when the path exists as a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists as a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Create one directory, recording what was created versus already present. */
async function ensureDir(path, created, existing, io = null) {
  if (await isDirectory(path)) {
    existing.push(path);
    return;
  }
  await mkdir(io === null ? path : await io.checkedPath(path), { recursive: true });
  created.push(path);
}

/** Write a file unless it exists and overwriting was not requested. */
async function writeOnce(path, content, { overwrite, created, existing, written }, io = null) {
  const alreadyThere = await isFile(path);
  if (alreadyThere && !overwrite) {
    existing.push(path);
    return false;
  }
  const target = io === null ? path : await io.checkedPath(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  written.push(path);
  if (!alreadyThere) created.push(path);
  return true;
}

/** Copy a file into place, keeping the original when it is, byte for byte, the same. */
async function copyOnce(source, target, { overwrite, created, existing, copied }, io = null) {
  if (await isFile(target)) {
    if (!overwrite) {
      existing.push(target);
      return false;
    }
  }
  const checkedTarget = io === null ? target : await io.checkedPath(target);
  await mkdir(dirname(checkedTarget), { recursive: true });
  await copyFile(source, checkedTarget);
  copied.push(target);
  return true;
}

/** Read a JSON file, returning undefined when it is absent or malformed. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Whether a directory already looks like a DIFFERENT project.
 *
 * The project folder is named after the script title, so two scripts that happen to share a
 * title resolve to the same folder. Creating there would mix two productions' episodes, assets
 * and metadata - and the result is not obviously wrong, because both are short dramas with
 * plausible folder names. This is the check that turns that into a question.
 *
 * A folder that is empty, or holds only the tree this function would create, is treated as
 * reusable: re-running the setup, or setting up an empty folder the user just made, must work.
 *
 * @returns a description of what was found, or null when the folder is free.
 */
export async function foreignProjectAt(root, { scriptFileName = null } = {}) {
  if (!await isDirectory(root)) return null;
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const episodeRoot = join(root, '剧集');
  // Existing episodes are the strongest signal: content lives there, and content is what would
  // be mixed. A bare `资产/` tree is not enough to refuse, because that is the shape this
  // function creates and a user may have made it by hand.
  if (await isDirectory(episodeRoot)) {
    let episodes = [];
    try {
      episodes = (await readdir(episodeRoot)).filter((name) => /第\s*\d+\s*集/u.test(name));
    } catch {
      episodes = [];
    }
    if (episodes.length > 0) {
      return {
        kind: 'episodes',
        detail: `这里已经有 ${episodes.length} 集（${episodes.slice(0, 3).join('、')}${episodes.length > 3 ? ' 等' : ''}）`,
      };
    }
  }
  // A different script file already sitting in the folder. The same title usually means the same
  // script, but a different file means it is not - so the name is compared, not just presence.
  if (scriptFileName !== null && names.some((name) => /^剧本\./u.test(name) && name !== scriptFileName)) {
    return { kind: 'script', detail: `这里已经有另一份剧本（${names.find((name) => /^剧本\./u.test(name))}）` };
  }
  // Any real content beyond the tree this creates.
  const known = new Set(['资产', '剧集', '剧本.txt', '剧本.md', '剧本.docx', '.director', '_staging', '_废稿']);
  const foreign = names.filter((name) => !known.has(name));
  if (foreign.length > 0) {
    return { kind: 'content', detail: `这个目录里还有别的东西（${foreign.slice(0, 3).join('、')}${foreign.length > 3 ? ' 等' : ''}）` };
  }
  return null;
}

/**
 * Create the project tree.
 *
 * @param root - absolute project root.
 * @param options - script, episode and asset inputs gathered from the conversation.
 * @returns created / existing / written / copied path lists plus a short report.
 */
export async function ensureDramaWorkspace(root, options = {}) {
  const io = options.io ?? null;
  const created = [];
  const existing = [];
  const written = [];
  const copied = [];
  const report = [];
  const overwrite = options.overwrite === true;
  const projectRecordPath = join(root, '.director', 'project.json');
  const initialized = await isFile(projectRecordPath);

  // Refuse to build on top of a different production. The folder is named after the script
  // title, so a second script with the same title lands here - and mixing two productions'
  // episodes and assets produces a project that looks plausible and is wrong. This is a
  // refusal rather than a warning because the damage is silent: nothing downstream would
  // notice that two series now share one asset tree.
  if (options.allowForeign !== true && !initialized) {
    const scriptFileName = typeof options.scriptPath === 'string' && options.scriptPath.length > 0
      ? `剧本${extname(options.scriptPath).length > 0 ? extname(options.scriptPath) : '.txt'}`
      : null;
    const foreign = await foreignProjectAt(root, { scriptFileName });
    if (foreign !== null) {
      const error = new Error(
        `${root} 里已经有一个项目了：${foreign.detail}。`
        + '同名剧本会落到同一个目录，两个项目混在一起以后很难分开。'
        + '请换一个剧本名（项目目录名就是剧本名），或者明确说明要在这个目录里继续。',
      );
      error.code = 'PROJECT_EXISTS';
      error.detail = foreign;
      throw error;
    }
  }

  await ensureDir(root, created, existing, io);
  const assetRoot = join(root, '资产');
  const peopleRoot = join(assetRoot, ASSET_DIRS.人物);
  for (const path of [
    assetRoot,
    peopleRoot,
    join(assetRoot, ASSET_DIRS.场景),
    join(assetRoot, ASSET_DIRS.道具),
    join(assetRoot, '资产盘点稿'),
    join(assetRoot, '资产提示词'),
    join(root, '剧集'),
  ]) {
    await ensureDir(path, created, existing, io);
  }

  // Script ---------------------------------------------------------------
  const sourceScript = options.scriptPath;
  let scriptFileName = null;
  if (typeof sourceScript === 'string' && sourceScript.length > 0) {
    if (!await isFile(sourceScript)) throw new Error(`script file not found: ${sourceScript}`);
    const extension = extname(sourceScript).length > 0 ? extname(sourceScript) : '.txt';
    scriptFileName = `剧本${extension}`;
    await copyOnce(sourceScript, join(root, scriptFileName), { overwrite, created, existing, copied }, io);
  } else if (typeof options.scriptText === 'string' && options.scriptText.length > 0) {
    scriptFileName = '剧本.txt';
    await writeOnce(join(root, scriptFileName), options.scriptText, { overwrite, created, existing, written }, io);
  }

  // Characters -----------------------------------------------------------
  const characterFolders = new Map();
  for (const character of Array.isArray(options.characters) ? options.characters : []) {
    if (character === null || typeof character !== 'object') continue;
    const folder = characterFolderName(character.name, character.relation);
    if (folder.length === 0) continue;
    const path = join(peopleRoot, folder);
    await ensureDir(path, created, existing, io);
    characterFolders.set(sanitizeName(character.name), folder);
  }

  // Planning documents ---------------------------------------------------
  if (typeof options.inventoryPath === 'string' && options.inventoryPath.length > 0) {
    if (!await isFile(options.inventoryPath)) throw new Error(`asset inventory not found: ${options.inventoryPath}`);
    await copyOnce(options.inventoryPath, join(assetRoot, '资产盘点稿', `资产盘点稿${extname(options.inventoryPath) || '.md'}`), { overwrite, created, existing, copied }, io);
  }
  if (typeof options.promptsPath === 'string' && options.promptsPath.length > 0) {
    if (!await isFile(options.promptsPath)) throw new Error(`asset prompts not found: ${options.promptsPath}`);
    await copyOnce(options.promptsPath, join(assetRoot, '资产提示词', `资产提示词${extname(options.promptsPath) || '.md'}`), { overwrite, created, existing, copied }, io);
  }
  if (Array.isArray(options.scenes) && options.scenes.length > 0) {
    await writeOnce(
      join(assetRoot, ASSET_DIRS.场景, '场景清单.txt'),
      `${options.scenes.map((scene) => sanitizeName(scene)).filter(Boolean).join('\n')}\n`,
      { overwrite, created, existing, written },
      io,
    );
  }
  if (Array.isArray(options.props) && options.props.length > 0) {
    await writeOnce(
      join(assetRoot, ASSET_DIRS.道具, '道具清单.txt'),
      `${options.props.map((prop) => sanitizeName(prop)).filter(Boolean).join('\n')}\n`,
      { overwrite, created, existing, written },
      io,
    );
  }

  // Episodes -------------------------------------------------------------
  const episodeNumbers = new Set();
  for (const episode of Array.isArray(options.episodes) ? options.episodes : []) {
    const number = Number(episode);
    if (Number.isInteger(number) && number > 0) episodeNumbers.add(number);
  }
  const scripts = options.episodeScripts !== null && typeof options.episodeScripts === 'object' ? options.episodeScripts : {};
  for (const key of Object.keys(scripts)) {
    const number = Number(key);
    if (Number.isInteger(number) && number > 0) episodeNumbers.add(number);
  }
  for (const number of [...episodeNumbers].sort((a, b) => a - b)) {
    const folder = join(root, '剧集', episodeFolderName(number));
    await ensureDir(folder, created, existing, io);
    await ensureDir(join(folder, '本集所需资产'), created, existing, io);
    const scriptText = scripts[String(number)] ?? scripts[number];
    if (typeof scriptText === 'string' && scriptText.trim().length > 0) {
      await writeOnce(join(folder, `${episodeFolderName(number)}剧本.txt`), scriptText, { overwrite, created, existing, written }, io);
    }
    const datasetPath = join(folder, 'dataset.json');
    if (!await isFile(datasetPath)) {
      await writeFile(io === null ? datasetPath : await io.checkedPath(datasetPath), `${JSON.stringify(defaultDataset(number), null, 2)}\n`, 'utf8');
      written.push(datasetPath);
      created.push(datasetPath);
    } else {
      existing.push(datasetPath);
    }
  }

  // D5: create the project's sidecar record as part of building the workspace.
  //
  // Without this a brand-new project could not store its 画幅/画风: `settings` refuses to write
  // metadata for a project that has no `.director/project.json` ("initialise it first"), and
  // nothing in the init path created one - so the very first thing a new production must do was
  // fail, and the user had to be walked through a `migrate` call they had no reason to know about.
  // Written only when absent, so re-running init never resets decisions already made.
  if (!await isFile(projectRecordPath)) {
    await mkdir(io === null ? join(root, '.director') : await io.checkedPath(join(root, '.director')), { recursive: true });
    const now = new Date().toISOString();
    const record = {
      schemaVersion: 1,
      projectId: `proj_${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
      name: basename(root),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      adoptedBy: 'workspace-init',
    };
    await writeFile(io === null ? projectRecordPath : await io.checkedPath(projectRecordPath), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    written.push(projectRecordPath);
    created.push(projectRecordPath);
  } else {
    existing.push(projectRecordPath);
    report.push('existing .director/project.json reused; init is idempotent');
  }

  if (episodeNumbers.size === 0) report.push('no episode numbers were given, so 剧集/ has no per-episode folders yet; call init again with episodes once the inventory is ready');
  if (characterFolders.size === 0) report.push('no characters were given, so 资产/人物资产/ is empty; call init again with characters');
  if (scriptFileName === null) report.push('no script was copied; pass script_path or script_text');
  return { root, created, existing, written, copied, report };
}

/** The dataset template written into each new episode folder. */
function defaultDataset(episode) {
  return {
    episode,
    characters: [],
    scenes: [],
    props: [],
    note: 'Each list holds the asset names this episode uses, exactly as written in the 资产盘点稿 and in the first three sections of the episode script. sync_asset copies a produced asset into this folder when its name appears here.',
  };
}

/** Read one episode's dataset record. */
async function readDataset(episodeFolder) {
  const dataset = await readJson(join(episodeFolder, 'dataset.json'));
  if (dataset === undefined || typeof dataset !== 'object') return defaultDataset(Number(episodeFolder.replace(/\D+/gu, '')) || 0);
  return {
    episode: dataset.episode ?? 0,
    characters: Array.isArray(dataset.characters) ? dataset.characters.map(String) : [],
    scenes: Array.isArray(dataset.scenes) ? dataset.scenes.map(String) : [],
    props: Array.isArray(dataset.props) ? dataset.props.map(String) : [],
  };
}

/** True when the episode's dataset claims this asset name. */
function datasetAssetMatch(dataset, assetName, assetKind) {
  const bucket = assetKind === '场景' ? dataset.scenes : assetKind === '道具' ? dataset.props : dataset.characters;
  const wanted = String(assetName).trim();
  const baseName = wanted.replace(/（[^）]*）/gu, '').trim();
  const wantedHasQualifier = wanted !== baseName;
  let variantMismatch = null;
  for (const entry of bucket) {
    const value = String(entry).trim();
    if (value.length === 0) continue;
    const entryBase = value.replace(/（[^）]*）/gu, '').trim();
    if (value === wanted) return { state: 'match', exact: true, requested: value };
    if (entryBase === baseName) {
      const entryHasQualifier = entryBase !== value;
      // A dataset that asks for `场景（夜）` must not silently receive the unqualified scene.
      // Only an unqualified request may match an unqualified asset.
      if (!wantedHasQualifier && !entryHasQualifier) return { state: 'match', exact: false, requested: value };
      variantMismatch ??= { state: 'variant-mismatch', requested: value };
    }
  }
  return variantMismatch;
}

/**
 * Copy one produced asset into every episode that needs it.
 *
 * The first episode receives the file under its own name. Later episodes get the
 * asset name prefixed when that keeps the copies distinguishable.
 */
export async function syncAssetToEpisodes(root, { assetPath, assetName, assetKind = '人物', io = null }) {
  return (await syncAssetToEpisodesDetailed(root, { assetPath, assetName, assetKind, io })).copied;
}

async function hashAt(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function syncAssetToEpisodesDetailed(root, { assetPath, assetName, assetKind = '人物', io = null }) {
  const episodesRoot = join(root, '剧集');
  let folders;
  try {
    folders = (await readdir(episodesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { copied: [], alreadyCurrent: [], unmatchedVariants: [], missingDatasets: [] };
  }
  const copied = [];
  const alreadyCurrent = [];
  const unmatchedVariants = [];
  const missingDatasets = [];
  const fileName = basename(assetPath);
  const sourceHash = await hashAt(assetPath);
  for (const folder of folders.sort(compareEpisodeFolders)) {
    const episodeFolder = join(episodesRoot, folder);
    const datasetFile = join(episodeFolder, 'dataset.json');
    let dataset;
    try {
      dataset = JSON.parse(await readFile(datasetFile, 'utf8'));
    } catch {
      missingDatasets.push(join(folder, 'dataset.json'));
      continue;
    }
    const normalized = {
      episode: dataset.episode ?? 0,
      characters: Array.isArray(dataset.characters) ? dataset.characters.map(String) : [],
      scenes: Array.isArray(dataset.scenes) ? dataset.scenes.map(String) : [],
      props: Array.isArray(dataset.props) ? dataset.props.map(String) : [],
    };
    const match = datasetAssetMatch(normalized, assetName, assetKind);
    if (match === null) continue;
    if (match.state === 'variant-mismatch') {
      unmatchedVariants.push({ episode: folder, requested: match.requested, syncedName: assetName });
      continue;
    }
    const targetDir = join(episodeFolder, '本集所需资产');
    await mkdir(io === null ? targetDir : await io.checkedPath(targetDir), { recursive: true });
    let targetName = fileName;
    if (await isFile(join(targetDir, targetName))) {
      const targetHash = await hashAt(join(targetDir, targetName));
      if (targetHash === sourceHash) {
        alreadyCurrent.push(join(targetDir, targetName));
        continue;
      }
      if (!fileName.startsWith(`${assetName}`)) targetName = `${assetName}_${fileName}`;
    }
    const targetPath = join(targetDir, targetName);
    await copyFile(assetPath, io === null ? targetPath : await io.checkedPath(targetPath));
    copied.push(targetPath);
  }
  return { copied, alreadyCurrent, unmatchedVariants, missingDatasets };
}

/** Sort `第10集` after `第2集`. */
function compareEpisodeFolders(left, right) {
  const a = Number(left.replace(/\D+/gu, '')) || 0;
  const b = Number(right.replace(/\D+/gu, '')) || 0;
  return a - b;
}

/** Absolute path of an asset subtree by kind. */
export function assetDirFor(root, assetKind) {
  const directory = ASSET_DIRS[assetKind];
  if (directory === undefined) throw new Error(`unknown asset kind "${assetKind}"; expected one of ${Object.keys(ASSET_DIRS).join(', ')}`);
  return join(root, '资产', directory);
}

/** Render a project tree for reporting. */
export async function describeTree(root, { maxEntries = 60 } = {}) {
  const lines = [];
  const walk = async (path, depth) => {
    if (lines.length >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      lines.push(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth < 3) await walk(join(path, entry.name), depth + 1);
      if (lines.length >= maxEntries) return;
    }
  };
  await walk(root, 0);
  return lines;
}

export { ASSET_DIRS };
