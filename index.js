/**
 * Short-drama director bundle for the DeepSeek Harness.
 *
 * Host half: register the production skills (director flow, asset inventory,
 * asset prompts, asset production, episode video prompts, H3 conversion,
 * ComfyUI deployment) plus the ComfyUI and workspace tools those skills drive.
 *
 * Skills are read from `skills/<name>/SKILL.md` in this package, so the module
 * body is already written: `PROMPT.md` and `references/*` next to a `SKILL.md`
 * are its resource base and are read with the ordinary file tools.
 *
 * @module dsh-plugin-short-drama-director
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import {
  comfyGraphTool,
  comfyInventoryTool,
  comfyJobTool,
  comfyRunTool,
  dramaWorkspaceTool,
} from './lib/tools.js';
import { comfyInstallTool, comfyLaunchTool, comfyWorkflowsTool, dramaModeTool } from './lib/lifecycle-tools.js';
import { registerCommands } from './lib/commands.js';
import { createPanelRouteHandler, registerStoryboardCommand, storyboardTool, PANEL_PREFIX } from './lib/storyboard-tools.js';
import { readModeSync } from './lib/state.js';
import { skillVisibleIn, toolsForMode } from './lib/mode.js';
import { createMediaService, handleFromUrl, MEDIA_PREFIX } from './lib/media-service.js';
import { designRoot } from './lib/design-root.js';
import { mediaRootsFor } from './lib/env-discovery.js';
import { appendPromptSourceInstruction } from './lib/prompt-sources.js';
import {
  appendUserLayerToSkill,
  customizationDir,
  discoverUserSkills,
  workflowMemoryTool,
} from './lib/workflow-memory.js';

/** Loader identity. */
export const name = 'short-drama-director';

/** Services this plugin registers into. */
export const inject = ['tools', 'skills'];
/** Highest skill precedence rank the registry defines, for packaged providers. */
const BUNDLED_SKILL_RANK = 600;
// Root installation and per-agent presets share one HTTP route and one handle registry.
const ROOT_MEDIA = new WeakMap();
// The panel's own route is shared the same way; its state is the registration itself.
const ROOT_PANEL = new WeakMap();

/**
 * Make a route disposer answer "is my route STILL installed".
 *
 * `webServer.register` returns a disposer that deletes the route it inserted. An activation that
 * outlives its server - a reload against a replaced web server - would otherwise leave the next
 * activation believing the prefix is taken, and the panel would fall back to the command channel
 * with nothing anywhere saying why.
 */
function wrapRouteDisposer(dispose) {
  if (typeof dispose !== 'function') return dispose;
  const wrapped = () => { wrapped.installed = false; dispose(); };
  wrapped.installed = true;
  return wrapped;
}

/**
 * Tunables; every path default matches the machine this bundle was written for.
 *
 * This MUST stay a Schemastery schema: the Loader calls `Config.validate()` while
 * resolving the row, so a plain data object fails activation with
 * "Cannot read properties of undefined (reading 'validate')" and takes the whole
 * plugin - every tool and every skill - down with it. Override individual fields
 * from the profile's `cordis.patch.yml` rather than editing this.
 */
export const Config = z.object({
  comfyBaseUrl: z.string().default('http://127.0.0.1:8188'),
  localPorts: z.array(z.number()).default([8188, 8189, 8888]),
  /**
   * The local port the cloud tunnel listens on. An instance answering here is
   * treated as the cloud one, which is what makes "prefer cloud" possible.
   */
  cloudLocalPort: z.number().default(8888),
  /**
   * Which instance to use when more than one is up: `auto` prefers the cloud,
   * `cloud` and `local` force one. `auto` is the default because a cloud GPU
   * finishes the same job faster and leaves the local card free.
   */
  preferInstance: z.string().default('auto'),
  /**
   * Empty means "discover and merge every installed ComfyUI". Explicit paths are scanned
   * recursively and remain a deliberate boundary; no unrelated install is added to them.
   */
  workflowsDir: z.string().default(''),
  /** Additional workflow folders, merged with workflowsDir; all are scanned recursively. */
  workflowSearchPaths: z.array(z.string()).default([]),
  h3Workflow: z.string().default(''),
  /**
   * Empty means "decide it": the system drive, then the user's home. Never a fixed letter -
   * a machine without a D: drive would otherwise be given a writable root that does not exist.
   */
  workspaceRoot: z.string().default(''),
  /**
   * Drive the short-drama project folder lives on. Empty means "decide it": a drive that
   * exists, preferring a data drive over the system drive (see `designRoot`). Projects live in
   * `<drive>/DSH-Short-Drama-Project/<script title>` — the same directory the 分镜管理
   * panel lists from, so the create step and the panel cannot disagree about where a
   * project is.
   */
  projectDrive: z.string().default(''),
  /**
   * A HINT, not the answer: where ComfyUI might live. Empty by default because the plugin
   * ships to machines it has never seen. Discovery also reads `COMFYUI_HOME` /
   * `COMFYUI_PATH`, what a previous session recorded, and one level of siblings around any
   * hint - which is how a portable copy and a 绘世 package side by side are both found.
   */
  comfyuiPortablePath: z.string().default(''),
  /** Extra install locations to inspect, for a machine with several copies. */
  comfyuiSearchPaths: z.array(z.string()).default([]),
  /**
   * The user's own cloud tunnel script. Empty by default on purpose: a cloud
   * instance is rebuilt with a different hostname and port, so the address must
   * be read from the user's file at call time and never carried by this plugin.
   */
  cloudTunnelScript: z.string().default(''),
  /** Optional hints for installation detection; empty by default for the same reason. */
  deployPackPath: z.string().default(''),
  cloudPatchPackPath: z.string().default(''),
  runTimeoutMs: z.number().default(900000),
  skillDir: z.string().default(''),
});

/** YAML frontmatter is the only place a skill's name and description live. */
function parseSkillFrontmatter(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (match === null) throw new Error(`short-drama-director: ${path} has no YAML frontmatter`);
  const block = match[1];
  const read = (key) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'mu').exec(block);
    if (line === null) return undefined;
    const value = line[1].trim();
    if (value.length === 0) return undefined;
    return value.replace(/^['"]|['"]$/gu, '');
  };
  const skillName = read('name');
  const description = read('description');
  const whenToUse = read('whenToUse');
  if (skillName === undefined) throw new Error(`short-drama-director: ${path} has no name in its frontmatter`);
  if (description === undefined) throw new Error(`short-drama-director: ${path} has no description in its frontmatter`);
  return {
    name: skillName,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    content: raw.slice(match[0].length).trim(),
  };
}

/** Discover every `skills/<name>/SKILL.md` in this package. */
async function discoverSkills(baseDir) {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(baseDir, entry.name);
    const skillPath = join(directory, 'SKILL.md');
    let raw;
    try {
      if (!(await stat(skillPath)).isFile()) continue;
      raw = await readFile(skillPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(raw, skillPath);
    found.push({
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'short-drama-director',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: skillPath,
      directory,
      resourceBase: { kind: 'directory', path: directory },
      content: parsed.content,
    });
  }
  return found;
}

/**
 * Register the skills provider and the ComfyUI / workspace tools.
 *
 * @param ctx - host context carrying the skill and tool registries.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const rootContext = ctx.root ?? ctx;
  let mediaRuntime = ROOT_MEDIA.get(rootContext);
  if (mediaRuntime === undefined) {
    mediaRuntime = { service: createMediaService(), users: 0, dispose: null };
    ROOT_MEDIA.set(rootContext, mediaRuntime);
  }
  const mediaService = mediaRuntime.service;
  // Never grant a bare drive root: on the machine this was written for that was `D:\`, which
  // exposed every unrelated file on the drive to the panel's media route, and on a machine
  // without a D: drive the grant pointed at nothing. Derive the two directories that genuinely
  // hold projects and a working folder, and grant only those.
  const designRootDir = designRoot({ drive: config.projectDrive }).root;
  for (const root of mediaRootsFor(config, process.env, { designRootDir })) mediaService.allowRoot(root);
  const mediaRouteDisposers = [];
  // Same sharing rule as the media route: one `webServer` prefix per root installation, and a
  // per-agent instance only counts as a user of it. Two simultaneous registrations of the same
  // path would throw, which is why the counter - not the registration itself - is the unit.
  let panelRuntime = ROOT_PANEL.get(rootContext);
  if (panelRuntime === undefined) {
    panelRuntime = { users: 0, dispose: null };
    ROOT_PANEL.set(rootContext, panelRuntime);
  }
  const panelRouteDisposers = [];
  const skillDir = config.skillDir !== undefined && config.skillDir.length > 0
    ? config.skillDir
    : fileURLToPath(new URL('skills/', import.meta.url));
  if (!isAbsolute(skillDir)) throw new Error('short-drama-director: skillDir must be an absolute directory');

  // A failing plugin fiber takes every tool and skill with it, so diagnostics must never
  // be the thing that throws: `ctx.logger` is reached for without a dependency declaring
  // it, and activation must not hinge on it.
  const log = (...parts) => {
    try {
      const logger = ctx.logger;
      if (typeof logger?.info === 'function') logger.info(parts.join(' '));
      else if (typeof logger?.debug === 'function') logger.debug(parts.join(' '));
    } catch {
      // Logging is best effort; never let it break activation.
    }
  };

  // The mode decides what this plugin exposes, and registration is synchronous, so the
  // mode is read synchronously too. Waiting for a promise here would leave the plugin
  // active with an empty registry for a tick, and a caller that inspects the tool list
  // right after `apply` would see nothing.
  let mode = readModeSync();

  // Discovered once per mode, not once per process: the file list is stable, but WHICH
  // files are offered is not. Keeping both under one key means a mode switch re-filters
  // instead of re-reading the directory.
  const candidatesByMode = new Map();
  /** The live provider, so the mode switch can invalidate its cached catalog. */
  let skillCatalog = null;

  ctx.skills.registerProvider((control) => {
    const provider = {
      name: 'short-drama-director',
      async list() {
        let bundled = candidatesByMode.get('all');
        if (bundled === undefined) {
          try {
            bundled = await discoverSkills(skillDir);
          } catch (error) {
            ctx.logger.warn(`short-drama-director: cannot read ${skillDir}: ${String(error)}`);
            return { candidates: [], complete: false };
          }
          candidatesByMode.set('all', bundled);
        }
        // User-added skills are read on every catalog request. They must appear without a
        // plugin rebuild, and a malformed user file must not take the packaged catalog down.
        let userSkills = [];
        try {
          userSkills = await discoverUserSkills(process.env, { onWarning: log });
        } catch (error) {
          log('short-drama-director: cannot read user skill directory', String(error?.message ?? error));
        }
        const merged = new Map(bundled.map((candidate) => [candidate.name, candidate]));
        for (const candidate of userSkills) {
          if (!merged.has(candidate.name)) merged.set(candidate.name, candidate);
        }
        const all = [...merged.values()];
        // Filtered on every call rather than cached: the mode can change between two
        // catalog reads, and a cached filtered list would keep advertising the tools of
        // the mode the user just left.
        // User-created skills are an explicit customization and remain available in both
        // modes. Packaged pipeline skills still obey the mode boundary.
        return all.filter((candidate) => candidate.source === 'user' || skillVisibleIn(mode, candidate.name));
      },
      async get(candidate) {
        if (typeof candidate?.locator !== 'string') return undefined;
        const raw = await readFile(candidate.locator, 'utf8');
        const parsed = parseSkillFrontmatter(raw, candidate.locator);
        const { directory } = candidate;
        let content = parsed.content;
        if (parsed.name === 'drama-episode-video-prompts') {
          try {
            content = await appendPromptSourceInstruction(content, { skillDir });
          } catch (error) {
            const message = String(error?.message ?? error);
            log('short-drama-director: cannot read the selected prompt source', message);
            content = `${content}\n\n## 全局配置：剧本转视频提示词\n\n读取全局配置失败：${message}\n\n在开始写视频提示词前，先提醒用户到「分镜管理 → 全局配置 → 剧本转视频提示词」重新选择或上传文档。\n`;
          }
        }
        content = await appendUserLayerToSkill(content, {
          skillName: parsed.name,
          env: process.env,
          // User rule additions apply in both modes. Automatic workflow memories are
          // deliberately drama-only, so general image/video work keeps a clean context.
          includeWorkflowMemory: mode === 'drama',
        });
        return {
          name: parsed.name,
          description: parsed.description,
          ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
          invocation: candidate.invocation ?? { modelInvocable: true, userInvocable: true },
          source: candidate.source ?? 'bundled',
          provider: 'short-drama-director',
          ...directory === undefined ? {} : { resourceBase: { kind: 'directory', path: directory } },
          path: candidate.locator,
          content,
        };
      },
      /** Called by the mode switch so a cached catalog cannot outlive the mode. */
      invalidate() {
        try {
          control?.invalidate?.();
        } catch (error) {
          log('short-drama-director: skill catalog invalidate failed', String(error?.message ?? error));
        }
      },
    };
    skillCatalog = provider;
    return provider;
  });

  // Tool registration is rebuilt on every mode change, so only the current mode's tools
  // exist at any moment. The registries make this cheap and exact: every `register`
  // returns the disposer that removes that one row, so a rebuild never risks leaving a
  // half-registered mode behind.
  const toolDisposers = [];
  // `storyboard` needs the filesystem and the session store, so it is built inside the
  // injection below and slotted in here once it exists.
  let storyboardFactory = null;

  /**
   * The one place a mode change is applied.
   *
   * `/drama` and the `drama_mode` tool are two doors into the same switch, so both end
   * here. Applying it in one place is what keeps the stored mode and the registered tools
   * from ever disagreeing.
   */
  const onModeChange = async (next) => {
    mode = next === 'drama' ? 'drama' : 'general';
    rebuildTools();
    // The provider is handed back its `invalidate`; calling it is what makes the change
    // visible to the next catalog read instead of at some later cache expiry.
    try {
      skillCatalog?.invalidate?.();
    } catch (error) {
      log('short-drama-director: catalog invalidate failed', String(error?.message ?? error));
    }
    log(`short-drama-director: mode -> ${mode}; tools now`, toolsForMode(mode).join(', '));
  };

  const toolFactories = {
    comfy_graph: () => comfyGraphTool(config),
    comfy_install: () => comfyInstallTool(config),
    comfy_inventory: () => comfyInventoryTool(config),
    comfy_job: () => comfyJobTool({ ...config, ctx }),
    comfy_launch: () => comfyLaunchTool(config),
    comfy_run: () => comfyRunTool({ ...config, ctx }),
    comfy_workflows: () => comfyWorkflowsTool(config),
    // The tool is another door into the same switch, so it is handed the same callback
    // `/drama` uses.
    drama_mode: () => dramaModeTool({ ...config, onModeChange }),
    drama_workspace: () => dramaWorkspaceTool({ ...config, ctx }),
    workflow_memory: () => workflowMemoryTool({ env: process.env }),
  };

  const rebuildTools = () => {
    while (toolDisposers.length > 0) {
      const dispose = toolDisposers.pop();
      try {
        dispose?.();
      } catch (error) {
        log('short-drama-director: tool dispose failed', String(error?.message ?? error));
      }
    }
    for (const name of toolsForMode(mode)) {
      const factory = name === 'storyboard' ? storyboardFactory : toolFactories[name];
      if (typeof factory !== 'function') continue;
      try {
        const dispose = ctx.tools.register(factory());
        if (typeof dispose === 'function') toolDisposers.push(dispose);
      } catch (error) {
        log(`short-drama-director: cannot register ${name}:`, String(error?.message ?? error));
      }
    }
  };

  // The storyboard tool and the `/storyboard` command both need the filesystem and
  // the session store. They are registered only once those services exist, so a
  // deployment without them keeps every other tool instead of losing the whole fiber:
  // a hard `inject` on an absent service would take this plugin down with it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['fs', 'sessions'], (scope) => {
      const registry = typeof scope.get === 'function' ? scope.get('commands') : undefined;
      const sandboxPolicy = typeof scope.get === 'function' ? scope.get('sandboxPolicy') : undefined;
      storyboardFactory = () => storyboardTool({
        ...config,
        ctx: scope,
        fs: scope.get('fs'),
        sessions: scope.get('sessions'),
        registry,
        sandboxPolicy,
        media: mediaService,
        onModeChange,
      });
      // Registered here rather than after the injection returns: this callback is what
      // proves the two services arrived, and the tool must exist the moment they do.
      if (mode === 'drama') rebuildTools();
    });
  }

  // The panel shows pictures and plays video, which a browser cannot do from a filesystem
  // path. This is the one route that hands out bytes, so it is also the one place where the
  // access boundary lives: a request carries an opaque handle minted by `lib/media-service`
  // for a specific file, and a handle is only ever minted for a file inside a project root the
  // tool actually read. No path from a URL is ever opened.
  //
  // Registered through `ctx.inject` rather than a hard `inject` entry: a deployment without a
  // web server (a CLI-only composition) must keep every tool and skill, and a hard dependency
  // on `webServer` would take the whole fiber down instead.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const owner = scope.root ?? scope;
      const webServer = typeof owner.get === 'function' ? owner.get('webServer') : undefined;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      try {
        if (mediaRuntime.users === 0) mediaRuntime.dispose = webServer.register({
          kind: 'prefix',
          path: MEDIA_PREFIX,
          handler: async (req, res) => {
            // The trust fence first: the composition's connection service owns Host/Origin
            // validation and browser authentication, and every route is expected to ask it
            // before doing any work. Answering before that fence would make this route the
            // one unauthenticated endpoint on the port.
            try {
              const connection = typeof owner.get === 'function' ? owner.get('connection') : undefined;
              if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('media request rejected: connection trust service unavailable');
                return;
              }
              const rejection = await Promise.resolve(connection.requestRejection(req));
              if (rejection !== undefined && rejection !== null) {
                res.writeHead(rejection.status ?? 403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(String(rejection.message ?? 'rejected'));
                return;
              }
            } catch (error) {
              log('short-drama-director: media trust fence failed closed', String(error?.message ?? error));
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('media request rejected');
              return;
            }
            const handle = handleFromUrl(req.url);
            if (handle === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('no such media');
              return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' });
              res.end();
              return;
            }
            try {
              await mediaService.serve(req, res, { handle });
            } catch (error) {
              log('short-drama-director: media serve failed', String(error?.message ?? error));
              if (!res.headersSent) res.writeHead(500);
              res.end();
            }
          },
        });
        mediaRuntime.users += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          mediaRuntime.users -= 1;
          if (mediaRuntime.users === 0) { mediaRuntime.dispose?.(); mediaRuntime.dispose = null; }
        };
        mediaRouteDisposers.push(release);
        scope.effect?.(() => release, 'short-drama-director shared media route');
        log(`short-drama-director: media route registered at ${MEDIA_PREFIX}`);

        // The panel's private channel, on the same web server and behind the same trust fence.
        //
        // The command channel cannot serve the panel: every admitted command appends
        // `command/run` and `command/done` to the session log, and the Web client renders that
        // pair as a conversation card, so a panel that calls the Host thirty times by being open
        // thirty times wrote into the transcript. `recordInput: false` removes the request half
        // only, and a command result has no field other than `text`, so the answer would still be
        // JSON in the log. A route has neither problem: nothing on this path is a session event.
        //
        // Registered here rather than in a second `ctx.inject(['webServer'])` because a duplicate
        // (kind, path) registration throws, and this is already the one place that owns the
        // server. The guard is "is a route registered", not the user counter: a registration that
        // failed - a server without prefix support, a colliding route - would otherwise leave the
        // counter at zero and the next activation claiming a route that was never installed.
        if (panelRuntime.dispose === null || panelRuntime.dispose.installed !== true) {
          panelRuntime.dispose = wrapRouteDisposer(webServer.register({
            kind: 'prefix',
            path: PANEL_PREFIX,
            handler: createPanelRouteHandler({
              ctx: owner,
              config,
              media: mediaService,
              onModeChange,
              // Resolved per request, and from BOTH places it can legitimately live: the root
              // context that owns the route, and the scope that registered it - which is the one a
              // host-side `fs` is usually injected into, while `ctx.root` may be a layer that never
              // saw it. Reading it once at registration would freeze whichever was undefined then.
              getFs: () => (typeof ctx.get === 'function' ? ctx.get('fs') : undefined)
                ?? (typeof owner.get === 'function' ? owner.get('fs') : undefined),
            }),
          }));
          panelRuntime.installedBy = webServer;
        }
        panelRuntime.users += 1;
        let panelReleased = false;
        const releasePanel = () => {
          if (panelReleased) return;
          panelReleased = true;
          panelRuntime.users -= 1;
          if (panelRuntime.users === 0) { panelRuntime.dispose?.(); panelRuntime.dispose = null; }
        };
        panelRouteDisposers.push(releasePanel);
        scope.effect?.(() => releasePanel, 'short-drama-director shared panel route');
        log(`short-drama-director: panel route registered at ${PANEL_PREFIX}`);
      } catch (error) {
        log('short-drama-director: cannot register the media or panel route', String(error?.message ?? error));
      }
    });
  }

  // `/drama` is the user's own switch. Registered after the tools so a deployment
  // without a command registry still gets everything else.
  const disposeCommands = registerCommands(ctx, onModeChange);
  // `/storyboard` stays registered even though the panel now talks to the HTTP route: it is the
  // fallback channel when that route is absent (a deployment with no web server, an older Host)
  // and the documented way for a person to read the same data by hand. Both channels call
  // `runPanelRequest`, so nothing about an action depends on which one carried it.
  //
  // Register once in the calling context. Cordis rejects a second definition in the same
  // layer; probing several attribution paths used to abort plugin activation midway.
  const boardDisposers = [];
  // One media service per plugin life. Handles are minted by the tool when it reads a project,
  // and the roots are the places this plugin is allowed to serve from: the project drive
  // (which is where an asset or a finished shot necessarily lives) and the workspace root the
  // configuration names. A handle for anything else is refused at serve time.
  const startStoryboardCommand = (viaContext, label) => {
    const commands = viaContext !== undefined && typeof viaContext.get === 'function'
      ? viaContext.get('commands')
      : viaContext;
    if (commands === undefined || commands === null || typeof commands.register !== 'function') return undefined;
    // The third argument is what lets the handler resolve the CALLER's sandbox policy.
    // Without it every write to the project folder is refused as outside the deployment
    // default's writable root, so the panel can read but never save.
    const dispose = registerStoryboardCommand(
      commands,
      () => (typeof ctx.get === 'function' ? ctx.get('fs') : undefined),
      ctx,
      { media: mediaService, config, onModeChange },
    );
    if (dispose !== undefined) boardDisposers.push(dispose);
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => dispose?.(), `short-drama-director storyboard command (${label})`);
    }
    return dispose;
  };

  // Prefer the registry already visible here; inject it only when it has not arrived yet.
  const commandsHere = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
  if (commandsHere !== undefined && commandsHere !== null) startStoryboardCommand(ctx, 'own context');
  else if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scope) => {
      startStoryboardCommand(scope, 'injected scope');
    });
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => disposeCommands?.(), 'short-drama-director commands');
  }

  // The first registration happens right here, synchronously, so the tool list the model
  // sees matches the stored mode from the moment the plugin is active. `storyboard` joins
  // on its own once `fs` arrives, inside the injection above.
  rebuildTools();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      while (toolDisposers.length > 0) {
        try {
          toolDisposers.pop()?.();
        } catch {
          // Teardown is best effort.
        }
      }
    }, 'short-drama-director tools');
  }

  log('short-drama-director: skills from', skillDir, '| user layer', customizationDir(process.env), '| ComfyUI default', config.comfyBaseUrl, '| /drama', disposeCommands === undefined ? 'unavailable' : 'registered', '| /storyboard registrations', boardDisposers.length, '| media route', mediaRouteDisposers.length, '| panel route', panelRouteDisposers.length);
}
