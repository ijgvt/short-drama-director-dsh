/**
 * ComfyUI client primitives for the short-drama director plugin.
 *
 * Two responsibilities:
 *  1. `comfyProbe` / `fetchJson` 鈥?reachability and inventory facts.
 *  2. UI-workflow -> API-prompt conversion plus graph patching, so a saved
 *     ComfyUI workflow JSON can be queued without a manual "Export (API)".
 *
 * The converter needs `/object_info` for widget names; callers pass the
 * object map in so one fetch serves many conversions.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const DEFAULT_PROBE_TIMEOUT_MS = 6000;

/** Normalize a user-supplied base URL into `http://host:port` without a trailing slash. */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) throw new Error('a ComfyUI address is required, for example http://127.0.0.1:8188');
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/u, '');
}

/** Fetch a JSON document from a ComfyUI endpoint with a bounded timeout. */
export async function fetchJson(baseUrl, route, { method = 'GET', body, headers, timeoutMs = 30000, signal } = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${route}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
    signal: composite,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} -> HTTP ${response.status} ${response.statusText}: ${text.slice(0, 600)}`);
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url} -> response was not JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Probe one ComfyUI endpoint for liveness plus the model inventory the asset
 * workflows depend on.
 *
 * @returns a plain report; `reachable: false` carries the failure reason instead
 *   of throwing, because "no ComfyUI here" is a normal answer for this plugin.
 */
export async function probeEndpoint(baseUrl, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal, inventory = false } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const report = { baseUrl: base, reachable: false };
  try {
    const stats = await fetchJson(base, '/system_stats', { timeoutMs, signal });
    const system = stats?.system ?? {};
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];
    report.reachable = true;
    report.comfyuiVersion = system.comfyui_version ?? null;
    report.os = system.os ?? null;
    report.pythonVersion = system.python_version ?? 'unknown';
    report.devices = devices.map((device) => ({
      name: device.name ?? 'unknown',
      vramTotalGb: device.vram_total === undefined ? null : round(device.vram_total / 1024 ** 3, 1),
      vramFreeGb: device.vram_free === undefined ? null : round(device.vram_free / 1024 ** 3, 1),
    }));
    try {
      const queue = await fetchJson(base, '/queue', { timeoutMs, signal });
      report.queue = {
        running: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
        pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0,
      };
    } catch {
      report.queue = null;
    }
    if (inventory) report.inventory = await readInventory(base, { timeoutMs, signal });
  } catch (error) {
    report.error = String(error?.message ?? error);
  }
  return report;
}

/** Model files the asset and video workflows select from. */
const INVENTORY_KEYS = [
  'CheckpointLoaderSimple',
  'UNETLoader',
  'LoraLoaderModelOnly',
  'VAELoader',
  'CLIPLoader',
  'UpscaleModelLoader',
  'TESpeedVOSR2Loader',
];

/** Collect the model dropdown choices a running instance actually offers. */
export async function readInventory(baseUrl, { timeoutMs = 20000, signal } = {}) {
  const objectInfo = await fetchJson(baseUrl, '/object_info', { timeoutMs, signal });
  const models = {};
  for (const key of INVENTORY_KEYS) {
    const required = objectInfo?.[key]?.input?.required;
    if (required === undefined) continue;
    for (const [inputName, spec] of Object.entries(required)) {
      if (Array.isArray(spec?.[0])) {
        models[`${key}.${inputName}`] = spec[0];
        break;
      }
    }
  }
  return { models };
}

/**
 * Read `/object_info`.
 *
 * The route ignores every `node_class` parameter except the first, so asking it
 * for several classes at once silently returns a partial map. The full document
 * is fetched instead and `classes` only narrows the returned copy, which keeps
 * the caller's cache complete.
 */
export async function readObjectInfo(baseUrl, { classes, timeoutMs = 30000, signal } = {}) {
  const full = await fetchJson(baseUrl, '/object_info', { timeoutMs, signal });
  if (!Array.isArray(classes) || classes.length === 0) return full;
  const narrowed = {};
  for (const name of classes) {
    if (Object.hasOwn(full, name)) narrowed[name] = full[name];
  }
  return narrowed;
}

/**
 * Every model filename an instance offers, across all loaders.
 *
 * A workflow records the model paths it was saved with; comparing them against
 * this list catches "that file moved or was deleted" before a run instead of
 * after it fails.
 *
 * @returns `{ names, byInput }`; `byInput` records how many files each loader
 *   input offered, so a report can point at the right dropdown.
 */
export function availableModelNames(objectInfo) {
  const names = new Set();
  const byInput = {};
  for (const [nodeClass, definition] of Object.entries(objectInfo ?? {})) {
    const buckets = definition?.input;
    if (buckets === undefined || buckets === null) continue;
    for (const bucket of ['required', 'optional']) {
      for (const [inputName, spec] of Object.entries(buckets[bucket] ?? {})) {
        const choices = Array.isArray(spec) ? spec[0] : undefined;
        if (!Array.isArray(choices)) continue;
        // Only a list of file-looking strings is a model dropdown.
        const files = choices.filter((choice) => typeof choice === 'string' && /\.(safetensors|ckpt|pt|pth|gguf|bin|onnx)$/iu.test(choice));
        if (files.length === 0) continue;
        byInput[`${nodeClass}.${inputName}`] = files.length;
        for (const file of files) names.add(file.replace(/\\/gu, '/'));
      }
    }
  }
  return { names: [...names], byInput };
}

// ---------------------------------------------------------------------------
// UI workflow -> API prompt
// ---------------------------------------------------------------------------

/** Combo-type widget names for a class, in `/object_info` input order. */
export function comboWidgetNames(nodeClass, objectInfo) {
  const definition = objectInfo?.[nodeClass];
  if (definition === undefined) return undefined;
  const order = inputOrderFor(definition);
  const names = [];
  for (const [inputName, spec] of order) {
    if (isComboSpec(spec)) names.push(inputName);
  }
  return names;
}

/** Every input of a class as `[name, spec]` pairs, in the order `/object_info` reports. */
function inputOrderFor(definition) {
  const buckets = definition?.input;
  if (buckets === undefined || buckets === null) return [];
  const declaredOrder = definition?.input_order;
  const pairs = [];
  for (const bucket of ['required', 'optional']) {
    const inputs = buckets[bucket];
    if (inputs === undefined || inputs === null) continue;
    const names = Array.isArray(declaredOrder?.[bucket]) ? declaredOrder[bucket] : Object.keys(inputs);
    for (const name of names) {
      if (Object.hasOwn(inputs, name)) pairs.push([name, inputs[name]]);
    }
  }
  return pairs;
}

/** True when an input is a value dropdown, which the frontend always renders as a widget. */
function isComboSpec(spec) {
  if (spec === null || typeof spec !== 'object') return false;
  if (Array.isArray(spec)) return Array.isArray(spec[0]);
  return false;
}

/** The options object of `[type, options]`, or the spec itself when object-shaped. */
function specOptions(spec) {
  if (Array.isArray(spec)) {
    const options = spec[1];
    return options !== null && typeof options === 'object' && !Array.isArray(options) ? options : undefined;
  }
  if (spec !== null && typeof spec === 'object') return spec;
  return undefined;
}

/**
 * Order `control_after_generate` widgets by how likely they are to be missing
 * from the saved node's declared slots.
 *
 * The saving frontend normally keeps a widget slot after a link replaces it, so a
 * missing declaration is the exception. When it does happen it is almost always
 * on an input the node also wires, which is why wired widgets come first.
 */
function controlWidgetOrder({ inputPairs, declaredSlotNames, linked }) {
  const ranked = [];
  for (const [name, spec] of inputPairs) {
    if (specOptions(spec)?.control_after_generate !== true) continue;
    if (declaredSlotNames.has(`${name}.control_after_generate`)) continue;
    ranked.push({ anchor: name, wired: linked.has(name) });
  }
  ranked.sort((left, right) => Number(right.wired) - Number(left.wired));
  return ranked.map((entry) => entry.anchor);
}

/**
 * Resolve the exact widget slot sequence one saved node serializes, plus the
 * option spec for each slot.
 *
 * The saved node is the authority on *which* inputs became widgets, because a
 * `STRING` or `INT` socket and a widget look identical in `/object_info` 鈥?the
 * frontend decides at instantiation, and only the saved node records the result.
 * `/object_info` supplies the two things the node cannot: the option spec used
 * for type-checking, and the phantom `control_after_generate` slots, which are
 * serialized but are not graph inputs.
 *
 * @param node - one saved UI node.
 * @param objectInfo - `/object_info` map for the target instance.
 * @param savedValueCount - how many widget values the node serialized, which is
 *   what reveals that phantom slots exist at all.
 * @returns `{ name, spec, phantom }` per slot, in serialization order.
 */
export function widgetSlotOrderFor(node, objectInfo, savedValueCount) {
  const definition = objectInfo?.[node?.type];
  if (definition === undefined) return undefined;
  const savedCount = savedValueCount ?? widgetValuesFor(node).length;
  const inputPairs = inputOrderFor(definition);
  const specFor = new Map(inputPairs);
  const orderIndex = new Map(inputPairs.map(([name], index) => [name, index]));

  const declared = [];
  for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
    const widget = input?.widget;
    if (widget === undefined || widget === null) continue;
    const name = typeof input?.name === 'string' && input.name.length > 0
      ? input.name
      : (typeof widget === 'string' ? widget : widget.name);
    if (typeof name !== 'string' || name.length === 0) continue;
    declared.push(name);
    // Autogrow fields such as `ref_images.ref_image_0` have no `/object_info`
    // entry, so they must claim the option spec of the field that declares them.
    if (name.includes('.') && !specFor.has(name)) {
      const parent = name.slice(0, name.indexOf('.'));
      if (specFor.has(parent)) specFor.set(name, specFor.get(parent));
    }
  }

  const items = [];
  const push = (name, spec, phantom) => {
    if (items.some((item) => item.phantom === false && item.name === name)) return;
    items.push({ name, spec, phantom, candidateAfter: undefined, rank: undefined });
  };
  for (const name of declared) push(name, specFor.get(name), false);
  // A widget the saved node omits (usually because a link replaced it) still
  // holds a position, so combos are appended as a last resort.
  for (const [name, spec] of inputPairs) {
    if (isComboSpec(spec)) push(name, spec, false);
  }

  // Phantoms are not in the saved slots, so only their count is knowable from
  // the serialized value count; where each one sits is decided by
  // `alignWidgetValues`, which is why they are offered here as ranked candidates.
  const leftovers = savedCount - items.length;
  if (leftovers > 0) {
    const wired = new Set();
    for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
      if (input?.link === undefined || input?.link === null) continue;
      if (typeof input?.name === 'string') wired.add(input.name);
    }
    const anchors = controlWidgetOrder({ inputPairs, declaredSlotNames: new Set(declared), linked: wired });
    for (let rank = 0; rank < anchors.length; rank += 1) {
      const anchor = anchors[rank];
      items.push({ name: `${anchor}.control_after_generate`, spec: undefined, phantom: true, candidateAfter: anchor, rank });
    }
  }
  items.sort((left, right) => rankOfItem(left) - rankOfItem(right));
  return items;

  function rankOfItem(item) {
    const base = item.phantom ? item.candidateAfter : item.name;
    const position = orderIndex.get(base) ?? Number.MAX_SAFE_INTEGER;
    return position * 2 + (item.phantom ? 0 : 1);
  }
}

/** Ordered widget values a saved node carries, tolerating both frontend layouts. */
function widgetValuesFor(node) {
  if (Array.isArray(node.widgets_values)) return node.widgets_values;
  if (node.widgets_values !== null && typeof node.widgets_values === 'object') {
    return Object.values(node.widgets_values);
  }
  return [];
}

/**
 * ComfyUI's model dropdown values always use forward slashes, including on Windows. A workflow
 * saved from a local graph can contain `Qwen\model.safetensors`, which the instance rejects even
 * though the same file is present as `Qwen/model.safetensors`.
 */
function normalizeComfyWidgetValue(value) {
  if (typeof value !== 'string') return value;
  if (!/\.(?:safetensors|ckpt|pt|pth|gguf|bin|onnx)$/iu.test(value)) return value;
  return value.replace(/\\/gu, '/');
}

/**
 * The name-keyed widget map, when the frontend wrote one.
 *
 * ComfyUI has written this map into two different places over time: a separate
 * `widgets_values_named` field, and `widgets_values` itself. The second form
 * matters because node packs such as VHS use it for their whole node, and reading
 * it positionally mis-assigns every value - `VHS_VideoCombine` then reaches the
 * server without `filename_prefix`, `format` or `frame_rate` and the prompt is
 * rejected outright.
 *
 * A name-keyed map is only accepted when at least one key matches a widget the
 * node declares, so an unrelated object cannot be mistaken for one.
 */
function namedWidgetValuesFor(node, objectInfo) {
  const named = node.widgets_values_named;
  if (named !== null && typeof named === 'object' && !Array.isArray(named)) return named;
  const candidate = node.widgets_values;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const declared = declaredWidgetNames(node.type, objectInfo);
  if (declared.size === 0) return undefined;
  const keys = Object.keys(candidate);
  if (keys.length === 0) return undefined;
  return keys.some((key) => declared.has(key)) ? candidate : undefined;
}

/** Widget names the instance declares for a node class. */
function declaredWidgetNames(type, objectInfo) {
  const spec = objectInfo?.[type];
  if (spec === undefined || spec === null) return new Set();
  const required = spec.input?.required ?? {};
  const optional = spec.input?.optional ?? {};
  const names = new Set();
  for (const [name, entry] of [...Object.entries(required), ...Object.entries(optional)]) {
    const kind = Array.isArray(entry) ? entry[0] : entry;
    if (typeof kind === 'string' && kind === 'COMBO') continue;
    if (Array.isArray(kind)) continue;
    if (typeof kind === 'string') names.add(name);
  }
  return names;
}

/** Label for a group-bypass / mute marker the frontend writes into `mode`. */
function modeIsActive(node) {
  return node.mode === undefined || node.mode === 0 || node.mode === null;
}

/**
 * Node classes that exist only in the frontend and never in `/object_info`.
 *
 * Notes and labels are pure annotations, and `SetNode` / `GetNode` are the
 * frontend's virtual-wire pair: a `SetNode` publishes the value arriving on its
 * input under a key, and every `GetNode` with the same key reads it back.
 * Neither pair reaches the backend, so both are resolved before submission.
 */
const COSMETIC_NODE_CLASSES = new Set([
  'Note',
  'MarkdownNote',
  'Label (rgthree)',
  'Label',
  'Reroute',
  'Reroute (rgthree)',
  'Bookmark (rgthree)',
  'Fast Groups Bypasser (rgthree)',
  'Fast Groups Muter (rgthree)',
  'Node Collector (rgthree)',
  'Anything Everywhere',
  'SetNode',
  'GetNode',
]);

/** True when a class only decorates the canvas. */
export function isCosmeticNodeClass(nodeClass) {
  return COSMETIC_NODE_CLASSES.has(nodeClass);
}

/** True for the frontend's virtual-wire pair, which resolves into direct links. */
export function isVirtualWireClass(nodeClass) {
  return nodeClass === 'SetNode' || nodeClass === 'GetNode';
}

/**
 * Frontend nodes that simply carry their input to their output.
 *
 * They have no backend class, so they must be resolved into a direct link rather
 * than dropped; dropping one orphans every consumer downstream of it.
 */
const PASS_THROUGH_CLASSES = new Set([
  'Reroute',
  'Reroute (rgthree)',
  'ReroutePrimitive',
  'PrimitiveNode',
]);

/** Convert a serialized value into the type this widget expects, or a mismatch. */
function coerceToSpec(value, spec) {
  if (spec === undefined) return { value };
  const type = Array.isArray(spec) ? spec[0] : undefined;
  if (Array.isArray(type)) {
    if (value === null || typeof value === 'object') return { value };
    return type.includes(value) ? { value } : { value, mismatch: `one of ${type.slice(0, 6).join('/')}` };
  }
  if (type === 'INT' || type === 'FLOAT') {
    if (typeof value === 'number') return { value };
    if (value === null || value === '' || typeof value === 'boolean') return { mismatch: type };
    const parsed = Number(value);
    return Number.isFinite(parsed) ? { value: parsed } : { mismatch: type };
  }
  if (type === 'BOOLEAN') {
    if (typeof value === 'boolean') return { value };
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { mismatch: 'BOOLEAN' };
  }
  if (type === 'STRING') {
    return typeof value === 'string' ? { value } : { mismatch: 'STRING' };
  }
  return { value };
}

/**
 * Align serialized widget values to the widget slots that produced them.
 *
 * Two facts drive this:
 *
 * - A named map, when the frontend wrote one, is authoritative: it is read by
 *   name and the positional array is ignored entirely.
 * - Otherwise a linked widget still consumes its slot's saved value. The
 *   frontend keeps serializing a widget after a link replaces it, so skipping
 *   the slot would shift every later widget by one and silently turn a step
 *   count into a sampler name.
 *
 * The saved slot list can be one short per phantom `control_after_generate`
 * slot. Where each phantom sits is not recorded, and the two candidate positions
 * are not equivalent: putting it in the wrong place turns a step count into a
 * control token. The placement is therefore solved as a bounded search that
 * minimises type conflicts and, among equally valid alignments, prefers the
 * phantom order `controlWidgetOrder` ranks most likely.
 *
 * @returns one entry per input slot, plus a note for every unresolved conflict.
 */
function alignWidgetValues({ order, namedValues, values, linked, notes, node }) {
  const entries = order.map((slot) => ({ slot, value: undefined, linked: linked.has(slot.name), mismatch: undefined, ignore: false }));
  if (namedValues !== undefined && Object.keys(namedValues).length > 0) {
    for (const entry of entries) {
      const named = namedValues[entry.slot.name];
      if (named === undefined) continue;
      const coerced = coerceToSpec(named, entry.slot.spec);
      entry.value = coerced.value;
      if (entry.linked) entry.ignore = true;
      else if (coerced.mismatch !== undefined) entry.mismatch = coerced.mismatch;
    }
    for (const name of Object.keys(namedValues)) {
      if (!order.some((slot) => slot.name === name)) {
        notes.push(`node ${node.id} (${node.type}) saves a value for "${name}", which is not a widget of this node class`);
      }
    }
    return entries;
  }
  if (values.length === 0) return entries;

  const visible = order.filter((slot) => slot.phantom !== true);
  const phantomCount = order.length - visible.length;
  const solution = search();
  if (solution === undefined) {
    notes.push(`node ${node.id} (${node.type}) could not align ${values.length} saved widget value(s) to its ${visible.length} input slot(s); ComfyUI validation will reject this graph`);
    return entries;
  }
  for (const [index, slot] of visible.entries()) {
    const valueIndex = solution.get(slot);
    const effective = valueIndex === undefined || valueIndex >= values.length ? index : valueIndex;
    if (effective >= values.length) continue;
    apply(entries, slot, values[effective]);
  }
  return entries;

  /** Record one aligned value on its entry. */
  function apply(target, slot, value) {
    const entry = target.find((candidate) => candidate.slot === slot);
    if (entry === undefined) return;
    // A linked slot keeps its placeholder value in the saved file and is
    // replaced from its source node when the prompt is built.
    if (entry.linked) {
      entry.ignore = true;
      return;
    }
    entry.value = value;
    const coerced = coerceToSpec(value, entry.slot.spec);
    if (coerced.mismatch !== undefined) entry.mismatch = coerced.mismatch;
  }

  /**
   * Find how many phantoms to interleave and where.
   *
   * The saved value count only bounds the number of phantoms; it does not prove
   * one exists, because a frontend version may or may not serialize a widget that
   * a link replaced. Each count from zero to the number of phantom candidates is
   * therefore laid out explicitly and accepted only when it consumes exactly the
   * saved values.
   *
   * Where a phantom sits is not recorded, and the plausible positions are not
   * equivalent: putting one before a seed instead of after it turns a step count
   * into a randomize token. Position `p` means the phantom is the `(p+1)`-th
   * serialized value, so the visible slot at sequence index `i` reads value
   * `i + (number of phantoms at or before i)`. Layouts are therefore scored by
   * type conflicts first, and among equals by how close each phantom sits to its
   * anchor, which is where the frontend actually puts it.
   *
   * @returns slot -> value index, or undefined when nothing lines up.
   */
  function search() {
    let best;
    for (let count = 0; count <= phantomCount; count += 1) {
      if (count + visible.length !== values.length) continue;
      for (const positions of placements(count)) {
        const picked = new Map();
        for (let index = 0; index < visible.length; index += 1) {
          const shifts = positions.filter((position) => position <= index).length;
          picked.set(visible[index], index + shifts);
        }
        const score = visible.reduce((sum, slot) => {
          const valueIndex = picked.get(slot);
          if (valueIndex === undefined || valueIndex >= values.length) return sum + 1;
          return sum + (coerceToSpec(values[valueIndex], slot.spec).mismatch === undefined ? 0 : 1);
        }, 0);
        if (best === undefined || score < best.score || (score === best.score && drift(positions) < drift(best.positions))) {
          best = { score, count, positions: [...positions], picked };
        }
      }
    }
    if (best !== undefined) return best.picked;
    if (values.length <= visible.length) {
      return new Map(visible.map((slot, index) => [slot, index]));
    }
    return undefined;
  }

  /**
   * Every way to place `count` phantoms among the `visible.length + count`
   * sequence positions, pruned at the first `count` positions only if the
   * combination count would explode.
   */
  function placements(count) {
    const total = visible.length + count;
    const results = [];
    const walk = (start, chosen) => {
      if (chosen.length === count) {
        results.push([...chosen]);
        return;
      }
      if (results.length > 400) return;
      for (let position = start; position < total; position += 1) {
        chosen.push(position);
        walk(position + 1, chosen);
        chosen.pop();
      }
    };
    walk(0, []);
    return results;
  }

  /** How far the placed phantoms sit from where the frontend would put them. */
  function drift(positions) {
    const anchors = order.filter((slot) => slot.phantom === true).map((slot) => (slot.rank ?? 0) + 1);
    return positions.reduce((sum, position, index) => sum + Math.abs(position - (anchors[index] ?? position)), 0);
  }
}

/**
 * Convert a saved UI workflow into the API prompt format.
 *
 * @param graph - parsed workflow JSON (`{ nodes: [...], links: [...] }`).
 * @param options.objectInfo - `/object_info` map, required for widget naming.
 * @returns `{ prompt, skipped, notes, nodeIndex }`; `prompt` is ready for `POST /prompt`.
 */
export function uiGraphToPrompt(graph, { objectInfo } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : undefined;
  if (nodes === undefined) {
    throw new Error('the workflow file is not a ComfyUI UI workflow: it has no "nodes" array');
  }
  if (objectInfo === undefined || objectInfo === null) {
    throw new Error('converting a workflow needs /object_info from the target instance');
  }

  const skipped = [];
  const notes = [];
  const byId = new Map();
  for (const node of nodes) {
    if (!Number.isInteger(node?.id) || typeof node?.type !== 'string') continue;
    byId.set(node.id, node);
    if (!modeIsActive(node)) {
      skipped.push({ id: node.id, type: node.type, mode: node.mode, reason: node.mode === 4 ? 'bypassed by a group bypasser' : 'muted in the saved workflow' });
    }
  }

  const prompt = {};
  const bypassed = new Map();
  const virtualWires = new Map();
  for (const node of nodes) {
    if (!Number.isInteger(node?.id) || typeof node?.type !== 'string') continue;
    if (!modeIsActive(node)) {
      // The frontend's bypass keeps the node in the picture but passes its input
      // straight through to whatever consumed its output. Dropping the node
      // instead would leave its consumers wired to nothing, and ComfyUI then
      // "succeeds" without executing the branch at all - no image, no error.
      if (node.mode === 4) bypassed.set(node.id, passThroughInputs(node));
      skipped.push({ id: node.id, type: node.type, mode: node.mode, reason: node.mode === 4 ? 'bypassed: its consumers were rewired to its own inputs' : 'muted in the saved workflow' });
      continue;
    }
    const named = namedWidgetValuesFor(node, objectInfo);
    const values = widgetValuesFor(node);
    const order = widgetSlotOrderFor(node, objectInfo, named === undefined ? values.length : Object.keys(named).length);
    if (order === undefined) {
      // A GetNode reads a value a SetNode published under the same key; neither
      // has a backend class, so the pair is resolved after the main pass.
      if (isVirtualWireClass(node.type)) {
        virtualWires.set(node.id, { kind: node.type, key: node.widgets_values?.[0] ?? null });
        skipped.push({ id: node.id, type: node.type, reason: `${node.type} virtual wire (key ${JSON.stringify(node.widgets_values?.[0] ?? null)}); resolved into a direct link` });
        continue;
      }
      // `Reroute` is a frontend-only pass-through: it carries its single input to
      // its output unchanged. Treating it as an uninstalled class used to drop it,
      // which left every consumer pointing at a node the prompt no longer
      // contained - ComfyUI then rejected the whole graph with "Exception when
      // validating inner node". Registering it as a bypass makes the existing
      // rewire pass connect consumers straight to whatever fed the reroute.
      if (PASS_THROUGH_CLASSES.has(node.type)) {
        bypassed.set(node.id, passThroughInputs(node));
        skipped.push({ id: node.id, type: node.type, reason: `${node.type} frontend pass-through; its consumers were rewired to its own input` });
        continue;
      }
      skipped.push({
        id: node.id,
        type: node.type,
        reason: isCosmeticNodeClass(node.type)
          ? 'canvas decoration; it has no backend node and no connections'
          : 'node class is not installed on this instance',
      });
      continue;
    }

    const linked = new Map();
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (input?.link === undefined || input.link === null) continue;
      if (typeof input?.name !== 'string' || input.name.length === 0) continue;
      linked.set(input.name, input.link);
    }

    const entries = alignWidgetValues({ order, namedValues: named, values, linked, notes, node });
    const inputs = {};
    for (const entry of entries) {
      if (entry.value === undefined || entry.slot.phantom || entry.ignore) continue;
      inputs[entry.slot.name] = normalizeComfyWidgetValue(entry.value);
      if (entry.mismatch !== undefined) {
        notes.push(`node ${node.id} (${node.type}) input "${entry.slot.name}" holds ${JSON.stringify(entry.value)} but expects ${entry.mismatch}; check this input before queueing`);
      }
    }

    for (const [name, linkId] of linked) {
      const origin = findLinkOrigin(graph, linkId);
      if (origin === undefined) {
        notes.push(`node ${node.id} (${node.type}) input "${name}" points at link ${String(linkId)} with no listed origin; ComfyUI validation will reject it`);
        continue;
      }
      inputs[name] = [String(origin.originId), origin.originSlot];
    }

    prompt[String(node.id)] = {
      class_type: node.type,
      inputs,
      ...node.title === undefined ? {} : { _meta: { title: node.title } },
    };
  }

  // Resolve every reference that now points at a bypassed node.
  if (bypassed.size > 0) {
    for (const node of Object.values(prompt)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!Array.isArray(value)) continue;
        const resolved = resolveThroughBypass({ graph, bypassed, nodes: byId, nodeId: value[0], slot: value[1], notes });
        if (resolved === undefined) {
          // Leaving the orphan in place makes ComfyUI raise "Exception when
          // validating inner node" and refuse the whole prompt, so the input is
          // dropped and the node falls back to its own default.
          delete node.inputs[name];
          notes.push(`the "${name}" input of ${node.class_type} was wired from a bypassed node that passes nothing through, so it was dropped and the workflow default applies`);
          continue;
        }
        if (resolved[0] !== String(value[0]) || resolved[1] !== value[1]) {
          notes.push(`the "${name}" input of ${node.class_type} was rewired from bypassed node ${String(value[0])} to node ${resolved[0]} slot ${resolved[1]}`);
        }
        node.inputs[name] = resolved;
      }
    }
  }

  // Resolve SetNode / GetNode virtual wires into direct links, then run the
  // bypass pass over the result so a GetNode that lands on a bypassed node is
  // followed all the way to a live source.
  if (virtualWires.size > 0) {
    const published = new Map();
    for (const node of nodes) {
      if (node?.type !== 'SetNode') continue;
      const key = node.widgets_values?.[0];
      const input = (Array.isArray(node.inputs) ? node.inputs : []).find((candidate) => candidate?.link !== undefined && candidate.link !== null);
      if (key === undefined || input === undefined) continue;
      const origin = findLinkOrigin(graph, input.link);
      if (origin !== undefined) published.set(String(key), [String(origin.originId), origin.originSlot]);
    }
    const reads = [...virtualWires.entries()].filter(([, wire]) => wire.kind === 'GetNode');
    const resolvedWires = new Map();
    for (const [getNodeId, wire] of reads) {
      const source = wire.key === null ? undefined : published.get(String(wire.key));
      if (source === undefined) {
        notes.push(`GetNode ${getNodeId} reads the key ${JSON.stringify(wire.key)} but no SetNode publishes it; whatever consumed it is left unset`);
        continue;
      }
      const throughBypass = resolveThroughBypass({ graph, bypassed, nodes: byId, nodeId: source[0], slot: source[1], notes });
      if (throughBypass !== undefined) resolvedWires.set(String(getNodeId), throughBypass);
    }
    for (const node of Object.values(prompt)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!Array.isArray(value)) continue;
        const source = resolvedWires.get(value[0]);
        if (source === undefined) continue;
        node.inputs[name] = [source[0], source[1] + value[1]];
      }
    }
  }

  if (Object.keys(prompt).length === 0) throw new Error('the workflow converted to an empty prompt');

  // A reference slot can be wired from a GetNode whose SetNode has nothing wired
  // into it (the author bypassed that source to leave the slot empty). That leaves
  // an input pointing at a node the prompt does not contain, and ComfyUI rejects
  // the WHOLE graph for it. Such a slot was meant to be empty, so it is dropped.
  for (const node of Object.values(prompt)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || prompt[String(value[0])] !== undefined) continue;
      delete node.inputs[name];
      notes.push(`the "${name}" input of ${node.class_type} was wired from node ${value[0]}, which is bypassed or empty in the saved workflow, so it was dropped and that optional slot is left unset`);
    }
  }

  return { prompt, skipped, notes, nodeIndex: byId };
}

/**
 * Fill required inputs that the converted graph leaves empty.
 *
 * A helper node such as `Seed (rgthree)` hides its real inputs behind linked
 * subnodes; when the saved state has no link there, the API prompt reaches
 * ComfyUI with a required input missing and the whole submission is rejected.
 * The value the frontend would show is the input's declared default, so that is
 * what gets written here.
 *
 * @returns one note per filled input, so the caller can report what was assumed.
 */
export function applyRequiredDefaults(prompt, objectInfo) {
  const notes = [];
  for (const [id, node] of Object.entries(prompt)) {
    const required = objectInfo?.[node.class_type]?.input?.required;
    if (required === undefined || required === null) continue;
    for (const [name, spec] of Object.entries(required)) {
      if (Object.hasOwn(node.inputs ?? {}, name)) continue;
      const kind = Array.isArray(spec) ? spec[0] : undefined;
      const declared = Array.isArray(spec) ? spec[1] : undefined;

      // A dropdown must be given one of its listed choices; leaving it empty makes
      // ComfyUI reject the node, and it then ignores the whole branch that depends on
      // it - silently, with only a server-log line to show for it.
      if (kind === 'COMBO') {
        const options = Array.isArray(declared?.options) ? declared.options : [];
        if (options.length === 0) continue;
        const choice = options[0];
        if (typeof choice !== 'string' && typeof choice !== 'number') continue;
        node.inputs[name] = choice;
        notes.push(`node ${id} (${node.class_type}) had no value for the required dropdown "${name}", so "${choice}" was used; the other choices are ${options.slice(1, 5).map((entry) => JSON.stringify(entry)).join(', ')}${options.length > 5 ? ', …' : ''}`);
        continue;
      }
      // A dynamic combo carries its sub-inputs under the chosen key: the saved graph
      // holds `mode.scale`, but the server also wants `mode` to say which branch that
      // sub-input belongs to.
      if (kind === 'COMFY_DYNAMICCOMBO_V3') {
        const keys = (Array.isArray(declared?.options) ? declared.options : [])
          .map((entry) => entry?.key)
          .filter((key) => typeof key === 'string');
        if (keys.length === 0) continue;
        // Prefer the key whose sub-inputs the graph already supplies, so the values it
        // has are the ones that take effect.
        const supplied = keys.find((key) => Object.keys(node.inputs ?? {}).some((inputName) => inputName.startsWith(`${name}.`)));
        const chosen = supplied ?? keys[0];
        node.inputs[name] = chosen;
        notes.push(`node ${id} (${node.class_type}) had no value for the required dynamic option "${name}", so "${chosen}" was used to match the ${name}.* inputs the graph already carries`);
        continue;
      }
      const hasDefault = declared !== null && typeof declared === 'object' && Object.hasOwn(declared, 'default');
      if (!hasDefault) continue;
      node.inputs[name] = declared.default;
      notes.push(`node ${id} (${node.class_type}) had no value for the required input "${name}", so its default ${JSON.stringify(declared.default)} was used; set it explicitly if that is wrong`);
    }
  }
  return notes;
}

/**
 * Follow one output slot through any chain of bypassed nodes to a live source.
 *
 * A bypassed node forwards the input that lines up with the requested output
 * slot, so the walk hops from the bypassed node to that input's own source and
 * repeats.
 *
 * @returns the surviving `[nodeId, slot]` pair, or undefined when the chain
 *   dead-ends in a bypassed node with nothing at that slot.
 */
function resolveThroughBypass({ graph, bypassed, nodes, nodeId, slot, notes, depth = 0 }) {
  if (depth > 32) {
    notes.push(`bypass chain from node ${String(nodeId)} exceeded 32 hops; the workflow may contain a cycle`);
    return ['0', 0];
  }
  const bypassedNode = bypassed.get(Number(nodeId));
  if (bypassedNode === undefined) return [String(nodeId), slot];
  const sourceInputName = bypassedNode[slot];
  if (sourceInputName === undefined) return undefined;
  const original = nodes.get(Number(nodeId));
  const input = (Array.isArray(original?.inputs) ? original.inputs : []).find((candidate) => candidate?.name === sourceInputName);
  if (input?.link === undefined || input.link === null) return undefined;
  const origin = findLinkOrigin(graph, input.link);
  if (origin === undefined) return undefined;
  return resolveThroughBypass({ graph, bypassed, nodes, nodeId: origin.originId, slot: origin.originSlot, notes, depth: depth + 1 });
}

/**
 * The inputs a bypassed node would forward, in output-slot order.
 *
 * The frontend matches the node's declared outputs to its declared inputs by
 * index, so an output whose matching input is unconnected (or does not exist)
 * has nothing to pass through and its consumers cannot be satisfied.
 */
function passThroughInputs(node) {
  const inputs = [];
  for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
    if (input?.link === undefined || input.link === null) { inputs.push(undefined); continue; }
    inputs.push(input.name);
  }
  const outputs = Array.isArray(node?.outputs) ? node.outputs.length : 0;
  return Array.from({ length: Math.max(outputs, inputs.length) }, (_, index) => inputs[index]);
}


/** Resolve a link id into its origin node and output slot. */
function findLinkOrigin(graph, linkId) {
  for (const link of Array.isArray(graph?.links) ? graph.links : []) {
    if (Array.isArray(link) && link[0] === linkId) return { originId: link[1], originSlot: link[2] };
  }
  // Newer frontends store links only on the node output/input slots.
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
    for (let slot = 0; slot < outputs.length; slot += 1) {
      const links = outputs[slot]?.links;
      if (Array.isArray(links) && links.includes(linkId)) {
        return { originId: node.id, originSlot: outputs[slot]?.slot_index ?? slot };
      }
    }
    for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
      const link = input?.link;
      if (link !== null && typeof link === 'object' && link?.id === linkId) {
        return { originId: link.origin_id, originSlot: link.origin_slot };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Graph patching
// ---------------------------------------------------------------------------

/**
 * Apply `key=value` overrides to an API prompt.
 *
 * A key is either a node id (`"42.prompt"`), a node title from the workflow
 * (`"Positive Prompt.text"`), or a bare input name when exactly one node in the
 * prompt declares it (`"seed"`, `"text"`).
 */
export function patchPrompt(prompt, overrides = {}, { titles } = {}) {
  const applied = [];
  const failed = [];
  for (const [key, rawValue] of Object.entries(overrides)) {
    const dot = key.lastIndexOf('.');
    if (dot <= 0) {
      failed.push({ key, reason: 'expected "<nodeId|title|class_type>.<input>"' });
      continue;
    }
    const target = key.slice(0, dot);
    const input = key.slice(dot + 1);
    // `*.input` is the explicit form of "whichever node declares this input".
    // Implicitly falling back to a bare input-name match is deliberately NOT
    // done: a wrong node id would then silently patch some unrelated node, and
    // the caller would believe its value was applied.
    const matches = target === '*'
      ? Object.entries(prompt).filter(([, node]) => Object.hasOwn(node.inputs ?? {}, input))
      : Object.entries(prompt).filter(([id, node]) => id === target || node._meta?.title === target || node.class_type === target);
    const resolved = matches;
    if (resolved.length === 0) {
      failed.push({ key, reason: `no node matched "${target}"; use a node id or node title from comfy_graph, or "*" for the single node declaring that input`, availableIds: Object.keys(prompt).slice(0, 20) });
      continue;
    }
    if (resolved.length > 1) {
      failed.push({ key, reason: `"${target}" matched ${resolved.length} nodes; use the node id`, candidates: resolved.map(([id, node]) => `${id}(${node._meta?.title ?? node.class_type})`) });
      continue;
    }
    const [id, node] = resolved[0];
    if (!Object.hasOwn(node.inputs ?? {}, input)) {
      failed.push({ key, reason: `node ${id} (${node.class_type}) has no input "${input}"`, available: Object.keys(node.inputs ?? {}) });
      continue;
    }
    const previous = node.inputs[input];
    node.inputs[input] = coerceLike(previous, rawValue);
    applied.push({ node: id, classType: node.class_type, input, from: previous, to: node.inputs[input] });
  }
  return { applied, failed };
}

/** Keep the patched value's JSON type aligned with the value already in the graph. */
function coerceLike(previous, value) {
  if (typeof value !== 'string') return value;
  if (typeof previous === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof previous === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  return normalizeComfyWidgetValue(value);
}

/**
 * Summarize a prompt for planning: node id, class, title, and the inputs a
 * caller is most likely to patch (text, images, sizes, seeds, steps).
 */
export function summarizePrompt(prompt, { limit = 400 } = {}) {
  // `steps?` matters: SplitSigmas carries the 涓€閲?step count in a singular
  // `step` input, and dropping it would hide the parameter the director tunes.
  const INTERESTING = /prompt|text|image|width|height|size|seed|steps?|cfg|denoise|scale|filename_prefix|sigma|scheduler|length|fps|frames|model|ckpt|lora|vae/i;
  const nodes = [];
  for (const [id, node] of Object.entries(prompt)) {
    const inputs = {};
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value)) {
        inputs[name] = `<- node ${value[0]} slot ${value[1]}`;
        continue;
      }
      if (typeof value === 'string' && value.length > 160) {
        inputs[name] = `${value.slice(0, 160)}鈥?(${value.length} chars)`;
        continue;
      }
      inputs[name] = value;
    }
    const interesting = Object.fromEntries(Object.entries(inputs).filter(([name]) => INTERESTING.test(name)));
    nodes.push({ id, classType: node.class_type, title: node._meta?.title ?? null, inputs: interesting });
  }
  nodes.sort((a, b) => Number(a.id) - Number(b.id));
  return {
    nodeCount: nodes.length,
    nodes: nodes.slice(0, limit),
    truncated: nodes.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Queue / history / files
// ---------------------------------------------------------------------------

/**
 * The remote file name one local file must be uploaded under.
 *
 * Uploading by basename alone is not safe: `overwrite` defaults to true, so two
 * different files that happen to share a name - `正面.png` from two character folders is
 * the common case - silently replace each other in the instance's input directory, and
 * whichever upload landed last is what every node then reads. The hash makes the name a
 * function of the CONTENT, which gives both properties we need at once: files that
 * differ can never collide, and re-running the same workflow reuses the same remote path
 * instead of leaving another stale copy behind.
 *
 * Exported separately from the upload so the caller can learn the final name BEFORE
 * uploading. That is what lets every failure be found first and only then put bytes on
 * the wire - the ordering fix in `comfy_run`.
 *
 * @param sha256 - 64 hex characters of the file's content hash.
 * @param localPath - the source path, used only for its extension and readable stem.
 * @returns a name of the form `dsh-<stem>-<first12>-<ext>`.
 */
export function remoteNameForContent(sha256, localPath) {
  const digest = String(sha256 ?? '').toLowerCase().slice(0, 12);
  if (!/^[0-9a-f]{12}$/u.test(digest)) throw new Error(`remoteNameForContent needs a sha256 hash; got ${JSON.stringify(sha256)}`);
  const ext = extname(localPath);
  const rawStem = basename(localPath, ext);
  // Keep it recognisable in the instance's input list, but strip anything that could
  // change how the server treats the name (path separators, control characters).
  const stem = rawStem.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 40) || 'file';
  return `dsh-${stem}-${digest}${ext.toLowerCase()}`;
}

/** Upload one local file into the instance's `input` directory. */
export async function uploadImage(baseUrl, { filePath, fileName, subfolder = '', overwrite = true, timeoutMs = 120000, signal }) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('image', new Blob([bytes]), fileName);
  form.append('overwrite', overwrite ? 'true' : 'false');
  if (subfolder.length > 0) form.append('subfolder', subfolder);
  return await fetchJson(baseUrl, '/upload/image', {
    method: 'POST',
    body: form,
    timeoutMs,
    signal,
  });
}

/**
 * How many reference images a saved workflow can actually take.
 *
 * A model's spec sheet says what it accepts; a saved graph says what it can be GIVEN, and only the
 * second number decides whether a submission fails five minutes into a queue. Three things make
 * them differ, and all three are read from the graph rather than assumed:
 *
 *   - a slot WIRED from another node is fed by that node, so an upload cannot reach it; that is
 *     what makes a declared slot unusable, and it is a fact only the graph knows;
 *   - a bypassed node (mode 4) or a muted one (mode 2) does not run, so its slots accept nothing;
 *   - a graph may simply have more or fewer image inputs than the model documents. The wiring is
 *     the truth.
 *
 * A slot that already names a file still COUNTS: uploading over it is how every regeneration works,
 * so treating it as unavailable would refuse work the instance would happily accept. The occupied
 * count is returned separately, to be reported rather than deducted.
 *
 * @param prompt - the API-format graph.
 * @param objectInfo - node definitions from the instance, used to recognise image inputs.
 * @returns `{ available, wired, bypassed, filled, slots }`.
 */
export function countReferenceSlots(prompt, objectInfo = null) {
  const graph = prompt !== null && typeof prompt === 'object' ? prompt : {};
  // Classes that hold an image the plugin can upload into, so a node of one of these is a feeder.
  const FEEDER_CLASSES = /^(LoadImage|LoadImageMask|LoadImageOutput|VHS_LoadVideo|LoadVideo)$/u;
  const slots = [];
  let wired = 0;
  let bypassed = 0;
  let filled = 0;

  for (const [nodeId, node] of Object.entries(graph)) {
    if (node === null || typeof node !== 'object') continue;
    const classType = String(node.class_type ?? '');
    const mode = node.mode ?? node._meta?.mode ?? 0;
    const inactive = mode === 2 || mode === 4;
    const inputs = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {};
    const declared = objectInfo?.[classType]?.input;
    const required = declared?.required ?? {};
    const optional = declared?.optional ?? {};

    for (const [name, value] of Object.entries(inputs)) {
      // A declared spec of `IMAGE` is the instance saying this input takes an image, which is the
      // authoritative signal for a class this plugin cannot recognise by name.
      const spec = required[name] ?? optional[name];
      const declaredImage = Array.isArray(spec) && String(spec[0] ?? '').toUpperCase() === 'IMAGE';
      const looksLikeImage = declaredImage
        || /image|reference|ref_image|init_image|mask/i.test(name)
        || FEEDER_CLASSES.test(classType);
      if (!looksLikeImage) continue;

      // A link is a `[nodeId, outputIndex]` pair: the slot is fed by the graph, not by an upload.
      // A link is a [nodeId, outputIndex] pair: the slot is fed by the graph, so an upload cannot
      // reach it. THIS is what makes a declared slot unusable, and it is why the count comes from
      // the wiring rather than from the model's spec sheet.
      const isLink = Array.isArray(value) && value.length === 2
        && typeof value[0] === 'string' && typeof value[1] === 'number';
      if (isLink) { wired += 1; continue; }
      if (inactive) { bypassed += 1; continue; }
      // A slot that already names a file is still WRITABLE - this plugin uploads over it, which is
      // how every regeneration works - so it counts as capacity. It is reported separately only so
      // an over-capacity message can say how many are already occupied.
      const occupied = typeof value === 'string' && value.trim().length > 0;
      if (occupied) filled += 1;
      slots.push({ nodeId, input: name, classType, occupied });
    }
  }

  return { available: slots.length, wired, bypassed, filled, slots };
}

/** Submit a prompt, returning its queue id. */
export async function queuePrompt(baseUrl, prompt, { clientId = 'dsh-short-drama-director', timeoutMs = 60000, signal } = {}) {
  const payload = JSON.stringify({ prompt, client_id: clientId });
  return await fetchJson(baseUrl, '/prompt', {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json' },
    timeoutMs,
    signal,
  });
}

/**
 * A submission whose fate is genuinely unknown.
 *
 * The distinction this carries is the one that matters most here. A transport failure has
 * three possible meanings and only one of them is safe to retry:
 *
 *   - the request never reached the instance (safe)
 *   - the instance accepted it and the reply was lost (retrying DOUBLES the work)
 *   - the instance rejected it (retrying changes nothing)
 *
 * A timeout or a reset connection cannot tell these apart, so the caller must not retry
 * automatically. This error type exists so that fact cannot be lost on the way up.
 */
export class SubmissionUnknownError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SubmissionUnknownError';
    this.code = 'SUBMISSION_UNKNOWN';
    Object.assign(this, detail);
  }
}

/**
 * Submit a prompt, distinguishing "the instance declined" from "no answer".
 *
 * An HTTP status IS an answer: the instance spoke and declined, so nothing is running and
 * retrying is safe. A timeout, an aborted connection, or a body that arrives unparseable is
 * NOT an answer, and the prompt may well be queued right now.
 */
export async function submitPrompt(baseUrl, prompt, { clientId = 'dsh-short-drama-director', timeoutMs = 60000, signal } = {}) {
  const unknown = (cause) => new SubmissionUnknownError(
    `no usable reply from ${baseUrl} for the submission, so it may or may not have been accepted (${cause}). `
    + 'Check the instance queue before resubmitting: sending it again could double the work',
    { baseUrl, cause },
  );
  try {
    const result = await queuePrompt(baseUrl, prompt, { clientId, timeoutMs, signal });
    const promptId = String(result?.prompt_id ?? '');
    if (promptId.length === 0) {
      // A success response with no prompt id is as unresolved as a timeout: something may have
      // been accepted, and there is no id to poll for it.
      throw unknown(`the reply carried no prompt_id: ${JSON.stringify(result ?? null).slice(0, 200)}`);
    }
    return result;
  } catch (error) {
    if (error instanceof SubmissionUnknownError) throw error;
    const message = String(error?.message ?? error);
    // An HTTP status is the instance declining, which is a real answer.
    if (/-> HTTP \d/u.test(message)) throw error;
    if (signal?.aborted === true) throw unknown(`the submission was cancelled before a reply arrived: ${message}`);
    throw unknown(message);
  }
}

/** Read one history entry by prompt id. */
export async function readHistory(baseUrl, promptId, { timeoutMs = 30000, signal } = {}) {
  return await fetchJson(baseUrl, `/history/${encodeURIComponent(promptId)}`, { timeoutMs, signal });
}

/** Read queue state. */
export async function readQueue(baseUrl, { timeoutMs = 15000, signal } = {}) {
  return await fetchJson(baseUrl, '/queue', { timeoutMs, signal });
}

/** Interrupt the running job. */
export async function interrupt(baseUrl, { timeoutMs = 15000, signal } = {}) {
  return await fetchJson(baseUrl, '/interrupt', { method: 'POST', body: '{}', timeoutMs, signal });
}

/**
 * Remove ONE queue entry, leaving every other task alone.
 *
 * This is the safe cancellation, and the reason the instance-level `/interrupt` is not: on a
 * shared instance that one stops whatever is running, including somebody else's job. Deleting a
 * specific queue entry is a request about one prompt id and cannot affect anything else.
 *
 * Two cases, because the queue has two halves and a prompt id lives in exactly one of them:
 * `queue_pending` holds what has not started, and those are deletable; `queue_running` is already
 * executing, and ComfyUI does not remove a running entry. A running job can only be stopped by an
 * interrupt, which is a different request with a different blast radius - so this REPORTS which
 * case it met rather than quietly escalating to one.
 *
 * @returns `{ removed, was, running, entry }` - `was` is 'pending', 'running' or 'missing'.
 */
export async function cancelQueueItem(baseUrl, promptId, { timeoutMs = 15000, signal } = {}) {
  const id = String(promptId ?? '');
  if (id.length === 0) throw new Error('cancelQueueItem needs a prompt id');
  const queue = await readQueue(baseUrl, { timeoutMs, signal });
  const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : [];
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running : [];

  // An entry is `[number, promptId, graph, extra]`, but the shape is not guaranteed across
  // versions, so the id is looked for at any position rather than at index 1.
  const find = (rows) => rows.find((row) => Array.isArray(row) && row.some((cell) => String(cell) === id));
  const pendingEntry = find(pending);
  const runningEntry = find(running);

  if (pendingEntry === undefined && runningEntry === undefined) {
    return { removed: false, was: 'missing', running: false, entry: null };
  }
  if (pendingEntry === undefined) {
    return { removed: false, was: 'running', running: true, entry: runningEntry };
  }
  await fetchJson(baseUrl, '/queue', {
    method: 'POST',
    body: JSON.stringify({ delete: [id] }),
    headers: { 'content-type': 'application/json' },
    timeoutMs,
    signal,
  });
  return { removed: true, was: 'pending', running: false, entry: pendingEntry };
}

/** Download a produced image or video into memory. */
export async function downloadOutput(baseUrl, { filename, subfolder = '', type = 'output', timeoutMs = 600000, signal }) {
  const query = new URLSearchParams({ filename, ...(subfolder.length > 0 ? { subfolder } : {}), type });
  const url = `${normalizeBaseUrl(baseUrl)}/view?${query.toString()}`;
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, url };
}

/**
 * Reduce a history entry into the ordered outputs it produced.
 *
 * Discovers both `images` and `videos`/`gifs` output buckets so an upscaled
 * video and a still frame from the same run are both reported.
 */
export function collectOutputs(historyEntry) {
  const outputs = [];
  const source = historyEntry?.outputs;
  if (source === undefined || source === null) return outputs;
  for (const [nodeId, buckets] of Object.entries(source)) {
    if (buckets === null || typeof buckets !== 'object') continue;
    for (const [bucket, items] of Object.entries(buckets)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item === null || typeof item !== 'object' || typeof item.filename !== 'string') continue;
        outputs.push({
          nodeId,
          bucket,
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output',
          ...item.format === undefined ? {} : { format: item.format },
        });
      }
    }
  }
  return outputs;
}

/** Wall-clock status of one queued prompt from `/queue` plus `/history`. */
export async function pollPrompt(baseUrl, promptId, { timeoutMs = 15000, signal } = {}) {
  const history = await readHistory(baseUrl, promptId, { timeoutMs, signal });
  const entry = history?.[promptId];
  if (entry !== undefined) {
    const status = entry.status ?? {};
    return {
      state: status.completed === true || status.status_str === 'success' ? 'completed' : 'error',
      status,
      outputs: collectOutputs(entry),
    };
  }
  const queue = await readQueue(baseUrl, { timeoutMs, signal });
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running : [];
  const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : [];
  const isRunning = running.some((item) => Array.isArray(item) && String(item[1]) === promptId);
  const position = pending.findIndex((item) => Array.isArray(item) && String(item[1]) === promptId);
  if (isRunning) {
    return { state: 'running', queuePosition: null, pending: pending.length };
  }
  if (position >= 0) {
    return { state: 'pending', queuePosition: position + 1, pending: pending.length };
  }
  // A prompt that is neither queued nor in history has not finished - ComfyUI only
  // writes the history entry when the run ends. Reporting it as finished would
  // make the caller collect an empty result and report a failure that is really
  // just "still starting", so the queue is re-read once before giving up.
  const retry = await readQueue(baseUrl, { timeoutMs, signal });
  const retryRunning = Array.isArray(retry?.queue_running) ? retry.queue_running : [];
  const retryPending = Array.isArray(retry?.queue_pending) ? retry.queue_pending : [];
  if (retryRunning.some((item) => Array.isArray(item) && String(item[1]) === promptId) || retryPending.some((item) => Array.isArray(item) && String(item[1]) === promptId)) {
    return { state: 'running', queuePosition: null, pending: retryPending.length };
  }
  return {
    state: 'unknown',
    queuePosition: null,
    pending: retryPending.length,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Render a failed history entry's node errors into short lines. */
export function formatExecutionErrors(historyEntry) {
  const messages = [];
  const status = historyEntry?.status ?? {};
  for (const message of Array.isArray(status.messages) ? status.messages : []) {
    if (!Array.isArray(message)) continue;
    const [kind, payload] = message;
    if (kind !== 'execution_error' && kind !== 'execution_interrupted') continue;
    const node = payload?.node_type === undefined ? '' : ` [${payload.node_type}#${payload.node_id}]`;
    messages.push(`${kind}${node}: ${payload?.exception_message ?? JSON.stringify(payload).slice(0, 400)}`);
  }
  return messages;
}
