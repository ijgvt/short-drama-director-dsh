/**
 * Storyboard discovery and editing, shared by the Host command and the UI.
 *
 * Nothing here is pinned to one project or one machine. A project is any directory
 * that contains a `剧集/第N集/` tree; an episode's storyboards are whatever files in
 * its folder match the prompt-file patterns, so a project can be renamed, moved or
 * renamed-and-moved between users without touching this code.
 *
 * @module dsh-plugin-short-drama-director/lib/storyboard
 */

import { basename, join } from 'node:path';
import { RevisionConflictError, UnknownShotError, blockAnchor, hashText, newShotId } from './director-store.js';
import { withFileLock } from './file-lock.js';

/** Folder that marks a project, and the folder holding one directory per episode. */
const EPISODE_ROOT = '剧集';

/**
 * Two texts that differ only in WHITESPACE are the same text.
 *
 * This is the guard, not the writer: `expectedText` exists to answer "did somebody else edit this
 * block while I had it open", and an edit that only moves spaces has not changed what the prompt
 * says. It was refusing REAL work: an expectedText copied out of a terminal or a Windows tool
 * differed from the file by one space, and the panel reported 「自动保存失败」 / 「块在读取后已变化」
 * for a byte-for-byte identical prompt. The cost of being forgiving is bounded - a spacing-only
 * edit made elsewhere is overwritten - while the cost of being strict is refusing the user's own
 * paragraph.
 *
 * Note what is NOT done here: the comparison collapses whitespace, the WRITER does not. The text
 * that lands on disk is exactly what the caller sent.
 */
export function sameBlockText(left, right) {
  const normalise = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  return normalise(left) === normalise(right);
}

/**
 * Directories never worth walking into.
 *
 * Deliberately NOT "anything starting with _ or .": a project legitimately lives under
 * `_verify` or `.work`, and skipping those hides it. Only build output and VCS metadata
 * are excluded.
 */
const SKIP_DIRECTORIES = /^(node_modules|\.git|\.svn|\.hg|__pycache__|\.venv|venv|\.next|\.nuxt|dist|build|target|\.cache|\.idea|\.vscode|\.trash)$/u;

/**
 * Prompt files an episode card can show.
 *
 * Matching is first-match-wins per file, in this order, so a name only has to satisfy
 * ONE rule and a suffix such as `（中文·供审阅修改）` cannot slip through the gap between
 * two stricter patterns. The earlier rule demanded text AFTER `中文`, which failed the
 * moment the name ended with `）` - and the English rule excluded anything containing
 * `中文` too, so BOTH H3 files disappeared and only the video prompt was left.
 */
export const PROMPT_SOURCES = [
  // Tolerant of the 大分镜 infix: `split-episode` writes one document per 大分镜 named
  // `第1集大分镜1视频提示词.txt`, and a strict `集视频提示词` pattern made those files invisible to the
  // panel - on disk, correct, and unreachable.
  { id: 'video', label: '视频提示词', test: /^第\d+集(?:大分镜\s*\d+)?视频提示词.*\.txt$/u },
  // H3 files come in two shapes and the language must be read from the NAME, not inferred from what
  // is left over.
  //
  // The old rule was "any remaining H3 file is the English one", which broke as soon as
  // `compile-h3` wrote one prompt per 大分镜: 第1集H3提示词-大分镜1（中文）.txt and
  // 第1集H3提示词-大分镜2（中文）.txt both fell through to the English pattern, so the panel
  // labelled a Chinese block "H3 英文" and then showed only ONE of the two files, because a source id
  // is unique within an episode.
  //
  // Both spellings are accepted: an explicit （中文）/（英文） marker, and the `-zh` / `-en` suffix
  // `compile-h3` uses when it writes to a filesystem where full-width brackets are awkward.
  // A file with NO language marker is the CHINESE one.
  //
  // The old rule was the opposite ("unmarked means English, because that is what the model is fed"), and it
  // mislabelled real work: this project's `第1集H3提示词.txt` is a 40 KB Chinese document, but the panel showed
  // it as 「H3 英文」 and hid the Chinese tab entirely - the user saw only 视频提示词 and H3 英文. A human writes
  // Chinese first; English is the artefact produced by 一键更新, so English has to say so in its name.
  { id: 'h3-zh', label: 'H3', test: /^第\d+集H3提示词(?:(?!.*(?:英文|[-_]en(?![a-z])|EN)).)*\.txt$/u },
  // English claims only an explicit marker: （英文） / -en / EN.
  { id: 'h3-en', label: 'H3 英文', test: /^第\d+集H3提示词.*(?:英文|[-_]en(?![a-z])|EN).*\.txt$/u },
];

/** Script file an episode uses as its source, when one is present. */
const SCRIPT_TEST = /^第(\d+)集剧本.*\.(txt|md)$/u;

/**
 * Whether one line is a 大分镜 heading, in any of the accepted dialects.
 *
 * Shared by the parser and by the save path so both agree on what a heading looks like: a
 * body line that merely begins with 大分镜 must never be mistaken for one and dropped.
 */
function isHeadingLine(line) {
  const text = String(line);
  if (/^\s*【\s*大分镜\s*\d+\s*】/u.test(text)) return true;
  if (/^\s*#{1,6}\s*大分镜\s*\d+/u.test(text)) return true;
  return /^\s*大分镜\s*\d+\s*$/u.test(text);
}

/**
 * Put the source 大分镜 number on a one-block H3 document.
 *
 * A compiled H3 file contains exactly one block, but that does not mean it is 大分镜 1. Without an
 * in-file identity, duration lookup and result recording both fall back to the file-local index and
 * every per-block file is accounted as block 1. The filename remains useful, but the document is
 * the durable payload and must carry the same number.
 */
export function withH3BlockHeading(text, blockNumber) {
  const body = String(text ?? '').replace(/^\uFEFF/u, '').trimStart();
  if (!Number.isInteger(blockNumber) || blockNumber < 1) return body;
  const existing = /^\s*【\s*大分镜\s*(\d+)\s*】/u.exec(body);
  if (existing !== null) {
    const found = Number(existing[1]);
    if (found !== blockNumber) {
      throw new Error(`H3 大分镜标题是 ${String(found)}，但这次操作对应 ${String(blockNumber)}；为避免结果记错块，未写入`);
    }
    return body;
  }
  return `【大分镜${String(blockNumber)}】\n${body}`;
}

/**
 * Locate the 大分镜 headings in one prompt file.
 *
 * Three dialects exist. The pipeline's video-prompt template writes `【大分镜1】`; H3
 * prompts are written with a Markdown heading; and files produced before the per-block
 * asset-mapping rule carry `### 大分镜 N（总时长：6 秒）`. All three are accepted, and the
 * dialect is reported so an inserted block matches its neighbours.
 *
 * @returns `[{ number, kind, start }]`, in file order.
 */
function findBlockHeadings(lines) {
  const heads = [];
  for (const [index, line] of lines.entries()) {
    if (!isHeadingLine(line)) continue;
    const bracketed = /^\s*【\s*大分镜\s*(\d+)\s*】/u.exec(line);
    if (bracketed !== null) {
      heads.push({ number: Number(bracketed[1]), kind: 'bracketed', start: index });
      continue;
    }
    const hashed = /^\s*(#{1,6})\s*大分镜\s*(\d+)/u.exec(line);
    if (hashed !== null) {
      heads.push({ number: Number(hashed[2]), kind: 'heading', start: index });
      continue;
    }
    const plain = /^\s*大分镜\s*(\d+)\s*$/u.exec(line);
    if (plain !== null) heads.push({ number: Number(plain[1]), kind: 'plain', start: index });
  }
  return heads;
}

/**
 * One block per entry, with its parts kept apart.
 *
 * `anchor` is the content identity used by the director store to keep a shot's id stable
 * across insertions and reorderings. It is taken from the BODY alone, so renumbering a
 * heading - which every structural edit does - does not look like a content change. That
 * distinction is the whole reason identity can survive an insert.
 *
 * @returns `[{ order, title, sourceNumber, heading, body, anchor, shotCount }]`.
 */
export function describeBlocks(text) {
  const parts = dissect(String(text));
  return parts.blocks.map((block, position) => {
    const body = withHeading(block, position + 1);
    const number = Number.isInteger(block.number) ? block.number : position + 1;
    return {
      order: position,
      title: `大分镜 ${number}`,
      sourceNumber: number,
      heading: block.lines[0] ?? '',
      body,
      anchor: blockAnchor(body),
      shotCount: countShots(body),
    };
  });
}

/** Split one prompt file into its 大分镜 blocks. */
/**
 * The duration a 大分镜 heading declares.
 *
 * Two facts make this worth parsing rather than leaving as opaque text:
 *
 *   - the handbook makes the PROMPT TEXT the only source of truth for duration (hard constraint 7),
 *     and `（总时长：8 秒）` in the heading IS the text saying how long the shot is. Leaving it
 *     unread meant the panel showed no duration for any block, and D09's consistency check had
 *     nothing to check.
 *   - the per-分镜 durations inside the body are a different thing. They describe the small shots
 *     WITHIN the block; this is the block's own total. Only `总时长` is read here for that reason.
 *
 * Returns null when the heading does not say, which is a normal state - not every file declares one.
 */
function secondsFromHeading(headingText) {
  const text = String(headingText ?? '');
  // `总时长：8 秒`, `总时长 8s`, `总时长：8.5 秒` - the label is what distinguishes the block total
  // from the per-shot durations in the body, so it is required.
  //
  // The seconds suffix is matched with a negative lookahead rather than `\b`: a word boundary does
  // not exist between `s` and the full-width `）`, so `（总时长：4s）` - a real way people write it -
  // failed to match while `4 秒` worked. The lookahead rejects `4sec` being read as `4s` + `ec`.
  const match = /总时长\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?![\p{L}\p{N}])|sec)/iu.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Sum the durations written on a block's small-shot headings.
 *
 * A 视频提示词 normally states 时长 per 分镜, not on the 大分镜 heading. Reading only the
 * heading therefore reported every compiled block as `?s` even though the durations were
 * present in the body. This is a parsed display value; the body remains the source of truth.
 */
export function totalShotSeconds(text) {
  let total = 0;
  let found = false;
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (!/【\s*(?:分镜|镜头)\s*\d+\s*】|(?:镜次|Shot)\s*\d+\s*[（(]/u.test(line)) continue;
    const duration = /时长\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?![\p{L}\p{N}])|sec)/iu.exec(line)?.[1]
      ?? /[（(]\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?![\p{L}\p{N}])|sec)\s*[）)]/iu.exec(line)?.[1];
    if (duration === undefined) continue;
    const value = Number(duration);
    if (!Number.isFinite(value) || value <= 0) continue;
    total += value;
    found = true;
  }
  return found ? Math.round(total * 1000) / 1000 : null;
}

export function splitShotBlocks(text) {
  const source = String(text);
  const parts = dissect(source);
  // The preamble - everything before the first 大分镜 - is returned alongside the blocks.
  //
  // It is NOT decoration: in a real project it holds the 资产映射 section, which is where the \
  // @ mentions live (`林晚（形象及服装参考: @林晚）`). Dropping it meant every block resolved to
  // ZERO references while the file was naming five assets in plain sight, so the panel showed no
  // reference images and a generation would have uploaded nothing. It is shared context for every
  // block of the file: the mapping section declares the cast and props the episode uses.
  const preamble = String(parts.preamble ?? '');
  // No 大分镜 markers at all: a file written as one document. It is shown whole, as a
  // single block, rather than dropped - the panel has to be able to open any prompt file,
  // and the user may still be turning it into the block form.
  if (parts.blocks.length === 0) {
    const whole = source.trimEnd();
    if (whole.length === 0) return [];
    return [{ index: 0, title: '全文', editIndex: 0, seconds: null, shotCount: countShots(whole), text: whole, preamble: '' }];
  }
  return parts.blocks.map((block, position) => {
    // `withHeading` returns the body only - the heading is the panel's label, supplied
    // separately as `title`, and a `【大分镜1】` line at the top of the text would be prompt
    // content nobody asked for once the block is pasted into the video model.
    const blockText = withHeading(block, position + 1);
    return {
      index: position,
      // The block's position in the FILE. Kept as its own field because the panel's list
      // and the file's order must not drift apart.
      editIndex: position,
      // The number alone. A file may hang a duration off its heading - `（总时长：6 秒）` -
      // and that is prompt content the writer edits, not a label for the panel's header.
      title: `大分镜 ${Number.isInteger(block.number) ? block.number : position + 1}`,
      sourceNumber: Number.isInteger(block.number) ? block.number : position + 1,
      // Read from the heading line the file actually has. `dissect` keeps it as the block's first
      // line, which is what the parser matched on - so this reads the same text the writer wrote.
      seconds: secondsFromHeading(block.lines?.[0]) ?? totalShotSeconds(blockText),
      shotCount: countShots(blockText),
      text: blockText,
      // What the whole file declares before the first block. The caller uses it when resolving
      // references; it is kept OFF `text` because the text is what gets pasted into the model and
      // what a save writes back.
      preamble,
    };
  });
}

/** Count the small shots inside one block, in either dialect. */
function countShots(body) {
  return (body.match(/^\s*#{0,6}\s*【\s*分镜\s*\d+\s*】/gmu) ?? []).length
    || (body.match(/^\s*#{0,6}\s*【\s*镜头\s*\d+\s*】/gmu) ?? []).length
    // `[Shot N]` also appears inside retention_analysis. Counting those references made a
    // three-shot H3 file report four shots. Only a line that STARTS with a shot marker is a shot.
    || (body.match(/^\s*\[Shot\s+\d+\]/gmu) ?? []).length;
}

/**
 * The body of a blank block the user fills in.
 *
 * Deliberately a skeleton rather than empty text: the file is the prompt that goes to the
 * The user's 「添加」 action means a truly empty shot: no uploaded assets, no mapping
 * placeholders, and no prompt text. The heading is supplied by the caller in the file's own
 * dialect, so an empty body is enough for the card to render and accept manual input.
 */
function blankBlock() {
  return [];
}

/**
 * Split a document into the part before its first block heading, the blocks themselves,
 * and the separators between them.
 *
 * Editing one block means editing one slice of this split result. Rebuilding the whole
 * document from it is what lets a block be inserted or renumbered without a single regex
 * run over prose that merely happens to look like a heading.
 *
 * A block holds its heading plus its content lines, with no trailing blank lines. The
 * separator that follows is the gap as written - blank lines, a `---` rule, or both - so
 * rebuilding reproduces the file's own rhythm instead of inventing one.
 *
 * @returns `{ preamble, blocks, separators, suffix }`; `separators[i]` sits between block
 *   `i` and block `i+1`, so there is always exactly one fewer separator than block.
 */
function dissect(text) {
  const source = String(text);
  const lines = source.split(/\r?\n/u);
  const heads = findBlockHeadings(lines);
  if (heads.length === 0) return { preamble: '', blocks: [], separators: [], suffix: source, tail: '' };

  const preamble = lines.slice(0, heads[0].start).join('\n');
  const blocks = [];
  const gaps = [];

  for (const [position, head] of heads.entries()) {
    const next = heads[position + 1];
    const end = next === undefined ? lines.length : next.start;
    const body = lines.slice(head.start, end);
    // Trailing blank lines and a `---` rule belong to the GAP, not to the block: keeping
    // them inside would make every inserted copy carry a stray rule, and would leave the
    // next heading glued to the previous line once the gap is reapplied.
    //
    // Only those lines are taken, and never a content line. Walking back from the end and
    // accepting "blank or ---" does both: a block ending `...第一段。` followed by `---`
    // stops at the `---`, while one ending with a real blank line stops at the blank.
    let cut = body.length;
    while (cut > 1 && /^\s*(?:-{3,})?\s*$/u.test(body[cut - 1])) cut -= 1;
    const level = /^\s*(#{1,6})\s*大分镜/u.exec(body[0] ?? '')?.[1] ?? '##';
    blocks.push({ kind: head.kind, level, number: head.number, lines: body.slice(0, cut) });
    gaps.push(body.slice(cut).join('\n'));
  }

  // The last gap holds the blank lines after the final block plus whatever follows it (a
  // 自检 section, a note). Split the two apart so neither is lost.
  const last = gaps[gaps.length - 1] ?? '';
  const rest = last.replace(/^\n+/u, '');
  const trailingBlanks = last.slice(0, last.length - rest.length);

  return {
    preamble,
    blocks,
    separators: gaps.slice(0, -1),
    suffix: rest,
    tail: trailingBlanks,
    /** Whether the original ended with a newline, so the rewrite can keep that shape. */
    endsWithNewline: source.endsWith('\n'),
  };
}

/**
 * How a renumbered heading line reads, keeping the file's own dialect.
 *
 * `level` is the run of `#` the file already uses. Hardcoding `##` would quietly change the
 * document's heading structure on the first structural edit, which matters because these
 * files sit inside a larger Markdown outline (`## 二、分镜` above them).
 */
function renderHeading(block, number, level = '##') {
  if (block.kind === 'heading') return `${level} 大分镜 ${number}`;
  if (block.kind === 'plain') return `大分镜 ${number}`;
  return `【大分镜${number}】`;
}

/** The run of `#` a block's heading uses, so renumbering keeps the outline intact. */
function headingLevel(block) {
  if (typeof block.level === 'string') return block.level;
  const match = /^\s*(#{1,6})\s*大分镜/u.exec(block.lines[0] ?? '');
  return match === null ? '##' : match[1];
}

/**
 * The block's body: no heading line, no trailing blank lines.
 *
 * The heading is the panel's label - it becomes the card title - so it is NOT part of the
 * text the user reads, edits or copies. A block is pasted into the video model as-is, and a
 * `【大分镜1】` line at the top would be prompt text nobody asked for. `dissect` keeps the
 * heading in `lines[0]` so the file's own dialect survives a rewrite; this is where it is
 * dropped from what the panel shows.
 */
function withHeading(block, number) {
  if (block.lines.length === 0) return '';
  const rest = block.lines.slice(1);
  while (rest.length > 0 && /^\s*$/u.test(rest[rest.length - 1])) rest.pop();
  return rest.join('\n');
}

/**
 * Rebuild a document from dissected parts, renumbering every heading by position.
 *
 * A gap is written with exactly one blank line before the next heading (and a `---` rule
 * if the gap had one), which is the shape every prompt file in this pipeline uses. The
 * point is to reproduce the file's rhythm for a normal edit rather than to be a byte-exact
 * round trip: the panel rewrites whole files, and a separator that drifts by one blank
 * line on each save would grow the file without the user touching it.
 *
 * @param parts - the result of {@link dissect}.
 * @param blocks - the blocks to write, in order; usually `parts.blocks` with one inserted.
 * @param separators - the gaps between them, one fewer than there are blocks.
 */
function reassemble(parts, blocks = parts.blocks, separators = parts.separators, { renumber = true } = {}) {
  if (blocks.length === 0) return parts.suffix;
  const pieces = [];
  if (parts.preamble.replace(/\s+$/u, '').length > 0) pieces.push(parts.preamble.replace(/\n+$/u, ''), '\n\n');
  for (const [position, block] of blocks.entries()) {
    if (position > 0) {
      // A blank line, then a `---` rule if the gap had one, then a blank line before the
      // next heading - the shape every prompt file in this pipeline uses. The rule goes
      // after the blank line, not before it, so a normal edit reproduces the file instead
      // of shifting its whitespace on every save.
      const gap = separators[position - 1] ?? '';
      pieces.push(/^\s*-{3,}\s*$/mu.test(gap) ? '\n\n---\n\n' : '\n\n');
    }
    // The heading IS written - it is the file's block marker, and without it the document
    // collapses into one block the next time it is read. It is only left out of what the
    // panel SHOWS (`withHeading`), never out of what the file holds.
    const level = headingLevel(block);
    const original = block.lines[0] ?? '';
    const heading = isHeadingLine(original)
      ? (renumber ? original.replace(/(大分镜\s*)\d+/u, (_, prefix) => `${prefix}${position + 1}`) : original)
      : renderHeading(block, position + 1, level);
    pieces.push(heading, '\n', withHeading(block, position + 1));
  }
  pieces.push('\n', parts.suffix.replace(/^\n+/u, ''));
  const out = pieces.join('');
  return parts.endsWithNewline === false ? out.replace(/\n+$/u, '') : out;
}

/** Read the episode number out of a folder name like `第3集`. */
export function episodeNumberOf(name) {
  const match = /^第\s*(\d+)\s*集$/u.exec(String(name).trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Build a filesystem helper bound to one resolved root.
 *
 * @param fs - the Host `ctx.fs` service.
 * @param root - absolute directory to work inside.
 * @param getPolicy - resolves the per-call sandbox policy, or undefined to fall back to
 *   the deployment default. The default is what breaks saving: it is `workspace-write`
 *   against the deployment's fallback root, and a project folder sits outside that, so
 *   every write is refused with "file access denied under workspace-write mode". Passing
 *   the CALLER's policy makes the sandbox judge the write by the mode the user is actually
 *   in, which is both the honest answer and the useful one: `danger-full-access` allows the
 *   save, `read-only` still refuses it, and nothing here decides that on the user's behalf.
 */
export function createReader(fs, root, getPolicy, { director } = {}) {
  const policyFor = typeof getPolicy === 'function' ? getPolicy : () => undefined;
  /** Write through the caller's policy, so the sandbox sees the mode the user chose. */
  const write = async (file, content) => fs.writeText(file, content, undefined, undefined, policyFor());
  // `.` rather than `''`: a sandboxed filesystem rejects an empty path outright with
  // "file_path must be a non-empty string", and that failure is indistinguishable from a
  // missing directory once it is swallowed by an "on error return nothing" guard.
  const target = async (relative) => fs.resolve(relative === '' ? '.' : relative, { cwd: root });
  const withDocumentLock = async (filePath, task) => {
    const relative = String(filePath).replace(/\\/gu, '/');
    const lockPath = join(director?.root ?? root, '.director', 'locks', `${hashText(relative).slice(0, 32)}.lock`);
    return await withFileLock(lockPath, task, {
      checkPath: async (path) => {
        if (typeof fs.checkedTarget === 'function') {
          const target = await fs.resolve(path, { cwd: root });
          return (await fs.checkedTarget(target, policyFor()))?.targetKey ?? path;
        }
        const policy = policyFor();
        if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access') {
          const error = new Error(`cannot write "${path}": file access denied under ${String(policy.mode ?? 'workspace-write')} mode`);
          error.code = 'FS_SANDBOX_DENIED';
          throw error;
        }
        return path;
      },
    });
  };

  /**
   * A project-relative path with forward slashes.
   *
   * Metadata keys must not depend on how the caller spelled the path: the panel sends
   * `测试短剧/剧集/第1集/…`, a tool call might send an absolute one, and Windows would
   * otherwise record backslashes for one and forward slashes for the other - two records
   * for one file, and therefore two sets of shot ids.
   */
  const relativeToRoot = (filePath) => {
    const normalised = String(filePath).replace(/\\/gu, '/');
    const base = String(root).replace(/\\/gu, '/').replace(/\/+$/u, '');
    if (normalised.startsWith(`${base}/`)) return normalised.slice(base.length + 1);
    // Already relative: strip any leading `./` so both spellings land on one key.
    return normalised.replace(/^\.\//u, '');
  };
  const documentRelativePathFor = async (filePath) => {
    let relative = relativeToRoot(filePath);
    if (director === undefined) return relative;
    // Two path spellings have existed for the same document (`剧集/…` from migration and
    // `项目名/剧集/…` from panel reads). Prefer the record that actually contains shot metadata
    // so a structural write cannot miss it and mint replacement identities.
    const folder = `${basename(director.root)}/`;
    const alternate = relative.startsWith(folder)
      ? relative.slice(folder.length)
      : `${folder}${relative}`;
    const current = await director.readDocument(relative);
    const other = await director.readDocument(alternate);
    const score = (document) => (document?.shots ?? []).reduce((total, shot) =>
      total + (shot.references?.length ?? 0) + (shot.selectedResultId === null || shot.selectedResultId === undefined ? 0 : 1), 0);
    if (other !== undefined && (current === undefined || score(other) > score(current))) return alternate;
    return relative;
  };

  /** Which flavour of prompt file this is, by name; display metadata only. */
  const documentKindOf = (filePath) => {
    const name = basename(filePath);
    if (/H3/iu.test(name) && /英/u.test(name)) return 'h3-en';
    if (/H3/iu.test(name)) return 'h3-zh';
    if (/视频提示词/u.test(name)) return 'video';
    return 'other';
  };

  /** Directories directly inside a path. */
  const directories = async (relative) => {
    const dir = await target(relative);
    if (await fs.stat(dir) === undefined) return [];
    const entries = await fs.listDir(dir);
    return entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name);
  };

  /** Files directly inside a path. */
  const files = async (relative) => {
    const dir = await target(relative);
    if (await fs.stat(dir) === undefined) return [];
    const entries = await fs.listDir(dir);
    return entries.filter((entry) => entry.type === 'file').map((entry) => entry.name);
  };

  /**
   * One directory as the folder picker needs it.
   *
   * Reports its own path, where going up leads, and which children are projects, so the
   * picker needs no second round trip per level. An unreadable directory is reported as
   * unreadable rather than empty: under a sandbox those two look identical otherwise,
   * and the difference decides whether the user should pick somewhere else.
   */
  const browse = async (relative = '') => {
    const self = String((await target(relative))?.targetKey ?? relative).replace(/[\\/]+$/u, '');
    const listing = { path: self, parent: null, directories: [], projects: [], readable: false, error: null };
    if (self.length > 0 && !/^[a-z]:$/iu.test(self) && !/^[\\/]$/u.test(self)) {
      const cut = Math.max(self.lastIndexOf('\\'), self.lastIndexOf('/'));
      // `D:` keeps its separator so joining below still yields `D:\<name>`.
      if (cut > 0) listing.parent = cut === 2 && /^[a-z]:/iu.test(self) ? self.slice(0, 3) : self.slice(0, cut);
    }
    let entries;
    try {
      entries = await fs.listDir(await target(relative));
    } catch (error) {
      listing.error = String(error?.message ?? error);
      return listing;
    }
    listing.readable = true;
    for (const entry of entries) {
      if (entry.type !== 'directory' || entry.name.startsWith('.')) continue;
      const separator = self.endsWith('\\') || self.endsWith('/') ? '' : '\\';
      const childPath = `${self}${separator}${entry.name}`;
      let isProject = false;
      try {
        const inner = await fs.listDir(await fs.resolve(childPath, { cwd: root }));
        isProject = inner.some((candidate) => candidate.type === 'directory' && candidate.name === EPISODE_ROOT);
      } catch {
        // A child that cannot be read is still listed; the picker just will not mark it.
      }
      const row = { name: entry.name, path: childPath, isProject };
      listing.directories.push(row);
      // A project is also offered directly, so one click picks it.
      if (isProject) listing.projects.push(row);
    }
    listing.directories.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return listing;
  };

  /**
   * Every project under a set of candidate directories.
   *
   * A directory is a project when it holds `剧集/`. The walk is bounded by depth and by
   * a visit budget rather than by a whitelist of folder names, so a project is found
   * wherever the user actually keeps it - including under an underscore-prefixed folder
   * such as `_verify`, which a "skip anything starting with _" rule would hide.
   *
   * @returns `{ projects, truncated }`; `truncated` says the budget ran out, so the
   *   caller can tell the user the list may be incomplete instead of implying it is not.
   */
  const scanProjects = async ({ candidates, depth = 4, budget = 4000 } = {}) => {
    const found = new Map();
    let visited = 0;
    let truncated = false;
    const visit = async (relative, level) => {
      if (level > depth || visited >= budget) {
        if (visited >= budget) truncated = true;
        return;
      }
      visited += 1;
      let names = [];
      try {
        names = await directories(relative);
      } catch {
        return;
      }
      for (const name of names) {
        if (SKIP_DIRECTORIES.test(name)) continue;
        const child = relative.length === 0 ? name : `${relative}/${name}`;
        if (name === EPISODE_ROOT) {
          const owner = relative.length === 0 ? '.' : relative;
          const label = relative.length === 0 ? basename(root) : basename(relative);
          // Keyed by PATH, not by name. Keying by the folder's base name made two projects that
          // share a title - `D:/A/送错的外卖` and `D:/B/送错的外卖` - collide, and the second was
          // silently dropped from the list. A project the user cannot see is worse than one
          // listed twice: there is no way to reach it, and nothing explains why. The path is what
          // the caller passes back, so it is also the honest identity.
          //
          // `label` is the path WITHOUT the shared tail, so a picker can tell two same-named
          // projects apart: name `送错的外卖`, label `系列A/送错的外卖`. A picker that shows only
          // the name is how a user picks the wrong one and edits the other production's episode.
          if (!found.has(owner)) found.set(owner, { name: label, path: owner, label: owner });
          continue;
        }
        await visit(child, level + 1);
      }
    };
    if (Array.isArray(candidates) && candidates.length > 0) {
      for (const candidate of candidates) await visit(candidate, 0);
    } else {
      await visit('', 0);
    }
    return { projects: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')), truncated, visited };
  };

  /** Backwards-compatible shape: just the projects. */
  const listProjects = async (options) => (await scanProjects(options)).projects;

  /** The episodes of one project, with the prompt files each one offers. */
  const listEpisodes = async (projectPath) => {
    const rootPath = projectPath === '.' ? EPISODE_ROOT : `${projectPath}/${EPISODE_ROOT}`;
    const names = await directories(rootPath);
    const episodes = [];
    for (const name of names) {
      const number = episodeNumberOf(name);
      if (number === null) continue;
      const folder = `${rootPath}/${name}`;
      const inside = await files(folder);
      const sources = [];
      // A source is a KIND of prompt file, and one kind may legitimately hold several files.
      //
      // That became true the moment `compile-h3` wrote one H3 prompt per 大分镜: an episode with two
      // 大分镜 has TWO Chinese H3 files, and the old "one match per source" rule dropped the second
      // one silently - so the panel offered 大分镜1 and simply never showed 大分镜2.
      //
      // Files are matched per source in the order the rules declare, and a file claimed by an earlier
      // rule cannot be claimed again. Within a source they are sorted by 大分镜 number, so the list
      // reads in shooting order rather than in whatever order the directory happened to return.
      const claimed = new Set();
      const blockNumberOf = (file) => Number(/大分镜\s*(\d+)/u.exec(file)?.[1] ?? 0);
      for (const source of PROMPT_SOURCES) {
        const matches = inside
          .filter((file) => !claimed.has(file) && source.test.test(file) && (new RegExp(`第\\s*${number}\\s*集`, 'u')).test(file))
          .sort((a, b) => blockNumberOf(a) - blockNumberOf(b) || a.localeCompare(b));
        if (matches.length === 0) continue;
        for (const match of matches) claimed.add(match);
        sources.push({
          id: source.id,
          label: source.label,
          // The FIRST file, for every caller that still expects one. A single-file source therefore
          // reads exactly as it did before this change.
          file: matches[0],
          path: `${folder}/${matches[0]}`,
          // Every file of this kind, in 大分镜 order - what a per-大分镜 compile produces.
          files: matches.map((match) => ({ file: match, path: `${folder}/${match}`, blockNumber: blockNumberOf(match) })),
        });
      }
      const script = inside.find((file) => SCRIPT_TEST.test(file));
      episodes.push({ number, folder, sources, script: script === undefined ? null : `${folder}/${script}` });
    }
    return episodes.sort((a, b) => a.number - b.number);
  };

  /**
   * Read one prompt file, split it into blocks, and - when the project has been migrated -
   * hand every block its stable shotId.
   *
   * Reconciliation happens on READ, not on write, and that is deliberate. It is what lets
   * an edit made outside the panel be noticed at all: the file's content is compared with
   * what the metadata recorded, and any mismatch surfaces here rather than being silently
   * absorbed by the next save. A project without `.director/` simply has no ids, and every
   * caller keeps working by position exactly as before.
   *
   * @param options.reconcile - set `false` for a purely presentational read that must not
   *   write metadata (the file browser, for instance). Defaults to true.
   */
  const readShots = async (filePath, { reconcile = true } = {}) => {
    const file = await target(filePath);
    const text = await fs.readText(file);
    const shots = splitShotBlocks(text);
    // The shape returned must not depend on whether metadata exists. A caller that reads a
    // block and then addresses it must be able to do so the same way in both cases, so
    // `shotId` is always present and is `null` when there is no identity rather than being
    // an absent key that a truthiness check would silently treat the same way.
    const bare = () => shots.map((shot) => ({ ...shot, shotId: null }));
    if (director === undefined || reconcile !== true) {
      return { text, shots: bare(), revision: null, shotIds: null };
    }

    const described = describeBlocks(text);
    const relative = await documentRelativePathFor(filePath);
    let outcome;
    try {
      outcome = await director.reconcileDocument(relative, {
        kind: documentKindOf(filePath),
        fileHash: hashText(text),
        blocks: described.map((block) => ({
          anchor: block.anchor,
          sourceNumber: block.sourceNumber,
        })),
      });
    } catch (error) {
      if (error?.code !== 'FS_SANDBOX_DENIED') throw error;
      // Read-only callers must still be able to inspect an existing project. Use the last
      // recorded identities without reconciling or extracting anything.
      const stored = await director.readDocument(relative);
      if (stored === undefined) return { text, shots: bare(), revision: null, shotIds: null };
      outcome = {
        document: stored,
        added: [],
        removed: [],
        ambiguous: [],
        changedOnDisk: stored.fileHash !== hashText(text),
      };
    }
    // Position is how the ids are matched back to the blocks the panel will render; the id
    // itself is what everything durable refers to from here on.
    const shotIds = outcome.document.shots.map((shot) => shot.shotId);
    return {
      text,
      shots: shots.map((shot, index) => {
        const stored = outcome.document.shots[index];
        return {
          ...shot,
          shotId: shotIds[index] ?? null,
          // Shot metadata is the durable half of a reference. Returning only the parsed text
          // meant the panel re-resolved from zero every time and could not remember a choice
          // the user had already made for a same-name ambiguity.
          references: stored?.references ?? [],
          referenceSlots: stored?.referenceSlots ?? [],
          assetBindings: stored?.assetBindings ?? [],
          selectedResultId: stored?.selectedResultId ?? null,
        };
      }),
      revision: outcome.document.revision,
      documentId: outcome.document.documentId,
      shotIds,
      added: outcome.added,
      removed: outcome.removed,
      ambiguous: outcome.ambiguous,
      changedOnDisk: outcome.changedOnDisk,
    };
  };

  /**
   * Resolve a locator to a block position.
   *
   * Two forms are accepted, and both must keep working: a number, which older callers and
   * the un-migrated path still use, and a `shotId`, which is what survives an insertion.
   * When the project has metadata and a number is given, the number is treated as a
   * POSITION IN THE CURRENT FILE - correct for a click, wrong to persist, which is why the
   * read hands the caller the id alongside it.
   */
  const resolveLocator = async (file, locator) => {
    const text = await fs.readText(file);
    const parts = dissect(text);
    if (Number.isInteger(locator)) {
      // A file with NO `大分镜` heading is exactly one block: the whole text.
      //
      // `splitShotBlocks` (what the panel reads) and `readShots` both report it that way, but
      // `dissect` cannot - it finds blocks by their headings, so it returns none. That asymmetry
      // meant the panel showed an editable block whose save ALWAYS failed with
      // 「there is no 大分镜 1 in the file」. Every compiled H3 prompt is in this shape (it starts at
      // `subject_definitions:` with no heading), so editing an H3 prompt - the one file the user is
      // meant to edit - could never be saved.
      if (parts.blocks.length === 0 && locator === 0) return { text, parts, index: 0, whole: true };
      if (parts.blocks[locator] === undefined) throw new Error(`there is no 大分镜 ${locator + 1} in the file`);
      return { text, parts, index: locator };
    }
    if (typeof locator !== 'string' || locator.length === 0) {
      throw new Error('a block is addressed by its index (a number) or its shotId (a string)');
    }
    if (director === undefined) {
      throw new Error(`this project has no shot metadata, so shotId ${locator} cannot be resolved. Read the file and use the block index, or migrate the project first`);
    }
    // A project whose metadata has never been written is a different situation from one
    // where the id is genuinely unknown, and the remedy is different too. Saying "it may
    // belong to another project" to someone who simply has not migrated yet sends them
    // looking in the wrong place.
    if (!await director.isInitialised()) {
      throw new Error(`this project has not been migrated yet, so it has no shot ids (asked for ${locator}). Run the storyboard migrate action first, or address the block by its index`);
    }
    const found = await director.findShot(locator);
    if (found === undefined) throw new UnknownShotError(`no shot ${locator} in this project; it may belong to another project or have been deleted`, { shotId: locator });
    const index = (await director.locate(locator))?.index;
    // Same whole-file case as above: a heading-less document is recorded as a single shot at
    // position 0, and the panel addresses it by that shot's id. Without this the id path threw
    // "its document no longer has a block at that position" for a file that is perfectly fine.
    if (parts.blocks.length === 0 && index === 0) return { text, parts, index: 0, whole: true };
    if (index === undefined || parts.blocks[index] === undefined) {
      throw new UnknownShotError(`shot ${locator} is recorded but its document no longer has a block at that position; re-read the file to reconcile`, { shotId: locator });
    }
    return { text, parts, index };
  };

  /**
   * Replace one block's body, keeping its heading and the file's own dialect.
   *
   * Rebuilt from the dissected parts rather than by replacing the block's text inside the
   * whole document. `String.replace` with a string pattern rewrites the FIRST occurrence,
   * and two blocks with identical bodies - exactly what the duplicate button produces -
   * would make it edit the wrong one.
   *
   * @param locator - block index (number) or stable shotId (string).
   * @param options.expectedRevision - when given, the document must still be at this
   *   revision or the write is refused. This is the guard against a stale panel
   *   overwriting an edit made elsewhere.
   */
  const writeShotUnlocked = async (filePath, locator, newText, {
    expectedRevision,
    expectedText,
    createIfMissing = false,
    episodeNumber = null,
    blockNumber = null,
  } = {}) => {
    const file = await target(filePath);
    if (createIfMissing === true) {
      // An empty H3 tab is a real card in the panel but deliberately has no file on disk.
      // Only the standard Chinese H3 target for the requested episode/block may be created
      // here, and only when it is genuinely absent. This keeps "create on first edit" from
      // becoming a general-purpose path that a stale client could use to plant arbitrary files.
      if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || !Number.isInteger(blockNumber) || blockNumber < 1) {
        throw new Error('首次创建 H3 需要有效的集数和大分镜编号');
      }
      if (locator !== 0) throw new Error('新建 H3 只能写入该单分镜文件的第 1 块');
      const expectedName = `第${String(episodeNumber)}集H3提示词-大分镜${String(blockNumber)}（中文）.txt`;
      const normalised = String(filePath).replace(/\\/gu, '/');
      const actualName = normalised.split('/').pop() ?? '';
      const episodeFolder = normalised.split('/').slice(-2, -1)[0] ?? '';
      if (actualName !== expectedName || episodeFolder !== `第${String(episodeNumber)}集`) {
        throw new Error(`首次创建 H3 的目标不是标准中文 H3 文件：${actualName || filePath}`);
      }
      if (await fs.stat(file) !== undefined) {
        throw new Error('这个 H3 文件已经存在，请刷新后再编辑；本次没有覆盖原文件');
      }
      const body = String(newText).replace(/\s+$/u, '');
      if (body.trim().length === 0) throw new Error('H3 内容为空，尚未创建文件');
      const next = withH3BlockHeading(body, blockNumber);
      await fs.writeText(file, `${next}\n`, { kind: 'createIfAbsent' }, undefined, policyFor());
      const created = await readShots(filePath);
      return {
        changed: true,
        created: true,
        shots: created.shots,
        revision: created.revision ?? null,
        shotId: created.shots[0]?.shotId ?? null,
      };
    }
    const resolved = await resolveLocator(file, locator);
    const { text, parts, index } = resolved;
    // A heading-less document is written as a whole. There is no heading to preserve and no
    // preamble to keep separate: the file IS the block.
    if (resolved.whole === true) {
      if (typeof expectedText === 'string' && !sameBlockText(text, expectedText)) {
        throw new Error('the file changed since it was read: re-read it and retry');
      }
      const next = String(newText).replace(/\s+$/u, '');
      if (next.length === 0) throw new Error('refusing to empty a file: type something, or delete the file yourself');
      if (text.trimEnd() === next) {
        // A no-op save still has to hand identities back. `reconcile: false` deliberately
        // strips shotIds for presentation-only reads, so using it here made a save that
        // changed nothing erase the card's stable identity and forced the NEXT structural
        // action back onto a positional locator.
        const unchanged = await readShots(filePath);
        return { changed: false, shots: unchanged.shots, revision: unchanged.revision ?? null, shotId: unchanged.shots[0]?.shotId ?? null };
      }
      // `director`/`expectedRevision` were already checked above, before this branch.
      await write(file, `${next}\n`);
      const updated = await readShots(filePath);
      return { changed: true, shots: updated.shots, revision: updated.revision ?? null, shotId: updated.shots[0]?.shotId ?? null };
    }
    const block = parts.blocks[index];
    if (typeof expectedText === 'string' && !sameBlockText(splitShotBlocks(text)[index]?.text, expectedText)) {
      throw new RevisionConflictError('文件已被修改，请重新读取后比较再保存', { relativePath: filePath });
    }

    // A stale panel must not overwrite an edit made elsewhere. The check runs before any
    // write, and against the document's own revision, so the caller learns it is behind
    // instead of losing the other edit.
    if (expectedRevision !== undefined && director !== undefined) {
      const relative = await documentRelativePathFor(filePath);
      const stored = await director.readDocument(relative);
      if (stored !== undefined && stored.revision !== expectedRevision) {
        throw new RevisionConflictError(
          `this document is at revision ${stored.revision}, not ${expectedRevision}: it changed since you read it. Re-read the file, compare, and retry`,
          { relativePath: relative, expected: expectedRevision, actual: stored.revision },
        );
      }
    }

    // The heading is the panel's label: it is what `title` shows and it is NOT part of the
    // text the textarea edits. It stays exactly as the file has it.
    const currentLines = block.lines;
    const hasHeading = isHeadingLine(currentLines[0] ?? '');
    const heading = hasHeading ? currentLines[0] : renderHeading(block, index + 1);

    // A caller may send the body alone (what the panel does) or a body still carrying the
    // heading. Both are accepted, and neither can produce a duplicated heading line.
    const incoming = String(newText).replace(/\s+$/u, '').split('\n');
    const bodyLines = isHeadingLine(incoming[0] ?? '') ? incoming.slice(1) : incoming;
    const before = currentLines.slice(hasHeading ? 1 : 0).join('\n');
    const after = bodyLines.join('\n');
    if (before === after) {
      // Keep the identity contract on the "unchanged" path too. Returning bare shots here is
      // indistinguishable from a migrated project losing every id, and the panel then sends
      // the following insert/delete by index.
      const unchanged = await readShots(filePath);
      return { changed: false, shots: unchanged.shots, revision: unchanged.revision ?? null, shotId: unchanged.shots[index]?.shotId ?? null };
    }

    const nextBlocks = [...parts.blocks];
    nextBlocks[index] = { ...block, lines: [heading, ...bodyLines] };
    await write(file, `${reassemble(parts, nextBlocks, undefined, { renumber: false }).replace(/\s+$/u, '')}\n`);
    // Re-read through the reconciling path, so the returned ids and revision describe the
    // file as it now is rather than as the caller assumed it was.
    const updated = await readShots(filePath);
    return { changed: true, shots: updated.shots, revision: updated.revision ?? null, shotId: updated.shots[index]?.shotId ?? null };
  };

  const writeShot = async (filePath, locator, newText, options = {}) =>
    await withDocumentLock(filePath, () => writeShotUnlocked(filePath, locator, newText, options));

  /**
   * Insert a block after the addressed one, either a copy of it or a blank skeleton.
   *
   * Inserted AFTER the block the user is looking at, because that is where the next shot
   * of the same beat belongs; appending to the end would make the common case - splitting
   * one block into two - a two-step move.
   *
   * The new block gets a NEW shotId (work manual §5.2): a copy is a new shot that happens
   * to start with the same content, not the original shot appearing twice. Existing shots
   * keep their ids and only have their order and display number updated, which is what
   * makes an insert safe for a shot that already has generated results.
   */
  const insertShotUnlocked = async (filePath, locator, kind = 'blank', { expectedRevision, body = null } = {}) => {
    const file = await target(filePath);
    const text = await fs.readText(file);
    const parts = dissect(text);
    const resolvedIndex = Number.isInteger(locator)
      ? locator
      : (await resolveLocator(file, locator)).index;
    const index = resolvedIndex;
    const anchor = parts.blocks[index];
    if (anchor === undefined) {
      // A heading-less document is one whole block; there is no position to insert AFTER, and
      // rewriting it into 大分镜 form on a stray click would restructure the user's file. An H3
      // prompt is one file per 大分镜 anyway, so inserting is meaningless there.
      if (parts.blocks.length === 0) {
        throw new Error(`${basename(filePath)} 没有「大分镜 N」标题，是一份完整文档，不能插入块。H3 提示词是一条大分镜一个文件，本来就不需要再加块。`);
      }
      throw new Error(`there is no 大分镜 ${index + 1} in ${basename(filePath)}`);
    }
    if (expectedRevision !== undefined && director !== undefined) {
      const relative = await documentRelativePathFor(filePath);
      const stored = await director.readDocument(relative);
      if (stored !== undefined && stored.revision !== expectedRevision) {
        throw new RevisionConflictError(
          `this document is at revision ${stored.revision}, not ${expectedRevision}: it changed since you read it`,
          { relativePath: relative, expected: expectedRevision, actual: stored.revision },
        );
      }
    }
    const wanted = kind === 'copy' ? 'copy' : 'blank';

    // A copy keeps the anchor's body verbatim, heading stripped: the body is the prompt
    // text, and it must stay byte-identical so the user can tweak the duplicate instead of
    // rewriting it. Renumbering happens in `reassemble`, by position, so duplicating
    // 大分镜2 never leaves two blocks claiming to be 大分镜2.
    const bodyLines = wanted === 'copy'
      ? anchor.lines.slice(1)
      : (Array.isArray(body) ? body.map(String) : blankBlock());
    // The heading is a placeholder: `reassemble` renumbers every heading from its position,
    // and `headingLevel` keeps the run of `#` the file already uses.
    const inserted = { kind: anchor.kind, level: anchor.level, number: index + 2, lines: [renderHeading(anchor, index + 2, anchor.level), ...bodyLines] };

    const nextBlocks = [...parts.blocks];
    nextBlocks.splice(index + 1, 0, inserted);
    // The gap is copied from a neighbour, so a file that separates blocks with a `---` rule
    // keeps exactly that rhythm. The neighbour is the gap AFTER the anchor when there is one,
    // otherwise the gap BEFORE it - appending after the last block must not silently drop the
    // rule that every other block has.
    const gap = parts.separators[index] ?? parts.separators[index - 1] ?? '\n\n';
    const separators = [...parts.separators];
    separators.splice(index, 0, gap);

    await write(file, `${reassemble(parts, nextBlocks, separators).replace(/\s+$/u, '')}\n`);
    // A fresh insert needs NEW ids for the new block while every existing shot keeps its
    // own. `setShots` is used rather than reconciliation here because the id set is already
    // known: the file's blocks minus the inserted one are exactly the recorded shots in
    // their recorded order, and re-deriving that from anchors would risk mistaking the
    // inserted copy for the shot it was copied from.
    if (director !== undefined) {
      const relative = await documentRelativePathFor(filePath);
      const after = await fs.readText(file);
      const described = describeBlocks(after);
      const stored = await director.readDocument(relative);
      if (stored !== undefined) {
        const before = stored.shots.map((shot) => shot.shotId);
        const next = described.map((block, position) => {
          // Everything at or after the insertion point shifted by one; the inserted slot is
          // the only genuinely new identity.
          const sourceIndex = position <= index ? position : position - 1;
          const reused = position === index + 1 ? undefined : before[sourceIndex];
          return { shotId: reused ?? newShotId(), anchor: block.anchor, occurrence: 0 };
        });
        await director.setShots(relative, next, { fileHash: hashText(after) });
        if (wanted === 'copy' && stored.shots[index]?.shotId !== undefined && next[index + 1]?.shotId !== undefined) {
          await director.copyShotBindings(relative, stored.shots[index].shotId, next[index + 1].shotId);
        }
      }
    }
    const updated = await readShots(filePath);
    return { changed: true, insertedAt: index + 1, kind: wanted, shots: updated.shots, revision: updated.revision ?? null, shotId: updated.shots[index + 1]?.shotId ?? null };
  };

  const insertShot = async (filePath, locator, kind = 'blank', options = {}) =>
    await withDocumentLock(filePath, () => insertShotUnlocked(filePath, locator, kind, options));

  /**
   * Remove one block and keep all remaining identities stable.
   *
   * Structural deletion is deliberately explicit and revision-guarded. The removed text is
   * archived in project metadata before the file is rewritten, so an accidental click can be
   * investigated without keeping the deleted block visibly alive in the prompt file.
   */
  const deleteShotUnlocked = async (filePath, locator, { expectedRevision } = {}) => {
    const file = await target(filePath);
    const text = await fs.readText(file);
    const parts = dissect(text);
    const resolved = Number.isInteger(locator)
      ? { index: locator, whole: parts.blocks.length === 0 && locator === 0 }
      : await resolveLocator(file, locator);
    const index = resolved.index;
    if (index < 0) throw new Error('要删除的分镜位置无效');

    let deleted;
    let nextText;
    let nextIds = null;
    let relative = null;
    if (resolved.whole === true) {
      deleted = { text, heading: '', shotId: null, index: 0 };
      nextText = '';
    } else {
      const anchor = parts.blocks[index];
      if (anchor === undefined) throw new Error(`there is no 大分镜 ${index + 1} in ${basename(filePath)}`);
      deleted = {
        text: withHeading(anchor, index + 1),
        heading: anchor.lines[0] ?? '',
        shotId: null,
        index,
      };
      const nextBlocks = parts.blocks.filter((_, position) => position !== index);
      const separators = [...parts.separators];
      if (separators.length > 0) separators.splice(Math.min(index, separators.length - 1), 1);
      nextText = nextBlocks.length === 0
        ? ''
        : `${reassemble(parts, nextBlocks, separators).replace(/\s+$/u, '')}\n`;
    }

    if (director !== undefined) relative = await documentRelativePathFor(filePath);
    let stored = null;
    if (director !== undefined && relative !== null) {
      stored = await director.readDocument(relative);
      deleted.shotId = stored?.shots?.[index]?.shotId ?? null;
    }
    if (expectedRevision !== undefined && stored !== undefined && stored !== null && stored.revision !== expectedRevision) {
      throw new RevisionConflictError(
        `this document is at revision ${stored.revision}, not ${expectedRevision}: it changed since you read it`,
        { relativePath: relative, expected: expectedRevision, actual: stored.revision },
      );
    }

    await write(file, nextText);
    if (director !== undefined && stored !== undefined && stored !== null) {
      const before = stored.shots.map((shot) => shot.shotId);
      nextIds = before.filter((_, position) => position !== index);
      const described = describeBlocks(nextText);
      await director.setShots(relative, nextIds.map((shotId, position) => ({
        shotId,
        anchor: described[position]?.anchor ?? `deleted-neighbour-${position}`,
        occurrence: 0,
      })), { fileHash: hashText(nextText) });
      if (deleted.shotId !== null) {
        await director.archiveShot(relative, deleted.shotId, {
          text: deleted.text,
          heading: deleted.heading,
          fileName: basename(filePath),
          index,
        });
      }
    }

    const updated = await readShots(filePath);
    return {
      changed: true,
      deletedAt: index,
      deletedShotId: deleted.shotId,
      shots: updated.shots,
      revision: updated.revision ?? null,
    };
  };

  const deleteShot = async (filePath, locator, options = {}) =>
    await withDocumentLock(filePath, () => deleteShotUnlocked(filePath, locator, options));

  return {
    browse,
    deleteShot,
    files,
    insertShot,
    listEpisodes,
    listProjects,
    readShots,
    scanProjects,
    writeShot,
    /** The metadata store, or undefined when this project has not been migrated. */
    director,
    /** Exposed so the migration action can address files the same way a read does. */
    relativeToRoot,
    documentKindOf,
  };
}

