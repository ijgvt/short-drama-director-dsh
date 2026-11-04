/**
 * Mode, project and instance-lifecycle tools.
 *
 * These are the three capabilities the design review added on top of the
 * generation tools:
 *
 *  - `drama_mode` makes short-drama mode an explicit, persisted decision rather
 *    than something a model may drift into, and answers "do I have a project
 *    already?" from one small file instead of scanning a drive.
 *  - `comfy_launch` starts and stops ComfyUI itself, local or through the user's
 *    own cloud tunnel, after probing so a second instance is never started.
 *
 * @module dsh-plugin-short-drama-director/lib/lifecycle-tools
 */

import { hostIdentity } from './version.js';
import { readLedgerSync } from './job-store.js';

/**
 * A short, non-secret summary of the live configuration.
 *
 * Reported by `drama_mode version` because most "why did it do that?" questions are really
 * "which instance / which root / which default was in force?". Paths and ports only: no
 * credentials, no tunnel password, nothing that a copied log would leak.
 */
function describeConfig(config) {
  const pick = (key) => {
    const value = config?.[key];
    return value === undefined || value === null || (typeof value === 'string' && value.length === 0) ? null : value;
  };
  return {
    comfyBaseUrl: pick('comfyBaseUrl'),
    localPorts: pick('localPorts'),
    cloudLocalPort: pick('cloudLocalPort'),
    preferInstance: pick('preferInstance'),
    projectDrive: pick('projectDrive'),
    runTimeoutMs: pick('runTimeoutMs'),
  };
}

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { lifecycleStatus, readCloudConfig, startCloud, startLocal, stopProcess, updateCloudCoordinates } from './launch.js';
import { readState, updateState, upsertProject, setActiveProject } from './state.js';
import { availableModelNames, isCosmeticNodeClass, readObjectInfo, uiGraphToPrompt } from './comfy.js';
import { assessCapability, detectInstalls, estimateDuration } from './install.js';
import { checkModels, matchWorkflows, scanWorkflows } from './workflows.js';
import { resolveWorkflowsDir } from './env-discovery.js';
import { statePath } from './state.js';

/** True when the path currently exists as a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** One project row with its on-disk presence rechecked (a single cheap stat). */
async function projectRow(entry) {
  const present = typeof entry.root === 'string' && await isDirectory(entry.root);
  return {
    name: entry.name ?? entry.root,
    root: entry.root,
    present,
    active: false,
    lastOpenedAt: entry.lastOpenedAt ?? null,
    episodes: entry.episodes ?? null,
    progress: entry.progress ?? null,
    note: present ? null : 'this folder no longer exists; it was probably moved, renamed or deleted',
  };
}

/**
 * `drama_mode` 鈥?read or change the operating mode, and resume a known project.
 */
/** How much hand-holding each recorded level asks for. */
const USER_TONE = {
  beginner: '用大白话，一次只问一个问题，每个术语解释一句，出错给下一步动作而不是堆日志。',
  experienced: '只给结论和参数，不要教他怎么用 ComfyUI；优先用他自己的工作流；他说过的参数就按他的。',
  creator: '他只关心成品像不像。进展说人话，每张确认图都发到聊天窗口，改图意见用自然语言接住。',
  unknown: '还不知道他什么水平，先按中间来：话不多，但有求必应。',
};

export function dramaModeTool(config) {
  /**
   * Rebuild what the plugin exposes after a mode change.
   *
   * The module switch and this tool are two doors into the same room, so they must have
   * the same effect. Without this, entering drama mode from the chat would leave the
   * drama tools unregistered - the state file would say `drama` while the model still had
   * no way to act on it.
   */
  const sync = typeof config.onModeChange === 'function' ? config.onModeChange : undefined;
  const announce = async (next) => {
    if (sync === undefined) return;
    await sync(next);
  };
  return defineTool({
    name: 'drama_mode',
    description: 'Read or change which mode the agent is in, and list or resume short-drama projects. General mode is the default: a plain ComfyUI assistant that generates images and video on request. Drama mode is the full short-drama pipeline and must be entered deliberately with action=enter, never inferred. Call action=status at the start of a conversation to learn whether the user already has projects before asking them anything.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'version', 'enter', 'exit', 'list_projects', 'forget_project', 'set_user_level'],
        description: 'status reads the stored mode and active project; version reports the running Host contract version and its capabilities (use it whenever a feature seems to be missing, to tell "not implemented" from "old code still loaded"); enter switches to drama mode; exit returns to general mode without deleting anything; list_projects rechecks every known project; forget_project drops one entry from the index; set_user_level records how much hand-holding the user wants.',
      },
      root: { type: 'string', description: 'Project root for action=enter. Omit to create a new project (the workspace tool decides the folder).' },
      name: { type: 'string', description: 'Script or project title, recorded with the project so it can be offered by name later.' },
      episodes: { type: 'integer', description: 'Episode count, recorded for the resume summary.' },
      reason: { type: 'string', description: 'Why drama mode is being entered; recorded for the log so a stray entry is auditable.' },
      user_level: {
        type: 'string',
        enum: ['unknown', 'beginner', 'experienced', 'creator'],
        description: 'For action=set_user_level. beginner = needs plain language and one question at a time; experienced = has their own ComfyUI and workflows, prefers their setup and no teaching; creator = has a script and cares about the result, not the tooling. Record it from what the user reveals; do not guess.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          statePath: { type: 'string', required: true },
          /** Null when nothing is active yet; nullability is a oneOf in this DSL. */
          userLevel: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          activeProject: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          activeContext: { type: 'json' },
          projects: { type: 'json', required: true },
          guidance: { type: 'array', items: { type: 'string' } },
          /** Handshake: what code is actually loaded, and what it can do. */
          host: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const lines = [`mode: ${value.mode}${value.changed ? ' (changed)' : ''}`, `state: ${value.statePath}`];
        if (value.host !== undefined && value.host !== null) {
          lines.push(`host: contract v${String(value.host.contractVersion)}  loaded ${String(value.host.loadedAt)}  ${Array.isArray(value.host.capabilities) ? value.host.capabilities.length : 0} capabilities`);
        }
        if (value.userLevel !== undefined) lines.push(`user level: ${value.userLevel}`);
        if (value.activeProject !== undefined && value.activeProject !== null) lines.push(`active project: ${value.activeProject}`);
        if (value.activeContext !== undefined && value.activeContext !== null && value.activeContext.episodeNumber !== null) {
          const source = value.activeContext.sourceId ?? '未指定来源';
          const shot = value.activeContext.shotId === null || value.activeContext.shotId === undefined ? '' : ' · 已定位镜头';
          lines.push(`active context: 第${String(value.activeContext.episodeNumber)}集 · ${String(source)}${shot}`);
        }
        if (Array.isArray(value.projects) && value.projects.length > 0) {
          lines.push('known projects:');
          for (const project of value.projects) {
            const progress = project.progress === null || project.progress === undefined ? '' : ` 鈥?${JSON.stringify(project.progress)}`;
            lines.push(`  ${project.name}  ${project.root}${project.present ? '' : '  [MISSING]'}${project.active ? '  [active]' : ''}${progress}`);
          }
        } else if (Array.isArray(value.projects)) {
          lines.push('no short-drama projects recorded yet');
        }
        for (const line of value.guidance ?? []) lines.push(line);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const { state, path } = await readState();
      const guidance = [];

      // T00 handshake. Answered before anything else and without touching state, because
      // its whole purpose is to be reachable when nothing else seems to work: it is how a
      // caller tells "this Host cannot do that" from "this Host is running older code".
      if (args.action === 'version') {
        const host = hostIdentity({ packageVersion: config.packageVersion ?? null, config: describeConfig(config) });
        return { mode: state.mode, changed: false, statePath: path, userLevel: null, activeProject: state.activeProject ?? null, activeContext: state.activeContext ?? null, projects: [], host, guidance };
      }

      if (args.action === 'enter') {
        await updateState((current) => {
          current.mode = 'drama';
          if (typeof args.root === 'string' && args.root.trim().length > 0) {
            const root = args.root.trim();
            const known = current.projects.find((entry) => entry.root === root);
            if (known === undefined) {
              upsertProject(current, { root, name: args.name ?? null, episodes: args.episodes ?? null, enteredWith: args.reason ?? null });
            } else {
              setActiveProject(current, root);
            }
          }
          return current;
        });
        guidance.push('Drama mode is on. Load the short-drama-director skill for the pipeline, and load its sub-skills only when that step is actually reached.');
        guidance.push('Drama mode is never entered by inference: leave it with action=exit as soon as the user wants ordinary generation again.');
        await announce('drama');
        const after = await readState();
        const projects = await allProjects(after.state);
        /**
         * Ask ONCE, at entry, whether this is a new project or an existing one.
         *
         * Entering drama mode used to say nothing about projects, so the first real question came after
         * assets had already been discussed - and a returning user had to notice on their own that their
         * earlier work was still there. The tool knows the list, so it says which case this is and the
         * model only has to present it:
         *
         *   - no projects on this machine  -> start a new one, do not ask an unanswerable question
         *   - one or more projects         -> offer 继续已有 / 新建, with the names to choose from
         */
        if (projects.length === 0) {
          guidance.push('本机还没有任何短剧项目：直接按“新项目”开始，不要问“从新项目还是已有项目继续”——没有可继续的项目，那个问题无意义。');
        } else {
          guidance.push(`本机已有 ${String(projects.length)} 个短剧项目。进入短剧模式的第一件事：问用户「继续已有项目，还是新建一个？」并给出选项（用选择题形式，不要开放式提问）。`);
          guidance.push(`可继续的项目：${projects.map((entry) => `${String(entry.name ?? entry.root)}（${String(entry.root)}）`).join('；')}`);
          guidance.push('用户选“继续”就用 drama_mode action=enter root=<该项目路径> 进入那个项目；用户选“新建”才按新项目流程走，不要在用户选择前自己替他定。');
        }
        return { mode: after.state.mode, userLevel: after.state.userLevel ?? null, activeProject: after.state.activeProject ?? null, activeContext: after.state.activeContext ?? null, changed: true, statePath: path, projects, host: hostIdentity(), guidance };
      }

      if (args.action === 'exit') {
        await updateState((current) => {
          current.mode = 'general';
          return current;
        });
        guidance.push('Back to general mode: generate, edit and upscale on request. Project files are untouched and the drama pipeline can be resumed with action=enter.');
        guidance.push('The drama-only tools (drama_workspace, storyboard) and the drama skills are no longer available in this mode; that is the intended state, not a failure.');
        await announce('general');
        return { mode: 'general', userLevel: state.userLevel ?? null, activeProject: state.activeProject ?? null, activeContext: state.activeContext ?? null, changed: true, statePath: path, projects: await allProjects(state), host: hostIdentity(), guidance };
      }

      if (args.action === 'set_user_level') {
        const level = args.user_level;
        if (typeof level !== 'string' || !['unknown', 'beginner', 'experienced', 'creator'].includes(level)) {
          throw new Error('set_user_level needs user_level: one of unknown, beginner, experienced, creator');
        }
        const next = await updateState((current) => {
          current.userLevel = level;
          return current;
        });
        const tone = {
          beginner: '用大白话，一次只问一个问题，每个术语解释一句，出错给下一步动作而不是堆日志。',
          experienced: '只给结论和参数，不要教他怎么用 ComfyUI；优先用他自己的工作流；他说过的参数就按他的。',
          creator: '他只关心成品像不像。进展说人话，每张确认图都发到聊天窗口，改图意见用自然语言接住。',
          unknown: '还不知道他什么水平，先按中间来：话不多，但有求必应。',
        }[level];
        guidance.push(tone);
        return { mode: next.state.mode, userLevel: next.state.userLevel ?? null, activeProject: next.state.activeProject ?? null, activeContext: next.state.activeContext ?? null, changed: true, statePath: next.path, projects: await allProjects(next.state), host: hostIdentity(), guidance };
      }

      if (args.action === 'forget_project') {
        if (typeof args.root !== 'string' || args.root.trim().length === 0) throw new Error('forget_project needs root');
        const root = args.root.trim();
        const next = await updateState((current) => {
          current.projects = current.projects.filter((entry) => entry.root !== root);
          if (current.activeProject === root) current.activeProject = null;
          return current;
        });
        guidance.push(`${root} was dropped from the index. The folder on disk was not touched.`);
        return { mode: next.state.mode, userLevel: next.state.userLevel ?? null, activeProject: next.state.activeProject ?? null, activeContext: next.state.activeContext ?? null, changed: true, statePath: next.path, projects: await allProjects(next.state), host: hostIdentity(), guidance };
      }

      const projects = await allProjects(state);

      // Unfinished work, read from the durable job ledger. This is what makes "关掉再打开还能接着做"
      // true rather than aspirational: a job whose submission was never confirmed, or whose
      // outputs never arrived, is exactly the thing a restart would otherwise hide.
      //
      // STALENESS IS SPLIT OUT. Every status call used to announce ten `queued` jobs from an
      // earlier session and tell the agent to poll them, while the live queue was empty - so each
      // new conversation opened with a pointless round trip and an explanation of history. A job
      // older than a day was not "in flight"; it is a leftover record, and saying so once is
      // enough. `submission_unknown` is never treated as stale, because that one genuinely
      // cannot be resolved without the user.
      const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const ledgerOpen = readLedgerSync()
        .filter((job) => job.corrupt !== true && ['intent', 'submitting', 'queued', 'running', 'downloading', 'download_failed', 'submission_unknown'].includes(job.state));
      const ageOf = (job) => {
        const stamp = job.updatedAt ?? job.createdAt ?? job.submittedAt ?? null;
        const parsed = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
        return Number.isFinite(parsed) ? nowMs - parsed : null;
      };
      const unfinished = ledgerOpen.filter((job) => job.state === 'submission_unknown' || (ageOf(job) ?? 0) <= STALE_AFTER_MS);
      const stale = ledgerOpen.filter((job) => job.state !== 'submission_unknown' && (ageOf(job) ?? 0) > STALE_AFTER_MS);
      if (unfinished.length > 0) {
        const unknown = unfinished.filter((job) => job.state === 'submission_unknown');
        const rest = unfinished.filter((job) => job.state !== 'submission_unknown');
        if (rest.length > 0) {
          guidance.push(`${rest.length} unfinished generation job(s) are recorded (${rest.map((job) => `${job.jobId} ${job.state}`).join(', ')}); poll them with comfy_job before starting anything new, and tell the user what was in flight.`);
        }
        if (unknown.length > 0) {
          guidance.push(`${unknown.length} job(s) have an UNCONFIRMED submission (${unknown.map((job) => job.jobId).join(', ')}). Their outcome cannot be known from here: check the instance queue (comfy_job with queue_only) and ASK the user before resubmitting, because sending it again could double the work.`);
        }
      }
      if (stale.length > 0) {
        guidance.push(`${stale.length} older ledger record(s) are still marked unfinished from an earlier session (${stale.slice(0, 4).map((job) => job.jobId).join(', ')}${stale.length > 4 ? ', …' : ''}). Do NOT poll them and do not mention them unless the user asks about an old run: the live queue is the answer. Only note it if the user says a generation is missing.`);
      }

      if (args.action === 'list_projects') {
        guidance.push(projects.length === 0 ? 'No project has been created yet.' : 'Pick by name or root; ask the user before starting a new project when one already exists.');
      } else {
        guidance.push(state.mode === 'drama'
          ? 'Drama mode is on.'
          : 'General mode: this is a ComfyUI assistant. Only enter drama mode when the user actually asks to make a short drama.');
        if (projects.some((project) => project.present)) {
          guidance.push('The user already has a project on disk; offer to resume it before creating a new one.');
        }
        if (state.userLevel === 'unknown') {
          guidance.push('The user\'s level is not recorded yet. Do not guess: pick it up from how they talk (do they name nodes and models, or ask what a workflow is?) and record it with set_user_level.');
        } else {
          guidance.push(`Tone for a ${state.userLevel} user: ${USER_TONE[state.userLevel] ?? USER_TONE.unknown}`);
        }
      }
      if (state.activeContext?.episodeNumber !== null && state.activeContext?.episodeNumber !== undefined) {
        const source = state.activeContext.sourceId ?? '未指定来源';
        const shot = state.activeContext.shotId === null || state.activeContext.shotId === undefined
          ? ''
          : `，当前镜头 ${String(state.activeContext.shotId)}`;
        guidance.push(`分镜管理当前停在：第${String(state.activeContext.episodeNumber)}集 / ${String(source)}${shot}。用户说“这一集”“这个镜头”时，默认按这个共享上下文定位；若与用户新说的不一致，以用户新说的为准。`);
      }
      return {
        mode: state.mode,
        userLevel: state.userLevel ?? 'unknown',
        changed: false,
        statePath: path,
        activeProject: state.activeProject ?? null,
        activeContext: state.activeContext ?? null,
        projects,
        host: hostIdentity(),
        guidance,
      };
    },
  });
}

/** Every known project, with on-disk presence rechecked. */
async function allProjects(state) {
  const rows = [];
  for (const entry of state.projects) {
    const row = await projectRow(entry);
    row.active = entry.root === state.activeProject;
    rows.push(row);
  }
  return rows.sort((left, right) => String(right.lastOpenedAt ?? '').localeCompare(String(left.lastOpenedAt ?? '')));
}

/**
 * `comfy_launch` 鈥?start, stop and inspect a ComfyUI instance.
 */
export function comfyLaunchTool(config) {
  return defineTool({
    name: 'comfy_launch',
    description: 'Start, stop or inspect ComfyUI itself. Probes first so it never starts a second instance on top of a live one, and waits until the instance actually answers before reporting success. Starting a local instance loads several GB into GPU memory, and starting the cloud tunnel reaches the user\'s paid instance, so both require consent: pass consent=true only when the user asked for this in the current turn or has just agreed to your question. Use the tunnel script the user already has; never invent a host or port.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'start_local', 'start_cloud', 'stop', 'update_cloud'],
        description: 'status reports what is running without changing anything; start_local launches the local ComfyUI; start_cloud runs the user\'s tunnel script; stop kills a process started this way; update_cloud rewrites host/port inside the user\'s tunnel script after keeping a backup.',
      },
      consent: {
        type: 'boolean',
        default: false,
        description: 'Required true for start_local, start_cloud and stop. Set it only when the user asked for the action in this turn or agreed to your question about it.',
      },
      variant: {
        type: 'string',
        enum: ['nvidia', 'fast_fp16', 'cpu'],
        default: 'nvidia',
        description: 'Which local launcher to prefer. fast_fp16 matches run_nvidia_gpu_fast_fp16_accumulation; cpu is for machines without a usable NVIDIA GPU.',
      },
      base_url: { type: 'string', description: 'Address to wait on. Defaults to the plugin setting, then to the first configured local port.' },
      timeout_ms: { type: 'integer', description: 'How long to wait for readiness before reporting a failure with the log tail. Default 240000.', default: 240000 },
      pid: { type: 'integer', description: 'Process id for action=stop, as reported by a previous start.' },
      host: { type: 'string', description: 'New cloud host for action=update_cloud.' },
      port: { type: 'integer', description: 'New cloud port for action=update_cloud.' },
      local_port: { type: 'integer', description: 'New local tunnel port for action=update_cloud.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          reached: { type: 'boolean', required: true },
          /**
           * Null, never undefined: JSON drops an `undefined` property and the
           * harness then rejects the whole tool result as "not lossless JSON".
           * The schema DSL rejects `type: [...]`, so nullability is a oneOf.
           */
          baseUrl: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          detail: { type: 'json' },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.action}: ${value.reached ? 'ready' : 'not ready'}${value.baseUrl === null || value.baseUrl === undefined ? '' : ` at ${value.baseUrl}`}`];
        const detail = value.detail ?? {};
        for (const [key, entry] of Object.entries(detail)) {
          if (entry === null || entry === undefined) continue;
          if (Array.isArray(entry)) {
            if (entry.length === 0) continue;
            lines.push(`${key}:`);
            for (const item of entry.slice(0, 12)) lines.push(`  ${typeof item === 'string' ? item : JSON.stringify(item)}`);
            continue;
          }
          if (typeof entry === 'object') { lines.push(`${key}: ${JSON.stringify(entry)}`); continue; }
          lines.push(`${key}: ${String(entry)}`);
        }
        for (const line of value.guidance ?? []) lines.push(line);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const guidance = [];
      const needsConsent = args.action !== 'status';
      if (needsConsent && args.consent !== true) {
        throw new Error(`action=${args.action} needs consent=true. Ask the user first: starting ComfyUI loads several GB into GPU memory, and the cloud tunnel connects to their paid instance.`);
      }

      if (args.action === 'status') {
        const report = await lifecycleStatus(config, { baseUrls: args.base_url === undefined ? undefined : [args.base_url], signal: exec.signal });
        const rows = report.rows.map((row) => row.reachable
          ? `${row.baseUrl}  -  ComfyUI ${row.comfyuiVersion ?? '?'}${row.queue === null ? '' : `, queue ${row.queue.running} running / ${row.queue.pending} pending`}${row.devices.length === 0 ? '' : `  -  ${row.devices.join('; ')}`}`
          : `${row.baseUrl}  -  not answering (${row.error ?? 'no response'})`);
        if (report.usable === null) {
          guidance.push('Nothing is running. Ask the user whether to start the local instance, and pass consent=true once they agree.');
        }
        if (report.launcher.launcher === null) {
          // "no launcher script" is NOT "not installed". Saying so made the agent ask the user
          // for a path on a machine that had three installs. Report the installs first; only
          // when discovery found nothing is "I could not find it" the honest sentence.
          const found = report.installs ?? [];
          if (found.length === 0) {
            guidance.push(`I found no local ComfyUI install on disk (searched: ${report.launcher.searched.join(', ') || 'the configured paths and the conventional locations'}). Say what was searched; do not ask the user for a path unless they offer one.`);
          } else {
            guidance.push(`A local ComfyUI is installed at ${found[0].path}${found[0].layout === 'integrated' ? ' (an integrated package - start it with action=start_local, not by hand)' : ''}. It has no script launcher, which is normal for an integrated package; action=start_local knows how to start it.`);
            if (found.length > 1) guidance.push(`Other installs found too: ${found.slice(1).map((entry) => entry.path).join(', ')}. Ask which one to use only if it matters.`);
          }
        }
        if (report.cloud.found !== true) {
          guidance.push('No cloud tunnel script is configured, so a cloud instance cannot be started yet. Ask the user how they reach it.');
        } else {
          guidance.push(`Cloud tunnel script declares ${report.cloud.host ?? '?'}:${String(report.cloud.port ?? '?')} on local port ${String(report.cloud.localPort ?? '?')}. If the instance was rebuilt these are stale.`);
        }
        return { action: args.action, reached: report.usable !== null, baseUrl: report.usable ?? null, detail: { rows, launcher: report.launcher.launcher?.path ?? null, launcherCandidates: report.launcher.candidates.map((candidate) => candidate.path), installs: report.installs ?? [], cloud: report.cloud }, guidance };
      }

      if (args.action === 'start_local') {
        const report = await startLocal(config, { variant: args.variant, baseUrl: args.base_url, readyTimeoutMs: args.timeout_ms, signal: exec.signal });
        if (report.started === false && report.alreadyRunning !== true) {
          guidance.push('Report the reason and the log tail to the user instead of retrying blindly.');
        }
        if (report.started === true) guidance.push('ComfyUI is up. Continue with the user\'s actual request.');
        return {
          action: args.action,
          reached: report.started === true || report.alreadyRunning === true,
          baseUrl: report.baseUrl ?? null,
          detail: { launcher: report.launcher ?? null, pid: report.pid ?? null, readyInMs: report.readyInMs ?? null, devices: report.devices ?? null, log: report.log ?? null, reason: report.reason ?? null, logTail: report.logTail ?? null },
          guidance,
        };
      }

      if (args.action === 'start_cloud') {
        const report = await startCloud(config, { readyTimeoutMs: args.timeout_ms, signal: exec.signal });
        if (report.started === false && report.alreadyRunning !== true) {
          guidance.push('Report the reason verbatim. If the instance was rebuilt, ask for the new host and port and offer action=update_cloud.');
        }
        if (report.started === true) guidance.push('The tunnel is up. ComfyUI on the cloud instance is reachable through the local port.');
        return {
          action: args.action,
          reached: report.started === true || report.alreadyRunning === true,
          baseUrl: report.baseUrl ?? null,
          detail: { tunnel: report.tunnel ?? null, pid: report.pid ?? null, readyInMs: report.readyInMs ?? null, log: report.log ?? null, reason: report.reason ?? null, hint: report.hint ?? null, logTail: report.logTail ?? null },
          guidance,
        };
      }

      if (args.action === 'stop') {
        if (!Number.isInteger(args.pid)) throw new Error('stop needs pid, as reported by a previous start');
        const result = await stopProcess({ pid: args.pid });
        guidance.push(result.stopped ? 'Stopped. Verify with action=status.' : 'The process could not be killed; report the output to the user.');
        return { action: args.action, reached: result.stopped, detail: result, guidance };
      }

      // update_cloud
      const scriptPath = typeof config.cloudTunnelScript === 'string' && config.cloudTunnelScript.trim().length > 0 ? config.cloudTunnelScript.trim() : null;
      if (scriptPath === null) throw new Error('no cloud tunnel script is configured, so there is nothing to update; ask the user for the script path or their SSH details');
      const result = await updateCloudCoordinates(scriptPath, { host: args.host, port: args.port, localPort: args.local_port });
      guidance.push(result.changed ? 'Coordinates updated and the previous file kept as a backup. Offer to start the tunnel now.' : 'Nothing was rewritten; the script may use a different variable naming.');
      return { action: args.action, reached: result.changed, detail: result, guidance };
    },
  });
}

/** Read-only helper used by other tools to describe a configured cloud target. */
export async function describeCloud(config) {
  return await readCloudConfig(config.cloudTunnelScript);
}

/**
 * `comfy_workflows` 鈥?what each saved workflow can do, and which one fits.
 */
export function comfyWorkflowsTool(config) {
  return defineTool({
    name: 'comfy_workflows',
    description: 'Know what the user\'s saved ComfyUI workflows can do, and pick one. action=scan reads the workflow directory and caches a profile of every workflow (capabilities, output medium, models it needs, whether its output is currently bypassed). action=match answers "which workflow does X". action=precheck checks one workflow before running it: conversion errors, models missing from the instance, and whether it would produce anything at all. The scan is local file reading only - no GPU, no network - and is cached, so do not re-scan on every question. When several workflows match, present the candidates and let the user choose; never pick silently.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['scan', 'match', 'list', 'precheck'],
        description: 'scan builds or refreshes the cache; match ranks candidates for a request; list shows the cache; precheck validates one workflow against a running instance.',
      },
      request: { type: 'string', description: 'For action=match: what the user asked for, in their own words.' },
      workflow: { type: 'string', description: 'For action=precheck: a workflow file name or path.' },
      directory: { type: 'string', description: 'Workflow directory. Defaults to the configured workflowsDir.' },
      base_url: { type: 'string', description: 'For action=precheck: instance to check models against. Defaults to the configured address.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          directory: { type: 'string' },
          count: { type: 'integer' },
          /** Null until the index has been built; the DSL has no nullable type. */
          scannedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          candidates: { type: 'json' },
          items: { type: 'json' },
          skipped: { type: 'json' },
          precheck: { type: 'json' },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.action}${value.count === undefined ? '' : ` 鈥?${value.count} workflow(s)`}${value.scannedAt === undefined ? '' : ` (indexed ${value.scannedAt})`}`];
        if (value.directory !== undefined) lines.push(`directory: ${value.directory}`);
        for (const row of value.candidates ?? []) {
          const flags = [row.outputInactive ? 'OUTPUT BYPASSED' : null, row.matched?.length > 0 ? `matches ${row.matched.join('+')}` : null].filter(Boolean).join(', ');
          lines.push(`  ${row.name}${flags === '' ? '' : `  [${flags}]`}`);
          lines.push(`      ${(row.capabilities ?? []).join(', ') || 'no capability detected'}`);
        }
        for (const item of value.items ?? []) {
          lines.push(`  ${item.name} 鈥?${(item.capabilities ?? []).join(', ') || 'no capability detected'}${item.outputInactive ? '  [OUTPUT BYPASSED]' : ''}${item.models?.length > 0 ? `  (${item.models.length} model(s))` : ''}`);
        }
        const precheck = value.precheck;
        if (precheck !== undefined && precheck !== null) {
          lines.push(`precheck ${precheck.workflow}: ${precheck.usable ? 'looks runnable' : 'problems found'}`);
          for (const problem of precheck.problems ?? []) lines.push(`  problem: ${problem}`);
          for (const warning of precheck.warnings ?? []) lines.push(`  warning: ${warning}`);
        }
        if (Array.isArray(value.skipped) && value.skipped.length > 0) lines.push(`skipped ${value.skipped.length} backup/partial file(s)`);
        for (const line of value.guidance ?? []) lines.push(line);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      // An explicit directory wins; otherwise DERIVE it from the ComfyUI install this machine
      // actually runs. The configured value is only a hint, because on a machine with two
      // copies the wrong one indexes 1 workflow where the right one has 20.
      const resolved = typeof args.directory === 'string' && args.directory.trim().length > 0
        ? { dir: args.directory.trim(), source: 'action argument' }
        : await resolveWorkflowsDir(config, { statePath: statePath() });
      const directory = resolved.dir;
      const guidance = [];
      if (typeof directory !== 'string' || directory.length === 0) {
        return {
          action: args.action,
          directory: null,
          count: 0,
          guidance: [
            'I could not find a ComfyUI workflow folder on this machine, so there is nothing to index yet.',
            'Tell me where ComfyUI lives (or run comfy_install action=check) and I will read the workflows from there.',
            'If ComfyUI is not installed at all, that is the step to do first - index only works on files that exist.',
          ],
        };
      }

      if (args.action === 'scan') {
        const report = await scanWorkflows(directory);
        const scannedAt = new Date().toISOString();
        await updateState((current) => {
          current.workflows = { indexedAt: scannedAt, dir: report.dir, count: report.count, items: report.items.slice(0, 400) };
          return current;
        });
        guidance.push(`Indexed ${report.count} workflow(s) from ${report.dir}. This read only local files, so it is cheap - but it is cached now, so answer later questions from action=match or action=list instead of scanning again.`);
        if (report.skippedSidecars.length > 0) guidance.push(`${report.skippedSidecars.length} .bak-style file(s) were skipped and will never be offered as candidates.`);
        const dead = report.items.filter((item) => item.outputInactive);
        if (dead.length > 0) guidance.push(`${dead.length} workflow(s) currently have no active output node (${dead.slice(0, 4).map((item) => item.name).join(', ')}): the saved state bypasses their SaveImage/SaveVideo, so running them produces nothing until the group is switched back on in the UI.`);
        return { action: args.action, directory: report.dir, count: report.count, scannedAt, items: report.items.map(briefItem), skipped: report.skippedSidecars, guidance };
      }

      const { state } = await readState();
      const index = state.workflows;

      if (args.action === 'list') {
        if (index.count === 0) {
          guidance.push('The workflow index is empty. Run action=scan once.');
          return { action: args.action, directory: index.dir ?? directory, count: 0, items: [], guidance };
        }
        if (index.dir !== directory) guidance.push(`The cache was built from ${index.dir}, which differs from the configured directory ${directory}; rescan if the workflows moved.`);
        return { action: args.action, directory: index.dir, count: index.count, scannedAt: index.indexedAt, items: (index.items ?? []).map(briefItem), guidance };
      }

      if (args.action === 'match') {
        if (typeof args.request !== 'string' || args.request.trim().length === 0) throw new Error('match needs request: what the user asked for');
        let active = index;
        if (active.count === 0) {
          const report = await scanWorkflows(directory);
          const scannedAt = new Date().toISOString();
          await updateState((current) => {
            current.workflows = { indexedAt: scannedAt, dir: report.dir, count: report.count, items: report.items.slice(0, 400) };
            return current;
          });
          active = { indexedAt: scannedAt, dir: report.dir, count: report.count, items: report.items };
          guidance.push('The index was empty, so it was built first (local file reading only).');
        }
        const result = matchWorkflows(active, args.request);
        if (result.confident.length === 1) {
          guidance.push(`Only one workflow matches, so it is safe to propose it directly: ${result.confident[0].name}.`);
        } else if (result.ambiguous) {
          guidance.push('Several workflows match. Present these candidates to the user with what each is for, and let them choose - do not pick one yourself, and say when a candidate is really an editing flow rather than a plain generator.');
        } else if (result.wanted.length === 0) {
          guidance.push('No capability could be read from the request. Show the list and ask what they want to do.');
        } else {
          guidance.push('Nothing matched. Show the closest candidates and ask which they meant.');
        }
        return { action: args.action, directory: active.dir, count: active.count, scannedAt: active.indexedAt, candidates: result.candidates, guidance };
      }

      // precheck
      if (typeof args.workflow !== 'string' || args.workflow.trim().length === 0) throw new Error('precheck needs workflow');
      const baseUrl = (args.base_url ?? config.comfyBaseUrl ?? '').trim();
      if (baseUrl.length === 0) throw new Error('precheck needs a ComfyUI address: pass base_url or configure comfyBaseUrl');
      const filePath = args.workflow.includes('\\') || args.workflow.includes('/')
        ? args.workflow
        : `${directory.replace(/[\\/]+$/u, '')}\\${args.workflow}`;
      const problems = [];
      const warnings = [];
      let graph;
      try {
        graph = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        return { action: args.action, directory, precheck: { workflow: args.workflow, usable: false, problems: [`cannot read ${filePath}: ${String(error.message ?? error)}`] }, guidance };
      }
      const objectInfo = await readObjectInfo(baseUrl, { timeoutMs: 120000, signal: exec.signal });
      let prompt;
      try {
        const converted = uiGraphToPrompt(graph, { objectInfo });
        prompt = converted.prompt;
        const missingClasses = [...new Set(converted.skipped.filter((entry) => !isCosmeticNodeClass(entry.type) && entry.reason === 'node class is not installed on this instance').map((entry) => entry.type))];
        if (missingClasses.length > 0) problems.push(`this instance is missing node classes the workflow needs: ${missingClasses.join(', ')}`);
        const rewired = converted.notes.filter((note) => /bypassed|dropped|no SetNode/i.test(note));
        if (rewired.length > 0) warnings.push(`${rewired.length} note(s) about bypassed or unresolved wiring; read them before trusting the output`);
      } catch (error) {
        return { action: args.action, directory, precheck: { workflow: args.workflow, usable: false, problems: [`the workflow could not be converted: ${String(error.message ?? error)}`] }, guidance };
      }

      const outputs = Object.entries(prompt).filter(([, node]) => /SaveImage|SaveVideo|VHS_VideoCombine|PreviewImage|DecodeAndSave/i.test(node.class_type));
      if (outputs.length === 0) problems.push('the saved state leaves no active output node, so a run would produce nothing; switch the output group back on in the ComfyUI UI and save again');

      // Models: compare what the workflow names against what the instance offers.
      const referenced = new Set();
      // Only models the SUBMITTED graph names. Bypassed branches routinely point
      // at models this instance does not have, and flagging those would report a
      // runnable workflow as broken.
      for (const node of Object.values(prompt)) {
        for (const value of Object.values(node.inputs ?? {})) {
          if (typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|gguf|onnx)$/iu.test(value)) referenced.add(value.replace(/\\/gu, '/'));
        }
      }
      const available = availableModelNames(objectInfo);
      const modelCheck = checkModels([...referenced], available.names);
      if (modelCheck.missing.length > 0) {
        problems.push(...modelCheck.missing.slice(0, 8).map((entry) => `model not found on this instance: ${entry.model}`));
      }

      const usable = problems.length === 0;
      guidance.push(usable
        ? 'Precheck passed. Queue it with comfy_run, and expect it to actually produce a file.'
        : 'Report these problems to the user before running anything: a run would fail or produce nothing.');
      if (modelCheck.matched.length > 0) guidance.push(`${modelCheck.matched.length} referenced model(s) are present on this instance.`);
      return {
        action: args.action,
        directory,
        scannedAt: index.indexedAt ?? null,
        precheck: {
          workflow: filePath,
          usable,
          problems,
          warnings,
          nodes: Object.keys(prompt).length,
          outputNodes: outputs.map(([id, node]) => `#${id} ${node.class_type}`),
          modelsReferenced: [...referenced].length,
          modelsPresent: modelCheck.matched.length,
        },
        guidance,
      };
    },
  });
}

/** Compact one index item for tool output. */
function briefItem(item) {
  return {
    name: item.name,
    file: item.file,
    capabilities: item.capabilities,
    media: item.media,
    nodeCount: item.nodeCount,
    bypassedNodes: item.bypassedNodes,
    outputInactive: item.outputInactive,
    models: item.models,
    modifiedAt: item.modifiedAt,
  };
}

/**
 * `comfy_install` 鈥?is ComfyUI already here, and what can this machine run.
 */
export function comfyInstallTool(config) {
  return defineTool({
    name: 'comfy_install',
    description: 'Answer "do I need to install ComfyUI?" and "what can this machine run?" before anything expensive. It checks several independent signals - a running instance, known install paths and their marker files, deployment packages, paths recorded by earlier sessions, environment variables - and reports which ones fired, so an existing install is never silently duplicated (a second copy costs well over a hundred gigabytes). It also turns the instance\'s GPU report into per-task verdicts, so the user learns up front that a small laptop GPU can generate stills but cannot run the video graph. Call it before proposing an install, and before promising video generation.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['check', 'capability'],
        description: 'check looks for existing installs and says what to do; capability reports what the current GPU can run and how long a task should take.',
      },
      task: {
        type: 'string',
        enum: ['image', 'edit', 'quadview', 'upscale-image', 'video'],
        description: 'For action=capability: which task to estimate. Defaults to image.',
      },
      base_url: { type: 'string', description: 'Instance to read the GPU from. Defaults to the configured address and the local ports.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          installed: { type: 'boolean' },
          signals: { type: 'array', items: { type: 'string' } },
          inspected: { type: 'json' },
          installs: { type: 'json' },
          packages: { type: 'json' },
          capability: { type: 'json' },
          estimate: { type: 'json' },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.action}: ${value.installed === true ? 'ComfyUI is already present' : value.installed === false ? 'nothing installed here' : 'capability report'}`];
        for (const signal of value.signals ?? []) lines.push(`  signal: ${signal}`);
        for (const row of value.inspected ?? []) lines.push(`  ${row.kind.padEnd(8)} ${row.path}`);
        const capability = value.capability;
        if (capability !== undefined && capability !== null) {
          if (capability.known === true) {
            lines.push(`  GPU: ${capability.gpu} (${capability.vramGb}GB)`);
            // One block per task, each carrying the step that changes its verdict. A row of
            // ticks would say what is possible and not what to do about what is not.
            for (const entry of capability.verdicts ?? []) {
              const minutes = entry.seconds === null || entry.seconds === undefined ? '' : `  ~${Math.max(1, Math.round(entry.seconds / 60))}min`;
              lines.push(`    [${entry.verdict}] ${entry.label}${minutes}`);
              lines.push(`        ${entry.why}`);
              if (entry.state !== 'ready') lines.push(`        -> ${entry.next}`);
            }
          }
          lines.push(`  ${capability.advice}`);
        }
        const estimate = value.estimate;
        if (estimate !== undefined && estimate !== null) lines.push(`  this run: ${estimate.text}`);
        for (const line of value.guidance ?? []) lines.push(line);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const { state } = await readState();
      const guidance = [];

      if (args.action === 'check') {
        const status = await lifecycleStatus(config, { baseUrls: args.base_url === undefined ? undefined : [args.base_url], signal: exec.signal });
        const live = status.rows.filter((row) => row.reachable).map((row) => row.baseUrl);
        // `statePath()` is passed so discovery also considers the path a previous session
        // recorded - the same hint the launcher uses. Without it the two could disagree about
        // where the install is, which is how "not installed" and "starting it" coexisted.
        const report = await detectInstalls(config, { liveBaseUrls: live, state, statePath: statePath() });
        guidance.push(report.recommendation.text);
        if (report.installed) {
          guidance.push('Do NOT start an install. Say what you found and offer to use it.');
        } else if (report.packages.length > 0) {
          guidance.push('A deployment package is present, so the heavy download is already done; deploy it with the comfyui-deploy skill rather than downloading again.');
        } else {
          guidance.push('Installing is a hundred-gigabyte, hard-to-undo operation: state the size and the GPU requirement, get explicit agreement, and install to a NEW path rather than over anything that exists.');
          // An honest "not installed" names the places that were searched. Otherwise the sentence
          // reads as a fact about the machine, and a user with three installs in an unusual place
          // is told to download what they already have.
          const searched = [...(report.searched?.discoveryHints ?? []), ...(report.searched?.markerRoots ?? [])];
          guidance.push(searched.length === 0
            ? 'Nothing was configured to search, so say that you looked at the configured paths and the conventional locations - not that the machine has nothing.'
            : `Searched: ${searched.slice(0, 6).join(' | ')}${searched.length > 6 ? ` (+${searched.length - 6} more)` : ''}. Say this list before saying "none".`);
        }
        if (report.installs.length > 1) guidance.push(`More than one install was found (${report.installs.map((entry) => entry.path).join(', ')}). Ask which one the user wants to use.`);
        return { action: args.action, installed: report.installed, signals: report.signals, inspected: report.inspected, installs: report.installs, packages: report.packages, guidance };
      }

      // capability
      const status = await lifecycleStatus(config, { baseUrls: args.base_url === undefined ? undefined : [args.base_url], signal: exec.signal });
      const row = status.rows.find((entry) => entry.reachable);
      if (row === undefined) {
        guidance.push('No instance is answering, so the GPU cannot be read. Start one first (comfy_launch), or answer from what the user already told you.');
        return { action: args.action, installed: false, signals: [], capability: { known: false, advice: 'No instance is answering; start ComfyUI first.' }, guidance };
      }
      const devices = (row.devices ?? []).map((text) => {
        const match = /^(.*?) \(([\d.]+)GB free of ([\d.]+)GB\)$/u.exec(text);
        return match === null ? { name: text, vramTotalGb: 0 } : { name: match[1], vramTotalGb: Number(match[3]) };
      });
      // Whether a route to a cloud GPU exists changes the verdict for anything this card is
      // short of: "video cannot run here" and "video needs the cloud instance" are different
      // answers, and only one of them tells the user what to do. The tunnel address is known
      // when the answering instance IS the cloud one, or when the configured address is not a
      // local port.
      const localPorts = Array.isArray(config.localPorts) ? config.localPorts : [];
      const answeringIsCloud = row.kind === 'cloud';
      const configuredIsRemote = typeof config.comfyBaseUrl === 'string'
        && !localPorts.some((port) => config.comfyBaseUrl.includes(`:${port}`));
      const capability = assessCapability(devices, { cloudConfigured: answeringIsCloud || configuredIsRemote });
      const estimate = estimateDuration({ task: args.task ?? 'image', vramGb: capability.vramGb ?? 6 });
      guidance.push(`Tell the user the estimate before starting: ${estimate.text}. Then report progress if it runs past roughly twice that, instead of staying silent.`);
      // A verdict of "needs a step" is only useful with the step attached, so the tool hands the
      // model the sentences rather than leaving it to reconstruct them from the numbers.
      for (const entry of capability.verdicts ?? []) {
        if (entry.state === 'prepare') guidance.push(`${entry.label}：${entry.verdict}。${entry.next}`);
        if (entry.state === 'blocked') guidance.push(`${entry.label}：${entry.verdict}。${entry.next}`);
      }
      if (capability.known === true) guidance.push('Store the fact that the user wants this class of task by just using it; no preference needs recording.');
      // Remember the hardware so a later session can answer without probing.
      await updateState((current) => {
        current.comfy.hardware = { gpu: capability.gpu ?? null, vramGb: capability.vramGb ?? null, checkedAt: new Date().toISOString() };
        current.comfy.lastUsed = row.baseUrl;
        return current;
      });
      return { action: args.action, installed: true, signals: [], capability, estimate, guidance };
    },
  });
}
