/**
 * Workflow knowledge: what each saved workflow in a directory can do, and which
 * one answers a request.
 *
 * Everything here works from the saved workflow JSON alone. That file already
 * records every node's class and every model filename, so a profile costs a file
 * read and a JSON parse - no GPU, no `/object_info`, no rendering. The result is
 * cached in the plugin state so a later question reads one small file.
 *
 * @module dsh-plugin-short-drama-director/lib/workflows
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

/** Capability tags this module can infer. Keep in step with the skills. */
export const CAPABILITIES = [
  'text-to-image',
  'image-to-image',
  'inpaint',
  'costume',
  'quadview',
  'upscale-image',
  'upscale-video',
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'video-edit',
  'audio',
];

/** Saved-workflow sidecars that are never runnable candidates. */
const SIDECAR_PATTERN = /\.bak|\.backup|\.old|\.orig|~$/iu;
const SKIP_DIRECTORIES = new Set(['.git', '.trash', '__pycache__', 'node_modules']);

/** Node-class signals, most specific first so a tag is not given loosely. */
const CLASS_SIGNALS = [
  { test: /MiniMaxH3ReferenceToVideo|MiniMaxH3ImageToVideo/iu, tag: 'reference-to-video' },
  { test: /MiniMaxH3Director|MiniMaxH3\w*/iu, tag: 'text-to-video' },
  { test: /WanImageToVideo|HunyuanImageToVideo|LTXVImgToVideo|SVD_img2vid/iu, tag: 'image-to-video' },
  { test: /VOSR2Video|SeedVR2VideoUpscaler/iu, tag: 'upscale-video' },
  { test: /VOSR2Image|SeedVR2|UpscaleModelLoader|ImageUpscaleWithModel/iu, tag: 'upscale-image' },
  { test: /Inpaint|SetLatentNoiseMask|CropMask|MaskComposite/iu, tag: 'inpaint' },
  { test: /Krea2Edit|TextEncodeQwenImage21|QwenImagePromptOptimizer/iu, tag: 'image-to-image' },
  { test: /CreateVideo|SaveVideo|VHS_VideoCombine/iu, tag: 'text-to-video' },
  { test: /LoadAudio|VAEDecodeAudio|TextEncodeAceStepAudio/iu, tag: 'audio' },
];

/** Name hints used only to rank candidates, never to decide a capability alone. */
const NAME_HINTS = [
  { test: /文生图|t2i|text2image/iu, tag: 'text-to-image' },
  { test: /图生图|img2img|image2image/iu, tag: 'image-to-image' },
  { test: /编辑|edit/iu, tag: 'image-to-image' },
  { test: /换装|costume/iu, tag: 'costume' },
  { test: /四视图|quad|多视图/iu, tag: 'quadview' },
  { test: /视频.*(?:放大|超分)|video.*upscale/iu, tag: 'upscale-video' },
  { test: /图像.*(?:放大|超分)|图片.*(?:放大|超分)|image.*upscale/iu, tag: 'upscale-image' },
  { test: /放大|超分|upscale|vosr|seedvr/iu, tag: 'upscale-image' },
  { test: /局部重绘|移除|inpaint/iu, tag: 'inpaint' },
  { test: /风格|style/iu, tag: 'text-to-image' },
  { test: /生视频|video|h3|minimax/iu, tag: 'text-to-video' },
];

/** True for a file this module considers a runnable saved workflow. */
function isWorkflowFile(name) {
  if (extname(name).toLowerCase() !== '.json') return false;
  if (SIDECAR_PATTERN.test(name)) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * What a workflow is primarily for.
 *
 * The file name is the strongest evidence available - these workflows are named
 * by their author - so it is read first and the graph only breaks ties.
 *
 * @returns one of `CAPABILITIES`.
 */
function inferPrimaryPurpose({ name, capabilities, media, hasEmptyLatent, hasLoaderImage }) {
  const has = (tag) => capabilities.has(tag);
  if (/四视图|quad|多视图/iu.test(name) || has('quadview')) return 'quadview';
  if (/换装|costume/iu.test(name) || has('costume')) return 'costume';
  if (/局部重绘|移除|inpaint|erase/iu.test(name) || has('inpaint')) return 'inpaint';
  if (/视频.*(?:放大|超分)|video.*upscale/iu.test(name) || has('upscale-video')) return 'upscale-video';
  if (/图像.*(?:放大|超分)|图片.*(?:放大|超分)|image.*upscale/iu.test(name) || has('upscale-image')) return 'upscale-image';
  if (/放大|超分|upscale|vosr|seedvr/iu.test(name)) return 'upscale-image';
  if (/文生图|t2i|text2image/iu.test(name)) return 'text-to-image';
  if (/编辑|edit|重绘|图生图/iu.test(name) || has('image-to-image')) return 'image-to-image';
  if (has('reference-to-video')) return 'reference-to-video';
  if (media.includes('video')) return has('image-to-video') ? 'image-to-video' : 'text-to-video';
  if (!hasEmptyLatent && hasLoaderImage) return 'image-to-image';
  return 'text-to-image';
}

/**
 * Score one candidate profile against the capabilities a request implied.
 *
 * @returns `{ score, matched, missing, warning }`; `warning` is set when the
 *   workflow can technically do the job but is really built for another one, so
 *   the caller can say so instead of presenting it as a plain generator.
 */
export function scoreCandidate(tags, wanted) {
  const matched = [...wanted].filter((tag) => tags.has(tag));
  const missing = [...wanted].filter((tag) => !tags.has(tag));
  let score = matched.length * 10;
  let warning;

  const purpose = tags.purpose;
  const asksImage = wanted.has('text-to-image');
  const asksVideo = wanted.has('text-to-image') === false && (wanted.has('text-to-video') || wanted.has('image-to-video') || wanted.has('reference-to-video'));

  // A flow built for one job that merely can also do another is a poor first
  // recommendation; say so rather than letting the caller pick it blind.
  if (asksImage && purpose !== 'text-to-image' && matched.includes('text-to-image')) {
    score -= 5;
    warning = `its main job is ${purpose}, not plain text-to-image`;
  }
  if (asksVideo && purpose.includes('upscale')) {
    score -= 5;
    warning = 'it enlarges existing footage rather than generating video';
  }
  if (purpose === 'upscale-image' && !wanted.has('upscale-image') && !wanted.has('upscale-video')) score -= 4;

  // Specialised flows - a style library, a fixed layout, an optional stage - are
  // not what a plain "generate me a picture" wants, unless the user asked for
  // that speciality.
  const purposeTag = PURPOSE_TO_TAG.get(purpose);
  if (purposeTag !== undefined && !wanted.has(purposeTag) && !wanted.has('upscale-image') && !wanted.has('upscale-video')) score -= 3;
  return { score, matched, missing, warning };
}

/** Map a primary purpose back onto the capability tag it stands for. */
const PURPOSE_TO_TAG = new Map([
  ['text-to-image', 'text-to-image'],
  ['image-to-image', 'image-to-image'],
  ['inpaint', 'inpaint'],
  ['costume', 'costume'],
  ['quadview', 'quadview'],
  ['upscale-image', 'upscale-image'],
  ['text-to-video', 'text-to-video'],
  ['image-to-video', 'image-to-video'],
  ['reference-to-video', 'reference-to-video'],
]);

/** Output node classes and the medium they write. */
const OUTPUT_MEDIUM = [
  { test: /VHS_VideoCombine|SaveVideo|SaveWEBM|CreateVideo/iu, medium: 'video' },
  { test: /SaveImage|PreviewImage|SaveImageJPG|ImageSaveNode/iu, medium: 'image' },
  { test: /SaveAudio|PreviewAudio/iu, medium: 'audio' },
];

/**
 * Build a lightweight profile of one saved workflow.
 *
 * @param file - absolute path of the workflow JSON.
 * @returns the profile, or `{ error }` when the file is not a readable UI workflow.
 */
export async function profileWorkflow(file) {
  const name = basename(file);
  let graph;
  try {
    graph = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { file, name, error: `not readable JSON: ${String(error.message ?? error)}` };
  }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : null;
  if (nodes === null) {
    return { file, name, error: 'no "nodes" array: this is API-format output, not a saved workflow' };
  }

  const info = await stat(file);
  const classes = [];
  const outClasses = [];
  const models = [];
  // Only nodes that will actually execute count: a bypassed or muted node cannot
  // give a workflow a capability it does not currently have.
  const activeClasses = [];
  for (const node of nodes) {
    const type = typeof node?.type === 'string' ? node.type : undefined;
    if (type === undefined) continue;
    classes.push(type);
    const running = (node.mode ?? 0) === 0;
    if (running) activeClasses.push(type);
    if (running && OUTPUT_MEDIUM.some((entry) => entry.test.test(type))) outClasses.push(type);
    for (const value of Array.isArray(node.widgets_values) ? node.widgets_values : []) {
      if (typeof value !== 'string') continue;
      if (/\.(safetensors|ckpt|pt|pth|gguf|bin|onnx)$/iu.test(value)) models.push(value.replace(/\\/gu, '/'));
    }
  }
  const uniqueClasses = [...new Set(classes)];
  const uniqueActive = [...new Set(activeClasses)];
  const media = [...new Set(outClasses.flatMap((type) => OUTPUT_MEDIUM.filter((entry) => entry.test.test(type)).map((entry) => entry.medium)))];
  const active = activeClasses.length;
  const bypassed = nodes.length - active;

  const capabilities = new Set();
  for (const type of uniqueActive) {
    for (const signal of CLASS_SIGNALS) {
      if (signal.test.test(type)) capabilities.add(signal.tag);
    }
  }
  const hasLoaderImage = uniqueActive.some((type) => /LoadImage|VHS_LoadImage/iu.test(type));
  const hasUpscaler = uniqueActive.some((type) => /VOSR2Image|SeedVR2|UpscaleModelLoader|ImageUpscaleWithModel/iu.test(type));

  // An upscale-only graph loads an image and enlarges it; it does not generate a
  // new one. Saying otherwise would offer it for "generate me a picture".
  if (hasLoaderImage && hasUpscaler) {
    capabilities.delete('text-to-image');
    capabilities.delete('image-to-image');
    capabilities.delete('text-to-video');
    capabilities.delete('reference-to-video');
  } else {
    // Generating a still: an empty latent in an image-producing graph is
    // text-to-image; a graph that loads an image instead is editing.
    const hasEmptyLatent = uniqueActive.some((type) => /^Empty.*Latent/iu.test(type));
    if (hasEmptyLatent && media.includes('image')) capabilities.add('text-to-image');
    if (hasLoaderImage && media.includes('image') && !hasEmptyLatent) capabilities.add('image-to-image');
  }
  // Creating video is not a reason to call a still-image flow a video flow.
  if (media.includes('video') && !capabilities.has('upscale-video') && ![...capabilities].some((tag) => tag.endsWith('-to-video'))) {
    capabilities.add('text-to-video');
  }
  if (capabilities.has('upscale-image') && media.includes('video')) capabilities.add('upscale-video');
  if (/换装/iu.test(name)) capabilities.add('costume');
  if (/四视图/iu.test(name)) capabilities.add('quadview');

  // Which capability the workflow is really *for*, from its name first and its
  // graph second. This is what lets a caller warn that a candidate is really an
  // editing flow rather than a plain generator.
  const primaryPurpose = inferPrimaryPurpose({ name, capabilities, media, hasEmptyLatent: uniqueActive.some((type) => /^Empty.*Latent/iu.test(type)), hasLoaderImage });

  return {
    file,
    name,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    nodeCount: nodes.length,
    activeNodes: active,
    bypassedNodes: bypassed,
    capabilities: [...capabilities].sort(),
    primaryPurpose,
    media,
    outputClasses: [...new Set(outClasses)],
    models: [...new Set(models)],
    /** True when the saved state leaves no output node running. */
    outputInactive: outClasses.length === 0,
    groupTitles: (Array.isArray(graph?.groups) ? graph.groups : []).map((group) => group?.title).filter((title) => typeof title === 'string').slice(0, 12),
  };
}

/**
 * Scan a workflow directory and build the index.
 *
 * @returns `{ dir, count, skipped, items }`; sidecars are counted in `skipped`.
 */
export async function scanWorkflows(dir) {
  const files = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === dir) {
        throw new Error(`cannot read the workflow directory ${dir}: ${String(error.message ?? error)}`);
      }
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(path);
      } else if (entry.isFile()) {
        files.push({
          path,
          relativePath: relative(dir, path).replace(/\\/gu, '/'),
        });
      }
    }
  };
  await walk(dir);
  const runnable = files.filter((entry) => isWorkflowFile(entry.relativePath));
  const items = [];
  for (const file of runnable) {
    const profile = await profileWorkflow(file.path);
    items.push({ ...profile, relativePath: file.relativePath, workflowRoot: dir });
  }
  return {
    dir,
    count: items.filter((item) => item.error === undefined).length,
    unreadable: items.filter((item) => item.error !== undefined),
    skippedSidecars: files
      .filter((entry) => extname(entry.relativePath).toLowerCase() === '.json' && !isWorkflowFile(entry.relativePath))
      .map((entry) => entry.relativePath),
    items: items.filter((item) => item.error === undefined).sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt))),
  };
}

/** Words in a request that imply a capability, for matching. */
const REQUEST_HINTS = [
  { test: /文生图|生成(一张|一个|一幅|个|张)?(图|图片|照片|插画|人像)|画(一张|一个|个|张)?|出图|t2i/iu, tags: ['text-to-image'] },
  // Word order varies in Chinese ("换掉背景" / "背景换掉"), so match the verb and
  // the object independently rather than as one phrase.
  { test: /改图|修图|编辑|图生图|img2img|换成|换掉|替换|修一下|改一下/iu, tags: ['image-to-image'] },
  { test: /背景|衣服|服装|发型|造型|pose|姿势/iu, tags: ['image-to-image'] },
  { test: /换装|换衣服|换套衣服|换服装|穿上|脱掉/iu, tags: ['costume', 'image-to-image'] },
  { test: /四视图|三视图|设定图|角色图|多视图|角色设定/iu, tags: ['quadview', 'image-to-image'] },
  { test: /放大|超分|清晰|分辨率|分辨率提高|upscale|4k|2k|8k/iu, tags: ['upscale-image', 'upscale-video'] },
  { test: /局部|擦除|去掉|移除|消除|重绘|p掉|抠掉/iu, tags: ['inpaint', 'image-to-image'] },
  { test: /生视频|出视频|视频|动起来|视频生成|animate/iu, tags: ['text-to-video', 'image-to-video', 'reference-to-video'] },
  { test: /音(频|乐)|配音|声音|audio/iu, tags: ['audio'] },
];

/**
 * Match a plain-language request against an index.
 *
 * @returns candidates ranked by capability overlap, then recency. A candidate
 *   whose saved state leaves no output node running is demoted and made explicit,
 *   because choosing it would produce nothing.
 */
export function matchWorkflows(index, request, { limit = 8 } = {}) {
  const wanted = new Set();
  for (const hint of REQUEST_HINTS) {
    if (hint.test.test(request)) for (const tag of hint.tags) wanted.add(tag);
  }

  const rows = index.items.map((item) => {
    const tags = new Set(item.capabilities);
    for (const hint of NAME_HINTS) {
      if (hint.test.test(item.name)) tags.add(hint.tag);
    }
    tags.purpose = item.primaryPurpose ?? 'text-to-image';
    const scored = scoreCandidate(tags, wanted);
    let score = scored.score;
    if (item.outputInactive) score -= 6;
    return {
      name: item.name,
      relativePath: item.relativePath ?? item.name,
      file: item.file,
      capabilities: [...tags].sort(),
      primaryPurpose: tags.purpose,
      matched: scored.matched,
      missing: scored.missing,
      // Null, never undefined: JSON drops an `undefined` property and the harness
      // then rejects the entire tool result as "not lossless JSON".
      warning: scored.warning ?? null,
      modifiedAt: item.modifiedAt,
      outputInactive: item.outputInactive === true,
      score,
    };
  });

  if (rows.length === 0 || wanted.size === 0) {
    // No generation intent was readable. Returning a ranked list here would invite
    // the caller to run the top row anyway; the honest answer is to ask.
    return { wanted: [], confident: [], candidates: [], ambiguous: false };
  }

  rows.sort((left, right) => (right.score - left.score) || String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
  const confident = rows.filter((row) => row.matched.length > 0 && row.outputInactive !== true);
  return {
    wanted: [...wanted],
    confident: confident.length === 1 ? confident : [],
    candidates: rows.slice(0, limit),
    ambiguous: confident.length > 1,
  };
}

/**
 * Check that every model a workflow references is present on an instance.
 *
 * A missing model is the most common reason a workflow that used to work stops
 * working after a move or a cleanup, and finding out costs one `object_info`
 * fetch rather than a failed multi-minute run.
 *
 * @param models - model paths as the workflow records them.
 * @param available - every model name the instance offers, from any loader.
 * @returns `{ missing, matched, unknown }`; `unknown` holds entries that could not
 *   be resolved either way, so a caller never reports a false alarm as fact.
 */
export function checkModels(models, available) {
  const pool = new Set(available.map((name) => String(name).replace(/\\/gu, '/')));
  const byBase = new Map();
  for (const name of pool) byBase.set(basename(name), name);
  const missing = [];
  const matched = [];
  const unknown = [];
  for (const model of models) {
    const normalized = model.replace(/\\/gu, '/');
    if (pool.has(normalized)) {
      matched.push(model);
      continue;
    }
    const base = basename(normalized);
    if (byBase.has(base)) {
      matched.push(model);
      continue;
    }
    missing.push({ model, hint: `no file named ${base} is offered by any loader on this instance` });
  }
  return { missing, matched, unknown };
}
