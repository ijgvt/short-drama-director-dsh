/**
 * Upgrade-safe user layer for the short-drama plugin.
 *
 * Workflow memories and skill customizations live under the DSH state directory,
 * never under this package. Replacing the plugin therefore cannot replace the
 * user's notes or rule additions. Unknown JSON fields and entries are preserved.
 *
 * @module dsh-plugin-short-drama-director/lib/workflow-memory
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { stateDir } from './state.js';
import { builtinWorkflowMemoryEntries } from './workflow-memory-seed.js';

export const WORKFLOW_MEMORY_SCHEMA_VERSION = 1;
export const USER_SKILL_RANK = 500;
export const WORKFLOW_MEMORY_STAGES = Object.freeze([
  'all',
  'workspace',
  'assets',
  'video-prompts',
  'h3',
  'storyboard',
  'comfyui',
  'delivery',
  'custom',
]);

const ACTIVE = 'active';
const DEPRECATED = 'deprecated';
const MAX_TITLE = 200;
const MAX_TEXT = 4000;
const MAX_ENTRIES = 200;
const MAX_PROMPT_BYTES = 12_000;
const MEMORY_FILE = 'workflow-memory.json';

let tempCounter = 0;
let mutationChain = Promise.resolve();

/** Serialize mutations in this Host process, so two tool calls cannot lose an entry. */
function serializeMutation(task) {
  const run = mutationChain.then(task, task);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/** The external user layer. This path is a function of DSH_HOME, not of the package. */
export function userLayerDir(env = process.env) {
  return join(stateDir(env), 'user-data');
}

export function workflowMemoryPath(env = process.env) {
  return join(userLayerDir(env), MEMORY_FILE);
}

export function customizationDir(env = process.env) {
  return join(userLayerDir(env), 'customizations');
}

export function skillAdditionsDir(env = process.env) {
  return join(customizationDir(env), 'skill-additions');
}

export function customSkillsDir(env = process.env) {
  return join(customizationDir(env), 'skills');
}

export function emptyWorkflowMemory() {
  return {
    schemaVersion: WORKFLOW_MEMORY_SCHEMA_VERSION,
    updatedAt: null,
    entries: [],
  };
}

export function seededWorkflowMemory() {
  return {
    ...emptyWorkflowMemory(),
    entries: builtinWorkflowMemoryEntries(),
  };
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function cleanText(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validSkillName(name) {
  return typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);
}

/** Keep the raw entry intact while exposing a validated, normalized view. */
export function normalizeWorkflowMemoryEntry(raw) {
  const record = asObject(raw);
  if (record === null) return null;
  const id = cleanText(record.id, 120);
  const title = cleanText(record.title, MAX_TITLE);
  const prevention = cleanText(record.prevention);
  if (id.length === 0 || title.length === 0 || prevention.length === 0) return null;
  const stage = WORKFLOW_MEMORY_STAGES.includes(record.stage) ? record.stage : 'all';
  const status = record.status === DEPRECATED ? DEPRECATED : ACTIVE;
  return {
    ...record,
    id,
    title,
    stage,
    symptom: cleanText(record.symptom),
    rootCause: cleanText(record.rootCause),
    prevention,
    applicability: cleanText(record.applicability),
    source: cleanText(record.source, 120) || 'agent',
    notes: cleanText(record.notes),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
    status,
    createdAt: cleanText(record.createdAt, 80) || null,
    updatedAt: cleanText(record.updatedAt, 80) || null,
  };
}

function normalizeStore(raw) {
  const record = asObject(raw);
  if (record === null) return emptyWorkflowMemory();
  return {
    ...record,
    schemaVersion: Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : WORKFLOW_MEMORY_SCHEMA_VERSION,
    updatedAt: cleanText(record.updatedAt, 80) || null,
    entries: Array.isArray(record.entries) ? record.entries : [],
  };
}

function validEntries(store) {
  const entries = [];
  const invalid = [];
  for (const raw of store.entries) {
    const entry = normalizeWorkflowMemoryEntry(raw);
    if (entry === null) invalid.push(raw);
    else entries.push(entry);
  }
  return { entries, invalid };
}

/**
 * Read the external memory store.
 *
 * A corrupt JSON file is copied to a timestamped quarantine before the caller can
 * replace it. If that copy cannot be made, mutation is refused rather than risking
 * permanent data loss. A future schema is likewise opened read-only.
 */
export async function readWorkflowMemory(env = process.env) {
  const path = workflowMemoryPath(env);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        store: seededWorkflowMemory(),
        path,
        existed: false,
        invalidCount: 0,
        readOnly: false,
        builtinSeeded: true,
      };
    }
    return {
      store: emptyWorkflowMemory(),
      path,
      existed: true,
      invalidCount: 0,
      readOnly: true,
      error: String(error?.message ?? error),
    };
  }

  try {
    const store = normalizeStore(JSON.parse(raw));
    const futureSchema = store.schemaVersion > WORKFLOW_MEMORY_SCHEMA_VERSION;
    const { invalid } = validEntries(store);
    return {
      store,
      path,
      existed: true,
      invalidCount: invalid.length,
      readOnly: futureSchema,
      ...futureSchema
        ? { error: `memory schema ${String(store.schemaVersion)} is newer than this plugin supports` }
        : {},
    };
  } catch (error) {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    let preserved = false;
    try {
      await copyFile(path, quarantine);
      preserved = true;
    } catch {
      // The write path refuses mutation when preserved remains false.
    }
    return {
      store: emptyWorkflowMemory(),
      path,
      existed: true,
      invalidCount: 0,
      readOnly: !preserved,
      quarantined: preserved ? quarantine : null,
      error: `cannot parse workflow memory: ${String(error?.message ?? error)}`,
    };
  }
}

async function writeWorkflowMemoryStore(store, path) {
  await mkdir(dirname(path), { recursive: true });
  tempCounter += 1;
  const temp = `${path}.${process.pid}.${tempCounter}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requireText(value, label, max = MAX_TEXT) {
  const text = cleanText(value, max);
  if (text.length === 0) throw new Error(`${label} 不能为空`);
  return text;
}

function requireStage(value) {
  const stage = cleanText(value, 40) || 'all';
  if (!WORKFLOW_MEMORY_STAGES.includes(stage)) {
    throw new Error(`未知流程阶段：${stage}；可用值：${WORKFLOW_MEMORY_STAGES.join(', ')}`);
  }
  return stage;
}

function ensureMutable(snapshot) {
  if (snapshot.readOnly) {
    throw new Error(
      `工作流记忆处于只读保护：${snapshot.error ?? snapshot.path}。`
      + '原文件未被覆盖；请先修复或备份该文件。',
    );
  }
}

function samePrevention(left, right) {
  return left.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
    === right.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/** Record one reusable, story-independent workflow pitfall. */
export async function rememberWorkflowMemory(input = {}, { env = process.env } = {}) {
  const title = requireText(input.title, 'title', MAX_TITLE);
  const stage = requireStage(input.stage);
  const prevention = requireText(input.prevention, 'prevention');
  const symptom = cleanText(input.symptom);
  const rootCause = cleanText(input.rootCause);

  return serializeMutation(async () => {
    const snapshot = await readWorkflowMemory(env);
    ensureMutable(snapshot);
    const store = snapshot.store;
    if (store.entries.length >= MAX_ENTRIES) {
      throw new Error(`工作流记忆已达到 ${String(MAX_ENTRIES)} 条上限；请先停用或删除不再适用的记录`);
    }
    const now = new Date().toISOString();
    const duplicateIndex = store.entries.findIndex((raw) => {
      const entry = normalizeWorkflowMemoryEntry(raw);
      return entry !== null
        && entry.status === ACTIVE
        && entry.stage === stage
        && entry.title === title
        && samePrevention(entry.prevention, prevention);
    });
    if (duplicateIndex >= 0) {
      const existing = normalizeWorkflowMemoryEntry(store.entries[duplicateIndex]);
      const confirmed = {
        ...existing,
        updatedAt: now,
        lastConfirmedAt: now,
        confirmationCount: Number.isInteger(existing.confirmationCount) ? existing.confirmationCount + 1 : 2,
      };
      store.entries[duplicateIndex] = confirmed;
      store.updatedAt = now;
      await writeWorkflowMemoryStore(store, snapshot.path);
      return { entry: confirmed, created: false, path: snapshot.path };
    }

    const entry = {
      id: `wf-${randomUUID()}`,
      title,
      stage,
      symptom,
      rootCause,
      prevention,
      applicability: cleanText(input.applicability) || '当前插件与工作流版本；升级后如有变化应复核',
      source: cleanText(input.source, 120) || 'agent',
      notes: cleanText(input.notes),
      tags: Array.isArray(input.tags)
        ? input.tags.map((tag) => cleanText(tag, 80)).filter((tag) => tag.length > 0).slice(0, 20)
        : [],
      status: ACTIVE,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: now,
      confirmationCount: 1,
    };
    store.entries.push(entry);
    store.schemaVersion = WORKFLOW_MEMORY_SCHEMA_VERSION;
    store.updatedAt = now;
    await writeWorkflowMemoryStore(store, snapshot.path);
    return { entry, created: true, path: snapshot.path };
  });
}

function findEntryIndex(store, id) {
  return store.entries.findIndex((raw) => {
    const entry = normalizeWorkflowMemoryEntry(raw);
    return entry?.id === id;
  });
}

/** Update one entry, preserving fields this version does not know about. */
export async function updateWorkflowMemory(id, patch = {}, { env = process.env } = {}) {
  const entryId = requireText(id, 'id', 120);
  return serializeMutation(async () => {
    const snapshot = await readWorkflowMemory(env);
    ensureMutable(snapshot);
    const index = findEntryIndex(snapshot.store, entryId);
    if (index < 0) throw new Error(`找不到工作流记忆：${entryId}`);
    const existing = normalizeWorkflowMemoryEntry(snapshot.store.entries[index]);
    const next = { ...existing };
    for (const key of ['title', 'symptom', 'rootCause', 'prevention', 'applicability', 'notes']) {
      if (patch[key] !== undefined) next[key] = cleanText(patch[key], key === 'title' ? MAX_TITLE : MAX_TEXT);
    }
    if (next.title.length === 0 || next.prevention.length === 0) {
      throw new Error('title 和 prevention 不能改成空值');
    }
    if (patch.stage !== undefined) next.stage = requireStage(patch.stage);
    if (patch.tags !== undefined) {
      next.tags = Array.isArray(patch.tags)
        ? patch.tags.map((tag) => cleanText(tag, 80)).filter((tag) => tag.length > 0).slice(0, 20)
        : [];
    }
    next.updatedAt = new Date().toISOString();
    snapshot.store.entries[index] = next;
    snapshot.store.updatedAt = next.updatedAt;
    await writeWorkflowMemoryStore(snapshot.store, snapshot.path);
    return { entry: next, path: snapshot.path };
  });
}

/** Stop applying an entry without deleting its history. */
export async function deprecateWorkflowMemory(id, { reason = '', env = process.env } = {}) {
  const entryId = requireText(id, 'id', 120);
  return serializeMutation(async () => {
    const snapshot = await readWorkflowMemory(env);
    ensureMutable(snapshot);
    const index = findEntryIndex(snapshot.store, entryId);
    if (index < 0) throw new Error(`找不到工作流记忆：${entryId}`);
    const existing = normalizeWorkflowMemoryEntry(snapshot.store.entries[index]);
    const now = new Date().toISOString();
    const next = {
      ...existing,
      status: DEPRECATED,
      updatedAt: now,
      deprecatedAt: now,
      deprecationReason: cleanText(reason),
    };
    snapshot.store.entries[index] = next;
    snapshot.store.updatedAt = now;
    await writeWorkflowMemoryStore(snapshot.store, snapshot.path);
    return { entry: next, path: snapshot.path };
  });
}

/** Delete only after explicit confirmation; normal forgetting should use deprecate. */
export async function forgetWorkflowMemory(id, { confirm = false, env = process.env } = {}) {
  const entryId = requireText(id, 'id', 120);
  if (confirm !== true) throw new Error('永久删除工作流记忆需要 confirm=true；通常应优先使用 deprecate 保留历史');
  return serializeMutation(async () => {
    const snapshot = await readWorkflowMemory(env);
    ensureMutable(snapshot);
    const index = findEntryIndex(snapshot.store, entryId);
    if (index < 0) throw new Error(`找不到工作流记忆：${entryId}`);
    const [removed] = snapshot.store.entries.splice(index, 1);
    snapshot.store.updatedAt = new Date().toISOString();
    await writeWorkflowMemoryStore(snapshot.store, snapshot.path);
    return { entry: normalizeWorkflowMemoryEntry(removed), path: snapshot.path };
  });
}

/** Filter active or historical entries without changing the store. */
export async function listWorkflowMemory({
  stage,
  query = '',
  status = ACTIVE,
  limit = 50,
  env = process.env,
} = {}) {
  const snapshot = await readWorkflowMemory(env);
  const { entries, invalid } = validEntries(snapshot.store);
  const needle = cleanText(query, 500).toLocaleLowerCase();
  const wantedStatus = status === 'all' || status === DEPRECATED ? status : ACTIVE;
  const wantedStage = typeof stage === 'string' && stage.length > 0 ? requireStage(stage) : null;
  const filtered = entries
    .filter((entry) => wantedStatus === 'all' || entry.status === wantedStatus)
    .filter((entry) => wantedStage === null || entry.stage === wantedStage || entry.stage === 'all')
    .filter((entry) => needle.length === 0 || JSON.stringify(entry).toLocaleLowerCase().includes(needle))
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    .slice(0, Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50)));
  return {
    ...snapshot,
    entries: filtered,
    total: entries.length,
    invalidCount: invalid.length,
  };
}

const SKILL_STAGES = new Map([
  ['short-drama-director', new Set(['all'])],
  ['drama-asset-inventory', new Set(['all', 'assets'])],
  ['drama-asset-prompts', new Set(['all', 'assets'])],
  ['drama-asset-production', new Set(['all', 'assets', 'comfyui'])],
  ['costume-and-quadview', new Set(['all', 'assets', 'comfyui'])],
  ['drama-episode-video-prompts', new Set(['all', 'video-prompts'])],
  ['h3-prompt-converter', new Set(['all', 'h3'])],
  ['h3-prompt-writing', new Set(['all', 'h3'])],
  ['drama-h3-video', new Set(['all', 'h3', 'comfyui'])],
  ['comfy-general', new Set(['all', 'comfyui'])],
  ['comfyui-deploy', new Set(['all', 'comfyui'])],
  ['qwen-image-2-1-prompter', new Set(['all', 'assets'])],
]);

export function workflowMemoryMatchesSkill(entry, skillName) {
  if (entry.status !== ACTIVE) return false;
  if (Array.isArray(entry.skills) && entry.skills.includes(skillName)) return true;
  const stages = SKILL_STAGES.get(skillName) ?? new Set(['all']);
  return stages.has(entry.stage);
}

/** Render only the highest-value active rules for a skill prompt. */
export function formatWorkflowMemoryEntries(entries, { maxBytes = MAX_PROMPT_BYTES } = {}) {
  const blocks = [];
  let bytes = 0;
  let omitted = 0;
  for (const entry of entries) {
    const block = [
      `- [${entry.stage}] ${entry.title}`,
      entry.symptom.length > 0 ? `  症状：${entry.symptom}` : '',
      entry.rootCause.length > 0 ? `  根因：${entry.rootCause}` : '',
      `  防止：${entry.prevention}`,
      entry.applicability.length > 0 ? `  适用：${entry.applicability}` : '',
    ].filter((line) => line.length > 0).join('\n');
    const size = Buffer.byteLength(`${block}\n`, 'utf8');
    if (bytes + size > maxBytes) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    bytes += size;
  }
  return { text: blocks.join('\n'), omitted, bytes };
}

/** Read one external skill-additions markdown file, if present. */
export async function readUserSkillAddition(skillName, env = process.env) {
  if (!validSkillName(skillName)) return { content: '', path: null, found: false };
  const path = join(skillAdditionsDir(env), `${skillName}.md`);
  try {
    const content = await readFile(path, 'utf8');
    return { content: content.trim(), path, found: content.trim().length > 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: '', path, found: false };
    return { content: '', path, found: false, error: String(error?.message ?? error) };
  }
}

/**
 * Append external rules and relevant memories to a skill actually loaded by the model.
 * User additions are always visible on read, so editing them needs no plugin rebuild.
 */
export async function appendUserLayerToSkill(content, {
  skillName,
  env = process.env,
  includeWorkflowMemory = true,
} = {}) {
  const name = validSkillName(skillName) ? skillName : 'custom';
  let snapshot;
  let addition;
  try {
    snapshot = await readWorkflowMemory(env);
    addition = await readUserSkillAddition(name, env);
  } catch (error) {
    // A machine without a resolvable state directory must still get packaged skills.
    // The failure is stated in the skill rather than silently discarding customization.
    return `${content.trimEnd()}\n\n<!-- BEGIN short-drama user layer unavailable -->\n## 用户定制层不可用\n\n${String(error?.message ?? error)}\n\n内置技能仍可使用；请先设置 DSH_HOME、USERPROFILE 或 HOME。\n<!-- END short-drama user layer unavailable -->\n`;
  }
  const { entries } = validEntries(snapshot.store);
  const relevant = includeWorkflowMemory
    ? entries
      .filter((entry) => workflowMemoryMatchesSkill(entry, name))
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    : [];
  const rendered = formatWorkflowMemoryEntries(relevant);
  if (!includeWorkflowMemory && !addition.found && addition.error === undefined) return content;

  const sections = [
    '<!-- BEGIN short-drama user layer (external; preserved across plugin upgrades) -->',
    includeWorkflowMemory ? '## 用户流程记忆与定制' : '## 用户技能定制',
    '以下内容来自插件包外的用户数据。用户明确写下的定制规则优先于普通内置流程偏好；但数据完整性、提交前校验、沙箱权限等安全硬约束仍然优先。',
  ];

  if (includeWorkflowMemory) {
    sections.push('遇到可复用的制作流程踩坑时，在完成当前任务后调用 `workflow_memory action=remember`。只记录与剧本无关的工具、参数、路径发现、提交、同步、归档流程；不要把剧情、角色台词或项目专属正文写进长期记忆。');
  }

  if (includeWorkflowMemory && snapshot.error !== undefined) {
    sections.push(`> 工作流记忆读取异常：${snapshot.error}\n> 文件：${snapshot.path}\n> 不要覆盖或重建它；先保留原文件并告诉用户检查。`);
  } else if (includeWorkflowMemory && rendered.text.length > 0) {
    sections.push(`### 已生效的流程经验\n${rendered.text}`);
    if (rendered.omitted > 0) {
      sections.push(`还有 ${String(rendered.omitted)} 条适用经验未全部注入；需要时调用 \`workflow_memory action=recall\` 查看。`);
    }
  }
  if (addition.found) {
    sections.push(`### 用户追加到 ${name} 的规则\n来源：${addition.path}\n\n${addition.content}`);
  }
  if (addition.error !== undefined) {
    sections.push(`> 用户追加规则读取失败：${addition.error}\n> 文件：${addition.path}`);
  }
  sections.push(includeWorkflowMemory
    ? `工作流记忆文件：${snapshot.path}\n用户定制目录：${customizationDir(env)}`
    : `用户定制目录：${customizationDir(env)}`);
  sections.push('<!-- END short-drama user layer -->');
  return `${content.trimEnd()}\n\n${sections.join('\n\n')}\n`;
}

function parseSkillFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (match === null) throw new Error('SKILL.md has no YAML frontmatter');
  const block = match[1];
  const read = (key) => {
    const line = new RegExp(`^${key}:[ \t]*(.*)$`, 'mu').exec(block);
    if (line === null) return undefined;
    const value = line[1].trim();
    return value.length === 0 ? undefined : value.replace(/^['"]|['"]$/gu, '');
  };
  const name = read('name');
  const description = read('description');
  if (!validSkillName(name) || description === undefined) {
    throw new Error('SKILL.md needs a valid kebab-case name and a description');
  }
  return { name, description, whenToUse: read('whenToUse') };
}

/** Discover user-added skills from the external customizations directory. */
export async function discoverUserSkills(env = process.env, { onWarning } = {}) {
  const root = customSkillsDir(env);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const locator = join(directory, 'SKILL.md');
    try {
      if (!(await stat(locator)).isFile()) continue;
      const raw = await readFile(locator, 'utf8');
      const parsed = parseSkillFrontmatter(raw);
      found.push({
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'short-drama-director',
        source: 'user',
        rank: USER_SKILL_RANK,
        locator,
        directory,
        resourceBase: { kind: 'directory', path: directory },
      });
    } catch (error) {
      onWarning?.(`short-drama-director: cannot read user skill ${locator}: ${String(error?.message ?? error)}`);
    }
  }
  return found;
}

const USER_LAYER_README = `# 短剧插件用户层

这个目录位于插件包外，升级或重装 \`short-drama-director-v2\` 时不会被替换。

## 流程记忆

- \`workflow-memory.json\`：由 \`workflow_memory\` 工具维护，也可以手工编辑。
- 只放与剧本无关的制作流程经验：工具行为、参数、路径发现、提交、同步、归档。
- 不要放剧情、台词、角色设定、项目资产清单或只对某一集有效的临时内容。

## 模型辅助工作流适配

- \`workflow-adapters.json\`：未知但结构可用的通用工作流，由当前会话模型生成语义绑定表，经代码校验后保存在这里。
- 只记录节点 ID 与输入名的绑定，不保存提示词、剧本、媒体文件或项目正文。
- 工作流内容或实例节点能力变化后，旧适配会自动失效；删除该文件即可让模型重新适配。

## 技能定制

- \`customizations/skill-additions/<技能名>.md\`：追加到同名内置技能末尾。建议用这个文件做小改动。
- \`customizations/skills/<目录>/SKILL.md\`：新增独立技能；不会覆盖内置技能。
- 内置技能升级后，追加规则仍在；如果上游改了同名规则，请重新检查冲突。

所有路径都按当前机器的 \`DSH_HOME\` 计算，不依赖插件包位置或固定盘符。
`;

/** Create the external scaffolding once; never overwrite an existing README. */
export async function ensureUserLayer(env = process.env) {
  const root = userLayerDir(env);
  await Promise.all([
    mkdir(skillAdditionsDir(env), { recursive: true }),
    mkdir(customSkillsDir(env), { recursive: true }),
  ]);
  const readme = join(root, 'README.md');
  try {
    await writeFile(readme, USER_LAYER_README, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const memoryPath = workflowMemoryPath(env);
  try {
    await writeFile(memoryPath, `${JSON.stringify(seededWorkflowMemory(), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return {
    root,
    memoryPath,
    readme,
    customizationRoot: customizationDir(env),
    skillAdditions: skillAdditionsDir(env),
    customSkills: customSkillsDir(env),
  };
}

function renderEntries(entries) {
  if (entries.length === 0) return '没有匹配的流程记忆';
  return entries.map((entry) => {
    const state = entry.status === ACTIVE ? '生效' : '已停用';
    return `[${state}] ${entry.title}\n  阶段：${entry.stage}\n  防止：${entry.prevention}`;
  }).join('\n');
}

/**
 * The model-facing tool. Its fields intentionally contain no script/project slot:
 * workflow memory is a process rule store, not another storyboard document.
 */
export function workflowMemoryTool(config = {}) {
  const env = config.env ?? process.env;
  return defineTool({
    name: 'workflow_memory',
    description: 'Record and recall reusable short-drama PRODUCTION WORKFLOW knowledge that is independent of any script: tool behavior, parameters, path discovery, validation, submission, synchronization and delivery pitfalls. Never store plot, dialogue, character lore, shot prose or a project-specific asset list. Memories and user skill additions live outside the plugin package and survive upgrades. Relevant active memories are injected into loaded drama skills; use recall when more are needed. Use deprecate to stop applying an obsolete rule, and forget only after explicit user confirmation.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'remember', 'list', 'recall', 'update', 'deprecate', 'forget'],
        description: 'status shows the external memory/customization paths; remember adds one reusable workflow pitfall; list/recall reads matching rules; update edits one rule; deprecate keeps history but stops injection; forget permanently deletes only with confirm=true.',
      },
      id: { type: 'string', description: 'Memory id for update, deprecate or forget.' },
      title: { type: 'string', description: 'Short, reusable title of the workflow pitfall; no script names.' },
      stage: {
        type: 'string',
        enum: [...WORKFLOW_MEMORY_STAGES],
        description: 'Pipeline stage this rule applies to. Use all only for a rule relevant to every stage.',
      },
      symptom: { type: 'string', description: 'What the user or operator observes when the pitfall happens.' },
      rootCause: { type: 'string', description: 'Verified technical or procedural cause. Do not guess.' },
      prevention: { type: 'string', description: 'Concrete action that avoids the pitfall next time.' },
      applicability: { type: 'string', description: 'Tool/workflow/version range where this was observed and should apply.' },
      notes: { type: 'string', description: 'Optional process-only note or evidence.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional process tags such as h3, autosave, paths.' },
      query: { type: 'string', description: 'For list/recall: case-insensitive text filter.' },
      status: {
        type: 'string',
        enum: ['active', 'deprecated', 'all'],
        description: 'For list/recall. Defaults to active.',
      },
      limit: { type: 'integer', description: 'For list/recall: 1-100 results, default 50.' },
      reason: { type: 'string', description: 'For deprecate: why the rule no longer applies.' },
      confirm: { type: 'boolean', description: 'For forget only: true means the user explicitly approved permanent deletion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
          memoryPath: { type: 'string', required: true },
          customizationRoot: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          entries: { type: 'json', required: true },
          entry: { type: 'json' },
          created: { type: 'boolean' },
          formatted: { type: 'string' },
          paths: { type: 'json' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const common = {
        memoryPath: workflowMemoryPath(env),
        customizationRoot: customizationDir(env),
        entries: [],
        count: 0,
      };
      switch (args.action) {
        case 'status': {
          const paths = await ensureUserLayer(env);
          const snapshot = await readWorkflowMemory(env);
          const { entries, invalid } = validEntries(snapshot.store);
          const warning = snapshot.error === undefined ? '' : `\n读取警告：${snapshot.error}`;
          const invalidNote = invalid.length > 0 ? `\n另有 ${String(invalid.length)} 条格式无效记录，原文件保留未改。` : '';
          return {
            ...common,
            action: args.action,
            message: `工作流记忆 ${String(entries.length)} 条，生效 ${String(entries.filter((entry) => entry.status === ACTIVE).length)} 条。\n记忆文件：${snapshot.path}\n用户定制：${paths.customizationRoot}\n追加技能规则：${paths.skillAdditions}\n用户新增技能：${paths.customSkills}${warning}${invalidNote}`,
            paths,
            entries,
            count: entries.length,
            warnings: invalid.length > 0 ? [`${String(invalid.length)} 条记录格式无效，未从文件中删除`] : [],
          };
        }
        case 'remember': {
          await ensureUserLayer(env);
          const result = await rememberWorkflowMemory(args, { env });
          return {
            ...common,
            action: args.action,
            message: result.created ? `已记录流程记忆：${result.entry.title}` : `已有相同流程记忆，已确认一次：${result.entry.title}`,
            entries: [result.entry],
            entry: result.entry,
            created: result.created,
            count: 1,
          };
        }
        case 'list':
        case 'recall': {
          const result = await listWorkflowMemory({
            stage: args.stage,
            query: args.query,
            status: args.status,
            limit: args.limit,
            env,
          });
          const formatted = renderEntries(result.entries);
          return {
            ...common,
            action: args.action,
            message: result.error === undefined ? formatted : `${formatted}\n\n读取警告：${result.error}`,
            entries: result.entries,
            count: result.entries.length,
            formatted,
            warnings: result.invalidCount > 0 ? [`${String(result.invalidCount)} 条记录格式无效，未从文件中删除`] : [],
          };
        }
        case 'update': {
          const result = await updateWorkflowMemory(requireText(args.id, 'id', 120), args, { env });
          return {
            ...common,
            action: args.action,
            message: `已更新流程记忆：${result.entry.title}`,
            entries: [result.entry],
            entry: result.entry,
            count: 1,
          };
        }
        case 'deprecate': {
          const result = await deprecateWorkflowMemory(requireText(args.id, 'id', 120), { reason: args.reason, env });
          return {
            ...common,
            action: args.action,
            message: `已停用流程记忆（历史保留）：${result.entry.title}`,
            entries: [result.entry],
            entry: result.entry,
            count: 1,
          };
        }
        case 'forget': {
          const result = await forgetWorkflowMemory(requireText(args.id, 'id', 120), { confirm: args.confirm === true, env });
          return {
            ...common,
            action: args.action,
            message: `已永久删除流程记忆：${result.entry?.title ?? args.id}`,
            entries: result.entry === null ? [] : [result.entry],
            ...result.entry === null ? {} : { entry: result.entry },
            count: result.entry === null ? 0 : 1,
          };
        }
        default:
          throw new Error(`未知 action：${String(args.action)}`);
      }
    },
  });
}

export const WORKFLOW_MEMORY_MAX_PROMPT_BYTES = MAX_PROMPT_BYTES;
