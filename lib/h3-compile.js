/**
 * Compile a 直出视频提示词 into MiniMax H3 prompts - one per 大分镜.
 *
 * ## The division of labour this module implements
 *
 * The two files have different jobs, and conflating them is what made this hard to see:
 *
 *   - **视频提示词** is what the USER edits. It is one document per episode, it declares its cast and
 *     props once in `【人物映射】/【场景映射】/【道具映射】` using `@资产名`, and it reads like a script.
 *     The `@` exists so editing is easy: it is a name you can search for and a picker can complete.
 *   - **H3 提示词** is what the MODEL is fed. It does not use `@` at all - it has its own mapping
 *     (`<Subject N>` / `<Picture N>`) because the workflow needs a NUMBER per reference image slot,
 *     not a name. And it is compiled **per 大分镜**, because H3 generates 4-15 seconds at a time.
 *
 * So the conversion is a COMPILE step, not a reformat: names become numbers, and one document becomes
 * one prompt per 大分镜 with its own subject table.
 *
 * ## Why the mapping is recomputed per 大分镜
 *
 * `<Picture 1>` is whichever image is uploaded first for THAT prompt. If 大分镜2 does not use a prop
 * that 大分镜1 did, carrying the episode-wide numbering over would upload an image the prompt never
 * mentions and shift every number after it - so each 大分镜 gets a contiguous table built from what
 * its own text actually refers to.
 *
 * @module dsh-plugin-short-drama-director/lib/h3-compile
 */

// `describeBlocks` carries the structure (sourceNumber, heading, body, anchor) and `splitShotBlocks`
// carries the parsed duration and the body the panel shows. They walk the same text, so their arrays
// are index-aligned; pairing them is how a compiled prompt gets both without re-parsing.
import { describeBlocks, splitShotBlocks, withH3BlockHeading } from './storyboard.js';
import { parseMentions } from './reference-service.js';

/** The 映射 sections a 视频提示词 declares, and the asset kind each one names. */
export const MAPPING_SECTIONS = Object.freeze([
  { heading: '【人物映射】', kind: 'character', role: 'character' },
  { heading: '【场景映射】', kind: 'scene', role: 'scene' },
  { heading: '【道具映射】', kind: 'prop', role: 'prop' },
  { heading: '【其他参考图片映射】', kind: 'reference-image', role: 'reference' },
  { heading: '【参考视频映射】', kind: 'reference-video', role: 'reference' },
  { heading: '【参考音频映射】', kind: 'reference-audio', role: 'reference' },
  { heading: '【参考媒体映射】', kind: 'reference-media', role: 'reference' },
]);

/**
 * Pull the `@资产名` out of one 映射 line.
 *
 * The line is `林晚（形象及服装参考: @林晚）`, so the NAME for the subject table is the one before the
 * bracket and the REFERENCE is the `@` one. They are usually the same word; when they differ, the
 * bracket form is what the writer wants read out.
 */
const mapLine = (line) => {
  const text = String(line ?? '').trim();
  if (text.length === 0) return null;
  const mention = parseMentions(text)[0];
  if (mention === undefined) return null;
  const before = text.split(/[（(]/u)[0].trim();
  // Aliases, declared by the writer.
  //
  // Needed because the prose names the THING while the mapping names the ASSET, and the two need not
  // overlap: 大分镜1 says 「老周把牛皮纸袋往前递」 for the mapped asset 外卖袋, and 牛皮纸袋 does not
  // contain 外卖袋 even as a substring - 纸|袋 are not adjacent in it. Nothing can infer that, so
  // it is declared:
  //
  //     外卖袋（道具外观参考：@外卖袋｜别名：牛皮纸袋、纸袋）
  //
  // Without a declaration the asset is reported as unused rather than silently substituted. An
  // honest report is answerable; a wrong upload order produces a wrong video with no clue why.
  const aliasPart = /(?:别名|aliases?)\s*[:：]\s*([^）)]*)/iu.exec(text)?.[1] ?? '';
  const aliases = aliasPart.split(/[、,，|｜]/u).map((entry) => entry.trim()).filter((entry) => entry.length >= 2);
  // The `@` reference is the authority, because it can name a COSTUME VARIANT
  // (`@林晚（家居服）`). The leading label is often just the base name; using it as the
  // subject name collapsed every costume back to the person and made H3 bind the wrong
  // four-view. Keep the full mention text here.
  return {
    name: mention.name,
    reference: mention.name,
    displayName: before.length > 0 ? before : mention.name,
    aliases,
    line: text,
  };
};

/**
 * Read the episode-wide `@资产名` table from a 视频提示词.
 *
 * The mapping section is the only place `@` is allowed (the prompt-writing rules say so explicitly:
 * "除此之外的任何位置一律写不带 @ 的资产名"), which is what makes this a reliable read rather than a
 * guess - anything after `## 二、分镜` is prose and is not scanned for references here.
 *
 * @returns `{ characters, scenes, props, byName }` where `byName` maps an asset name to its kind, for
 *   finding which assets one 大分镜 actually mentions.
 */
export function readAssetMapping(text) {
  const source = String(text ?? '');
  // Everything before the 分镜 section. A file without that heading is scanned whole, because the
  // mapping may still be there and refusing to read it would be worse than reading a little prose.
  const splitAt = source.search(/\n#{1,6}\s*[二三][、.]\s*(?:分镜|自检)/u);
  const head = splitAt < 0 ? source : source.slice(0, splitAt);
  const lines = head.split(/\r?\n/u);

  const tables = { characters: [], scenes: [], props: [], referenceImages: [], referenceVideos: [], referenceAudios: [], referenceMedia: [] };
  const keyOf = { '【人物映射】': 'characters', '【场景映射】': 'scenes', '【道具映射】': 'props', '【其他参考图片映射】': 'referenceImages', '【参考视频映射】': 'referenceVideos', '【参考音频映射】': 'referenceAudios', '【参考媒体映射】': 'referenceMedia' };
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = Object.keys(keyOf).find((entry) => trimmed.startsWith(entry));
    if (heading !== undefined) {
      current = keyOf[heading];
      // Writers often put the first row on the heading line:
      // `【人物映射】林晚（参考: @林晚）`. Treating that line as heading-only silently dropped
      // the row, so the split document existed but compiled to "no assets referenced".
      const inline = trimmed.slice(heading.length).trim();
      if (inline.length > 0) {
        const entry = mapLine(inline);
        if (entry !== null) tables[current].push(entry);
      }
      continue;
    }
    // A new section heading ends the current table, so a stray @ later cannot join it.
    if (/^#{1,6}\s|^【/u.test(trimmed) && heading === undefined) { current = null; continue; }
    if (current === null) continue;
    const entry = mapLine(trimmed);
    if (entry !== null) tables[current].push(entry);
  }

  // A split episode repeats its mapping sections in every 大分镜. Counting those rows as if
  // they were distinct assets made a five-character episode report "13 characters". The
  // episode-wide table is a set of asset names; aliases are merged without duplicating a name.
  for (const bucket of Object.keys(tables)) {
    const unique = new Map();
    for (const entry of tables[bucket]) {
      const existing = unique.get(entry.name);
      if (existing === undefined) {
        unique.set(entry.name, { ...entry, aliases: [...(entry.aliases ?? [])] });
        continue;
      }
      existing.aliases = [...new Set([...(existing.aliases ?? []), ...(entry.aliases ?? [])])];
    }
    tables[bucket] = [...unique.values()];
  }

  const aliases = new Map();
  const byName = new Map();
  for (const [bucket, kind] of [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop'], ['referenceImages', 'reference-image'], ['referenceVideos', 'reference-video'], ['referenceAudios', 'reference-audio'], ['referenceMedia', 'reference-media']]) {
    for (const entry of tables[bucket]) {
      if (!byName.has(entry.name)) byName.set(entry.name, kind);
      if ((entry.aliases ?? []).length > 0) aliases.set(entry.name, entry.aliases);
    }
  }
  /**
   * A body may write the person's base name while the mapping names the costume:
   * `林晚 站在门口` with `林晚（家居服）（参考：@林晚（家居服））`. When exactly ONE
   * variant of a base is declared and no explicit base entry exists, that base mention
   * means the variant. With two or more variants, the base alone is ambiguous, and the
   * compiler must not silently pick one.
   */
  const referenceFor = new Map();
  const explicitNames = new Set(byName.keys());
  const variantCounts = new Map();
  for (const name of byName.keys()) {
    const parsed = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]$/u.exec(name);
    if (parsed !== null) variantCounts.set(parsed[1], (variantCounts.get(parsed[1]) ?? 0) + 1);
  }
  for (const name of byName.keys()) {
    const parsed = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]$/u.exec(name);
    if (parsed !== null && !explicitNames.has(parsed[1]) && variantCounts.get(parsed[1]) === 1) {
      referenceFor.set(parsed[1], name);
    }
  }
  return { ...tables, byName, aliases, referenceFor };
}

/**
 * Which of an episode's assets one 大分镜 actually refers to.
 *
 * Matched by NAME APPEARING IN THE TEXT, which is how the prompt format works: the rules require
 * every asset used to be written out by name in 【初始站位】 and 【画面】 ("画面里有的就要写出来，不许漏写").
 * So a name in the body IS a reference, and a name absent from the body is not used by this 大分镜.
 *
 * Longest name first, so `深夜公寓玄关` is found before a shorter name that happens to be its substring.
 */
export function assetsUsedBy(blockText, byName, aliases = new Map(), referenceFor = new Map()) {
  const text = String(blockText ?? '');
  // Longest first, so a longer name is credited before a shorter one that happens to sit inside it.
  const names = [...new Set([...byName.keys(), ...referenceFor.keys()])].sort((a, b) => b.length - a.length);
  const used = [];
  const seen = new Set();
  for (const name of names) {
    const subjectName = referenceFor.get(name) ?? name;
    if (seen.has(subjectName)) continue;
    const kind = byName.get(subjectName) ?? byName.get(name);
    if (text.includes(name)) {
      used.push({ name: subjectName, kind, matchedBy: name });
      seen.add(subjectName);
      continue;
    }
    // An alias the writer declared, e.g. 外卖袋 declared as also being written 牛皮纸袋.
    for (const alias of (aliases.get(subjectName) ?? aliases.get(name) ?? [])) {
      if (alias.length >= 2 && text.includes(alias)) {
        used.push({ name: subjectName, kind, matchedBy: alias });
        seen.add(subjectName);
        break;
      }
    }
  }
  return used;
}

/**
 * The block body for name matching, with mapping rows removed.
 *
 * Mapping rows contain `@资产名` by definition. Including them in `assetsUsedBy` made every mapped
 * asset look as if it appeared in the action, even when the shot never used it, and hid the
 * distinction between a local extra-reference upload and a subject mentioned in the scene.
 */
function bodyWithoutMappings(text) {
  const kept = [];
  let inMapping = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*【[^】]*映射】/u.test(line)) {
      inMapping = true;
      continue;
    }
    if (/^\s*【/u.test(line)) inMapping = false;
    if (!inMapping) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Asset names a 大分镜 uses but no mapping entry covers.
 *
 * Found by looking for the SHAPE of an asset name rather than the names themselves: a 2-6 character
 * noun phrase inside 【拍摄主体】 is how this format writes what is on screen. Anything found there
 * that is not a mapped name is reported, because the prompt rules require every asset to be written
 * by its mapped name - so a mismatch is either a typo in the prose or an asset missing from the
 * mapping, and both are worth knowing before a generation rather than after.
 *
 * Deliberately a REPORT and not a guess: 大分镜1 says 「老周把牛皮纸袋往前递」 for the mapped asset 外卖袋,
 * and nothing in the text connects 牛皮纸袋 to 外卖袋 - the words do not overlap even as substrings. An
 * honest "this block names something the mapping does not" is answerable; a silent substitution is not.
 */
export function unmappedSubjects(blockText, byName, referenceFor = new Map()) {
  const text = String(blockText ?? '');
  const at = text.indexOf('【拍摄主体】');
  const subjects = at < 0 ? '' : (text.slice(at + '【拍摄主体】'.length).split('\n')[0] ?? '');
  const named = subjects.split(/[、,，]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return named.filter((entry) => {
    if (byName.has(entry)) return false;
    // A mapping may declare the costume only (`@林晚（家居服）`) while the shot
    // writes the person's base name. That is covered only when the mapping made
    // the reading unambiguous, which is what referenceFor records.
    if (referenceFor.has(entry)) return false;
    for (const name of byName.keys()) if (entry.includes(name)) return false;
    return true;
  });
}


/**
 * 功能参考: an extra reference the block asks for by its FUNCTION, not by its role in the cast.
 *
 * The writer may put `初始位置参考：@外卖袋` or `音频参考：@林川（音色）` in 【初始站位】 or inside a 分镜.
 * The name only has to resolve to a FILE - what matters is the picture/audio and what it is FOR.
 * A recognised label gets a standard sentence; an unrecognised one is carried through in the
 * writer's own words, because inventing a role is worse than repeating theirs.
 */
const FUNCTIONAL_REFERENCE_ROLES = Object.freeze([
  { match: /初始位置|初始站位|站位/u, media: 'Picture', zh: '规定本大分镜的初始位置与人物相对关系', en: 'defines the initial blocking and the relative positions in this block' },
  { match: /走位/u, media: 'Picture', zh: '规定本大分镜的走位路径', en: 'defines the blocking path in this block' },
  { match: /轴线/u, media: 'Picture', zh: '规定本大分镜的轴线关系，避免越轴', en: 'defines the camera axis for this block' },
  { match: /构图|取景/u, media: 'Picture', zh: '规定本大分镜的构图与取景', en: 'defines the composition and framing of this block' },
  { match: /服装|造型|妆造/u, media: 'Picture', zh: '沿用同一套服装与造型', en: 'carries the same costume and styling' },
  { match: /光影|光线|布光/u, media: 'Picture', zh: '规定本大分镜的光线方向与质感', en: 'defines the lighting direction and texture' },
  { match: /音色|声音|配音|旁白|音频/u, media: 'Audio', zh: '作为音色与声音质感参考', en: 'is a voice-timbre and sound-texture reference' },
  // 参考视频 has its own upload slot: `运镜参考：@某片段` must become `<Video 1>`, never a picture.
  { match: /运镜|镜头运动|镜头节奏|视频/u, media: 'Video', zh: '作为镜头运动与节奏参考', en: 'is a camera-movement and pacing reference' },
]);

/** The role for a label, or `null` when the writer's own words have to carry it. */
export function functionalReferenceRole(label) {
  const text = String(label ?? '');
  for (const entry of FUNCTIONAL_REFERENCE_ROLES) if (entry.match.test(text)) return entry;
  return null;
}

/**
 * Every `<功能>参考：@名字` in a block, in the order it appears.
 *
 * Deliberately tolerant: any run of non-punctuation before 「参考」 is the label. A mention may
 * carry one balanced qualifier, because `@林川（音色）` names a function-only reading while
 * `@林晚（家居服）` names a real costume variant; the caller decides which qualifier to keep.
 */
export function functionalReferences(text) {
  const found = [];
  const pattern = /([^\s，。；、：:【】]{1,14}?参考)\s*(?:[：:]\s*)*@([\p{L}\p{N}·・\-_.]+(?:[（(][^）)\n]*[）)])?)/gu;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const label = match[1].trim();
    const name = parseMentions(`@${match[2]}`)[0]?.name ?? match[2].trim();
    if (name.length === 0) continue;
    if (found.some((entry) => entry.name === name && entry.label === label)) continue;
    found.push({ label, name, role: functionalReferenceRole(label) });
  }
  return found;
}

/**
 * Compile one 大分镜 into an H3 prompt.
 *
 * The output is deliberately SKELETAL where the model's own judgement is required: `summary`,
 * `retention_analysis` and `detailed_description` need the shot-by-shot prose an H3 prompt is, and
 * inventing that here would be inventing the user's creative work. What this builds exactly is the
 * part that is mechanical and easy to get wrong - the subject table and the picture numbering - and
 * it carries the block's own text through so the writing has everything it needs.
 *
 * @param options.block - one 大分镜 from `splitShotBlocks`.
 * @param options.used - the assets this block refers to, in mapping order.
 * @param options.style - the locked style line (画风), which H3 keeps per prompt.
 */
export function compileBlockToH3({ block, used = [], style = null, language = 'zh', mediaTypes = {}, knownNames = null, functionalEntries = [] } = {}) {
  const counts = { Picture: 0, Video: 0, Audio: 0 };
  const subjects = used.map((entry) => {
    const mediaType = entry.kind === 'reference-video' ? 'Video' : entry.kind === 'reference-audio' ? 'Audio' : entry.kind === 'reference-media' ? mediaTypes[entry.name] : 'Picture';
    if (!['Picture', 'Video', 'Audio'].includes(mediaType)) throw new Error(`参考媒体「${entry.name}」缺少音频/视频类型，无法生成 H3 映射`);
    const number = ++counts[mediaType];
    return { subject: mediaType === 'Picture' ? number : null, picture: mediaType === 'Picture' ? number : null,
      ...(mediaType === 'Picture' ? {} : { mediaType, referenceIndex: number }),
      name: entry.name, kind: entry.kind,
      ...(mediaType === 'Audio' && typeof entry.voiceFor === 'string' && entry.voiceFor.length > 0
        ? { voiceFor: entry.voiceFor }
        : {}),
      label: `<${mediaType === 'Picture' ? 'Subject' : mediaType} ${number}>` };
  });
  /**
   * 功能参考: extra references the block asks for by function (`初始位置参考：@外卖袋`).
   *
   * They are NOT cast members, so they get no `<Subject N>` - just a numbered reference and the
   * sentence that says what they are FOR. The number continues the same counters, so the upload order
   * stays the order the prompt declares.
   */
  const annotations = (() => {
    // A name may be written with a qualifier — `外卖袋（音色）`, `外卖袋｜别名` — and a qualifier must not
    // turn one asset into two references. Compare on the bare name, and against aliases too.
    //
    // Dedupe is keyed by MEDIA TYPE + name, not by name: a person already in the picture mapping can
    // still need a separate AUDIO reference, while the same audio asset must not be added twice.
    const known = new Set();
    for (const subject of subjects) known.add(`${subject.mediaType ?? 'Picture'}:${subject.name}`);
    for (const entry of used) {
      const media = entry.kind === 'reference-video' ? 'Video' : entry.kind === 'reference-audio' ? 'Audio' : entry.kind === 'reference-media' ? mediaTypes[entry.name] : 'Picture';
      for (const alias of entry.aliases ?? []) known.add(`${media}:${alias}`);
    }
    const base = (value) => String(value).split(/[（(｜|、，,]/u)[0].trim();
    /**
     * Keep a costume qualifier, but drop a qualifier that only describes how the
     * asset is being used. `@林晚（家居服）` is a different four-view; `@林川（音色）`
     * is the same asset used as an audio reference. The library is the authority
     * when available; the role-based fallback only handles the classic 音色 form.
     */
    const referenceName = (entry) => {
      const raw = String(entry.name ?? '').trim();
      const bare = base(raw);
      if (knownNames !== null && knownNames !== undefined && knownNames.has(raw)) return raw;
      const qualifier = /[（(]\s*([^）)]*?)\s*[）)]\s*$/u.exec(raw)?.[1] ?? '';
      const functionOnly = entry.role?.media === 'Audio' && /音色|声音|配音|旁白|音频/u.test(qualifier);
      return functionOnly ? bare : raw;
    };
    /**
     * A functional reference must name something that EXISTS.
     *
     * `初始位置参考：@楼道灯` on a project with no 楼道灯 asset used to emit
     * `<Picture 4> 是 楼道灯 的参考，…`, which binds to nothing - so generation refused the prompt the
     * compiler had just produced, and the message pointed at the reference rather than at the typo.
     * When the caller knows the library (`knownNames`), an unknown name is left as plain prose and
     * reported instead of becoming a reference. Without `knownNames` the old behaviour is kept, so a
     * caller that has no library does not silently lose references.
     */
    const isKnown = (name) => knownNames === null || knownNames === undefined || knownNames.has(name);
    /**
     * Only the BODY is scanned: a mapping section's own lines (`雨声（声音参考：@雨声）` inside
     * 【参考媒体映射】) also match the 「XX参考：@Y」 shape, and reading them here turned one audio
     * reference into two. The mapping is already handled by `used`; this scanner is for the writer
     * asking for an extra reference in 【初始站位】 or inside a 分镜.
     */
    const bodyOnly = (value) => {
      const kept = [];
      let inMapping = false;
      for (const line of String(value).split('\n')) {
        if (/^\s*【[^】]*映射】/u.test(line)) { inMapping = true; continue; }
        if (/^\s*【/u.test(line)) inMapping = false;
        if (!inMapping) kept.push(line);
      }
      return kept.join('\n');
    };
    const seen = new Set();
    return [
      ...functionalReferences(bodyOnly(block?.text ?? '')),
      ...(Array.isArray(functionalEntries) ? functionalEntries : []),
    ]
      .map((entry) => ({ ...entry, name: referenceName(entry) }))
      .filter((entry) => {
        const media = entry.role?.media ?? 'Picture';
        const key = `${media}:${entry.name}`;
        if (entry.name.length === 0 || !isKnown(entry.name) || known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();
  const functional = annotations.map((entry) => {
    const mediaType = entry.role?.media ?? 'Picture';
    const number = ++counts[mediaType];
    const targetSubject = mediaType === 'Audio'
      ? subjects.find((subject) => !subject.mediaType && (
        subject.name === entry.name
        || entry.label.includes(subject.name)
        || entry.name.includes(subject.name)
      ))
      : undefined;
    return {
      annotation: entry,
      mediaType,
      number,
      label: `<${mediaType} ${number}>`,
      target: targetSubject === undefined ? entry.name : `<Subject ${String(targetSubject.subject)}>`,
      // The writer's own words when the label is not in the vocabulary: repeating them is honest,
      // inventing a role is not.
      roleZh: entry.role?.zh ?? `作为${entry.label.replace(/参考$/u, '')}依据`,
      roleEn: entry.role?.en ?? `serves as the ${entry.label} for this block`,
      name: entry.name,
    };
  });

  const labelled = subjects.map((entry) => entry.mediaType ? (language === 'en'
    ? `${entry.label} is ${entry.name}; use it only as a ${entry.mediaType === 'Audio' ? 'sound texture and rhythm' : 'camera movement and pacing'} reference`
    : `${entry.label} 是 ${entry.name}；仅作为${entry.mediaType === 'Audio' ? '声音质感与节奏' : '镜头运动与节奏'}参考`)
    : language === 'en'
    ? `<Subject ${entry.subject}> is ${entry.name} from <Picture ${entry.picture}>`
    : `<Subject ${String(entry.subject)}> 是 <Picture ${String(entry.picture)}> 中的${entry.name}`);
  /**
   * Adapt either 竖屏真人专业版 dialect into the field names this compiler reads.
   *
   * The standard version writes `镜次N (X 秒)` with `景别/机位` / `画面调度` / `音频` /
   * `台词/旁白`. The execution version keeps `【大分镜N】` but writes `【镜头01】时长：X秒`
   * with `【取景机位】` / `【画面内容】` / `【环境音】` / `【台词】` / `【画风锁定】`.
   * Older aliases remain readable while the bundled prompt emits only these names. Without
   * this adapter the new fields and production sections leak into `detailed_description`.
   *
   * A TEXT adapter, not another dialect in the splitter: it renames fields the compiler already
   * understands and leaves any other format untouched. Legacy blocks with `Shot N (…)` remain readable.
   */
  const adaptBeatBlock = (text) => {
    if (!/^\s*(?:(?:镜次|Shot)\s*\d+\s*\(|【\s*镜头\s*\d+\s*】)/mu.test(text)) return text;
    let out = text
      .replace(/^\s*(?:镜次|Shot)\s*(\d+)\s*\(\s*(\d+)\s*秒\s*\)\s*$/gmu, '【分镜$1】（时长：$2秒）')
      .replace(/^\s*【\s*镜头\s*(\d+)\s*】\s*(?:[｜|]\s*)?(?:时长\s*[：:]\s*)?(\d+)\s*秒\s*$/gmu,
        '【分镜$1】（时长：$2秒）')
      .replace(/^\s*【(?:取景与机位|取景机位)】\s*/gmu, '【摄像机景别】')
      .replace(/^\s*【(?:表演与调度|画面内容)】\s*/gmu, '【画面】')
      .replace(/^\s*【(?:声音与混响|环境音)】.*$/gmu, '')
      .replace(/^\s*【(?:对白与旁白|台词)】\s*$/gmu, '')
      .replace(/^\s*【画风锁定】.*$/gmu, '')
      .replace(/^\s*【本段起始调度】\s*/gmu, '【初始站位】')
      .replace(/^\s*【画面风格】\s*/gmu, '【画面风格和类型】')
      .replace(/^\s*景别\/机位：/gmu, '【摄像机景别】')
      .replace(/^\s*画面调度：/gmu, '【画面】')
      .replace(/^\s*风格：.*$/gmu, '')
      .replace(/^\s*音频：.*$/gmu, '')
      .replace(/^\s*台词\/旁白：\s*$/gmu, '');
    // `[名字（情绪）："台词"]` -> `名字 开口说："台词"（情绪）`
    out = out.replace(/^\[([^\]（(]+)(?:（([^）)]*)）)?[：:]\s*"([\s\S]*?)"\]\s*$/gmu, (whole, name, mood, line) =>
      `${String(name).trim()} 开口说："${String(line).trim()}"${mood === undefined ? '' : `（${String(mood).trim()}）`}`);
    // Structural sections H3 does not use; leaving them in is what polluted the description.
    out = out.replace(/^\s*【(?:人物映射|场景映射|道具映射|画面风格和类型|参考图片映射|参考视频映射|参考音频映射|参考媒体映射)】[^\n]*\n(?:[^\n【]+\n?)*/gmu, '');
    out = out.replace(/^\s*【(?:光线与色温设定|光源与色温档案|场景索引|场景特质|镜次序列|镜头序列|镜头清单)】[^\n]*\n/gmu, '');
    out = out.replace(/^\s*【(?:固定尾声明|本段固定尾声明)】[^\n]*(?:\n(?!\s*【)[^\n]*)*\n?/gmu, '');
    return out;
  };
  let raw = adaptBeatBlock(String(block?.text ?? '')).split(/\n\s*(?:#{1,6}\s*)?(?:[三四五][、.]\s*)?自检/u)[0];
  // Functional references are represented by their numbered role definition below. Leaving the
  // raw `初始站位参考@文件名` in the prose would leak the upload name and repeat the instruction.
  raw = raw.replace(/([^\s，。；、：:【】]{1,14}?参考)\s*(?:[：:]\s*)*@[\p{L}\p{N}·・\-_.]+(?:[（(][^）)\n]*[）)])?/gu, '');
  raw = raw.replace(/[ \t]{2,}/gu, ' ');
  const styleText = style ?? /【画面风格和类型】([^\n]*)/u.exec(raw)?.[1]?.trim() ?? '';
  const stagingAt = raw.search(/【(?:初始站位|初始位置|人物站位(?:（本(?:\s*段\s*|\s*Beat\s*)起始）)?)[^】]*】|【分镜\s*\d+】/u);
  if (stagingAt >= 0) raw = raw.slice(stagingAt);
  const names = new Map(subjects.map((entry) => [entry.name, entry.label]));
  for (const entry of used) {
    const label = names.get(entry.name);
    if (label === undefined) continue;
    for (const alias of entry.aliases ?? []) names.set(alias, label);
    // compileBlockToH3 is also a public entry point. When it is called directly,
    // `matchedBy` is the only record that the body wrote the base name while the
    // mapping named a costume, so bind that base name to the costume subject too.
    if (typeof entry.matchedBy === 'string' && entry.matchedBy.length > 0) names.set(entry.matchedBy, label);
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = names.size ? new RegExp([...names.keys()].sort((a, b) => b.length - a.length).map(escape).join('|'), 'gu') : null;
  const replaceNames = (value) => pattern === null ? value : value.split(/("[^"\n]*"|“[^”\n]*”)/gu)
    .map((part, index) => index % 2 ? part : part.replace(pattern, (name) => names.get(name)).replace(/@(?=<(?:Subject|Audio|Video) \d+>)/gu, '')).join('');
  // Match only the heading token. Real prompts also use the inline dialect
  // `【分镜1】时长：2秒 【摄像机景别】… 【拍摄主体】… 【画面】…`; consuming the rest of the
  // line made every shot body empty, so the model filled it with raw names and retention then
  // reported every subject as invisible.
  const shots = [...raw.matchAll(/【分镜\s*\d+】/gu)];
  /**
   * Keep the bracket's suffix, not only the lines below it.
   *
   * `【初始站位】（本段轴线：谢妄在左，顾星野在右）` carries a real directing rule after the
   * heading. The previous cleanup deleted the whole bracket, so the per-line blocking survived but
   * the axis rule silently disappeared. Only the heading token is removed now; any note inside or
   * immediately after it remains prose in `detailed_description`.
   */
  const stripStagingHeading = (value) => value.replace(
    /【(?:初始站位|初始位置|人物站位(?:（本(?:\s*段\s*|\s*Beat\s*)起始）)?)([^】]*)】/gu,
    (_, note) => String(note ?? '').trim(),
  );
  const staging = replaceNames(stripStagingHeading(raw.slice(0, shots[0]?.index ?? 0)).trim());
  const speakers = new Map();
  const subjectLabelsIn = (value) => [...String(value ?? '').matchAll(/<Subject\s+(\d+)>/gu)]
    .map((match) => `<Subject ${match[1]}>`);
  /**
   * Infer an omitted `开口说` subject from the clause before it.
   *
   * The real prompt form is often
   * `陆沉 视线看向 楚玄的方向，开口说：…`. Replacing names first leaves the listener as the
   * nearest `<Subject>`, which made every such line speak as the person being looked at.
   * Remove gaze/directional objects before choosing the last remaining subject. A one-person
   * 【拍摄主体】 is even stronger evidence and wins first.
   */
  const inferSpeakerLabel = (beforeText, subjectLineText) => {
    const subjectsInShot = [...new Set(subjectLabelsIn(subjectLineText))];
    if (subjectsInShot.length === 1) return subjectsInShot[0];
    const before = String(beforeText ?? '');
    const boundary = Math.max(
      before.lastIndexOf('。'),
      before.lastIndexOf('！'),
      before.lastIndexOf('？'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf('\n'),
    );
    const scoped = before.slice(boundary + 1)
      .replace(/(?:视线|目光|眼神)?\s*(?:看向|望向|盯向|盯着|注视着|望着|扫向|转向|朝向)\s*<Subject\s+\d+>(?:\s*的?\s*(?:方向|脸|面部|眼睛|胸口|背影|后脑))?/gu, '')
      .replace(/(?:视线|目光|眼神)\s*(?:落在|停在|投向)\s*<Subject\s+\d+>(?:\s*的?\s*(?:方向|脸|面部|眼睛|胸口|背影|后脑))?/gu, '');
    const candidates = subjectLabelsIn(scoped);
    return candidates.at(-1) ?? null;
  };
  let elapsed = 0;
  const formatted = shots.map((match, index) => {
    const chunk = raw.slice(match.index + match[0].length, shots[index + 1]?.index ?? raw.length).trim();
    const camera = (/【摄像机景别】([^【\n]*)/u.exec(chunk)?.[1]?.trim() ?? '').replace(/[。；;]\s*$/u, '');
    const subjectLine = /【拍摄主体】([^【\n]*)/u.exec(chunk)?.[1]?.trim() ?? '';
    const picture = /【画面】([\s\S]*)/u.exec(chunk)?.[1]?.trim() ?? chunk;    // 【拍摄主体】 has no official field of its own, so `source-format.md` says to name it at the
    // start of the shot as 「镜头对准 X」, and to state the camera direction right after it. The
    // direction is the third item of 【摄像机景别】 (正面 / 左侧面 / 右侧面 / 背面); without it the
    // upstream validator warns `aim clause states no camera direction`, and a shot that does not say
    // which side of the subject it is on is the difference between a left and a right profile.
    const direction = camera.split(/[，,]/u)
      .map((part) => part.trim())
      .find((part) => /^(?:正面|左侧面|右侧面|背面|左侧|右侧|侧面)/u.test(part)) ?? '';
    // An 过肩 line already says who the camera is aimed at (`镜头越过 A 的肩膀对准 B`), so adding
    // 「镜头对准 B」 again is noise in a prompt the model has to read - and since that camera line
    // replaces the direction field with the 过肩 note, the copy could not carry a direction either.
    const cameraAimsItself = /对准/u.test(camera);
    const focus = subjectLine.length > 0 && !cameraAimsItself
      ? `镜头对准 ${replaceNames(subjectLine)}${direction.length > 0 ? `，${direction}` : ''}。`
      : '';
    let description = replaceNames(picture);
    /**
     * Dialogue, in EITHER source form.
     *
     * `PROMPT-通用小白版.md` writes dialogue as 「角色名 开口说：“台词”（情绪，语速）」 - the tone comes
     * AFTER the quote. This compiler only recognised 「台词：角色名（情绪）“台词”」, which is the form
     * the 分镜稿 happens to use. A prompt written exactly as the document instructs therefore had its
     * dialogue left as plain text: no `<d>` wrapper and no speaker id, which is not a legal H3
     * prompt. The project that "worked" had been written in the other form by luck.
     */
    const dialogueFor = (subject, tone, line, kind) => {
      if (!speakers.has(subject)) {
        // H3 speaker ids are tied to the subject they identify: <Subject 5> speaks as S5.
        // Numbering by first spoken line made the same person change ids between blocks and
        // labelled off-screen listeners as the first speaker.
        const subjectNumber = Number(/^<Subject\s+(\d+)>$/u.exec(String(subject))?.[1]);
        speakers.set(subject, Number.isInteger(subjectNumber) && subjectNumber > 0
          ? subjectNumber
          : speakers.size + 1);
      }
      const id = speakers.get(subject);
      const dialogueLanguage = /[\p{Script=Han}]/u.test(line) ? 'Chinese' : 'English';
      const offscreen = kind === '画外音说' || /OS|内心/iu.test(kind);
      const verb = offscreen
        ? (language === 'en' ? 'says in an off-screen voiceover: ' : '画外音说：')
        : (language === 'en' ? ' says: ' : '说：');
      const toneText = typeof tone === 'string' && tone.trim().length > 0 ? `（${tone.trim()}）` : '';
      return `${subject} (S${id}) ${toneText}${verb}<d>[${dialogueLanguage}] ${line}</d>`;
    };
    description = description.replace(/台词[:：]\s*(<Subject \d+>)(?:[（(]([^）)]*)[）)])?\s*["“]([^"”]*)["”]/gu, (_, subject, tone, line) => dialogueFor(subject, tone, line, '说'));
    // 「角色名 开口说：“台词”（情绪，语速）」 - tone after the quote, which is how the document writes it.
    description = description.replace(/(<Subject \d+>)\s*(开口说|画外音说|内心\s*OS|内心独白|说)\s*[:：]\s*[“"]([^”"]*)[”"]\s*(?:[（(]([^）)]*)[）)])?/gu,
      (_, subject, kind, line, tone) => dialogueFor(subject, tone, line, kind.replace(/\s/gu, '')));
    /**
     * The name may not be repeated before 「开口说」.
     *
     * The document's own example writes `…苏晚 抬头，视线看向 林川 的方向，开口说：“…”` - the speaker was
     * named at the start of the clause, not next to the verb. When that is the case the speaker is
     * taken from 【拍摄主体】 if it names exactly one person (the shot is about them), and otherwise from
     * the nearest subject mentioned before the line. Guessing is avoided when neither is available:
     * the dialogue is left as written and the validator will flag it.
     */
    if (/开口说\s*[:：]|画外音说\s*[:：]|内心\s*OS\s*[:：]/u.test(description)) {
      const scopedSubjectLine = replaceNames(subjectLine);
      description = description.replace(/(开口说|画外音说|内心\s*OS)\s*[:：]\s*[“"]([^”"]*)[”"]\s*(?:[（(]([^）)]*)[）)])?/gu,
        (whole, kind, line, tone, offset) => {
          const subject = inferSpeakerLabel(description.slice(0, offset), scopedSubjectLine);
          if (subject === null) return whole;
          return dialogueFor(subject, tone, line, kind.replace(/\s/gu, ''));
        });
    }
    const milliseconds = Math.round(elapsed * 1000);
    const time = `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${(milliseconds % 60000 / 1000).toFixed(3).padStart(6, '0')}`;
    elapsed += Number(/^(?:\s*[（(])?\s*时长\s*[:：]\s*(\d+(?:\.\d+)?)\s*秒/u.exec(chunk)?.[1] ?? 0);
    // The camera line is part of the prompt the model reads, so a bare asset name there is the same
    // inconsistency as one in the prose - and in a two-person shot it is ambiguous which one it means.
    const cameraText = replaceNames(camera);
    return `[Shot ${index + 1}] ${index ? `At ${time}, ` : ''}${cameraText}${cameraText ? '。' : ''}${focus}${description}`;
  });
  /**
   * Make a voice reference usable by H3, not merely present in the slot table.
   *
   * The official Ref2VA guide has three requirements that the old compiler missed:
   *   - bind the audio to the visible subject and the same global speaker ID;
   *   - cite `<Audio N>` again in the spoken shot;
   *   - state the audio relationship in `retention_analysis`.
   *
   * A file can be uploaded perfectly and still be ignored when any of those are absent. We only
   * auto-bind when the target subject is unambiguous (named in the reference label or there is
   * exactly one speaking subject), so an ambience track with several characters is left alone.
   */
  const subjectForOwner = (owner) => {
    const clean = String(owner ?? '').trim();
    if (clean.length === 0) return null;
    return subjects.find((subject) => !subject.mediaType && (
      subject.name === clean
      || subject.name.replace(/[（(][^）)]*[）)]$/u, '') === clean.replace(/[（(][^）)]*[）)]$/u, '')
    )) ?? null;
  };
  /**
   * `【参考音频映射】` is a media table, not a cast table. The name before its bracket is the
   * owner; the `@mention` is the file. Preserve that owner here so an audio-only mapping still
   * binds to the visible character and speaker ID in H3.
   */
  const voiceSources = [
    ...subjects.filter((entry) => entry.mediaType === 'Audio' && typeof entry.voiceFor === 'string')
      .map((entry) => ({ audioLabel: entry.label, owner: entry.voiceFor, targetLabel: null })),
    ...functional
      .filter((entry) => entry.mediaType === 'Audio' && /音色|声音|配音|旁白|对白|语音/u.test(entry.annotation.label))
      .map((entry) => ({
        audioLabel: entry.label,
        owner: null,
        targetLabel: entry.target.startsWith('<Subject ') ? entry.target : null,
      })),
  ];
  const boundAudioLabels = new Set();
  const voiceBindings = voiceSources.flatMap((source) => {
    if (boundAudioLabels.has(source.audioLabel)) return [];
    const ownedSubject = source.owner === null ? null : subjectForOwner(source.owner)?.label ?? null;
    const soleSpeaker = source.owner === null && speakers.size === 1 ? [...speakers.keys()][0] : null;
    const subjectLabel = ownedSubject ?? source.targetLabel ?? soleSpeaker;
    const speakerNumber = subjectLabel === null ? null : speakers.get(subjectLabel);
    if (subjectLabel === null || speakerNumber === undefined) return [];
    boundAudioLabels.add(source.audioLabel);
    return [{ audioLabel: source.audioLabel, subjectLabel, speakerId: `S${speakerNumber}` }];
  });
  const voicedFormatted = formatted.map((shot) => {
    let next = shot;
    if (!next.includes('<d>')) return next;
    for (const binding of voiceBindings) {
      if (!next.includes(binding.subjectLabel) || next.includes(binding.audioLabel)) continue;
      const pair = new RegExp(`${escape(binding.subjectLabel)}\\s*\\(${binding.speakerId}\\)`, 'u');
      if (!pair.test(next)) continue;
      next = next.replace(pair, (match) => `${match} 沿用 ${binding.audioLabel} 的音色，`);
    }
    return next;
  });
  const visibleLabelsForShot = (shot) => new Set(subjectLabelsIn(String(shot ?? '')
    .replace(/(?:视线|目光|眼神)?\s*(?:看向|望向|盯向|盯着|注视着|望着|扫向|转向|朝向)\s*<Subject\s+\d+>(?:\s*的?\s*(?:方向|脸|面部|眼睛|胸口|背影|后脑))?/gu, '')
    .replace(/(?:视线|目光|眼神)\s*(?:落在|停在|投向)\s*<Subject\s+\d+>(?:\s*的?\s*(?:方向|脸|面部|眼睛|胸口|背影|后脑))?/gu, '')));
  const subjectDefinitionLines = labelled.map((line, index) => {
      const subject = subjects[index];
      const voice = voiceBindings.find((candidate) => candidate.audioLabel === subject.label);
      if (voice !== undefined) {
        return { subject, line: language === 'en'
          ? `${subject.label} is the voice-timbre reference for ${voice.subjectLabel} (${voice.speakerId}); it contains a spoken vocal layer and is used only to clone timbre and delivery, not the original words.`
          : `${subject.label} 是 ${voice.subjectLabel} (${voice.speakerId}) 的音色参考，其中包含人声层；仅复刻声音音色与表达，不复制原句内容。` };
      }
      return { subject, line: subject.mediaType ? line : `${line}，${subjectDefinitionTail(subject, language)}` };
    });
  // H3 examples list visible Picture subjects first, then standalone Audio/Video references.
  // Keeping the audio line first made voice binding easy to miss in long prompts.
  const mediaOrder = { Picture: 0, Audio: 1, Video: 2 };
  subjectDefinitionLines.sort((left, right) =>
    mediaOrder[left.subject.mediaType ?? 'Picture'] - mediaOrder[right.subject.mediaType ?? 'Picture']);
  const subjectDefinitions = [
    ...subjectDefinitionLines.map((entry) => entry.line),
    // One line per functional reference: what it is, and what it is for.
    ...functional.map((entry) => {
      const binding = voiceBindings.find((candidate) => candidate.audioLabel === entry.label);
      if (binding !== undefined) {
        return language === 'en'
          ? `${entry.label} is the voice-timbre reference for ${binding.subjectLabel} (${binding.speakerId}); it contains a spoken vocal layer and is used only to clone timbre and delivery, not the original words.`
          : `${entry.label} 是 ${binding.subjectLabel} (${binding.speakerId}) 的音色参考，其中包含人声层；仅复刻声音音色与表达，不复制原句内容。`;
      }
      if (entry.mediaType === 'Picture') {
        const purpose = String(entry.annotation.label ?? '其他视觉参考')
          .replace(/参考图$|参考$|图$/u, '')
          .trim() || '其他视觉';
        return language === 'en'
          ? `${entry.label} is the ${purpose} image; ${entry.roleEn}.`
          : `${entry.label} 是${purpose}图，${entry.roleZh}。`;
      }
      return language === 'en'
        ? `${entry.label} is ${entry.target}; it ${entry.roleEn}.`
        : `${entry.label} 是 ${entry.target} 的参考，用于${entry.roleZh}。`;
    }),
  ].join('\n');
  const detail = [styleText, staging, ...(voicedFormatted.length ? voicedFormatted : [replaceNames(raw).replace(/@/gu, '')])].filter(Boolean).join('\n');
  void detail;
  const subjectRetention = subjects.map((entry) => {
      if (entry.mediaType) {
        const voice = voiceBindings.find((candidate) => candidate.audioLabel === entry.label);
        if (voice !== undefined) {
          return { entry, line: `${entry.label}: reference - ${language === 'en'
            ? `its vocal timbre guides the dialogue delivery of ${voice.subjectLabel} without copying the original signal.`
            : `其音色用于 ${voice.subjectLabel} 的台词演绎，不复制原音频信号。`}` };
        }
        return { entry, line: `${entry.label}: ${entry.mediaType === 'Audio' ? 'reference' : 'weak_reference'} - ${language === 'en' ? 'Preserve the specified reference role.' : '沿用指定参考作用。'}` };
      }
      // Staging declares who is present in the block, not who appears in every shot. Using
      // it as an every-shot signal made an opponent who was only glanced at appear in every
      // retention row, and downstream models then drew them into frames where they had left.
      const subjectLabel = `<Subject ${entry.subject}>`;
      let appearances = voicedFormatted.flatMap((shot, index) => {
        return visibleLabelsForShot(shot).has(subjectLabel) ? [`[Shot ${index + 1}]`] : [];
      });
      // A scene named in the block's initial staging is the space containing every shot.
      // Characters are different: staging can mention someone who never appears on screen.
      if (appearances.length === 0 && entry.kind === 'scene' && subjectLabelsIn(staging).includes(subjectLabel)) {
        appearances = voicedFormatted.map((_, index) => `[Shot ${index + 1}]`);
      }
      if (appearances.length === 0) {
        return {
          entry,
          line: `${subjectLabel} (not visible in any shot): weak_reference - ${language === 'en'
            ? 'Keep it only as staging/context and do not draw it into a frame.'
            : '仅作为站位或上下文参考，不得画入任何镜头。'}`,
        };
      }
      return {
        entry,
        line: `${subjectLabel} (appears in ${appearances.join(', ')}): fully_preserved - ${language === 'en' ? 'Reference appearance is preserved.' : '参考外观保留。'}`,
      };
    }).sort((left, right) =>
      mediaOrder[left.entry.mediaType ?? 'Picture'] - mediaOrder[right.entry.mediaType ?? 'Picture']);
  const retention = [
    ...subjectRetention.map((entry) => entry.line),
    ...functional.map((entry) => {
      const binding = voiceBindings.find((candidate) => candidate.audioLabel === entry.label);
      if (binding !== undefined) {
        return `${entry.label}: reference - ${language === 'en'
          ? `its vocal timbre guides the dialogue delivery of ${binding.subjectLabel} without copying the original signal.`
          : `其音色用于 ${binding.subjectLabel} 的台词演绎，不复制原音频信号。`}`;
      }
      return `${entry.label}: ${entry.mediaType === 'Audio' ? 'reference' : 'weak_reference'} - ${language === 'en' ? 'Preserve the specified reference role.' : '沿用指定参考作用。'}`;
    }),
  ].join('\n');

  /**
   * A `@` may not survive into an H3 prompt.
   *
   * `@` binds a mention to the block's 【人物映射】/【场景映射】/【道具映射】. When a mention is NOT declared
   * there — the common case of writing `初始位置参考：@外卖袋` in 【初始站位】 without adding it to the
   * mapping — nothing can be bound, and this compiler used to copy the `@` through verbatim. The
   * result was an H3 prompt that looks synced (the file changes, the action returns) but which
   * `generate-h3` refuses outright with 「H3 正文不能含 @ 引用」. Silently producing an unusable prompt is
   * worse than producing a slightly lossy one, so the `@` is dropped, the name is kept as plain text,
   * and every such mention is REPORTED so the user can declare it.
   */
  const unmappedMentions = [];
  // A mention already serving as a 功能参考 is BOUND (it has its own numbered line), so it is not
  // "unmapped" - reporting it would tell the user to fix something that is already correct.
  const boundNames = new Set(functional.map((entry) => entry.name));
  const stripMentions = (value) => String(value ?? '').replace(/@[\p{L}\p{N}（）()·・\-_.]+/gu, (whole) => {
    const name = parseMentions(whole)[0]?.name ?? whole.slice(1);
    if (!boundNames.has(name) && !unmappedMentions.includes(name)) unmappedMentions.push(name);
    return name;
  });
  // The role sentence also belongs in the description: H3 reads `detailed_description` as the shot
  // itself, and a reference nobody mentions there is a reference the model may ignore.
  const functionalNotes = functional.map((entry) => (language === 'en'
    ? `Per ${entry.label}, it ${entry.roleEn}.`
    : `据 ${entry.label}：${entry.roleZh}。`));
  const rawDetail = [styleText, staging, ...functionalNotes, ...(voicedFormatted.length ? voicedFormatted : [replaceNames(raw).replace(/@/gu, '')])].filter(Boolean).join('\n');
  const voiceSummary = voiceBindings.map((binding) => (language === 'en'
    ? `${binding.subjectLabel} (${binding.speakerId}) uses ${binding.audioLabel} as the voice-timbre reference.`
    : `目标对白使用 ${binding.audioLabel} 作为 ${binding.subjectLabel} (${binding.speakerId}) 的音色参考。`)).join(' ');
  const voiceSoundscape = voiceBindings.map((binding) => (language === 'en'
    ? `Dialogue uses ${binding.audioLabel} as the voice-timbre reference for ${binding.subjectLabel} (${binding.speakerId}) without copying the original words.`
    : `对白以 ${binding.audioLabel} 为 ${binding.subjectLabel} (${binding.speakerId}) 的音色参考，不复制原句内容。`)).join(' ');

  return {
    blockIndex: block?.index ?? 0,
    sourceNumber: block?.sourceNumber ?? null,
    seconds: block?.seconds ?? null,
    // The subject table IS the reference-image upload order, so it is the thing the workflow needs.
    subjects,
    functional: functional.map((entry) => ({ label: entry.label, name: entry.name, mediaType: entry.mediaType, role: entry.annotation.label })),
    pictureCount: counts.Picture,
    uploadOrder: [...subjects.filter((entry) => !entry.mediaType).map((entry) => entry.name), ...functional.filter((entry) => entry.mediaType === 'Picture').map((entry) => entry.name)],
    /** Mentions written with `@` that had no mapping entry; their `@` was dropped. */
    unmappedMentions,
    text: withH3BlockHeading([
      'subject_definitions:',
      subjectDefinitions.length > 0
        ? subjectDefinitions
        // An English file must not carry a Chinese sentence here. `subject_definitions` is NOT
        // translated - it carries the `<Subject N>` bindings, and re-wording those would change
        // which picture each slot refers to - so whatever this line says stays in the language it
        // was written in. A Chinese placeholder in an otherwise-English prompt is exactly the
        // `subject_definitions contains non-English prose outside <d>` rejection the skill documents.
        : (language === 'en' ? '(no reference assets for this shot)' : '（本大分镜没有引用任何资产）'),
      '',
      'summary:',
      `[${voiceBindings.length > 0 ? 'reference generation + audio reference' : 'reference generation'}] `
        + `${language === 'en' ? 'The target video follows the actions and dialogue below.' : '目标视频按以下镜头顺序呈现动作与对白。'}`
        + (voiceSummary.length > 0 ? ` ${voiceSummary}` : ''),
      '',
      'retention_analysis:',
      retention,
      '',
      'detailed_description:',
      stripMentions(rawDetail),
      '',
      'overall_soundscape:',
      /**
       * NOT `N/A`.
       *
       * In the H3 spec `N/A` in `overall_soundscape` means there IS no soundscape - a silent video. The
       * placeholder was copied from `non_diegetic_music` (where `N/A` is correct: this production has no BGM,
       * which the user asked for). So every compiled block told the model to render with no sound at all,
       * and a viewer hears nothing. The field has to carry a real instruction, derived from what the shots
       * already describe: ambient bed + synchronous action and body sounds, and no music.
       */
      language === 'en'
        ? [voiceSoundscape, 'A continuous ambient bed of the location across the whole clip, with room tone that matches the space; every action and body sound (footsteps, cloth friction, props set down or struck, breathing, swallowing) lands on the frame that causes it; no music, no narration, no subtitles.'].filter(Boolean).join(' ')
        : `${voiceSoundscape}全片持续保留所在地点的环境底噪，混响与该空间一致；每一处动作声与身体声（脚步、衣料摩擦、道具放置或碰撞、呼吸、吞咽）都与产生它的画面同步；不加背景音乐、不加旁白、不加字幕。`,
      '',
      'non_diegetic_music:',
      'N/A',
      '',
    ].join('\n'), block?.sourceNumber),
  };
}

/**
 * The wording after `中的资产名` in a subject definition.
 *
 * Left as a short, neutral clause rather than an invented description of the character: the H3 spec
 * asks for the appearance to be carried by the reference image, and writing prose here that the image
 * does not support is how a prompt asks for something the reference cannot deliver.
 */
function subjectDefinitionTail(subject, language) {
  if (language === 'en') {
    return subject.kind === 'character'
      ? 'face, features, hairstyle and clothing follow the reference exactly'
      : 'appearance, layout and material follow the reference exactly';
  }
  return subject.kind === 'character'
    ? '面容、五官、发型与服装严格沿用参考图'
    : '外观、布局与材质严格沿用参考图';
}

/**
 * Compile a whole 直出视频提示词 into one H3 prompt per 大分镜.
 *
 * @returns `{ prompts, mapping, unmatched }`. `unmatched` names any 映射 entry no 大分镜 mentions -
 *   reported rather than dropped, because that is either an unused asset the writer should remove or
 *   a 大分镜 that forgot to name something it uses.
 */
export function compileEpisodeToH3(text, { style = null, language = 'zh', mediaTypes = {}, knownNames = null } = {}) {
  const source = String(text ?? '');
  const mapping = readAssetMapping(source);
  const structural = describeBlocks(source);
  const presentational = splitShotBlocks(source);
  const mentioned = new Set();
  const prompts = structural.map((block, index) => {
    // The presentational parse is the authority on what the block's body IS, so the two agree on
    // what the user sees and what gets compiled.
    const shown = presentational[index];
    const merged = {
      index: block.order,
      sourceNumber: block.sourceNumber,
      seconds: shown?.seconds ?? null,
      text: shown?.text ?? block.body,
    };
    const local = readAssetMapping(merged.text);
    const active = local.byName.size ? local : mapping;
    // Extra references are not cast members. A plain mention in the action must not turn a blocking
    // picture (or audio/video) into a `<Subject>`; the explicit mapping path below gives them a
    // standalone numbered reference instead.
    const subjectMapping = new Map([...active.byName].filter(([, kind]) =>
      kind === 'character' || kind === 'scene' || kind === 'prop'));
    const used = assetsUsedBy(bodyWithoutMappings(merged.text), subjectMapping, active.aliases, active.referenceFor)
      .map((entry) => {
        /**
         * `【参考音频映射】谢妄（声音参考: @文件名）` names the OWNER before the bracket and
         * the FILE inside the mention. Keeping only the mention made H3 emit a bare file
         * reference and lose the fact that this is 谢妄's voice. Carry the owner through so the
         * compiler can bind `<Audio N>` to the matching `<Subject N> (Sx)`.
         */
        const mediaType = entry.kind === 'reference-audio'
          || (entry.kind === 'reference-media' && mediaTypes[entry.name] === 'Audio')
          ? 'Audio'
          : null;
        const mappingEntry = [...(active.referenceAudios ?? []), ...(active.referenceMedia ?? [])]
          .find((item) => item.name === entry.name);
        return {
          ...entry,
          ...(mediaType === 'Audio' && typeof mappingEntry?.displayName === 'string' && mappingEntry.displayName !== entry.name
            ? { voiceFor: mappingEntry.displayName }
            : {}),
          aliases: [...new Set([
            ...(active.aliases.get(entry.name) ?? []),
            ...(entry.matchedBy === entry.name ? [] : [entry.matchedBy]),
          ])],
        };
      });
    /**
     * A local mapping section is itself an explicit user choice.
     *
     * Choosing an asset from the panel writes it into the block's own mapping, not necessarily into
     * the prose. The old compiler searched the mapping text itself and therefore confused "mapped"
     * with "visible in the action"; extra pictures in particular could disappear from H3. A
     * block-local mapping is an explicit user choice, so every row is retained. An episode-wide
     * mapping still needs a body mention, otherwise every asset would be copied into every 大分镜.
     */
    const localOnly = local.byName.size > 0 ? local : null;
    const explicitFunctionalEntries = [];
    if (localOnly !== null) {
      const alreadyUsed = new Set(used.map((entry) => entry.name));
      for (const [bucket, kind] of [
        ['characters', 'character'],
        ['scenes', 'scene'],
        ['props', 'prop'],
      ]) {
        for (const entry of localOnly[bucket] ?? []) {
          if (alreadyUsed.has(entry.name)) continue;
          used.push({
            name: entry.name,
            kind,
            matchedBy: 'mapping',
            aliases: entry.aliases ?? [],
          });
          mentioned.add(entry.name);
          alreadyUsed.add(entry.name);
        }
      }
      for (const entry of localOnly.referenceImages ?? []) {
        if (alreadyUsed.has(entry.name)) continue;
        const label = entry.displayName !== entry.name ? entry.displayName : '其他视觉参考';
        const role = functionalReferenceRole(label) ?? {
          media: 'Picture',
          zh: '按用户指定的构图、站位或其他视觉参考作用参与本大分镜',
          en: 'serves as the user-specified composition, blocking or other visual reference for this block',
        };
        explicitFunctionalEntries.push({ label, name: entry.name, role });
        mentioned.add(entry.name);
        alreadyUsed.add(entry.name);
      }
      for (const [bucket, kind] of [
        ['referenceVideos', 'reference-video'],
        ['referenceAudios', 'reference-audio'],
        ['referenceMedia', 'reference-media'],
      ]) {
        for (const entry of localOnly[bucket] ?? []) {
          if (alreadyUsed.has(entry.name)) continue;
          const mediaType = kind === 'reference-audio'
            || (kind === 'reference-media' && mediaTypes[entry.name] === 'Audio')
            ? 'Audio'
            : kind === 'reference-video' || (kind === 'reference-media' && mediaTypes[entry.name] === 'Video')
              ? 'Video'
              : null;
          used.push({
            name: entry.name,
            kind,
            matchedBy: 'mapping',
            aliases: entry.aliases ?? [],
            ...(mediaType === 'Audio' && entry.displayName !== entry.name ? { voiceFor: entry.displayName } : {}),
          });
          mentioned.add(entry.name);
          alreadyUsed.add(entry.name);
        }
      }
    }
    for (const entry of used) mentioned.add(entry.name);
    return compileBlockToH3({
      block: merged,
      used,
      style,
      language,
      mediaTypes,
      knownNames,
      functionalEntries: explicitFunctionalEntries,
    });
  });
  const unmatched = [...mapping.byName.keys()].filter((name) => !mentioned.has(name));
  // Names a 大分镜 puts on screen that no mapping entry covers. Reported, never guessed - see
  // unmappedSubjects for why the words cannot be connected automatically.
  const loose = structural.flatMap((block, index) => {
    const text = presentational[index]?.text ?? block.body;
    const local = readAssetMapping(text);
    const active = local.byName.size ? local : mapping;
    return unmappedSubjects(text, active.byName, active.referenceFor)
      .map((entry) => ({ block: block.sourceNumber, name: entry }));
  });
  return { prompts, mapping, unmatched, unmappedSubjects: loose, blockCount: structural.length };
}

/** A stable filename for one compiled 大分镜, so a recompile overwrites rather than accumulates. */
export function h3FileName(episodeNumber, blockNumber, language = 'zh') {
  return `第${String(episodeNumber)}集H3提示词-大分镜${String(blockNumber)}${language === 'en' ? '（英文）' : '（中文）'}.txt`;
}

/**
 * The English sibling of ONE Chinese H3 document, keeping that document's own name.
 *
 * A project does not have to be split: `第1集H3提示词.txt` holding six 大分镜 is a normal shape (written by
 * hand, or produced by 一键同步 before anything was compiled). Its English companion must then also be one
 * document, and the honest name is the Chinese one with the language marker swapped - inventing
 * `第1集H3提示词-大分镜K（英文）.txt` names would turn one file into six and leave the panel showing a
 * different number of English blocks than Chinese ones.
 *
 * A name with no marker gets one appended; `（中文）`/`中文` is replaced in place; a name that already says
 * 英文 is returned unchanged.
 */
export function englishSiblingName(chineseFileName) {
  const name = String(chineseFileName ?? '');
  const withoutExtension = name.replace(/\.txt$/iu, '') || 'H3提示词';
  if (/（中文）|\(中文\)/u.test(withoutExtension)) return `${withoutExtension.replace(/（中文）|\(中文\)/u, '（英文）')}.txt`;
  if (/中文/u.test(withoutExtension)) return `${withoutExtension.replace(/中文/u, '英文')}.txt`;
  if (/（英文）|\(英文\)|[-_]en(?![a-z])|英文/u.test(withoutExtension)) return `${withoutExtension}.txt`;
  return `${withoutExtension}（英文）.txt`;
}

