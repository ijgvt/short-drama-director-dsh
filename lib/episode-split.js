/**
 * Split an episode's 直出视频提示词 into one self-contained document per 大分镜.
 *
 * ## Why the episode file has to be split at all
 *
 * The writing skill already says the H3 output is "one MiniMax H3 prompt per 大分镜", because H3
 * generates 4-15 seconds at a time. What was missing is the other half: the 视频提示词 it is compiled
 * FROM was still one document per episode, so the two did not line up - and the panel showed one
 * block of H3 for a whole episode while the compile step had nothing per-大分镜 to read.
 *
 * Once each 大分镜 has its own file, "H3 是大分镜翻译成 H3 格式" becomes literally true: N 大分镜 in,
 * N H3 files out, in the same order, about the same assets.
 *
 * ## What "self-contained" means here
 *
 * Each output file repeats the `【人物映射】/【场景映射】/【道具映射】` for the assets THAT 大分镜 uses,
 * with the `@` kept. That repetition is the point rather than duplication to be factored out:
 *
 *   - the panel can show one 大分镜 on its own and still have its `@` references to resolve;
 *   - the compile step reads one file and gets one H3 prompt, with no need to look at its siblings;
 *   - the prompt-writing rules already require the mapping to be per-大分镜 ("仅本大分镜出场人物"), so
 *     this is the shape the writer was asked for all along.
 *
 * @module dsh-plugin-short-drama-director/lib/episode-split
 */

import { describeBlocks, splitShotBlocks } from './storyboard.js';
import { readAssetMapping, assetsUsedBy } from './h3-compile.js';

/**
 * Cut a block's body at the next top-level section heading.
 *
 * The parser ends a block at the NEXT 大分镜 heading, so the LAST block's body runs to the end of the
 * file and swallows whatever follows it - in a real document, the `## 三、自检` section. That section
 * is the writer's own checklist, addressed to the whole episode, and it is also where a stray `@`
 * tends to live; carrying it into every split file put the checklist into 大分镜2 and the stray `@` into
 * its compiled H3 prompt, which the model is then handed.
 *
 * A `##` heading after the 分镜 section is by definition a new section, so the body ends there.
 */
function cutAtNextSection(body) {
  const lines = String(body ?? '').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    // Only a top-level heading, and only after the block's own content has begun - the block's own
    // `### 大分镜 N` heading is not part of `body` in the first place.
    if (/^\s*##(?!#)\s*\S/u.test(line)) return lines.slice(0, index).join('\n');
  }
  return lines.join('\n');
}

/** One mapping section, with `@` kept, listing only the assets this block uses. */
function mappingSection(title, entries, referenceFor) {
  if (entries.length === 0) return null;
  return [title, ...entries.map((entry) => referenceFor(entry))].join('\n');
}

/**
 * Remove mapping sections that were already present inside a source block.
 *
 * The canonical 视频提示词 puts mapping before the first shot, but the professional
 * format places it after `【光线与色温设定】` / `【场景索引】`. Slicing at
 * `【初始站位】` therefore missed that format and then appended a second mapping at the top:
 * the generated block file contained two copies of every mapping section.
 *
 * Mapping is the one thing the splitter regenerates deterministically, so remove those
 * sections from the body and write the canonical copy once. Every other section - lighting,
 * scene character, staging and shot sequence - is preserved in its original order.
 */
function stripMappingSections(text) {
  const output = [];
  let skipping = false;
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^【(?:人物|场景|道具|其他参考图片|参考视频|参考音频|参考媒体)映射】/u.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      const startsSection = /^\s*(?:【|#{1,6}\s)/u.test(line);
      if (trimmed.length === 0 || !startsSection) continue;
      skipping = false;
    }
    output.push(line);
  }
  return output.join('\n');
}

/**
 * Split one episode document.
 *
 * @param text - the 直出视频提示词, in either shape: a single 资产映射 at the top, or one per 大分镜.
 *   Reading is tolerant because both exist in the wild; WRITING is always per-大分镜, which is the
 *   format this function exists to produce.
 * @param options.episodeTitle - used for the header line of each output file.
 * @returns `{ documents, mapping, unusedMapping }` where each document is
 *   `{ blockNumber, seconds, fileName, text, assets }`.
 */
export function splitEpisodePrompt(text, { episodeTitle = null, episodeNumber = 1, style = null } = {}) {
  // Exported for the caller that only wants the body boundaries; the split itself is below.
  const source = String(text ?? '');
  const episodeMapping = readAssetMapping(source);
  const structural = describeBlocks(source);
  const presentational = splitShotBlocks(source);
  const hasMapping = (mapping) => (mapping?.byName?.size ?? 0) > 0;

  // The episode-level mapping is the fallback: a file that declares an asset at the top and uses it in
  // several 大分镜 still gets that asset in each of their mappings, because a block that does not name
  // its own props cannot be compiled or previewed on its own.
  const seen = new Set();
  const documents = structural.map((block, index) => {
    const shown = presentational[index];
    const originalBody = cutAtNextSection(shown?.text ?? block.body);
    let body = stripMappingSections(originalBody).trim();
    const styleLine = /【画面风格和类型】[^\n]*/u.exec(originalBody)?.[0]
      ?? /【画面风格和类型】[^\n]*/u.exec(shown?.preamble ?? '')?.[0]
      ?? (style ? `【画面风格和类型】${style}` : null);
    // The style line is emitted once below. Some source formats keep it at the top of the
    // body, so remove that original occurrence instead of carrying a second style paragraph.
    if (styleLine !== null) body = body.replace(styleLine, '').trimStart();
    const merged = { index: block.order, sourceNumber: block.sourceNumber, seconds: shown?.seconds ?? null, text: body };
    // Parse THIS block's mapping first. A whole-episode merge cannot tell `周砚（戏服）` in
    // block 1 from `周砚` in block 2: the two declarations collapse onto one base name and the
    // costume reading disappears. The episode mapping is only a fallback for older files that
    // declare one shared mapping before the first block.
    const blockMapping = readAssetMapping(shown?.text ?? block.body);
    const mappingForBlock = hasMapping(blockMapping) ? blockMapping : episodeMapping;
    const used = assetsUsedBy(body, mappingForBlock.byName, mappingForBlock.aliases, mappingForBlock.referenceFor);
    for (const entry of used) seen.add(entry.name);

    const kindOf = (name) => mappingForBlock.byName.get(name);
    const referenceFor = (entry) => {
      const declared = [
        ...mappingForBlock.characters,
        ...mappingForBlock.scenes,
        ...mappingForBlock.props,
        ...mappingForBlock.referenceImages,
        ...mappingForBlock.referenceVideos,
        ...mappingForBlock.referenceAudios,
        ...mappingForBlock.referenceMedia,
      ].find((item) => item.name === entry.name);
      // The writer's own line is reused verbatim when it exists, so a hand-written suffix such as
      // `夜/内景` or a declared alias is not lost by being reconstructed.
      if (declared !== undefined) return declared.line;
      return kindOf(entry.name) === 'character' ? `${entry.name}（形象及服装参考: @${entry.name}）` : `${entry.name}（参考: @${entry.name}）`;
    };

    const sections = [
      mappingSection('【人物映射】', used.filter((entry) => entry.kind === 'character'), referenceFor),
      mappingSection('【场景映射】', used.filter((entry) => entry.kind === 'scene'), referenceFor),
      mappingSection('【道具映射】', used.filter((entry) => entry.kind === 'prop'), referenceFor),
      mappingSection('【其他参考图片映射】', used.filter((entry) => entry.kind === 'reference-image'), referenceFor),
      mappingSection('【参考视频映射】', used.filter((entry) => entry.kind === 'reference-video'), referenceFor),
      mappingSection('【参考音频映射】', used.filter((entry) => entry.kind === 'reference-audio'), referenceFor),
      mappingSection('【参考媒体映射】', used.filter((entry) => entry.kind === 'reference-media'), referenceFor),
    ].filter((section) => section !== null);

    const number = block.sourceNumber ?? block.order + 1;
    // No `# 第N集 - 大分镜 M` title and no `### 大分镜 M（总时长…）` heading.
    //
    // A split file IS one 大分镜, and the filename already says which one; the two heading lines
    // only repeated that and pushed the prompt down the file. The user asked for them gone, with the
    // reference format being 测试短剧, where a block starts at 【画面风格和类型】/【人物映射】.
    //
    // `【大分镜N】` IS kept: it is the block's own label in that same reference format, and it is
    // what makes the file a proper one-block document rather than a heading-less blob.
    const parts = [
      `【大分镜${String(number)}】`,
      ...(styleLine ? [styleLine] : []),
      ...sections,
      body.trim(),
    ];
    return {
      blockNumber: number,
      seconds: merged.seconds,
      assets: used.map((entry) => ({ name: entry.name, kind: entry.kind })),
      fileName: videoPromptFileName(episodeNumber, number),
      text: `${parts.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`,
    };
  });

  return {
    documents,
    mapping: episodeMapping,
    unusedMapping: [...episodeMapping.byName.keys()].filter((name) => !seen.has(name)),
  };
}

/**
 * A stable filename per 大分镜, so a re-split overwrites rather than accumulates.
 *
 * Carries the episode number because the source rules match on `第N集` - a file named only
 * `大分镜1视频提示词.txt` is invisible to the panel, which is how a freshly split file can exist on
 * disk and still not be offered.
 */
export function videoPromptFileName(episodeNumber, blockNumber) {
  return `第${String(episodeNumber)}集大分镜${String(blockNumber)}视频提示词.txt`;
}

/**
 * Whether a document is already a single-大分镜 file rather than a whole episode.
 *
 * Used to decide whether splitting is needed at all: re-splitting an already-split file would rename
 * 大分镜3 to 大分镜1, which is how a careless pass loses the numbering.
 */
export function isSingleBlockPrompt(text) {
  return describeBlocks(String(text ?? '')).length <= 1;
}
