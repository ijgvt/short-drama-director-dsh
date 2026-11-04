/**
 * A project's file-name code from its title's pinyin initials.
 *
 * `外卖送到三年前` → `wmsdsnq`. The rule the user confirmed is one letter per character, in order,
 * lower case, punctuation dropped.
 *
 * ## Why there is no dictionary here
 *
 * A pinyin table large enough for arbitrary titles is tens of thousands of entries and would still
 * miss the rare character in somebody's script. ICU already ships a Chinese collation that orders
 * Hanzi by pinyin, so the INITIAL can be read off an ORDERING instead of a lookup: take one anchor
 * character per initial (the alphabetically first syllable of that letter - `阿` for a, `八` for b,
 * …), sort the character among them, and whichever bin it lands in is its initial. Twenty-three
 * characters replace twenty thousand, and the platform supplies the knowledge.
 *
 * Two things this must get right, both learned by measuring rather than assuming:
 *
 *  1. An anchor has to be the FIRST element of its group. Within one syllable ICU breaks ties by
 *     stroke count, so `塌`(13 画) sorts AFTER `他`(5 画) despite both being `tā` - using 塌 as the
 *     't' anchor put 他 and 她 in the 's' bin.
 *  2. If the platform's ICU is the small build, `zh-u-co-pinyin` silently degrades to code-point
 *     order and every answer would be wrong. `initialFor` therefore CALIBRATES itself once against
 *     characters whose initials are certain, and reports unavailable rather than guessing.
 *
 * ## What it cannot do
 *
 * Polyphonic characters get their most common reading, so `重生` yields `z` (zhòng) rather than `c`
 * (chóng). There is no way to know from the title alone. The code is therefore a project setting the
 * user can correct, and the derived value is shown to them when it is used.
 *
 * @module dsh-plugin-short-drama-director/lib/pinyin-initials
 */

/** One character per initial, each the collation-first element of its letter group. Verified. */
const ANCHORS = Object.freeze([
  ['a', '阿'], ['b', '八'], ['c', '擦'], ['d', '搭'], ['e', '婀'], ['f', '发'], ['g', '旮'],
  ['h', '哈'], ['j', '击'], ['k', '咔'], ['l', '拉'], ['m', '妈'], ['n', '拿'], ['o', '噢'],
  ['p', '趴'], ['q', '七'], ['r', '然'], ['s', '撒'], ['t', '他'], ['w', '挖'], ['x', '夕'],
  ['y', '压'], ['z', '匝'],
]);

/** Characters with an initial that no reading can change - used to prove collation works. */
const CALIBRATION = Object.freeze([['八', 'b'], ['撒', 's'], ['他', 't'], ['挖', 'w'], ['匝', 'z'], ['阿', 'a'], ['七', 'q'], ['妈', 'm']]);

/** The longest code a name may produce; mirrors the accepted range in `result-naming`. */
const MAX_CODE_LENGTH = 16;

let compare = null;
let usable = null;

/** Bin one character against the anchors. Returns a letter, or `null` for a non-Hanzi. */
function initialWith(compareFn, char) {
  let found = null;
  for (const [letter, anchor] of ANCHORS) {
    if (compareFn(anchor, char) <= 0) found = letter;
    else break;
  }
  return found;
}

/**
 * Whether this platform can answer at all.
 *
 * Calibrated once and cached: the check is cheap but it runs on every project read, and the answer
 * cannot change within a process.
 */
export function pinyinAvailable() {
  if (usable !== null) return usable;
  try {
    compare = new Intl.Collator('zh-Hans-u-co-pinyin').compare;
    usable = CALIBRATION.every(([char, letter]) => initialWith(compare, char) === letter);
  } catch {
    usable = false;
  }
  return usable;
}

/**
 * The initial of one character: an ASCII letter/digit comes back as-is (lower case), a Hanzi is
 * binned by collation, and anything else (space, punctuation) yields `null` so it can be dropped.
 */
export function initialFor(char) {
  if (typeof char !== 'string' || char.length === 0) return null;
  if (/^[a-z0-9]$/iu.test(char)) return char.toLowerCase();
  if (!/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) return null;
  if (!pinyinAvailable()) return null;
  return initialWith(compare, char);
}

/**
 * The code a title suggests.
 *
 * @returns `{ code, complete, unknown, truncated }`
 *   - `complete`: every Hanzi was answerable AND nothing was dropped, so the code can be used as-is.
 *   - `unknown`: the characters that could not be read, so the caller can ask about exactly those
 *     instead of asking the user to redo the whole thing.
 *
 * An incomplete code is still RETURNED (it is useful to show, "this is what I could read: `wm?dsnq`"),
 * but `complete: false` means it must not silently become a file name.
 */
export function projectInitials(title) {
  const text = String(title ?? '').trim();
  const unknown = [];
  let truncated = false;
  if (text.length === 0) return { code: '', complete: false, unknown, truncated };
  let code = '';
  for (const char of text) {
    const initial = initialFor(char);
    if (initial === null) {
      // A Hanzi we cannot read is missing information; punctuation simply is not part of a code.
      if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) unknown.push(char);
      continue;
    }
    if (code.length >= MAX_CODE_LENGTH) { truncated = true; break; }
    code += initial;
  }
  return { code, complete: code.length > 0 && unknown.length === 0, unknown, truncated };
}
