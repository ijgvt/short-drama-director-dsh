/**
 * Blank-project scaffolding shared by the panel and the director tool.
 *
 * A blank production is still a real project: the same asset tree, project record,
 * per-episode folders and metadata as one created from an inventory. The only difference is
 * that every episode starts with one empty 大分镜 and the asset library starts empty.
 */

import { mkdir, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createDirectorStore } from './director-store.js';
import { applyMigration, planMigration } from './migrate.js';
import { normalizeSetting } from './project-settings.js';
import { ensureDramaWorkspace, episodeFolderName, sanitizeName } from './workspace.js';

const MAX_PROJECT_EPISODES = 999;
export const PROJECT_MIN_FREE_BYTES = 1024 ** 3;
export const PROJECT_RECOMMENDED_FREE_BYTES = 10 * 1024 ** 3;

function writeIo(fs, getPolicy) {
  if (fs === null || fs === undefined) return null;
  const policyFor = typeof getPolicy === 'function' ? getPolicy : () => undefined;
  return {
    async checkedPath(path) {
      if (typeof fs.checkedTarget === 'function') {
        const target = await fs.resolve(path);
        return (await fs.checkedTarget(target, policyFor()))?.targetKey ?? path;
      }
      const policy = policyFor();
      if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access') {
        const error = new Error(`cannot write "${path}": file access denied under ${String(policy.mode ?? 'workspace-write')} mode`);
        error.code = 'FS_SANDBOX_DENIED';
        throw error;
      }
      return path;
    },
  };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeEpisodeCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PROJECT_EPISODES) {
    throw new Error(`集数必须是 1–${String(MAX_PROJECT_EPISODES)} 的整数`);
  }
  return count;
}

function validateProjectName(value) {
  const name = String(value ?? '').trim();
  if (name.length === 0) throw new Error('项目名称不能为空');
  if (/[\\/:*?"<>|\x00-\x1f]/u.test(name)) throw new Error('项目名称不能包含路径字符');
  const safe = sanitizeName(name);
  if (safe.length === 0) throw new Error('项目名称不可用');
  return safe;
}

function validateProjectSetting(key, value) {
  const normalized = normalizeSetting(key, value);
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.value;
}

/**
 * Check the volume before scaffolding a project. A drive can exist while having almost no
 * space; creating there would make the first image/video generation fail long after the
 * project looked successfully created.
 */
export async function inspectProjectStorage(path, {
  statfsImpl = statfs,
  minimumBytes = PROJECT_MIN_FREE_BYTES,
  recommendedBytes = PROJECT_RECOMMENDED_FREE_BYTES,
} = {}) {
  let probe = path;
  let info = null;
  while (true) {
    try {
      info = await statfsImpl(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (info === null) return { path, known: false, blocked: false, warning: null };
  const blockSize = Number(info.bsize);
  const availableBlocks = Number(info.bavail);
  const freeBytes = Number.isFinite(blockSize) && Number.isFinite(availableBlocks)
    ? Math.max(0, blockSize * availableBlocks)
    : null;
  if (freeBytes === null) return { path, known: false, blocked: false, warning: null };
  const freeGb = Math.round((freeBytes / 1024 ** 3) * 10) / 10;
  const blocked = freeBytes < minimumBytes;
  const warning = !blocked && freeBytes < recommendedBytes
    ? `项目盘只剩 ${String(freeGb)}GB，低于建议的 ${String(Math.round(recommendedBytes / 1024 ** 3))}GB。建议在插件设置里切换 projectDrive，或用另一个磁盘目录新建项目。`
    : null;
  return {
    path: probe,
    known: true,
    freeBytes,
    freeGb,
    minimumGb: Math.round(minimumBytes / 1024 ** 3),
    recommendedGb: Math.round(recommendedBytes / 1024 ** 3),
    blocked,
    warning,
  };
}

/**
 * The minimum a blank 大分镜 prompt file can contain while still being a recognised block.
 *
 * The body is deliberately empty. Future authored content belongs to the user or director,
 * not to a template that could be mistaken for finished prompt text.
 */
export function blankStoryboardText() {
  return '## 大分镜 1\n';
}

async function writeIfMissing(path, text, io = null) {
  const target = io === null ? path : await io.checkedPath(path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function scaffoldBlankEpisode(projectRoot, episodeNumber, io = null) {
  const folderName = episodeFolderName(episodeNumber);
  const folder = join(projectRoot, '剧集', folderName);
  const folderTarget = io === null ? folder : await io.checkedPath(folder);
  const neededTarget = io === null ? join(folder, '本集所需资产') : await io.checkedPath(join(folder, '本集所需资产'));
  await mkdir(folderTarget, { recursive: true });
  await mkdir(neededTarget, { recursive: true });
  await writeIfMissing(
    join(folder, `${folderName}剧本.txt`),
    '',
    io,
  );
  await writeIfMissing(
    join(folder, `${folderName}视频提示词.txt`),
    blankStoryboardText(),
    io,
  );
  return folder;
}

/**
 * Adopt the freshly scaffolded prompt files immediately.
 *
 * Without this, the panel could read a generated shotId and then be refused on its first
 * save because project.json existed but documents.json did not. Creating a project is an
 * explicit write, so allocating its initial identities here is not migration by surprise.
 */
async function initializeScaffoldedDocuments(projectRoot, { fs = null, getPolicy = undefined } = {}) {
  const director = createDirectorStore(fs, projectRoot, getPolicy);
  const plan = await planMigration(projectRoot);
  const summary = await applyMigration(director, plan, { commit: true });
  return { plan, summary };
}

/**
 * Create a complete blank production.
 *
 * The optional script is copied into the project root. Parsing it into an asset inventory is
 * a separate director action: filesystem creation must not wait on a language model, and a
 * failed model turn must leave a usable blank project rather than a half-created one.
 */
export async function createBlankDramaProject({
  root,
  name,
  episodeCount,
  aspectRatio = '9:16',
  artStyle = '真人',
  artStyleNote = null,
  resolution = '720p',
  scriptText = null,
  assertWritable = null,
  fs = null,
  getPolicy = undefined,
} = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) throw new Error('缺少项目父目录');
  const safeName = validateProjectName(name);
  const count = normalizeEpisodeCount(episodeCount);
  const parent = root.trim();
  const projectRoot = join(parent, safeName);
  const io = writeIo(fs, getPolicy);
  if (typeof assertWritable === 'function') await assertWritable(projectRoot);
  if (await pathExists(projectRoot)) {
    const error = new Error(`项目已存在：${safeName}`);
    error.code = 'PROJECT_EXISTS';
    throw error;
  }
  const checkedAspect = validateProjectSetting('aspectRatio', aspectRatio);
  const checkedStyle = validateProjectSetting('artStyle', artStyle);
  const checkedResolution = validateProjectSetting('resolution', resolution);
  const checkedNote = validateProjectSetting('artStyleNote', artStyleNote);
  if (checkedStyle === '其他' && (checkedNote === null || checkedNote.length === 0)) {
    throw new Error('选择「其他」画风时，需要填写自定义风格');
  }
  const storage = await inspectProjectStorage(parent);
  if (storage.blocked) {
    const error = new Error(`项目盘只剩 ${String(storage.freeGb)}GB，低于最低 ${String(storage.minimumGb)}GB。请在插件设置里切换 projectDrive，或从另一个磁盘目录新建项目。`);
    error.code = 'INSUFFICIENT_PROJECT_SPACE';
    throw error;
  }

  const episodes = Array.from({ length: count }, (unused, index) => index + 1);
  const workspace = await ensureDramaWorkspace(projectRoot, {
    episodes,
    ...(typeof scriptText === 'string' && scriptText.trim().length > 0
      ? {
        scriptText,
        // A single-episode upload is unambiguously that episode's script. Multi-episode
        // uploads still need real episode boundaries and are not copied into every episode.
        ...(count === 1 ? { episodeScripts: { 1: scriptText } } : {}),
      }
      : {}),
    io,
  });
  for (const episodeNumber of episodes) {
    await scaffoldBlankEpisode(projectRoot, episodeNumber, io);
  }
  const director = createDirectorStore(fs, projectRoot, getPolicy);
  await director.setSettings({
    aspectRatio: checkedAspect,
    resolution: checkedResolution,
    artStyle: checkedStyle,
    artStyleNote: checkedNote,
  }, { decidedBy: 'project-create' });
  const initialized = await initializeScaffoldedDocuments(projectRoot, { fs, getPolicy });

  return {
    ...workspace,
    projectRoot,
    projectName: safeName,
    episodes,
    scriptWritten: typeof scriptText === 'string' && scriptText.trim().length > 0,
    storage,
    spaceWarning: storage.warning ?? null,
    metadata: {
      documents: initialized.plan.documents.length,
      shots: initialized.summary.shots,
    },
  };
}

/**
 * Add one blank episode to an existing project. Project-level assets are untouched, which is
 * what lets a later episode see every asset uploaded for earlier episodes.
 */
export async function createBlankEpisode({
  projectRoot,
  episodeNumber,
  assertWritable = null,
  fs = null,
  getPolicy = undefined,
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('缺少项目路径');
  }
  const number = normalizeEpisodeCount(episodeNumber);
  const root = projectRoot.trim();
  const io = writeIo(fs, getPolicy);
  if (typeof assertWritable === 'function') await assertWritable(root);
  const record = await createDirectorStore(fs, root, getPolicy).readProject();
  if (record === undefined || record === null) throw new Error('项目尚未初始化，不能新增集数');
  const folder = join(root, '剧集', episodeFolderName(number));
  if (await pathExists(folder)) {
    throw new Error(`项目里已经有第${String(number)}集`);
  }
  await ensureDramaWorkspace(root, { episodes: [number], io });
  await scaffoldBlankEpisode(root, number, io);
  await initializeScaffoldedDocuments(root, { fs, getPolicy });
  return {
    projectRoot: root,
    projectName: basename(root),
    episodeNumber: number,
    folder,
  };
}
