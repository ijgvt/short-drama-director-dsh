/**
 * General-mode generation entry point.
 *
 * The five task forms are intentionally thin: they collect only values a creator can
 * understand, then this module resolves the saved task/workflow endpoint and binds those
 * values to the workflow's own graph. Node ids are discovered from the graph so a user can
 * re-save a ComfyUI workflow without turning the panel into a collection of stale ids.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { resolveConfiguredEndpoint } from './generation-config.js';
import { generateH3 } from './h3-generation.js';
import { mediaTypeFor } from './media-service.js';
import { convertQwenEditPrompt } from './qwen-edit-model.js';
import { runComfyWorkflow } from './tools.js';
import { isTransientResultName } from './result-store.js';

export { normalizeQwenEditPrompt } from './qwen-edit-prompt.js';

const TASKS = new Set(['text-to-image', 'image-edit', 'upscale-image', 'upscale-video', 'video-generation']);
const IMAGE_EDIT_PROMPT_MODES = new Set(['qwen-official', 'qwen-converted', 'raw']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
const HISTORY_LIMIT = 24;

function asTask(value) {
  const task = String(value ?? '').trim();
  if (!TASKS.has(task)) throw new Error(`未知的生成任务：${task || '(空)'}`);
  return task;
}

function asImageEditPromptMode(value) {
  const mode = String(value ?? '').trim();
  if (mode.length === 0) return 'qwen-official';
  if (!IMAGE_EDIT_PROMPT_MODES.has(mode)) throw new Error(`未知的图片编辑提示词处理方式：${mode}`);
  return mode;
}

function requestIdFor(value) {
  const supplied = typeof value === 'string' ? value.trim() : '';
  const id = supplied.length > 0 ? supplied : `general_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  if (!/^[\w-]{8,160}$/u.test(id)) throw new Error('生成请求编号无效，请重新点击生成');
  return id;
}

function safeName(value, fallback) {
  const original = basename(String(value ?? '').replace(/\\/gu, '/')).trim();
  const cleaned = original.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/gu, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function extensionFor(kind, fileName) {
  let extension = extname(String(fileName ?? '')).toLowerCase();
  if (extension.length === 0) {
    extension = kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.wav';
  }
  const allowed = kind === 'image' ? IMAGE_EXTENSIONS : kind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  if (!allowed.has(extension)) {
    throw new Error(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}格式不支持：${extension || '(无扩展名)'}`);
  }
  return extension;
}

function decodeMedia(entry, index) {
  const kind = entry?.kind === 'image' || entry?.kind === 'video' || entry?.kind === 'audio' ? entry.kind : null;
  if (kind === null) throw new Error(`第 ${index + 1} 个上传文件的类型无效`);
  const encoded = String(entry?.fileDataBase64 ?? '').replace(/^data:[^,]*,/u, '').trim();
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error(`第 ${index + 1} 个上传文件的数据无效`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new Error(`第 ${index + 1} 个上传文件为空`);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`第 ${index + 1} 个上传文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB；请压缩后再上传`);
  }
  const safeFileName = safeName(entry?.fileName, `input-${index + 1}${extensionFor(kind, entry?.fileName)}`);
  const extension = extensionFor(kind, safeFileName);
  const existingExtension = extname(safeFileName);
  const stem = (existingExtension.length > 0 ? safeFileName.slice(0, -existingExtension.length) : safeFileName) || `input-${index + 1}`;
  return {
    kind,
    fileName: `${stem}${extension}`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function ensureDirectory(fs, path, getPolicy) {
  const resolved = await fs.resolve(path);
  const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
  if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access'
    && typeof fs.checkedTarget !== 'function') {
    throw new Error('当前文件服务无法按会话权限创建生成输入目录；请改用完全权限会话');
  }
  const target = typeof fs.checkedTarget === 'function'
    ? await fs.checkedTarget(resolved, policy)
    : resolved;
  await mkdir(target.targetKey, { recursive: true });
  return target.targetKey;
}

async function writeMediaFiles(fs, directory, media, getPolicy) {
  if (media.length === 0) return [];
  await ensureDirectory(fs, directory, getPolicy);
  const written = [];
  for (const [index, item] of media.entries()) {
    const fileName = `${String(index + 1).padStart(2, '0')}-${item.sha256.slice(0, 12)}-${item.fileName}`;
    const resolved = await fs.resolve(join(directory, fileName));
    const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
    if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access'
      && typeof fs.checkedTarget !== 'function') {
      throw new Error('当前文件服务无法按会话权限写入生成输入文件；请改用完全权限会话');
    }
    const target = typeof fs.checkedTarget === 'function'
      ? await fs.checkedTarget(resolved, policy)
      : resolved;
    await writeFile(target.targetKey, item.bytes, { flag: 'wx' }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    written.push({ ...item, path: target.targetKey });
  }
  return written;
}

async function resolveAssetMedia(entry, index, media, task) {
  const kind = entry?.kind;
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error(`第 ${index + 1} 个项目资产类型无效`);
  if (kind !== 'image' && task !== 'video-generation') {
    throw new Error(`第 ${index + 1} 个项目资产是${kind === 'video' ? '视频' : '音频'}，这个任务只接受图片`);
  }
  const handle = typeof entry?.mediaHandle === 'string' ? entry.mediaHandle.trim() : '';
  if (handle.length === 0) throw new Error(`第 ${index + 1} 个项目资产缺少媒体句柄`);
  if (media === null || media === undefined || typeof media.resolveHandle !== 'function') {
    throw new Error('当前运行环境无法读取项目资产');
  }
  const resolved = media.resolveHandle(handle);
  if (typeof resolved !== 'string' || resolved.length === 0) throw new Error(`第 ${index + 1} 个项目资产已失效，请重新选择`);
  const sourcePath = await realpath(resolved).catch(() => null);
  if (sourcePath === null) throw new Error(`第 ${index + 1} 个项目资产文件已不存在`);
  if (typeof media.insideRealRoots === 'function' && !await media.insideRealRoots(sourcePath)) {
    throw new Error(`第 ${index + 1} 个项目资产超出项目范围`);
  }
  const bytes = await readFile(sourcePath);
  if (bytes.length === 0) throw new Error(`第 ${index + 1} 个项目资产是空文件`);
  return {
    kind,
    fileName: safeName(entry?.fileName, basename(sourcePath)),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    slotNumber: Number.isInteger(entry?.slotNumber) ? entry.slotNumber : null,
    order: Number.isInteger(entry?.order) ? entry.order : null,
    label: typeof entry?.label === 'string' ? entry.label : null,
    assetId: typeof entry?.assetId === 'string' ? entry.assetId : null,
    variantName: typeof entry?.variantName === 'string' ? entry.variantName : null,
    role: typeof entry?.role === 'string' ? entry.role : null,
    source: 'project-asset',
  };
}

async function normalizeMedia(payload, task, context) {
  const entries = Array.isArray(payload.generationMedia) ? payload.generationMedia : [];
  const decoded = entries.map((entry, index) => ({
    ...decodeMedia(entry, index),
    slotNumber: Number.isInteger(entry?.slotNumber) ? entry.slotNumber : null,
    order: Number.isInteger(entry?.order) ? entry.order : null,
    label: typeof entry?.label === 'string' ? entry.label : null,
    source: 'upload',
  }));
  const assetEntries = Array.isArray(payload.generationAssets) ? payload.generationAssets : [];
  const assets = [];
  for (let index = 0; index < assetEntries.length; index += 1) {
    assets.push(await resolveAssetMedia(assetEntries[index], index, context.media, task));
  }
  let combined = [...decoded, ...assets];
  if (task === 'video-generation') {
    const caps = { image: 9, audio: 3, video: 3 };
    const labels = { image: 'Picture', audio: 'Audio', video: 'Video' };
    const ordered = [];
    for (const kind of ['image', 'audio', 'video']) {
      const group = combined.filter((entry) => entry.kind === kind);
      if (group.length > caps[kind]) {
        throw new Error(`H3 <${labels[kind]} N> 最多支持 ${caps[kind]} 个${kind === 'image' ? '图片' : kind === 'audio' ? '音频' : '视频'}参考`);
      }
      const numbered = group.map((entry, index) => ({
        entry,
        slot: Number.isInteger(entry.slotNumber) && entry.slotNumber > 0 ? entry.slotNumber : index + 1,
      }));
      const seen = new Set();
      for (const item of numbered) {
        if (seen.has(item.slot)) throw new Error(`H3 参考槽 <${labels[kind]} ${item.slot}> 重复`);
        seen.add(item.slot);
      }
      numbered.sort((left, right) => left.slot - right.slot);
      for (let index = 0; index < numbered.length; index += 1) {
        if (numbered[index].slot !== index + 1) {
          throw new Error(`H3 <${labels[kind]} N> 必须从 1 开始连续填写，请补齐空槽`);
        }
      }
      ordered.push(...numbered.map((item) => ({ ...item.entry, slotNumber: item.slot })));
    }
    combined = ordered;
  } else if (task === 'image-edit') {
    const ordered = combined.map((entry, index) => ({
      entry,
      order: Number.isInteger(entry.order) && entry.order > 0 ? entry.order : index + 1,
    }));
    const seen = new Set();
    for (const item of ordered) {
      if (seen.has(item.order)) throw new Error(`图片编辑参考顺序 <image${item.order}> 重复`);
      seen.add(item.order);
    }
    ordered.sort((left, right) => left.order - right.order);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].order !== index + 1) {
        throw new Error('图片编辑参考顺序必须从 <image1> 开始连续编号');
      }
    }
    combined = ordered.map((item) => ({ ...item.entry, order: item.order }));
  }
  const totalBytes = combined.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`本次上传文件合计超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB；请减少文件或压缩后再上传`);
  }
  const imageCount = combined.filter((entry) => entry.kind === 'image').length;
  if (task === 'text-to-image' && combined.length > 0) throw new Error('文生图不接受参考图；请使用图片编辑');
  if (task === 'image-edit') {
    if (imageCount < 1) throw new Error('图片编辑需要至少一张参考图');
    if (imageCount > 8) throw new Error('当前图片编辑工作流最多支持 8 张参考图');
    if (combined.some((entry) => entry.kind !== 'image')) throw new Error('图片编辑只接受图片输入');
  }
  if (task === 'upscale-image' && (combined.length !== 1 || combined[0].kind !== 'image')) {
    throw new Error('图像超分需要且只能上传一张图片');
  }
  if (task === 'upscale-video' && (combined.length !== 1 || combined[0].kind !== 'video')) {
    throw new Error('视频超分需要且只能上传一段视频');
  }
  return combined;
}

function resultFiles(generation, media) {
  const files = Array.isArray(generation?.files) ? generation.files : [];
  return files.map((file) => {
    const path = typeof file?.path === 'string' ? file.path : '';
    let handle = null;
    try {
      handle = path.length > 0 && typeof media?.mint === 'function' ? media.mint(path) : null;
    } catch {
      handle = null;
    }
    return {
      name: path.length > 0 ? basename(path) : String(file?.name ?? ''),
      kind: typeof file?.kind === 'string' ? file.kind : null,
      bytes: Number.isFinite(Number(file?.bytes)) ? Number(file.bytes) : null,
      remoteName: typeof file?.remoteName === 'string' ? file.remoteName : null,
      mediaHandle: handle,
      mediaType: path.length > 0 ? mediaTypeFor(path) : null,
    };
  });
}

function resultEndpoint(task, config) {
  return resolveConfiguredEndpoint(task, { config }).catch(() => null);
}

function historyKindFor(path) {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return null;
}

async function collectHistoryFiles(directory) {
  const files = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === '.inputs' || entry.name === '.trash') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.director') {
        files.push(...await collectHistoryFiles(join(path, 'generated')));
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      files.push(...await collectHistoryFiles(path));
      continue;
    }
    if (!entry.isFile() || isTransientResultName(entry.name) || historyKindFor(path) === null) continue;
    const info = await stat(path).catch(() => null);
    if (info?.isFile() !== true || info.size <= 0) continue;
    files.push({ path, name: entry.name, bytes: info.size, modifiedAt: info.mtimeMs });
  }
  return files;
}

/**
 * Recover completed general-mode results after a panel or app restart.
 *
 * The output layout is already durable: one request folder per submission. This scans that
 * layout, skips input staging and compare artifacts, mints fresh media handles, and returns
 * cache entries shaped exactly like a live submission's result.
 */
export async function listGeneralGenerationHistory(context = {}, { limit = HISTORY_LIMIT } = {}) {
  const root = typeof context.root === 'string' && context.root.trim().length > 0 ? context.root.trim() : process.cwd();
  const generalRoot = join(root, '通用生成');
  const entries = [];
  for (const task of TASKS) {
    let requestDirs = [];
    try {
      requestDirs = await readdir(join(generalRoot, task), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const request of requestDirs) {
      if (!request.isDirectory() || request.name.startsWith('.')) continue;
      const directory = join(generalRoot, task, request.name);
      const files = await collectHistoryFiles(directory);
      if (files.length === 0) continue;
      files.sort((left, right) => right.modifiedAt - left.modifiedAt);
      const generatedFiles = files.map((file) => {
        let mediaHandle = null;
        try {
          mediaHandle = typeof context.media?.mint === 'function' ? context.media.mint(file.path) : null;
        } catch {
          mediaHandle = null;
        }
        return {
          name: file.name,
          kind: historyKindFor(file.path),
          bytes: file.bytes,
          remoteName: null,
          mediaHandle,
          mediaType: mediaTypeFor(file.path),
        };
      });
      entries.push({
        cacheId: `general-result-${task}-${request.name}`,
        generationTask: task,
        requestId: request.name,
        endpoint: null,
        workflow: null,
        // Files found on disk are already saved locally. Reporting `completed` here made the
        // panel keep the entry in its non-terminal vocabulary even though preview handles and
        // bytes were available.
        state: 'saved',
        message: '已从磁盘恢复',
        generatedFiles,
        restored: true,
        cachedAt: new Date(files[0].modifiedAt).toISOString(),
      });
    }
  }
  entries.sort((left, right) => String(right.cachedAt).localeCompare(String(left.cachedAt)));
  return {
    generationAction: 'history',
    cache: entries.slice(0, Math.max(0, limit)),
  };
}

/**
 * Run one general-generation form.
 *
 * @param payload - { generationTask, generationPrompt, generationMedia, generationAssets,
 *   generationSettings, requestId }. `generationAssets` carries opaque project-library handles
 *   instead of browser-encoded file bodies.
 * @param context - the shared storyboard context: fs, media, config, getPolicy, root and signal.
 */
export async function runGeneralGeneration(payload = {}, context = {}) {
  const workflowRunner = typeof context.runWorkflow === 'function' ? context.runWorkflow : runComfyWorkflow;
  const videoGenerator = typeof context.generateVideo === 'function' ? context.generateVideo : generateH3;
  const task = asTask(payload.generationTask);
  const imageEditPromptMode = task === 'image-edit' ? asImageEditPromptMode(payload.generationPromptMode) : null;
  const requestId = requestIdFor(payload.requestId);
  const settings = payload.generationSettings !== null && typeof payload.generationSettings === 'object' && !Array.isArray(payload.generationSettings)
    ? payload.generationSettings
    : {};
  const media = await normalizeMedia(payload, task, context);
  if (task === 'image-edit' && payload.generationAction === 'convert-edit-prompt') {
    const rewrite = await convertQwenEditPrompt(String(payload.generationPrompt ?? ''), {
      aspectRatio: typeof settings.aspectRatio === 'string' ? settings.aspectRatio : '',
      references: media,
      images: media.map((entry) => ({
        data: entry.bytes,
        mediaType: mediaTypeFor(entry.fileName),
        fileName: entry.fileName,
        label: entry.label,
        role: entry.role,
      })),
      ctx: context.ctx ?? null,
      modelRoute: context.modelRoute ?? null,
      sessionId: context.sessionId ?? null,
      signal: context.signal ?? null,
    });
    return {
      generationTask: task,
      generationAction: 'convert-edit-prompt',
      requestId,
      state: 'converted',
      message: '已转换为千问 2.1 官方提示词；请检查后再生成',
      promptRewrite: rewrite,
      referenceCount: media.length,
    };
  }
  const root = typeof context.root === 'string' && context.root.trim().length > 0 ? context.root.trim() : process.cwd();
  let outputRoot = join(root, '通用生成', task, requestId);
  outputRoot = await ensureDirectory(context.fs, outputRoot, context.getPolicy);
  const inputDirectory = join(outputRoot, '.inputs');
  const written = await writeMediaFiles(context.fs, inputDirectory, media, context.getPolicy);
  const mediaPaths = written.map((entry) => entry.path);
  const endpoint = await resultEndpoint(task, context.config ?? null);

  if (task === 'video-generation') {
    const prompt = String(payload.generationPrompt ?? '').trim();
    if (prompt.length === 0) throw new Error('视频生成需要 H3 提示词');
    const declaredPictures = [...prompt.matchAll(/<Picture\s+(\d+)>/giu)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value) && value > 0);
    const requiredPictures = declaredPictures.length > 0 ? Math.max(...declaredPictures) : 0;
    if (requiredPictures > written.length) {
      throw new Error(`H3 提示词声明了 <Picture ${requiredPictures}>，但只上传了 ${written.length} 张参考图；请补齐参考图或删掉对应定义`);
    }
    const referenceCounts = { Picture: 0, Audio: 0, Video: 0 };
    const references = written.map((entry) => {
      const mediaType = entry.kind === 'video' ? 'Video' : entry.kind === 'audio' ? 'Audio' : 'Picture';
      referenceCounts[mediaType] += 1;
      return {
        mediaType,
        referenceIndex: referenceCounts[mediaType],
        absolutePath: entry.path,
        sha256: entry.sha256,
        referenceId: `general-${entry.kind}-${referenceCounts[mediaType]}`,
      };
    });
    const seconds = Number(settings.seconds ?? 6);
    const generated = await videoGenerator({
      text: prompt,
      seconds,
      references,
      projectRoot: outputRoot,
      shotId: null,
      episodeNumber: null,
      blockNumber: null,
      settings: {
        mode: settings.mode === 'action' ? 'action' : 'drama',
        resolution: settings.resolution === '480p' || settings.resolution === '1080p' ? settings.resolution : '720p',
        aspectRatio: typeof settings.aspectRatio === 'string' && settings.aspectRatio.length > 0 ? settings.aspectRatio : '9:16',
      },
      requestId,
    }, context);
    const generation = generated.generation ?? null;
    return {
      generationTask: task,
      requestId,
      endpoint,
      workflow: generation?.workflow ? basename(generation.workflow) : null,
      state: generation?.state ?? null,
      message: generated.message ?? '视频任务已提交',
      generatedFiles: resultFiles(generation, context.media),
      generation,
      referenceCount: written.length,
      jobId: generation?.jobId ?? null,
      promptId: generation?.promptId ?? null,
    };
  }

  const promptSource = String(payload.generationPrompt ?? '');
  const promptText = promptSource.trim();
  if (promptText.length === 0 && task !== 'upscale-image' && task !== 'upscale-video') {
    throw new Error('这个任务需要提示词');
  }
  const rewrite = task === 'image-edit' && imageEditPromptMode === 'qwen-official'
    ? await convertQwenEditPrompt(promptSource, {
      imageCount: media.length,
      aspectRatio: typeof settings.aspectRatio === 'string' ? settings.aspectRatio : '',
      references: media,
      images: media.map((entry) => ({
        data: entry.bytes,
        mediaType: mediaTypeFor(entry.fileName),
        fileName: entry.fileName,
        label: entry.label,
        role: entry.role,
      })),
      ctx: context.ctx ?? null,
      modelRoute: context.modelRoute ?? null,
      sessionId: context.sessionId ?? null,
      signal: context.signal ?? null,
    })
    : null;
  const promptForWorkflow = task === 'image-edit' && imageEditPromptMode === 'raw'
    ? promptSource
    : (rewrite?.rewritten_prompt ?? promptText);
  const workflowSettings = rewrite?.wh_ratio && !settings.aspectRatio
    ? { ...settings, aspectRatio: rewrite.wh_ratio }
    : settings;
  const policy = typeof context.getPolicy === 'function' ? context.getPolicy() : undefined;
  const result = await workflowRunner({ ...(context.config ?? {}), ctx: context.ctx ?? null }, {
    task,
    output: outputRoot,
    requestId,
    // Submit and return a ledger job promptly. Waiting inside this Host call made the whole
    // panel's command lane busy for the duration of an image render, so the user could not
    // switch modes until it finished. The result cache resumes collection asynchronously.
    timeout_ms: 0,
    name: `通用生成-${task}-${requestId}`,
    project: outputRoot,
    resultsProjectRoot: outputRoot,
    generalGeneration: {
      task,
      promptText: promptForWorkflow,
      preservePromptWhitespace: task === 'image-edit' && imageEditPromptMode === 'raw',
      mediaPaths,
      settings: {
        ...workflowSettings,
        filenamePrefix: `general-${task}-${requestId}`,
      },
    },
  }, {
    signal: context.signal,
    // The panel has already resolved the caller's live session policy. Carry that exact value
    // into the shared runner: its exec envelope has no session identity, so resolving again there
    // would fall back to the deployment default and reject the output directory after the GPU
    // task had already been queued.
    ...(policy === undefined || policy === null ? {} : { sandboxPolicy: policy }),
    ...(typeof context.getPolicy === 'function' ? { getPolicy: context.getPolicy } : {}),
    agent: { session: { header: { cwd: outputRoot } } },
  });
  return {
    generationTask: task,
    requestId,
    endpoint,
    workflow: result.workflow ? basename(result.workflow) : null,
    state: result.state ?? null,
    message: `${result.state === 'completed' ? '生成完成' : `已提交（${String(result.state ?? '已提交')}）`}`
      + (result.workflowAdaptation ? ' · 工作流已由当前模型适配' : ''),
    generatedFiles: resultFiles(result, context.media),
    promptRewrite: rewrite,
    jobId: result.jobId ?? null,
    promptId: result.promptId ?? null,
    workflowAdaptation: result.workflowAdaptation ?? null,
  };
}
