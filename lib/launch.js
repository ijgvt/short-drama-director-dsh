/**
 * ComfyUI process lifecycle: find a launcher, start it, watch for readiness,
 * stop it, and read cloud tunnel coordinates out of the user's own script.
 *
 * Two rules from the design review shape everything here:
 *
 *  - Nothing about the machine is hardcoded. Launcher paths, cloud host, and
 *    cloud port are discovered from the user's environment at call time, because
 *    a cloud instance is rebuilt with a different hostname and port.
 *  - Starting is a long-running side effect that costs GPU memory, so the tools
 *    always probe first and require the caller to pass consent explicitly.
 *
 * @module dsh-plugin-short-drama-director/lib/launch
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { probeEndpoint, readQueue } from './comfy.js';
import { discoverInstallations } from './env-discovery.js';
import { statePath } from './state.js';

/** Launcher file names, best first. `variant` selects between them. */
const LAUNCHER_NAMES = {
  nvidia: ['run_nvidia_gpu.bat', 'run_nvidia_gpu_fast_fp16_accumulation.bat', 'start_comfyui_nvidia.bat'],
  fast_fp16: ['run_nvidia_gpu_fast_fp16_accumulation.bat', 'run_nvidia_gpu.bat', 'start_comfyui_nvidia.bat'],
  cpu: ['run_cpu.bat', 'run_nvidia_gpu.bat'],
};

/** Startup can take minutes on a cold model cache; this bounds the wait. */
const DEFAULT_READY_TIMEOUT_MS = 240000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * Detect a 绘世/Aki-style integrated package and return the command that starts its backend.
 *
 * These packages are a *launcher plus an embedded interpreter*, not a shell script:
 *
 *     <pkg>\绘世启动器.exe          GUI front end
 *     <pkg>\python\python.exe       the interpreter the GUI would use
 *     <pkg>\ComfyUI\main.py         the backend
 *
 * Launching the GUI is the wrong move for an agent: it opens a window and waits for a human
 * to click 一键启动, so nothing is listening and the wait times out with a misleading "did
 * not answer". Starting the SAME interpreter on the SAME main.py skips only the window, and
 * the user's models, custom nodes and output directory are all still the ones they use.
 *
 * `--user-directory` is passed explicitly because ComfyUI otherwise migrates the profile into
 * its own default location, which would silently give the user a different instance's settings
 * and workflows.
 *
 * Deliberately NOT implemented as a generated .bat: this path contains non-ASCII characters,
 * and cmd.exe reads a .bat as the OEM code page regardless of its bytes, so the path is
 * mangled before a single line runs.
 *
 * @returns `{ kind, python, script, workspace, userDirectory, gui }` or `null`.
 */
export async function discoverIntegratedPackage(root) {
  if (typeof root !== 'string' || root.trim().length === 0) return null;
  for (const candidate of [root.trim(), dirname(root.trim())]) {
    const python = join(candidate, 'python', 'python.exe');
    const script = join(candidate, 'ComfyUI', 'main.py');
    if (!await isFile(python)) continue;
    if (!await isFile(script)) continue;
    const app = join(candidate, 'ComfyUI');
    const userDirectory = join(app, 'user');
    let gui = null;
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      const found = entries.find((entry) => entry.isFile() && /启动器|launcher/iu.test(entry.name) && /\.exe$/iu.test(entry.name));
      if (found !== undefined) gui = join(candidate, found.name);
    } catch {
      // A readable package is not required for headless launch.
    }
    return {
      kind: 'integrated-package',
      root: candidate,
      python,
      script,
      workspace: app,
      userDirectory,
      gui,
    };
  }
  return null;
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

/** True when a path is a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Ports worth trying when nothing is configured. */
function candidatePorts(config) {
  const ports = Array.isArray(config.localPorts) ? [...config.localPorts] : [];
  if (Number.isInteger(config.localPort)) ports.unshift(config.localPort);
  ports.push(8188, 8189, 8888);
  return [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/**
 * Find a ComfyUI launcher without assuming a fixed path.
 *
 * The workspace directory is searched shallowly (its own files) plus a couple of
 * conventional siblings, which covers a `run_*.bat` beside `python_embeded` and a
 * `start_*.bat` one level up.
 *
 * @returns `{ launcher, workspace, candidates, searched }`.
 */
export async function discoverLocalLauncher(config, { variant = 'nvidia' } = {}) {
  const names = LAUNCHER_NAMES[variant] ?? LAUNCHER_NAMES.nvidia;
  const searched = [];
  const roots = [];
  if (typeof config.comfyuiPortablePath === 'string' && config.comfyuiPortablePath.trim().length > 0) {
    const workspace = config.comfyuiPortablePath.trim();
    roots.push(workspace, dirname(workspace));
  }

  const candidates = [];
  for (const root of roots) {
    for (const name of names) {
      const path = join(root, name);
      if (await isFile(path)) candidates.push({ path, workspace: root, name });
    }
    // A directory listing also finds launchers whose names we did not predict.
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.(bat|cmd|ps1|sh)$/iu.test(entry.name)) continue;
        if (!/comfy|run|start/iu.test(entry.name)) continue;
        const path = join(root, entry.name);
        if (candidates.some((candidate) => candidate.path === path)) continue;
        candidates.push({ path, workspace: root, name: entry.name });
      }
    } catch {
      // A missing or unreadable root is not an error; it just yields no candidates.
    }
    searched.push(root);
  }

  // Prefer an exact launcher-name match over a keyword match.
  candidates.sort((left, right) => {
    const leftRank = names.indexOf(left.name);
    const rightRank = names.indexOf(right.name);
    return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
  });
  return { launcher: candidates[0] ?? null, candidates, searched };
}

/**
 * Merge the discovered portable install into launcher discovery without changing an explicit
 * user path. Exported so portability tests can prove detection and launch use the same install.
 */
export function launcherConfigFor(config = {}, portableInstall = null) {
  return {
    ...config,
    comfyuiPortablePath: (
      typeof config.comfyuiPortablePath === 'string' && config.comfyuiPortablePath.trim().length > 0
        ? config.comfyuiPortablePath
        : portableInstall?.path ?? ''
    ),
  };
}

/**
 * Start a launcher detached and wait until the instance answers.
 *
 * @returns a report; `started: false` carries the reason instead of throwing,
 *   because "it did not come up" is a normal outcome the caller must report.
 */
export async function startLocal(config, {
  variant = 'nvidia',
  baseUrl,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
  /** Where to look for a path a previous session recorded. Omitted means "the default state file". */
  statePath: discoverStatePath = statePath(),
} = {}) {
  // Discover installations the way the rest of the plugin does: config hint, environment,
  // what a previous session recorded, and one level of siblings. Naming a single path here
  // meant a machine with the copy elsewhere looked like it had no ComfyUI at all.
  const installations = await discoverInstallations(config, { statePath: discoverStatePath });
  const integratedInstall = installations.installs.find((install) => install.layout === 'integrated') ?? null;
  const portableInstall = installations.installs.find((install) => install.layout !== 'integrated') ?? null;

  // An integrated package (绘世/Aki) is tried first: when one is present, its embedded
  // interpreter is the instance the user actually runs, so a second .bat-style instance
  // would fight it for the port and the GPU.
  const integrated = integratedInstall === null
    ? null
    : {
      kind: 'integrated-package',
      root: integratedInstall.path,
      python: join(integratedInstall.path, 'python', 'python.exe'),
      script: integratedInstall.script,
      workspace: join(integratedInstall.path, 'ComfyUI'),
      userDirectory: join(integratedInstall.path, 'ComfyUI', 'user'),
      gui: null,
    };

  // Discovery and launching must use the same answer. Before this, install detection could
  // find a working portable copy while start_local still searched only an explicitly
  // configured path and reported "no launcher".
  const launcherConfig = integrated === null ? launcherConfigFor(config, portableInstall) : null;
  const discovery = integrated === null ? await discoverLocalLauncher(launcherConfig, { variant }) : null;
  if (integrated === null && discovery.launcher === null) {
    return {
      started: false,
      reason: `no ComfyUI launcher found. Searched: ${discovery.searched.join(', ') || '(no configured path)'}. Set comfyuiPortablePath, or tell me where ComfyUI lives — comfy_install action=check will look for you.`,
      candidates: discovery.candidates,
      inspected: installations.inspected.map((entry) => ({ path: entry.path, usable: entry.usable, layout: entry.layout, source: entry.source })),
    };
  }
  // Which install was chosen, and why - so the caller can say it instead of implying a default.
  const chosenInstall = integrated !== null
    ? { path: integratedInstall.path, layout: integratedInstall.layout, source: integratedInstall.source }
    : { path: portableInstall?.path ?? null, layout: portableInstall?.layout ?? null, source: portableInstall?.source ?? null };

  const port = candidatePorts(config)[0] ?? 8188;
  const target = baseUrl ?? `http://127.0.0.1:${port}`;

  // Never start a second instance on top of a live one.
  const before = await probeEndpoint(target, { timeoutMs: 4000, signal });
  if (before.reachable) {
    const who = integrated === null ? discovery.launcher.path : integrated.python;
    return { started: false, alreadyRunning: true, baseUrl: before.baseUrl, launcher: who, reason: `${before.baseUrl} is already answering; nothing was started` };
  }

  const launcherPath = integrated === null ? discovery.launcher.path : integrated.python;
  const workspace = integrated === null ? discovery.launcher.workspace : integrated.workspace;
  const logPath = join(dirname(launcherPath), `dsh-comfy-launch-${Date.now()}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const logHandle = await import('node:fs').then(({ openSync }) => openSync(logPath, 'a'));

  // An integrated package runs `python main.py <flags>`; a portable build runs its own .bat.
  const command = integrated === null ? launcherPath : integrated.python;
  const commandArgs = integrated === null
    ? []
    : [
      '-s', 'main.py',
      '--port', String(port),
      '--listen', '127.0.0.1',
      '--user-directory', integrated.userDirectory,
      '--disable-auto-launch',
      '--log-stdout',
    ];

  let child;
  try {
    child = spawn(command, commandArgs, {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', logHandle, logHandle],
      windowsHide: true,
    });
  } catch (error) {
    return { started: false, reason: `could not launch ${command}: ${String(error)}`, launcher: command, log: logPath };
  }
  child.unref();

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, readyTimeoutMs);
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (signal?.aborted === true) break;
    await sleep(pollIntervalMs);
    const probe = await probeEndpoint(target, { timeoutMs: 4000, signal });
    if (probe.reachable) {
      return {
        started: true,
        baseUrl: probe.baseUrl,
        launcher: command,
        workspace,
        // Reported so a caller can tell the two shapes apart without guessing from the path.
        launcherKind: integrated === null ? 'portable-script' : integrated.kind,
        guiFrontEnd: integrated?.gui ?? null,
        pid: child.pid,
        log: logPath,
        readyInMs: Date.now() - startedAt,
        comfyuiVersion: probe.comfyuiVersion ?? null,
        devices: (probe.devices ?? []).map((device) => `${device.name} (${device.vramFreeGb ?? '?'}GB free of ${device.vramTotalGb ?? '?'}GB)`),
      };
    }
    lastError = probe.error ?? lastError;
  }

  const tail = await readLogTail(logPath);
  return {
    started: false,
    launcher: command,
    workspace,
    pid: child.pid,
    log: logPath,
    reason: `${basename(command)} was launched but ${target} did not answer within ${Math.round(readyTimeoutMs / 1000)}s (last probe: ${lastError})`,
    logTail: tail,
  };
}

/** Last few non-empty log lines, for diagnosing a failed start. */
export async function readLogTail(logPath, { lines = 25 } = {}) {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Read cloud tunnel coordinates out of the user's own tunnel script.
 *
 * The script is DISCOVERED when no path is configured, because requiring the user to paste a path
 * meant `comfy_launch action=start_cloud` answered "no tunnel script path is configured" on a
 * machine whose tunnel script was sitting in the conventional place - so a cloud user whose
 * tunnel dropped had to open a cmd window and run the .bat themselves, which contradicts the
 * plugin's own "cloud first" default.
 *
 * The values are returned as found and never substituted by a default: a cloud instance is
 * rebuilt with a new hostname and port, so a remembered value is at best a hint.
 */
export async function readCloudConfig(scriptPath, config = {}) {
  const explicit = typeof scriptPath === 'string' && scriptPath.trim().length > 0 ? scriptPath.trim() : null;
  if (explicit !== null) {
    if (!await isFile(explicit)) return { found: false, reason: `tunnel script not found: ${explicit}`, searched: [explicit] };
    return parseCloudScript(explicit);
  }
  const discovery = await findCloudScripts(config);
  if (discovery.found.length === 0) {
    return {
      found: false,
      reason: 'no tunnel script path is configured, and none was found in the usual places',
      // Reported so "I could not find it" is checkable instead of mysterious.
      searched: discovery.searched,
      hint: 'Ask the user where their tunnel script is (the .bat/.ps1/.sh that runs ssh -L or plink -L), then set cloudTunnelScript to it.',
    };
  }
  const parsed = await parseCloudScript(discovery.found[0]);
  return { ...parsed, discovered: true, alsoFound: discovery.found.slice(1), searched: discovery.searched };
}

/** Parse the coordinates a tunnel script declares. */
async function parseCloudScript(path) {
  const text = await readFile(path, 'utf8');
  const read = (name) => {
    const match = new RegExp(`^\\s*(?:set\\s+)?${name}\\s*=\\s*(.+?)\\s*$`, 'imu').exec(text);
    return match === null ? null : match[1].replace(/^["']|["']$/gu, '').trim();
  };
  const host = read('RHOST');
  const port = read('RPORT');
  const localPort = read('LPORT');
  const passwordFile = /pw\.txt/iu.test(text) ? join(dirname(path), 'pw.txt') : null;
  return {
    found: host !== null || port !== null,
    script: path,
    host,
    port: port === null ? null : Number(port),
    localPort: localPort === null ? null : Number(localPort),
    passwordFile,
    note: 'These are the values written in your tunnel script. A rebuilt cloud instance has a different host and port, so they may be stale.',
  };
}

/** Where a tunnel script could live. Nothing here is a requirement - every entry is optional. */
async function findCloudScripts(config = {}) {
  const searched = [];
  const roots = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const path = value.trim();
    if (!roots.includes(path)) roots.push(path);
  };
  // The user's own configuration first, then the install hints we already have, then the
  // conventional ComfyUI folders people put deployment scripts in.
  add(config.cloudTunnelScript);
  add(config.comfyuiPortablePath);
  for (const key of ['COMFYUI_HOME', 'COMFYUI_PATH']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) add(value);
  }
  // Installs found on disk are the best hint there is: a tunnel script usually sits in a
  // `_deploy` folder beside the ComfyUI the user runs. Without this, a machine with nothing
  // configured searched nowhere at all and reported "none found" - while the script was one
  // directory away from an install discovery had already located.
  const found = await discoverInstallations(config, { statePath: statePath() }).catch(() => ({ installs: [] }));
  for (const install of found.installs ?? []) {
    if (typeof install.path === 'string' && install.path.length > 0) add(install.path);
  }
  const candidatesRoots = [];
  for (const root of roots) {
    candidatesRoots.push(root, join(root, '_deploy'), dirname(root), join(dirname(root), '_deploy'));
  }
  for (const candidate of candidatesRoots) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
  }
  const scripts = [];
  for (const directory of searched) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // connect_*cloud*.bat, connect_comfy_cloud.bat, start_h3_cloud.bat, tunnel*.sh ...
      if (!/\.(bat|cmd|ps1|sh)$/iu.test(entry.name)) continue;
      if (!/cloud|tunnel/iu.test(entry.name)) continue;
      // Not a tunnel: stop/disconnect scripts tear one down, and diagnose/probe/check scripts
      // inspect one. Picking one of those as "the tunnel" would run a diagnostic and then wait
      // for an instance that was never started.
      if (/stop|kill|disconnect|diagnose|probe|check|test|install|update/iu.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (!scripts.includes(path)) scripts.push(path);
    }
  }
  return { found: scripts, searched };
}

/**
 * Start the cloud tunnel, then wait for the local end to answer.
 *
 * The tunnel script is the user's, run as-is; this never composes a connection
 * command of its own, so it cannot disagree with what the user configured.
 */
export async function startCloud(config, {
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
} = {}) {
  const configured = typeof config.cloudTunnelScript === 'string' && config.cloudTunnelScript.trim().length > 0
    ? config.cloudTunnelScript.trim()
    : null;
  // Discovery, not just configuration: a cloud user whose tunnel dropped should not have to open
  // a cmd window and run their own .bat. The script is looked for in the install hints and the
  // conventional `_deploy` folders; only when nothing is found is the user asked for a path.
  let scriptPath = configured;
  if (scriptPath === null) {
    const discovery = await findCloudScripts(config);
    scriptPath = discovery.found[0] ?? null;
    if (scriptPath === null) {
      return {
        started: false,
        reason: 'no cloud tunnel script is configured, and none was found. Tell me how you reach your cloud ComfyUI (the script path, or an SSH host and port) and I will record it.',
        searched: discovery.searched,
      };
    }
  }
  if (!await isFile(scriptPath)) {
    return { started: false, reason: `tunnel script not found: ${scriptPath}` };
  }
  const coords = await readCloudConfig(scriptPath);
  const localPort = coords.localPort ?? candidatePorts(config)[0] ?? 8888;
  const target = `http://127.0.0.1:${localPort}`;

  const before = await probeEndpoint(target, { timeoutMs: 4000, signal });
  if (before.reachable) {
    return { started: false, alreadyRunning: true, baseUrl: before.baseUrl, tunnel: coords, reason: `${before.baseUrl} is already answering; the tunnel is up` };
  }

  const logPath = join(dirname(scriptPath), `dsh-tunnel-${Date.now()}.log`);
  const logHandle = await import('node:fs').then(({ openSync }) => openSync(logPath, 'a'));
  const child = spawn('cmd.exe', ['/c', scriptPath], {
    cwd: dirname(scriptPath),
    detached: true,
    stdio: ['ignore', logHandle, logHandle],
    windowsHide: true,
    // Console-only commands such as `timeout /t` fail immediately when stdin is redirected.
    // Our tunnel scripts use this flag to switch to a console-free sleep; other scripts may
    // ignore it. This is why an automated start now follows the same path as a real launch.
    env: { ...process.env, DSH_NONINTERACTIVE: '1' },
  });
  child.unref();

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, readyTimeoutMs);
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (signal?.aborted === true) break;
    await sleep(pollIntervalMs);
    const probe = await probeEndpoint(target, { timeoutMs: 4000, signal });
    if (probe.reachable) {
      return { started: true, baseUrl: probe.baseUrl, tunnel: coords, pid: child.pid, log: logPath, readyInMs: Date.now() - startedAt };
    }
    lastError = probe.error ?? lastError;
  }

  return {
    started: false,
    tunnel: coords,
    log: logPath,
    reason: `the tunnel script ran but ${target} did not answer within ${Math.round(readyTimeoutMs / 1000)}s (last probe: ${lastError})`,
    hint: coords.host === null
      ? 'The script did not declare RHOST/RPORT, so I cannot tell which instance it targets.'
      : `It targets ${coords.host}:${String(coords.port)}. If you rebuilt the cloud instance, that address is stale - give me the new host and port and I will update the script (a backup is kept).`,
    logTail: await readLogTail(logPath),
  };
}

/**
 * Rewrite the cloud coordinates inside the user's tunnel script.
 *
 * A timestamped backup is written beside the original first, because the script
 * is the user's own file and may carry edits this plugin knows nothing about.
 */
export async function updateCloudCoordinates(scriptPath, { host, port, localPort }) {
  if (!await isFile(scriptPath)) throw new Error(`tunnel script not found: ${scriptPath}`);
  const original = await readFile(scriptPath, 'utf8');
  let next = original;
  if (typeof host === 'string' && host.length > 0) next = next.replace(/^(\s*set\s+RHOST\s*=\s*).+$/imu, `$1${host}`);
  if (Number.isInteger(port)) next = next.replace(/^(\s*set\s+RPORT\s*=\s*).+$/imu, `$1${port}`);
  if (Number.isInteger(localPort)) next = next.replace(/^(\s*set\s+LPORT\s*=\s*).+$/imu, `$1${localPort}`);
  if (next === original) {
    return { changed: false, reason: 'none of RHOST / RPORT / LPORT appear in the script, so nothing was rewritten', script: scriptPath };
  }
  const backup = `${scriptPath}.bak-${Date.now()}`;
  await writeFile(backup, original, 'utf8');
  await writeFile(scriptPath, next, 'utf8');
  return { changed: true, script: scriptPath, backup, readBack: await readCloudConfig(scriptPath) };
}

/** Stop a running instance by killing a process tree. */
export async function stopProcess({ pid, tree = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: false, reason: 'no pid given' };
  const args = tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'];
  const result = await new Promise((resolvePromise) => {
    const child = spawn('taskkill', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => resolvePromise({ code: -1, output: String(error) }));
    child.on('close', (code) => resolvePromise({ code, output }));
  });
  return { stopped: result.code === 0, exitCode: result.code, output: result.output.trim().slice(0, 800) };
}

/**
 * Report what is running, without starting anything.
 *
 * @returns one row per candidate address plus the queue depth of a reachable one.
 */
export async function lifecycleStatus(config, { baseUrls, signal } = {}) {
  const targets = Array.isArray(baseUrls) && baseUrls.length > 0
    ? baseUrls
    : candidatePorts(config).map((port) => `http://127.0.0.1:${port}`);
  const rows = [];
  for (const target of targets) {
    const probe = await probeEndpoint(target, { timeoutMs: 4000, signal });
    let queue = null;
    if (probe.reachable) {
      try {
        const state = await readQueue(probe.baseUrl, { timeoutMs: 8000, signal });
        queue = { running: Array.isArray(state?.queue_running) ? state.queue_running.length : 0, pending: Array.isArray(state?.queue_pending) ? state.queue_pending.length : 0 };
      } catch {
        queue = null;
      }
    }
    rows.push({ baseUrl: probe.baseUrl, reachable: probe.reachable, error: probe.error ?? null, queue, comfyuiVersion: probe.comfyuiVersion ?? null, devices: (probe.devices ?? []).map((device) => `${device.name} (${device.vramFreeGb ?? '?'}GB free of ${device.vramTotalGb ?? '?'}GB)`) });
  }
  // The same discovery `startLocal` uses. Reporting a different answer here was a measured bug:
  // `comfy_launch status` said "No local launcher was found (searched: nothing configured)"
  // on a machine where `start_local` then started a 绘世 package without complaint - so the
  // agent told the user it could not find their ComfyUI and asked for a path.
  const installations = await discoverInstallations(config, { statePath: statePath() }).catch(() => ({ installs: [], inspected: [], hints: [] }));
  const local = await discoverLocalLauncher(config);
  return {
    rows,
    usable: rows.find((row) => row.reachable)?.baseUrl ?? null,
    launcher: local,
    // Found on disk, whether or not a script launcher exists: this is what makes "it IS installed"
    // answerable without starting anything.
    installs: installations.installs ?? [],
    inspected: installations.inspected ?? [],
    cloud: await readCloudConfig(config.cloudTunnelScript),
  };
}

/**
 * Choose which reachable ComfyUI to use.
 *
 * The tunnel port is how a cloud instance appears locally, so it is what marks an
 * address as cloud. When both are up the cloud wins by default: the user's own
 * setting, and the one that keeps a 6 GB laptop GPU free.
 *
 * @param prefer - `auto` (cloud when both are up), `cloud`, or `local`.
 * @returns `{ baseUrl, kind, reason, rows }`; `baseUrl` is null when nothing answers.
 */
export async function selectInstance(config, { baseUrl, prefer = 'auto', signal } = {}) {
  if (typeof baseUrl === 'string' && baseUrl.trim().length > 0) {
    return { baseUrl: baseUrl.trim(), kind: 'explicit', reason: 'the address you passed', rows: [] };
  }
  const cloudPort = Number.isInteger(config.cloudLocalPort) ? config.cloudLocalPort : 8888;
  const targets = candidatePorts(config).map((port) => ({ port, baseUrl: `http://127.0.0.1:${port}` }));
  const rows = [];
  for (const target of targets) {
    const probe = await probeEndpoint(target.baseUrl, { timeoutMs: 4000, signal });
    rows.push({
      ...target,
      reachable: probe.reachable,
      // 8888-style tunnel port, unless the configuration says otherwise.
      kind: target.port === cloudPort ? 'cloud' : 'local',
      device: probe.devices?.[0]?.name ?? null,
      vramGb: probe.devices?.[0]?.vramTotalGb ?? null,
    });
  }
  const up = rows.filter((row) => row.reachable);
  const cloud = up.filter((row) => row.kind === 'cloud');
  const local = up.filter((row) => row.kind === 'local');

  const pick = (row, reason) => ({ baseUrl: row.baseUrl, kind: row.kind, reason, rows });

  if (prefer === 'cloud') {
    if (cloud.length > 0) return pick(cloud[0], 'you asked for the cloud instance');
    if (local.length > 0) return pick(local[0], 'you asked for the cloud, but only a local instance is up');
    return { baseUrl: null, kind: null, reason: 'no instance is reachable', rows };
  }
  if (prefer === 'local') {
    if (local.length > 0) return pick(local[0], 'you asked for the local instance');
    if (cloud.length > 0) return pick(cloud[0], 'you asked for local, but only the cloud is up');
    return { baseUrl: null, kind: null, reason: 'no instance is reachable', rows };
  }
  // auto
  if (cloud.length > 0 && local.length > 0) return pick(cloud[0], 'both are up, and the cloud instance is preferred');
  if (cloud.length > 0) return pick(cloud[0], 'the cloud instance is up');
  if (local.length > 0) return pick(local[0], 'only a local instance is up');
  return { baseUrl: null, kind: null, reason: 'no instance is reachable', rows };
}

/** Promise-based delay that respects an abort signal. */
function sleep(ms, signal) {  return new Promise((resolvePromise, reject) => {
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
