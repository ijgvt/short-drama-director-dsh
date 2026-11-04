/**
 * Human commands for the plugin.
 *
 * A command is the strongest form of "the user pressed something": it is typed
 * and submitted by the person, it cannot be produced by the model, and its
 * lifecycle is logged. That makes `/drama` the honest gate for entering
 * short-drama mode - the tool `drama_mode` still exists so the model can record
 * what the user already asked for, but the mode is the user's to switch.
 *
 * @module dsh-plugin-short-drama-director/lib/commands
 */

import { readState, updateState } from './state.js';
import { describeMode } from './mode.js';
import { designRoot } from './design-root.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The project folders that actually exist on disk.
 *
 * The command's option list used `state.projects`, which is only the plugin's own registry - one stale entry
 * from an earlier session listed ONE project while the design root held five, and the "marked" one was a
 * test path nobody was working on. The disk is the truth, so the list is read from disk: a folder under the
 * design root that contains `剧集` is a project. `state.projects` is merged in only for entries the scan
 * cannot see (a project that was moved, or a root outside the design root).
 */
async function listProjectFolders(known) {
  // `designRoot()` answers `{ root, drive, source }`, not a bare string.
  const root = designRoot()?.root;
  const found = new Map();
  if (typeof root === 'string' && root.length > 0) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const folder = join(root, entry.name);
        try {
          const episode = await stat(join(folder, '剧集'));
          if (episode.isDirectory()) found.set(folder, entry.name);
        } catch { /* not a project folder */ }
      }
    } catch { /* design root missing: fall through to the registry */ }
  }
  // Merge the registry in only when the DESIGN ROOT does not already have a project of that name.
  //
  // Without this the list showed `v48回归新剧` twice: once from disk, once from a stale registry entry under
  // `D:\Temp\...` that nobody was working on - and the stale one was the "marked" project, which is exactly
  // the confusing thing the user reported. Disk wins on a name collision.
  const names = new Set([...found.values()]);
  for (const entry of known) {
    if (typeof entry.root !== 'string') continue;
    const label = entry.name ?? entry.root;
    if (names.has(label) || found.has(entry.root)) continue;
    found.set(entry.root, label);
    names.add(label);
  }
  return [...found.entries()].map(([path, name]) => ({ name, root: path })).sort((left, right) => left.name.localeCompare(right.name, 'zh'));
}

/**
 * The message `/drama on` returns: the project choice, or "start a new one".
 *
 * A command carries no session id (`{ name, rawInput }`), so it cannot start a model turn; the question is
 * therefore part of this result rather than something the model is asked to produce afterwards.
 */
async function dramaEntryText() {
  const { state } = await readState();
  const projects = await listProjectFolders(state.projects ?? []);
  if (projects.length === 0) {
    return `已进入${describeMode('drama')}。\n\n这台机器上还没有短剧项目，我们从**新项目**开始：把剧本发我（或告诉我剧本路径），我先做资产盘点。`;
  }
  const active = typeof state.activeProject === 'string' ? projects.find((entry) => entry.root === state.activeProject) : undefined;
  return [
    `已进入${describeMode('drama')}。`,
    active === undefined ? '' : `当前标记的项目：${active.name}（${active.root}）`,
    '',
    `这台机器上有 ${projects.length} 个短剧项目，请选一个：`,
    '',
    ...projects.map((entry, index) => `${index + 1}. ${entry.name}　（${entry.root}）`),
    '',
    `${projects.length + 1}. 新建一个项目`,
    '',
    '回复序号即可（例如「2」），也可以直接说"继续 XXX"或"新建"。',
  ].filter((line) => line !== '').join('\n');
}

function describeDirectorContext(context) {
  if (context === null || context === undefined || !Number.isInteger(context.episodeNumber)) return '';
  const source = context.sourceId === 'h3-zh'
    ? 'H3'
    : context.sourceId === 'h3-en' ? 'H3 英文（旧文件）' : context.sourceId === 'video' ? '视频提示词' : (context.sourceId ?? '未指定来源');
  const shot = typeof context.shotId === 'string' && context.shotId.length > 0 ? ' · 已定位镜头' : '';
  return `第${context.episodeNumber}集 · ${source}${shot}`;
}

/**
 * Build the `/drama` definition bound to this plugin's config.
 *
 * @param onModeChange - awaited after the mode actually changes, so the plugin can
 *   rebuild what it exposes before the command reports success. Awaited rather than
 *   fired and forgotten: reporting "已进入短剧模式" while the drama tools are still
 *   absent would be a lie the user acts on.
 */
function dramaCommand(onModeChange) {
  return {
    name: 'drama',
    description: '切换短剧模式：不进这个模式时，本 agent 就是一个通用 ComfyUI 助手（生图/生视频/改图）',
    input: { hint: '[on|off|status]（省略则切换）' },
    recordInput: true,
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim().toLowerCase();
      /**
       * Leave a trace on EVERY invocation, before any branch.
       *
       * "发了 /drama on 没有反应" cannot be diagnosed from the outside: the command may not have reached the
       * Host at all (typed into the wrong box, client without the command), or it may have reached it and
       * returned early. `state.json` had not been written for seven minutes while the process was newer than
       * the code, which is consistent with "never arrived" - so this records arrival itself: mtime of the
       * state file becomes the proof that the handler ran, and `lastDramaCommandRaw` shows what it received.
       */
      try {
        await updateState((current) => {
          current.lastDramaCommandAt = new Date().toISOString();
          current.lastDramaCommandRaw = String(invocation.rawInput ?? '');
          return current;
        });
      } catch { /* a trace that fails must never break the command */ }
      const { state, path } = await readState();
      const project = state.activeProject === null || state.activeProject === undefined
        ? null
        : state.projects.find((entry) => entry.root === state.activeProject) ?? null;

      if (raw === 'status') {
        const context = describeDirectorContext(state.activeContext);
        return {
          kind: 'success',
          text: state.mode === 'drama'
            ? `当前：短剧模式（项目：${project?.name ?? state.activeProject ?? '未指定'}${context.length > 0 ? `；${context}` : ''}）`
            : '当前：通用模式（生图 / 生视频 / 改图）。要做短剧就发 `/drama on`。',
        };
      }

      let next;
      if (raw === 'on' || raw === 'enter' || raw === '开' || raw === '进入') next = 'drama';
      else if (raw === 'off' || raw === 'exit' || raw === '关' || raw === '退出') next = 'general';
      else if (raw.length === 0) next = state.mode === 'drama' ? 'general' : 'drama';
      else {
        return { kind: 'error', text: `看不懂 "${raw}"。用 /drama on、/drama off 或 /drama status。` };
      }

      if (next === state.mode) {
        /**
         * `/drama on` while already in drama mode STILL shows the project choice.
         *
         * Returning 「已经是短剧模式了」 here was the bug behind "输入指令没有反应": the most common way to
         * arrive is to type `/drama on` when the mode was already stored (a previous session, or a restart),
         * and that path produced one line and no question. The mode was never the interesting part - which
         * project to work on is.
         */
        if (next === 'drama') return { kind: 'success', text: await dramaEntryText() };
        return { kind: 'success', text: '已经是通用模式了。' };
      }

      await updateState((current) => {
        current.mode = next;
        return current;
      });

      // The switch is only real once what the model can reach has changed with it.
      // A failing rebuild is reported instead of swallowed: the user asked for a mode,
      // and telling them it is on while the tools are missing would be worse than an error.
      let rebuildNote = '';
      if (typeof onModeChange === 'function') {
        try {
          await onModeChange(next);
        } catch (error) {
          rebuildNote = `\n\u26a0\ufe0f 切换已写入，但重新装配工具/技能时出错：${String(error?.message ?? error)}`;
        }
      }

      if (next === 'drama') {
        // The list is read from DISK (see `dramaEntryText`): the registry alone listed one stale test project
        // while the design root held five, which is exactly what the user saw.
        return { kind: 'success', text: `${await dramaEntryText()}${rebuildNote}` };
      }
      return {
        kind: 'success',
        text: `已回到${describeMode('general')}：生图 / 生视频 / 改图。\n短剧专用工具（\`drama_workspace\`、\`storyboard\`）与短剧技能已收起，项目文件都没动，随时可以再进来。${rebuildNote}`,
      };
    },
  };
}

/**
 * Register the plugin's commands.
 *
 * @param ctx - a context carrying the optional `commands` service.
 * @param onModeChange - called after `/drama` changes the stored mode.
 * @returns a disposer, or undefined when this deployment has no command registry.
 */
export function registerCommands(ctx, onModeChange) {
  // `ctx.get` is the documented optional-service accessor. Guard it so a context
  // that only carries the services this plugin hard-depends on still activates.
  if (typeof ctx.get !== 'function') return undefined;
  const commands = ctx.get('commands');
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return undefined;
  return commands.register(dramaCommand(onModeChange));
}
