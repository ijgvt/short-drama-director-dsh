/**
 * References: turning `@陈默` in a prompt into a binding to a concrete asset version.
 *
 * ## Why text is not enough
 *
 * The prompt files already write `@陈默`, but that is a string. Nothing knows which asset it
 * means, which costume, or which version of the file - so a regeneration silently changes
 * what a finished shot was built from, and a typo produces a prompt that names an asset
 * nobody has. The handbook calls this out directly: "仅插入名字不算完成" - inserting a name
 * is not the same as making a reference.
 *
 * A reference is a record:
 *
 * ```
 * referenceId     one occurrence group
 * assetVersionId  the CONCRETE file this resolves to - not a name, not a variant
 * occurrences[]   where in the text, by UTF-16 offset, with the text that should be there
 * bindingState    resolved | needs_review | unresolved | ambiguous
 * ```
 *
 * ## The two naming conventions that must not be confused
 *
 * The source writes the BASE asset name (`@陈默`, `@老周`), while the folder adds a qualifier
 * that is usually an identity: `陈默（男主）`, `老周（外卖员）`. But the inventory document also
 * uses parentheses for real VARIANTS (`老周（淋湿）`). The folder name cannot say which it is,
 * so resolution tries the unambiguous readings in order and refuses to guess between two
 * equally good ones - an ambiguous `@` is reported, not silently bound to the wrong costume.
 *
 * @module dsh-plugin-short-drama-director/lib/reference-service
 */

import {
  characterVoiceVersion,
  fileVariantName,
  flattenVersions,
  representativeVersion,
  stripGeneratorSuffix,
} from './asset-store.js';

/**
 * Characters an asset name may contain.
 *
 * Deliberately excludes whitespace and the punctuation that separates fields in the prompt
 * format - a mention that swallowed a trailing comma or a full-width colon would address
 * something that does not exist, and the error would look like a missing asset.
 */
const NAME_CHAR = /[\p{L}\p{N}（）()·・\-_.]/u;

/** What a mention may look like, so a bare `@` in prose is not mistaken for one. */
export const MENTION_PATTERN = /@([\p{L}\p{N}（）()·・\-_.]+)/gu;

/**
 * Find every `@mention` in a string.
 *
 * Offsets are UTF-16 code units, which is what a JavaScript textarea reports for
 * `selectionStart` and what `String.prototype.slice` uses. Mixing in code-point offsets would
 * make a mention after an emoji land in the wrong place.
 *
 * @returns `[{ text, name, start, end }]` in document order.
 */
export function parseMentions(text) {
  const source = String(text ?? '');
  const out = [];
  MENTION_PATTERN.lastIndex = 0;
  for (;;) {
    const match = MENTION_PATTERN.exec(source);
    if (match === null) break;
    const name = trimName(match[1]);
    if (name.length === 0) continue;
    out.push({ text: `@${name}`, name, start: match.index, end: match.index + 1 + name.length });
  }
  return out;
}

/**
 * Trim what is punctuation rather than part of a name.
 *
 * Brackets are the case that matters. `（` and `）` are both name characters because
 * `老周（淋湿）` is a legal mention, but in `参考: @林晚）` the closing bracket belongs to the
 * field's own wrapper - and swallowing it produced a mention of an asset called `林晚）`,
 * which of course does not exist. So an unbalanced trailing closing bracket is dropped, while
 * a balanced pair is kept. Trailing `.` and `-` are punctuation for the same reason.
 */
function trimName(raw) {
  let name = String(raw);
  for (;;) {
    const before = name;
    // Sentence punctuation must never be part of a name.
    name = name.replace(/[.\-·、,，;；:：]+$/u, '');
    // An unmatched closing bracket at the end is the surrounding text's, not the name's.
    const open = (name.match(/[（(]/gu) ?? []).length;
    const close = (name.match(/[）)]/gu) ?? []).length;
    if (close > open && /[）)]$/u.test(name)) name = name.slice(0, -1);
    if (name === before) break;
  }
  return name;
}

/**
 * Every name an asset answers to.
 *
 * A name is `@`-addressable when it is the asset's own name or one of its recorded aliases.
 * Variant names are NOT included here: `林晚（家居服）` describes a costume, and treating it
 * as a separate addressable asset is what made the old base-name comparison erase costumes.
 * It is offered as a QUALIFIER for a mention of the base name instead.
 */
function addressableNames(asset) {
  return [asset.name, ...(asset.aliases ?? [])].filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/** One concrete file that can represent an ambiguous asset or variant in the panel. */
function candidateDetail(asset, variant = null) {
  const chosenVariant = variant
    ?? (asset.variants ?? []).find((entry) => entry.name === asset.identityVariant)
    ?? (asset.variants ?? [])[0]
    ?? null;
  const files = (chosenVariant?.files ?? []).filter((file) => (
    file.missing !== true
    && !(asset.kind === 'character' && file.role === 'voice')
      && fileVariantName(asset, file) === chosenVariant?.name
  ));
  const file = representativeVersion(
    { ...chosenVariant, files },
    undefined,
    { allowVoice: asset.kind !== 'character' },
  ) ?? null;
  return {
    assetId: asset.assetId,
    assetName: asset.name,
    kind: asset.kind ?? null,
    variantName: chosenVariant?.name ?? null,
    assetVersionId: file?.assetVersionId ?? null,
    role: file?.role ?? null,
    fileName: file?.fileName ?? null,
  };
}

/** An ambiguity with enough detail for a user to choose without inspecting paths by hand. */
function ambiguousAssets(name, candidates, note) {
  return {
    state: 'ambiguous',
    candidates: candidates.map((asset) => asset.name),
    candidateDetails: candidates.map((asset) => candidateDetail(asset)),
    note,
  };
}

/**
 * Resolve `@角色（音色）` to the character-level voice file.
 *
 * A voice is stored inside the character asset rather than as a second audio asset, so the normal
 * variant resolver cannot reach it. The qualifier is an explicit user choice and therefore maps to
 * the uploaded `role: voice` version without inventing a costume called 音色.
 */
function characterVoiceMention(asset) {
  if (asset?.kind !== 'character') return null;
  const voice = characterVoiceVersion(asset);
  if (voice === undefined) return null;
  const variant = (asset.variants ?? []).find((entry) =>
    entry.variantId === voice.variantId
    || (entry.files ?? []).some((file) => file.assetVersionId === voice.assetVersionId))
    ?? {
      variantId: voice.variantId,
      name: voice.variantName ?? asset.identityVariant ?? 'default',
      files: [voice],
    };
  return {
    state: 'resolved',
    asset,
    variant,
    version: voice,
    role: 'voice',
    alternatives: [],
    assetKind: 'reference-audio',
    sourceAssetKind: 'character',
    mediaType: 'Audio',
    voiceFor: asset.name,
  };
}

/**
 * Resolve one mention name against the asset library.
 *
 * @returns `{ state, asset, candidates, note }` where `state` is:
 *   - `resolved` - exactly one asset, and the version to bind is unambiguous
 *   - `ambiguous` - more than one asset or variant could be meant
 *   - `unresolved` - nothing matches; the text is kept and the user is told
 */
export function resolveMention(name, assets, {
  allowDescriptive = false,
  preferredAssetId = null,
  preferredVariantName = null,
} = {}) {
  const wanted = String(name).trim();
  if (wanted.length === 0) return { state: 'unresolved', note: 'empty name' };

  // 1. Exact addressable name. `@陈默` matching the asset 陈默 whose folder is 陈默（男主）:
  //    the qualifier is an identity, so it must not block the match.
  const exact = assets.filter((asset) => addressableNames(asset).includes(wanted));
  const preferred = exact.find((asset) => asset.assetId === preferredAssetId) ?? null;
  let exactUnresolved = null;
  if (exact.length === 1) {
    const outcome = refineByVariant(
      exact[0],
      exact[0].assetId === preferredAssetId ? preferredVariantName : null,
    );
    if (outcome.state !== 'unresolved') return outcome;
    // An inventory-only exact spelling can exist beside a scanned base asset that owns the
    // file. Example: inventory `手机（林妙）`, file `手机（林妙）.png`. Continue to the
    // qualified-name rule below instead of stopping on the empty duplicate.
    exactUnresolved = outcome;
  }
  /**
   * Several assets answer to the same name: the one NAMED exactly wins.
   *
   * `外卖袋` matched twice because a re-export had produced a second asset, so every `@外卖袋` in the
   * prompt came back ambiguous (five out of five) and generation was refused - even though one asset is
   * literally called 外卖袋 and the other only shares a derived name. An exact name is an identity; a
   * derived match is a coincidence, so the exact one is chosen and asking is reserved for a real tie.
   */
  if (exact.length > 1) {
    // A choice made in the panel is the user's answer to this exact ambiguity. The same id is
    // carried by `previous`, so reopening the block does not ask the question again.
    if (preferred !== null) return refineByVariant(preferred, preferredVariantName);
    const named = exact.filter((asset) => String(asset.name ?? '').trim() === wanted);
    if (named.length === 1) return refineByVariant(named[0], null);
    if (named.length > 1) {
      const canonical = named.filter((asset) => ['character', 'scene', 'prop'].includes(asset.kind));
      const generic = named.filter((asset) => ['reference-image', 'reference-media'].includes(asset.kind));
      const hashes = (asset) => new Set(flattenVersions(asset)
        .filter((file) => file.missing !== true)
        .map((file) => file.sha256)
        .filter((value) => typeof value === 'string'));
      if (canonical.length === 1 && generic.length > 0) {
        const canonicalHashes = hashes(canonical[0]);
        const duplicateOnly = generic.every((asset) => {
          const own = [...hashes(asset)];
          return own.length === 0 || own.some((hash) => canonicalHashes.has(hash));
        });
        if (duplicateOnly) return refineByVariant(canonical[0], preferredVariantName);
      }
      /**
       * One spelling may have an inventory-only shell beside the real file-backed asset.
       * A shell has no competing picture, so it must not turn a valid reference into a question.
       * Two assets that both own pictures remain a genuine ambiguity and are still refused.
       */
      const imageOwners = named.filter((asset) => flattenVersions(asset)
        .some((file) => file.missing !== true && file.role !== 'voice' && typeof file.relativePath === 'string'));
      if (imageOwners.length === 1) return refineByVariant(imageOwners[0], preferredVariantName);
    }
  }

  // 2. `基础名（限定名）` - the mention itself names a variant.
  const qualified = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]$/u.exec(wanted);
  if (qualified !== null) {
    const [, base, qualifier] = qualified;
    const owners = assets.filter((asset) => addressableNames(asset).includes(base));
    /**
     * A library that split one prop into one ASSET PER SPELLING.
     *
     * `雷劫代练木牌` exists with variants default / 挂号背面 / 天道同价, and the import ALSO created bare shells
     * named `雷劫代练木牌（正面）`, `雷劫代练木牌（挂号背面）` … with zero files. So `@雷劫代练木牌（正面）` asked the real
     * asset for a variant it does not have, and the whole reference came back unresolved even though a prop
     * with that exact spelling was sitting in the library.
     *
     * Prefer, in order: the real variant of the base asset; then another asset NAMED exactly `base（qualifier）`
     * that actually has a file; then report the miss with the variant names so the user can fix it.
     */
    const hasFileDeep = (asset) => (asset.variants ?? []).some((variant) => (variant.files ?? []).some((file) => file.missing !== true));
    /**
     * A file whose STEM is the whole mention.
     *
     * The real library keeps this prop's 正面 picture as `雷劫代练木牌（正面）.png` inside the BASE asset's own
     * variant - the qualifier is a FILE name, not a variant name. Verified against the project: `雷劫代练木牌`
     * resolves to `雷劫代练木牌（正面）.png`, yet `@雷劫代练木牌（正面）` reported a missing variant. Matching the file
     * stem is what makes the qualified spelling land on that picture.
     */
    const byFileStem = () => {
      const target = wanted.trim().toLowerCase();
      for (const asset of assets) {
        for (const variant of asset.variants ?? []) {
          for (const file of variant.files ?? []) {
            if (file.missing === true) continue;
            const stem = String(file.fileName ?? '').replace(/\.[^.]+$/u, '').trim().toLowerCase();
            if (stem === target) return refineByVariant(asset, variant.name);
          }
        }
      }
      return null;
    };
    const spelled = assets.find((asset) => String(asset.name ?? '').trim() === wanted && asset !== owners[0] && hasFileDeep(asset));
    if (owners.length === 1) {
      const hasVariant = owners[0].variants.some((variant) => variant.name === qualifier);
      if (hasVariant) return refineByVariant(owners[0], qualifier);
      if (/^(?:音色|声音|voice|audio)$/iu.test(qualifier)) {
        const voice = characterVoiceMention(owners[0]);
        if (voice !== null) return voice;
      }
      if (spelled !== undefined) return refineByVariant(spelled, null);
      const byName = byFileStem();
      if (byName !== null) return byName;
      return { state: 'unresolved', note: `${owners[0].name} has no variant "${qualifier}"; variants are ${owners[0].variants.map((v) => v.name).join(', ')}` };
    }
    if (owners.length > 1) {
      const chosen = owners.find((asset) => asset.assetId === preferredAssetId);
      if (chosen !== undefined) {
        if (/^(?:音色|声音|voice|audio)$/iu.test(qualifier)) {
          const voice = characterVoiceMention(chosen);
          if (voice !== null) return voice;
        }
        return refineByVariant(chosen, qualifier);
      }
      if (spelled !== undefined) return refineByVariant(spelled, null);
      const byName = byFileStem();
      if (byName !== null) return byName;
      return ambiguousAssets(base, owners, `"${base}" matches ${owners.length} assets`);
    }
    // No base asset at all: an asset literally named `base（qualifier）` is the only way this resolves.
    if (spelled !== undefined) return refineByVariant(spelled, null);
    const byName = byFileStem();
    if (byName !== null) return byName;
  }
  if (exactUnresolved !== null) return exactUnresolved;

  if (exact.length > 1) {
    return ambiguousAssets(wanted, exact, `"${wanted}" matches ${exact.length} assets`);
  }

  // 3. A DESCRIPTIVE name - only when the caller says its input IS a description.
  //
  // The looseness is scoped rather than global because it has to be. H3 writes `<Picture 5> 中的牛皮纸外卖袋`
  // (prose about `外卖袋`), and matching that needs containment. But an `@` mention is a NAME the user
  // typed against a list, and applying the same containment there makes `林晚-军装` - a FILE name - bind
  // to the character `林晚`, silently ignoring the costume. That is precisely the "不要把服装当成新角色"
  // mistake, and a mistyped name is a question worth asking rather than a guess worth making.
  if (allowDescriptive === true) {
  //
  // `<Picture 5> 中的牛皮纸外卖袋` is prose about the asset `外卖袋`; `<Picture 4> 中的深夜公寓玄关环境` is
  // prose about `深夜公寓玄关`. Neither is an exact name, and the asset is the thing being DESCRIBED,
  // so containment is the relationship - in BOTH directions, because the extra words sit on either
  // side (`牛皮纸外卖袋`, `深夜公寓玄关环境`) and stripping Chinese modifiers reliably is not something
  // this can do well.
  //
  // Accepted ONLY when exactly one asset matches. That restriction IS the safety of the rule:
  // `<Picture 3> 中的老周被雨淋湿的状态` contains `老周`, and if two assets both contained it the right
  // answer would be unknowable - so it becomes a question for the user rather than a coin flip. A
  // missing binding is recoverable; a silently wrong image is not.
    const contained = assets.filter((asset) => addressableNames(asset)
      .some((candidate) => candidate.length >= 2 && (wanted.includes(candidate) || candidate.includes(wanted))));
    if (contained.length === 1) return refineByVariant(contained[0], null);
    if (contained.length > 1) {
      const chosen = contained.find((asset) => asset.assetId === preferredAssetId);
      if (chosen !== undefined) return refineByVariant(chosen, preferredVariantName);
      return ambiguousAssets(
        wanted,
        contained,
        `"${wanted}" 描述得像 ${contained.length} 个资产（${contained.map((asset) => asset.name).join('、')}），无法确定是哪一个`,
      );
    }
  }
  return { state: 'unresolved', note: `no asset is named "${wanted}"` };
}

/**
 * Pick the version a resolved mention binds to.
 *
 * The choice is by ROLE first: a person reference wants a reference sheet if one exists
 * (`quadview`), because that is what a video model needs for identity. Everything else takes
 * the current version of the named variant. This is a DEFAULT, not a silent decision - the
 * caller can override it, and the UI shows which version was chosen.
 */
function refineByVariant(asset, variantName) {
  const variants = variantName === null
    ? asset.variants
    : asset.variants.filter((variant) => variant.name === variantName);

  if (variants.length === 0) {
    return { state: 'unresolved', note: `${asset.name} has no variant "${variantName}"` };
  }
  if (variants.length > 1 && variantName === null) {
    // Several variants and the mention did not say which. Prefer the IDENTITY variant when
    // the folder named one: `@林晚` on a character whose folders are `林晚（女主）` and
    // `林晚（家居服）` means the character, not a costume. Only when no spelling claims the
    // identity does this become a question the user has to answer - and then it must be
    // asked, because binding a costume the user did not name is worse than asking.
    if (asset.identityVariant !== null && asset.identityVariant !== undefined) {
      const identity = variants.find((variant) => variant.name === asset.identityVariant);
      if (identity !== undefined) return pickVersion(asset, identity);
    }
    const named = variants.filter((variant) => variant.name !== 'default');
    if (named.length > 1) {
      return {
        state: 'ambiguous',
        asset,
        candidates: named.map((variant) => variant.name),
        candidateDetails: named.map((variant) => candidateDetail(asset, variant)),
        note: `${asset.name} has ${named.length} variants (${named.map((v) => v.name).join(', ')}); say which with @${asset.name}（变体）`,
      };
    }
  }

  return pickVersion(asset, variants[0]);
}

/** Choose the file version of a resolved variant, preferring a reference sheet. */
function pickVersion(asset, chosenVariant) {
  // A stale index may still list costume files under the identity variant. The file name is
  // the durable evidence: keep only files that actually belong to this variant, then let the
  // shared representative helper honour an explicit selection, role preference and recency.
  const files = (chosenVariant.files ?? []).filter((file) => (
    file.missing !== true
    && !(asset.kind === 'character' && file.role === 'voice')
      && fileVariantName(asset, file) === chosenVariant.name
  ));
  if (files.length === 0) {
    return { state: 'unresolved', asset, note: `${asset.name} has no file on disk for variant ${chosenVariant.name}` };
  }

  let preferred = representativeVersion(
    { ...chosenVariant, files },
    undefined,
    { allowVoice: asset.kind !== 'character' },
  );
  // Asset generation keeps the native image by default. If the user explicitly created an
  // upscaled scene copy, prefer it for upload when no exact version was selected; `3x` is a
  // technical variant, not a separate creative asset.
  const hasExplicitSelection = typeof chosenVariant.selectedVersionId === 'string'
    && files.some((file) => file.assetVersionId === chosenVariant.selectedVersionId);
  if (asset.kind === 'scene' && !hasExplicitSelection) {
    const rank = (file) => {
      const name = String(file.fileName ?? file.relativePath ?? '');
      const scale = /[（(][^）)]*?(\d+(?:\.\d+)?)\s*x[^）)]*[）)]/iu.exec(name)
        ?? /(?:^|[\s·・_-])(\d+(?:\.\d+)?)\s*x(?:$|[\s·・_-])/iu.exec(name);
      if (scale !== null) return Number(scale[1]);
      return /超分|放大|高清|upscal/iu.test(name) ? 2 : 0;
    };
    const sameRole = files.filter((file) => file.role === preferred.role);
    const bestScale = Math.max(0, ...sameRole.map(rank));
    if (bestScale > 0) {
      const candidates = sameRole.filter((file) => rank(file) === bestScale);
      preferred = candidates.reduce(
        (best, file) => ((file.version ?? 0) > (best.version ?? 0) ? file : best),
        candidates[0],
      );
    }
  }
  return {
    state: 'resolved',
    asset,
    variant: chosenVariant,
    version: preferred,
    role: preferred.role,
    alternatives: files.filter((file) => file.assetVersionId !== preferred.assetVersionId).map((file) => ({
      assetVersionId: file.assetVersionId, role: file.role, version: file.version, fileName: file.fileName,
    })),
  };
}

/**
 * Build the reference records for one block's text.
 *
 * Occurrences are grouped by (variant, version): one asset used three times in a block is ONE
 * reference with three occurrences, because the generation input is deduplicated by file
 * version (handbook §2.3 item 7). The order of the returned references is the order of their
 * first appearance, which is what the prompt's reference numbering follows.
 *
 * @param options.previous - references recorded for this shot before, matched by expectedText
 *   so a version the user pinned by hand survives a re-parse.
 */
export function buildReferences(text, assets, { previous = [], choices = {} } = {}) {
  const mentions = parseMentions(text);
  const groups = new Map();
  const unresolved = [];
  const ambiguous = [];
  const remembered = new Map();
  for (const before of previous) {
    if (typeof before?.assetId !== 'string') continue;
    const choice = { assetId: before.assetId, variantName: before.variantName ?? null };
    if (typeof before.display === 'string') remembered.set(before.display, choice);
    if (typeof before.assetName === 'string') remembered.set(`@${before.assetName}`, choice);
  }

  for (const mention of mentions) {
    const chosen = choices?.[mention.name] ?? choices?.[mention.text] ?? remembered.get(mention.text) ?? null;
    const preferred = typeof chosen === 'string' ? { assetId: chosen } : chosen;
    const outcome = resolveMention(mention.name, assets, {
      preferredAssetId: typeof preferred?.assetId === 'string' ? preferred.assetId : null,
      preferredVariantName: typeof preferred?.variantName === 'string' ? preferred.variantName : null,
    });
    if (outcome.state === 'resolved') {
      // One asset mentioned through two spellings is one generation input. Two DIFFERENT assets
      // that happen to contain identical bytes are still two semantic slots: e.g. a character
      // portrait and a staging reference may use the same source image in a test project.
      const key = `${outcome.asset.assetId}\0${referenceFileIdentity(outcome.version)}`;
      const group = groups.get(key) ?? {
        assetId: outcome.asset.assetId,
        assetName: outcome.asset.name,
        variantId: outcome.variant.variantId,
        variantName: outcome.variant.name,
        assetVersionId: outcome.version.assetVersionId,
        role: outcome.version.role,
        fileName: outcome.version.fileName,
        relativePath: outcome.version.relativePath,
        sha256: outcome.version.sha256,
        display: `@${mention.name}`,
        // The category, so the panel's asset column can group 人物 / 场景 / 道具 instead of putting
        // every reference in 「其他参考图片」. The H3 path carries it too (buildH3References); both
        // prompts need it or only one of them groups correctly.
        assetKind: outcome.assetKind ?? outcome.asset.kind ?? null,
        ...(outcome.sourceAssetKind ? { sourceAssetKind: outcome.sourceAssetKind } : {}),
        ...(outcome.mediaType ? { mediaType: outcome.mediaType } : {}),
        ...(outcome.voiceFor ? { voiceFor: outcome.voiceFor } : {}),
        occurrences: [],
      };
      group.occurrences.push({ start: mention.start, end: mention.end, expectedText: mention.text });
      groups.set(key, group);
      continue;
    }
    if (outcome.state === 'ambiguous') {
      ambiguous.push({
        ...mention,
        candidates: outcome.candidates ?? [],
        candidateDetails: outcome.candidateDetails ?? [],
        note: outcome.note,
      });
    } else {
      unresolved.push({ ...mention, note: outcome.note });
    }
  }

  // A reference the user pinned to a specific version stays pinned: the recorded
  // assetVersionId wins over the default this parse would have chosen.
  const pinned = new Map();
  for (const before of previous) {
    for (const occurrence of before.occurrences ?? []) pinned.set(`${occurrence.start}:${occurrence.expectedText}`, before);
  }

  const references = [];
  let index = 0;
  for (const group of groups.values()) {
    index += 1;
    const first = group.occurrences[0];
    const remembered = pinned.get(`${first.start}:${first.expectedText}`);
    const keepPinned = remembered !== undefined
      && remembered.assetId === group.assetId
      && remembered.assetVersionId !== group.assetVersionId;
    references.push({
      referenceId: remembered?.referenceId ?? newReferenceId(),
      ...group,
      assetVersionId: keepPinned ? remembered.assetVersionId : group.assetVersionId,
      pinned: keepPinned || remembered?.pinned === true,
      referenceIndex: index,
      bindingState: 'resolved',
    });
  }

  return {
    references,
    unresolved: unresolved.map((entry) => ({ name: entry.name, text: entry.text, start: entry.start, note: entry.note })),
    ambiguous: ambiguous.map((entry) => ({
      name: entry.name,
      text: entry.text,
      start: entry.start,
      candidates: entry.candidates,
      candidateDetails: entry.candidateDetails,
      note: entry.note,
    })),
    // The distinct file versions a generation would upload, in reference order. This is the
    // number the prompt's reference labels must match, so it is computed once, here.
    orderedInputs: references.map((reference) => ({
      referenceIndex: reference.referenceIndex,
      assetVersionId: reference.assetVersionId,
      fileName: reference.fileName,
      role: reference.role,
      sha256: reference.sha256,
    })),
  };
}

/**
 * Stable identity used to merge the asset bar and to detect duplicate candidates.
 *
 * Different asset records can point at the exact same file (the same path and sha256) after a
 * migration/import. Their `assetVersionId` differs, but they are not two creative choices and
 * must not produce two slots or an "ambiguous" reply.
 */
export function referenceFileIdentity(reference) {
  const path = String(reference?.relativePath ?? reference?.path ?? '').replace(/\\/gu, '/');
  const hash = typeof reference?.sha256 === 'string' ? reference.sha256 : '';
  const role = String(reference?.role ?? reference?.mediaType ?? '');
  // Content is the generation input. The same bytes copied under two variant folders are one
  // image, not two references. Keeping the path in this key made `@谢妄` appear twice after a
  // legacy upload left identical copies under 墨化/ and 日常装/.
  if (hash.length > 0) return `content:${role}:${hash}`;
  if (path.length > 0) return `path:${role}:${path}`;
  if (typeof reference?.assetVersionId === 'string' && reference.assetVersionId.length > 0) {
    return `version:${reference.assetVersionId}`;
  }
  if (typeof reference?.referenceId === 'string' && reference.referenceId.length > 0) {
    return `reference:${reference.referenceId}`;
  }
  return [
    reference?.assetId ?? '',
    reference?.variantId ?? reference?.variantName ?? '',
    reference?.role ?? '',
  ].join(':');
}

/**
 * Stable identity for one visible asset-bar slot.
 *
 * A display label such as `@谢妄` is the user's slot identity. Two file versions recorded under
 * that same label are candidates for one slot, not two cards. H3's `<Picture N>` labels follow
 * the same rule. References without a display label fall back to asset + variant + role.
 */
export function referenceDisplayIdentity(reference) {
  const display = String(reference?.display ?? '').trim();
  if (display.length > 0) return `display:${display}`;
  return [
    'asset',
    reference?.assetId ?? '',
    reference?.variantId ?? reference?.variantName ?? '',
    reference?.role ?? '',
  ].join(':');
}

const referenceSlotQuality = (reference) => (Array.isArray(reference?.occurrences) && reference.occurrences.length > 0 ? 1000 : 0)
  + (typeof reference?.thumbnailHandle === 'string' && reference.thumbnailHandle.length > 0 ? 100 : 0)
  + (reference?.bindingState === 'resolved' ? 10 : 0)
  + (Number.isFinite(reference?.version) ? reference.version : 0);

function mergeReferenceSlots(references) {
  const order = [];
  const bySlot = new Map();
  for (const reference of references) {
    if (reference === null || typeof reference !== 'object') continue;
    const identity = referenceDisplayIdentity(reference);
    const previous = bySlot.get(identity);
    if (previous === undefined) {
      bySlot.set(identity, { ...reference, occurrences: [...(reference.occurrences ?? [])] });
      order.push(identity);
      continue;
    }
    const preferred = referenceSlotQuality(reference) > referenceSlotQuality(previous) ? reference : previous;
    const other = preferred === reference ? previous : reference;
    const occurrences = new Map();
    for (const occurrence of [...(preferred.occurrences ?? []), ...(other.occurrences ?? [])]) {
      if (occurrence === null || typeof occurrence !== 'object') continue;
      occurrences.set(`${occurrence.start}:${occurrence.end}:${occurrence.expectedText ?? ''}`, occurrence);
    }
    bySlot.set(identity, {
      ...preferred,
      occurrences: [...occurrences.values()].sort((left, right) => left.start - right.start),
    });
  }
  return order.map((identity) => bySlot.get(identity));
}

/**
 * Keep the video-prompt asset bar independent from edits to the prompt text.
 *
 * For a video prompt, `@name` is how the user ADDS an asset to the bar, not the storage
 * record of everything currently in it. Deleting a sentence or an `@` from the editor must
 * therefore not detach an already selected asset. Assets leave only through the explicit
 * remove action, which sends their reference/version id in `removeReferenceIds`.
 *
 * Current text wins for ordering and occurrences. Previously selected files that are no
 * longer mentioned remain afterwards, without stale text offsets.
 */
export function mergeVideoPromptReferences(current = [], previous = [], { removeReferenceIds = [] } = {}) {
  const removed = new Set((Array.isArray(removeReferenceIds) ? removeReferenceIds : [])
    .filter((value) => typeof value === 'string' && value.length > 0));
  const isRemoved = (reference) =>
    removed.has(String(reference?.referenceId ?? ''))
    || removed.has(String(reference?.assetVersionId ?? ''));

  const previousList = (Array.isArray(previous) ? previous : [])
    .filter((reference) => reference !== null && typeof reference === 'object' && !isRemoved(reference));
  const currentReferences = mergeReferenceSlots((Array.isArray(current) ? current : [])
    .filter((reference) => !isRemoved(reference)))
    .map((reference) => {
      // Re-resolution may rebuild a reference without media handles. A previous record for the
      // SAME concrete version can supply its thumbnail, but a different version never can.
      const previousMedia = (reference.thumbnailHandle === null || reference.thumbnailHandle === undefined)
        ? previousList.find((entry) => referenceDisplayIdentity(entry) === referenceDisplayIdentity(reference)
          && entry.assetVersionId === reference.assetVersionId
          && typeof entry.thumbnailHandle === 'string'
          && entry.thumbnailHandle.length > 0)
        : undefined;
      return {
        ...reference,
        ...(previousMedia === undefined ? {} : { thumbnailHandle: previousMedia.thumbnailHandle }),
        textReferenced: true,
      };
    });
  const seen = new Set(currentReferences.map(referenceDisplayIdentity));
  const retained = mergeReferenceSlots(previousList)
    .filter((reference) => !seen.has(referenceDisplayIdentity(reference)))
    .map((reference) => ({
      ...reference,
      occurrences: [],
      textReferenced: false,
    }));
  const references = [...currentReferences, ...retained]
    .map((reference, index) => ({ ...reference, referenceIndex: index + 1 }));
  return {
    references,
    orderedInputs: references.map((reference) => ({
      referenceIndex: reference.referenceIndex,
      assetVersionId: reference.assetVersionId,
      fileName: reference.fileName,
      role: reference.role,
      sha256: reference.sha256,
    })),
  };
}

const REFERENCE_MEDIA_ORDER = Object.freeze({ Picture: 0, Video: 1, Audio: 2 });

function mediaTypeOfReference(reference) {
  if (reference?.mediaType === 'Picture' || reference?.mediaType === 'Video' || reference?.mediaType === 'Audio') {
    return reference.mediaType;
  }
  if (reference?.assetKind === 'reference-audio') return 'Audio';
  if (reference?.assetKind === 'reference-video') return 'Video';
  return 'Picture';
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function speakerForCharacter(text, reference) {
  const subject = Number(reference?.subject);
  if (!Number.isInteger(subject) || subject < 1) return null;
  for (const match of String(text ?? '').matchAll(/<Subject\s+(\d+)>\s*\(([^)]*)\)/gu)) {
    if (Number(match[1]) !== subject) continue;
    const speaker = match[2].match(/\bS\d+\b/u)?.[0] ?? null;
    if (speaker !== null) return speaker;
  }
  const names = subjectNamesForVoice(String(text ?? ''));
  const name = names.get(subject);
  if (typeof name !== 'string' || name.length === 0) return null;
  const named = new RegExp(`${escapeRegExp(name)}\\s*\\(([^)]*)\\)`, 'u').exec(String(text ?? ''));
  return named?.[1]?.match(/\bS\d+\b/u)?.[0] ?? null;
}

function subjectNamesForVoice(text) {
  const names = new Map();
  const section = /subject_definitions\s*:([\s\S]*?)(?:\n\s*\n\s*[a-z_]+\s*:|\nsummary\s*:)/u.exec(text)?.[1] ?? '';
  for (const line of section.split(/\r?\n/u)) {
    const match = /^<Subject\s+(\d+)>\s*(?:是|is)\s+(.+)$/u.exec(line.trim());
    if (match === null) continue;
    const rest = match[2];
    const name = /中的\s*([^，,。\n]+)/u.exec(rest)?.[1]
      ?? /^(.+?)\s+(?:from|in)\s+<Picture\s+\d+>/iu.exec(rest)?.[1]
      ?? null;
    if (name !== null && name.trim().length > 0) names.set(Number(match[1]), name.trim());
  }
  return names;
}

/**
 * Automatically attach the user's voice file for each character present in a block.
 *
 * Voice belongs to the character asset and is never synthesized or rewritten by the director.
 * This helper only turns an existing `role: voice` file into ordinary H3 Audio references:
 *
 * - character appearance order chooses the first three voices;
 * - an explicit audio reference keeps its slot and is never overridden;
 * - when the block already has manually bound audio, the remaining slots are filled;
 * - the H3 source text is not edited. Auto voice slots are marked so `generate-h3` can accept
 *   them without requiring a matching line in the authored prompt.
 */
export function addCharacterVoicesToReferences(references, assets, {
  slots = [],
  h3 = false,
  text = '',
  maxCharacterVoices = 3,
} = {}) {
  const isAutoVoice = (entry) => entry?.autoVoice === true || entry?.binding?.autoVoice === true;
  const sourceReferences = (Array.isArray(references) ? references : [])
    .filter((reference) => !isAutoVoice(reference));
  const sourceSlots = (Array.isArray(slots) ? slots : [])
    .filter((slot) => !isAutoVoice(slot));
  const byAssetId = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.assetId, asset]));
  const audioReferences = sourceReferences.filter((reference) => mediaTypeOfReference(reference) === 'Audio');
  const occupiedAudioNumbers = new Set(audioReferences
    .map((reference) => Number(reference.referenceIndex))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 3));
  const explicitOwners = new Set();
  for (const reference of audioReferences) {
    if (typeof reference.voiceFor === 'string' && reference.voiceFor.length > 0) {
      explicitOwners.add(reference.voiceFor);
    }
  }

  const characterReferences = sourceReferences
    .filter((reference) => reference?.assetKind === 'character' && reference.bindingState === 'resolved')
    .sort((left, right) => {
      const media = REFERENCE_MEDIA_ORDER[mediaTypeOfReference(left)] - REFERENCE_MEDIA_ORDER[mediaTypeOfReference(right)];
      return media !== 0 ? media : (Number(left.referenceIndex) || 0) - (Number(right.referenceIndex) || 0);
    });
  const seenCharacters = new Set();
  const autoReferences = [];
  const autoSlots = [];
  const slotLimit = Math.min(3, Math.max(0, Number.isInteger(maxCharacterVoices) ? maxCharacterVoices : 3));
  let autoCount = 0;
  for (const character of characterReferences) {
    if (autoCount >= slotLimit) break;
    if (typeof character.assetId !== 'string' || seenCharacters.has(character.assetId)) continue;
    seenCharacters.add(character.assetId);
    const asset = byAssetId.get(character.assetId);
    const voice = characterVoiceVersion(asset);
    if (voice === undefined) continue;
    const characterName = String(character.assetName ?? asset?.name ?? '').trim();
    if (characterName.length === 0 || explicitOwners.has(characterName)) continue;
    if (audioReferences.some((reference) => String(reference.definition ?? '').includes(characterName))) continue;

    let audioNumber = null;
    for (let number = 1; number <= 3; number += 1) {
      if (!occupiedAudioNumbers.has(number)) {
        audioNumber = number;
        break;
      }
    }
    if (audioNumber === null) break;
    occupiedAudioNumbers.add(audioNumber);
    autoCount += 1;

    const subject = Number.isInteger(character.subject) ? character.subject : null;
    const speaker = speakerForCharacter(text, character);
    const label = `<Audio ${audioNumber}>`;
    const owner = subject === null ? characterName : `<Subject ${subject}>`;
    const definition = speaker === null
      ? `${label} 是 ${owner} 的人物音色参考；仅复刻声音音色与表达，不复制原句内容。`
      : `${label} 是 ${owner} (${speaker}) 的音色参考，其中包含人声层；仅复刻声音音色与表达，不复制原句内容。`;
    const reference = {
      referenceId: newReferenceId(),
      referenceIndex: audioNumber,
      display: h3 ? label : `@${characterName}（音色）`,
      definition,
      ...(h3 ? { mediaType: 'Audio' } : {}),
      assetId: character.assetId,
      assetName: characterName,
      assetKind: 'reference-audio',
      sourceAssetKind: 'character',
      variantId: voice.variantId,
      variantName: voice.variantName,
      assetVersionId: voice.assetVersionId,
      role: 'voice',
      fileName: voice.fileName,
      relativePath: voice.relativePath,
      bytes: voice.bytes,
      sha256: voice.sha256,
      version: voice.version,
      voiceFor: characterName,
      subject,
      speaker,
      occurrences: [],
      bindingState: 'resolved',
      pinned: false,
      autoVoice: true,
    };
    autoReferences.push(reference);
    if (h3) {
      const {
        display: _display,
        definition: _definition,
        occurrences: _occurrences,
        referenceId: _referenceId,
        ...binding
      } = reference;
      void _display;
      void _definition;
      void _occurrences;
      void _referenceId;
      autoSlots.push({
        label,
        definition,
        mode: 'bound',
        binding,
        autoVoice: true,
        voiceFor: characterName,
        subject,
        speaker,
      });
    }
  }

  const combined = [...sourceReferences, ...autoReferences]
    .sort((left, right) => REFERENCE_MEDIA_ORDER[mediaTypeOfReference(left)] - REFERENCE_MEDIA_ORDER[mediaTypeOfReference(right)]
      || (Number(left.referenceIndex) || 0) - (Number(right.referenceIndex) || 0));
  return {
    references: combined,
    slots: [...sourceSlots, ...autoSlots],
    autoVoiceCount: autoReferences.length,
    orderedInputs: combined.map((reference, index) => ({
      referenceIndex: index + 1,
      assetVersionId: reference.assetVersionId,
      fileName: reference.fileName,
      role: reference.role,
      sha256: reference.sha256,
    })),
  };
}

/**
 * Whether the text at an offset is exactly this mention and nothing more.
 *
 * A plain substring comparison is not enough, and the case that proves it is
 * `@林晚（女主）` followed by a hand-typed `x`: the old span still holds the old text, so a
 * naive check reports "unchanged" - but the user edited the mention, and the reference now
 * addresses something that does not exist. The character AFTER the mention has to be a
 * boundary, not another name character that the user just appended.
 */
function holdsMentionAt(source, occurrence) {
  if (source.slice(occurrence.start, occurrence.end) !== occurrence.expectedText) return false;
  const after = source.slice(occurrence.end, occurrence.end + 1);
  if (after.length === 0) return true;
  return !NAME_CHAR.test(after);
}

/**
 * Re-check recorded references against the current text.
 *
 * This is what runs after the file was edited outside the panel, or after the user changed a
 * mention by hand. The rule from the handbook: if the position can no longer be shown to
 * still hold the same text, the reference becomes `needs_review` - the user's sentence is
 * NEVER silently rewritten or dropped.
 *
 * @returns `{ references, changes }` with each reference's `bindingState` updated.
 */
export function validateReferences(text, references, assets) {
  const source = String(text ?? '');
  const changes = [];
  const out = [];
  // Parsed once: every occurrence is matched against the same mention list, and parsing per
  // occurrence would let a later edit change what an earlier one was compared against.
  const mentions = parseMentions(source);

  for (const reference of references ?? []) {
    const occurrences = [];
    let intact = true;

    for (const occurrence of reference.occurrences ?? []) {
      // How many mentions currently carry this exact text? One means the binding is still
      // unambiguous. More than one means it is not, and that is true even when the recorded
      // span still reads correctly: appending a second `@老周` somewhere else leaves the
      // first span intact while making it impossible to say which one this reference meant.
      // Checking this FIRST is what makes a duplicated mention surface for review instead of
      // passing as unchanged.
      const found = mentions.filter((mention) => mention.text === occurrence.expectedText);
      if (found.length > 1) {
        intact = false;
        changes.push({
          referenceId: reference.referenceId,
          kind: 'ambiguous-position',
          at: occurrence.start,
          expected: occurrence.expectedText,
          count: found.length,
        });
        continue;
      }

      if (holdsMentionAt(source, occurrence)) {
        occurrences.push(occurrence);
        continue;
      }
      // The span no longer holds exactly this mention. A mention that MOVED is recoverable,
      // and only when exactly one candidate exists. A mention that was EDITED is not, and the
      // distinction matters: the first is a reload, the second is a decision the user made.
      if (found.length === 1) {
        occurrences.push({ start: found[0].start, end: found[0].end, expectedText: occurrence.expectedText });
        changes.push({ referenceId: reference.referenceId, kind: 'moved', from: occurrence.start, to: found[0].start });
        continue;
      }
      intact = false;
      changes.push({
        referenceId: reference.referenceId,
        kind: 'text-changed',
        at: occurrence.start,
        expected: occurrence.expectedText,
        found: source.slice(occurrence.start, occurrence.end),
      });
    }

    // The bound version must still exist. A regeneration adds a version and never removes one,
    // so a missing binding means the file was deleted or the project was moved.
    const stillThere = assets.some((asset) => flattenVersions(asset)
      .some((file) => file.assetVersionId === reference.assetVersionId && file.missing !== true));
    if (!stillThere) changes.push({ referenceId: reference.referenceId, kind: 'version-missing', assetVersionId: reference.assetVersionId });

    out.push({
      ...reference,
      occurrences,
      bindingState: !intact || occurrences.length === 0 ? 'needs_review' : (stillThere ? 'resolved' : 'needs_review'),
    });
  }

  return { references: out, changes };
}

let refCounter = 0;
/** An id for one reference group. */
export function newReferenceId() {
  refCounter += 1;
  return `ref_${Date.now().toString(36)}${refCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Where a mention should be inserted, and what text to insert.
 *
 * The display form is the base asset name because that is what the prompt format writes and
 * what a video model reads. The chosen VERSION is carried by the reference record, not by the
 * text, so a version change never rewrites the user's sentence.
 */
export function mentionFor(asset, variantName = null) {
  const suffix = variantName === null || variantName === 'default' ? '' : `（${variantName}）`;
  return { text: `@${asset.name}${suffix}`, assetId: asset.assetId, variantName };
}

/**
 * H3's own reference syntax: `<Subject N>` bound to `<Picture N>`.
 *
 * ## Why the @ parser cannot see these
 *
 * H3 does not use `@` - that is by design, not an omission. An H3 prompt declares its references
 * once, at the top:
 *
 *     subject_definitions:
 *     <Subject 1> 是 <Picture 1> 中的林晚，面容、五官、发型与服装严格沿用参考图：…
 *     <Subject 4> 是 <Picture 4> 中的深夜公寓玄关环境，空间布局、陈设与材质严格沿用参考图：…
 *
 * and then refers to them by number throughout the body (`<Subject 1> 站在 <Subject 4> 的入户门内`).
 * A correct H3 file therefore parses to ZERO `@` mentions, and a reference bar that only understood
 * `@` showed nothing at all - on the very file the video model is fed from.
 *
 * ## What the number means
 *
 * `<Picture N>` IS the reference slot: the Nth image uploaded, in that order. So it is not a
 * positional offset like a `@` mention - it is the slot number itself, which is why it becomes
 * `referenceIndex` directly rather than being counted from text order.
 *
 * @param text - the H3 prompt file's contents.
 * @returns `{ pictures, subjects, order }`. A definition whose sentence cannot be read keeps its
 *   number and reports `name: null` rather than guessing: a missing binding is a question the user
 *   can answer, a wrong binding is a silently wrong image.
 */
export function parseH3References(text) {
  const source = String(text ?? '');
  const picturePattern = /<Picture\s*(\d+)>/gu;
  const subjectPattern = /<Subject\s*(\d+)>/gu;

  // The definitions section, matched by its own name so a reordered file still works, and bounded by
  // the next top-level field so a name in the body is not mistaken for a definition.
  const definitionsMatch = /subject_definitions\s*:([\s\S]*?)(?:\n\s*\n\s*[a-z_]+\s*:|\nsummary\s*:)/u.exec(source);
  const definitions = definitionsMatch === null ? source : definitionsMatch[1];

  const pictures = [];
  const seen = new Set();
  for (const line of definitions.split(/\r?\n/u)) {
    const picture = /<Picture\s*(\d+)>/u.exec(line);
    if (picture === null) continue;
    const number = Number(picture[1]);
    if (seen.has(number)) continue;
    seen.add(number);
    const subject = /<Subject\s*(\d+)>/u.exec(line);
    // The asset name, read relative to the `<Picture N>` token rather than by one language's wording.
    //
    // The two H3 files spell the binding on OPPOSITE sides of the number:
    //
    //     <Subject 1> 是 <Picture 1> 中的林晚，…            (Chinese: the name follows)
    //     <Subject 1> is 林晚 from <Picture 1>; …          (English: the name precedes)
    //
    // Matching `中的` alone read all six Chinese pictures and none of the English ones, so the
    // English file - the one actually fed to the model - resolved to zero references. Anchoring on
    // the token handles both without a per-language rule.
    const pictureAt = line.indexOf(`<Picture ${String(number)}>`);
    const before = pictureAt > 0 ? line.slice(0, pictureAt) : '';
    const after = pictureAt >= 0 ? line.slice(pictureAt) : line;
    const afterMatch = /^\s*(?:中的|in|of|from)\s*([^，,。；;:\n]{1,80})/iu.exec(after.replace(/^<Picture\s*\d+>/u, ''));
    /**
     * A STANDALONE reference, with no `<Subject N>`: 「<Picture 3> 是 外卖袋 的参考，用于初始位置」。
     *
     * `compile-h3` emits this shape for a 功能参考 (`初始位置参考：@外卖袋`), where the picture is not a
     * cast member and therefore has no subject. Without this branch the name read as `null`, the
     * reference was reported unresolved, and `generate-h3` refused the very prompt the compiler had
     * just produced. Only tried when the line has no `<Subject>`, so the cast form is untouched.
     */
    const standaloneMatch = subject === null
      ? /^\s*是\s*([^，,。；;:\n]{1,80}?)\s*的(?:图|参考|示例|示意|素材)/u.exec(after.replace(/^<Picture\s*\d+>/u, ''))
      : null;
    // `is 林晚 from <Picture 1>` -> take what sits between the verb and the preposition.
    // 60, not 40: “the late-night apartment entryway environment” is 45 characters, and a
    // 40-character cap silently failed on it while shorter names worked - so the bug looked like a
    // language problem rather than an off-by-length one.
    const beforeMatch = /(?:is|是)\s+(?:the\s+)?([^，,。；;:\n]{1,80}?)\s+(?:from|in|of)\s*$/iu.exec(before);
    const name = (beforeMatch?.[1] ?? afterMatch?.[1] ?? standaloneMatch?.[1] ?? null);
    pictures.push({
      picture: number,
      subject: subject === null ? null : Number(subject[1]),
      // A leading article is prose, not part of the name.
      name: name === null ? null : name.replace(/^(?:the|a|an)\s+/iu, '').trim(),
      definition: line.trim().slice(0, 400),
    });
  }

  const subjects = [...new Set([...source.matchAll(subjectPattern)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  const used = [...new Set([...source.matchAll(picturePattern)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  const media = [];
  const mediaSeen = new Set();
  for (const line of definitions.split(/\r?\n/u)) {
    // The slot label is the identity. Accept `是1`, `是 1`, or even an incomplete
    // `<Audio 1> 是 的参考`; a saved panel binding supplies the actual file.
    const match = /^\s*<(Audio|Video)\s*(\d+)>\s*(?:is|是)?\s*([^；;，,。\n]*)/u.exec(line);
    if (!match || mediaSeen.has(`${match[1]}:${match[2]}`)) continue;
    mediaSeen.add(`${match[1]}:${match[2]}`);
    const name = match[3].trim();
    media.push({ mediaType: match[1], picture: Number(match[2]), subject: null, name: name.length > 0 ? name : null, definition: line.trim() });
  }
  return { pictures, subjects, order: used, ...(media.length ? { media } : {}) };
}

/** Whether a file is an H3 prompt rather than a 大分镜 storyboard. */
export function looksLikeH3(text) {
  const source = String(text ?? '');
  return /subject_definitions\s*:/u.test(source) || /<Picture\s*\d+>/u.test(source);
}

/**
 * Turn H3 picture definitions into reference records, resolved against the asset library.
 *
 * Separate from {@link parseH3References} so the extraction can be tested without a library, and so
 * an H3 file with no library available still reports its picture numbers rather than nothing.
 *
 * ## Why a sibling file is needed
 *
 * The 中文 and 英文 H3 files are the SAME six pictures in the same order - the numbers are the slots,
 * and both files were produced from one storyboard. But the English file translates the asset names
 * too (`<Picture 4>` becomes "the late-night apartment entryway environment"), and no amount of
 * name matching recovers `深夜公寓玄关` from that. Since the numbering is shared, the Chinese file's
 * names are the mapping for the English file's pictures.
 *
 * @param options.hint - another H3 file's text for the same episode. Any picture number the hint
 *   names is used when this file's own sentence did not yield a usable name.
 */
export function buildH3References(text, assets, { previous = [], hint = null, slots = [] } = {}) {
  const parsed = parseH3References(text);
  const hinted = hint === null ? new Map() : new Map(parseH3References(hint).pictures
    .filter((entry) => entry.name !== null)
    .map((entry) => [entry.picture, entry.name]));
  const normalizeDefinition = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const slotByLabel = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (slot === null || typeof slot !== 'object') continue;
    if (typeof slot.label !== 'string' || slot.label.length === 0) continue;
    slotByLabel.set(slot.label, { ...slot, definition: normalizeDefinition(slot.definition) });
  }
  const references = [];
  const unresolved = [];
  const parsedByLabel = new Map([...parsed.pictures, ...(parsed.media ?? [])]
    .map((entry) => [`<${entry.mediaType ?? 'Picture'} ${entry.picture}>`, entry]));
  const usedLabels = new Set();
  const isLiveBinding = (binding) => typeof binding?.assetVersionId === 'string'
    && assets.some((asset) => flattenVersions(asset)
      .some((file) => file.assetVersionId === binding.assetVersionId && file.missing !== true));
  const addBoundSlot = (label, savedSlot) => {
    const shown = /^<(Picture|Audio|Video)\s+(\d+)>$/u.exec(label);
    if (shown === null || savedSlot?.mode !== 'bound' || savedSlot.binding === null || typeof savedSlot.binding !== 'object') return false;
    const binding = savedSlot.binding;
    if (!isLiveBinding(binding)) {
      unresolved.push({
        start: 0,
        text: label,
        note: `素材栏绑定的文件 ${String(binding.fileName ?? binding.assetVersionId ?? '')} 已不在磁盘上`,
      });
      usedLabels.add(label);
      return true;
    }
    const parsedEntry = parsedByLabel.get(label) ?? null;
    references.push({
      ...binding,
      referenceId: binding.referenceId ?? newReferenceId(),
      referenceIndex: Number(shown[2]),
      display: label,
      definition: savedSlot.definition || parsedEntry?.definition || '',
      ...(shown[1] === 'Picture' ? {} : { mediaType: shown[1] }),
      occurrences: [],
      bindingState: 'resolved',
      pinned: binding.pinned === true,
      subject: parsedEntry?.subject ?? null,
    });
    usedLabels.add(label);
    return true;
  };
  /**
   * The asset bar is panel state, not a projection of the prompt.
   *
   * Once a slot is bound its record survives editing or even clearing the H3 text. This is what
   * keeps a user from deleting a sentence and accidentally deleting the material column with it.
   */
  for (const [label, savedSlot] of slotByLabel) addBoundSlot(label, savedSlot);
  for (const entry of [...parsed.pictures, ...(parsed.media ?? [])]) {
    const label = `<${entry.mediaType ?? 'Picture'} ${entry.picture}>`;
    if (usedLabels.has(label)) continue;
    const savedSlot = slotByLabel.get(label) ?? null;
    // A panel-owned slot is identified by `<Audio 1>` / `<Video 1>`, not by the prose that follows
    // it. Comparing the whole definition meant editing a file name in the prompt silently detached
    // the uploaded media. The label is already the workflow slot; keep the binding stable across
    // description edits, and let the asset bar's explicit remove/restore controls change it.
    const slotApplies = savedSlot !== null;
    // `detached` is the old spelling for an empty slot. Treat it as empty, without rendering a
    // tombstone card or blocking the prompt from being edited back into use.
    if (slotApplies && (savedSlot.mode === 'empty' || savedSlot.mode === 'detached')) continue;
    if (slotApplies && savedSlot.mode === 'bound' && savedSlot.binding !== null && typeof savedSlot.binding === 'object') {
      const binding = savedSlot.binding;
      if (isLiveBinding(binding)) {
        references.push({
          ...binding,
          referenceId: binding.referenceId ?? newReferenceId(),
          referenceIndex: entry.picture,
          display: label,
          definition: entry.definition,
          ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
          occurrences: [],
          bindingState: 'resolved',
          pinned: binding.pinned === true,
          subject: entry.subject,
        });
        continue;
      }
      unresolved.push({
        start: 0,
        text: label,
        note: `素材栏绑定的文件 ${String(binding.fileName ?? binding.assetVersionId ?? '')} 已不在磁盘上；提示词原文保持不变`,
      });
      continue;
    }
    // The sibling's name is used only when it actually REACHES an asset and this file's own name does
    // not.
    //
    // Neither name is unconditionally better. In a translated file this file's own name is a
    // translation (`kraft paper takeaway bag`) and the sibling's is the original (`外卖袋`), so the
    // sibling wins. In the original file the sibling IS the translation, and adopting it would throw
    // away the good name and lose bindings that already worked - which is exactly what happened when
    // this preferred the sibling unconditionally: the Chinese file dropped from six bindings to four.
    // Testing which one resolves settles it without having to know which file is which, and it cannot
    // make a working binding worse.
    /**
     * Resolve by name, then by FILE stem.
     *
     * The library's asset name is derived from the file name with the generator suffix stripped
     * (`外卖袋_00001_.png` -> `外卖袋`). A prompt written with the raw file stem - which is exactly what a
     * person sees in their file manager, and what an upload writes if the returned name is missed -
     * therefore missed every time. Falling back to the file stem means ANY image that was imported can be
     * referenced by the name the user actually sees, which is the point of uploading it.
     */
    const byFileName = (wanted) => {
      const target = String(wanted).trim().toLowerCase();
      if (target.length === 0) return null;
      const candidates = [];
      for (const [assetIndex, asset] of assets.entries()) {
        for (const variant of asset.variants ?? []) {
          for (const file of variant.files ?? []) {
            if (file.missing === true) continue;
            const stem = stripGeneratorSuffix(String(file.fileName ?? '')).stem.trim().toLowerCase();
            if (stem !== target) continue;
            candidates.push({
              asset,
              variant,
              file,
              assetIndex,
              canonical: ['character', 'scene', 'prop'].includes(asset.kind) ? 0 : 1,
              quadview: file.role === 'quadview' ? 0 : 1,
            });
          }
        }
      }
      candidates.sort((left, right) => left.canonical - right.canonical
        || left.quadview - right.quadview
        || left.assetIndex - right.assetIndex);
      const best = candidates[0];
      return best === undefined ? null : {
        state: 'resolved',
        asset: best.asset,
        variant: best.variant,
        version: best.file,
        role: best.file.role,
        alternatives: [],
      };
    };
    const resolveName = (wanted) => {
      if (wanted === null) return null;
      const byName = resolveMention(wanted, assets, { allowDescriptive: true });
      if (byName !== null && byName.state === 'resolved') return byName;
      return byFileName(wanted) ?? byName;
    };

    const other = entry.mediaType ? null : hinted.get(entry.picture) ?? null;
    // THIS file's explicit name wins. The sibling hint is a fallback for translated prose, not a
    // correction for a name the author wrote. Checking the file stem here is essential: a prompt
    // such as `顾星野_四视图` resolves to the character's quadview even though the sibling still
    // names an older prop in the same Picture slot.
    const ownHit = resolveName(entry.name);
    const name = ownHit === null || ownHit.state !== 'resolved'
      ? (other ?? entry.name)
      : entry.name;
    if (name === null) {
      unresolved.push({
        start: 0,
        text: label,
        note: `第 ${String(entry.picture)} 张参考图没写明是哪个资产；subject_definitions 里应写成「<Subject N> 是 <Picture N> 中的资产名，…」`,
      });
      continue;
    }
    const hit = resolveName(name);
    if (hit === null || hit.state !== 'resolved') {
      unresolved.push({
        start: 0,
        text: `${label} ${name}`,
        note: `参考图里写的「${name}」在资产库里${hit?.state === 'unresolved' ? '找不到' : '有多个候选'}；请让它和资产名一致`,
      });
      continue;
    }
    const kept = previous.find((record) => record.assetVersionId === hit.version.assetVersionId);
    references.push({
      referenceId: kept?.referenceId ?? newReferenceId(),
      // The picture NUMBER is the slot, so it is the index - not a count of what came before it.
      referenceIndex: entry.picture,
      display: label,
      definition: entry.definition,
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      assetId: hit.asset.assetId,
      assetName: hit.asset.name,
      variantId: hit.variant.variantId,
      variantName: hit.variant.name,
      /**
       * The asset's own category, for the panel's asset column.
       *
       * A resolved reference's `kind` is the generic `reference-image` (it became a <Picture N>), so the
       * panel could not tell 林川 from 写字楼大厅 and dropped everything into 「其他参考图片」. The library
       * knows the real one - `character` / `scene` / `prop` - and this is the only layer that has it.
       */
      assetKind: hit.asset?.kind ?? null,
      assetVersionId: hit.version.assetVersionId,
      role: hit.version.role,
      fileName: hit.version.fileName,
      relativePath: hit.version.relativePath,
      bytes: hit.version.bytes,
      sha256: hit.version.sha256,
      version: hit.version.version,
      occurrences: [],
      bindingState: 'resolved',
      pinned: kept?.pinned === true,
      subject: entry.subject,
    });
  }
  // Sorted by picture number: that order is the order the model reads the images in.
  references.sort((a, b) => ['Picture', 'Video', 'Audio'].indexOf(a.mediaType ?? 'Picture') - ['Picture', 'Video', 'Audio'].indexOf(b.mediaType ?? 'Picture') || a.referenceIndex - b.referenceIndex);
  for (const match of String(text).matchAll(/<(Picture|Audio|Video)\s*(\d+)>/gu)) {
    const label = `<${match[1]} ${Number(match[2])}>`;
    const savedSlot = slotByLabel.get(label);
    if (savedSlot?.mode === 'empty' || savedSlot?.mode === 'detached') continue;
    if (!references.some((entry) => entry.display === label) && !unresolved.some((entry) => entry.text?.startsWith(label))) unresolved.push({ start: match.index, text: label, note: 'H3 引用没有可用的资产定义' });
  }
  return {
    references,
    unresolved,
    ambiguous: [],
    changes: [],
    orderedInputs: references.map((reference, index) => ({
      referenceIndex: index + 1,
      assetVersionId: reference.assetVersionId,
      fileName: reference.fileName,
      role: reference.role,
      sha256: reference.sha256,
    })),
  };
}

/**
 * Make the model-facing H3 prose agree with a slot's uploaded image without editing the prompt file.
 *
 * Picture slots are explicit user decisions. When `<Picture 1>` is bound to 顾星野's four-view but
 * the authored Subject line still says 谢妄, sending the authored line unchanged asks the model to
 * render 谢妄 and lets the new image lose. Replace only the identity name outside dialogue and quoted
 * on-screen text, so spoken lines and visible lettering remain exactly as written.
 */
export function reconcileH3ReferenceNames(text, references = []) {
  const source = String(text ?? '');
  const parsed = parseH3References(source);
  const byLabel = new Map();
  for (const reference of Array.isArray(references) ? references : []) {
    if (typeof reference?.display === 'string'
      && typeof reference?.assetName === 'string'
      && reference.assetName.trim().length > 0) {
      byLabel.set(reference.display, reference.assetName.trim());
    }
  }
  const identityKey = (value) => {
    let current = String(value ?? '').trim().toLowerCase();
    let previous = null;
    while (previous !== current) {
      previous = current;
      current = current
        .replace(/[（(][^）)]*[）)]\s*$/u, '')
        .replace(/[_\s·-]*(?:四视图|定妆照|参考图|环境|场景|道具)\s*$/u, '')
        .trim();
    }
    return current;
  };
  const replacements = new Map();
  for (const entry of [...parsed.pictures, ...(parsed.media ?? [])]) {
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) continue;
    const label = `<${entry.mediaType ?? 'Picture'} ${entry.picture}>`;
    const next = byLabel.get(label);
    if (next === undefined) continue;
    const old = entry.name.trim();
    if (identityKey(old) === identityKey(next)) continue;
    if (replacements.has(old) && replacements.get(old) !== next) replacements.set(old, null);
    else replacements.set(old, next);
  }
  const pairs = [...replacements.entries()]
    .filter(([, next]) => typeof next === 'string')
    .sort((left, right) => right[0].length - left[0].length);
  if (pairs.length === 0) return source;
  let output = source.split(/(<d>[\s\S]*?<\/d>|"[^"\n]*"|“[^”\n]*”)/gu).map((part, index) => {
    if (index % 2 === 1) return part;
    let segment = part;
    for (const [position, [old]] of pairs.entries()) segment = segment.split(old).join(`__H3_SLOT_NAME_${position}__`);
    return segment;
  }).join('');
  for (const [position, [, next]] of pairs.entries()) output = output.split(`__H3_SLOT_NAME_${position}__`).join(next);
  return output;
}
