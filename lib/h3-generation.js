import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runComfyWorkflow, comfyJobTool } from './tools.js';
import { readObjectInfo } from './comfy.js';
import { selectInstance } from './launch.js';
import { resolveWorkflowDirectories } from './env-discovery.js';
import { readState } from './state.js';
import { scanWorkflows } from './workflows.js';

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'];
const watchers = new Set();
function watchSubmitted(result, config, context) {
  if (!result.promptId || !['pending', 'running', 'queued', 'unknown'].includes(result.state)) return;
  const key = `${result.baseUrl}#${result.promptId}`;
  if (watchers.has(key)) return;
  watchers.add(key);
  const controller = new AbortController();
  context.ctx?.effect?.(() => () => controller.abort(), `h3-watch:${result.promptId}`);
  const poll = async (remaining) => {
    if (controller.signal.aborted || remaining <= 0) { watchers.delete(key); return; }
    try {
      const policy = typeof context.getPolicy === 'function' ? context.getPolicy() : undefined;
      const report = await comfyJobTool(config).execute({ prompt_id: result.promptId, base_url: result.baseUrl }, {
        signal: controller.signal,
        ...(policy === undefined || policy === null ? {} : { sandboxPolicy: policy }),
        ...(typeof context.getPolicy === 'function' ? { getPolicy: context.getPolicy } : {}),
      });
      if (report.jobs?.some((job) => ['completed', 'error'].includes(job.state))) { watchers.delete(key); return; }
    } catch { /* Keep the known prompt ID; a network error never creates another submission. */ }
    const timer = setTimeout(() => poll(remaining - 1), 10000);
    timer.unref?.();
  };
  const timer = setTimeout(() => poll(2160), 5000);
  timer.unref?.();
}
/**
 * Resolution, expressed the way the WORKFLOW expresses it.
 *
 * `ResolutionSelector` is driven by a megapixel budget, not by a named tier, so the tier the user picks
 * has to be translated into the number that actually produces it. These are the values the user
 * calibrated by hand on this workflow: 0.5 → 480p, 0.9 → 720p, 1.5 → 1080p. They are NOT derivable from
 * the short edge - 0.9 mp at 9:16 lands near 720p but not exactly on it, and the workflow's own note
 * table disagrees with the tier naming - so they are recorded as a table rather than computed.
 *
 * The aspect ratio is passed through to the same node unchanged, so a ratio the node supports needs no
 * entry here.
 */
export const RESOLUTION_MEGAPIXELS = Object.freeze({ '480p': 0.5, '720p': 0.9, '1080p': 1.5 });

/**
 * Sampling steps per mode: `steps` is the TOTAL the basic scheduler runs, `transitionStep` is
 * how many of those the first pass (一采) takes.
 *
 * The gap between them is the second pass (二采), so 文戏 12/8 leaves 4 refinement steps and
 * 武打 14/10 leaves the same 4 - the difference in total is spent on the first pass, where an
 * action shot needs it. Kept as one table because these two numbers must move together: a first
 * pass longer than the total is not a schedule, it is a workflow that silently ignores one of them.
 */
export const SAMPLING_STEPS = Object.freeze({
  drama: { steps: 12, transitionStep: 8 },
  action: { steps: 14, transitionStep: 10 },
});

/** The node group whose LoRA chain is switched on for 武打. Matched by group TITLE, not by node id. */
const ACTION_GROUP_TITLE = /武打/u;

/**
 * Project settings are defaults; a per-shot choice is an explicit override. Getting this order
 * backwards made a 9:16 selection arrive at the workflow as the project's 16:9 default.
 */
export function h3SettingsWithProjectDefaults(projectSettings = {}, overrides = {}) {
  return {
    ...(projectSettings?.aspectRatio ? { aspectRatio: projectSettings.aspectRatio } : {}),
    ...(projectSettings?.resolution ? { resolution: projectSettings.resolution } : {}),
    ...(overrides ?? {}),
  };
}

export function videoDimensions(settings = {}) {
  const { resolution = '720p', aspectRatio = '9:16', mode = 'drama' } = settings;
  if (!Object.hasOwn(RESOLUTION_MEGAPIXELS, resolution)) throw new Error(`不支持的清晰度：${String(resolution)}`);
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`不支持的宽高比：${String(aspectRatio)}`);
  if (!Object.hasOwn(SAMPLING_STEPS, mode)) throw new Error(`不支持的生成模式：${String(mode)}`);
  const megapixels = RESOLUTION_MEGAPIXELS[resolution];
  const [w, h] = aspectRatio.split(':').map(Number);
  // Reported for the user's benefit only - the instance computes the real size from `megapixels`, so this
  // must not be presented as the authoritative figure.
  //
  // `megapixels` counts TOTAL pixels, not a scale factor: the workflow author's table shows
  // megapixels 0.5 → 960×544 (0.52 MP) and 2.0 → 1920×1088 (2.09 MP), i.e. pixels ≈ megapixels × 1e6 with
  // the ratio preserved and the result snapped to `multiple`. So the linear scale is
  // sqrt(megapixels × 1e6 / (w × h)), and dropping that 1e6 would shrink the estimate by 1000×.
  const unit = Math.sqrt((megapixels * 1_000_000) / (w * h));
  return {
    megapixels,
    resolution,
    aspectRatio,
    mode,
    width: Math.round((w * unit) / 16) * 16,
    height: Math.round((h * unit) / 16) * 16,
  };
}

/**
 * The exact `aspect_ratio` string the instance's ResolutionSelector accepts for a ratio.
 *
 * The node labels its options by ITS convention - `9:16 (Portrait Widescreen)`, `2:3 (Portrait Photo)`,
 * `21:9 (Ultrawide)` - and those labels exist nowhere in a saved graph: `widgets_values` holds the chosen
 * string, not the list it came from. Inferring the suffix from the saved value is therefore wrong, because
 * the suffix is not the same for every ratio: copying `(Widescreen)` from `16:9` onto `9:16` produces
 * `9:16 (Widescreen)`, which the node does not offer and the instance rejects.
 *
 * So the list is asked of the instance. When ResolutionSelector is not a required class there - another
 * workflow, or a slider-based size control - the bare ratio comes back and the graph decides, rather than
 * this function inventing a label.
 */
export async function aspectRatioLabelFor(baseUrl, ratio, { timeoutMs = 30000, signal } = {}) {
  const objectInfo = await readObjectInfo(baseUrl, { classes: ['ResolutionSelector'], timeoutMs, signal });
  const declared = objectInfo?.ResolutionSelector?.input;
  if (declared === undefined || declared === null) return ratio;
  const spec = { ...(declared.required ?? {}), ...(declared.optional ?? {}) }.aspect_ratio;
  // `/object_info` reports a combo two ways: a dynamic one as `["COMBO", {"options": [...]}]` and a plain
  // one as `[["a", "b"], {}]`. Only the second form was read at first, so the list always came back empty,
  // the bare ratio was returned, and the instance rejected every submission that carried a ratio - the
  // exact failure this function exists to prevent. It failed silently, because returning the input
  // unchanged looks like "this instance has no opinion". Both forms are read now.
  const options = Array.isArray(spec?.[1]?.options)
    ? spec[1].options
    : Array.isArray(spec?.[0]) ? spec[0] : [];
  const usable = options.filter((option) => typeof option === 'string');
  if (usable.length === 0) return ratio;
  const exact = usable.find((option) => option === ratio)
    ?? usable.find((option) => option.startsWith(`${ratio} `) || option.startsWith(`${ratio}(`));
  if (exact === undefined) throw new Error(`分辨率选择器不支持 ${ratio}；它提供的是 ${usable.join('、')}`);
  return exact;
}

/**
 * Set a node's named widget AND keep the positional `widgets_values` array in step with it.
 *
 * A saved UI graph carries both, and the converter reads the NAMED form while ComfyUI's own frontend
 * writes the positional one. Changing only one of them produces a graph that looks right in the file and
 * sends the old value to the instance - or the reverse, depending on which side reads it.
 */
/**
 * What a saved graph can actually be driven into, judged by the same rules the generator uses.
 *
 * This exists because workflow selection used to be a FILENAME sort (`ReferenceToVideo` first) and
 * the capability assertions lived inside the generator. The two disagreed: the auto-picked file was
 * one with no duration node, so the panel's generate button failed on a fresh install - while
 * another workflow beside it could run. Selecting by filename is guessing; selecting by capability
 * is checking.
 *
 * Pure and side-effect free, so the selftest and the acceptance scan use exactly this function.
 *
 * @returns `{ runnable, missing, nodes }` - `missing` is a short list of capability keys.
 */
export function describeH3Workflow(graph) {
  const live = (graph?.nodes ?? []).filter((node) => (node.mode ?? 0) === 0);
  const reference = live.filter((node) => node.type === 'MiniMaxH3ReferenceToVideo');
  const selector = live.find((node) => /ResolutionSelector/u.test(String(node.type ?? '')));
  const scheduler = live.find((node) => /BasicScheduler/u.test(String(node.type ?? '')));
  const duration = findDurationNode(live);
  const transition = findTransitionTarget(live);
  const missing = [];
  if (reference.length !== 1) missing.push('一个启用的 MiniMaxH3ReferenceToVideo 节点');
  if (selector === undefined) missing.push('分辨率选择器');
  if (scheduler === undefined) missing.push('基础调度器（BasicScheduler）');
  if (duration === null) missing.push('视频时长节点（标题含“时长/duration/seconds”）');
  if (transition === null) missing.push('一采步数（transition_step 或 SplitSigmas.step）');
  return {
    runnable: missing.length === 0,
    missing,
    nodes: {
      reference: reference[0]?.id ?? null,
      selector: selector?.id ?? null,
      scheduler: scheduler?.id ?? null,
      duration: duration === null ? null : { id: duration.node.id, widget: duration.widget },
      transition: transition === null ? null : { id: transition.node.id, widget: transition.widget },
    },
  };
}

/**
 * The node holding the clip's duration, in either saved shape.
 *
 * Matched two ways on purpose: by the value widget plus a title that says it is the duration, and
 * by the CLASS the user can see in the UI (`PrimitiveFloat`) plus the same title. The user's words
 * were "工作流明明就有视频时长节点，标题叫视频时长（秒），可搜索节点叫 PrimitiveFloat" - so the class
 * name is part of how people identify this node, not an implementation detail.
 */
function findDurationNode(live) {
  const titled = (node) => /时长|duration|seconds/iu.test(String(node.title ?? node.properties?.title ?? ''));
  const byValue = live.filter((node) => titled(node) && hasWidget(node, 'value'));
  if (byValue.length > 0) return { node: byValue[0], widget: 'value' };
  const byClass = live.filter((node) => /^Primitive(Float|Int|Number)$/u.test(String(node.type ?? '')) && titled(node) && hasWidget(node, 'value'));
  if (byClass.length > 0) return { node: byClass[0], widget: 'value' };
  return null;
}

/**
 * Where the first pass's step count lives.
 *
 * `SelfLiftH3Sampler.transition_step` is the shape the 终极篇 workflow uses. The 优化版 expresses the
 * same thing as `SplitSigmas.step` (the split point IS the first pass), so a workflow that uses the
 * standard splitter is accepted instead of being called "missing transition_step".
 */
function findTransitionTarget(live) {
  const direct = live.filter((node) => hasWidget(node, 'transition_step'));
  if (direct.length > 0) return { node: direct[0], widget: 'transition_step' };
  const split = live.filter((node) => /SplitSigmas/u.test(String(node.type ?? '')) && hasWidget(node, 'step'));
  if (split.length > 0) return { node: split[0], widget: 'step' };
  return null;
}

/** Loader widgets that identify the video model this workflow actually runs. */
const VIDEO_MODEL_LOADERS = [
  { test: /^UNETLoader$/iu, widget: 'unet_name' },
  { test: /^UnetLoaderGGUF$/iu, widget: 'unet_name' },
  { test: /^CheckpointLoader/iu, widget: 'ckpt_name' },
  { test: /^(DiffusionModelLoader|ModelLoader)$/iu, widget: 'model_name' },
];

function widgetValue(node, name) {
  const named = node?.widgets_values_named;
  if (named !== undefined && named !== null && Object.hasOwn(named, name)) return named[name];
  const at = widgetNamesOf(node).indexOf(name);
  return at >= 0 && Array.isArray(node?.widgets_values) ? node.widgets_values[at] : undefined;
}

function positionalWidgetValue(node, name) {
  const at = widgetNamesOf(node).indexOf(name);
  return at >= 0 && Array.isArray(node?.widgets_values) ? node.widgets_values[at] : undefined;
}

/**
 * What the global configuration panel may edit in a video workflow.
 *
 * Only the model loader, BasicScheduler and the first-pass split are exposed. Those are the
 * fields the H3 graph can change without rewriting its sampling architecture.
 */
export function inspectH3WorkflowControls(graph) {
  const live = (graph?.nodes ?? []).filter((node) => (node.mode ?? 0) === 0);
  let model = null;
  for (const loader of VIDEO_MODEL_LOADERS) {
    const node = live.find((entry) => loader.test.test(String(entry.type ?? '')) && hasWidget(entry, loader.widget));
    if (node === undefined) continue;
    model = {
      nodeId: node.id,
      type: node.type,
      widget: loader.widget,
      // The UI workflow can hold two different spellings after an outside edit. The positional
      // array is what the user sees in the ComfyUI canvas and what the workflow was actually
      // switched to, while the named map may still carry the previous export. Prefer the visible
      // positional value and normalise both forms when saving.
      value: positionalWidgetValue(node, loader.widget) ?? widgetValue(node, loader.widget) ?? null,
      namedValue: node.widgets_values_named?.[loader.widget] ?? null,
      positionalValue: positionalWidgetValue(node, loader.widget) ?? null,
    };
    break;
  }
  const schedulerNode = live.find((node) => /BasicScheduler/u.test(String(node.type ?? ''))
    && hasWidget(node, 'steps') && hasWidget(node, 'scheduler'));
  const transition = findTransitionTarget(live);
  return {
    capability: describeH3Workflow(graph),
    model,
    scheduler: schedulerNode === undefined ? null : {
      nodeId: schedulerNode.id,
      type: schedulerNode.type,
      steps: widgetValue(schedulerNode, 'steps') ?? null,
      scheduler: widgetValue(schedulerNode, 'scheduler') ?? null,
    },
    transition: transition === null ? null : {
      nodeId: transition.node.id,
      type: transition.node.type,
      widget: transition.widget,
      value: widgetValue(transition.node, transition.widget) ?? null,
    },
  };
}

/** Pick the saved video configuration for the instance that will execute the run. */
export function videoConfigForEnvironment(generation, kind) {
  const video = generation?.video ?? null;
  if (video === null) return null;
  if (video.local !== undefined || video.cloud !== undefined) {
    return video[kind === 'cloud' ? 'cloud' : 'local'] ?? null;
  }
  // Old shared shape. It remains readable so upgrading the plugin does not lose a saved model.
  return video;
}

/**
 * Apply the editable video settings to a workflow graph.
 *
 * A saved workflow can only hold one value per node, so `writeMode` decides which mode's
 * numbers are written into the file. Both modes stay in global state and are applied again
 * per generation by `prepareH3Graph`.
 */
export function applyH3WorkflowControls(graph, {
  model = null,
  scheduler = null,
  totalSteps,
  firstPassSteps,
  writeMode = 'drama',
}) {
  const next = structuredClone(graph);
  const controls = inspectH3WorkflowControls(next);
  if (controls.capability.runnable !== true) {
    throw new Error(`视频工作流不可用：缺少 ${controls.capability.missing.join('、')}`);
  }
  if (controls.scheduler === null) throw new Error('视频工作流缺少启用的基础调度器');
  if (controls.transition === null) throw new Error('视频工作流缺少一采步数节点');
  if (!Number.isInteger(totalSteps) || totalSteps < 2 || totalSteps > 200) {
    throw new Error('总步数必须是 2 到 200 的整数');
  }
  if (!Number.isInteger(firstPassSteps) || firstPassSteps < 1 || firstPassSteps >= totalSteps) {
    throw new Error('一采步数必须大于等于 1，且小于总步数');
  }
  if (model !== null && typeof model !== 'string') throw new Error('视频模型必须是字符串或 null');
  if (scheduler !== null && (typeof scheduler !== 'string' || scheduler.trim().length === 0)) {
    throw new Error('基础调度器不能为空');
  }
  if (model !== null) {
    if (controls.model === null) throw new Error('当前视频工作流没有可写的模型加载器');
    const node = next.nodes.find((entry) => entry.id === controls.model.nodeId);
    setWidget(node, controls.model.widget, model, {});
  }
  const schedulerNode = next.nodes.find((entry) => entry.id === controls.scheduler.nodeId);
  setWidget(schedulerNode, 'steps', totalSteps, {});
  if (scheduler !== null) setWidget(schedulerNode, 'scheduler', scheduler, {});
  const transitionNode = next.nodes.find((entry) => entry.id === controls.transition.nodeId);
  setWidget(transitionNode, controls.transition.widget, firstPassSteps, {});
  return {
    graph: next,
    writeMode,
    secondPassSteps: totalSteps - firstPassSteps,
    controls: inspectH3WorkflowControls(next),
  };
}

/**
 * The widget a port exposes, or `undefined` when the port is a real link input.
 *
 * ComfyUI graphs come in two saved shapes and both are in use on real machines:
 *
 *  - NEW: the node carries `widgets_values_named` (a name → value map) as well as the array.
 *  - OLD: only the positional `widgets_values` array, with the names recoverable solely from the
 *    `inputs` order.
 *
 * Every predicate below used to require the named map, so an old-format workflow that plainly has
 * a `PrimitiveFloat` titled 「视频时长（秒）」 was reported as having no duration node - and the panel's
 * generate button refused to run on a workflow that works fine when opened in the UI.
 */
function widgetNameOfPort(port) {
  if (port === null || typeof port !== 'object') return undefined;
  if (port.widget !== undefined && port.widget !== null) {
    const name = port.widget.name ?? port.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  }
  return undefined;
}

/** Widget names in the order their values sit in `widgets_values`. */
function widgetNamesOf(node) {
  const names = [];
  for (const port of node.inputs ?? []) {
    const name = widgetNameOfPort(port);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Where a named widget's value lives on this node, or `null` when the node has no such widget. */
function widgetSlot(node, name) {
  const named = node.widgets_values_named;
  if (named !== undefined && named !== null && Object.hasOwn(named, name)) return { kind: 'named' };
  const at = widgetNamesOf(node).indexOf(name);
  if (at >= 0 && Array.isArray(node.widgets_values)) return { kind: 'positional', at };
  // A named map that lacks the key means the node does not have that widget; there is nothing to
  // fall back to, because an absent key is authoritative in the new format.
  return null;
}

/** Whether this node exposes a widget with that name, in either saved shape. */
export function hasWidget(node, name) {
  return widgetSlot(node, name) !== null;
}

/** Set one widget by name, writing BOTH storage forms so the converter and the UI agree. */
function setWidget(node, name, value, patch) {
  const slot = widgetSlot(node, name);
  if (slot === null) return false;
  if (slot.kind === 'named') {
    node.widgets_values_named[name] = value;
    if (Array.isArray(node.widgets_values)) {
      const at = widgetNamesOf(node).indexOf(name);
      if (at >= 0 && at < node.widgets_values.length) node.widgets_values[at] = value;
    }
  } else {
    // Old format only: the positional array IS the stored state, and the converter reads it.
    node.widgets_values[slot.at] = value;
    if (node.widgets_values_named !== undefined && node.widgets_values_named !== null) {
      node.widgets_values_named[name] = value;
    }
  }
  patch[`${node.id}.${name}`] = value;
  return true;
}

/**
 * Which nodes a titled group box contains.
 *
 * The 武打 LoRA chain is identified the way a person identifies it - by the box drawn around it - rather
 * than by node ids, so re-saving the workflow in ComfyUI does not silently point this at the wrong LoRAs.
 * A workflow with no such group reports that it cannot honour the request instead of quietly generating
 * 文戏 and calling it 武打.
 */
function nodesInGroup(graph, titlePattern) {
  const groups = (graph.groups ?? []).filter((group) => titlePattern.test(String(group.title ?? '')));
  if (groups.length === 0) return null;
  const inside = new Set();
  for (const group of groups) {
    const [x, y, w, h] = group.bounding ?? [];
    if (![x, y, w, h].every((value) => typeof value === 'number')) continue;
    for (const node of graph.nodes ?? []) {
      const [nx, ny] = node.pos ?? [];
      if (typeof nx !== 'number' || typeof ny !== 'number') continue;
      if (nx >= x && nx <= x + w && ny >= y && ny <= y + h) inside.add(node);
    }
  }
  return [...inside];
}

/** Clone the saved sampling path; replace only documented H3 prompt/size/reference inputs. */
export function prepareH3Graph(graph, {
  text,
  seconds,
  settings,
  references,
  requestId,
  aspectRatioLabel = null,
  samplingSteps = null,
  model = null,
}) {
  if (/@/u.test(text)) throw new Error('H3 正文不能含 @ 引用，请先同步为 H3 格式');
  // Whole seconds only. The model's frame counts are quantised (the workflow's own expression snaps them
  // to a stride), so a fractional request cannot be honoured exactly - and silently generating a
  // different length than the one asked for is worse than refusing it. The duration control offers whole
  // seconds for the same reason.
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw new Error('H3 大分镜时长必须是 4–15 秒的整数');
  const size = videoDimensions(settings);
  const prepared = structuredClone(graph);
  const patch = {};
  if (typeof model === 'string' && model.length > 0) {
    const modelControls = inspectH3WorkflowControls(prepared);
    if (modelControls.model !== null) {
      const modelNode = prepared.nodes.find((node) => node.id === modelControls.model.nodeId);
      setWidget(modelNode, modelControls.model.widget, model, patch);
    }
  }
  const targets = prepared.nodes?.filter((node) => node.type === 'MiniMaxH3ReferenceToVideo' && (node.mode ?? 0) === 0) ?? [];
  if (targets.length !== 1) throw new Error('工作流需有且只有一个启用的 MiniMaxH3ReferenceToVideo 节点');
  const target = targets[0];
  let nextNode = Math.max(0, ...prepared.nodes.map((node) => node.id)) + 1;
  let nextLink = Math.max(0, ...(prepared.links ?? []).map((link) => Array.isArray(link) ? link[0] : link.id)) + 1;

  // ---- resolution: the ResolutionSelector owns the size, so it is the node that changes ----
  //
  // `options.aspectRatioLabel` is the string the INSTANCE accepts for this ratio, which only the instance
  // knows (see `aspectRatioLabelFor`). Without it the bare ratio is written, and the node's own list is
  // checked when the graph happens to carry one.
  const selectors = prepared.nodes.filter((node) => (node.mode ?? 0) === 0 && /ResolutionSelector/u.test(node.type));
  if (selectors.length === 0) throw new Error('工作流缺少启用的分辨率选择器，无法按清晰度与宽高比设置尺寸');
  for (const selector of selectors) {
    const options = (selector.inputs ?? [])
      .filter((port) => (port.widget?.name ?? port.name) === 'aspect_ratio')
      .flatMap((port) => (Array.isArray(port.widget?.options) ? port.widget.options : []))
      .filter((option) => typeof option === 'string');
    if (options.length > 0 && !options.some((option) => option === size.aspectRatio || option.startsWith(`${size.aspectRatio} `) || option.startsWith(`${size.aspectRatio}(`))) {
      throw new Error(`分辨率选择器不支持 ${size.aspectRatio}；它提供的是 ${options.join('、')}`);
    }
    setWidget(selector, 'aspect_ratio', aspectRatioLabel ?? size.aspectRatio, patch);
    setWidget(selector, 'megapixels', size.megapixels, patch);
  }

  // ---- duration: the seconds node, which the workflow's expression turns into a legal frame count ----
  // Judged by `describeH3Workflow`, so selection and generation can never disagree about whether a
  // workflow has a duration node.
  const capability = describeH3Workflow(prepared);
  const durationTarget = findDurationNode(prepared.nodes?.filter((node) => (node.mode ?? 0) === 0) ?? []);
  if (durationTarget === null) {
    throw new Error(`工作流缺少视频时长节点（标题需含“时长”，可搜索节点通常是 PrimitiveFloat），无法按大分镜时长生成。这份工作流缺：${capability.missing.join('、')}`);
  }
  for (const node of prepared.nodes?.filter((item) => (item.mode ?? 0) === 0 && hasWidget(item, 'value') && /时长|duration|seconds/iu.test(String(item.title ?? item.properties?.title ?? ''))) ?? []) {
    setWidget(node, 'value', seconds, patch);
  }
  setWidget(durationTarget.node, durationTarget.widget, seconds, patch);

  // ---- steps: the basic scheduler is the TOTAL, transition_step is the first pass ----
  const defaults = SAMPLING_STEPS[size.mode];
  const steps = {
    steps: Number.isInteger(samplingSteps?.totalSteps)
      ? samplingSteps.totalSteps
      : (Number.isInteger(samplingSteps?.steps) ? samplingSteps.steps : defaults.steps),
    transitionStep: Number.isInteger(samplingSteps?.firstPassSteps)
      ? samplingSteps.firstPassSteps
      : (Number.isInteger(samplingSteps?.transitionStep) ? samplingSteps.transitionStep : defaults.transitionStep),
    scheduler: typeof samplingSteps?.scheduler === 'string' && samplingSteps.scheduler.length > 0
      ? samplingSteps.scheduler
      : null,
  };
  if (steps.steps < 2 || steps.steps > 200 || steps.transitionStep < 1 || steps.transitionStep >= steps.steps) {
    throw new Error(`采样步数配置无效：总步数 ${String(steps.steps)}，一采 ${String(steps.transitionStep)}`);
  }
  const schedulers = prepared.nodes.filter((node) => (node.mode ?? 0) === 0 && /BasicScheduler/u.test(node.type));
  if (schedulers.length === 0) throw new Error('工作流缺少启用的基础调度器，无法设置总步数');
  for (const node of schedulers) {
    setWidget(node, 'steps', steps.steps, patch);
    if (steps.scheduler !== null) setWidget(node, 'scheduler', steps.scheduler, patch);
  }
  // A workflow may express the first pass as `transition_step` (SelfLiftH3Sampler) or as the split
  // point of a standard `SplitSigmas`. Both are accepted; see `findTransitionTarget`.
  const transitionTarget = findTransitionTarget(prepared.nodes.filter((node) => (node.mode ?? 0) === 0));
  if (transitionTarget === null) throw new Error('工作流缺少一采步数（transition_step 或 SplitSigmas.step），无法设置一采步数');
  for (const node of prepared.nodes.filter((item) => (item.mode ?? 0) === 0
    && (hasWidget(item, 'transition_step') || (/SplitSigmas/u.test(String(item.type ?? '')) && hasWidget(item, 'step'))))) {
    setWidget(node, hasWidget(node, 'transition_step') ? 'transition_step' : 'step', steps.transitionStep, patch);
  }

  // ---- 武打: switch its LoRA chain ON by clearing the bypass ----
  //
  // The chain is already wired: base → dmad → MysticXXX → [武打 ×4] → attention → … The bypass on each
  // 武打 node is the only thing making those four inert, so clearing it IS "turning 武打 on" - no link is
  // created and each LoRA keeps the strength the workflow ships with.
  const combat = nodesInGroup(prepared, ACTION_GROUP_TITLE);
  if (combat === null) {
    if (size.mode === 'action') throw new Error('工作流里找不到「武打」分组，无法开启武打 LoRA');
  } else {
    for (const node of combat) {
      // The group also holds the slider that feeds one LoRA's strength; it needs the same treatment.
      //
      // `mode` is set on the NODE, not listed in `patch`: it is a node-level flag rather than one of the
      // class's inputs, and the patch map is validated against the instance's input list - so a mode entry
      // there is rejected as "no input mode" and blocks the whole submission.
      const wanted = size.mode === 'action' ? 0 : 4;
      if ((node.mode ?? 0) !== wanted) node.mode = wanted;
    }
  }

  const fpsNode = prepared.nodes.find((node) => (node.mode ?? 0) === 0 && /CreateVideo|VideoCombine/u.test(node.type));
  const fps = Number(fpsNode?.widgets_values_named?.fps ?? fpsNode?.widgets_values_named?.frame_rate ?? 24);
  if (!(fps > 0 && fps <= 120)) throw new Error('工作流输出帧率无效');
  // The workflow's own expression converts seconds into the model's legal frame counts, and this is the
  // same figure that expression starts from (fps × seconds, snapped to the model's stride). Reported so
  // the user can see what the duration became; the expression remains the authority on the final value.
  const length = Math.round((seconds * fps - 1) / 4) * 4 + 1;
  // H3 prompt text is authored source, not a template. Mode, references and canvas travel through
  // dedicated workflow inputs; the prompt string itself is submitted byte-for-byte.
  const values = { prompt: text };
  target.widgets_values_named = { ...(target.widgets_values_named ?? {}), ...values };
  for (const port of target.inputs ?? []) if (Object.hasOwn(values, port.name)) { port.link = null; port.widget = { name: port.name }; }
  const refPorts = (target.inputs ?? []).filter((port) => /^ref_(?:images|videos|audios|video_audios)\./u.test(port.name));
  const oldLinks = new Set(refPorts.map((port) => port.link).filter((id) => id != null));
  target.inputs = (target.inputs ?? []).filter((port) => !refPorts.includes(port));
  prepared.links = (prepared.links ?? []).filter((link) => !oldLinks.has(Array.isArray(link) ? link[0] : link.id));
  const normalizedReferences = Array.isArray(references) ? references : [];
  for (const reference of normalizedReferences) {
    if (typeof reference?.absolutePath !== 'string' || reference.absolutePath.length === 0) {
      throw new Error('H3 参考素材缺少本地文件路径');
    }
  }
  const pictures = normalizedReferences
    .filter((entry) => (entry.mediaType ?? 'Picture') === 'Picture')
    .sort((a, b) => a.referenceIndex - b.referenceIndex);
  const videos = normalizedReferences
    .filter((entry) => entry.mediaType === 'Video')
    .sort((a, b) => a.referenceIndex - b.referenceIndex);
  const audios = normalizedReferences
    .filter((entry) => entry.mediaType === 'Audio')
    .sort((a, b) => a.referenceIndex - b.referenceIndex);
  if (pictures.length > 9) throw new Error('当前 H3 工作流最多支持 9 张参考图片');
  if (videos.length > 3) throw new Error('当前 H3 工作流最多支持 3 段参考视频');
  if (audios.length > 3) throw new Error('当前 H3 工作流最多支持 3 段参考音频');
  if (pictures.length + videos.length + audios.length !== normalizedReferences.length) {
    throw new Error('H3 参考素材类型必须是 Picture、Video 或 Audio');
  }
  for (let index = 0; index < pictures.length; index += 1) {
    if (pictures[index].referenceIndex !== index + 1) throw new Error('H3 图片编号必须从 1 连续递增');
  }
  for (let index = 0; index < videos.length; index += 1) {
    if (videos[index].referenceIndex !== index + 1) throw new Error('H3 视频编号必须从 1 连续递增');
  }
  for (let index = 0; index < audios.length; index += 1) {
    if (audios[index].referenceIndex !== index + 1) throw new Error('H3 音频编号必须从 1 连续递增');
  }

  const inputs = {};
  const mediaInputs = [];
  const usedLoaderIds = new Set();
  for (const [index, reference] of pictures.entries()) {
    const id = nextNode++, link = nextLink++;
    prepared.nodes.push({ id, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [link] }], widgets_values: [''], widgets_values_named: { image: '' } });
    const slot = target.inputs.length;
    target.inputs.push({ name: `ref_images.ref_image_${index}`, type: 'IMAGE', link });
    prepared.links.push([link, id, 0, target.id, slot, 'IMAGE']);
    inputs[String(id)] = reference.absolutePath;
    usedLoaderIds.add(String(id));
  }

  const appendMediaReferences = ({ entries, templateType, portPrefix, portName, inputIndex, targetType, mediaKind }) => {
    if (entries.length === 0) return;
    const template = prepared.nodes.find((node) => node.type === templateType);
    if (template === undefined) {
      throw new Error(`当前 H3 工作流缺少 ${templateType}，无法绑定参考${mediaKind === 'video' ? '视频' : '音频'}`);
    }
    for (const [index, reference] of entries.entries()) {
      const id = nextNode++, link = nextLink++;
      const node = structuredClone(template);
      node.id = id;
      node.mode = 0;
      for (const input of node.inputs ?? []) input.link = null;
      for (const output of node.outputs ?? []) output.links = null;
      const outputIndex = (node.outputs ?? []).findIndex((port) => port.type === targetType);
      if (outputIndex < 0) throw new Error(`${templateType} 没有 ${targetType} 输出，无法连接 H3 参考槽`);
      node.outputs[outputIndex].links = [link];
      if (node.widgets_values_named !== null && typeof node.widgets_values_named === 'object' && !Array.isArray(node.widgets_values_named)) {
        node.widgets_values_named = { ...node.widgets_values_named, [portName]: mediaKind === 'audio' ? 'None' : '' };
        if (templateType === 'LoadAudio') node.widgets_values_named.upload = '';
      }
      if (node.widgets_values !== null && typeof node.widgets_values === 'object' && !Array.isArray(node.widgets_values)) {
        node.widgets_values = { ...node.widgets_values, [portName]: mediaKind === 'audio' ? 'None' : '' };
      } else if (Array.isArray(node.widgets_values)) {
        const widgetIndex = (node.inputs ?? []).findIndex((port) => port.name === portName);
        if (widgetIndex >= 0) node.widgets_values[widgetIndex] = mediaKind === 'audio' ? 'None' : '';
        if (templateType === 'LoadAudio') {
          const uploadIndex = (node.inputs ?? []).findIndex((port) => port.name === 'upload');
          if (uploadIndex >= 0) node.widgets_values[uploadIndex] = '';
        }
      }
      prepared.nodes.push(node);
      const slot = target.inputs.length;
      target.inputs.push({ name: `${portPrefix}.${inputIndex}${index}`, type: targetType, link });
      prepared.links.push([link, id, outputIndex, target.id, slot, targetType]);
      mediaInputs.push({ nodeId: String(id), input: portName, filePath: reference.absolutePath, kind: mediaKind });
      usedLoaderIds.add(String(id));
    }
  };

  appendMediaReferences({
    entries: videos,
    templateType: 'VHS_LoadVideo',
    portPrefix: 'ref_videos',
    portName: 'video',
    inputIndex: 'ref_video_',
    targetType: 'IMAGE',
    mediaKind: 'video',
  });
  appendMediaReferences({
    entries: audios,
    templateType: 'LoadAudio',
    portPrefix: 'ref_audios',
    portName: 'audio',
    inputIndex: 'ref_audio_',
    targetType: 'AUDIO',
    mediaKind: 'audio',
  });

  // Unused media loaders must not request stale files from an earlier project.
  for (const node of prepared.nodes) {
    if (/^(?:LoadImage|VHS_LoadVideo|LoadAudio)$/u.test(String(node.type ?? ''))
      && !usedLoaderIds.has(String(node.id))) node.mode = 2;
  }
  const seed = Number.parseInt(createHash('sha256').update(requestId).digest('hex').slice(0, 12), 16);
  for (const node of prepared.nodes) if ((node.mode ?? 0) === 0) {
    const named = node.widgets_values_named;
    if (named && Object.hasOwn(named, 'seed')) { named.seed = seed; patch[`${node.id}.seed`] = seed; }
    if (named && Object.hasOwn(named, 'noise_seed')) { named.noise_seed = seed; patch[`${node.id}.noise_seed`] = seed; }
  }
  return { graph: prepared, inputs, mediaInputs, patch, size, fps, length, steps };
}

/**
 * Pick the H3 workflow to run, by CAPABILITY rather than by file name.
 *
 * The old selection sorted candidates by name and took the first that merely had a reference
 * node. On the machine this was written for, that selected `MiniMaxH3-ReferenceToVideo-linux.json`
 * - a workflow with no duration node - so the panel's generate button failed with
 * 「工作流缺少视频时长节点」 on a fresh install, while a workflow that runs fine sat in the same folder.
 *
 * Now every candidate is judged with `describeH3Workflow`, the same function the generator uses,
 * so selection and generation cannot disagree. Among the runnable ones the most recently edited
 * wins (that is the copy the user has been working on); when nothing is runnable the error names
 * what each file is missing, because "no workflow found" leaves the user with nothing to do.
 */
export async function findH3Workflow(config) {
  if (config.h3Workflow) return config.h3Workflow;
  // Every discovered install contributes candidates. Picking a single "best" install is right
  // for choosing a launcher, but wrong for finding workflows: the H3 graph can live in the
  // second install's nested folder.
  const resolved = await resolveWorkflowDirectories(config);
  const directories = resolved.directories.map((entry) => entry.dir);
  const rejected = [];
  const runnable = [];
  for (const directory of directories) {
    const scanned = await scanWorkflows(directory).catch(() => null);
    if (scanned === null) continue;
    for (const item of scanned.items) {
      if (!/H3/iu.test(item.relativePath ?? item.name)
        && !(item.capabilities ?? []).some((tag) => /video/iu.test(tag))) continue;
      const file = item.file;
      const graph = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (graph === null) {
        rejected.push({ file, missing: ['这个文件不是可读的 ComfyUI 工作流 JSON'] });
        continue;
      }
      const described = describeH3Workflow(graph);
      if (described.runnable) {
        const info = await stat(file).catch(() => null);
        runnable.push({ file, name: item.name, modifiedAt: info?.mtimeMs ?? 0 });
      } else {
        rejected.push({ file, missing: described.missing });
      }
    }
  }
  if (runnable.length > 0) {
    // Newest first: the copy the user last edited is the one they mean.
    runnable.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));
    return runnable[0].file;
  }
  if (rejected.length === 0) throw new Error('未找到 H3 视频工作流。请在插件设置里填写 h3Workflow，或把工作流放进 ComfyUI 的 workflows 目录。');
  const detail = rejected.map((entry) => `${basename(entry.file)}：缺 ${entry.missing.join('、')}`).join('；');
  throw new Error(`找到 ${rejected.length} 个 H3 工作流，但没有一个能按大分镜时长生成 —— ${detail}。修好其中一个，或在插件设置里用 h3Workflow 指定可用的那份。`);
}

export async function generateH3({ text, seconds, references, projectRoot, shotId, episodeNumber = null, blockNumber = null, settings, requestId }, context) {
  const config = { ...(context.config ?? {}), ctx: context.ctx ?? context.config?.ctx ?? null };
  if (typeof requestId !== 'string' || !/^[\w-]{8,160}$/u.test(requestId)) throw new Error('生成请求缺少有效 requestId');
  const { state } = await readState();
  // The execution instance decides whether the local or cloud video configuration applies.
  const savedEndpoint = state.generation?.tasks?.endpoints?.['video-generation'];
  const configuredEndpoint = savedEndpoint === 'cloud' ? 'cloud' : savedEndpoint === 'local' ? 'local' : null;
  const chosen = await selectInstance(config, { baseUrl: null, prefer: configuredEndpoint ?? config.preferInstance ?? 'auto' }).catch(() => null);
  const reachableKind = chosen?.kind === 'local' || chosen?.kind === 'cloud' ? chosen.kind : null;
  if (configuredEndpoint !== null && reachableKind === null) {
    throw new Error(`视频生成配置为使用${configuredEndpoint === 'local' ? '本地' : '云端'} ComfyUI，但该实例当前不可达。请启动目标实例或到全局配置切换运行端`);
  }
  if (configuredEndpoint !== null && reachableKind !== configuredEndpoint) {
    throw new Error(`视频生成配置为使用${configuredEndpoint === 'local' ? '本地' : '云端'} ComfyUI，但当前可达的是${reachableKind === 'local' ? '本地' : '云端'}。请启动目标实例或到全局配置切换运行端`);
  }
  const instanceKind = chosen?.kind === 'cloud' ? 'cloud' : 'local';
  const savedVideo = videoConfigForEnvironment(state.generation, instanceKind);
  const savedWorkflow = savedVideo?.workflow;
  const workflow = await findH3Workflow(
    typeof savedWorkflow === 'string' && savedWorkflow.length > 0
      ? { ...config, h3Workflow: savedWorkflow }
      : config,
  );
  const graph = JSON.parse(await readFile(workflow, 'utf8'));
  // ONE instance, chosen once.
  //
  // `runComfyWorkflow` picks an instance itself, and with `prefer: auto` that is the cloud when both are
  // answering. The aspect-ratio label has to come from the SAME instance the graph is queued on, so the
  // choice is made here and then passed to the run explicitly - resolving the label against
  // `config.comfyBaseUrl` while the run went to the cloud would send one machine's option spelling to
  // another. A selection failure is left to `runComfyWorkflow`, which reports it with its own wording.
  const instanceUrl = (chosen?.baseUrl ?? '').trim();
  const savedSteps = savedVideo?.modes?.[settings?.mode ?? 'drama'] ?? null;
  const samplingSteps = savedSteps === null ? null : {
    totalSteps: savedSteps.totalSteps,
    firstPassSteps: savedSteps.firstPassSteps,
    scheduler: savedSteps.scheduler,
  };
  let aspectRatioLabel = null;
  if (instanceUrl.length > 0) {
    try {
      aspectRatioLabel = await aspectRatioLabelFor(instanceUrl, videoDimensions(settings).aspectRatio);
    } catch (error) {
      // A ratio the instance genuinely does not offer is a real refusal and stops here, because generating
      // a different shape would be a silent lie. A probe that merely could not answer is left to the
      // submission's own validation.
      if (/不支持/u.test(String(error?.message ?? ''))) throw error;
    }
  }
  const plan = prepareH3Graph(graph, {
    text,
    seconds,
    settings,
    references,
    requestId,
    aspectRatioLabel,
    samplingSteps,
    model: savedVideo?.model ?? null,
  });
  const output = join(projectRoot, '.director', 'generated', requestId);
  const policy = context.getPolicy?.();
  // A durable intent through the caller's filesystem also checks the output write boundary.
  const intentTarget = await context.fs.resolve(join(output, 'request.json'));
  // The block is part of the submission identity. The same text can legitimately exist in two
  // 大分镜; omitting the number here let a reused requestId pass the intent check while the
  // eventual result was still attributed to whichever block the old job carried.
  const intentText = JSON.stringify({
    requestId,
    shotId,
    episodeNumber: episodeNumber ?? null,
    blockNumber: blockNumber ?? null,
    workflow,
    settings: plan.size,
    text,
  });
  const existing = await context.fs.stat(intentTarget).catch(() => undefined);
  if (existing) {
    if (await context.fs.readText(intentTarget) !== intentText) throw new Error('同一 requestId 的生成内容已改变，请先核对原任务');
  } else await context.fs.writeText(intentTarget, intentText, { kind: 'createIfAbsent' }, undefined, policy);
  const result = await (context.runWorkflow ?? runComfyWorkflow)(config, {
    // The instance the label was resolved against, so the two cannot disagree.
    ...(instanceUrl.length > 0 ? { base_url: instanceUrl } : {}),
    workflow, output, inputs: plan.inputs, mediaInputs: plan.mediaInputs, patch: plan.patch, requestId,
    name: `H3-${basename(projectRoot)}-${settings?.mode === 'action' ? '武打' : '文戏'}`,
    // `episodeNumber` / `blockNumber` are THIS function's parameters, not fields on `context`.
    // Reading them off `context` (which carries the tool execution context, where they do not
    // exist) recorded null forever, so every candidate lost the only information that could name
    // it - and the results grid fell back to the instance's own `YZ_H3__00004-audio.mp4`.
    project: projectRoot, shotId, episodeNumber: episodeNumber ?? null, blockNumber: blockNumber ?? null, referenceIds: references.map((entry) => `${entry.mediaType ?? 'Picture'}:${entry.referenceIndex}:${entry.assetVersionId ?? entry.sha256 ?? entry.referenceId}`), resultsProjectRoot: projectRoot, timeout_ms: 0,
  }, {
    signal: context.signal ?? new AbortController().signal,
    cwd: projectRoot,
    ...(policy === undefined || policy === null ? {} : { sandboxPolicy: policy }),
    ...(typeof context.getPolicy === 'function' ? { getPolicy: context.getPolicy } : {}),
  }, { preparedGraph: plan.graph });
  watchSubmitted(result, config, context);
  // The receipt is what the caller acts on, so it names the two handles that make a run findable
  // later: the ledger id and the instance's own prompt id. A submission can legitimately come back
  // with no prompt id (the instance accepted the graph, the reply was thin), and that must NOT read
  // as a failure: re-submitting spends the GPU twice for one shot. An absent handle is therefore
  // stated as "look it up", never left blank.
  const handles = [
    typeof result?.jobId === 'string' && result.jobId.length > 0 ? `任务 ${result.jobId}` : '',
    typeof result?.promptId === 'string' && result.promptId.length > 0 ? `prompt ${result.promptId}` : '',
  ].filter((part) => part.length > 0).join(' · ');
  const pictureCount = references.filter((entry) => (entry.mediaType ?? 'Picture') === 'Picture').length;
  const audioCount = references.filter((entry) => entry.mediaType === 'Audio').length;
  const videoCount = references.filter((entry) => entry.mediaType === 'Video').length;
  const referenceSummary = `参考 ${String(pictureCount)} 图 / ${String(audioCount)} 音频 / ${String(videoCount)} 视频`;
  const message = handles.length > 0
    ? `视频任务已提交：${result.state}（${plan.size.resolution} / ${plan.size.aspectRatio}）· ${referenceSummary} · ${handles}`
    : `视频任务已提交：${result.state}（${plan.size.resolution} / ${plan.size.aspectRatio}）· ${referenceSummary} · 回执里没有 prompt_id：用 storyboard action=jobs 按 requestId 反查，不要重提`;
  return { generation: result, message };
}
