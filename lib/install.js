/**
 * Installation detection and machine capability check.
 *
 * Two questions this answers before anything expensive happens:
 *
 *  - Is ComfyUI already on this machine? Installing it again costs over a
 *    hundred gigabytes, and the usual cause is simply that the user forgot, so
 *    several independent signals are checked and the caller must report which
 *    ones fired rather than announcing a verdict out of nowhere.
 *  - What can this machine actually run? A 6 GB laptop GPU generates stills
 *    happily and cannot run the H3 video graph at all, and saying so up front is
 *    kinder than letting a run fail.
 *
 * @module dsh-plugin-short-drama-director/lib/install
 */

import { access, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { discoverInstallations } from './env-discovery.js';

/** Files that prove a directory is a runnable ComfyUI rather than a stray folder. */
const RUNNABLE_MARKERS = [
  'python_embeded/python.exe',
  'python_embeded\\python.exe',
  'run_nvidia_gpu.bat',
  'run_cpu.bat',
  'main.py',
  'ComfyUI/main.py',
  // 绘世/Aki-style integrated package: its own interpreter beside the backend. This shape
  // has NO run_*.bat at all, so without these two markers a perfectly working install would
  // be invisible to detection - and the caller would be told to install a second copy.
  'python/python.exe',
  'python\\python.exe',
];

/** A marker pair that only an integrated package satisfies, checked as a set. */
const INTEGRATED_MARKERS = [['python/python.exe', 'ComfyUI/main.py']];

/** Files that prove a directory holds a deployment package, not an install. */
const PACKAGE_MARKERS = ['install_windows.ps1', 'MANIFEST.txt', 'README_必读.txt', 'INSTALL_PROMPT.md', 'INSTALL_PROMPT_CLOUD.md'];

const ARCHIVE_FILE = /\.(?:rar|7z|zip)$/iu;
const PACKAGE_NAME_HINT = /comfy|绘世|aki|deploy|整合|部署|download|下载|夸克|quark|网盘/iu;

/** A downloaded bundle outside the configured paths, so a first-time user is not asked to download twice. */
async function inspectPackagePath(path) {
  if (await isDirectory(path)) return inspectRoot(path);
  if (!await exists(path) || !ARCHIVE_FILE.test(path)) return null;
  const name = basename(path);
  if (!/comfy|绘世|aki/iu.test(name)) return null;
  return {
    path,
    kind: 'package',
    layout: 'archive',
    markers: [name],
    topLevel: [],
  };
}

/** True when a path exists. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when a path is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Candidate install roots, derived from configuration rather than hardcoded. */
function candidateRoots(config) {
  const roots = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const path = value.trim();
    if (!roots.includes(path)) roots.push(path);
  };
  add(config.comfyuiPortablePath);
  add(config.deployPackPath);
  add(config.cloudPatchPackPath);
  // A sibling of the configured portable install usually holds the other copies
  // of the same deployment, which is how a forgotten install is found.
  if (typeof config.comfyuiPortablePath === 'string' && config.comfyuiPortablePath.includes('\\')) {
    const parent = config.comfyuiPortablePath.slice(0, config.comfyuiPortablePath.lastIndexOf('\\'));
    if (parent.length > 0 && isAbsolute(parent)) add(parent);
  }
  return roots;
}

/**
 * Inspect one directory for install or package markers.
 *
 * @returns `{ path, kind, markers, sizeHint }` where `kind` is `install`,
 *   `package`, `empty`, or `absent`.
 */
async function inspectRoot(path) {
  if (!await isDirectory(path)) return { path, kind: 'absent', markers: [] };
  const markers = [];
  for (const marker of RUNNABLE_MARKERS) {
    if (await exists(join(path, marker))) markers.push(marker);
  }
  const packetMarkers = [];
  for (const marker of PACKAGE_MARKERS) {
    if (await exists(join(path, marker))) packetMarkers.push(marker);
  }
  let entries = [];
  try {
    entries = (await readdir(path, { withFileTypes: true })).map((entry) => entry.name);
  } catch {
    // An unreadable directory tells us nothing beyond its existence.
  }
  if (markers.length > 0) {
    // Tell the two layouts apart, because they start differently: a portable build launches
    // through a .bat, while an integrated package must be started as `python main.py`.
    const integrated = INTEGRATED_MARKERS.every((group) => group.every((marker) => markers.includes(marker)));
    return { path, kind: 'install', layout: integrated ? 'integrated' : 'portable', markers, packageMarkers: packetMarkers, topLevel: entries.slice(0, 12) };
  }
  // Quark integrated bundles are often staged as:
  //   <folder>/ComfyUI/ComfyUI-aki-v3.2.rar
  //   <folder>/models, custom_nodes, workflows
  // The archive is not an install yet, but it is a complete deploy source.
  const comfyDir = join(path, 'ComfyUI');
  if (await isDirectory(comfyDir)) {
    let nested = [];
    try {
      nested = await readdir(comfyDir, { withFileTypes: true });
    } catch {
      nested = [];
    }
    const archive = nested.find((entry) => entry.isFile() && ARCHIVE_FILE.test(entry.name) && /comfy|绘世|aki/iu.test(entry.name));
    if (archive !== undefined) {
      return {
        path,
        kind: 'package',
        layout: 'integrated-archive',
        markers: [`ComfyUI/${archive.name}`],
        packageMarkers: packetMarkers,
        topLevel: entries.slice(0, 12),
      };
    }
  }
  if (await isDirectory(join(path, 'ComfyUI_windows_portable'))
    && (await isDirectory(join(path, 'models')) || await isDirectory(join(path, 'python_env')))) {
    return {
      path,
      kind: 'package',
      layout: 'portable-bundle',
      markers: ['ComfyUI_windows_portable', 'models/python_env'],
      packageMarkers: packetMarkers,
      topLevel: entries.slice(0, 12),
    };
  }
  if (packetMarkers.length > 0) return { path, kind: 'package', markers: packetMarkers, topLevel: entries.slice(0, 12) };
  return { path, kind: entries.length === 0 ? 'empty' : 'other', markers: [], topLevel: entries.slice(0, 12) };
}

/**
 * Find downloaded deployment bundles without requiring `deployPackPath`.
 *
 * Downloads/Desktop/Documents are scanned shallowly. Drive roots are only descended into
 * folders whose names look ComfyUI-related, which keeps a fresh-user check quick while still
 * finding folders such as `D:\comfyui专属\ComfyUI-Deploy-20261022`.
 */
export async function discoverDeploymentPackages(config = {}, env = process.env) {
  const homes = [];
  const home = env.USERPROFILE ?? env.HOME;
  if (typeof home === 'string' && home.length > 0) {
    homes.push(join(home, 'Downloads'), join(home, 'Desktop'), join(home, 'Documents'));
  }

  const configuredPaths = [
    config.deployPackPath,
    config.cloudPatchPackPath,
    ...(Array.isArray(config.comfyuiSearchPaths) ? config.comfyuiSearchPaths : []),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);

  const broadBases = [...homes, ...configuredPaths];
  const hintedDriveBases = [];
  if (configuredPaths.length === 0) {
    const system = typeof env.SystemDrive === 'string' ? env.SystemDrive.replace(/[\\/]+$/u, '') : 'C:';
    for (const letter of 'CDEFGH'.split('')) {
      const drive = `${letter}:\\`;
      if (letter === system.replace(':', '') || await isDirectory(drive)) hintedDriveBases.push(drive);
    }
  }

  const packages = new Map();
  const visited = new Set();
  const inspectOne = async (path) => {
    const key = String(path).toLowerCase();
    if (visited.has(key)) return packages.get(key);
    visited.add(key);
    const evidence = await inspectPackagePath(path).catch(() => null);
    if (evidence?.kind === 'package') {
      packages.set(key, evidence);
      return evidence;
    }
    return null;
  };
  const inspectChildren = async (base) => {
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(base, entry.name);
      if (entry.isFile()) {
        await inspectOne(child);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const evidence = await inspectOne(child);
      if (evidence?.kind === 'package') continue;
      if (!PACKAGE_NAME_HINT.test(entry.name)) continue;
      let nested = [];
      try {
        nested = await readdir(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of nested) {
        if (item.isFile()) await inspectOne(join(child, item.name));
        else if (item.isDirectory() && PACKAGE_NAME_HINT.test(item.name)) {
          await inspectOne(join(child, item.name));
        }
      }
    }
  };

  for (const base of broadBases) {
    await inspectOne(base);
    await inspectChildren(base);
  }
  for (const drive of hintedDriveBases) {
    await inspectChildren(drive);
  }
  return [...packages.values()];
}

/**
 * Look for an existing ComfyUI without installing anything.
 *
 * This used to inspect only `candidateRoots(config)` - the configured paths, the environment
 * variables, a recorded path and a couple of conventional user folders. It never asked the
 * plugin's own discovery, which is the code that actually finds installs on a real machine.
 *
 * The cost of that split was measured: on a machine with three working installs (a 绘世 package
 * and two portable builds), with nothing configured, `comfy_install action=check` answered
 * "Nothing is installed here" and offered to download ~100 GB - while `discoverInstallations()`
 * found all three in 48 ms. The first thing a new user asks is "will my computer work", so the
 * first answer they got was the opposite of the truth.
 *
 * Discovery is therefore the PRIMARY source here, and the marker scan below is kept only for
 * what discovery does not cover: deployment PACKAGES that are not installed yet (a folder with
 * `install_windows.ps1` but no `main.py`), which matter because they turn "download 100 GB"
 * into "unpack what you already have".
 *
 * @param config - plugin configuration, used as hints for discovery.
 * @param options.liveBaseUrls - addresses an instance answered on, if any.
 * @param options.statePath - the plugin state file, for a path a previous session recorded.
 * @returns signals, the roots inspected, and a recommendation the caller can act on.
 */
export async function detectInstalls(config, {
  liveBaseUrls = [],
  state,
  statePath: stateFile = undefined,
  env = process.env,
} = {}) {
  const signals = [];
  const roots = [];
  for (const root of candidateRoots(config)) {
    roots.push(await inspectRoot(root));
  }
  const packageByPath = new Map();
  for (const root of roots.filter((entry) => entry.kind === 'package')) {
    packageByPath.set(String(root.path).toLowerCase(), root);
  }
  for (const packet of await discoverDeploymentPackages(config, env).catch(() => [])) {
    packageByPath.set(String(packet.path).toLowerCase(), packet);
  }
  const packages = [...packageByPath.values()];

  // Discovery first: same function the launcher and the workflow index use, so "is it
  // installed" and "which one do I start" can never give two different answers.
  const discovery = await discoverInstallations(config, { statePath: stateFile }).catch(() => ({ installs: [], inspected: [] }));
  const discovered = discovery.installs ?? [];
  // The marker scan can agree with discovery (both see `ComfyUI/main.py`); one directory must
  // not be reported twice under two names.
  const seenPaths = new Set(discovered.map((entry) => String(entry.path).toLowerCase()));
  const scannedInstalls = roots
    .filter((root) => root.kind === 'install' && !seenPaths.has(String(root.path).toLowerCase()))
    .map((root) => ({ path: root.path, layout: root.layout ?? 'portable', markers: root.markers, source: 'marker scan' }));
  // The marker files that PROVED the layout. Discovery reports the layout it detected, and this
  // turns that back into the evidence a reader can check: "we called it portable because
  // ComfyUI/main.py is there". A caller that repeats "not installed" needs exactly this.
  const markersForLayout = (layout) => (layout === 'integrated'
    ? ['python/python.exe', 'ComfyUI/main.py']
    : layout === 'source'
      ? ['main.py', 'user/default/workflows']
      : layout === 'portable'
        ? ['ComfyUI/main.py']
        : []);
  const installs = [
    ...discovered.map((entry) => ({ path: entry.path, layout: entry.layout, markers: markersForLayout(entry.layout), source: entry.source ?? 'discovery' })),
    ...scannedInstalls,
  ];

  const live = liveBaseUrls.filter((url) => typeof url === 'string' && url.length > 0);

  if (live.length > 0) signals.push(`a ComfyUI instance answered at ${live.join(', ')}`);
  for (const install of installs) {
    const layout = install.layout === 'integrated' ? ' (integrated package: 绘世/Aki style)' : '';
    signals.push(`${install.path} is a working install${layout}; it was found by ${install.source}`);
  }
  for (const packet of packages) signals.push(`${packet.path} holds a deployment package (${packet.markers.slice(0, 2).join(', ')}) but is not an installed ComfyUI`);
  const recorded = state?.comfy?.local?.workspace;
  if (typeof recorded === 'string' && recorded.length > 0) signals.push(`a previous session recorded the install at ${recorded}`);
  for (const key of ['COMFYUI_HOME', 'COMFYUI_PATH']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) signals.push(`the environment variable ${key} points at ${value}`);
  }

  const installed = live.length > 0 || installs.length > 0;
  return {
    installed,
    liveInstances: live,
    installs,
    packages: packages.map((root) => ({
      path: root.path,
      markers: root.markers,
      ...(root.layout === undefined ? {} : { layout: root.layout }),
    })),
    inspected: [
      ...discovery.inspected.map((entry) => ({ path: entry.path, kind: entry.usable ? 'install' : 'other', layout: entry.layout })),
      ...roots.map((root) => ({ path: root.path, kind: root.kind })),
    ],
    signals,
    // Said explicitly so a caller can repeat it: an answer of "not installed" is only honest
    // next to the list of places that were searched.
    searched: {
      discoveryHints: (discovery.hints ?? []).map((hint) => `${hint.path} (${hint.source})`),
      markerRoots: roots.map((root) => root.path),
      deploymentPackages: packages.map((packet) => packet.path),
    },
    recommendation: buildInstallRecommendation({ installed, live, installs, packages, searched: discovery.inspected?.length ?? 0 }),
  };
}

/** Turn the signals into the sentence the caller should say. */
function buildInstallRecommendation({ installed, live, installs, packages, searched = 0 }) {
  if (live.length > 0) {
    return { action: 'use-existing', text: `ComfyUI is already running at ${live[0]}. Nothing needs installing - just use it.` };
  }
  if (installs.length > 0) {
    return { action: 'use-existing', text: `ComfyUI is already installed at ${installs[0].path}. Offer to start it instead of installing anything; only install if the user says this copy is broken or wants a second one elsewhere.` };
  }
  if (packages.length > 0) {
    return { action: 'deploy-existing', text: `No working install was found, but ${packages.map((root) => root.path).join(' and ')} holds a deployment package. Deploy that (the deployment skill reads its own README) rather than downloading everything again.` };
  }
  // "Nothing is installed" is only honest next to WHERE it was looked for. Without that list the
  // sentence reads as a fact about the machine, and a user who has three installs in an unusual
  // place is told to download a hundred gigabytes they already own.
  return {
    action: 'install',
    text: `No ComfyUI install was found. Tell the user up front what installing involves - the package is on the order of a hundred gigabytes and needs an NVIDIA GPU with a recent driver - and get explicit agreement before starting. Before you say "you have none", say what was searched (${searched} location(s) were inspected) and offer to look anywhere they name.`,
  };
}

/**
 * The three answers a user actually needs from an environment check.
 *
 * A boolean is not one of them. "This GPU has 6 GB" is a fact; "video will not run here, but it
 * will on the cloud instance and here is the one thing to do first" is an answer. The middle
 * state matters most: a small card does not make video impossible, it makes it need a step, and
 * collapsing that into "no" would talk a user out of work they can do.
 */
export const VERDICTS = Object.freeze({
  ready: '可做',
  prepare: '需准备',
  blocked: '暂不可做',
});

/** One task's verdict, with the next step spelled out rather than implied. */
function verdict({ key, label, state, why, next, seconds = null }) {
  return { key, label, state, verdict: VERDICTS[state], why, next, seconds };
}

/**
 * Estimate what this machine can do, from the answer an instance gave.
 *
 * Three verdicts per task, each with the step that changes it:
 *
 *   - `ready`   - do it now, on this machine
 *   - `prepare` - doable, but one thing has to happen first (a cloud instance, a smaller size)
 *   - `blocked` - not on this machine, and not by trying harder
 *
 * The time estimate rides along because "how long will I wait" is the question that follows
 * "can I do this", and answering them separately is how a user ends up staring at a spinner.
 *
 * @param devices - device rows from the instance probe (name and VRAM).
 * @param options.cloudConfigured - whether a cloud tunnel address is known. When it is, a task
 *   this card cannot run becomes `prepare` instead of `blocked`: the route exists.
 */
export function assessCapability(devices = [], { cloudConfigured = false } = {}) {
  const best = devices
    .map((device) => ({ name: device.name ?? 'unknown', vram: Number(device.vramTotalGb ?? 0) }))
    .sort((left, right) => right.vram - left.vram)[0];

  const anythingOnThisCard = (needed) => {
    if (best === undefined || best.vram === 0) return null;
    return best.vram >= needed;
  };

  if (best === undefined || best.vram === 0) {
    // No reading at all. The honest answer is not "blocked" - nothing was measured - so every
    // task is `prepare` with the step being "find out", which is also the smallest one.
    const unknown = (key, label, seconds) => verdict({
      key,
      label,
      state: 'prepare',
      why: '没有读到显卡信息，所以还不能下结论。',
      next: '先跑一个最小的工作流试一次——一次小图生成的代价很低，比继续猜准。',
      seconds,
    });
    return {
      known: false,
      verdicts: [unknown('image', '生图 / 图像编辑', 60), unknown('video', 'H3 视频', 600)],
      advice: '读不到显卡信息。先跑一张最小的图：能出就说明环境是通的，再谈视频。',
    };
  }

  const gpu = best.name;
  const vram = best.vram;
  // The cloud route turns "cannot" into "needs a step" for everything the local card is short
  // of. That is the whole reason the middle verdict exists.
  // 16GB is the comfortable local line, not a permission gate. Below it the local route stays
  // available, but the default recommendation moves to cloud and the user can still override.
  const videoLocal = anythingOnThisCard(16);
  const imageLocal = anythingOnThisCard(6);

  const verdicts = [
    verdict({
      key: 'image',
      label: '生图 / 图像编辑',
      state: imageLocal ? 'ready' : 'prepare',
      why: imageLocal ? `${gpu}（${vram}GB）够用。` : `${gpu} 只有 ${vram}GB，出图要降分辨率才稳。`,
      next: imageLocal ? '可以直接开始。' : '把出图分辨率降到 1024 以内，或者改用云端实例。',
      seconds: estimateDuration({ task: 'image', vramGb: vram }).seconds,
    }),
    verdict({
      key: 'quadview',
      label: '人物四视图',
      state: imageLocal ? 'ready' : 'prepare',
      why: imageLocal ? '四视图是图生图，和出图同一档。' : '显存偏小，四视图会慢，但能跑。',
      next: imageLocal ? '可以直接开始。' : '一次只做一个人物，别批量排。',
      seconds: estimateDuration({ task: 'quadview', vramGb: vram }).seconds,
    }),
    verdict({
      key: 'upscale-image',
      label: '图片超分',
      state: imageLocal ? 'prepare' : 'prepare',
      // Upscaling is never "just do it": a 3x pass on a large image is where a small card runs
      // out, so the honest verdict is the middle one even when the card is capable.
      why: imageLocal ? '放大会成倍吃显存，大图可能要分块。' : `本地 ${vram}GB 跑大幅超分很勉强。`,
      next: imageLocal ? '先在一张图上试 2 倍，通过再加到 3 倍。' : '走云端做超分，或者只放大最关键的几张。',
      seconds: estimateDuration({ task: 'upscale-image', vramGb: vram }).seconds,
    }),
    verdict({
      key: 'video',
      label: 'H3 视频',
      state: videoLocal ? 'ready' : 'prepare',
      why: videoLocal
        ? `${vram}GB 显存可以本地跑 H3。`
        : (cloudConfigured
          ? `本地 ${vram}GB 低于推荐的 16GB，默认走云端；本地没有被禁用。`
          : `本地 ${vram}GB 低于推荐的 16GB，不建议直接本地运行，但手动选择本地仍然允许。`),
      next: videoLocal
        ? '可以直接开始。'
        : (cloudConfigured
          ? '默认把视频发到云端；也可以手动切回本地，先降低分辨率、Chunks 和步数再试。'
          : '建议准备云端实例；如果坚持本地运行，可以手动保留本地端，并先降低分辨率、Chunks 和步数。'),
      seconds: estimateDuration({ task: 'video', vramGb: videoLocal ? vram : 24 }).seconds,
    }),
  ];

  const ready = verdicts.filter((entry) => entry.state === 'ready');
  const prepare = verdicts.filter((entry) => entry.state === 'prepare');
  const blocked = verdicts.filter((entry) => entry.state === 'blocked');

  // The advice leads with what can be done, because that is what the user is about to do. A
  // list of limitations first reads as "you cannot work here", which is usually untrue.
  const parts = [];
  if (ready.length > 0) parts.push(`${ready.map((entry) => entry.label).join('、')}现在就能做。`);
  if (prepare.length > 0) parts.push(`${prepare.map((entry) => entry.label).join('、')}需要先做一步准备。`);
  if (blocked.length > 0) parts.push(`${blocked.map((entry) => entry.label).join('、')}在这台机器上做不了。`);
  if (!videoLocal) {
    parts.push('**视频这一步要主动告诉用户走云端，不要等生成失败再说。**');
  }

  return { known: true, gpu, vramGb: vram, verdicts, advice: parts.join('') };
}

/**
 * A rough time estimate for one generation, from the task kind and the GPU.
 *
 * These are measured on a 6 GB laptop GPU (Krea2 still at 768x1280 / 8 steps took
 * about 52 s, a Qwen quad-view about 210 s), then scaled by VRAM. They exist to
 * set an expectation before a silent wait, not to promise a number.
 *
 * @returns `{ seconds, low, high, text }`.
 */
export function estimateDuration({ task = 'image', vramGb = 6, megapixels = 1 } = {}) {
  const baseline = {
    image: 60,
    edit: 150,
    quadview: 210,
    'upscale-image': 90,
    video: 600,
  }[task] ?? 90;
  const speed = vramGb >= 24 ? 0.4 : vramGb >= 16 ? 0.6 : vramGb >= 12 ? 0.8 : vramGb >= 8 ? 1 : 1.4;
  const size = Math.max(0.5, Math.min(3, megapixels));
  const seconds = Math.round(baseline * speed * size);
  return {
    seconds,
    low: Math.round(seconds * 0.6),
    high: Math.round(seconds * 2),
    text: seconds < 90
      ? `大约 1 分钟`
      : seconds < 300
        ? `大约 ${Math.round(seconds / 60)} 分钟`
        : `大约 ${Math.round(seconds / 60)} 分钟或更久`,
  };
}
