/**
 * Project-level defaults: the three answers a production cannot proceed without.
 *
 * A script can be read without them, but nothing can be GENERATED without them: a 定妆照
 * needs a shape, a 四视图 needs a shape, a shot needs a shape and a look. Leaving them to
 * be re-decided per generation is how a project ends up with 9:16 character sheets beside
 * 16:9 scenes and two different art styles in one episode -- the shots then cannot be cut
 * together, and nothing in the pipeline reports it as an error.
 *
 * So they are decided ONCE, at script intake, and stored on the project
 * (`.director/project.json`). The storyboard panel reads the same record, which is what
 * makes the panel's default match what the agent will actually generate.
 *
 * Shapes here mirror the instance's own constraints rather than inventing new ones:
 * - `ASPECT_RATIOS` is the H3 ResolutionSelector's list (see `h3-generation.js`).
 * - `RESOLUTIONS` is the same 480p/720p/1080p ladder the H3 settings already accept.
 * - `ART_STYLES` is the four-option choice the H3 converter and asset-prompt skills
 *   already require (真人 / 3D动漫 / 动画 / 其他). Keeping one list means the opening
 *   style sentence cannot disagree with what the panel shows.
 *
 * @module dsh-plugin-short-drama-director/lib/project-settings
 */

import { normalizeProjectCode } from './result-naming.js';

/** Aspect ratios the H3 ResolutionSelector offers, in the order the panel shows them. */
export const ASPECT_RATIOS = Object.freeze(['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9']);

/** Output resolutions, matching `RESOLUTION_MEGAPIXELS` in `h3-generation.js`. */
export const RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);

/**
 * The four art styles the skills already require, with the opening sentence each one maps
 * to. `其他` carries the user's own words, so the generator never has to guess a genre.
 */
export const ART_STYLES = Object.freeze([
  { id: '真人', sentence: '实拍电影风格，真人写实', english: 'Live-action, cinematic' },
  { id: '3D动漫', sentence: '三维动画风格', english: '3D animation, cinematic' },
  { id: '动画', sentence: '二维动画风格', english: '2D animation, cinematic' },
  { id: '其他', sentence: null, english: null },
]);

const STYLE_IDS = new Set(ART_STYLES.map((entry) => entry.id));

/** What a project looks like before anyone has answered. `null` means "not answered yet". */
export function emptySettings() {
  return {
    /** 竖屏 `9:16` or 横屏 `16:9` are the two that matter; the rest stay available. */
    aspectRatio: null,
    resolution: null,
    artStyle: null,
    /** Free text, required when `artStyle === '其他'`; otherwise optional extra guidance. */
    artStyleNote: null,
    /**
     * Short file-name code for this production, e.g. `wmsdsnq`. NOT derived from the title: without
     * a pinyin dictionary any derivation is a guess, and a guessed code silently ends up inside
     * file names. Optional - when absent, result names fall back to the readable Chinese form.
     */
    code: null,
    /** Who answered and when, so a later reader can tell a decision from a default. */
    decidedAt: null,
    decidedBy: null,
  };
}

/** Human labels, used by both the panel and the agent's question. */
export const SETTING_LABELS = Object.freeze({
  aspectRatio: '画幅（宽高比）',
  resolution: '分辨率',
  artStyle: '画风',
  code: '项目代号',
});

/**
 * Validate one setting value.
 *
 * Refusing an unknown value is the point: a silently coerced ratio would produce assets at
 * a shape nobody chose, and the mistake would only surface after several generations.
 *
 * @returns `{ ok: true, value }` with the stored form, or `{ ok: false, reason }`.
 */
export function normalizeSetting(key, raw) {
  if (key === 'aspectRatio') {
    const value = String(raw ?? '').trim();
    if (!ASPECT_RATIOS.includes(value)) {
      return { ok: false, reason: `不支持的宽高比：${value || '（空）'}；可选 ${ASPECT_RATIOS.join('、')}` };
    }
    return { ok: true, value };
  }
  if (key === 'resolution') {
    const value = String(raw ?? '').trim();
    if (!RESOLUTIONS.includes(value)) {
      return { ok: false, reason: `不支持的分辨率：${value || '（空）'}；可选 ${RESOLUTIONS.join('、')}` };
    }
    return { ok: true, value };
  }
  if (key === 'artStyle') {
    const value = String(raw ?? '').trim();
    if (!STYLE_IDS.has(value)) {
      return { ok: false, reason: `不支持的画风：${value || '（空）'}；可选 ${[...STYLE_IDS].join('、')}` };
    }
    return { ok: true, value };
  }
  if (key === 'artStyleNote') {
    const value = raw === null || raw === undefined ? null : String(raw).trim();
    return { ok: true, value: value === '' ? null : value };
  }
  if (key === 'code') {
    // Delegated so there is exactly one definition of a legal code: the same one the naming
    // function uses, so a code the settings accept can never produce a name the namer rejects.
    if (raw === null || raw === undefined || String(raw).trim() === '') return { ok: true, value: null };
    const normalized = normalizeProjectCode(raw);
    return normalized.ok ? { ok: true, value: normalized.code } : { ok: false, reason: normalized.reason };
  }
  return { ok: false, reason: `未知的设置项：${key}` };
}

/**
 * Which settings still block generation.
 *
 * `artStyleNote` is required only for `其他`, because that option is "tell me in your own
 * words" and an empty note would leave the style sentence with nothing to say.
 */
export function missingSettings(settings) {
  const merged = { ...emptySettings(), ...(settings ?? {}) };
  const missing = [];
  if (merged.aspectRatio === null) missing.push('aspectRatio');
  if (merged.artStyle === null) missing.push('artStyle');
  if (merged.artStyle === '其他' && (merged.artStyleNote === null || merged.artStyleNote === '')) missing.push('artStyleNote');
  // `resolution` is NOT required: a project can be shot before the output size is settled,
  // and every generator already has a defensible default (720p). Making it blocking would
  // turn a preference into a gate.
  return missing;
}

/** Whether every blocking answer is present. */
export function settingsComplete(settings) {
  return missingSettings(settings).length === 0;
}

/** The opening style sentence for a project, or `null` when the style is not decided yet. */
export function styleSentence(settings) {
  const merged = { ...emptySettings(), ...(settings ?? {}) };
  if (merged.artStyle === null) return null;
  const known = ART_STYLES.find((entry) => entry.id === merged.artStyle);
  if (known === undefined) return null;
  if (known.sentence !== null) return known.sentence;
  return merged.artStyleNote === null ? null : String(merged.artStyleNote);
}

/**
 * The question to ask at script intake, phrased for a person rather than for a machine.
 *
 * `ask_user_question` gives each option a label and a description, so the choices carry
 * enough explanation that a first-time user does not have to know what 9:16 means.
 */
export function intakeQuestions() {
  return [
    {
      key: 'aspectRatio',
      header: '画幅',
      question: '这部片子是竖屏还是横屏？',
      options: [
        { label: '9:16 竖屏（推荐）', description: '手机短剧的常规画幅，全屏观看，抖音/快手/视频号原生比例。' },
        { label: '16:9 横屏', description: '影视/横屏平台画幅，也用于场景空镜和四视图等资产图。' },
        { label: '其他比例', description: '1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 21:9，告诉我用哪个。' },
      ],
    },
    {
      key: 'artStyle',
      header: '画风',
      question: '整部片子的画面风格定哪一种？（全片必须统一，中途改会让镜头接不上）',
      options: [
        { label: '真人（推荐）', description: '实拍电影风格，真人写实。' },
        { label: '3D动漫', description: '三维动画风格，人物立体、有建模质感，适合玄幻/科幻题材。' },
        { label: '动画', description: '二维动画风格，手绘/赛璐璐质感，画面更扁平，适合日常或轻喜剧。' },
        { label: '其他', description: '用自己的话描述风格，我会照你的说法锁全片。' },
      ],
    },
    {
      key: 'resolution',
      header: '分辨率',
      question: '成片出多少分辨率？（可后改，不影响现在开工）',
      options: [
        { label: '720p（推荐）', description: '本地 6GB 显卡和云端都稳；短剧竖屏 720x1280。' },
        { label: '1080p', description: '更清晰，显存/云端算力要求更高，生成更慢。' },
        { label: '480p', description: '最快最省，适合先看效果再重出；成片阶段可以再升到高清。' },
      ],
    },
  ];
}
