/**
 * Prompt documents for the 剧本 → 视频提示词 step.
 *
 * The general built-in version ships as a skill reference. Professional and user-authored
 * versions are uploaded into `%DSH_HOME%/short-drama/prompt-sources/` so the selected document
 * survives plugin upgrades and can be handed to the model as an ordinary text file.
 *
 * The selection is global, not project data: changing it affects the next episode
 * generated in every project. The skill provider appends the selected file to the
 * `drama-episode-video-prompts` skill, so the model cannot fall back to the old
 * "ask which version" instruction.
 *
 * @module dsh-plugin-short-drama-director/lib/prompt-sources
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from '../vendor/adm-zip/adm-zip.js';
import { readState, stateDir, updateState } from './state.js';

export const DEFAULT_PROMPT_SOURCE_ID = 'builtin-general';

export const BUILTIN_PROMPT_SOURCES = Object.freeze([
  {
    id: DEFAULT_PROMPT_SOURCE_ID,
    label: '通用小白版',
    relativePath: 'drama-episode-video-prompts/references/PROMPT-通用小白版.md',
    description: '默认版本，结构稳妥、易读，适合大多数短剧。',
  },
]);

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);
const WORD_EXTENSIONS = new Set(['.docx', '.docm']);
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS = 1_000_000;

export function bundledSkillDir() {
  return fileURLToPath(new URL('../skills/', import.meta.url));
}

function resolvedSkillDir(skillDir) {
  return typeof skillDir === 'string' && skillDir.trim().length > 0
    ? resolve(skillDir.trim())
    : bundledSkillDir();
}

export function promptSourcesDir(env = process.env) {
  return join(stateDir(env), 'prompt-sources');
}

async function fileInfo(file) {
  try {
    const info = await stat(file);
    return info.isFile()
      ? { exists: true, size: info.size, updatedAt: info.mtime.toISOString() }
      : { exists: false, size: 0, updatedAt: null };
  } catch {
    return { exists: false, size: 0, updatedAt: null };
  }
}

function storedCustomEntries(state) {
  const rows = state?.generation?.promptSources?.custom;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((entry) => entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string' && entry.id.startsWith('custom-')
      && typeof entry.file === 'string' && entry.file.length > 0)
    .map((entry) => ({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : '自定义提示词',
      originalName: typeof entry.originalName === 'string' && entry.originalName.length > 0
        ? entry.originalName
        : basename(entry.file),
      file: entry.file,
      characters: Number.isInteger(entry.characters) ? entry.characters : null,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
    }));
}

function storedSelectedId(state) {
  const selected = state?.generation?.promptSources?.selected;
  return typeof selected === 'string' && selected.length > 0 ? selected : DEFAULT_PROMPT_SOURCE_ID;
}

/**
 * Resolve built-in and uploaded prompt documents and the current selection.
 *
 * A missing custom file is reported rather than silently replaced, because the user
 * may have moved the document and needs to know why the next episode changed.
 */
export async function readPromptSourceConfiguration({ skillDir, env = process.env } = {}) {
  const { state } = await readState(env);
  const directory = resolvedSkillDir(skillDir);
  const builtin = await Promise.all(BUILTIN_PROMPT_SOURCES.map(async (definition) => {
    const file = join(directory, ...definition.relativePath.split('/'));
    return {
      id: definition.id,
      label: definition.label,
      kind: 'builtin',
      description: definition.description,
      deletable: false,
      file,
      ...await fileInfo(file),
    };
  }));
  const custom = await Promise.all(storedCustomEntries(state).map(async (entry) => ({
    ...entry,
    kind: 'custom',
    description: `用户上传：${entry.originalName}`,
    deletable: true,
    ...await fileInfo(entry.file),
  })));
  const options = [...builtin, ...custom];
  const fallback = options.find((entry) => entry.id === DEFAULT_PROMPT_SOURCE_ID) ?? options[0] ?? null;
  const configured = storedSelectedId(state);
  const selected = options.find((entry) => entry.id === configured) ?? null;
  const selectedSource = selected ?? fallback;
  const error = selected === null
    ? `全局配置保存的提示词已不存在，暂按「${fallback?.label ?? '默认版本'}」显示`
    : selected.exists !== true
      ? `所选提示词文件不存在：${selected.label}`
      : selected.size === 0
        ? `所选提示词文件是空的：${selected.label}`
        : null;
  return {
    selected: selectedSource?.id ?? null,
    selectedLabel: selectedSource?.label ?? null,
    configured,
    selectedSource,
    defaultId: DEFAULT_PROMPT_SOURCE_ID,
    directory: promptSourcesDir(env),
    options,
    builtin,
    custom,
    error,
  };
}

/** Reject a save that names a prompt that is not installed or whose file vanished. */
export async function validatePromptSelection(selected, { skillDir, env = process.env } = {}) {
  const config = await readPromptSourceConfiguration({ skillDir, env });
  const wanted = typeof selected === 'string' && selected.length > 0 ? selected : config.selected;
  const option = config.options.find((entry) => entry.id === wanted);
  if (option === undefined || option === null) throw new Error('未找到所选的剧本转视频提示词');
  if (option.exists !== true) throw new Error(`所选提示词文件不存在：${option.label}`);
  if (option.size === 0) throw new Error(`所选提示词文件是空的：${option.label}`);
  return option;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00A0/gu, ' ')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, name) => {
    const lower = String(name).toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
  });
}

function decodeTextBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  // Windows users often save a Chinese txt as ANSI/GBK. Node/Electron with full ICU
  // can decode it; when that decoder is unavailable, keep the UTF-8 result instead
  // of failing an otherwise readable upload.
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return utf8;
  }
}

function extractWordText(bytes) {
  let zip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new Error('Word 文档无法解析，请确认文件没有损坏');
  }
  const entry = zip.getEntry('word/document.xml');
  if (entry === null || entry === undefined) throw new Error('Word 文档缺少正文，无法提取提示词');
  const xml = entry.getData().toString('utf8');
  const withBreaks = xml
    .replace(/<w:tab[^>]*\/>/giu, '\t')
    .replace(/<w:(?:br|cr)[^>]*\/>/giu, '\n')
    .replace(/<\/w:p>/giu, '\n')
    .replace(/<\/w:tr>/giu, '\n')
    .replace(/<\/w:tc>/giu, '\t')
    .replace(/<[^>]*>/gu, '');
  return normalizeText(decodeXmlEntities(withBreaks));
}

/**
 * Extract plain text from the document types a prompt author is likely to use.
 * The browser sends base64 so the same action works through the private route and
 * the command fallback without asking the Host to open an arbitrary path.
 */
export function extractPromptDocument({ fileName = '', fileDataBase64, text } = {}) {
  if (typeof text === 'string' && text.trim().length > 0) {
    const content = normalizeText(text);
    if (content.length > MAX_PROMPT_CHARACTERS) throw new Error('提示词文档过长（上限 100 万字）');
    return content;
  }
  if (typeof fileDataBase64 !== 'string' || fileDataBase64.length === 0) throw new Error('请选择提示词文档');
  const encoded = fileDataBase64.replace(/^data:[^,]*,/u, '').trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error('提示词文档数据无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new Error('提示词文档是空的');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('提示词文档不能超过 4 MB');
  const extension = extname(String(fileName ?? '')).toLowerCase();
  let content;
  if (TEXT_EXTENSIONS.has(extension)) content = decodeTextBytes(bytes);
  else if (WORD_EXTENSIONS.has(extension)) content = extractWordText(bytes);
  else if (extension === '.doc') throw new Error('旧版 .doc 无法直接读取，请在 Word 中另存为 .docx 或 .txt 后上传');
  else throw new Error('提示词文档仅支持 .txt、.md、.docx');
  content = normalizeText(content);
  if (content.length === 0) throw new Error('没有从文档中读到文字');
  if (content.length > MAX_PROMPT_CHARACTERS) throw new Error('提示词文档过长（上限 100 万字）');
  return content;
}

function promptLabel(fileName) {
  const normalized = String(fileName ?? '').replace(/\\/gu, '/');
  const original = basename(normalized);
  const extension = extname(original);
  const stem = extension.length === 0 ? original : original.slice(0, -extension.length);
  return stem.trim().slice(0, 80) || '自定义提示词';
}

/** Store an uploaded document and make it the selected prompt for the next episode. */
export async function savePromptSourceUpload({
  fileName,
  fileDataBase64,
  text,
  skillDir,
  env = process.env,
} = {}) {
  const content = extractPromptDocument({ fileName, fileDataBase64, text });
  const normalizedName = String(fileName ?? '自定义提示词.md').replace(/\\/gu, '/');
  const originalName = basename(normalizedName) || '自定义提示词.md';
  const id = `custom-${randomUUID()}`;
  const directory = promptSourcesDir(env);
  const file = join(directory, `${id}.md`);
  const temp = join(directory, `${id}.${process.pid}.${Date.now()}.tmp`);
  const entry = {
    id,
    label: promptLabel(originalName),
    originalName,
    file,
    characters: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temp, `${content}\n`, 'utf8');
    await rename(temp, file);
    await updateState((next) => {
      const current = next.generation?.promptSources ?? {};
      const custom = Array.isArray(current.custom) ? current.custom : [];
      next.generation = {
        ...(next.generation ?? {}),
        promptSources: { ...current, selected: id, custom: [...custom, entry] },
      };
      return next;
    }, env);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    entry,
    config: await readPromptSourceConfiguration({ skillDir, env }),
  };
}

/** Remove an uploaded prompt. Built-ins are immutable and refuse the operation. */
export async function deletePromptSource(id, { skillDir, env = process.env } = {}) {
  if (typeof id !== 'string' || !id.startsWith('custom-')) throw new Error('内置提示词不能删除');
  const { state } = await readState(env);
  const entry = storedCustomEntries(state).find((row) => row.id === id) ?? null;
  if (entry === null) {
    return {
      deleted: false,
      config: await readPromptSourceConfiguration({ skillDir, env }),
    };
  }
  const base = resolve(promptSourcesDir(env));
  const target = resolve(entry.file);
  const rel = relative(base, target);
  const insideStorage = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  await updateState((next) => {
    const current = next.generation?.promptSources ?? {};
    const custom = (Array.isArray(current.custom) ? current.custom : []).filter((row) => row?.id !== id);
    const selected = current.selected === id ? DEFAULT_PROMPT_SOURCE_ID : (current.selected ?? DEFAULT_PROMPT_SOURCE_ID);
    next.generation = {
      ...(next.generation ?? {}),
      promptSources: { ...current, selected, custom },
    };
    return next;
  }, env);
  if (insideStorage) await rm(target, { force: true }).catch(() => undefined);
  return {
    deleted: true,
    config: await readPromptSourceConfiguration({ skillDir, env }),
  };
}

/** Persist the prompt version this project will use for the next 剧本 → 视频提示词 pass. */
export async function selectPromptSource(id, { skillDir, env = process.env } = {}) {
  const option = await validatePromptSelection(id, { skillDir, env });
  await updateState((next) => {
    const current = next.generation?.promptSources ?? {};
    next.generation = {
      ...(next.generation ?? {}),
      promptSources: { ...current, selected: option.id },
    };
    return next;
  }, env);
  return {
    selected: option.id,
    label: option.label,
    file: option.file,
    config: await readPromptSourceConfiguration({ skillDir, env }),
  };
}

/**
 * The instruction appended to the `drama-episode-video-prompts` skill.
 *
 * The model must see this before it decides which reference to read. It names the
 * exact file and says the global choice wins over the version table in the skill.
 */
export async function promptSourceForSkill({ skillDir, env = process.env } = {}) {
  const config = await readPromptSourceConfiguration({ skillDir, env });
  const selected = config.selectedSource;
  const fallback = config.options.find((entry) => entry.id === DEFAULT_PROMPT_SOURCE_ID) ?? null;
  const usable = selected?.exists === true && selected.size > 0
    ? selected
    : (fallback?.exists === true && fallback.size > 0 ? fallback : null);
  if (usable === null) {
    return {
      ...config,
      option: null,
      instruction: [
        '## 全局配置：剧本转视频提示词',
        '',
        '全局配置的提示词文件当前不可用。',
        '在开始写视频提示词前，先提醒用户到「分镜管理 → 全局配置 → 剧本转视频提示词」重新选择或上传文档，不要自行改用其他版本。',
        config.error === null ? '' : `当前问题：${config.error}`,
      ].filter(Boolean).join('\n'),
    };
  }
  const kindLabel = usable.kind === 'custom' ? '用户上传的自定义提示词' : '内置提示词';
  const lost = selected !== null && selected.exists !== true
    ? `\n注意：全局配置选择的「${selected.label}」文件已丢失，本次临时使用默认的「${usable.label}」。请提醒用户到全局配置重新选择或上传。\n`
    : '';
  const instruction = [
    '## 全局配置：剧本转视频提示词（优先于本文件前面的版本说明）',
    '',
    `当前选择：**${usable.label}**（${kindLabel}）。`,
    `权威提示词文件：\`${usable.file}\``,
    '',
    '在开始“剧本转视频提示词”之前，必须用文件工具完整读取上面这个文件，并以它为唯一依据。',
    '不要改用其他版本，也不要把其他版本的字段名、结构或硬性规则混进来。',
    '不要再次询问用户选哪一版；用户已经在「分镜管理 → 全局配置」里决定了。',
    lost,
  ].join('\n');
  return { ...config, option: usable, instruction };
}

/** Convenience for the skill provider: append the selected source to one skill's text. */
export async function appendPromptSourceInstruction(content, options = {}) {
  const selected = await promptSourceForSkill(options);
  return `${String(content).trimEnd()}\n\n${selected.instruction}\n`;
}
