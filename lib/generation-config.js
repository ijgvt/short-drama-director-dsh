/**
 * Global generation configuration for the storyboard panel.
 *
 * The task/workflow preferences and video sampling values are not project data. They live in
 * `%DSH_HOME%/short-drama/state.json` so opening another production does not silently change
 * which workflow or model the user selected.
 *
 * @module dsh-plugin-short-drama-director/lib/generation-config
 */

import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fetchJson, probeEndpoint, readObjectInfo } from './comfy.js';
import { resolveWorkflowDirectories } from './env-discovery.js';
import { readCloudConfig } from './launch.js';
import { scanWorkflows } from './workflows.js';
import { readState, statePath, updateState } from './state.js';
import {
  SAMPLING_STEPS,
  applyH3WorkflowControls,
  findH3Workflow,
  inspectH3WorkflowControls,
} from './h3-generation.js';
import { readPromptSourceConfiguration, validatePromptSelection } from './prompt-sources.js';

export const GENERATION_TASKS = Object.freeze([
  { id: 'text-to-image', label: '文生图', selectable: true },
  { id: 'image-edit', label: '图片编辑', selectable: true },
  { id: 'upscale-image', label: '图像超分', selectable: true },
  { id: 'upscale-video', label: '视频超分', selectable: true },
  { id: 'video-generation', label: '视频生成', selectable: false },
]);

const TASK_BY_ID = new Map(GENERATION_TASKS.map((task) => [task.id, task]));

function unique(values) {
  return [...new Set(values)];
}

function isVosr2Workflow(item) {
  return /VOSR2|vosr2/iu.test(String(item?.name ?? item?.file ?? ''));
}

function isImageUpscaleWorkflow(item) {
  const name = String(item?.name ?? '');
  const groups = (item?.groupTitles ?? []).join(' ');
  return /图像.*(?:放大|超分)|图片.*(?:放大|超分)|image.*upscale/iu.test(`${name} ${groups}`);
}

function isVideoUpscaleWorkflow(item) {
  const name = String(item?.name ?? '');
  const groups = (item?.groupTitles ?? []).join(' ');
  return /视频.*(?:放大|超分)|video.*upscale/iu.test(`${name} ${groups}`);
}

function isCombinedUpscaleWorkflow(item) {
  return isImageUpscaleWorkflow(item) && isVideoUpscaleWorkflow(item);
}

function portOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.port.length > 0 ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
}

function comboOptions(objectInfo, className, inputName) {
  const declared = objectInfo?.[className]?.input;
  const spec = { ...(declared?.required ?? {}), ...(declared?.optional ?? {}) }[inputName];
  if (spec === undefined) return [];
  const values = Array.isArray(spec?.[1]?.options)
    ? spec[1].options
    : Array.isArray(spec?.[0]) ? spec[0] : [];
  return values.filter((value) => typeof value === 'string');
}

/**
 * Whether a scanned workflow is a sensible candidate for one task.
 *
 * Capabilities are the primary evidence. A few combined workflows legitimately serve two
 * tasks, so a row may appear in more than one dropdown. The file name and group titles are
 * only used where the saved graph cannot express the distinction, notably a VOSR2 graph that
 * carries both image and video upscale groups.
 */
export function workflowMatchesTask(item, taskId) {
  const capabilities = new Set(item?.capabilities ?? []);
  const groups = (item?.groupTitles ?? []).join(' ');
  const name = String(item?.name ?? '');
  const purpose = item?.primaryPurpose ?? null;
  if (taskId === 'text-to-image') {
    return capabilities.has('text-to-image') && !capabilities.has('upscale-image');
  }
  if (taskId === 'image-edit') {
    return ['image-to-image', 'inpaint', 'costume', 'quadview'].some((tag) => capabilities.has(tag))
      || ['image-to-image', 'inpaint', 'costume', 'quadview'].includes(purpose)
      || /编辑|重绘|换装|四视图|图生图|inpaint|img2img/iu.test(name);
  }
  if (taskId === 'upscale-image') {
    if (isCombinedUpscaleWorkflow(item)) return false;
    if (isVideoUpscaleWorkflow(item) && !isImageUpscaleWorkflow(item)) return false;
    return isImageUpscaleWorkflow(item)
      || (capabilities.has('upscale-image')
        && !/视频.*(放大|超分)|video.*upscale/iu.test(name)
        && !/视频.*(放大|超分)|video.*upscale/iu.test(groups))
      || (isVosr2Workflow(item) && !/仅.*视频|video.only/iu.test(name));
  }
  if (taskId === 'upscale-video') {
    if (isCombinedUpscaleWorkflow(item)) return false;
    if (isImageUpscaleWorkflow(item) && !isVideoUpscaleWorkflow(item)) return false;
    return isVideoUpscaleWorkflow(item)
      || capabilities.has('upscale-video')
      || (isVosr2Workflow(item) && !/仅.*图像|仅.*图片|image.only/iu.test(name));
  }
  return false;
}

function summarizeWorkflow(item, taskId = null) {
  return {
    file: item.file,
    name: item.name,
    relativePath: item.relativePath ?? item.name,
    workflowRoot: item.workflowRoot ?? null,
    capabilities: item.capabilities ?? [],
    primaryPurpose: item.primaryPurpose ?? null,
    media: item.media ?? [],
    models: item.models ?? [],
    modelCount: (item.models ?? []).length,
    outputInactive: item.outputInactive === true,
    modifiedAt: item.modifiedAt ?? null,
    matchesTask: taskId === null ? null : workflowMatchesTask(item, taskId),
  };
}

async function workflowInventory(config, state, env) {
  let dir = null;
  let source = null;
  let directories = [];
  let unresolved = [];
  try {
    const resolved = await resolveWorkflowDirectories(config, { statePath: statePath(env) });
    dir = resolved.dir ?? null;
    source = resolved.source ?? null;
    directories = resolved.directories ?? [];
    unresolved = resolved.unresolved ?? [];
  } catch {
    dir = state.workflows?.dir ?? null;
    source = 'stored index';
  }
  if (directories.length === 0 && typeof dir === 'string' && dir.length > 0) {
    directories = [{ dir, source }];
  }
  if (directories.length > 0) {
    const scans = await Promise.allSettled(directories.map((entry) => scanWorkflows(entry.dir)));
    const itemsByFile = new Map();
    const unreadable = [];
    const errors = [];
    for (const [index, result] of scans.entries()) {
      const entry = directories[index];
      if (result.status === 'rejected') {
        errors.push(`${entry.dir}: ${String(result.reason?.message ?? result.reason)}`);
        continue;
      }
      for (const item of result.value.items) {
        const key = String(item.file).toLowerCase();
        if (!itemsByFile.has(key)) {
          itemsByFile.set(key, { ...item, workflowSource: entry.source, workflowRoot: entry.dir });
        }
      }
      for (const bad of result.value.unreadable) unreadable.push({ ...bad, workflowSource: entry.source });
    }
    const items = [...itemsByFile.values()]
      .sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
    if (items.length > 0 || errors.length < directories.length) {
      return {
        dir,
        directories,
        unresolved,
        source,
        scannedAt: new Date().toISOString(),
        items,
        unreadable,
        errors,
      };
    }
    if (Array.isArray(state.workflows?.items) && state.workflows.items.length > 0) {
      return {
        dir,
        directories,
        unresolved,
        source,
        scannedAt: state.workflows.indexedAt ?? null,
        items: state.workflows.items,
        stale: true,
        error: errors.join('; '),
      };
    }
    return { dir, directories, unresolved, source, scannedAt: null, items: [], error: errors.join('; ') };
  }
  return {
    dir: null,
    directories: [],
    unresolved,
    source,
    scannedAt: state.workflows?.indexedAt ?? null,
    items: state.workflows?.items ?? [],
  };
}

function cloudWorkflowCacheRoot(baseUrl, env) {
  const key = createHash('sha256').update(String(baseUrl)).digest('hex').slice(0, 12);
  return join(dirname(statePath(env)), 'remote-workflows', 'cloud', key);
}

function safeRemoteWorkflowSegments(remotePath) {
  const segments = String(remotePath ?? '').replace(/\\/gu, '/').split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes(':'))) return null;
  return segments;
}

/**
 * Read the workflows the cloud instance itself exposes.
 *
 * ComfyUI stores saved UI workflows under `/userdata?dir=workflows`. Mirroring them into
 * DSH_HOME gives the plugin a normal local file to profile and submit, while keeping the
 * category honestly separate from locally installed folders. A locally edited cache file is
 * newer than the remote timestamp and is therefore preserved on the next sync.
 */
export async function cloudWorkflowInventory(environment, {
  env = process.env,
  signal,
  timeoutMs = 20000,
} = {}) {
  const baseUrl = typeof environment?.baseUrl === 'string' ? environment.baseUrl : null;
  if (environment?.configured !== true || baseUrl === null) {
    return { dir: null, source: 'cloud not configured', items: [], unreadable: [], error: null };
  }
  const cacheRoot = cloudWorkflowCacheRoot(baseUrl, env);
  const scanCache = async (source, error = null) => {
    try {
      const scanned = await scanWorkflows(cacheRoot);
      return {
        dir: cacheRoot,
        source,
        items: scanned.items.map((item) => ({
          ...item,
          workflowSource: source,
        })),
        unreadable: scanned.unreadable,
        error,
      };
    } catch {
      return { dir: cacheRoot, source, items: [], unreadable: [], error };
    }
  };
  if (environment.reachable !== true) {
    return await scanCache('cloud workflow cache (instance offline)', '云端当前未响应，显示上次同步的工作流缓存');
  }

  let listing;
  try {
    listing = await fetchJson(baseUrl, '/userdata?dir=workflows&recurse=true&full_info=true', { timeoutMs, signal });
  } catch (error) {
    return await scanCache('cloud workflow cache (sync failed)', `云端工作流读取失败：${String(error?.message ?? error)}`);
  }
  if (!Array.isArray(listing)) {
    return await scanCache('cloud workflow cache (invalid response)', '云端工作流接口返回了无法识别的格式');
  }

  const currentPaths = new Set();
  const failures = [];
  for (const entry of listing) {
    const remotePath = typeof entry === 'string' ? entry : entry?.path;
    const segments = safeRemoteWorkflowSegments(remotePath);
    if (segments === null || !/\.json$/iu.test(segments.at(-1))) continue;
    if (/\.bak|\.backup|\.old|\.orig|~$/iu.test(segments.at(-1))) continue;
    const relativePath = segments.join('/');
    currentPaths.add(relativePath);
    const target = join(cacheRoot, ...segments);
    const remoteModified = Number(typeof entry === 'object' ? entry?.modified : 0) || 0;
    const local = await stat(target).catch(() => null);
    const shouldDownload = local === null
      || remoteModified <= 0
      || local.mtimeMs < remoteModified - 1000;
    if (!shouldDownload) continue;
    try {
      // GET /userdata/{file} resolves from the user-data root and ignores `dir`; encode the
      // whole `workflows/...` path as one route segment. This is the shape ComfyUI's own
      // frontend uses, and it works with nested workflow folders too.
      const routePath = encodeURIComponent(['workflows', ...segments].join('/'));
      const graph = await fetchJson(baseUrl, `/userdata/${routePath}`, { timeoutMs, signal });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
      if (remoteModified > 0) {
        const stamp = new Date(remoteModified);
        await utimes(target, stamp, stamp).catch(() => undefined);
      }
    } catch (error) {
      failures.push(`${relativePath}: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * A successful listing is the authority for which workflows still exist remotely.
   * Do not leave deleted workflows in the mirror: they remain selectable on disk and can
   * silently be submitted long after the cloud instance no longer owns them.
   */
  const staleFiles = [];
  try {
    const previousCache = await scanWorkflows(cacheRoot);
    for (const item of previousCache.items) {
      if (currentPaths.has(item.relativePath)) continue;
      await rm(item.file, { force: true });
      staleFiles.push(item.relativePath);
    }
  } catch {
    // A cache that cannot be scanned is still reported by scanCache below.
  }
  const cached = await scanCache(`cloud instance ${baseUrl}`, failures.length > 0 ? failures.join('; ') : null);
  return {
    ...cached,
    items: cached.items.filter((item) => currentPaths.has(item.relativePath)),
    staleFiles,
  };
}

async function environmentStatus(config, { signal, probe = true } = {}) {
  let cloud = null;
  try {
    cloud = await readCloudConfig(config.cloudTunnelScript);
  } catch {
    cloud = { found: false };
  }
  const cloudConfigured = cloud?.found === true;
  const cloudPort = cloudConfigured
    ? (Number.isInteger(cloud?.localPort) ? cloud.localPort : (Number.isInteger(config.cloudLocalPort) ? config.cloudLocalPort : 8888))
    : null;
  const basePort = portOf(config.comfyBaseUrl);
  const localPorts = unique([
    ...(Array.isArray(config.localPorts) ? config.localPorts : []),
    8188,
    8189,
    cloudConfigured ? null : 8888,
    basePort !== null && basePort !== cloudPort ? basePort : null,
  ].filter((value) => Number.isInteger(value) && value > 0 && value < 65536 && value !== cloudPort));
  const rowsFor = async (ports) => probe
    ? await Promise.all(ports.map(async (port) => {
      const report = await probeEndpoint(`http://127.0.0.1:${port}`, { timeoutMs: 2500, signal });
      return {
        baseUrl: report.baseUrl,
        reachable: report.reachable,
        error: report.error ?? null,
        comfyuiVersion: report.comfyuiVersion ?? null,
        devices: report.devices ?? [],
        queue: report.queue ?? null,
      };
    }))
    : ports.map((port) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      reachable: false,
      error: 'not probed',
      comfyuiVersion: null,
      devices: [],
      queue: null,
    }));
  const localRows = await rowsFor(localPorts);
  const cloudRows = cloudConfigured ? await rowsFor([cloudPort]) : [];
  const localUp = localRows.find((row) => row.reachable) ?? null;
  const cloudUp = cloudRows.find((row) => row.reachable) ?? null;
  return {
    local: {
      kind: 'local',
      label: '本地 ComfyUI',
      configured: localRows.length > 0,
      reachable: localUp !== null,
      baseUrl: localUp?.baseUrl ?? null,
      instances: localRows,
      note: localUp === null ? '本地 ComfyUI 未响应' : null,
    },
    cloud: {
      kind: 'cloud',
      label: '云端 ComfyUI',
      configured: cloudConfigured,
      reachable: cloudUp !== null,
      baseUrl: cloudUp?.baseUrl ?? null,
      instances: cloudRows,
      localPort: cloudPort,
      tunnel: cloud,
      note: cloudConfigured
        ? (cloudUp === null ? '已配置云端，但隧道当前未响应' : null)
        : '未配置云端 ComfyUI（可选）',
    },
  };
}

async function objectInfoFor(environment, { classes, signal }) {
  if (environment?.reachable !== true || typeof environment.baseUrl !== 'string') return null;
  try {
    return await readObjectInfo(environment.baseUrl, { classes, timeoutMs: 12000, signal });
  } catch {
    return null;
  }
}

/** Separate local/cloud video settings, while accepting the old shared shape. */
function videoSettingsByEnvironment(generation) {
  const saved = generation?.video ?? null;
  if (saved !== null && (saved.local !== undefined || saved.cloud !== undefined)) {
    return { local: saved.local ?? null, cloud: saved.cloud ?? null, legacy: false };
  }
  return { local: saved, cloud: saved, legacy: saved !== null };
}

/** The workflow used by cloud when the user asks for settings separate from local. */
function cloudCopyPath(localFile) {
  const stem = basename(localFile).replace(/\.json$/iu, '');
  return join(dirname(localFile), `${stem}（云端）.json`);
}

function optionsForEnvironment(info, controls, model) {
  const modelOptions = unique(controls.model === null
    ? []
    : comboOptions(info, controls.model.type, controls.model.widget));
  if (typeof model === 'string' && model.length > 0 && !modelOptions.includes(model)) modelOptions.unshift(model);
  const schedulerOptions = unique([
    controls.scheduler?.scheduler,
    ...comboOptions(info, controls.scheduler?.type ?? 'BasicScheduler', 'scheduler'),
  ].filter((value) => typeof value === 'string' && value.length > 0));
  return {
    modelOptions,
    schedulerOptions,
  };
}

function normalizedMode(mode, saved, control) {
  const defaults = SAMPLING_STEPS[mode];
  const firstPassSteps = Number.isInteger(saved?.firstPassSteps)
    ? saved.firstPassSteps
    : defaults.transitionStep;
  const secondPassSteps = Number.isInteger(saved?.secondPassSteps)
    ? saved.secondPassSteps
    : (Number.isInteger(saved?.totalSteps)
      ? Math.max(0, saved.totalSteps - firstPassSteps)
      : defaults.steps - defaults.transitionStep);
  const scheduler = typeof saved?.scheduler === 'string' && saved.scheduler.length > 0
    ? saved.scheduler
    : (control.scheduler?.scheduler ?? 'beta');
  return {
    totalSteps: firstPassSteps + secondPassSteps,
    firstPassSteps,
    secondPassSteps,
    scheduler,
  };
}

function defaultWorkflowForTask(taskId, candidates) {
  if (taskId === 'text-to-image') {
    return candidates.find((entry) => /krea2.*文生图|文生图.*krea2/iu.test(entry.name))
      ?? candidates.find((entry) => /文生图/iu.test(entry.name))
      ?? candidates[0]
      ?? null;
  }
  if (taskId === 'upscale-image') {
    return candidates.find((entry) => isImageUpscaleWorkflow(entry))
      ?? candidates.find((entry) => /SeedVR2|ImageUpscale|图像.*放大|图像.*超分/iu.test(entry.name))
      ?? candidates.find((entry) => isVosr2Workflow(entry))
      ?? candidates[0]
      ?? null;
  }
  if (taskId === 'upscale-video') {
    return candidates.find((entry) => isVideoUpscaleWorkflow(entry))
      ?? candidates.find((entry) => /SeedVR2Video|VideoUpscale|视频.*放大|视频.*超分/iu.test(entry.name))
      ?? candidates.find((entry) => isVosr2Workflow(entry))
      ?? candidates[0]
      ?? null;
  }
  return candidates[0] ?? null;
}

async function firstRunnableH3File(items = []) {
  for (const item of items) {
    if (!/H3/iu.test(item.relativePath ?? item.name)
      && !(item.capabilities ?? []).some((tag) => /video/iu.test(tag))) continue;
    const graph = await readFile(item.file, 'utf8').then(JSON.parse).catch(() => null);
    if (graph === null) continue;
    if (inspectH3WorkflowControls(graph).capability.runnable === true) return item.file;
  }
  return null;
}

function defaultTaskSettings(generation, inventories, environments) {
  const tasks = { local: {}, cloud: {} };
  for (const task of GENERATION_TASKS) {
    if (task.selectable !== true) continue;
    for (const kind of ['local', 'cloud']) {
      const configured = environments[kind]?.configured === true;
      if (!configured) {
        tasks[kind][task.id] = '';
        continue;
      }
      const items = inventories[kind]?.items ?? [];
      const files = new Set(items.map((item) => item.file));
      const candidates = items
        .filter((item) => workflowMatchesTask(item, task.id))
        .map(summarizeWorkflow);
      const saved = generation?.tasks?.[kind]?.[task.id] ?? null;
      const fallback = defaultWorkflowForTask(task.id, candidates);
      tasks[kind][task.id] = files.has(saved) ? saved : (fallback?.file ?? '');
    }
  }
  return tasks;
}

function taskEndpoints(generation, config, environments) {
  const fallback = environments.cloud.configured
    ? (config.preferInstance === 'local' ? 'local' : 'cloud')
    : 'local';
  const videoRecommendation = videoEndpointRecommendation(environments);
  return Object.fromEntries(GENERATION_TASKS.map((task) => {
    const saved = generation?.tasks?.endpoints?.[task.id];
    if (saved === 'cloud' || saved === 'local') return [task.id, saved];
    if (task.id === 'video-generation' && videoRecommendation.belowRecommended && environments.cloud.configured) {
      return [task.id, 'cloud'];
    }
    return [task.id, fallback];
  }));
}

/**
 * VRAM changes the recommendation, never the permission to run.
 *
 * 16GB is the practical comfort line for this H3 graph, not a capability switch. Below it the
 * default should move to cloud when available, but an explicit local choice must survive and
 * the UI must keep both endpoints selectable.
 */
export function videoEndpointRecommendation(environments = {}) {
  const readings = (environments.local?.instances ?? [])
    .flatMap((instance) => instance.devices ?? [])
    .map((device) => Number(device.vramTotalGb))
    .filter((value) => Number.isFinite(value) && value > 0);
  const localVramGb = readings.length === 0 ? null : Math.max(...readings);
  const belowRecommended = localVramGb !== null && localVramGb < 16;
  const cloudConfigured = environments.cloud?.configured === true;
  return {
    localVramGb,
    recommendedMinimumGb: 16,
    belowRecommended,
    recommendedEndpoint: belowRecommended && cloudConfigured ? 'cloud' : 'local',
    hardBlocked: false,
  };
}

/**
 * Read the global configuration, current instance status and the editable video controls.
 */
export async function readGenerationConfiguration(config = {}, {
  signal,
  env = process.env,
  probe = true,
} = {}) {
  const { state } = await readState(env);
  const [inventory, environments] = await Promise.all([
    workflowInventory(config, state, env),
    environmentStatus(config, { signal, probe }),
  ]);
  const cloudInventory = await cloudWorkflowInventory(environments.cloud, { signal, env });
  const inventories = { local: inventory, cloud: cloudInventory };
  const generation = state.generation ?? null;
  const promptSources = await readPromptSourceConfiguration({ skillDir: config.skillDir, env });
  const tasks = GENERATION_TASKS.map((task) => {
    const localWorkflows = inventory.items.map((item) => summarizeWorkflow(item, task.id));
    const cloudWorkflows = cloudInventory.items.map((item) => summarizeWorkflow(item, task.id));
    return {
      ...task,
      workflows: localWorkflows,
      environmentWorkflows: {
        local: localWorkflows,
        cloud: cloudWorkflows,
      },
    };
  });
  const settingsTasks = defaultTaskSettings(generation, inventories, environments);
  const settingsEndpoints = taskEndpoints(generation, config, environments);

  const savedVideo = videoSettingsByEnvironment(generation);
  const video = {
    workflow: null,
    controls: null,
    error: null,
    environments: {},
    recommendation: videoEndpointRecommendation(environments),
  };
  const videoSettings = { local: null, cloud: null };
  try {
    const preferredLocal = savedVideo.local?.workflow ?? null;
    let localWorkflow = null;
    if (typeof preferredLocal === 'string' && preferredLocal.length > 0) {
      try {
        if ((await stat(preferredLocal)).isFile()) localWorkflow = preferredLocal;
      } catch {
        localWorkflow = null;
      }
    }
    localWorkflow = localWorkflow ?? await findH3Workflow(config);
    const localGraph = JSON.parse(await readFile(localWorkflow, 'utf8'));
    const localControls = inspectH3WorkflowControls(localGraph);

    const savedCloudWorkflow = savedVideo.cloud?.workflow ?? null;
    let cloudWorkflow = null;
    const savedCloudIsRemote = typeof savedCloudWorkflow === 'string'
      && cloudInventory.items.some((item) => item.file === savedCloudWorkflow);
    let savedCloudFile = null;
    if (typeof savedCloudWorkflow === 'string' && savedCloudWorkflow.length > 0) {
      try {
        if ((await stat(savedCloudWorkflow)).isFile()) savedCloudFile = savedCloudWorkflow;
      } catch {
        savedCloudFile = null;
      }
    }
    if (savedCloudIsRemote) cloudWorkflow = savedCloudFile;
    cloudWorkflow = cloudWorkflow ?? await firstRunnableH3File(cloudInventory.items);
    cloudWorkflow = cloudWorkflow ?? savedCloudFile;
    cloudWorkflow = cloudWorkflow ?? cloudCopyPath(localWorkflow);
    if (cloudWorkflow === localWorkflow) cloudWorkflow = cloudCopyPath(localWorkflow);

    const cloudGraph = await readFile(cloudWorkflow, 'utf8').then(JSON.parse).catch(() => localGraph);
    const controlsByKind = {
      local: localControls,
      cloud: inspectH3WorkflowControls(cloudGraph),
    };
    const classes = unique([
      ...Object.values(controlsByKind).map((controls) => controls.model?.type),
      'BasicScheduler',
    ].filter((value) => typeof value === 'string'));
    const [localInfo, cloudInfo] = await Promise.all([
      objectInfoFor(environments.local, { classes, signal }),
      objectInfoFor(environments.cloud, { classes, signal }),
    ]);
    for (const [kind, info] of [['local', localInfo], ['cloud', cloudInfo]]) {
      const saved = savedVideo[kind] ?? {};
      const workflow = kind === 'local' ? localWorkflow : cloudWorkflow;
      const controls = controlsByKind[kind];
      let exists = false;
      try {
        exists = (await stat(workflow)).isFile();
      } catch {
        exists = false;
      }
      const model = typeof saved.model === 'string' && saved.model.length > 0
        ? saved.model
        : (controls.model?.value ?? null);
      const options = optionsForEnvironment(info, controls, model);
      const modes = {
        drama: normalizedMode('drama', saved.modes?.drama, controls),
        action: normalizedMode('action', saved.modes?.action, controls),
      };
      const writeMode = saved.writeMode === 'action' ? 'action' : 'drama';
      video.environments[kind] = {
        kind,
        workflow: { file: workflow, name: basename(workflow), exists, willCreate: !exists },
        controls,
        model,
        modes,
        writeMode,
        modelOptions: options.modelOptions,
        schedulerOptions: options.schedulerOptions,
      };
      videoSettings[kind] = { workflow, model, modes, writeMode };
    }
    video.workflow = { file: localWorkflow, name: basename(localWorkflow) };
    video.controls = localControls;
  } catch (error) {
    const message = String(error?.message ?? error);
    video.error = message;
    for (const kind of ['local', 'cloud']) {
      const saved = savedVideo[kind] ?? {};
      const modes = {
        drama: normalizedMode('drama', saved.modes?.drama, { scheduler: null, transition: null }),
        action: normalizedMode('action', saved.modes?.action, { scheduler: null, transition: null }),
      };
      video.environments[kind] = {
        kind,
        workflow: typeof saved.workflow === 'string' && saved.workflow.length > 0
          ? { file: saved.workflow, name: basename(saved.workflow), exists: false, willCreate: false }
          : null,
        controls: null,
        model: saved.model ?? null,
        modes,
        writeMode: saved.writeMode === 'action' ? 'action' : 'drama',
        modelOptions: saved.model === null || saved.model === undefined ? [] : [saved.model],
        schedulerOptions: unique([modes.drama.scheduler, modes.action.scheduler]),
        error: message,
      };
      videoSettings[kind] = {
        workflow: saved.workflow ?? null,
        model: saved.model ?? null,
        modes,
        writeMode: saved.writeMode === 'action' ? 'action' : 'drama',
      };
    }
  }

  return {
    workflowDirectory: inventory.dir,
    workflowDirectories: inventory.directories ?? [],
    workflowSource: inventory.source,
    workflowEnvironments: {
      local: {
        dir: inventory.dir,
        directories: inventory.directories ?? [],
        source: inventory.source,
        error: inventory.error ?? null,
      },
      cloud: {
        dir: cloudInventory.dir,
        source: cloudInventory.source,
        error: cloudInventory.error ?? null,
      },
    },
    scannedAt: inventory.scannedAt,
    workflowError: inventory.error ?? null,
    tasks,
    promptSources,
    settings: {
      tasks: settingsTasks,
      endpoints: settingsEndpoints,
      video: videoSettings,
      promptSource: { selected: promptSources.selected },
    },
    environments,
    video,
    savedAt: [savedVideo.local?.updatedAt, savedVideo.cloud?.updatedAt]
      .filter((value) => typeof value === 'string')
      .sort()
      .at(-1) ?? null,
  };
}

function validateTaskSelections(taskSettings, inventories, environments) {
  const normalized = { local: {}, cloud: {} };
  for (const kind of ['local', 'cloud']) {
    const items = inventories[kind]?.items ?? [];
    for (const [taskId, file] of Object.entries(taskSettings?.[kind] ?? {})) {
      const task = TASK_BY_ID.get(taskId);
      if (task === undefined || task.selectable !== true) continue;
      if (typeof file !== 'string' || file.length === 0) {
        normalized[kind][taskId] = '';
        continue;
      }
      if (!items.some((item) => item.file === file) && !(kind === 'cloud' && environments.cloud?.configured !== true)) {
        throw new Error(`${task.label}的工作流文件不存在：${basename(file)}`);
      }
      normalized[kind][taskId] = file;
    }
  }
  return normalized;
}

function validateTaskEndpoints(endpoints) {
  return Object.fromEntries(GENERATION_TASKS.map((task) => [
    task.id,
    endpoints?.[task.id] === 'cloud' ? 'cloud' : 'local',
  ]));
}

function validateMode(label, mode, allowedSchedulers) {
  const firstPassSteps = mode?.firstPassSteps;
  const secondPassSteps = Number.isInteger(mode?.secondPassSteps)
    ? mode.secondPassSteps
    : (Number.isInteger(mode?.totalSteps) && Number.isInteger(firstPassSteps)
      ? mode.totalSteps - firstPassSteps
      : null);
  if (!Number.isInteger(firstPassSteps) || firstPassSteps < 1) {
    throw new Error(`${label}一采步数必须大于等于 1`);
  }
  if (!Number.isInteger(secondPassSteps) || secondPassSteps < 1) {
    throw new Error(`${label}二采步数必须大于等于 1`);
  }
  const totalSteps = firstPassSteps + secondPassSteps;
  if (totalSteps > 200) throw new Error(`${label}总步数不能超过 200`);
  if (typeof mode?.scheduler !== 'string' || mode.scheduler.trim().length === 0) {
    throw new Error(`${label}基础调度器不能为空`);
  }
  if (allowedSchedulers.length > 0 && !allowedSchedulers.includes(mode.scheduler)) {
    throw new Error(`${label}基础调度器“${mode.scheduler}”不在当前实例提供列表中`);
  }
  return {
    totalSteps,
    firstPassSteps,
    secondPassSteps,
    scheduler: mode.scheduler,
  };
}

export const WORKFLOW_BACKUP_LIMIT = 7;

function backupDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep the newest configured number of daily backups for one workflow file. */
export async function pruneWorkflowBackups(file, { keep = WORKFLOW_BACKUP_LIMIT } = {}) {
  const prefix = `${basename(file)}.bak-dsh-config-`;
  let names = [];
  try {
    names = (await readdir(dirname(file), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { removed: [] };
  }
  const over = names.slice(0, Math.max(0, names.length - keep));
  const removed = [];
  for (const name of over) {
    const path = join(dirname(file), name);
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed };
}

async function writeWorkflowAtomic(file, graph, { now = new Date() } = {}) {
  const original = await readFile(file, 'utf8');
  const backup = `${file}.bak-dsh-config-${backupDay(now)}`;
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const temp = `${file}.${process.pid}.${stamp}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  let backupCreated = false;
  await writeFile(backup, original, { encoding: 'utf8', flag: 'wx' }).then(
    () => { backupCreated = true; },
    (error) => { if (error?.code !== 'EEXIST') throw error; },
  );
  await pruneWorkflowBackups(file);
  try {
    await writeFile(temp, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { backup, backupCreated };
}

/**
 * Save task workflow choices and update the video workflow file.
 */
export async function saveGenerationConfiguration(config = {}, settings = {}, {
  signal,
  env = process.env,
  probe = true,
} = {}) {
  const { state } = await readState(env);
  const promptSource = await validatePromptSelection(settings?.promptSource?.selected, {
    skillDir: config.skillDir,
    env,
  });
  const environments = await environmentStatus(config, { signal, probe });
  const inventories = {
    local: await workflowInventory(config, state, env),
    cloud: await cloudWorkflowInventory(environments.cloud, { signal, env }),
  };
  const tasks = validateTaskSelections(settings?.tasks ?? {}, inventories, environments);
  const endpoints = validateTaskEndpoints(settings?.endpoints ?? {});
  const incomingVideo = settings?.video?.local !== undefined || settings?.video?.cloud !== undefined
    ? settings.video
    : { local: settings?.video ?? null, cloud: settings?.video ?? null };
  const localSettings = incomingVideo.local ?? incomingVideo.cloud ?? null;
  const cloudSettings = incomingVideo.cloud ?? incomingVideo.local ?? null;
  if (localSettings === null && cloudSettings === null) throw new Error('保存视频配置时缺少本地或云端设置');
  const fallbackWorkflow = await findH3Workflow(config);
  const localWorkflow = typeof localSettings?.workflow === 'string' && localSettings.workflow.length > 0
    ? localSettings.workflow
    : fallbackWorkflow;
  const fallbackCloudWorkflow = await firstRunnableH3File(inventories.cloud.items);
  let cloudWorkflow = typeof cloudSettings?.workflow === 'string' && cloudSettings.workflow.length > 0
    ? cloudSettings.workflow
    : (fallbackCloudWorkflow ?? cloudCopyPath(localWorkflow));
  if (cloudWorkflow === localWorkflow) cloudWorkflow = cloudCopyPath(localWorkflow);
  try {
    if (!(await stat(localWorkflow)).isFile()) throw new Error(`本地视频工作流不存在：${localWorkflow}`);
  } catch {
    throw new Error(`本地视频工作流不存在：${localWorkflow}`);
  }
  let cloudExists = false;
  try {
    cloudExists = (await stat(cloudWorkflow)).isFile();
  } catch {
    cloudExists = false;
  }
  if (!cloudExists) {
    try {
      await mkdir(dirname(cloudWorkflow), { recursive: true });
      await writeFile(cloudWorkflow, await readFile(localWorkflow, 'utf8'), 'utf8');
    } catch (error) {
      throw new Error(`无法建立云端视频工作流副本：${String(error?.message ?? error)}`);
    }
  }
  const localGraph = JSON.parse(await readFile(localWorkflow, 'utf8'));
  const cloudGraph = JSON.parse(await readFile(cloudWorkflow, 'utf8'));
  const localControls = inspectH3WorkflowControls(localGraph);
  const cloudControls = inspectH3WorkflowControls(cloudGraph);
  if (localControls.capability.runnable !== true) {
    throw new Error(`本地视频工作流不可用：缺少 ${localControls.capability.missing.join('、')}`);
  }
  if (cloudControls.capability.runnable !== true) {
    throw new Error(`云端视频工作流不可用：缺少 ${cloudControls.capability.missing.join('、')}`);
  }
  const classes = unique([
    localControls.model?.type,
    cloudControls.model?.type,
    'BasicScheduler',
  ].filter(Boolean));
  const [localInfo, cloudInfo] = await Promise.all([
    objectInfoFor(environments.local, { classes, signal }),
    objectInfoFor(environments.cloud, { classes, signal }),
  ]);
  const updatedAt = new Date().toISOString();
  const savedEnvironments = {};
  for (const [kind, graph, controls, info, configured] of [
    ['local', localGraph, localControls, localInfo, localSettings],
    ['cloud', cloudGraph, cloudControls, cloudInfo, cloudSettings],
  ]) {
    const schedulerOptions = unique(comboOptions(info, controls.scheduler?.type ?? 'BasicScheduler', 'scheduler'));
    const modes = {
      drama: validateMode(`${kind === 'local' ? '本地' : '云端'}文戏`, configured?.modes?.drama, schedulerOptions),
      action: validateMode(`${kind === 'local' ? '本地' : '云端'}武打`, configured?.modes?.action, schedulerOptions),
    };
    const writeMode = configured?.writeMode === 'action' ? 'action' : 'drama';
    const model = typeof configured?.model === 'string' && configured.model.length > 0
      ? configured.model
      : (controls.model?.value ?? null);
    if (model !== null) {
      const modelOptions = unique(comboOptions(info, controls.model?.type, controls.model?.widget));
      if (modelOptions.length > 0 && !modelOptions.includes(model)) {
        throw new Error(`${kind === 'local' ? '本地' : '云端'}视频模型“${model}”不在当前实例提供列表中`);
      }
    }
    const active = modes[writeMode];
    const applied = applyH3WorkflowControls(graph, {
      model,
      scheduler: active.scheduler,
      totalSteps: active.totalSteps,
      firstPassSteps: active.firstPassSteps,
      writeMode,
    });
    const file = kind === 'local' ? localWorkflow : cloudWorkflow;
    const backup = await writeWorkflowAtomic(file, applied.graph);
    savedEnvironments[kind] = {
      workflow: file,
      model,
      modes,
      writeMode,
      updatedAt,
      backup: backup.backup,
    };
  }
  await updateState((next) => {
    const currentPromptSources = next.generation?.promptSources ?? {};
    next.generation = {
      tasks: { ...tasks, endpoints },
      video: savedEnvironments,
      promptSources: { ...currentPromptSources, selected: promptSource.id },
    };
    return next;
  }, env);
  return {
    saved: true,
    updatedAt,
    promptSource: {
      selected: promptSource.id,
      label: promptSource.label,
      file: promptSource.file,
    },
    workflows: {
      local: savedEnvironments.local.workflow,
      cloud: savedEnvironments.cloud.workflow,
    },
    backups: {
      local: savedEnvironments.local.backup,
      cloud: savedEnvironments.cloud.backup,
    },
    writeModes: {
      local: savedEnvironments.local.writeMode,
      cloud: savedEnvironments.cloud.writeMode,
    },
    config: await readGenerationConfiguration(config, { signal, env, probe }),
  };
}

/**
 * Read one candidate H3 graph without saving anything.
 *
 * Changing the workflow dropdown used to leave the model and scheduler lists showing values
 * from the previously saved graph until the whole configuration was saved and reopened. This
 * is the lightweight second half of that interaction: parse the newly selected file and query
 * only the environment that will run it.
 */
export async function inspectVideoWorkflowConfiguration(config = {}, {
  workflow,
  kind = 'local',
  signal,
  env = process.env,
  probe = true,
} = {}) {
  const environmentKind = kind === 'cloud' ? 'cloud' : 'local';
  if (typeof workflow !== 'string' || workflow.trim().length === 0) throw new Error('请选择一个视频工作流');
  const { state } = await readState(env);
  const environments = await environmentStatus(config, { signal, probe });
  const inventory = environmentKind === 'cloud'
    ? await cloudWorkflowInventory(environments.cloud, { signal, env })
    : await workflowInventory(config, state, env);
  const item = inventory.items.find((entry) => entry.file === workflow);
  if (item === undefined) throw new Error(`视频工作流不在已索引目录中：${basename(workflow)}`);
  const graph = JSON.parse(await readFile(item.file, 'utf8'));
  const controls = inspectH3WorkflowControls(graph);
  if (controls.capability.runnable !== true) {
    throw new Error(`视频工作流不可用：缺少 ${controls.capability.missing.join('、')}`);
  }
  const classes = unique([controls.model?.type, 'BasicScheduler'].filter(Boolean));
  const info = await objectInfoFor(environments[environmentKind], { classes, signal });
  const model = controls.model?.value ?? null;
  const options = optionsForEnvironment(info, controls, model);
  return {
    kind: environmentKind,
    workflow: {
      file: item.file,
      name: item.name,
      relativePath: item.relativePath ?? item.name,
    },
    controls,
    model,
    modelOptions: options.modelOptions,
    schedulerOptions: options.schedulerOptions,
    modes: {
      drama: normalizedMode('drama', null, controls),
      action: normalizedMode('action', null, controls),
    },
  };
}

/**
 * Resolve which execution side a task should use.
 */
export async function resolveConfiguredEndpoint(taskId, { env = process.env, config = null } = {}) {
  const { state } = await readState(env);
  const endpoint = state.generation?.tasks?.endpoints?.[taskId];
  if (endpoint === 'cloud' || endpoint === 'local') return endpoint;
  if (config !== null) {
    const defaults = await readGenerationConfiguration(config, { env, probe: false }).catch(() => null);
    const fallback = defaults?.settings?.endpoints?.[taskId];
    if (fallback === 'cloud' || fallback === 'local') return fallback;
  }
  return null;
}

/**
 * Resolve a configured workflow for a task on one environment.
 *
 * Returns null when no preference is stored, so callers can keep their old workflow argument
 * behaviour and only use this when the user intentionally omitted a workflow.
 */
export async function resolveConfiguredWorkflow(config, taskId, kind, { env = process.env } = {}) {
  const { state } = await readState(env);
  const environment = kind === 'cloud' ? 'cloud' : 'local';
  let file = state.generation?.tasks?.[environment]?.[taskId] ?? null;
  if (typeof file !== 'string' || file.length === 0) {
    const defaults = await readGenerationConfiguration(config, { env, probe: false }).catch(() => null);
    file = defaults?.settings?.tasks?.[environment]?.[taskId] ?? null;
  }
  if (typeof file !== 'string' || file.length === 0) return null;
  try {
    if (!(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}
