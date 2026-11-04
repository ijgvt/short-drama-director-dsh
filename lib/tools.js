/**
 * Model-facing tools of the short-drama director plugin.
 *
 * Every tool is registered in `apply()` in `../index.js`; this module owns the
 * definitions. Queued prompt ids live in a durable ledger (lib/job-store.js) rather than
 * in process memory, so a run started in one session can be collected in the next.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  applyRequiredDefaults,
  availableModelNames,
  collectOutputs,
  downloadOutput,
  formatExecutionErrors,
  interrupt,
  cancelQueueItem,
  normalizeBaseUrl,
  isCosmeticNodeClass,
  patchPrompt,
  pollPrompt,
  probeEndpoint,
  submitPrompt,
  countReferenceSlots,
  readObjectInfo,
  readQueue,
  remoteNameForContent,
  summarizePrompt,
  uiGraphToPrompt,
  uploadImage,
} from './comfy.js';
import { ensureDramaWorkspace, syncAssetToEpisodesDetailed } from './workspace.js';
import { inspectImageBytes } from './image-guard.js';
import { mediaTypeFor } from './media-service.js';
import { createJobStore, LIVE_STATES } from './job-store.js';
import { createResultStore, isTransientResultName } from './result-store.js';
import { designRoot, projectPathFor } from './design-root.js';
import { estimateDuration } from './install.js';

/**
 * The job ledger for this deployment.
 *
 * config.jobLedgerDir lets a profile keep jobs somewhere other than the default user-data
 * directory; everything else gets one ledger per DSH home, which is what makes a job started
 * in one session visible in the next.
 */
function jobStore(config) {
  return createJobStore(config.jobLedgerDir === undefined ? {} : { dir: config.jobLedgerDir });
}

/** Only an answered failure may reuse an intent. Unknown submissions require human reconciliation. */
export function ledgerStateCanResubmit(state) {
  return state === 'failed' || state === 'cancelled';
}

/** Resolve the caller-owned filesystem and sandbox policy for Host-side tool writes. */
function runnerIo(config = {}, exec = undefined, overrides = {}) {
  const ctx = config.ctx ?? null;
  const fs = overrides.fs ?? (typeof ctx?.get === 'function' ? ctx.get('fs') : null);
  const sandboxPolicy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
  const sessionId = exec?.agent?.session?.header?.id ?? exec?.agent?.id ?? undefined;
  const directSession = exec?.agent?.session;
  const lookedUpSession = typeof sessions?.get === 'function' && typeof sessionId === 'string'
    ? sessions.get(sessionId)
    : undefined;
  const session = typeof directSession?.id === 'string'
    ? directSession
    : (lookedUpSession ?? directSession);
  let policy;
  if (typeof overrides.getPolicy === 'function') {
    policy = overrides.getPolicy();
  } else if (exec?.sandboxPolicy !== undefined && exec?.sandboxPolicy !== null) {
    // A generator such as H3 has already resolved policy for THIS call. Its runWorkflow exec
    // envelope has no agent session, so carrying the resolved policy prevents the runner from
    // falling back to the deployment default.
    policy = exec.sandboxPolicy;
  } else if (typeof exec?.getPolicy === 'function') {
    policy = exec.getPolicy();
  } else if (typeof sandboxPolicy?.resolve === 'function') {
    try {
      policy = sandboxPolicy.resolve(session === undefined ? {} : { session });
    } catch {
      policy = undefined;
    }
  }
  const checkedPath = async (path) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error('cannot write an empty filesystem path');
    }
    // `checkedTarget` accepts a RESOLVED TARGET OBJECT, not a path string. Passing the string
    // through worked under danger-full-access because that mode returns its input unchanged;
    // workspace-write immediately reads `target.displayPath`, so the string became `undefined`
    // and dsh-fs-local eventually called `.trim()` on it. Resolve first in BOTH cases.
    const target = fs !== null && fs !== undefined && typeof fs.resolve === 'function'
      ? await fs.resolve(path, {
        ...(typeof exec?.cwd === 'string' ? { cwd: exec.cwd } : {}),
        ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      })
      : path;
    if (fs !== null && fs !== undefined && typeof fs.checkedTarget === 'function') {
      const checked = await fs.checkedTarget(target, policy);
      return checked?.targetKey ?? target?.targetKey ?? path;
    }
    if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access') {
      const error = new Error(`cannot write "${path}": file access denied under ${String(policy.mode ?? 'workspace-write')} mode`);
      error.code = 'FS_SANDBOX_DENIED';
      throw error;
    }
    return target?.targetKey ?? path;
  };
  return {
    fs,
    policy,
    getPolicy: () => policy,
    checkedPath,
    async ensureDir(path) {
      const target = await checkedPath(path);
      await mkdir(target, { recursive: true });
      return target;
    },
    async writeBytes(path, bytes) {
      await writeFile(await checkedPath(path), bytes);
    },
  };
}

/**
 * Move a collector-owned job state without ever regressing a saved result.
 *
 * The same job can be observed by the in-process H3 watcher, the panel's refresh polling and
 * a later jobs read at the same time. They used to each write `completed` before downloading,
 * so a slower observer could overwrite `saved` after the file already existed. The result then
 * looked unfinished forever even though ComfyUI and the local file were both complete.
 */
async function setCollectedJobState(ledger, jobId, state, detail = {}) {
  return await ledger.update(jobId, (job) => {
    if (job.state === 'saved' && state !== 'saved') return job;
    const now = new Date().toISOString();
    const changed = job.state !== state
      || (detail.note !== undefined && detail.note !== job.note);
    return {
      ...job,
      state,
      ...detail,
      updatedAt: now,
      events: changed
        ? [...(job.events ?? []), { at: now, state, ...(detail.note === undefined ? {} : { note: detail.note }) }]
        : (job.events ?? []),
    };
  });
}

/**
 * Bring one durable ledger entry back in sync with its ComfyUI instance.
 *
 * The normal `comfy_run` path polls in-process, but that loop disappears when DSH exits.
 * The ledger is deliberately durable, so the result panel must be able to resume the
 * observation later: ask `/history`, download the finished outputs, and only then move the
 * entry to `saved`. This is collection, not a new generation.
 */
export async function refreshLedgerJob(jobId, { config = {}, signal, fs = null, getPolicy = undefined } = {}) {
  const ledger = jobStore(config);
  const io = runnerIo(config, undefined, { fs, getPolicy });
  const job = await ledger.read(jobId);
  if (job === undefined || job === null || typeof job.promptId !== 'string' || job.promptId.length === 0) {
    return job;
  }
  if (['saved', 'failed', 'cancelled'].includes(job.state)) return job;
  // Older collection passes could leave `completed` in the ledger after the bytes had already
  // landed locally. Reconcile that local fact before asking the instance, so a finished video
  // becomes terminal even when the tunnel is currently offline.
  if (['completed', 'download_failed', 'downloading'].includes(job.state) && Array.isArray(job.files) && job.files.length > 0) {
    const existing = [];
    for (const entry of job.files) {
      const value = entry !== null && typeof entry === 'object' ? entry : { path: entry };
      const path = typeof value.path === 'string' ? value.path : '';
      if (path.length === 0) continue;
      const info = await stat(path).catch(() => null);
      if (info?.isFile() !== true || info.size <= 0) continue;
      existing.push({
        ...value,
        path,
        kind: typeof value.kind === 'string' ? value.kind : kindOfOutputFile(path),
        bytes: info.size,
        remoteName: typeof value.remoteName === 'string' ? value.remoteName : basename(path),
      });
    }
    if (existing.length > 0) {
      await setCollectedJobState(ledger, job.jobId, 'saved', { files: existing });
      return await ledger.read(job.jobId);
    }
  }
  const baseUrl = typeof job.instanceId === 'string' ? job.instanceId : job.plan?.instanceId;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return job;

  let observed;
  try {
    observed = await pollPrompt(baseUrl, job.promptId, { signal, timeoutMs: 15000 });
  } catch (error) {
    return {
      ...job,
      refreshError: String(error?.message ?? error).slice(0, 500),
    };
  }

  if (observed.state === 'pending') {
    await setCollectedJobState(ledger, job.jobId, 'queued');
    return await ledger.read(job.jobId);
  }
  if (observed.state === 'running') {
    await setCollectedJobState(ledger, job.jobId, 'running');
    return await ledger.read(job.jobId);
  }
  if (observed.state === 'error') {
    const errors = formatExecutionErrors({ status: observed.status });
    await setCollectedJobState(ledger, job.jobId, 'failed', {
      note: (errors.length > 0 ? errors.join(' | ') : 'the instance reported the run as failed').slice(0, 500),
    });
    return await ledger.read(job.jobId);
  }
  if (observed.state === 'unknown') {
    // A prompt that has disappeared from both the queue and history is not still generating.
    // Give the instance a grace period for the queue/history handoff, then surface it for human
    // reconciliation instead of leaving the shot in "running" forever.
    const activity = Date.parse(String(job.updatedAt ?? job.createdAt ?? ''));
    if (Number.isFinite(activity) && Date.now() - activity > 10 * 60 * 1000) {
      await setCollectedJobState(ledger, job.jobId, 'submission_unknown', {
        note: 'ComfyUI 队列和 history 都已找不到这个 prompt，且本地没有结果；请先核对原实例，不要自动重投',
      });
      return await ledger.read(job.jobId);
    }
    return job;
  }
  if (observed.state !== 'completed') return job;

  await setCollectedJobState(ledger, job.jobId, 'downloading', { outputs: observed.outputs ?? [] });
  const outputDir = typeof job.output === 'string' && job.output.length > 0 ? resolve(job.output) : null;
  if (outputDir === null) return await ledger.read(job.jobId);

  const files = [];
  const errors = [];
  for (const item of Array.isArray(observed.outputs) ? observed.outputs : []) {
    if (isTransientResultName(item.filename)) continue;
    const extension = extname(item.filename).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension)) continue;
    const kind = kindOfOutputFile(item.filename);
    const targetPath = join(outputDir, basename(item.filename));
    try {
      if (!await isFile(targetPath)) {
        const { buffer } = await downloadOutput(baseUrl, {
          filename: item.filename,
          subfolder: item.subfolder,
          type: item.type,
          signal,
        });
        await io.ensureDir(outputDir);
        await io.writeBytes(targetPath, buffer);
      }
      const info = await stat(targetPath);
      files.push({
        path: targetPath,
        kind,
        bytes: info.size,
        remoteName: item.filename,
      });
      if (typeof job.plan?.resultsProjectRoot === 'string' && job.plan.resultsProjectRoot.length > 0) {
        try {
          await createResultStore(job.plan.resultsProjectRoot, {
            fs: io.fs,
            getPolicy: io.getPolicy,
          }).record({
            jobId: job.jobId,
            shotId: job.shotId ?? job.plan.shotId ?? null,
            episodeNumber: Number.isInteger(job.plan.episodeNumber) ? job.plan.episodeNumber : null,
            blockNumber: Number.isInteger(job.plan.blockNumber) ? job.plan.blockNumber : null,
            sourcePath: targetPath,
            producedName: basename(targetPath),
            role: job.name ?? null,
          });
        } catch {
          // The generated file is still usable when the optional candidate index fails.
        }
      }
    } catch (error) {
      errors.push(`${item.filename}: ${String(error?.message ?? error)}`);
    }
  }

  if (files.length > 0) {
    await setCollectedJobState(ledger, job.jobId, 'saved', {
      files,
      ...(errors.length === 0 ? {} : { note: `部分文件下载失败：${errors.slice(0, 3).join(' | ')}`.slice(0, 500) }),
    });
  } else {
    await setCollectedJobState(ledger, job.jobId, 'download_failed', {
      note: (errors.length > 0
        ? errors.slice(0, 3).join(' | ')
        : 'the instance finished but returned no downloadable media').slice(0, 500),
    });
  }
  return await ledger.read(job.jobId);
}
import { selectInstance } from './launch.js';
import { checkModels } from './workflows.js';
import { resolveWorkflowsDir, discoverInstallations } from './env-discovery.js';
import { statePath, updateState, upsertProject } from './state.js';
import { normalizeQwenEditPrompt } from './qwen-edit-prompt.js';
import { convertQwenEditPrompt } from './qwen-edit-model.js';
import { adaptGeneralWorkflowWithModel } from './workflow-adapter-model.js';

/** path -> parsed workflow JSON, so one converted graph serves many runs. */
const graphCache = new Map();
/** promptId -> job record for polling and delivery. */
/**
 * Object info is per-instance AND per-process-start.
 *
 * ComfyUI can gain custom nodes after it restarts while this Host keeps running. A cache that
 * never expires therefore keeps reporting the missing class forever, even though the local
 * ComfyUI already loaded it and can run the workflow. Keep a short TTL, and allow a forced
 * refresh when a converted graph reports a missing active node class.
 */
const objectInfoCache = new Map();
const OBJECT_INFO_CACHE_TTL_MS = 30_000;

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mkv', '.flac', '.mp3', '.wav']);

/**
 * Video upscale is target-resolution based, not source-multiplier based.
 *
 * The VOSR2 video branch first resizes the LONG side, then applies an integer scale. Its
 * historical 640 + x2 chain turns a 736x1280 source into the same 736x1280 output. Using a
 * target long side makes every clip land on a predictable editing format.
 */
export const VIDEO_UPSCALE_TARGETS = Object.freeze({
  '480p': Object.freeze({ longSide: 854, label: '480p' }),
  '720p': Object.freeze({ longSide: 1280, label: '720p' }),
  '1080p': Object.freeze({ longSide: 1920, label: '1080p' }),
  '2K': Object.freeze({ longSide: 2560, label: '2K' }),
  '4K': Object.freeze({ longSide: 3840, label: '4K' }),
});

const VIDEO_UPSCALE_SCALE = 2;

export function normalizeVideoUpscaleTarget(value, fallback = '1080p') {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) return fallback;
  const canonical = Object.keys(VIDEO_UPSCALE_TARGETS)
    .find((key) => key.toLowerCase() === raw.toLowerCase());
  if (canonical === undefined || !Object.hasOwn(VIDEO_UPSCALE_TARGETS, canonical)) {
    throw new Error(`视频超分目标清晰度无效：${raw || '(空)'}`);
  }
  return canonical;
}

/** Resolve the `%date:...%` placeholders ComfyUI supports inside a prefix. */
export function resolveDatePlaceholders(prefix) {
  return String(prefix).replace(/%date:([^%]+)%/gu, (_match, format) => {
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return String(format)
      .replace(/yyyy/gu, String(now.getFullYear()))
      .replace(/MM/gu, pad(now.getMonth() + 1))
      .replace(/dd/gu, pad(now.getDate()))
      .replace(/HH/gu, pad(now.getHours()))
      .replace(/hh/gu, pad(now.getHours()))
      .replace(/mm/gu, pad(now.getMinutes()))
      .replace(/ss/gu, pad(now.getSeconds()));
  });
}

/** A `copy_as` value is a file name, never a path. */
export function safeCopyName(value, fallback = 'result') {
  const name = basename(String(value ?? '').replace(/\\/gu, '/')).trim();
  return name.length > 0 && name !== '.' && name !== '..' ? name : fallback;
}

/**
 * Look a produced filename up in a rename map, tolerating a `%date:...%` key.
 *
 * ComfyUI resolves `%date:yyyyMMddhhmmss%` while running, so a caller who copies
 * that placeholder out of a saved workflow cannot know the real filename. A key
 * containing the placeholder is therefore matched by its literal prefix too.
 */
function lookupRename(map, filename) {
  if (map === undefined || map === null) return undefined;
  if (Object.hasOwn(map, filename)) return map[filename];
  const base = filename.replace(/^.*[\\/]/u, '');
  if (Object.hasOwn(map, base)) return map[base];
  for (const [key, value] of Object.entries(map)) {
    const marker = key.indexOf('%date:');
    if (marker > 0 && filename.startsWith(key.slice(0, marker))) return value;
  }
  return undefined;
}

/** Resolve a caller path against the session workspace, keeping absolute paths intact. */
function resolvePath(path, exec) {
  const raw = String(path ?? '').trim();
  if (!isAbsolute(raw)) {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error(`"${raw}" is relative but the session has no working directory`);
    return resolve(cwd, raw);
  }
  return resolve(raw);
}

/** Read and cache one workflow file. */
async function loadGraph(path) {
  const cached = graphCache.get(path);
  if (cached !== undefined) return cached;
  const raw = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  graphCache.set(path, parsed);
  return parsed;
}

/** Fetch `/object_info`, reusing only a recent answer for this instance. */
async function objectInfoFor(baseUrl, signal, { refresh = false, maxAgeMs = OBJECT_INFO_CACHE_TTL_MS } = {}) {
  const key = normalizeBaseUrl(baseUrl);
  const cached = objectInfoCache.get(key);
  if (!refresh && cached !== undefined && Date.now() - cached.fetchedAt < maxAgeMs) return cached.info;
  const info = await readObjectInfo(baseUrl, { timeoutMs: 120000, signal });
  objectInfoCache.set(key, { info, fetchedAt: Date.now() });
  return info;
}

/** Active node classes the target instance does not declare, ignoring canvas-only helpers. */
function missingActiveNodeClasses(converted) {
  return [...new Set((converted?.skipped ?? [])
    .filter((entry) => !isCosmeticNodeClass(entry.type) && entry.reason === 'node class is not installed on this instance')
    .map((entry) => entry.type))];
}

/** Workflow-shape failures the session model may be able to adapt, unlike bad user input. */
function isWorkflowShapeError(error) {
  const message = String(error?.message ?? error);
  return /the configured .*workflow|image slot .* has no active LoadImage|editable numeric scale input|视频超分工作流没有/u.test(message)
    && !/needs prompt|需要提示词|需要至少一张|需要且只能上传/u.test(message);
}

/** Candidates to probe when the caller names no address. */
function defaultCandidates(config) {
  const list = [];
  if (typeof config.comfyBaseUrl === 'string' && config.comfyBaseUrl.trim().length > 0) list.push(config.comfyBaseUrl.trim());
  for (const port of config.localPorts ?? []) list.push(`http://127.0.0.1:${port}`);
  return [...new Set(list)];
}

/** Seconds -> a compact human string for tool output. */
function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function linkedSourceId(value) {
  return Array.isArray(value) && value.length >= 2 ? String(value[0]) : null;
}

/** Follow a converted prompt link to the first upstream node matching a predicate. */
function findUpstreamNode(prompt, value, predicate, seen = new Set()) {
  const id = linkedSourceId(value);
  if (id === null || seen.has(id)) return null;
  seen.add(id);
  const node = prompt[id];
  if (node === undefined) return null;
  if (predicate(node, id)) return { id, node };
  for (const input of Object.values(node.inputs ?? {})) {
    const found = findUpstreamNode(prompt, input, predicate, seen);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Pick the ComfySwitch branch for the requested output canvas.
 *
 * TextEncodeQwenImage21 exposes an empty latent sized to the first reference image. The other
 * branch is the workflow's explicit EmptyLatentImage driven by ResolutionSelector. A same-ratio
 * edit wants the reference-sized branch; a 16:9 four-view or another explicit target ratio wants
 * the empty-latent branch while the reference conditioning still travels separately.
 */
function qwenEditSwitchSetting(node, encoderId, { useReferenceCanvas = true, fallback = null } = {}) {
  const direct = (value) => Array.isArray(value) && String(value[0]) === String(encoderId);
  const referenceBranch = direct(node.inputs?.on_false) ? false : direct(node.inputs?.on_true) ? true : null;
  if (referenceBranch !== null) return useReferenceCanvas ? referenceBranch : !referenceBranch;
  if (fallback !== null) return fallback;
  return typeof node.inputs?.switch === 'boolean' ? node.inputs.switch : false;
}

function newGenerationSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Patch every active seed-bearing node in an image graph.
 *
 * A UI workflow can keep the sampler seed linked to `Seed (rgthree)`, or it can expose
 * `noise_seed` on a custom-sampler chain. Patching only the helper node is not enough when
 * the converter drops / disconnects it, so the same numeric seed is written to all active
 * `seed` and `noise_seed` inputs. The patch is validated before submission like every other.
 */
function patchSeedInputs(prompt, patch, seed) {
  const patched = [];
  for (const [id, node] of Object.entries(prompt)) {
    for (const input of ['seed', 'noise_seed']) {
      if (!Object.hasOwn(node.inputs ?? {}, input)) continue;
      patch[`${id}.${input}`] = seed;
      patched.push({ node: id, classType: node.class_type, input });
    }
  }
  return patched;
}

export function expandSeedOverrides(patch, prompt) {
  const next = { ...(patch ?? {}) };
  const explicit = Object.entries(next)
    .filter(([key, value]) => /\.(?:seed|noise_seed)$/u.test(key) && Number.isInteger(Number(value)))
    .map(([, value]) => Number(value));
  if (explicit.length === 0) return next;
  const seed = explicit[0];
  // If the caller asks for one seed, every linked sampler/helper input must receive the
  // same value. Patching only Seed (rgthree) could leave the sampler's required seed empty
  // after conversion, which made ComfyUI silently fall back to 0.
  for (const [id, node] of Object.entries(prompt ?? {})) {
    for (const input of ['seed', 'noise_seed']) {
      if (Object.hasOwn(node.inputs ?? {}, input)) next[`${id}.${input}`] = seed;
    }
  }
  return next;
}

/**
 * Adapt a Qwen image-edit graph to one 9:16 portrait -> one 16:9 four-view.
 *
 * Node ids differ after users save the workflow, so they are found from the graph:
 * the prompt and reference image are traced upstream from the active
 * TextEncodeQwenImage21 node. Extra reference images are removed from its inputs because
 * the four-view prompt requires exactly one person image.
 */
export function prepareCharacterQuadviewPrompt(prompt, { referenceImage, promptText, filenamePrefix = null, seed = null } = {}) {
  const encoder = Object.entries(prompt).find(([, node]) => /TextEncodeQwenImage21/iu.test(node.class_type ?? ''));
  if (encoder === undefined) {
    throw new Error('the configured image-edit workflow has no active TextEncodeQwenImage21 node; choose the Qwen image edit workflow that supports four-view generation');
  }
  const [encoderId, encoderNode] = encoder;
  const imageSource = findUpstreamNode(
    prompt,
    encoderNode.inputs?.['images.image_1'],
    (node) => /LoadImage/iu.test(node.class_type ?? '') && typeof node.inputs?.image === 'string',
  );
  if (imageSource === null) {
    throw new Error('the image-edit workflow has no active LoadImage connected to images.image_1');
  }
  const promptSource = findUpstreamNode(
    prompt,
    encoderNode.inputs?.prompt,
    (node) => typeof node.inputs?.value === 'string' || typeof node.inputs?.text === 'string',
  );
  const promptRewrite = normalizeQwenEditPrompt(promptText, { imageCount: 1, aspectRatio: '16:9' });
  const patch = {};
  if (promptSource !== null) {
    const inputName = typeof promptSource.node.inputs?.value === 'string' ? 'value' : 'text';
    patch[`${promptSource.id}.${inputName}`] = promptRewrite.rewritten_prompt;
  } else if (typeof encoderNode.inputs?.prompt === 'string') {
    patch[`${encoderId}.prompt`] = promptRewrite.rewritten_prompt;
  } else {
    throw new Error('the image-edit workflow has no editable text prompt upstream of TextEncodeQwenImage21');
  }

  // Four-view mode needs exactly one person reference. The saved Qwen workflow keeps
  // image-2..image-9 in the same encoder; bypassed sources are already removed by the
  // converter, and any remaining extra reference is dropped here.
  for (const name of Object.keys(encoderNode.inputs ?? {})) {
    if (/^images\.image_[2-9]$/u.test(name)) delete encoderNode.inputs[name];
  }

  const switches = Object.entries(prompt).filter(([, node]) => /ComfySwitchNode/iu.test(node.class_type ?? ''));
  if (switches.length === 0) {
    throw new Error('the image-edit workflow has no active ComfySwitchNode; four-view generation could silently return the input image');
  }
  for (const [id, node] of switches) {
    if (typeof node.inputs?.switch === 'boolean') {
      patch[`${id}.switch`] = qwenEditSwitchSetting(node, encoderId, { useReferenceCanvas: false, fallback: true });
    }
  }

  const resolutions = Object.entries(prompt).filter(([, node]) => /ResolutionSelector/iu.test(node.class_type ?? ''));
  if (resolutions.length === 0) {
    throw new Error('the image-edit workflow has no active ResolutionSelector, so the four-view size cannot be guaranteed');
  }
  for (const [id, node] of resolutions) {
    if (Object.hasOwn(node.inputs ?? {}, 'aspect_ratio')) patch[`${id}.aspect_ratio`] = '16:9';
    if (Object.hasOwn(node.inputs ?? {}, 'megapixels')) patch[`${id}.megapixels`] = 1.5;
  }

  if (typeof filenamePrefix === 'string' && filenamePrefix.trim().length > 0) {
    const save = Object.entries(prompt).find(([, node]) => /SaveImage/iu.test(node.class_type ?? '')
      && Object.hasOwn(node.inputs ?? {}, 'filename_prefix'));
    if (save !== undefined) patch[`${save[0]}.filename_prefix`] = filenamePrefix.trim();
  }
  const actualSeed = Number.isInteger(seed) ? seed : newGenerationSeed();
  const seedTargets = patchSeedInputs(prompt, patch, actualSeed);
  return {
    patch,
    inputs: { [imageSource.id]: String(referenceImage) },
    imageNodeId: imageSource.id,
    promptNodeId: promptSource?.id ?? encoderId,
    promptRewrite,
    seed: actualSeed,
    seedTargets,
  };
}

/**
 * Bind a source image and a 3x factor to an image-upscale graph.
 *
 * The saved VOSR2 workflow can route its `scale` input through an `easy int` helper, so
 * patching the upscaler node directly would do nothing. Follow the link and patch the numeric
 * source instead. Node ids are discovered from the converted prompt; nothing here assumes the
 * ids from this machine's saved workflow.
 */
export function prepareImageUpscalePrompt(prompt, { sourceImage, factor = 3, filenamePrefix = null } = {}) {
  const upscaler = Object.entries(prompt).find(([, node]) => /VOSR2Image|SeedVR2|ImageUpscaleWithModel/iu.test(node.class_type ?? ''));
  if (upscaler === undefined) {
    throw new Error('the configured image-upscale workflow has no active VOSR2/SeedVR2 image upscaler');
  }
  const [upscalerId, upscalerNode] = upscaler;
  const loader = findUpstreamNode(
    prompt,
    upscalerNode.inputs?.images ?? upscalerNode.inputs?.image,
    (node) => /LoadImage/iu.test(node.class_type ?? '') && typeof node.inputs?.image === 'string',
  );
  if (loader === null) {
    throw new Error('the configured image-upscale workflow has no active LoadImage connected to its upscaler');
  }
  const patch = {};
  const scale = upscalerNode.inputs?.scale;
  if (typeof scale === 'number') {
    patch[`${upscalerId}.scale`] = factor;
  } else {
    const scaleSourceId = linkedSourceId(scale);
    const scaleSource = scaleSourceId === null ? undefined : prompt[scaleSourceId];
    const numericInput = scaleSource === undefined
      ? null
      : Object.entries(scaleSource.inputs ?? {}).find(([, value]) => typeof value === 'number');
    if (scaleSourceId === null || numericInput === undefined || numericInput === null) {
      throw new Error('the image-upscale workflow has no editable numeric scale input; refusing to run at an unknown factor');
    }
    patch[`${scaleSourceId}.${numericInput[0]}`] = factor;
  }
  if (typeof filenamePrefix === 'string' && filenamePrefix.trim().length > 0) {
    const save = Object.entries(prompt).find(([, node]) => /SaveImage/iu.test(node.class_type ?? '')
      && Object.hasOwn(node.inputs ?? {}, 'filename_prefix'));
    if (save !== undefined) patch[`${save[0]}.filename_prefix`] = filenamePrefix.trim();
  }
  return {
    patch,
    inputs: { [loader.id]: String(sourceImage) },
    imageNodeId: loader.id,
    upscalerNodeId: upscalerId,
    factor,
  };
}

/** The plain string widget a prompt can be written through, or null. */
function promptInputName(node) {
  for (const name of ['value', 'text', 'prompt']) {
    if (Object.hasOwn(node?.inputs ?? {}, name) && typeof node.inputs[name] === 'string') return name;
  }
  return null;
}

/** Write one plain string prompt input, refusing a linked or absent target. */
function setPromptNodeText(prompt, nodeId, node, text, patch) {
  const inputName = promptInputName(node);
  if (inputName === null) {
    throw new Error(`node ${nodeId} (${node.class_type}) has no editable string prompt input; refusing to run with an old prompt`);
  }
  patch[`${nodeId}.${inputName}`] = String(text);
  return inputName;
}

function findPromptSourceForSampler(prompt) {
  const anchors = [];
  for (const node of Object.values(prompt)) {
    if (!/Sampler/iu.test(String(node.class_type ?? ''))) continue;
    if (node.inputs?.positive !== undefined) anchors.push(node.inputs.positive);
  }
  for (const anchor of anchors) {
    const found = findUpstreamNode(prompt, anchor, (node) => promptInputName(node) !== null);
    if (found !== null) return found;
  }
  const fallback = Object.entries(prompt).find(([, node]) => promptInputName(node) !== null);
  return fallback === undefined ? null : { id: fallback[0], node: fallback[1] };
}

function patchGeneralResolution(prompt, settings, patch) {
  if (typeof settings?.aspectRatio !== 'string' || settings.aspectRatio.trim().length === 0) return;
  const selectors = Object.entries(prompt)
    .filter(([, node]) => /ResolutionSelector/iu.test(String(node.class_type ?? '')))
    .filter(([, node]) => Object.hasOwn(node.inputs ?? {}, 'aspect_ratio'));
  if (selectors.length === 0) throw new Error('the configured image workflow has no editable ResolutionSelector');
  for (const [id, node] of selectors) {
    patch[`${id}.aspect_ratio`] = settings.aspectRatio.trim();
    if (Number.isFinite(Number(settings.megapixels)) && Object.hasOwn(node.inputs ?? {}, 'megapixels')) {
      patch[`${id}.megapixels`] = Number(settings.megapixels);
    }
  }
}

function patchUpscalerScale(prompt, upscalerId, upscaler, factor, patch) {
  const scale = upscaler.inputs?.scale;
  if (typeof scale === 'number') {
    patch[`${upscalerId}.scale`] = factor;
    return;
  }
  const sourceId = linkedSourceId(scale);
  const source = sourceId === null ? undefined : prompt[sourceId];
  const numeric = source === undefined
    ? null
    : Object.entries(source.inputs ?? {}).find(([, value]) => typeof value === 'number');
  if (sourceId === null || numeric === undefined || numeric === null) {
    throw new Error('the configured upscale workflow has no editable numeric scale input; refusing to run at an unknown factor');
  }
  patch[`${sourceId}.${numeric[0]}`] = factor;
}

/**
 * Patch the VOSR2 video chain for one deterministic output size.
 *
 * The graph's contract is: long-side resize -> TESpeedVOSR2Video(scale). We keep the model
 * scale at 2 and set the resize node to targetLongSide / 2. ImageScaleToMaxDimension is the
 * core node so the same workflow runs on a local install without the optional Apt preset.
 * This is intentionally different from image upscale, where x2/x3/x4 is meaningful relative
 * to the source pixels.
 */
export function prepareVideoUpscaleTarget(prompt, targetResolution) {
  const target = normalizeVideoUpscaleTarget(targetResolution);
  const definition = VIDEO_UPSCALE_TARGETS[target];
  const upscalerEntry = Object.entries(prompt).find(([, node]) => /TESpeedVOSR2Video/iu.test(String(node.class_type ?? '')));
  if (upscalerEntry === undefined) {
    throw new Error('视频超分工作流没有 TESpeedVOSR2Video；请选择“VOSR2-视频放大”专用工作流');
  }
  const [upscalerId, upscaler] = upscalerEntry;
  const resize = findUpstreamNode(
    prompt,
    upscaler.inputs?.images,
    (node) => /ImageScaleToMaxDimension|Image_Resize_longsize/iu.test(String(node.class_type ?? '')),
  );
  if (resize === null) {
    throw new Error('视频超分工作流缺少 ImageScaleToMaxDimension（或旧版 Image_Resize_longsize）；无法用目标清晰度控制最终尺寸');
  }
  const preResizeLongSide = definition.longSide / VIDEO_UPSCALE_SCALE;
  if (!Number.isInteger(preResizeLongSide) || preResizeLongSide < 64) {
    throw new Error(`视频超分目标 ${target} 无法换算为整数预缩放尺寸`);
  }
  const patch = {};
  const sizeInput = /ImageScaleToMaxDimension/iu.test(String(resize.node.class_type ?? ''))
    ? 'largest_size'
    : 'size';
  const size = resize.node.inputs?.[sizeInput];
  if (typeof size === 'number') {
    patch[`${resize.id}.${sizeInput}`] = preResizeLongSide;
  } else {
    const sourceId = linkedSourceId(size);
    const source = sourceId === null ? undefined : prompt[sourceId];
    const numeric = source === undefined
      ? null
      : Object.entries(source.inputs ?? {}).find(([, value]) => typeof value === 'number');
    if (sourceId === null || numeric === undefined || numeric === null) {
      throw new Error('视频超分工作流的 long-side resize 没有可编辑的数值输入');
    }
    patch[`${sourceId}.${numeric[0]}`] = preResizeLongSide;
  }
  patchUpscalerScale(prompt, upscalerId, upscaler, VIDEO_UPSCALE_SCALE, patch);
  return {
    patch,
    targetResolution: target,
    targetLongSide: definition.longSide,
    preResizeLongSide,
    scale: VIDEO_UPSCALE_SCALE,
    resizeNodeId: resize.id,
    upscalerNodeId: upscalerId,
  };
}

function patchGeneralOutputPrefix(prompt, prefix, patch) {
  if (typeof prefix !== 'string' || prefix.trim().length === 0) return;
  for (const [id, node] of Object.entries(prompt)) {
    if (!/SaveImage|SaveVideo|VHS_VideoCombine/iu.test(String(node.class_type ?? ''))) continue;
    if (typeof node.inputs?.filename_prefix !== 'string') continue;
    patch[`${id}.filename_prefix`] = prefix.trim();
  }
}

function nodesInsideGroup(graph, group) {
  const [x, y, width, height] = group?.bounding ?? [];
  if (![x, y, width, height].every((value) => typeof value === 'number')) return [];
  return (graph.nodes ?? []).filter((node) => {
    const [nx, ny] = node.pos ?? [];
    return typeof nx === 'number' && typeof ny === 'number'
      && nx >= x && nx <= x + width && ny >= y && ny <= y + height;
  });
}

/**
 * Select the saved branch a general task is meant to run.
 *
 * A combined workflow can contain image and video upscalers side by side, and the Qwen edit
 * workflow keeps image-2..image-8 in separate groups. The visible node mode is therefore part
 * of the request, not a persistent user setting: a video upscale must activate the video branch
 * even if the saved canvas was left on the image branch. Groups are used because they survive
 * node-id changes when the user re-saves the workflow.
 */
export function prepareGeneralWorkflowGraph(graph, { task, mediaPaths = [] } = {}) {
  const next = structuredClone(graph);
  const imageCount = Array.isArray(mediaPaths) ? mediaPaths.length : 0;
  if (task === 'upscale-image' || task === 'upscale-video') {
    const imageGroup = /图像.*(?:放大|超分)|image.*(?:upscale|upscaler)/iu;
    const videoGroup = /视频.*(?:放大|超分)|video.*(?:upscale|upscaler)/iu;
    const groups = next.groups ?? [];
    const selected = task === 'upscale-video' ? videoGroup : imageGroup;
    const rejected = task === 'upscale-video' ? imageGroup : videoGroup;
    const hasShape = groups.some((group) => selected.test(String(group.title ?? '')));
    if (!hasShape && groups.some((group) => rejected.test(String(group.title ?? '')))) {
      throw new Error(`the configured upscale workflow has no ${task === 'upscale-video' ? 'video' : 'image'} group; choose the workflow that contains that branch`);
    }
    for (const group of groups) {
      const title = String(group.title ?? '');
      const wanted = selected.test(title) ? 0 : rejected.test(title) ? 4 : null;
      if (wanted === null) continue;
      for (const node of nodesInsideGroup(next, group)) node.mode = wanted;
    }
  }
  if (task === 'image-edit') {
    for (const group of next.groups ?? []) {
      const match = /^image-(\d+)$/iu.exec(String(group.title ?? '').trim());
      if (match === null) continue;
      const index = Number(match[1]);
      const wanted = index <= imageCount ? 0 : 4;
      for (const node of nodesInsideGroup(next, group)) node.mode = wanted;
    }
  }
  return next;
}

/**
 * Bind the general panel's task form to a converted graph.
 *
 * This intentionally discovers prompt, image and upscaler nodes from the graph instead of
 * relying on ids copied from the author's canvas. The caller still supplies only task-facing
 * values (prompt, media paths, ratio, scale); no raw node id is exposed in the UI.
 */
export function prepareGeneralPrompt(prompt, objectInfo, {
  task,
  promptText = '',
  mediaPaths = [],
  settings = {},
  preservePromptWhitespace = false,
} = {}) {
  const patch = {};
  const inputs = {};
  const mediaInputs = [];
  const media = Array.isArray(mediaPaths) ? mediaPaths.filter((value) => typeof value === 'string' && value.length > 0) : [];
  const sourceText = String(promptText ?? '');
  const text = sourceText.trim();
  const seed = Number.isInteger(settings?.seed) ? settings.seed : newGenerationSeed();
  const seedTargets = ['text-to-image', 'image-edit'].includes(task)
    ? patchSeedInputs(prompt, patch, seed)
    : [];

  if (task === 'text-to-image') {
    if (text.length === 0) throw new Error('文生图需要提示词');
    const source = findPromptSourceForSampler(prompt);
    if (source === null) throw new Error('the configured text-to-image workflow has no active editable prompt node');
    setPromptNodeText(prompt, source.id, source.node, text, patch);
    patchGeneralResolution(prompt, settings, patch);
    patchGeneralOutputPrefix(prompt, settings.filenamePrefix, patch);
    return { patch, inputs, mediaInputs, promptNodeId: source.id, seed, seedTargets };
  }

  if (task === 'image-edit') {
    if (text.length === 0) throw new Error('图片编辑需要提示词');
    if (media.length === 0) throw new Error('图片编辑需要至少一张参考图');
    const encoder = Object.entries(prompt).find(([, node]) => /TextEncodeQwenImage21/iu.test(String(node.class_type ?? '')));
    if (encoder === undefined) {
      throw new Error('the configured image-edit workflow has no active TextEncodeQwenImage21; choose the Qwen Image 2.1 edit workflow');
    }
    const [encoderId, encoderNode] = encoder;
    const promptForNode = preservePromptWhitespace ? sourceText : text;
    const source = findUpstreamNode(prompt, encoderNode.inputs?.prompt, (node) => promptInputName(node) !== null);
    if (source !== null) {
      setPromptNodeText(prompt, source.id, source.node, promptForNode, patch);
    } else {
      setPromptNodeText(prompt, encoderId, encoderNode, promptForNode, patch);
    }
    const slots = Object.keys(encoderNode.inputs ?? {})
      .map((name) => ({ name, match: /^images\.image_(\d+)$/u.exec(name) }))
      .filter((entry) => entry.match !== null)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    if (slots.length < media.length) {
      throw new Error(`the configured image-edit workflow has ${slots.length} usable image slot(s), but ${media.length} were supplied`);
    }
    for (let index = 0; index < media.length; index += 1) {
      const slot = slots[index];
      const loader = findUpstreamNode(
        prompt,
        encoderNode.inputs?.[slot.name],
        (node) => /LoadImage/iu.test(String(node.class_type ?? '')) && typeof node.inputs?.image === 'string',
      );
      if (loader === null) {
        throw new Error(`image slot ${slot.name} has no active LoadImage; activate that reference group in the saved workflow`);
      }
      inputs[loader.id] = media[index];
    }
    for (const [id, node] of Object.entries(prompt)) {
      if (/ComfySwitchNode/iu.test(String(node.class_type ?? '')) && typeof node.inputs?.switch === 'boolean') {
        const useReferenceCanvas = typeof settings?.aspectRatio !== 'string' || settings.aspectRatio.trim().length === 0;
        patch[`${id}.switch`] = qwenEditSwitchSetting(node, encoderId, {
          useReferenceCanvas,
          fallback: !useReferenceCanvas,
        });
      }
    }
    patchGeneralResolution(prompt, settings, patch);
    patchGeneralOutputPrefix(prompt, settings.filenamePrefix, patch);
    return { patch, inputs, mediaInputs, promptNodeId: source?.id ?? encoderId, imageCount: media.length, seed, seedTargets };
  }

  if (task === 'upscale-image') {
    if (media.length !== 1) throw new Error('图像超分需要且只能上传一张图片');
    const upscaler = Object.entries(prompt).find(([, node]) => /TESpeedVOSR2Image|SeedVR2|ImageUpscaleWithModel/iu.test(String(node.class_type ?? '')));
    if (upscaler === undefined) throw new Error('the configured image-upscale workflow has no active image upscaler');
    const [upscalerId, upscalerNode] = upscaler;
    const loader = findUpstreamNode(
      prompt,
      upscalerNode.inputs?.images ?? upscalerNode.inputs?.image,
      (node) => /LoadImage/iu.test(String(node.class_type ?? '')) && typeof node.inputs?.image === 'string',
    );
    if (loader === null) throw new Error('the configured image-upscale workflow has no active LoadImage connected to its upscaler');
    inputs[loader.id] = media[0];
    patchUpscalerScale(prompt, upscalerId, upscalerNode, Number(settings.scale ?? 3), patch);
    patchGeneralOutputPrefix(prompt, settings.filenamePrefix, patch);
    return { patch, inputs, mediaInputs, imageNodeId: loader.id, upscalerNodeId: upscalerId };
  }

  if (task === 'upscale-video') {
    if (media.length !== 1) throw new Error('视频超分需要且只能上传一段视频');
    const upscaler = Object.entries(prompt).find(([, node]) => /TESpeedVOSR2Video/iu.test(String(node.class_type ?? '')));
    if (upscaler === undefined) throw new Error('the configured video-upscale workflow has no active TESpeedVOSR2Video node');
    const [upscalerId, upscalerNode] = upscaler;
    const loader = findUpstreamNode(
      prompt,
      upscalerNode.inputs?.images,
      (node) => /VHS_LoadVideo|LoadVideo/iu.test(String(node.class_type ?? '')) && typeof node.inputs?.video === 'string',
    );
    if (loader === null) throw new Error('the configured video-upscale workflow has no active video loader connected to its upscaler');
    mediaInputs.push({ nodeId: loader.id, input: 'video', filePath: media[0], kind: 'video' });
    const target = prepareVideoUpscaleTarget(prompt, settings.targetResolution);
    Object.assign(patch, target.patch);
    patchGeneralOutputPrefix(prompt, settings.filenamePrefix, patch);
    return { patch, inputs, mediaInputs, videoNodeId: loader.id, upscalerNodeId: upscalerId, upscaleTarget: target };
  }

  if (task === 'video-generation') {
    throw new Error('H3 视频生成由视频工作流单独处理');
  }
  throw new Error(`unknown general generation task: ${String(task ?? '')}`);
}

/**
 * Apply an explicit image-edit prompt mode to a direct `comfy_run` call.
 *
 * The panel and the conversation tool must not each invent their own prompt policy. The
 * default asks the current session model for the Qwen-Image-2.1 edit contract; `raw` sends
 * the caller's text to the workflow without trimming, wrapping, or replacing `<imageN>` tags.
 * This runs before uploads or queue submission, so a failed conversion costs no GPU work.
 */
export async function prepareDirectImageEditPrompt(prompt, args, {
  ctx = null,
  modelRoute = null,
  sessionId = null,
  signal = null,
  exec = null,
} = {}) {
  if (args?.task !== 'image-edit'
    || args.generalGeneration !== undefined
    || args.characterQuadview !== undefined
    || args.patch === null
    || typeof args.patch !== 'object'
    || Array.isArray(args.patch)) {
    return null;
  }
  const encoder = Object.entries(prompt).find(([, node]) => /TextEncodeQwenImage21/iu.test(String(node.class_type ?? '')));
  if (encoder === undefined) return null;
  const [encoderId, encoderNode] = encoder;
  const source = findUpstreamNode(prompt, encoderNode.inputs?.prompt, (node) => promptInputName(node) !== null);
  const sourceInput = source === null ? null : promptInputName(source.node);
  const candidates = [
    ...(source === null || sourceInput === null ? [] : [`${source.id}.${sourceInput}`]),
    ...Object.keys(encoderNode.inputs ?? {})
      .filter((name) => typeof encoderNode.inputs[name] === 'string')
      .map((name) => `${encoderId}.${name}`),
  ];
  const promptKey = candidates.find((key) => typeof args.patch[key] === 'string' && args.patch[key].trim().length > 0);
  if (promptKey === undefined) return null;
  const inputCount = Object.keys(args.inputs ?? {}).length
    + (Array.isArray(args.mediaInputs) ? args.mediaInputs.filter((entry) => entry?.kind === 'image').length : 0);
  const imageCount = Math.max(1, inputCount);
  const promptMode = typeof args.promptMode === 'string' && args.promptMode.trim().length > 0
    ? args.promptMode.trim()
    : 'qwen-official';
  if (promptMode !== 'qwen-official' && promptMode !== 'raw') {
    throw new Error(`未知的图片编辑提示词处理方式：${promptMode}`);
  }
  if (promptMode === 'raw') {
    return {
      patch: { ...args.patch },
      imageCount,
      promptNodeId: source?.id ?? encoderId,
      promptRewrite: null,
      promptMode,
    };
  }
  const imagePaths = [
    ...Object.values(args.inputs ?? {}).filter((value) => typeof value === 'string'),
    ...(Array.isArray(args.mediaInputs) ? args.mediaInputs.filter((entry) => entry?.kind === 'image').map((entry) => entry.filePath) : []),
  ];
  const images = [];
  const references = [];
  for (const filePath of imagePaths) {
    const absolute = resolvePath(filePath, exec);
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      const error = new Error(`无法读取图片编辑参考图：${absolute}；原提示词已保留，未提交工作流`);
      error.code = 'QWEN_EDIT_IMAGES_REQUIRED';
      throw error;
    }
    images.push({
      data: bytes,
      mediaType: mediaTypeFor(absolute),
      fileName: basename(absolute),
    });
    references.push({ fileName: basename(absolute) });
  }
  const requestedAspectRatio = Object.entries(args.patch)
    .find(([key, value]) => /\.aspect_ratio$/u.test(key) && typeof value === 'string')?.[1] ?? '';
  const promptRewrite = await convertQwenEditPrompt(args.patch[promptKey], {
    imageCount,
    aspectRatio: requestedAspectRatio,
    references,
    images,
    ctx,
    modelRoute,
    sessionId,
    signal,
  });
  const automatic = {};
  for (const [id, node] of Object.entries(prompt)) {
    if (/ComfySwitchNode/iu.test(String(node.class_type ?? '')) && typeof node.inputs?.switch === 'boolean') {
      const useReferenceCanvas = promptRewrite.wh_ratio.length === 0;
      automatic[`${id}.switch`] = qwenEditSwitchSetting(node, encoderId, {
        useReferenceCanvas,
        fallback: !useReferenceCanvas,
      });
    }
    if (promptRewrite.wh_ratio.length > 0
      && /ResolutionSelector/iu.test(String(node.class_type ?? ''))
      && Object.hasOwn(node.inputs ?? {}, 'aspect_ratio')) {
      automatic[`${id}.aspect_ratio`] = promptRewrite.wh_ratio;
    }
  }
  return {
    patch: { ...automatic, ...args.patch, [promptKey]: promptRewrite.rewritten_prompt },
    imageCount,
    promptNodeId: source?.id ?? encoderId,
    promptRewrite,
    promptMode,
  };
}

function sessionModelRoute(exec) {
  try {
    return exec?.agent?.session?.requestHeader?.()?.config ?? null;
  } catch {
    return null;
  }
}

/** True when the file exists and is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * `comfy_inventory` — is there a usable ComfyUI, and what can it generate with.
 */
export function comfyInventoryTool(config) {
  return defineTool({
    name: 'comfy_inventory',
    description: 'Detect a usable ComfyUI instance and report what it can run. Probes the configured and candidate addresses, and reports GPU, queue depth, node-class count and the model files the asset workflows select from. Use it before promising any image or video generation. It also searches this machine for a local ComfyUI install (portable, source or an integrated package) and for a deployment package, and says WHERE it found each one and why that path was chosen - never assume a location, read it from this report.',
    parameters: {
      base_url: {
        type: 'string',
        description: 'Exact instance to probe, for example http://127.0.0.1:8188 or an SSH-tunnel address. Omit to probe the configured address and the default local ports.',
      },
      inventory: {
        type: 'boolean',
        description: 'Also list available model files. Slower; use it when choosing checkpoints, LoRAs or upscale bundles.',
        default: false,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                baseUrl: { type: 'string', required: true },
                reachable: { type: 'boolean', required: true },
                comfyuiVersion: { type: 'string' },
                os: { type: 'string' },
                error: { type: 'string' },
                queueRunning: { type: 'integer' },
                queuePending: { type: 'integer' },
                devices: { type: 'array', items: { type: 'string' } },
                models: { type: 'json' },
              },
            },
          },
          usable: { type: 'string', description: 'The first reachable instance, or an empty string.' },
          localInstall: { type: 'json', description: 'The configured path HINTS (null when unset). Not the answer to "is ComfyUI installed" - read `discovered` for that.' },
          discovered: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                layout: { type: 'string' },
                source: { type: 'string' },
                workflowsDir: { type: 'string' },
              },
            },
            description: 'ComfyUI installs found on disk by discovery, best first: local package or portable build, where it is, how it was found, and its workflow folder.',
          },
        },
      },
      render: (_args, value) => {
        const lines = [];
        for (const candidate of value.candidates) {
          if (!candidate.reachable) {
            lines.push(`${candidate.baseUrl} — unreachable (${candidate.error ?? 'no response'})`);
            continue;
          }
          lines.push(`${candidate.baseUrl} — ComfyUI ${candidate.comfyuiVersion ?? '?'} on ${candidate.os ?? '?'}; queue ${candidate.queueRunning ?? 0} running / ${candidate.queuePending ?? 0} pending; ${(candidate.devices ?? []).join('; ') || 'no device info'}`);
          if (candidate.models !== undefined && candidate.models !== null) {
            for (const [key, files] of Object.entries(candidate.models)) {
              lines.push(`  ${key}: ${Array.isArray(files) ? `${files.length} file(s)` : String(files)}`);
            }
          }
        }
        const local = value.localInstall ?? {};
        const discovered = value.discovered ?? [];
        if (discovered.length === 0) {
          lines.push('local install: none discovered on disk (configured hints: ' +
            [local.comfyuiPortablePath, local.deployPackPath, local.cloudPatchPackPath].filter(Boolean).join(', ') || 'none' + ')');
        } else {
          lines.push(`local install: ${discovered.length} found`);
          for (const install of discovered) {
            lines.push(`  [${install.layout ?? '?'}] ${install.path}${install.workflowsDir === null || install.workflowsDir === undefined ? '' : ` · workflows: ${install.workflowsDir}`}${install.source ? ` (${install.source})` : ''}`);
          }
        }
        lines.push(value.usable.length > 0 ? `usable: ${value.usable}` : 'usable: none — no ComfyUI is reachable');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const targets = typeof args.base_url === 'string' && args.base_url.trim().length > 0
        ? [args.base_url.trim()]
        : defaultCandidates(config);
      if (targets.length === 0) throw new Error('no ComfyUI address to probe: this plugin has no configured comfyBaseUrl and no local ports');
      const candidates = [];
      for (const target of targets) {
        const report = await probeEndpoint(target, { signal: exec.signal, inventory: args.inventory === true });
        candidates.push({
          baseUrl: report.baseUrl,
          reachable: report.reachable,
          ...report.comfyuiVersion === undefined || report.comfyuiVersion === null ? {} : { comfyuiVersion: String(report.comfyuiVersion) },
          ...report.os === undefined || report.os === null ? {} : { os: String(report.os) },
          ...report.error === undefined ? {} : { error: report.error },
          ...report.queue === null || report.queue === undefined ? {} : { queueRunning: report.queue.running, queuePending: report.queue.pending },
          ...report.devices === undefined ? {} : { devices: report.devices.map((device) => `${device.name} (${device.vramFreeGb ?? '?'}GB free of ${device.vramTotalGb ?? '?'}GB)`) },
          ...report.inventory === undefined ? {} : { models: report.inventory.models },
        });
      }
      // Discovery, not the config values. This block used to report the three configured path
      // settings, so on a machine with nothing configured it printed `not found` three times -
      // telling a user who had three working installs that none existed. The config fields are
      // HINTS for discovery, never the answer.
      const discovery = await discoverInstallations(config, { statePath: statePath() }).catch(() => ({ installs: [], inspected: [], hints: [] }));
      const localInstall = {
        // Kept for callers that already read these keys: the configured hint, or null.
        comfyuiPortablePath: config.comfyuiPortablePath?.trim() ? config.comfyuiPortablePath.trim() : null,
        deployPackPath: config.deployPackPath?.trim() ? config.deployPackPath.trim() : null,
        cloudPatchPackPath: config.cloudPatchPackPath?.trim() ? config.cloudPatchPackPath.trim() : null,
      };
      const discovered = (discovery.installs ?? []).map((install) => ({
        path: install.path,
        layout: install.layout,
        source: install.source ?? null,
        workflowsDir: install.workflowRoot ?? null,
      }));
      const usable = candidates.find((candidate) => candidate.reachable)?.baseUrl ?? '';
      return { candidates, usable, localInstall, discovered };
    },
  });
}

/**
 * `comfy_graph` — inspect a saved workflow and preview the exact inputs to patch.
 */
export function comfyGraphTool(config) {
  return defineTool({
    name: 'comfy_graph',
    description: 'Read a saved ComfyUI workflow JSON and list the nodes and patchable inputs, so a generation can be queued without exporting the workflow manually. Accepts the UI workflow files in the ComfyUI user/workflows directory. Report the node ids you intend to patch and pass them to comfy_run as patch entries.',
    parameters: {
      workflow: {
        type: 'string',
        description: 'Path to the workflow JSON, or a bare file name to resolve inside the configured ComfyUI workflows directory.',
      },
      base_url: {
        type: 'string',
        description: 'Instance whose /object_info supplies node widget names. When omitted, the same instance chooser comfy_run uses picks one (cloud first); pass an address to force a specific instance.',
      },
      node_class: {
        type: 'string',
        description: 'Only list nodes of this class type.',
      },
      include_all_inputs: {
        type: 'boolean',
        description: 'List every input rather than only text, image, size, seed, step, scale, sampler and filename inputs.',
        default: false,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workflow: { type: 'string', required: true },
          baseUrl: { type: 'string', required: true },
          nodeCount: { type: 'integer', required: true },
          skipped: { type: 'json' },
          notes: { type: 'array', items: { type: 'string' } },
          nodes: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `${value.workflow} -> ${value.nodeCount} nodes against ${value.baseUrl}`,
        ];
        if (Array.isArray(value.skipped) && value.skipped.length > 0) {
          lines.push(`skipped ${value.skipped.length} node(s): ${value.skipped.slice(0, 8).map((entry) => `${entry.id}:${entry.type}${entry.reason === undefined ? `(mode ${entry.mode})` : `(${entry.reason})`}`).join(', ')}`);
        }
        for (const node of value.nodes ?? []) {
          const inputs = Object.entries(node.inputs ?? {}).map(([name, val]) => `${name}=${typeof val === 'string' && val.length > 60 ? `${val.slice(0, 60)}…` : JSON.stringify(val)}`);
          lines.push(`#${node.id} ${node.classType}${node.title === null || node.title === undefined ? '' : ` "${node.title}"`}\n    ${inputs.join('\n    ')}`);
        }
        if (Array.isArray(value.notes) && value.notes.length > 0) {
          lines.push('notes:');
          for (const note of value.notes.slice(0, 12)) lines.push(`  - ${note}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Read the graph from whichever instance is preferred, so the node list
      // matches the machine the run will actually use.
      const chosen = await selectInstance(config, { baseUrl: args.base_url, prefer: config.preferInstance ?? 'auto', signal: exec.signal });
      const baseUrl = chosen.baseUrl;
      if (baseUrl === null || baseUrl.length === 0) throw new Error(`no ComfyUI instance is answering (${chosen.reason}). Start one with comfy_launch, then retry`);
      const path = await resolveWorkflowPath(args.workflow, config, exec);
      const graph = await loadGraph(path);
      const objectInfo = await objectInfoFor(baseUrl, exec.signal);
      const { prompt, skipped, notes } = uiGraphToPrompt(graph, { objectInfo });
      const summary = summarizePrompt(prompt);
      const nodes = args.include_all_inputs === true
        ? Object.entries(prompt).map(([id, node]) => ({ id: Number(id), classType: node.class_type, title: node._meta?.title ?? null, inputs: stripLinks(node.inputs) })).sort((a, b) => a.id - b.id)
        : summary.nodes;
      const filtered = args.node_class === undefined
        ? nodes
        : nodes.filter((node) => node.classType === args.node_class);
      return { workflow: path, baseUrl, nodeCount: summary.nodeCount, skipped, notes, nodes: filtered };
    },
  });
}

/** Replace link tuples with a readable marker for display. */
function stripLinks(inputs) {
  const out = {};
  for (const [name, value] of Object.entries(inputs ?? {})) {
    out[name] = Array.isArray(value) ? `<- node ${value[0]}` : (typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value);
  }
  return out;
}

/** Resolve a workflow argument to an absolute file path. */
async function resolveWorkflowPath(workflow, config, exec) {
  const raw = String(workflow ?? '').trim();
  if (raw.length === 0) throw new Error('a workflow file is required');
  const candidates = [];
  if (isAbsolute(raw)) candidates.push(raw);
  else {
    candidates.push(resolvePath(raw, exec));
    // Derive the folder from the ComfyUI this machine runs, so a bare file name resolves
    // without the user configuring anything (see env-discovery).
    const derived = await resolveWorkflowsDir(config);
    if (derived.dir !== null) candidates.push(join(derived.dir, raw));
    if (typeof config.workflowsDir === 'string' && config.workflowsDir.trim().length > 0) candidates.push(join(config.workflowsDir.trim(), raw));
  }
  if (extname(raw).length === 0) {
    for (const candidate of [...candidates]) candidates.push(`${candidate}.json`);
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(`workflow not found: tried ${candidates.join(', ')}`);
}

/**
 * `comfy_run` — upload inputs, patch the graph, queue it, wait, and save outputs.
 */
export function comfyRunTool(config) {
  return defineTool({
    name: 'comfy_run',
    description: 'Queue one ComfyUI workflow and bring the results back into the project. Uploads any input images, applies graph patches by node id or node title, waits for the run to finish, then copies every produced image or video into the output directory. Returns the local file paths; read them with read_image or present them so the user can review. This is the only tool that submits generation work.',
    parameters: {
      workflow: {
        type: 'string',
        description: 'Workflow JSON path, or a bare file name resolved inside the configured ComfyUI workflows directory.',
      },
      task: {
        type: 'string',
        enum: ['text-to-image', 'image-edit', 'upscale-image', 'upscale-video'],
        description: 'Use the workflow configured for this task in the storyboard global configuration when `workflow` is omitted. The chosen local/cloud workflow follows the instance that will run the job.',
      },
      promptMode: {
        type: 'string',
        enum: ['qwen-official', 'raw'],
        description: 'For task=image-edit: qwen-official (default) sends every bound reference image to the current vision-capable session model and rewrites the text into the Qwen-Image-2.1 edit contract; raw sends the supplied prompt byte-for-byte with no model, wrapper, or <imageN> replacement.',
      },
      output: {
        type: 'string',
        description: 'Directory to save the produced files into. Create the target asset or episode folder first, for example 资产/人物资产/男主.',
      },
      base_url: {
        type: 'string',
        description: 'Instance to queue on. Leave unset and the plugin picks one itself: with both the local and the cloud instance running it chooses the cloud, because the cloud GPU finishes the same job several times faster and keeps the local card free. Pass an address only to force a specific instance.',
      },
      prefer: {
        type: 'string',
        enum: ['auto', 'cloud', 'local'],
        description: 'Which instance to prefer when several answer. auto (default) picks the cloud; cloud or local forces one. Ignored when base_url is given. If the user says the cloud is busy, expensive, or unavailable, pass local.',
      },
      patch: {
        type: 'json',
        description: 'Input overrides keyed "<nodeId|nodeTitle>.<inputName>", for example {"5.text":"...", "9.width":1080, "7.seed":12345}. Use comfy_graph first to read the exact ids and input names.',
      },
      seed: {
        type: 'integer',
        description: 'Optional seed for image generation. General image tasks and character four-view generation also inject a random seed automatically into every active seed/noise_seed input; pass this only when the user asked to reproduce a specific seed.',
      },
      inputs: {
        type: 'json',
        description: 'Images to upload and bind, keyed by the node id of a LoadImage node. The value is an absolute path on THIS machine, for example {"475":"<absolute path to the reference image>"} - read it from the asset library or the user\'s message, never assume a directory layout. Files are uploaded with their own base name.',
      },
      mediaInputs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeId: { type: 'string', required: true },
            input: { type: 'string', required: true, description: 'Plain string media input on that node, such as "video" for VHS_LoadVideo or "image" for LoadImage.' },
            filePath: { type: 'string', required: true },
            kind: { type: 'string', enum: ['image', 'video', 'audio'], required: true },
          },
        },
        description: 'Generic media uploads for non-image nodes. Use this for VHS_LoadVideo.video, LoadAudio.audio, or a specific media input that is not the conventional LoadImage.image slot.',
      },
      filename_prefix: {
        type: 'json',
        description: 'Filename prefixes to set, keyed the same way as patch but only for filename_prefix inputs, for example {"1":"男主"}. Applied after patch.',
      },
      name: {
        type: 'string',
        description: 'Short label for this run, used in the reply and in the saved-file names.',
      },
      requestId: {
        type: 'string',
        description: 'A stable id for THIS plan, so repeating the call cannot start a second run. Pass the same value when retrying after a double click or a lost reply; the same id with a different plan is refused. Omitting it makes the call one-shot, which suits an interactive run and is wrong for anything that might be retried.',
      },
      resultsProjectRoot: {
        type: 'string',
        description: 'Absolute path of the short-drama project this run belongs to. When given, every produced file is also recorded as a CANDIDATE under <root>/.director/results, so a generation does not become the version in use until someone selects it. Leave unset for general image work that belongs to no project.',
      },
      episodeNumber: {
        type: 'integer',
        description: 'For a short-drama run: which episode this belongs to, so the recorded candidate can be named 项目名_第N集_大分镜M（第k次） instead of the instance\'s opaque output name.',
      },
      blockNumber: {
        type: 'integer',
        description: 'For a short-drama run: which 大分镜 (block) this belongs to, for the same candidate naming.',
      },
      jobId: {
        type: 'string',
        description: 'Attach this run to an existing ledger entry instead of creating one. Use it when resuming a job whose submission outcome was never confirmed, AFTER checking the instance queue.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'How long to wait for the run before reporting it as still running. Defaults to the plugin setting.',
        default: 900000,
      },
      copy_as: {
        type: 'json',
        description: 'Rename map for the saved files, keyed by the produced file name, for example {"ComfyUI_00001_.png":"男主（军装造型）四视图.png"}. Use it to store assets under their asset name.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          promptId: { type: 'string', required: true },
          baseUrl: { type: 'string', required: true },
          // Present when the answer is an EARLIER run of the same requestId instead of a fresh one.
          // Repeating a request must be harmless, so the recorded job comes back rather than a second
          // submission - and the reply has to be allowed to say which of the two happened.
          jobId: { type: 'string' },
          reused: { type: 'boolean' },
          workflow: { type: 'string', required: true },
          state: { type: 'string', required: true },
          elapsed: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                remoteName: { type: 'string', required: true },
              },
            },
          },
          applied: { type: 'json' },
          failed: { type: 'json' },
          warnings: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          workflowAdaptation: { type: 'json' },
          // Present when `resultsProjectRoot` was given: the produced files are also recorded as CANDIDATES,
          // so a generation is not "the version in use" until somebody selects one. Without this property the
          // schema rejects the tool's own output (`additionalProperties: false`), so a run that DID produce a
          // video reported itself as an invalid result - the files were on disk and the reply said nothing.
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                candidateId: { type: 'string', required: true },
                fileName: { type: 'string', required: true },
                status: { type: 'string', required: true },
                duplicate: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `${value.state} — ${value.workflow} on ${value.baseUrl} in ${value.elapsed} (prompt ${value.promptId})`,
        ];
        for (const file of value.files) lines.push(`  ${file.kind}: ${file.path} (${Math.round(file.bytes / 1024)}KB, from ${file.remoteName})`);
        if (value.files.length === 0) lines.push('  no output files');
        if (Array.isArray(value.applied) && value.applied.length > 0) {
          lines.push(`patched ${value.applied.length} input(s): ${value.applied.map((entry) => `${entry.node}.${entry.input}`).join(', ')}`);
        }
        for (const warning of value.warnings ?? []) lines.push(`warning: ${warning}`);
        for (const error of value.errors ?? []) lines.push(`error: ${error}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) { return runComfyWorkflow(config, args, exec); }
  });
}

/** Shared submission path for the sidebar and comfy_run. */
export async function runComfyWorkflow(config, args, exec, { preparedGraph = null } = {}) {
      const io = runnerIo(config, exec);
      // Resolve the caller's output boundary before anything is uploaded or queued. A read-only
      // or out-of-workspace target must fail here: discovering it after submit spends GPU time
      // and leaves a running job whose result can never be saved.
      const outputDir = args.output === undefined ? undefined : resolvePath(args.output, exec);
      if (outputDir !== undefined) await io.ensureDir(outputDir);
      let configuredEndpoint = null;
      if ((typeof args.base_url !== 'string' || args.base_url.length === 0)
        && typeof args.prefer !== 'string'
        && typeof args.task === 'string') {
        const { resolveConfiguredEndpoint } = await import('./generation-config.js');
        configuredEndpoint = await resolveConfiguredEndpoint(args.task, { config });
      }
      // Pick the instance before anything else: with both up the cloud wins, so a
      // caller that says nothing still gets the faster GPU.
      const chosen = await selectInstance(config, {
        baseUrl: args.base_url,
        prefer: configuredEndpoint ?? args.prefer ?? config.preferInstance ?? 'auto',
        signal: exec.signal,
      });
      const baseUrl = chosen.baseUrl;
      if (baseUrl === null || baseUrl.length === 0) {
        throw new Error(`no ComfyUI instance is answering (${chosen.reason}). Start one with comfy_launch, then retry`);
      }
      if (configuredEndpoint !== null && chosen.kind !== configuredEndpoint) {
        throw new Error(`this task is configured to run on ${configuredEndpoint}, but the reachable instance is ${chosen.kind}. Start the configured instance or change 全局配置`);
      }
      let workflowArg = args.workflow;
      if ((typeof workflowArg !== 'string' || workflowArg.trim().length === 0) && typeof args.task === 'string') {
        const { resolveConfiguredWorkflow } = await import('./generation-config.js');
        const kind = chosen.kind === 'cloud' ? 'cloud' : 'local';
        workflowArg = await resolveConfiguredWorkflow(config, args.task, kind) ?? undefined;
        if (workflowArg === undefined) {
          throw new Error(`no ${args.task} workflow is configured for the ${kind} ComfyUI. Open 全局配置 in the storyboard panel and choose one, or pass workflow explicitly`);
        }
      }
      if (typeof workflowArg !== 'string' || workflowArg.trim().length === 0) {
        throw new Error('comfy_run needs workflow, or task with a workflow configured in 全局配置');
      }
      const workflowPath = await resolveWorkflowPath(workflowArg, config, exec);
      let graph = preparedGraph ?? await loadGraph(workflowPath);
      if (args.generalGeneration !== undefined && args.generalGeneration !== null) {
        graph = prepareGeneralWorkflowGraph(graph, args.generalGeneration);
      } else if (args.upscaleImage !== undefined && args.upscaleImage !== null) {
        graph = prepareGeneralWorkflowGraph(graph, {
          task: 'upscale-image',
          mediaPaths: [args.upscaleImage.sourcePath],
        });
      } else if (args.characterQuadview !== undefined && args.characterQuadview !== null) {
        graph = prepareGeneralWorkflowGraph(graph, {
          task: 'image-edit',
          mediaPaths: [args.characterQuadview.referenceImage],
        });
      }
      let objectInfo = await objectInfoFor(baseUrl, exec.signal);
      const convert = () => {
        const result = uiGraphToPrompt(graph, { objectInfo });
        // Helper nodes can reach the API with a required input empty; fill declared
        // defaults so the instance does not reject the whole submission.
        result.notes.push(...applyRequiredDefaults(result.prompt, objectInfo));
        return result;
      };
      let converted = convert();
      if (missingActiveNodeClasses(converted).length > 0) {
        // A custom node may have been installed while ComfyUI was restarting and this Host was
        // still running. Re-read the live capability map before telling the user it is absent.
        objectInfo = await objectInfoFor(baseUrl, exec.signal, { refresh: true });
        converted = convert();
      }
      const prompt = converted.prompt;
      const directImageEdit = await prepareDirectImageEditPrompt(prompt, args, {
        ctx: config.ctx ?? null,
        modelRoute: sessionModelRoute(exec),
        sessionId: exec?.agent?.session?.header?.id ?? null,
        signal: exec?.signal ?? null,
        exec,
      });
      if (directImageEdit !== null) {
        args = { ...args, patch: directImageEdit.patch };
      }
      let generalGeneration = null;
      let workflowAdaptation = null;
      if (args.generalGeneration !== undefined && args.generalGeneration !== null) {
        try {
          generalGeneration = prepareGeneralPrompt(prompt, objectInfo, args.generalGeneration);
        } catch (error) {
          if (!isWorkflowShapeError(error)) throw error;
          const task = args.generalGeneration.task;
          const generationSettings = args.generalGeneration.settings ?? {};
          const roleOverrides = {};
          if (task === 'upscale-image') {
            roleOverrides.scale = Number(generationSettings.scale ?? 3);
          } else if (task === 'upscale-video') {
            const targetResolution = normalizeVideoUpscaleTarget(generationSettings.targetResolution);
            const target = VIDEO_UPSCALE_TARGETS[targetResolution];
            roleOverrides.scale = 2;
            roleOverrides.longSide = Math.round(target.longSide / roleOverrides.scale);
          }
          let adapted;
          try {
            adapted = await adaptGeneralWorkflowWithModel({
              task,
              graph,
              prompt,
              objectInfo,
              promptText: args.generalGeneration.promptText ?? '',
              mediaPaths: args.generalGeneration.mediaPaths ?? [],
              settings: generationSettings,
              preservePromptWhitespace: args.generalGeneration.preservePromptWhitespace === true,
              roleOverrides,
              ctx: config.ctx ?? null,
              modelRoute: sessionModelRoute(exec),
              sessionId: exec?.agent?.session?.header?.id ?? null,
              signal: exec?.signal ?? null,
            });
          } catch (adaptError) {
            const failure = new Error(
              `工作流结构不兼容，当前会话模型也没有生成可验证的适配器。原错误：${String(error?.message ?? error)}；模型适配错误：${String(adaptError?.message ?? adaptError)}。未提交工作流`,
            );
            failure.code = 'WORKFLOW_ADAPTER_FAILED';
            failure.cause = adaptError;
            throw failure;
          }
          generalGeneration = adapted.result;
          if (task === 'upscale-video') {
            const targetResolution = normalizeVideoUpscaleTarget(generationSettings.targetResolution);
            const target = VIDEO_UPSCALE_TARGETS[targetResolution];
            generalGeneration.upscaleTarget = {
              targetResolution,
              targetLongSide: target.longSide,
              preResizeLongSide: roleOverrides.longSide,
              scale: roleOverrides.scale,
            };
          }
          workflowAdaptation = {
            adapterId: adapted.adapter.id,
            reason: adapted.adapter.reason,
            cached: adapted.cached,
            persistenceWarning: adapted.persistenceWarning,
          };
        }
        args = {
          ...args,
          patch: { ...generalGeneration.patch, ...(args.patch ?? {}) },
          inputs: { ...generalGeneration.inputs, ...(args.inputs ?? {}) },
          mediaInputs: [...(generalGeneration.mediaInputs ?? []), ...(Array.isArray(args.mediaInputs) ? args.mediaInputs : [])],
        };
      }
      let characterQuadview = null;
      if (args.characterQuadview !== undefined && args.characterQuadview !== null) {
        characterQuadview = prepareCharacterQuadviewPrompt(prompt, {
          ...args.characterQuadview,
          seed: Number.isInteger(args.seed) ? args.seed : args.characterQuadview.seed,
        });
        args = {
          ...args,
          patch: { ...characterQuadview.patch, ...(args.patch ?? {}) },
          inputs: { ...characterQuadview.inputs, ...(args.inputs ?? {}) },
        };
      }
      let imageUpscale = null;
      if (args.upscaleImage !== undefined && args.upscaleImage !== null) {
        imageUpscale = prepareImageUpscalePrompt(prompt, {
          sourceImage: args.upscaleImage.sourcePath,
          factor: args.upscaleImage.factor ?? 3,
          filenamePrefix: args.upscaleImage.filenamePrefix ?? null,
        });
        args = {
          ...args,
          patch: { ...imageUpscale.patch, ...(args.patch ?? {}) },
          inputs: { ...imageUpscale.inputs, ...(args.inputs ?? {}) },
        };
      }
      const imageTask = ['text-to-image', 'image-edit'].includes(args.task)
        || args.generalGeneration !== undefined
        || args.characterQuadview !== undefined;
      const hasSeedPatch = Object.keys(args.patch ?? {}).some((key) => /\.(?:seed|noise_seed)$/u.test(key));
      if (imageTask && !hasSeedPatch) {
        const automaticSeedPatch = {};
        const automaticSeed = newGenerationSeed();
        const targets = patchSeedInputs(prompt, automaticSeedPatch, automaticSeed);
        if (targets.length > 0) {
          args = { ...args, patch: { ...(args.patch ?? {}), ...automaticSeedPatch } };
        }
      }
      const warnings = [`running on the ${chosen.kind} instance ${baseUrl} (${chosen.reason})`];
      if (workflowAdaptation !== null) {
        warnings.push(`workflow adapter ${workflowAdaptation.adapterId} ${workflowAdaptation.cached ? 'reused' : 'created by the session model'}${workflowAdaptation.reason ? `: ${workflowAdaptation.reason}` : ''}`);
        if (workflowAdaptation.persistenceWarning) warnings.push(workflowAdaptation.persistenceWarning);
      }
      if (characterQuadview !== null) {
        warnings.push(`character four-view mode: image node ${characterQuadview.imageNodeId}, prompt node ${characterQuadview.promptNodeId}, one reference image, 16:9`);
        if (!Array.isArray(characterQuadview.seedTargets) || characterQuadview.seedTargets.length === 0) {
          warnings.push('character four-view graph exposed no writable seed/noise_seed input; verify the workflow exposes a sampler seed before relying on variations');
        }
      }
      if (imageUpscale !== null) {
        warnings.push(`image upscale mode: load node ${imageUpscale.imageNodeId}, upscaler node ${imageUpscale.upscalerNodeId}, factor ${imageUpscale.factor}`);
      }
      if (generalGeneration !== null) {
        const details = [
          generalGeneration.promptNodeId === undefined ? '' : `prompt node ${generalGeneration.promptNodeId}`,
          generalGeneration.imageCount === undefined ? '' : `${generalGeneration.imageCount} image input(s)`,
          generalGeneration.upscalerNodeId === undefined ? '' : `upscaler node ${generalGeneration.upscalerNodeId}`,
        ].filter((entry) => entry.length > 0);
        warnings.push(`general ${args.generalGeneration.task}: ${details.join(', ') || 'graph selected from 全局配置'}`);
        if (generalGeneration.seed !== undefined) {
          warnings.push(`seed ${String(generalGeneration.seed)} applied to ${String(generalGeneration.seedTargets?.length ?? 0)} active seed input(s)`);
        }
      }
      if (directImageEdit !== null) {
        const canvas = directImageEdit.promptRewrite === null
          ? 'raw workflow canvas'
          : `${directImageEdit.promptRewrite.wh_ratio || directImageEdit.promptRewrite.ratio_follow} canvas`;
        warnings.push(
          `Qwen 2.1 edit prompt (${directImageEdit.promptMode}): ${directImageEdit.imageCount} image input(s), `
          + `${canvas}, prompt node ${directImageEdit.promptNodeId}`,
        );
      }
      const missingNodeClasses = missingActiveNodeClasses(converted);
      if (missingNodeClasses.length > 0) {
        throw new Error(`this instance is missing node classes the workflow needs: ${missingNodeClasses.join(', ')}. Install those ComfyUI nodes, or pick a workflow this instance can run`);
      }
      if (converted.skipped.length > 0) {
        const decorated = converted.skipped.filter((entry) => isCosmeticNodeClass(entry.type)).length;
        warnings.push(`${converted.skipped.length} node(s) were left out of the submitted graph (${decorated} canvas decoration, ${converted.skipped.length - decorated} bypassed or muted)`);
      }

      // A model the workflow names but the instance does not offer is the most
      // common reason a previously working workflow fails, and finding out costs
      // one comparison instead of a failed multi-minute run.
      //
      // Only models named by nodes that are actually IN the submitted graph count:
      // a file's bypassed branches routinely reference models this instance does
      // not have (a prompt enhancer, an alternate upscaler), and flagging those
      // would block runs that would have worked.
      const missingModels = (() => {
        const referenced = new Set();
        for (const node of Object.values(prompt)) {
          for (const value of Object.values(node.inputs ?? {})) {
            if (typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|gguf|onnx)$/iu.test(value)) referenced.add(value.replace(/\\/gu, '/'));
          }
        }
        if (referenced.size === 0) return [];
        const available = availableModelNames(objectInfo);
        return checkModels([...referenced], available.names).missing;
      })();
      if (missingModels.length > 0) {
        throw new Error(`this workflow references ${missingModels.length} model file(s) that ${baseUrl} does not offer, so the run would fail: ${missingModels.slice(0, 6).map((entry) => entry.model).join(', ')}${missingModels.length > 6 ? ` (+${missingModels.length - 6} more)` : ''}. Install those models, or pick a workflow whose models are present`);
      }
      for (const note of converted.notes.slice(0, 8)) warnings.push(note);

      const applied = [];
      // Declared here rather than next to the polling loop, because the idempotency guard
      // returns early with a recorded result and needs a real (empty) errors list to return.
      const errors = [];
      // Every check below runs BEFORE anything is uploaded or submitted. The rule is the
      // one the work manual states plainly: all required inputs and all patches are
      // validated before submit, and ANY failure blocks the submission.
      //
      // This is not merely tidiness. A patch that matched nothing leaves the graph holding
      // its own saved value, so the run produces output the caller never asked for while
      // still costing full GPU time - and the old code reported that only after the run
      // had finished. A patch that could not apply is therefore a blocking failure, not a
      // note to attach afterwards.
      const blocking = [];

      // ---------------------------------------------------------------------
      // Stage 1 - patch validation. No network, no disk, no GPU.
      // ---------------------------------------------------------------------
      if (args.patch !== undefined && args.patch !== null && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        // A `ResolutionSelector.aspect_ratio` is a LABELLED combo - the instance offers
        // `9:16 (Portrait Widescreen)`, never a bare `9:16` - so a short ratio is resolved against the node's
        // own declared choices before the patch is applied. That is not a guess: the list is the node's, and
        // a ratio it does not offer is still refused below. Without this, typing the obvious `9:16` produces
        // "not in [...]" from the instance, which reads as the workflow being broken rather than as the
        // spelling being short.
        const effectivePatch = ['text-to-image', 'image-edit', 'upscale-image'].includes(args.task)
          || args.generalGeneration !== undefined
          || args.characterQuadview !== undefined
          ? expandSeedOverrides(args.patch, prompt)
          : { ...args.patch };
        patchAspectRatioLabels(effectivePatch, prompt, objectInfo);
        const result = patchPrompt(prompt, effectivePatch);
        args = { ...args, patch: effectivePatch };
        applied.push(...result.applied);
        blocking.push(...result.failed.map((entry) => ({ ...entry, kind: 'patch' })));
      }
      if (args.filename_prefix !== undefined && args.filename_prefix !== null && typeof args.filename_prefix === 'object' && !Array.isArray(args.filename_prefix)) {
        for (const [nodeId, prefix] of Object.entries(args.filename_prefix)) {
          const target = prompt[String(nodeId)];
          if (target === undefined || !Object.hasOwn(target.inputs ?? {}, 'filename_prefix')) {
            // Name the nodes that DO take it, so the caller can correct the id
            // without another round trip.
            const holders = Object.entries(prompt).filter(([, node]) => Object.hasOwn(node.inputs ?? {}, 'filename_prefix')).map(([id, node]) => `#${id} ${node.class_type}`);
            blocking.push({ key: `${nodeId}.filename_prefix`, kind: 'filename_prefix', reason: `node ${nodeId} has no filename_prefix input; the nodes that do are ${holders.length === 0 ? 'none' : holders.join(', ')}` });
            continue;
          }
          // `%date:...%` reaches the server as a real prefix unless it is resolved
          // here; left alone it names the file literally "Krea2-%date".
          const resolvedPrefix = resolveDatePlaceholders(prefix);
          target.inputs.filename_prefix = resolvedPrefix;
          applied.push({ node: String(nodeId), classType: target.class_type, input: 'filename_prefix', from: null, to: resolvedPrefix });
        }
      }
      // An `inputs` entry must land on a node that exists AND declares an image input.
      // Anything else is a binding the caller asked for and will not get, so it blocks.
      const uploadTargets = [];
      for (const [nodeId, filePath] of Object.entries(args.inputs ?? {})) {
        const target = prompt[String(nodeId)];
        if (target === undefined) {
          blocking.push({ key: `${nodeId}.image`, kind: 'input', reason: `no node ${nodeId} in the converted graph, so the image cannot be bound. Node ids present: ${Object.keys(prompt).slice(0, 20).join(', ')}` });
          continue;
        }
        if (typeof target.inputs?.image === 'string') {
          uploadTargets.push({
            nodeId: String(nodeId),
            target,
            filePath: String(filePath),
            inputName: 'image',
            kind: 'image',
          });
        } else {
          blocking.push({ key: `${nodeId}.image`, kind: 'input', reason: `node ${nodeId} (${target.class_type}) has no plain image input to bind (its "image" is ${JSON.stringify(target.inputs?.image ?? null)}), so an uploaded file cannot reach it` });
        }
      }
      if (args.mediaInputs !== undefined && args.mediaInputs !== null) {
        if (!Array.isArray(args.mediaInputs)) {
          blocking.push({ key: 'mediaInputs', kind: 'input', reason: 'mediaInputs must be an array of { nodeId, input, filePath, kind }' });
        } else {
          for (const [index, entry] of args.mediaInputs.entries()) {
            const nodeId = typeof entry?.nodeId === 'string' ? entry.nodeId : null;
            const inputName = typeof entry?.input === 'string' ? entry.input : null;
            const filePath = typeof entry?.filePath === 'string' ? entry.filePath : null;
            const kind = entry?.kind;
            if (nodeId === null || inputName === null || filePath === null || !['image', 'video', 'audio'].includes(kind)) {
              blocking.push({
                key: `mediaInputs[${String(index)}]`,
                kind: 'input',
                reason: 'each media input needs a nodeId, input, filePath and kind (image/video/audio)',
              });
              continue;
            }
            const target = prompt[nodeId];
            if (target === undefined) {
              blocking.push({
                key: `${nodeId}.${inputName}`,
                kind: 'input',
                reason: `no node ${nodeId} in the converted graph, so the ${kind} cannot be bound. Node ids present: ${Object.keys(prompt).slice(0, 20).join(', ')}`,
              });
              continue;
            }
            if (typeof target.inputs?.[inputName] !== 'string') {
              blocking.push({
                key: `${nodeId}.${inputName}`,
                kind: 'input',
                reason: `node ${nodeId} (${target.class_type}) has no plain "${inputName}" input to bind (its value is ${JSON.stringify(target.inputs?.[inputName] ?? null)})`,
              });
              continue;
            }
            uploadTargets.push({
              nodeId,
              target,
              filePath,
              inputName,
              kind,
            });
          }
        }
      }
      // An input with NO VALUE is a guaranteed-rejected submission, and this is the check with the
      // narrowest possible definition of "no value".
      //
      // ComfyUI's own rule is `if x not in inputs: required_input_missing` (execution.py, in
      // `validate_inputs`) - it asks whether the KEY is present, not whether the value is truthy. An
      // empty string is a legitimate value with a legitimate meaning, and at least one node in the wild
      // documents "" as the default for a required input: `BlockSparseAttention.dense_blocks` has
      // `("STRING", {"default": ""})` in its object_info.
      //
      // Treating "" as unset rejected a workflow the instance would have accepted, and reported MY
      // mistake as the workflow's - the most expensive kind of wrong answer, because it sends the user
      // to fix something that is not broken. `undefined` and `null` are still refused: undefined cannot
      // survive JSON at all, and null is how a missing local file is represented.
      for (const [id, node] of Object.entries(prompt)) {
        for (const [name, value] of Object.entries(node.inputs ?? {})) {
          if (value !== undefined && value !== null) continue;
          blocking.push({
            key: `${id}.${name}`,
            kind: 'required-input',
            reason: `node ${id} (${node.class_type}) would run with "${name}" unset (its value is ${String(value)}). A required input must be present as a key; pass "" if the node documents an empty string as its default`,
          });
        }
      }

      // ---------------------------------------------------------------------
      // Stage 2 - resolve and hash every input file. Still no network.
      // ---------------------------------------------------------------------
      // Hashing here is what makes the naming collision-proof: the remote name is
      // derived from content, so two different files can never share a remote path.
      const uploads = [];
      for (const { nodeId, target, filePath, inputName, kind } of uploadTargets) {
        const absolute = resolvePath(filePath, exec);
        let bytes;
        try {
          bytes = await readFile(absolute);
        } catch {
          blocking.push({ key: `${nodeId}.${inputName}`, kind: 'input', reason: `input ${kind} not found or unreadable: ${absolute}` });
          continue;
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const remoteName = remoteNameForContent(sha256, absolute);
        let dimensions = {};
        if (kind === 'image') {
          // Refuse a file that is not a usable picture HERE, before anything is uploaded.
          //
          // Measured: a 1x1 PNG reached `LoadImage`, ComfyUI's video-capable loader tried to decode it,
          // FFmpeg answered `Invalid argument returned 22`, and the report named a node id and nothing
          // else. That is indistinguishable from "the workflow is broken", and it cost a GPU queue slot
          // to learn. The guard is structural (no decoder), so it is cheap and it still catches the two
          // real cases: bytes that are not an image, and a picture whose payload was cut off.
          const verdict = inspectImageBytes(bytes);
          if (verdict.ok !== true) {
            blocking.push({ key: `${nodeId}.${inputName}`, kind: 'input', reason: `${absolute}: ${verdict.reason}` });
            continue;
          }
          dimensions = { width: verdict.width, height: verdict.height };
        } else {
          const extension = extname(absolute).toLowerCase();
          const allowed = kind === 'video'
            ? new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'])
            : new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);
          if (bytes.length === 0 || !allowed.has(extension)) {
            blocking.push({
              key: `${nodeId}.${inputName}`,
              kind: 'input',
              reason: `${absolute}: expected a non-empty ${kind} (${[...allowed].join(', ')})`,
            });
            continue;
          }
        }
        uploads.push({
          nodeId,
          target,
          absolute,
          bytes,
          sha256,
          remoteName,
          inputName,
          kind,
          ...dimensions,
        });
        // Assign the name now, so a graph that later fails validation still shows the
        // binding the caller asked for rather than the workflow's saved value.
        target.inputs[inputName] = remoteName;
      }

      // ---------------------------------------------------------------------
      // Stage 2b - reference slot capacity, counted from the graph itself.
      //
      // A video model's documentation says how many reference images it accepts. What a given
      // SAVED workflow can accept is a different number, and it is the one that decides whether a
      // submission is rejected five minutes into a queue: a slot wired from another node is not
      // available, and a bypassed node takes its slots with it. So the count comes from the
      // graph's own structure - reachable, enabled, unlinked image inputs - not from the model's
      // spec sheet.
      //
      // Blocking here is the whole point: seven reference images against six usable slots must be
      // refused BEFORE anything is sent, because the instance would accept the prompt and fail
      // later, after the user has waited.
      const slotInfo = countReferenceSlots(prompt, objectInfo);
      const wantedInputs = Object.keys(args.inputs ?? {}).length
        + (Array.isArray(args.mediaInputs) ? args.mediaInputs.filter((entry) => entry?.kind === 'image').length : 0);
      if (wantedInputs > slotInfo.available) {
        blocking.push({
          key: 'inputs',
          kind: 'slot-capacity',
          reason: `this workflow can take ${String(slotInfo.available)} uploaded image(s)${slotInfo.wired > 0 ? `; ${String(slotInfo.wired)} more image input(s) are wired from other nodes, so an upload cannot reach them` : ''}${slotInfo.bypassed > 0 ? `; ${String(slotInfo.bypassed)} are on bypassed nodes` : ''}${slotInfo.filled > 0 ? `; ${String(slotInfo.filled)} already hold a file and would be replaced` : ''}, but ${String(wantedInputs)} input image(s) were given`,
          available: slotInfo.slots.map((slot) => `${slot.nodeId}.${slot.input}`),
        });
      }

      // ---------------------------------------------------------------------
      // Stage 3 - the gate. Nothing has been sent yet; stop here if anything failed.
      // ---------------------------------------------------------------------
      if (blocking.length > 0) {
        // The error is the whole product value of this gate: it has to name the exact key
        // and say what WOULD have worked, because the caller's next move is to retry with
        // a corrected key. Truncating the remedy out of the message is what turns a
        // one-round-trip fix into a guessing game, so the per-entry budget is generous.
        const shown = blocking.slice(0, 12);
        const detail = shown.map((entry) => {
          const extra = [
            Array.isArray(entry.available) && entry.available.length > 0 ? `available inputs: ${entry.available.slice(0, 24).join(', ')}` : '',
            Array.isArray(entry.candidates) && entry.candidates.length > 0 ? `candidates: ${entry.candidates.slice(0, 12).join(', ')}` : '',
            // The node ids are what a caller needs to rebuild a key from scratch.
            Array.isArray(entry.availableIds) && entry.availableIds.length > 0 ? `node ids present: ${entry.availableIds.join(', ')}` : '',
          ].filter((part) => part.length > 0).join('; ');
          const reason = String(entry.reason ?? '').slice(0, 400);
          return `${entry.key} (${reason}${extra.length > 0 ? `. ${extra}` : ''})`;
        }).join('; ');
        const more = blocking.length > shown.length ? ` (+${blocking.length - shown.length} more)` : '';
        const kinds = [...new Set(blocking.map((entry) => entry.kind))].join(', ');
        const nothingSent = uploads.length === 0 ? ' No file was uploaded and the instance was not contacted,' : ' The instance was not contacted,';
        throw new Error(
          `nothing was submitted: ${blocking.length} problem(s) must be fixed first [${kinds}]. ${detail}${more}.`
          + `${nothingSent} so this cost no GPU time. `
          + 'Read the node ids and their inputs with comfy_graph, then retry with keys that exist.',
        );
      }

      // ---------------------------------------------------------------------
      // Stage 4 - upload, then submit. Every check has already passed.
      // ---------------------------------------------------------------------
      const uploadedByPath = new Map();
      for (const file of uploads) {
        // Identical content in two nodes only needs one copy on the instance.
        const prior = uploadedByPath.get(file.remoteName);
        if (prior === undefined) {
          const result = await uploadImage(baseUrl, {
            filePath: file.absolute,
            fileName: file.remoteName,
            // The name already carries the content hash, so a same-named upload with
            // different bytes is a different file, never an overwrite of this one.
            overwrite: false,
            signal: exec.signal,
          });
          uploadedByPath.set(file.remoteName, result);
          applied.push({ node: file.nodeId, classType: file.target.class_type, input: file.inputName, from: null, to: file.remoteName, uploadedAs: result?.name ?? file.remoteName, sha256: file.sha256 });
        } else {
          applied.push({ node: file.nodeId, classType: file.target.class_type, input: file.inputName, from: null, to: file.remoteName, reusedUpload: true, sha256: file.sha256 });
        }
      }

      // A saved workflow that names its files with `%date:...%` produces a name no
      // copy_as key can predict. Resolve every remaining placeholder so the saved
      // asset has a stable name even when the caller passed no prefix.
      for (const [id, node] of Object.entries(prompt)) {
        const current = node.inputs?.filename_prefix;
        if (typeof current !== 'string' || !current.includes('%date:')) continue;
        const resolved = resolveDatePlaceholders(current);
        node.inputs.filename_prefix = resolved;
        warnings.push(`node #${id} (${node.class_type}) stored the prefix "${current}"; the %date: placeholder was resolved to "${resolved}" so the produced file has a name a rename map can match.`);
      }

      // ---------------------------------------------------------------------
      // Stage 5 - the ledger, then the submission.
      //
      // The record is written FIRST. That ordering is the whole point: between the instance
      // accepting a prompt and this process writing the id down, the entry is the only thing
      // that knows the job exists. Writing it afterwards - which is what the in-memory table
      // did - means a crash in that window leaves a run on the GPU that nothing here can name.
      // ---------------------------------------------------------------------
      const ledger = jobStore(config);
      const instanceKind = chosen.kind;
      const planSnapshot = {
        // The immutable record of what was asked for. Constructed from the values that were
        // actually applied, not from the arguments, so it describes the run rather than the
        // request - and a later edit to the prompt or an asset cannot change what this run is
        // recorded as having used.
        workflow: workflowPath,
        ...(preparedGraph === null ? {} : { preparedGraphHash: createHash('sha256').update(JSON.stringify(preparedGraph)).digest('hex') }),
        instanceId: baseUrl,
        instanceKind,
        inputs: uploads.map((file) => ({
          sha256: file.sha256,
          fileName: file.remoteName,
          localPath: file.absolute,
          kind: file.kind,
          input: file.inputName,
        })),
        patch: args.patch ?? null,
        filenamePrefix: args.filename_prefix ?? null,
        ...(generalGeneration?.upscaleTarget === undefined
          ? {}
          : {
            upscaleTarget: {
              targetResolution: generalGeneration.upscaleTarget.targetResolution,
              targetLongSide: generalGeneration.upscaleTarget.targetLongSide,
              preResizeLongSide: generalGeneration.upscaleTarget.preResizeLongSide,
              scale: generalGeneration.upscaleTarget.scale,
            },
          }),
        shotId: args.shotId ?? null,
        // Explicit production coordinates keep progress attached to the video-prompt shot even
        // when the model was generated from an H3 companion with its own stable shotId.
        episodeNumber: Number.isInteger(args.episodeNumber) ? args.episodeNumber : null,
        blockNumber: Number.isInteger(args.blockNumber) ? args.blockNumber : null,
        projectId: args.project ?? null,
        resultsProjectRoot: args.resultsProjectRoot ?? null,
        referenceIds: Array.isArray(args.referenceIds) ? args.referenceIds : null,
        workflowAdaptation: workflowAdaptation ?? null,
      };
      let ledgerJob = null;
      if (typeof args.jobId === 'string' && args.jobId.length > 0) {
        ledgerJob = await ledger.read(args.jobId);
        if (ledgerJob === undefined) throw new Error(`no job ${args.jobId} in the ledger`);
        if (ledgerJob.state === 'submission_unknown') {
          const error = new Error(
            `job ${ledgerJob.jobId} has an UNCONFIRMED submission. Check the instance queue first; `
            + 'it will not be resubmitted automatically. Start a new generation only after confirming the old prompt did not run.',
          );
          error.code = 'SUBMISSION_UNKNOWN';
          throw error;
        }
        warnings.push(`attaching this run to the existing ledger entry ${args.jobId} (${ledgerJob.state})`);
      } else if (typeof args.requestId === 'string' && args.requestId.length > 0) {
        const begun = await ledger.beginIntent({
          requestId: args.requestId,
          plan: planSnapshot,
          instanceId: baseUrl,
          projectId: args.project ?? null,
          shotId: args.shotId ?? null,
          name: args.name ?? null,
          output: args.output ?? null,
        });
        ledgerJob = begun.job;
        if (begun.reused) {
          // The same request id already produced a job. Returning that job instead of
          // submitting again is what makes a repeat harmless.
          //
          // It matters MOST for a job that already finished: the user double-clicked, or the
          // client retried after a lost reply, and the finished result is sitting on disk. A
          // second submission there would re-run the model and produce a second file for one
          // request - the exact waste this guard exists to prevent. So a terminal state
          // returns its recorded result, and only the two states that genuinely need another
          // attempt fall through:
          //
          //   submission_unknown is NEVER retried, even if the caller repeats the same request
          //     id. The old prompt may be running; the caller must check the queue and start a
          //     deliberately new request after resolving that fact.
          //   failed / cancelled - the instance declined or the run was stopped, so there is
          //     nothing on the instance and a fresh attempt is the right answer.
          if (ledgerJob.state === 'submission_unknown') {
            const error = new Error(
              `request ${args.requestId} is already recorded as ${ledgerJob.jobId} with an UNCONFIRMED submission. `
              + 'Check the instance queue first. It was NOT resubmitted automatically; if the old prompt did not run, use a new requestId deliberately.',
            );
            error.code = 'SUBMISSION_UNKNOWN';
            throw error;
          }
          const needsAnotherAttempt = ledgerStateCanResubmit(ledgerJob.state);
          if (!needsAnotherAttempt) {
            const why = LIVE_STATES.includes(ledgerJob.state)
              ? `already started ${ledgerJob.jobId} (${ledgerJob.state})`
              : `already finished as ${ledgerJob.jobId} (${ledgerJob.state})`;
            warnings.push(`request ${args.requestId} ${why}; not submitting again. Pass a new requestId only if you deliberately want a second run of the same plan`);
            return {
              promptId: ledgerJob.promptId ?? null,
              baseUrl,
              jobId: ledgerJob.jobId,
              state: ledgerJob.state,
              reused: true,
              // The ledger stores a summary - path and size - because it is written as the run progresses, so
              // a reused answer has to be brought back to the full file shape the caller is promised, with
              // `kind` and `remoteName`. Without this the reply describes files differently depending on
              // whether the run was fresh, and the declared output schema rejects the shorter form: a
              // finished job collected a second time would report "invalid output" while its video sat on
              // disk. Entries written by older versions are normalised here too, since they cannot be
              // migrated in place.
              files: (Array.isArray(ledgerJob.files) ? ledgerJob.files : []).map((file) => {
                const path = String(file?.path ?? '');
                return {
                  path,
                  kind: typeof file?.kind === 'string' && file.kind.length > 0 ? file.kind : kindOfOutputFile(path),
                  bytes: typeof file?.bytes === 'number' ? file.bytes : 0,
                  remoteName: typeof file?.remoteName === 'string' && file.remoteName.length > 0 ? file.remoteName : basename(path),
                };
              }),
              workflow: workflowPath,
              elapsed: '0s',
              applied,
              failed: [],
              warnings,
              errors,
            };
          }
          warnings.push(`request ${args.requestId} previously ended as ${ledgerJob.state} (${ledgerJob.jobId}); attempting a fresh submission at the caller's request`);
        }
      } else {
        // No request id: one-shot. Recorded anyway, so the job is visible in the ledger and
        // survives a restart, but a repeat is a new job - which is correct for an interactive
        // run and the reason requestId exists for anything that might be retried.
        const begun = await ledger.beginIntent({
          requestId: `auto_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
          plan: planSnapshot,
          instanceId: baseUrl,
          projectId: args.project ?? null,
          shotId: args.shotId ?? null,
          name: args.name ?? null,
          output: args.output ?? null,
        });
        ledgerJob = begun.job;
        warnings.push(`recorded as ${ledgerJob.jobId}; pass requestId to make a retry safe`);
      }

      await ledger.setState(ledgerJob.jobId, 'submitting');
      let submitted;
      try {
        submitted = await submitPrompt(baseUrl, prompt, { signal: exec.signal });
      } catch (error) {
        if (error?.code === 'SUBMISSION_UNKNOWN') {
          // The one outcome that must never be retried automatically. Recording it and
          // stopping is the honest answer: the instance might be generating right now.
          await ledger.markSubmissionUnknown(ledgerJob.jobId, String(error.message).slice(0, 500));
          throw new Error(
            `${error.message}. The job is recorded as ${ledgerJob.jobId} in state submission_unknown; `
            + 'it will NOT be retried on its own. Check the instance queue (comfy_job with queue_only), then either '
            + 'collect the run with that job\'s prompt id or start a fresh job deliberately.',
          );
        }
        // The instance answered and declined: nothing is running, so the record is a failure.
        await ledger.setState(ledgerJob.jobId, 'failed', { note: String(error?.message ?? error).slice(0, 500) });
        throw error;
      }
      const promptId = String(submitted?.prompt_id ?? '');
      await ledger.attachPromptId(ledgerJob.jobId, promptId);
      // An estimate is what lets the caller say "about two minutes" instead of
      // leaving the user in a silent wait. The task kind comes from the output
      // nodes that are actually in the submitted graph.
      const outputClasses = Object.values(prompt).map((node) => node.class_type).join(' ');
      const taskKind = /VHS_VideoCombine|SaveVideo|SaveWEBM|CreateVideo/i.test(outputClasses)
        ? 'video'
        : /VOSR2Image|SeedVR2|ImageUpscaleWithModel/i.test(outputClasses)
          ? 'upscale-image'
          : /TextEncodeQwenImage21|Krea2Edit/i.test(outputClasses)
            ? 'edit'
            : 'image';
      const estimate = estimateDuration({ task: taskKind });
      warnings.push(`estimated ${estimate.text}; tell the user before they wait, and report progress if it runs past roughly twice that`);
      // The instance accepts a broken graph with HTTP 200 and reports the
      // problems in `node_errors`; it then runs nothing and saves nothing, so a
      // caller that ignores this field reports a success that never happened.
      const nodeErrors = Object.entries(submitted?.node_errors ?? {})
        .map(([nodeId, entry]) => `${nodeId} (${entry?.class_type ?? '?'}): ${(entry?.errors ?? []).map((item) => item.details ?? item.message).filter(Boolean).join('; ') || JSON.stringify(entry).slice(0, 200)}`);
      if (nodeErrors.length > 0) {
        throw new Error(
          `the instance rejected this graph, so nothing was generated. Fix these and retry: ${nodeErrors.join(' | ')}`,
        );
      }
      if (promptId.length === 0) throw new Error(`the instance accepted no prompt: ${JSON.stringify(submitted).slice(0, 500)}`);

      const started = Date.now();
      const requestedTimeout = Number(args.timeout_ms ?? config.runTimeoutMs);
      const deadline = started + (Number.isFinite(requestedTimeout) ? Math.max(0, requestedTimeout) : 0);
      const renameMap = args.copy_as ?? {};      let record = { state: 'pending', outputs: [] };
      const pollIntervalMs = 2500;
      while (Date.now() < deadline) {
        exec.signal?.throwIfAborted?.();
        record = await pollPrompt(baseUrl, promptId, { signal: exec.signal });
        if (record.state === 'completed' || record.state === 'error') break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollIntervalMs, remaining), exec.signal);
      }

      if (record.state === 'error') {
        const history = await pollPrompt(baseUrl, promptId, { signal: exec.signal });
        errors.push(...formatExecutionErrors({ status: record.status }));
        if (errors.length === 0) errors.push(`run failed: ${JSON.stringify(record.status ?? record).slice(0, 600)}`);
        void history;
      }
      if (record.state === 'pending' || record.state === 'running' || record.state === 'unknown') {
        warnings.push(`still ${record.state} after ${humanDuration(Date.now() - started)}; poll with comfy_job and prompt id ${promptId}`);
      }

      // (The ledger already carries baseUrl, workflow, name, output and state from the
      // snapshot and the state transitions; nothing needs copying into an in-memory table.)

      const files = [];
      if (record.state === 'completed') {
        for (const item of collectOutputs({ outputs: outputsToMap(record.outputs) })) {
          if (isTransientResultName(item.filename)) {
            warnings.push(`ignored temporary comparison output ${item.filename}; only real workflow outputs become candidates`);
            continue;
          }
          const extension = extname(item.filename).toLowerCase();
          if (!MEDIA_EXTENSIONS.has(extension)) continue;
          const kind = kindOfOutputFile(item.filename);
          if (outputDir === undefined) {
            files.push({ path: item.filename, kind, bytes: 0, remoteName: item.filename });
            continue;
          }
          const { buffer } = await downloadOutput(baseUrl, { filename: item.filename, subfolder: item.subfolder, type: item.type, signal: exec.signal });
          const renamed = lookupRename(renameMap, item.filename);
          const requestedName = typeof renamed === 'string' && renamed.trim().length > 0 ? renamed.trim() : item.filename;
          const targetName = safeCopyName(requestedName, basename(item.filename));
          if (targetName !== requestedName) {
            warnings.push(`copy_as name ${requestedName} was reduced to ${targetName}; output files cannot escape the selected directory`);
          }
          const targetPath = join(outputDir, targetName);
          await io.ensureDir(dirname(targetPath));
          await io.writeBytes(targetPath, buffer);
          files.push({ path: targetPath, kind, bytes: buffer.byteLength, remoteName: item.filename });
        }
      }

      // A copy_as key that matched nothing is silent otherwise, and the asset then
      // lands under ComfyUI's own generated name - which for a `%date%` prefix is a
      // literal "Krea2-%date" on disk. Say so instead.
      if (record.state === 'completed' && Object.keys(renameMap).length > 0) {
        const unmatched = Object.keys(renameMap).filter((key) => !files.some((file) => lookupRename(renameMap, file.remoteName) !== undefined && lookupRename(renameMap, file.remoteName) === renameMap[key]));
        if (unmatched.length > 0) {
          warnings.push(`copy_as did not match any produced file, so those names were NOT applied: ${unmatched.slice(0, 4).join(', ')}. A key must be the exact produced filename; avoid a %date:...% placeholder in it, because the instance resolves that at run time into a timestamp you cannot predict. Set comfy_run's filename_prefix argument instead to control the stored name.`);
        }
      }

      // A run that finished but produced nothing must not read as success.
      //
      // This is the cheapest lie the tool could tell: `state === 'completed'` with no file, reported
      // as a finished run, lets the caller believe an image exists and move on. The two causes need
      // different fixes - a bypassed output node is fixed in the ComfyUI UI, a missed patch is fixed
      // here - so they get different messages, and both are an ERROR rather than a note.
      //
      // Nothing is recorded as a result either: a candidate area holding a "video result" that does
      // not exist is worse than an empty one, because the panel would offer a play button for a file
      // that is not there.
      if (record.state === 'completed' && files.length === 0) {
        const activeOutputs = Object.entries(prompt).filter(([, node]) => /SaveImage|SaveVideo|VHS_VideoCombine|PreviewImage|DecodeAndSave/i.test(node.class_type));
        const detail = activeOutputs.length === 0
          ? 'the workflow has no ACTIVE output node: every SaveImage/SaveVideo in the saved file is bypassed or muted. Load the workflow in the ComfyUI UI, enable the output you want, and save it again'
          : 'the instance reported success but wrote no file, so nothing was generated. The usual cause is that the patched input is fed by another node, or that the generation path is bypassed in the saved file';
        const error = new Error(`NO_EXPECTED_OUTPUT: the run completed in ${humanDuration(Date.now() - started)} but produced no output - ${detail}`);
        error.code = 'NO_EXPECTED_OUTPUT';
        throw error;
      }
      // Nothing can be unresolved here: every patch, input binding and required value was
      // checked in stage 3, and any failure stopped the run before the instance was
      // contacted. Reaching this point means the graph is exactly what the caller asked
      // for, so there is no "these overrides did not apply" case left to report.
      for (const note of applied.length === 0 ? ['no patch, input or filename_prefix was passed; the workflow runs with its own saved values'] : []) {
        warnings.push(note);
      }

      // ---------------------------------------------------------------------
      // Stage 5b - record the produced files as CANDIDATES.
      //
      // A generation that writes straight into the asset tree makes every experiment
      // indistinguishable from a decision: four attempts at one costume sit beside the approved
      // file with nothing saying which is which, and the newest is silently the one in use. So a
      // run that is told which project it belongs to also records its output in
      // `.director/results/`, where nothing uses it until someone selects it.
      //
      // The caller supplies the ABSOLUTE project root, not a name: this tool has no projects root
      // of its own - `drama_workspace` computes that - and guessing one would write a candidate
      // area into the wrong folder. No root means no recording, which is right for general image
      // work that belongs to no project.
      const candidates = [];
      if (files.length > 0 && typeof args.resultsProjectRoot === 'string' && args.resultsProjectRoot.length > 0) {
        try {
          const store = createResultStore(args.resultsProjectRoot, {
            fs: io.fs,
            getPolicy: io.getPolicy,
          });
          for (const file of files) {
            try {
              const candidate = await store.record({
                jobId: ledgerJob.jobId,
                shotId: typeof args.shotId === 'string' && args.shotId.length > 0 ? args.shotId : null,
                // The episode and block travel with the run so the candidate can be named after
                // the shot it belongs to; without them the grid only shows the instance's own
                // file name, which says nothing about which shot a clip is.
                episodeNumber: Number.isInteger(args.episodeNumber) ? args.episodeNumber : null,
                blockNumber: Number.isInteger(args.blockNumber) ? args.blockNumber : null,
                sourcePath: file.path,
                producedName: basename(file.path),
                role: typeof args.name === 'string' && args.name.length > 0 ? args.name : null,
              });
              candidates.push({ candidateId: candidate.candidateId, fileName: candidate.fileName, status: candidate.status, duplicate: candidate.duplicate });
            } catch (error) {
              // One unusable file must not discard the others.
              warnings.push(`${basename(file.path)} was saved but not recorded as a candidate: ${String(error?.message ?? error)}`);
            }
          }
          if (candidates.length > 0) {
            warnings.push(`${candidates.length} candidate(s) recorded under .director/results - nothing uses them until one is selected (storyboard action=results with resultAction=select)`);
          }
        } catch (error) {
          warnings.push(`could not open the result area: ${String(error?.message ?? error)}`);
        }
      }

      // The ledger mirrors the run's progress, so a job that outlives this process is still
      // describable: which step it reached, and how long each took. A state alone says where
      // it is; the trail says whether it is moving.
      if (record.state === 'completed') {
        await ledger.setState(ledgerJob.jobId, 'completed', { outputs: record.outputs ?? [] });
        if (files.length > 0) {
          await ledger.setState(ledgerJob.jobId, 'saved', { files: files.map((file) => ({ path: file.path, bytes: file.bytes })) });
        } else {
          // The instance finished but nothing arrived, so there is nothing to have saved.
          await ledger.setState(ledgerJob.jobId, 'completed', { note: 'the run completed but produced no file' });
        }
      } else if (record.state === 'error') {
        await ledger.setState(ledgerJob.jobId, 'failed', { note: errors.slice(0, 3).join(' | ').slice(0, 500) });
      } else if (record.state === 'running') {
        await ledger.setState(ledgerJob.jobId, 'running');
      } else if (record.state === 'pending') {
        await ledger.setState(ledgerJob.jobId, 'queued');
      }

      const jobRecord = ledgerJob;
      if (jobRecord !== null) await ledger.update(jobRecord.jobId, (job) => ({ ...job, saved: files.map((file) => file.path) }));

      const elapsed = humanDuration(Date.now() - started);

      return {
        jobId: ledgerJob?.jobId ?? null,
        promptId,
        baseUrl,
        workflow: workflowPath,
        state: record.state,
        elapsed,
        files,
        applied,
        candidates,
        failed: [],
        warnings,
        errors,
        workflowAdaptation,
      };
}

/**
 * What a produced file IS, from its extension.
 *
 * The same classification decides `kind` when a run saves its files and when a recorded job is replayed,
 * so the two cannot describe the same file differently. A reused answer comes from a ledger entry that
 * stored only a path, which is why this has to work from the path alone.
 */
function kindOfOutputFile(path) {
  const extension = extname(String(path)).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(extension)) return 'video';
  if (['.mp3', '.wav', '.flac'].includes(extension)) return 'audio';
  return 'image';
}

/**
 * Expand a short `aspect_ratio` in a patch to the label the instance's ResolutionSelector offers.
 *
 * The node's choices are labelled by ITS convention and differ per ratio (`2:3 (Portrait Photo)`,
 * `21:9 (Ultrawide)`), so the label cannot be composed - it is read from the declared list. A patch key
 * that does not address such a node, or a ratio the node does not offer, is left exactly as it was so the
 * normal patch validation reports it.
 */
function patchAspectRatioLabels(patch, prompt, objectInfo) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (typeof value !== 'string' || value.includes('(')) continue;
    const [nodeId, inputName] = String(key).split('.');
    if (inputName !== 'aspect_ratio') continue;
    const classType = prompt?.[nodeId]?.class_type;
    if (typeof classType !== 'string') continue;
    const declared = objectInfo?.[classType]?.input;
    if (declared === undefined || declared === null) continue;
    const spec = { ...(declared.required ?? {}), ...(declared.optional ?? {}) }.aspect_ratio;
    const options = Array.isArray(spec?.[1]?.options) ? spec[1].options : Array.isArray(spec?.[0]) ? spec[0] : [];
    const match = options.find((option) => typeof option === 'string'
      && (option === value || option.startsWith(`${value} `) || option.startsWith(`${value}(`)));
    if (typeof match === 'string') patch[key] = match;
  }
}

/** Rebuild the `outputs` map shape `collectOutputs` expects from a flat list. */
function outputsToMap(outputs) {
  const map = {};
  for (const item of Array.isArray(outputs) ? outputs : []) {
    const bucket = item.bucket ?? 'images';
    map[item.nodeId] = map[item.nodeId] ?? {};
    map[item.nodeId][bucket] = map[item.nodeId][bucket] ?? [];
    map[item.nodeId][bucket].push({ filename: item.filename, subfolder: item.subfolder, type: item.type, format: item.format });
  }
  return map;
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    if (signal === undefined) return;
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `comfy_job` — follow up on a run that outlived its wait, or inspect the queue.
 */
export function comfyJobTool(config) {
  return defineTool({
    name: 'comfy_job',
    description: 'Check a ComfyUI run that comfy_run left unfinished, and save whatever it produced once it is done. Also reports the live queue and can cancel the running job.',
    parameters: {
      prompt_id: {
        type: 'string',
        description: 'Prompt id returned by comfy_run. Omit to report the queue and every run this session started.',
      },
      output: {
        type: 'string',
        description: 'Directory to save finished outputs into. Defaults to the directory comfy_run used for that prompt.',
      },
      base_url: { type: 'string', description: 'Instance address. When omitted: the address the recorded job ran on, then the same chooser comfy_run uses, then the configured address.' },
      cancel: { type: 'boolean', description: 'Interrupt the currently running job before reporting. REFUSED without confirm_instance_owned, because /interrupt stops whatever that instance is running - including another project\'s job on a shared instance.', default: false },
      confirm_instance_owned: { type: 'boolean', description: 'Required with cancel=true. Confirms you own the instance and mean to interrupt it rather than cancelling one job by prompt id.', default: false },
      queue_only: { type: 'boolean', description: 'Only report the queue state.', default: false },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseUrl: { type: 'string', required: true },
          queueRunning: { type: 'integer', required: true },
          queuePending: { type: 'integer', required: true },
          // Whether this call is asking a different instance than the one that queued the job. It
          // changes what every other line here means, so it is reported rather than inferred.
          instanceChanged: { type: 'boolean' },
          // The address the job was originally queued on; an empty string when the ledger has no
          // record of one. Deliberately a string rather than null: this schema dialect takes one
          // type per field, and a nullable type would make the whole definition invalid - which
          // silently drops the tool from the registry instead of failing loudly.
          instanceId: { type: 'string' },
          jobs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                promptId: { type: 'string', required: true },
                // Returned but undeclared: with `additionalProperties: false` the whole comfy_job
                // answer failed validation the moment a job was in the ledger, so the tool looked
                // broken exactly when it was needed (right after a generation).
                jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                state: { type: 'string', required: true },
                // Same omission as jobId: returned for a short-drama run, never declared.
                shotId: { type: 'string' },
                name: { type: 'string' },
                workflow: { type: 'string' },
                elapsed: { type: 'string' },
              },
            },
          },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                remoteName: { type: 'string', required: true },
              },
            },
          },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.baseUrl} — queue ${value.queueRunning} running / ${value.queuePending} pending`];
        for (const job of value.jobs) lines.push(`  ${job.promptId}: ${job.state}${job.name === undefined ? '' : ` "${job.name}"`}${job.elapsed === undefined ? '' : ` after ${job.elapsed}`}`);
        for (const file of value.files) lines.push(`  saved ${file.kind}: ${file.path}`);
        for (const error of value.errors ?? []) lines.push(`error: ${error}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const ledger = jobStore(config);
      const io = runnerIo(config, exec);
      // Resolving the instance from the LEDGER, not from process memory, is what lets a
      // prompt id survive a restart: the address a job was submitted to is recorded with it,
      // and a job cannot be polled on the wrong instance (a local one and a cloud one have
      // unrelated queues).
      const knownJob = typeof args.prompt_id === 'string' && args.prompt_id.length > 0
        ? (await ledger.list({ limit: 1000 })).find((job) => job.promptId === args.prompt_id)
        : undefined;
      // Address resolution order, and why it is not simply `config.comfyBaseUrl`:
      //   1. an explicit base_url;
      //   2. the instance the job was recorded on;
      //   3. the SAME chooser `comfy_run` uses.
      // Step 3 was missing. `config.comfyBaseUrl` defaults to a local port, so on a machine where
      // the work ran on a cloud tunnel `comfy_job` went to the wrong address and answered
      // `Error: fetch failed` while `comfy_inventory` was talking to the cloud instance happily.
      // The panel's own status line tells the agent to "poll them with comfy_job", so that
      // instruction led straight into the failure.
      let baseUrl = (args.base_url ?? knownJob?.instanceId ?? '').trim();
      if (baseUrl.length === 0) {
        const chosen = await selectInstance(config, { prefer: config.preferInstance ?? 'auto', signal: exec.signal }).catch(() => null);
        baseUrl = (chosen?.baseUrl ?? '').trim();
      }
      if (baseUrl.length === 0) baseUrl = String(config.comfyBaseUrl ?? '').trim();
      if (baseUrl.length === 0) throw new Error('no ComfyUI address answers: pass base_url, start an instance with comfy_launch, or configure comfyBaseUrl');

      // A job belongs to the instance that queued it, and the prompt id is only meaningful there.
      //
      // Asking a DIFFERENT instance about it is not a harmless mismatch: the id will not be found,
      // and the natural reading of "not found" is that the job vanished - so the caller re-runs it,
      // which is a second generation the user pays for. Saying `instance_changed` instead turns that
      // into a fixable address problem.
      //
      // Reachable in practice because a cloud tunnel's local port and the instance behind it can
      // both change between sessions, while the ledger - being on disk - does not.
      let instanceChanged = false;
      if (knownJob !== undefined && typeof knownJob.instanceId === 'string' && knownJob.instanceId.length > 0
        && normalizeBaseUrl(knownJob.instanceId) !== normalizeBaseUrl(baseUrl)) {
        instanceChanged = true;
      }

      // Cancelling by instance interrupt stops WHATEVER is running, including another
      // project's job on a shared instance. Refusing unless the caller says the instance is
      // theirs is the difference between "cancel my job" and "stop the world".
      if (args.cancel === true) {
        // Cancel by PROMPT ID first, whenever one is known. That request names a single queue entry
        // and cannot affect anything else, so it needs no confirmation and is the right default on
        // an instance that may be shared. The instance-level interrupt remains the fallback, and it
        // stops whatever is running - including somebody else's job - so it keeps its confirmation.
        //
        // The error message below has promised this path since the guard was written; until now the
        // path itself did not exist, so "prefer cancelling by prompt id" was advice that could not
        // be taken.
        const target = typeof args.prompt_id === 'string' && args.prompt_id.length > 0 ? args.prompt_id : null;
        if (target !== null) {
          const outcome = await cancelQueueItem(baseUrl, target, { signal: exec.signal });
          if (outcome.was === 'running') {
            // Escalating to an instance interrupt here is exactly the mistake the confirmation
            // exists to prevent, so this reports what it found and leaves the decision to the caller.
            throw new Error(
              `prompt ${target} is already RUNNING, and a running queue entry cannot be removed. `
              + 'Stopping it needs the instance-level /interrupt, which also stops whatever else that instance is running - '
              + 'call this tool again with confirm_instance_owned=true only if you own the instance and mean exactly that',
            );
          }
          if (outcome.was === 'missing') {
            throw new Error(`prompt ${target} is neither pending nor running on ${baseUrl}; nothing was cancelled`);
          }
        } else if (args.confirm_instance_owned !== true) {
          throw new Error(
            'cancel without a prompt_id uses the instance-level /interrupt, which stops whatever is running on that instance - including somebody else\'s job. '
            + 'Prefer cancelling by prompt id (this tool with cancel=true and prompt_id set, which removes just that queue entry), '
            + 'or pass confirm_instance_owned=true if you own the instance and mean to interrupt it',
          );
        } else {
          await interrupt(baseUrl, { signal: exec.signal });
        }
      }
      const queue = await readQueue(baseUrl, { signal: exec.signal });
      const queueRunning = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
      const queuePending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
      const listed = [];
      const files = [];
      const errors = [];

      // The ids to report: the one asked for, or every live job in the ledger. A finished job
      // is included only when it is the one asked for, so a plain call reports what needs
      // attention rather than the whole history.
      const live = await ledger.live();
      const ids = typeof args.prompt_id === 'string' && args.prompt_id.length > 0
        ? [args.prompt_id]
        : live.filter((job) => typeof job.promptId === 'string').map((job) => job.promptId);

      for (const id of ids) {
        const known = (await ledger.list({ limit: 1000 })).find((job) => job.promptId === id);
        if (args.queue_only === true) continue;
        const record = await pollPrompt(baseUrl, id, { signal: exec.signal });
        const created = known?.createdAt === undefined ? undefined : Date.parse(known.createdAt);
        listed.push({
          promptId: id,
          jobId: known?.jobId ?? null,
          state: record.state,
          ...known?.name === undefined || known?.name === null ? {} : { name: known.name },
          ...known?.plan?.workflow === undefined ? {} : { workflow: known.plan.workflow },
          ...created === undefined || Number.isNaN(created) ? {} : { elapsed: humanDuration(Date.now() - created) },
          ...known?.shotId === undefined || known?.shotId === null ? {} : { shotId: known.shotId },
        });

        const outputDir = args.output === undefined ? known?.output ?? undefined : resolvePath(args.output, exec);
        // Mirror the observed state back into the ledger, so a job collected here is not left
        // looking unfinished for the next session. `completed` is only an observation from the
        // instance; local collection moves through `downloading` to `saved`. Writing `completed`
        // before the download is what allowed a concurrent observer to overwrite an already saved
        // result and make the panel say "生成中" forever.
        if (known !== undefined) {
          if (record.state === 'completed') {
            await setCollectedJobState(
              ledger,
              known.jobId,
              outputDir === undefined || outputDir === null ? 'completed' : 'downloading',
              { outputs: record.outputs ?? [] },
            );
          } else if (record.state === 'error') {
            await setCollectedJobState(ledger, known.jobId, 'failed', { note: errors.slice(0, 3).join(' | ').slice(0, 400) });
          } else if (record.state === 'running') {
            await setCollectedJobState(ledger, known.jobId, 'running');
          } else if (record.state === 'pending') {
            await setCollectedJobState(ledger, known.jobId, 'queued');
          }
        }

        if (record.state === 'error') errors.push(...formatExecutionErrors({ status: record.status }));
        if (record.state !== 'completed') continue;
        if (outputDir === undefined || outputDir === null) continue;
        await io.ensureDir(outputDir);
        const saved = [];
        for (const item of collectOutputs({ outputs: outputsToMap(record.outputs) })) {
          const extension = extname(item.filename).toLowerCase();
          if (!MEDIA_EXTENSIONS.has(extension)) continue;
          const kind = kindOfOutputFile(item.filename);
          try {
            const { buffer } = await downloadOutput(baseUrl, { filename: item.filename, subfolder: item.subfolder, type: item.type, signal: exec.signal });
            const targetPath = join(outputDir, item.filename);
            await io.writeBytes(targetPath, buffer);
            files.push({ path: targetPath, kind, bytes: buffer.byteLength, remoteName: item.filename });
            saved.push(targetPath);
            if (known?.plan?.resultsProjectRoot) {
              await createResultStore(known.plan.resultsProjectRoot, {
                fs: io.fs,
                getPolicy: io.getPolicy,
              }).record({
                jobId: known.jobId,
                shotId: known.shotId ?? known.plan.shotId ?? null,
                // Asynchronous collection is the normal H3 path. Dropping these coordinates
                // here made a finished shot fall back to "ready": the result existed, but
                // progress could not associate it with the video-prompt 大分镜.
                episodeNumber: Number.isInteger(known.plan.episodeNumber) ? known.plan.episodeNumber : null,
                blockNumber: Number.isInteger(known.plan.blockNumber) ? known.plan.blockNumber : null,
                sourcePath: targetPath,
                producedName: basename(targetPath),
                role: known.name ?? null,
              });
            }
          } catch (error) {
            // The generation SUCCEEDED and the bytes are still on the instance. Recording
            // this as a failed run would throw away finished work and invite a re-run; the
            // remedy is to download again, so that is what the state says.
            errors.push(`download failed for ${item.filename}: ${String(error?.message ?? error)}`);
          }
        }
        if (known !== undefined) {
          if (saved.length > 0) await setCollectedJobState(ledger, known.jobId, 'saved', { files: saved });
          else if (outputDir !== undefined) await setCollectedJobState(ledger, known.jobId, 'download_failed', { note: 'the run finished; the local copy does not exist yet. Retry the download, do not re-run the model' });
        }
      }

      // Jobs whose submission outcome was never confirmed are reported every time, because
      // they are the one state a caller must resolve by hand.
      for (const job of await ledger.list({ state: 'submission_unknown', limit: 20 })) {
        errors.push(`job ${job.jobId} has an unconfirmed submission (${String(job.note ?? 'no reply').slice(0, 160)}). Check the instance queue, then either collect it or start a new job deliberately; it will not be retried automatically`);
      }

      if (args.queue_only !== true && listed.length === 0 && errors.length === 0) {
        errors.push('no prompt id given and the job ledger holds no live job');
      }
      // Reported as its own field AND as an error line, because it changes what every other line in
      // this answer means: if the address moved, "not found" is about the address, not the job.
      if (instanceChanged) {
        errors.push(
          `INSTANCE_CHANGED: ${String(knownJob?.promptId ?? '')} was queued on ${String(knownJob?.instanceId ?? '')} but this call is asking ${baseUrl}. `
          + 'A prompt id is only meaningful on the instance that queued it, so a "not found" here says nothing about whether the job ran. '
          + 'Ask the original address, or re-point the tunnel at the same instance',
        );
      }
      return { baseUrl, instanceChanged, instanceId: knownJob?.instanceId ?? '', queueRunning, queuePending, jobs: listed, files, errors };
    },
  });
}

/**
 * `drama_workspace` — build and maintain the short-drama project structure.
 */
export function dramaWorkspaceTool(config) {
  return defineTool({
    name: 'drama_workspace',
    description: 'Create or extend the short-drama project workspace: the root folder named after the script, the 资产 tree (人物资产 / 场景资产 / 道具资产 / 资产盘点稿 / 资产提示词) and one folder per episode containing that episode script and its 本集所需资产. init is idempotent when .director/project.json already exists; use status or sync_asset as production advances. Existing files are never overwritten unless overwrite is true.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['init', 'status', 'sync_asset'],
        description: 'init creates the folder tree and writes the script and planning documents; status reports what exists; sync_asset copies one produced asset into every episode that needs it.',
      },
      root: {
        type: 'string',
        description: 'Project root. Defaults to <project drive>\\DSH-Short-Drama-Project\\<script_name> — the fixed design root the 分镜管理 panel also lists from, so a project created here is the one the panel offers. Pass an explicit path only to keep a project somewhere else deliberately.',
      },
      script_name: { type: 'string', description: 'Script title; becomes the project folder name. Required for init unless root is given.' },
      script_path: { type: 'string', description: 'Existing script file to copy into the root as 剧本.<ext>. Required for init.' },
      episodes: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Episode numbers to create folders for, for example [1,2,3]. Defaults to every episode in the asset inventory.',
      },
      characters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            relation: { type: 'string', required: true, description: 'The text for the parenthesis after the folder name: 男主 / 女主 / 男二 / 女二, a relationship such as 男主父亲, or a profession when there is no relationship.' },
          },
        },
        description: 'Characters to create folders for under 资产/人物资产, as 名字（身份）.',
      },
      scenes: { type: 'array', items: { type: 'string' }, description: 'Scene asset names; each becomes a file placeholder list, not a folder.' },
      props: { type: 'array', items: { type: 'string' }, description: 'Prop asset names.' },
      inventory_path: { type: 'string', description: 'Asset inventory document (资产盘点稿) to copy into 资产/资产盘点稿.' },
      prompts_path: { type: 'string', description: 'Asset prompt document (资产提示词) to copy into 资产/资产提示词.' },
      asset_path: {
        type: 'string',
        description: 'For action=sync_asset: the produced asset file to copy into episode folders.',
      },
      asset_name: {
        type: 'string',
        description: 'For action=sync_asset: the asset name the file belongs to, used to find which episodes need it.',
      },
      asset_kind: {
        type: 'string',
        enum: ['人物', '场景', '道具'],
        description: 'For action=sync_asset: which asset tree the file belongs in.',
      },
      episode_scripts: {
        type: 'json',
        description: 'For init: episode scripts keyed by episode number, for example {"1":"<full text of episode 1 script>"}. Written to 剧集/第1集/第1集剧本.txt. Prepare the text yourself from the source script; the first three sections must name the episode characters, scenes and props.',
      },
      overwrite: { type: 'boolean', description: 'Replace existing files (not folders) with the supplied content.', default: false },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          created: { type: 'array', required: true, items: { type: 'string' } },
          existing: { type: 'array', required: true, items: { type: 'string' } },
          written: { type: 'array', required: true, items: { type: 'string' } },
          copied: { type: 'array', required: true, items: { type: 'string' } },
          alreadyCurrent: { type: 'array', items: { type: 'string' } },
          unmatchedVariants: { type: 'array', items: { type: 'json' } },
          missingDatasets: { type: 'array', items: { type: 'string' } },
          report: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [value.root];
        if (value.created.length > 0) lines.push(`created ${value.created.length}: ${value.created.slice(0, 20).join(', ')}${value.created.length > 20 ? ` … (+${value.created.length - 20})` : ''}`);
        if (value.written.length > 0) lines.push(`wrote: ${value.written.join(', ')}`);
        if (value.copied.length > 0) lines.push(`copied ${value.copied.length} file(s): ${value.copied.slice(0, 20).join(', ')}`);
        if (value.existing.length > 0) lines.push(`${value.existing.length} path(s) already existed`);
        for (const line of value.report ?? []) lines.push(line);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const io = runnerIo(config, exec);
      const root = await resolveProjectRoot(args, config, exec, io);
      if (args.action === 'status') return await describeWorkspace(root);
      if (args.action === 'sync_asset') {
        if (args.asset_path === undefined) throw new Error('sync_asset needs asset_path');
        const absolute = resolvePath(args.asset_path, exec);
        if (!await isFile(absolute)) throw new Error(`asset file not found: ${absolute}`);
        const synced = await syncAssetToEpisodesDetailed(root, {
          assetPath: absolute,
          assetName: args.asset_name ?? basename(absolute).replace(/\.[^.]+$/u, ''),
          assetKind: args.asset_kind ?? '人物',
          io,
        });
        const report = [
          ...(synced.alreadyCurrent.length > 0 ? [`${synced.alreadyCurrent.length} path(s) are already the exact same bytes`] : []),
          ...synced.unmatchedVariants.map((entry) => `${entry.episode}: dataset asks for ${entry.requested}, but sync_asset was given ${entry.syncedName}; the variant was not copied`),
          ...synced.missingDatasets.map((file) => `${file} is missing or invalid; no sync decision was made for that episode`),
        ];
        return {
          root,
          created: [],
          existing: synced.alreadyCurrent,
          written: [],
          copied: synced.copied,
          alreadyCurrent: synced.alreadyCurrent,
          unmatchedVariants: synced.unmatchedVariants,
          missingDatasets: synced.missingDatasets,
          report,
        };
      }
      const result = await ensureDramaWorkspace(root, {
        scriptName: args.script_name,
        scriptPath: args.script_path === undefined ? undefined : resolvePath(args.script_path, exec),
        episodes: args.episodes,
        characters: args.characters,
        scenes: args.scenes,
        props: args.props,
        inventoryPath: args.inventory_path === undefined ? undefined : resolvePath(args.inventory_path, exec),
        promptsPath: args.prompts_path === undefined ? undefined : resolvePath(args.prompts_path, exec),
        episodeScripts: args.episode_scripts,
        overwrite: args.overwrite === true,
        // The refusal to build on another production is the default. An explicit
        // `overwrite: true` is how a caller says "yes, this same folder, on purpose".
        allowForeign: args.overwrite === true,
        io,
      });
      // D8: register the project in the plugin state.
      //
      // `drama_mode status` answers "which projects exist" from `state.json`, while this tool used
      // to create folders and tell nobody - so after a successful init the mode reported
      // 「No project has been created yet」 and the agent offered to create what already existed.
      // Recorded for every init, including a re-run, so the entry also refreshes `present`.
      try {
        await updateState((current) => {
          const known = current.projects.find((entry) => entry.root === result.root);
          upsertProject(current, {
            ...(known ?? {}),
            root: result.root,
            name: args.script_name ?? basename(result.root),
            present: true,
            episodes: Array.isArray(args.episodes) ? args.episodes.length : (known?.episodes ?? null),
          });
          return current;
        });
      } catch (error) {
        // A state write that fails must not undo a workspace that was built successfully.
        result.report.push(`工作区已建好，但项目索引没写进 state.json（${String(error?.message ?? error)}）；drama_mode status 可能还看不到它。`);
      }
      return result;
    },
  });
}

/**
 * Decide the project root.
 *
 * Default: `<drive>:/DSH-Short-Drama-Project/<script title>` - the fixed design root,
 * which is the same directory the 分镜管理 panel lists from, so a project created here
 * is always the one the panel offers. An explicit `root` still wins, for a user who
 * deliberately keeps a project somewhere else.
 */
async function resolveProjectRoot(args, config, exec, io = null) {
  if (args.root !== undefined && args.root.trim().length > 0) return resolvePath(args.root, exec);
  const name = args.script_name?.trim();
  if (name === undefined || name.length === 0) {
    throw new Error('give root, or script_name so the project folder can be named after the script');
  }
  const { root, projectRoot } = projectPathFor(name, { drive: config.projectDrive });
  // The design root is created here rather than left to the caller: the very first
  // project on a fresh machine would otherwise need someone to make the folder first.
  await mkdir(io === null ? root : await io.checkedPath(root), { recursive: true });
  return projectRoot;
}

/** Report the workspace shape without changing it. */
async function describeWorkspace(root) {
  const { readdir } = await import('node:fs/promises');
  const report = [];
  const created = [];
  const existing = [];
  const listDir = async (path) => {
    try {
      return (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    } catch {
      return [];
    }
  };
  try {
    await access(root);
    existing.push(root);
  } catch {
    report.push(`${root} does not exist yet; run action=init`);
    return { root, created, existing, written: [], copied: [], report };
  }
  const top = await listDir(root);
  report.push(`${root}: ${top.map((entry) => `${entry.name}${entry.directory ? '/' : ''}`).join(', ')}`);
  const assets = await listDir(join(root, '资产'));
  if (assets.length > 0) report.push(`资产/: ${assets.map((entry) => entry.name).join(', ')}`);
  const people = await listDir(join(root, '资产', '人物资产'));
  if (people.length > 0) report.push(`资产/人物资产/: ${people.length} character folder(s) — ${people.map((entry) => entry.name).join(', ')}`);
  const episodes = (await listDir(join(root, '剧集'))).filter((entry) => entry.directory);
  for (const episode of episodes) {
    const files = await listDir(join(root, '剧集', episode.name));
    const needed = await listDir(join(root, '剧集', episode.name, '本集所需资产'));
    report.push(`剧集/${episode.name}: ${files.map((entry) => `${entry.name}${entry.directory ? '/' : ''}`).join(', ') || '(empty)'}; 本集所需资产: ${needed.length} entr${needed.length === 1 ? 'y' : 'ies'}`);
  }
  if (episodes.length === 0) report.push('剧集/: no episode folders yet');
  return { root, created, existing, written: [], copied: [], report };
}
