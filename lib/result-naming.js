/**
 * The name a produced clip is stored and displayed under.
 *
 * Users asked for `<项目代号>_<集数>_<大分镜号>(<第k次>)` - short, sortable, and recognisable at a
 * glance - instead of the instance's `YZ_H3__00004-audio.mp4`, which says nothing about which
 * project, episode or shot it belongs to. In a grid of attempts that name was the only label, so
 * every candidate looked alike.
 *
 * ## Why the code is an explicit project decision, not a guess
 *
 * The obvious derivation is the pinyin initials of the title. This bundle ships no pinyin
 * dictionary, and a hand-written table would silently produce a WRONG code for any character it
 * does not cover - a wrong name is worse than an asked one, because it looks authoritative and
 * ends up in file names the user cannot re-derive. The requirement itself said not to guess: the
 * example the user gave (`snqdwm`) does not match the title it was said to come from, so the rule
 * is not established yet.
 *
 * So the code is a PROJECT SETTING (`projectCode`), asked once and stored beside 画幅/画风. When it
 * has not been set, the readable Chinese name is used instead - never an invented code.
 *
 * ## One assembly point
 *
 * Display and the on-disk name come from the SAME function below. Two implementations of a naming
 * rule drift, and then a candidate is displayed as one thing and saved as another.
 *
 * @module dsh-plugin-short-drama-director/lib/result-naming
 */

/** Characters a code may contain, lowercase only, so file names stay portable across systems. */
const CODE_PATTERN = /^[a-z0-9]{1,16}$/u;

import { projectInitials } from './pinyin-initials.js';

/**
 * Normalise a user-supplied code.
 *
 * @returns `{ ok: true, code }` or `{ ok: false, reason }`. Refusing is deliberate: a code with a
 *   slash or a space would change the target DIRECTORY of a promote, not just the file name.
 */
export function normalizeProjectCode(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: '项目代号不能为空' };
  const cleaned = String(raw).trim().toLowerCase().replace(/[\s_-]+/gu, '');
  if (cleaned.length === 0) return { ok: false, reason: '项目代号不能为空' };
  if (!CODE_PATTERN.test(cleaned)) {
    return { ok: false, reason: `项目代号只能用小写字母和数字（1-16 位），现在是「${String(raw)}」` };
  }
  return { ok: true, code: cleaned };
}

/**
 * The code a project should use, and where it came from.
 *
 * Order of preference:
 *  1. `source: 'project'` - the user set `projectCode`. Always wins, because polyphonic characters
 *     mean a derivation can be wrong in a way nothing can detect (`重生` is chóng, not zhòng).
 *  2. `source: 'pinyin'` - every character was answerable, so the title's initials ARE the code.
 *  3. `source: 'as-transcribed'` - the platform cannot do pinyin collation; fall back to the ASCII
 *     the user typed, which needs no knowledge of Chinese at all.
 *  4. `source: null` - no code. The caller must ask, or fall back to the readable Chinese name.
 *
 * A PARTIAL derivation is never returned as a decision: `complete: false` means characters were
 * unreadable, and a code with holes in it would end up in a file name looking authoritative.
 */
export function projectCodeFor({ settings = null, projectName = null } = {}) {
  const stored = settings?.code;
  if (typeof stored === 'string' && stored.trim().length > 0) {
    const normalized = normalizeProjectCode(stored);
    if (normalized.ok) return { code: normalized.code, source: 'project' };
  }
  const label = String(projectName ?? '');
  // `外卖送到三年前` → `wmsdsnq`. See `lib/pinyin-initials` for how this is read off ICU's pinyin
  // collation instead of a bundled dictionary.
  const derived = projectInitials(label);
  if (derived.complete) {
    const normalized = normalizeProjectCode(derived.code);
    if (normalized.ok) return { code: normalized.code, source: 'pinyin' };
  }
  // A name that already carries ASCII can be abbreviated without inventing anything: `MyDrama 2`
  // becomes `mydrama2`. This is still not a guess - it is a transcription of characters the user
  // typed, minus punctuation.
  const ascii = label.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (ascii.length > 0 && CODE_PATTERN.test(ascii.slice(0, 16))) {
    return { code: ascii.slice(0, 16), source: 'as-transcribed' };
  }
  return { code: null, source: null, unknown: derived.unknown };
}

/**
 * `<code>_<集数>_<分镜号>(<第k次>)` - no leading zeros, ASCII parentheses.
 *
 * ASCII parentheses and underscores on purpose: this becomes a FILE NAME on Windows, macOS and
 * Linux, and a full-width `（）` in a path is a source of confusing tooling failures.
 *
 * @param options.code - the project code; required, because a code-less name is a different format.
 * @param options.episode - episode number, 1-based.
 * @param options.block - 大分镜 number, 1-based.
 * @param options.attempt - generation ordinal for that block, 1-based.
 * @param options.extension - when given, appended verbatim (include the dot).
 * @returns the name, or `null` when a component is missing - the caller then keeps the produced
 *   name rather than inventing a position for a file nobody can place.
 */
export function resultNameFor({ code, episode, block, attempt = 1, extension = null } = {}) {
  const normalized = normalizeProjectCode(code);
  if (!normalized.ok) return null;
  for (const value of [episode, block, attempt]) {
    if (!Number.isInteger(value) || value < 1) return null;
  }
  const stem = `${normalized.code}_${episode}_${block}(${attempt})`;
  if (extension === null || extension === undefined || String(extension).length === 0) return stem;
  const dot = String(extension).startsWith('.') ? '' : '.';
  return `${stem}${dot}${String(extension)}`;
}

/**
 * The readable fallback when a project has no code: `项目名_第N集_大分镜M（第k次）`.
 *
 * Kept because a project that predates the code setting must still show something a person can
 * place. This is the shape the results grid shipped with before the code existed.
 */
export function readableNameFor({ projectName, episode, block, attempt = 1 } = {}) {
  const label = String(projectName ?? '').trim();
  if (label.length === 0) return null;
  if (!Number.isInteger(episode) || !Number.isInteger(block)) return null;
  return `${label}_第${episode}集_大分镜${block}（第${attempt}次）`;
}
