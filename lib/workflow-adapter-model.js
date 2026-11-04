/**
 * Model-assisted semantic adapters for compatible-but-unknown ComfyUI workflows.
 *
 * The model is allowed to choose EXISTING node/input targets for task-facing values. It is
 * never allowed to add nodes, change class types, replace model files or submit a prompt.
 * Every binding is validated against the converted graph before it can be applied.
 *
 * @module dsh-plugin-short-drama-director/lib/workflow-adapter-model
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock } from './file-lock.js';
import { stateDir } from './state.js';

export const WORKFLOW_ADAPTER_SCHEMA_VERSION = 1;

const MODEL_PATCH_ROLES = Object.freeze([
  'aspectRatio',
  'megapixels',
  'width',
  'height',
  'seed',
  'filenamePrefix',
  'scale',
  'longSide',
]);
const ARRAY_BINDING_ROLES = new Set(['media', ...MODEL_PATCH_ROLES, 'switch']);
const MODEL_FILE_RE = /\.(?:safetensors|ckpt|pt|pth|gguf|onnx|bin)$/iu;
const adapterCache = new Map();

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inputSpecs(definition) {
  return {
    ...(definition?.input?.required ?? {}),
    ...(definition?.input?.optional ?? {}),
  };
}

function specType(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return 'COMBO';
  return typeof spec[0] === 'string' ? spec[0] : null;
}

function specOptions(spec) {
  if (!Array.isArray(spec)) return [];
  const values = Array.isArray(spec[1]?.options)
    ? spec[1].options
    : (Array.isArray(spec[0]) ? spec[0] : []);
  return values.filter((value) => typeof value === 'string').slice(0, 40);
}

function currentInputType(value) {
  if (typeof value === 'string') return MODEL_FILE_RE.test(value) ? 'MODEL_FILE' : 'STRING';
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (Array.isArray(value)) return 'LINK';
  if (value === null) return 'NULL';
  return typeof value;
}

function compactValue(value) {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (Array.isArray(value)) return ['<linked>', ...value.slice(1)];
  return value;
}

function nodeCatalog(prompt, objectInfo) {
  const classes = {};
  for (const node of Object.values(prompt ?? {})) {
    const className = String(node?.class_type ?? '');
    if (className.length === 0 || classes[className] !== undefined) continue;
    const specs = inputSpecs(objectInfo?.[className]);
    classes[className] = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [
      name,
      {
        type: specType(spec),
        options: specOptions(spec),
      },
    ]));
  }
  const nodes = Object.entries(prompt ?? {}).map(([id, node]) => ({
    id,
    classType: node.class_type,
    inputs: Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, value]) => [
      name,
      currentInputType(value),
    ])),
    current: Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, value]) => [
      name,
      compactValue(value),
    ])),
  }));
  return { nodes, classes };
}

function normalizeNodeBinding(raw, prompt, { requireString = null, requireNumber = false, requireBoolean = false } = {}) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('绑定项必须是对象');
  const nodeId = String(raw.nodeId ?? raw.node ?? '').trim();
  const input = String(raw.input ?? raw.inputName ?? '').trim();
  if (nodeId.length === 0 || input.length === 0) throw new Error('绑定项缺 nodeId 或 input');
  const node = prompt?.[nodeId];
  if (node === undefined) throw new Error(`节点 ${nodeId} 不存在`);
  if (!Object.hasOwn(node.inputs ?? {}, input)) throw new Error(`节点 ${nodeId} (${node.class_type}) 没有输入 ${input}`);
  const value = node.inputs[input];
  const type = currentInputType(value);
  if (type === 'MODEL_FILE' || type === 'LINK' || type === 'NULL') {
    throw new Error(`节点 ${nodeId}.${input} 不是可写标量，不能作为模型适配目标`);
  }
  if (requireString !== null && type !== requireString) throw new Error(`节点 ${nodeId}.${input} 应为 ${requireString}，实际是 ${type}`);
  if (requireNumber && type !== 'NUMBER') throw new Error(`节点 ${nodeId}.${input} 应为 NUMBER，实际是 ${type}`);
  if (requireBoolean && type !== 'BOOLEAN') throw new Error(`节点 ${nodeId}.${input} 应为 BOOLEAN，实际是 ${type}`);
  return { nodeId, input };
}

function normalizeBindingList(raw, prompt, normalizeEntry) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('多目标绑定必须是数组');
  if (raw.length > 64) throw new Error('单个语义角色最多允许 64 个绑定');
  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const normalized = normalizeEntry(entry);
    if (normalized === null) continue;
    const key = `${normalized.nodeId}.${normalized.input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Validate the model's semantic bindings against the actual converted API prompt.
 */
export function validateWorkflowAdapterBindings(raw, {
  prompt,
  task,
  mediaCount = 0,
  roleValues = {},
} = {}) {
  const source = raw?.bindings ?? raw;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('模型适配结果没有 bindings 对象');
  }
  for (const key of Object.keys(source)) {
    if (key !== 'prompt' && !ARRAY_BINDING_ROLES.has(key)) throw new Error(`未知适配字段：${key}`);
  }
  const promptBinding = source.prompt === null || source.prompt === undefined
    ? null
    : normalizeNodeBinding(source.prompt, prompt, { requireString: 'STRING' });
  if (promptBinding !== null
    && /filename_prefix|(^|_)image$|(^|_)video$|(^|_)audio$|model|unet|lora|ckpt|seed|steps|aspect|megapixel|^width$|^height$|switch/iu.test(promptBinding.input)) {
    throw new Error(`节点 ${promptBinding.nodeId}.${promptBinding.input} 看起来不是提示词输入`);
  }
  if (task !== 'upscale-image' && task !== 'upscale-video' && promptBinding === null) {
    throw new Error('模型没有为提示词找到可写字符串节点');
  }
  const media = normalizeBindingList(source.media, prompt, (entry) => {
    const normalized = normalizeNodeBinding(entry, prompt, { requireString: 'STRING' });
    if (normalized === null) return null;
    const mediaIndex = Number(entry.mediaIndex ?? entry.index);
    if (!Number.isInteger(mediaIndex) || mediaIndex < 1) throw new Error('media 绑定需要从 1 开始的 mediaIndex');
    return { ...normalized, mediaIndex };
  });
  for (let index = 1; index <= mediaCount; index += 1) {
    if (!media.some((entry) => entry.mediaIndex === index)) {
      throw new Error(`模型没有为第 ${index} 张媒体文件找到上传输入`);
    }
  }
  const numberBindings = {};
  for (const role of ['megapixels', 'width', 'height', 'seed', 'scale', 'longSide']) {
    numberBindings[role] = normalizeBindingList(source[role], prompt, (entry) =>
      normalizeNodeBinding(entry, prompt, { requireNumber: true }));
  }
  const aspectRatio = normalizeBindingList(source.aspectRatio, prompt, (entry) =>
    normalizeNodeBinding(entry, prompt, { requireString: 'STRING' }));
  const filenamePrefix = normalizeBindingList(source.filenamePrefix, prompt, (entry) =>
    normalizeNodeBinding(entry, prompt, { requireString: 'STRING' }));
  if (filenamePrefix.some((binding) => binding.input !== 'filename_prefix')) {
    throw new Error('filenamePrefix 只能绑定 filename_prefix 输入');
  }
  const switchBindings = normalizeBindingList(source.switch, prompt, (entry) => {
    const normalized = normalizeNodeBinding(entry, prompt, { requireBoolean: true });
    if (normalized === null) return null;
    if (!['reference', 'explicit'].includes(entry.when)) throw new Error('switch.when 只能是 reference 或 explicit');
    if (typeof entry.whenTrue !== 'boolean') throw new Error('switch.whenTrue 必须是布尔值');
    return { ...normalized, when: entry.when, whenTrue: entry.whenTrue };
  });
  if (typeof roleValues.aspectRatio === 'string' && roleValues.aspectRatio.length > 0
    && aspectRatio.length === 0
    && !(numberBindings.width.length > 0 && numberBindings.height.length > 0)) {
    throw new Error('请求了明确画幅，但模型没有绑定 aspectRatio、width/height');
  }
  if (task === 'upscale-video'
    && typeof roleValues.targetResolution === 'string'
    && roleValues.targetResolution.length > 0
    && numberBindings.longSide.length === 0
    && numberBindings.width.length === 0
    && numberBindings.height.length === 0) {
    throw new Error('视频超分请求了目标清晰度，但模型没有绑定 resize size 或宽高');
  }
  return {
    prompt: promptBinding,
    media,
    aspectRatio,
    filenamePrefix,
    switch: switchBindings,
    ...numberBindings,
  };
}

function dimensionsFromRatio(aspectRatio, megapixels) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u.exec(String(aspectRatio ?? '').trim());
  if (match === null) return null;
  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!(left > 0 && right > 0)) return null;
  const pixels = Math.max(0.1, Number(megapixels) || 0.9) * 1_000_000;
  const width = Math.max(64, Math.round(Math.sqrt(pixels * left / right) / 8) * 8);
  const height = Math.max(64, Math.round(Math.sqrt(pixels * right / left) / 8) * 8);
  return { width, height };
}

/**
 * Apply one already-validated adapter to the current request values.
 */
export function applyWorkflowAdapter(adapter, {
  prompt,
  mediaPaths = [],
  roleValues = {},
  preservePromptWhitespace = false,
} = {}) {
  const bindings = adapter.bindings ?? adapter;
  const patch = {};
  const mediaInputs = [];
  const seedTargets = [];
  const setPatch = (role, binding, value) => {
    if (binding === null || binding === undefined || value === undefined || value === null) return;
    patch[`${binding.nodeId}.${binding.input}`] = value;
    if (role === 'seed') seedTargets.push({ node: binding.nodeId, input: binding.input });
  };
  if (bindings.prompt !== null && bindings.prompt !== undefined) {
    const promptText = preservePromptWhitespace ? String(roleValues.prompt ?? '') : String(roleValues.prompt ?? '').trim();
    if (promptText.length === 0) throw new Error('适配器需要提示词，但本次提示词为空');
    setPatch('prompt', bindings.prompt, promptText);
  }
  for (const binding of bindings.media ?? []) {
    const filePath = mediaPaths[binding.mediaIndex - 1];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error(`适配器需要第 ${binding.mediaIndex} 个媒体文件，但本次没有提供`);
    }
    mediaInputs.push({
      nodeId: binding.nodeId,
      input: binding.input,
      filePath,
      kind: roleValues.mediaKind ?? 'image',
    });
  }
  for (const binding of bindings.aspectRatio ?? []) setPatch('aspectRatio', binding, roleValues.aspectRatio);
  for (const binding of bindings.megapixels ?? []) setPatch('megapixels', binding, roleValues.megapixels);
  for (const binding of bindings.seed ?? []) setPatch('seed', binding, roleValues.seed);
  for (const binding of bindings.filenamePrefix ?? []) setPatch('filenamePrefix', binding, roleValues.filenamePrefix);
  for (const binding of bindings.scale ?? []) setPatch('scale', binding, roleValues.scale);
  for (const binding of bindings.longSide ?? []) setPatch('longSide', binding, roleValues.longSide);
  const dimensions = dimensionsFromRatio(roleValues.aspectRatio, roleValues.megapixels);
  for (const binding of bindings.width ?? []) setPatch('width', binding, dimensions?.width ?? roleValues.width);
  for (const binding of bindings.height ?? []) setPatch('height', binding, dimensions?.height ?? roleValues.height);
  for (const binding of bindings.switch ?? []) {
    const active = binding.when === 'reference' ? roleValues.explicitCanvas !== true : roleValues.explicitCanvas === true;
    setPatch('switch', binding, active ? binding.whenTrue : !binding.whenTrue);
  }
  return {
    patch,
    inputs: {},
    mediaInputs,
    promptNodeId: bindings.prompt?.nodeId ?? null,
    imageCount: (bindings.media ?? []).length,
    seed: roleValues.seed,
    seedTargets,
    adaptedByModel: true,
    adapterId: adapter.id ?? null,
  };
}

function adapterPath(env = process.env) {
  return join(stateDir(env), 'user-data', 'workflow-adapters.json');
}

function signatureFor({ task, workflowHash, instanceHash }) {
  return hashText(`${task}\0${workflowHash}\0${instanceHash}`);
}

function normalizeStoredAdapter(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.task !== 'string'
    || typeof raw.workflowHash !== 'string' || typeof raw.instanceHash !== 'string'
    || raw.bindings === null || typeof raw.bindings !== 'object') return null;
  return raw;
}

async function readAdapterStore(env) {
  const path = adapterPath(env);
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      path,
      store: {
        schemaVersion: Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : WORKFLOW_ADAPTER_SCHEMA_VERSION,
        entries: Array.isArray(raw?.entries) ? raw.entries.map(normalizeStoredAdapter).filter(Boolean) : [],
      },
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path, store: { schemaVersion: WORKFLOW_ADAPTER_SCHEMA_VERSION, entries: [] } };
    }
    return { path, store: { schemaVersion: WORKFLOW_ADAPTER_SCHEMA_VERSION, entries: [] }, error: String(error?.message ?? error) };
  }
}

async function saveAdapter(adapter, env) {
  const path = adapterPath(env);
  const key = signatureFor(adapter);
  adapterCache.set(key, adapter);
  try {
    await withFileLock(`${path}.lock`, async () => {
      const snapshot = await readAdapterStore(env);
      if (snapshot.error) throw new Error(`适配器存储无法解析：${snapshot.error}`);
      const entries = snapshot.store.entries.filter((entry) => signatureFor(entry) !== key);
      entries.push(adapter);
      const store = {
        schemaVersion: WORKFLOW_ADAPTER_SCHEMA_VERSION,
        entries: entries.slice(-100),
      };
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    return { path, warning: null };
  } catch (error) {
    return { path, warning: `适配器已在本进程生效，但写入用户层失败：${String(error?.message ?? error)}` };
  }
}

async function loadAdapter({ task, workflowHash, instanceHash, env }) {
  const key = signatureFor({ task, workflowHash, instanceHash });
  if (adapterCache.has(key)) return adapterCache.get(key);
  const snapshot = await readAdapterStore(env);
  const adapter = snapshot.store.entries.find((entry) =>
    entry.task === task && entry.workflowHash === workflowHash && entry.instanceHash === instanceHash);
  if (adapter !== undefined) adapterCache.set(key, adapter);
  return adapter ?? null;
}

function parseJsonReply(text) {
  const value = String(text ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch (error) {
    throw new Error(`模型适配结果不是合法 JSON：${String(error?.message ?? error)}`);
  }
}

async function requestAdapterFromModel({
  task,
  prompt,
  objectInfo,
  roleValues,
  mediaCount,
  ctx,
  modelRoute,
  sessionId,
  signal,
}) {
  const llm = ctx?.get?.('llm');
  const selected = modelRoute ?? ctx?.get?.('agentDefaultModel')?.currentSelection?.();
  const route = selected?.provider && selected?.model
    ? { provider: selected.provider, model: selected.model }
    : (selected?.config?.provider && selected?.config?.model
      ? { provider: selected.config.provider, model: selected.config.model }
      : null);
  if (!llm || route === null) {
    throw new Error('工作流不兼容，且当前会话没有可调用的模型来生成适配器。原工作流未提交');
  }
  const catalog = nodeCatalog(prompt, objectInfo);
  const request = {
    task,
    mediaCount,
    roleValues,
    nodes: catalog.nodes,
    classInputs: catalog.classes,
  };
  const system = [
    'You are adapting an unknown but existing ComfyUI API workflow to the current task.',
    'Return JSON only, with shape {"bindings":{...},"reason":"..."}.',
    'Never invent node ids, input names, nodes or class types. Never return a full workflow.',
    'Never bind model-loader inputs or any input whose current value is a model filename.',
    'prompt is {"nodeId":"...","input":"..."}; media is an ordered array of {"mediaIndex":1,"nodeId":"...","input":"image"}.',
    'aspectRatio and filenamePrefix are arrays of {"nodeId":"...","input":"..."}.',
    'megapixels, width, height, seed, scale and longSide are arrays of numeric {"nodeId":"...","input":"..."} inputs.',
    'switch is an array of {"nodeId":"...","input":"...","when":"reference"|"explicit","whenTrue":true|false}.',
    'Bind every supplied media item to exactly one existing writable string input, in order.',
    'For image editing, find the actual text input used by the image encoder/sampler chain and the actual reference image loader inputs.',
    'For text-to-image, find the prompt input that feeds the sampler positive conditioning.',
    'Only include roles that are actually needed and supported by the graph. Omit unsupported optional roles.',
    'The code will reject any binding that does not exist or has the wrong scalar type.',
  ].join(' ');
  const assembler = new BlockAssembler();
  const timeout = AbortSignal.timeout(180000);
  const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for await (const chunk of llm.stream({
    ...route,
    system,
    sessionId,
    temperature: 0,
    maxTokens: 4096,
    signal: callSignal,
    messages: [createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(request) }],
      source: { kind: 'short-drama-workflow-adapter' },
    })],
  })) assembler.push(chunk);
  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseJsonReply(text);
}

/**
 * Resolve a model-assisted adapter: reuse one for the same workflow+instance, otherwise ask
 * the current session model, validate it, persist it, and apply it to this request.
 */
export async function adaptGeneralWorkflowWithModel({
  task,
  graph,
  prompt,
  objectInfo,
  promptText,
  mediaPaths = [],
  settings = {},
  preservePromptWhitespace = false,
  roleOverrides = {},
  ctx = null,
  modelRoute = null,
  sessionId = null,
  signal = null,
  env = process.env,
} = {}) {
  const workflowHash = hashText(stableJson(graph));
  const instanceHash = hashText(stableJson(objectInfo));
  const identity = { task, workflowHash, instanceHash };
  const explicitCanvas = typeof settings?.aspectRatio === 'string' && settings.aspectRatio.trim().length > 0;
  const seed = Number.isInteger(settings?.seed) ? settings.seed : Math.floor(Math.random() * (2 ** 31));
  const roleValues = {
    prompt: promptText,
    mediaKind: task === 'upscale-video' ? 'video' : 'image',
    aspectRatio: typeof settings?.aspectRatio === 'string' ? settings.aspectRatio.trim() : '',
    megapixels: Number.isFinite(Number(settings?.megapixels)) ? Number(settings.megapixels) : undefined,
    seed,
    filenamePrefix: typeof settings?.filenamePrefix === 'string' ? settings.filenamePrefix : '',
    scale: Number.isFinite(Number(roleOverrides.scale ?? settings?.scale))
      ? Number(roleOverrides.scale ?? settings.scale)
      : undefined,
    longSide: Number.isFinite(Number(roleOverrides.longSide)) ? Number(roleOverrides.longSide) : undefined,
    targetResolution: typeof settings?.targetResolution === 'string' ? settings.targetResolution : '',
    explicitCanvas,
  };
  let adapter = await loadAdapter({ ...identity, env });
  let cached = adapter !== null;
  let persistenceWarning = null;
  if (adapter !== null) {
    try {
      const result = applyWorkflowAdapter(adapter, {
        prompt,
        mediaPaths,
        roleValues,
        preservePromptWhitespace,
      });
      return { adapter, result, cached: true, persistenceWarning };
    } catch {
      adapter = null;
      cached = false;
    }
  }
  const reply = await requestAdapterFromModel({
    task,
    prompt,
    objectInfo,
    roleValues,
    mediaCount: mediaPaths.length,
    ctx,
    modelRoute,
    sessionId,
    signal,
  });
  const bindings = validateWorkflowAdapterBindings(reply.bindings ?? reply, {
    prompt,
    task,
    mediaCount: mediaPaths.length,
    roleValues,
  });
  const now = new Date().toISOString();
  adapter = {
    id: `wfa_${signatureFor(identity).slice(0, 20)}`,
    schemaVersion: WORKFLOW_ADAPTER_SCHEMA_VERSION,
    task,
    workflowHash,
    instanceHash,
    bindings,
    // Do not persist model-authored free text: it can accidentally echo prompt or project data.
    reason: '当前会话模型选择了现有节点输入；已通过结构与类型校验',
    createdAt: now,
    updatedAt: now,
    source: 'session-model',
  };
  const saved = await saveAdapter(adapter, env);
  persistenceWarning = saved.warning;
  const result = applyWorkflowAdapter(adapter, {
    prompt,
    mediaPaths,
    roleValues,
    preservePromptWhitespace,
  });
  return { adapter, result, cached, persistenceWarning };
}

export function workflowAdapterPath(env = process.env) {
  return adapterPath(env);
}
