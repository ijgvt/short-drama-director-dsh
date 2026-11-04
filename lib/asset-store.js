/**
 * The asset library: identity, variants, file versions and content hashing.
 *
 * ## What was wrong before
 *
 * Assets were files in folders, addressed by name. Three consequences, all of them real:
 *
 *   - `lib/workspace.js` compared base names with the parentheses stripped, so
 *     `林晚（家居服）` and `林晚（礼服）` were treated as interchangeable - two costumes of one
 *     character collapsed into one asset.
 *   - Synchronisation decided "already copied" from FILE SIZE. A regenerated image of the
 *     same dimensions has the same size, so the episode kept using the old picture while
 *     the library showed the new one. Nothing reported a problem.
 *   - A name is not an identity. Regenerating produced `深夜公寓玄关_00001_.png` next to
 *     `深夜公寓玄关.png`, and nothing said they were the same scene at two versions.
 *
 * ## The model
 *
 * ```
 * Asset            林晚              one character, scene or prop - `assetId`
 *  └ AssetVariant  家居服 / 新规范    a costume, an age, a time of day - `variantId`
 *     └ AssetFileVersion  四视图 v2   one concrete file - `assetVersionId`, sha256, role
 * ```
 *
 * A file version is immutable once registered: if the bytes at its path change, that is a
 * NEW version and the old one is marked superseded, so a shot bound to v2 keeps pointing at
 * v2 after v3 arrives.
 *
 * ## What a scan can and cannot decide
 *
 * Directory names are the only structure available, so the parse is deliberately
 * conservative. `林晚（女主）` is a character name with a ROLE in the parentheses, not a
 * costume; `深夜公寓玄关（新规范）` is a scene with a VARIANT. Both are recorded as a variant
 * name, because the difference is not knowable from a folder name - and guessing wrong is
 * worse than recording the string the user typed. Anything genuinely ambiguous is reported
 * in `problems` for the user to resolve rather than silently resolved here.
 *
 * @module dsh-plugin-short-drama-director/lib/asset-store
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readAssetInventory } from './asset-inventory.js';
import { cleanAssetLabel } from './asset-name.js';

/** Metadata layout version for `assets.json`. */
export const ASSET_SCHEMA_VERSION = 1;

/** Current category folders plus the legacy combined media folder. */
const KIND_BY_FOLDER = new Map([
  ['人物资产', 'character'],
  ['场景资产', 'scene'],
  ['道具资产', 'prop'],
  ['其他参考图片', 'reference-image'],
  ['参考视频', 'reference-video'],
  ['参考音频', 'reference-audio'],
  ['参考媒体', 'reference-media'],
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif']);
const MEDIA_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);

/** Files a generator leaves behind that are not assets. */
const SCRATCH_PATTERNS = [
  /^rgthree\.compare\._temp_/iu,   // ComfyUI's rgthree comparison node scratch output
  /^ComfyUI_/iu,                   // ComfyUI's default unnamed output
  /\.tmp$/iu,
  /^\./u,                          // hidden files
];
const INTERNAL_ASSET_DIRECTORY = /^_(?:rejected|trash|backup|archive|draft|tmp|temp)(?:[._ -].*)?$/iu;
const FILE_DESCRIPTOR_TOKEN = /^(?:四视图|三视图|正面|侧面|背面|特写|定妆照|声音|音色|primary|quadview|quad_view|threeview|front|side|back|closeup|voice)(?:[\s_-]*(?:\d+(?:\.\d+)?\s*(?:x|倍)|超分|放大|高清))?$/iu;

/**
 * Whether a file is a generator's scratch output rather than a produced asset.
 *
 * These matter because they sit in the same folders as real assets and would otherwise be
 * offered as selectable references. `rgthree.compare._temp_*` in particular appears next to
 * the asset it was comparing.
 */
export function isScratchFile(name) {
  return SCRATCH_PATTERNS.some((pattern) => pattern.test(name));
}

/** A file that is an image and not scratch. */
export function isAssetFile(name, kind = null) {
  if (isScratchFile(name)) return false;
  const ext = extname(name).toLowerCase();
  if (kind === 'reference-video') return VIDEO_EXT.has(ext);
  if (kind === 'reference-audio') return AUDIO_EXT.has(ext);
  // A character's voice is part of that character, not a second audio asset. Keep the scan
  // deliberately narrow: only files explicitly named as 音色 / 声音 / voice / audio enter a
  // character folder as media, so an unrelated recording cannot silently become the voice.
  if (kind === 'character' && AUDIO_EXT.has(ext)) {
    return /音色|声音|voice|audio/iu.test(basename(name, ext));
  }
  return IMAGE_EXT.has(ext) || (kind === 'reference-media' && MEDIA_EXT.has(ext));
}

/** sha256 of a file's bytes. */
export async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * The role a file plays within its variant.
 *
 * The roles are what make two files of one asset non-interchangeable: a `quadview` is a
 * reference sheet, a `front` is the hero image, and a downstream workflow that wants one
 * will produce nonsense if handed the other.
 */
export function roleOf(fileName) {
  const stem = basename(fileName, extname(fileName));
  // Audio is never a portrait even when the character's own name contains a role word such as
  // `定妆照`. Role priority must follow the actual media type before looking at the filename.
  if (AUDIO_EXT.has(extname(fileName).toLowerCase())) return 'voice';
  if (/定妆照|全身照|fullbody|full_body/iu.test(stem)) return 'front';
  if (/四视图|quadview|quad_view/iu.test(stem)) return 'quadview';
  if (/三视图|threeview/iu.test(stem)) return 'threeview';
  if (/夜景|night/iu.test(stem)) return 'night';
  if (/正面|front/iu.test(stem)) return 'front';
  if (/侧面|side/iu.test(stem)) return 'side';
  if (/背面|back/iu.test(stem)) return 'back';
  if (/特写|closeup|close_up/iu.test(stem)) return 'closeup';
  return 'primary';
}

/**
 * Strip the generator's variant numbering off a file's stem.
 *
 * ComfyUI appends `_00001_` (and continues upward) when it saves instead of overwriting, so
 * `深夜公寓玄关_00001_.png` is the same asset as `深夜公寓玄关.png`, saved again. Removing the
 * suffix is what lets them be recognised as two versions of one asset rather than two assets.
 *
 * @returns `{ stem, copy }` where `copy` is the generator's number, or null.
 */
export function stripGeneratorSuffix(fileName) {
  const ext = extname(fileName);
  let stem = basename(fileName, ext);
  let copy = null;
  const numbered = /^(.*?)_(\d{5})_?$/u.exec(stem);
  if (numbered !== null) {
    stem = numbered[1];
    copy = Number(numbered[2]);
  }
  return { stem, copy };
}

/**
 * Split a folder name into its asset name and its parenthesised qualifier.
 *
 * `林晚（女主）` gives `{ name: '林晚', qualifier: '女主' }`. The qualifier is kept verbatim
 * and never interpreted: for a character it is usually a role, for a scene it is usually a
 * variant, and the folder name does not say which. Recording the user's own string is the
 * only honest option, and it keeps `林晚（家居服）` distinct from `林晚（礼服）` - the
 * distinction the old base-name comparison erased.
 */
export function parseAssetFolder(folderName) {
  const text = cleanAssetLabel(folderName);
  const match = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/u.exec(text);
  if (match === null) return { name: text, qualifier: null };
  return { name: cleanAssetLabel(match[1]), qualifier: cleanAssetLabel(match[2]) };
}

function splitQualifierTokens(value) {
  return String(value ?? '')
    .replace(/[（）()]/gu, ' ')
    .split(/[·・,，/]/u)
    .map((token) => cleanAssetLabel(token))
    .filter((token) => token.length > 0);
}

/**
 * Canonicalize a stored or filename-derived variant name.
 *
 * File-role words are metadata, not costume/state names. This turns legacy records such as
 * `魔化·（四视图）3x` back into `魔化`, so a scan cannot leave one costume split across three
 * cards. Base-shape labels (`基础定妆`, `基础造型`) join the asset's identity variant.
 */
export function canonicalVariantName(value, { identityVariant = null } = {}) {
  const fallback = cleanAssetLabel(identityVariant);
  const identity = fallback.length > 0 ? fallback : 'default';
  const cleaned = cleanAssetLabel(value).replace(/[（）()]/gu, ' ');
  if (cleaned.length === 0 || /^default$/iu.test(cleaned)) return identity;
  if (cleanAssetLabel(identityVariant) === cleaned) return identity;
  if (/^(?:基础定妆|基础造型|基础形象|标准造型|identity)$/iu.test(cleaned)) return identity;
  const tokens = splitQualifierTokens(cleaned)
    .filter((token) => !FILE_DESCRIPTOR_TOKEN.test(token) && !isFileScaleName(token));
  return tokens.length > 0 ? tokens.join('·') : identity;
}

/**
 * Read the variant from a FILE name inside a character/scene folder.
 *
 * A real project keeps every image for one character in that character's folder:
 * `林妙.png`, `林妙（记者会）.png`, `林妙（记者会·四视图）.png`. The folder qualifier
 * (`女主`) names the role, not the costume. Looking only at the folder put every one of
 * those files into the `女主` variant and left `记者会` with zero images, so the asset
 * page showed an empty costume even though the picture was on disk.
 *
 * Parenthesised file descriptions are compound: the meaningful part is a variant
 * (`记者会`, `戏服`, `夜`, `反打`), while `四视图`/`3x`/`超分` describe the file itself.
 * Those descriptors are removed before choosing a variant; a file with none falls back
 * to the folder qualifier.
 */
export function parseAssetFileStem(fileName, { folderQualifier = null } = {}) {
  const { stem, copy } = stripGeneratorSuffix(fileName);
  const trimmed = cleanAssetLabel(stem);
  const firstParen = trimmed.search(/[（(]/u);

  // A qualifier may be followed by more parenthesised file metadata:
  // `谢妄（魔化）（四视图）3x_00001_.png` is the `魔化` variant, not a new
  // `魔化·（四视图）3x` variant.
  if (firstParen > 0) {
    const base = cleanAssetLabel(trimmed.slice(0, firstParen));
    const qualifierText = trimmed.slice(firstParen);
    const groups = [...qualifierText.matchAll(/[（(]([^（）()]*)[)）]/gu)].map((entry) => entry[1]);
    const trailing = qualifierText.replace(/[（(][^（）()]*[)）]/gu, ' ');
    const tokens = [...groups.flatMap(splitQualifierTokens), ...splitQualifierTokens(trailing)];
    const scales = tokens.filter((token) => isFileScaleName(token));
    const variantTokens = tokens.filter((token) => !isFileScaleName(token) && !FILE_DESCRIPTOR_TOKEN.test(token));
    return {
      base,
      copy,
      variantTokens,
      variantName: variantTokens.length > 0
        ? variantTokens.join('·')
        : (folderQualifier === null || folderQualifier === undefined ? null : cleanAssetLabel(folderQualifier)),
      scale: scales.length > 0 ? scales.join('·') : null,
    };
  }

  // Files also use unparenthesised suffixes (`林晚四视图.png`, `公司楼下_3x.png`).
  // Strip only recognised trailing metadata so the base name remains searchable.
  const trailing = /^(.*?)(?:[\s_·・-]+)([^·・\s_-]+)$/u.exec(trimmed);
  const trailingToken = trailing?.[2] ?? null;
  const hasTrailingMetadata = trailing !== null && (FILE_DESCRIPTOR_TOKEN.test(trailingToken) || isFileScaleName(trailingToken));
  const base = hasTrailingMetadata ? trailing[1].trim() : trimmed;
  const scales = hasTrailingMetadata && isFileScaleName(trailingToken) ? [trailingToken] : [];
  let scaleFromDescriptor = null;
  if (!hasTrailingMetadata) {
    for (const descriptor of ['四视图', '三视图', '正面', '侧面', '背面', '特写', '定妆照', '声音', '音色']) {
      if (base.length > descriptor.length && base.endsWith(descriptor)) {
        scaleFromDescriptor = descriptor;
        break;
      }
    }
  }
  const cleanBase = cleanAssetLabel(scaleFromDescriptor === null ? base : base.slice(0, -scaleFromDescriptor.length));
  return {
    base: cleanBase,
    copy,
    variantTokens: [],
    variantName: folderQualifier === null || folderQualifier === undefined ? null : cleanAssetLabel(folderQualifier),
    scale: scales.length > 0 ? scales.join('·') : null,
  };
}

/** Whether a name is only a file-quality suffix, not a real asset variant. */
export function isFileScaleName(value) {
  return /^(?:\d+(?:\.\d+)?\s*(?:x|倍)|(?:超分|放大|高清)(?:\s*\d+(?:\.\d+)?\s*(?:x|倍)?)?|upscal(?:e|ed)?(?:\s*\d+(?:\.\d+)?\s*x?)?)$/iu.test(String(value ?? '').trim());
}

/**
 * The variant a recorded file actually belongs to.
 *
 * Older indexes grouped every file in an identity folder under the folder's role qualifier,
 * so `林妙（保洁工服·四视图）.png` was recorded as a file of variant `女主`. Resolution must
 * not trust that stale `variantName`; it derives the variant from the path first:
 * a variant subfolder wins, then a qualifier in the file name, then the asset's identity.
 */
export function fileVariantName(asset, file) {
  const relative = String(file?.relativePath ?? file?.paths?.[0] ?? '').replace(/\\/gu, '/');
  const parts = relative.split('/').filter(Boolean);
  const fileName = String(file?.fileName ?? file?.name ?? '');
  const recordedVariant = [file?.variantName, file?.qualifier]
    .find((value) => typeof value === 'string' && value.length > 0 && !isFileScaleName(value))
    ?? null;
  const folderCandidates = [
    asset?.identityFolder,
    ...String(asset?.folder ?? '').split(/\s+\+\s+/u),
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.replace(/\\/gu, '/').split('/').filter(Boolean))
    .sort((left, right) => right.length - left.length);

  if (folderCandidates.length === 0) {
    const parsed = parseAssetFileStem(String(file?.fileName ?? file?.name ?? ''), {
      folderQualifier: asset?.identityVariant ?? null,
    });
    return parsed.variantName ?? asset?.identityVariant ?? 'default';
  }

  const hasAssetPrefix = parts[0] === '资产';
  const relativeParts = hasAssetPrefix ? parts.slice(1) : parts;
  for (const folderParts of folderCandidates) {
    const matches = folderParts.every((part, index) => relativeParts[index] === part);
    if (!matches) continue;
    const afterBase = relativeParts.slice(folderParts.length);
    // A directory below the asset folder is an explicit costume/variant folder.
    if (afterBase.length > 1) return afterBase[0];
    if (afterBase.length === 1) {
      const parsed = parseAssetFileStem(fileName);
      if (parsed.variantName !== null && !isFileScaleName(parsed.variantName)) {
        return parsed.variantName;
      }
      const folderName = folderParts.at(-1) ?? '';
      return parseAssetFolder(folderName).qualifier
        ?? asset?.identityVariant
        ?? 'default';
    }
  }

  // A stale or synthetic index may carry a path that no longer matches any recorded asset
  // folder. In that case the file name is not enough evidence to reassign it; honour the
  // recorded variant until a rescan can establish the new path.
  return recordedVariant
    ?? (isFileScaleName(asset?.identityVariant) ? 'default' : asset?.identityVariant)
    ?? 'default';
}

/** Map a category folder name to its asset kind. */
export function kindOfFolder(folderName) {
  return KIND_BY_FOLDER.get(String(folderName).trim()) ?? null;
}

/** Whether a directory name looks like a per-asset subfolder rather than something else. */
function isAssetFolder(name) {
  return !isScratchFile(name) && !name.startsWith('.') && !INTERNAL_ASSET_DIRECTORY.test(name);
}

/**
 * Read the asset tree from disk without writing anything.
 *
 * @param root - absolute project root.
 * @returns `{ kind, folder, assetName, qualifier, files: [{ name, path, relativePath, bytes, sha256, role, copy }] }`
 *   per asset, plus `problems` for anything the parse could not decide.
 */
export async function scanAssets(root) {
  const assets = [];
  const problems = [];
  const assetRoot = join(root, '资产');

  let kindDirs = [];
  try {
    kindDirs = await readdir(assetRoot, { withFileTypes: true });
  } catch {
    return { assets: [], problems: [{ kind: 'no-asset-folder', detail: `no 资产/ folder under ${root}` }] };
  }

  for (const kindDir of kindDirs.filter((entry) => entry.isDirectory())) {
    const kind = kindOfFolder(kindDir.name);
    if (kind === null) {
      // 资产提示词 / 资产盘点稿 are documents, not assets. Not a problem, just not a kind.
      continue;
    }

    const kindPath = join(assetRoot, kindDir.name);
    const entries = await readdir(kindPath, { withFileTypes: true });

    // Characters live one folder per asset; scenes and props are flat files. Both shapes
    // exist because the pipeline created them at different times, and both must keep working.
    const folders = entries.filter((entry) => entry.isDirectory() && isAssetFolder(entry.name));
    const looseFiles = entries.filter((entry) => entry.isFile() && isAssetFile(entry.name, kind));

    // Character folders are grouped by the name that remains after the qualifier is
    // stripped, the same way loose files are. `林晚（家居服）` and `林晚（礼服）` are one
    // character with two costumes, and treating them as two assets is what made the old
    // base-name comparison erase the distinction in the other direction: it collapsed them
    // into one interchangeable thing. Neither is right - they are two VARIANTS of one asset.
    const folderGroups = new Map();
    for (const folder of folders) {
      const parsed = parseAssetFolder(folder.name);
      const group = folderGroups.get(parsed.name) ?? { name: parsed.name, folders: [] };
      group.folders.push({ dir: folder.name, qualifier: parsed.qualifier, hasDirectFiles: false });
      folderGroups.set(parsed.name, group);
    }

    for (const [assetName, group] of folderGroups.entries()) {
      const files = [];
      const variantNames = new Set();
      const subfolders = [];
      for (const entry of group.folders) {
        const folderPath = join(kindPath, entry.dir);
        // A character folder may itself contain variant subfolders (家居服/, 礼服/), which is
        // how a designer separates costumes. Both levels are read, and the deeper one wins.
        const inner = await readdir(folderPath, { withFileTypes: true });
        const variantDirs = inner.filter((child) => child.isDirectory() && isAssetFolder(child.name));
        const directFiles = inner.filter((child) => child.isFile() && isAssetFile(child.name, kind));

        if (directFiles.length > 0) {
          entry.hasDirectFiles = true;
          variantNames.add(entry.qualifier ?? 'default');
          for (const file of directFiles) {
            const parsedFile = parseAssetFileStem(file.name, { folderQualifier: entry.qualifier });
            if (parsedFile.variantName !== null) variantNames.add(parsedFile.variantName);
            files.push({
              ...(await describeFile(join(folderPath, file.name), `${kindDir.name}/${entry.dir}/${file.name}`, entry.qualifier)),
              variantName: parsedFile.variantName ?? entry.qualifier ?? 'default',
            });
          }
        }
        for (const variantDir of variantDirs) {
          const variantPath = join(folderPath, variantDir.name);
          const variantFiles = (await readdir(variantPath, { withFileTypes: true })).filter((child) => child.isFile() && isAssetFile(child.name, kind));
          if (variantFiles.length === 0) continue;
          variantNames.add(variantDir.name);
          for (const file of variantFiles) {
            files.push({
              ...(await describeFile(join(variantPath, file.name), `${kindDir.name}/${entry.dir}/${variantDir.name}/${file.name}`, variantDir.name)),
              variantName: variantDir.name,
            });
          }
        }
        subfolders.push(entry.dir);
      }

      if (group.folders.length > 1) {
        problems.push({
          kind: 'mixed-qualifiers',
          detail: `${kindDir.name}/${assetName} appears under ${group.folders.length} names (${group.folders.map((f) => f.dir).join(', ')}); each spelling is kept as its own variant of one asset`,
        });
      }
      const variants = [...variantNames];
      // A qualifier is only the asset's own when there is exactly one spelling of it.
      const soleQualifier = variants.length === 1 && variants[0] !== 'default' ? variants[0] : null;
      // Which folder spelling is the asset's IDENTITY rather than one of its variants: the
      // folder whose name IS the asset name, i.e. `林晚` itself. `林晚（女主）` and
      // `林晚（家居服）` are one character with a costume - the first names who she is, the
      // second what she is wearing - and telling them apart is what lets `@林晚` mean the
      // character without having to say which costume, and without making every mention of a
      // character who owns two costumes ambiguous.
      //
      // The bare name does not always exist: the designer may have written `林晚（女主）` and
      // nothing else, in which case there is no identity folder and the first variant is the
      // best available reading.
      // A bare folder can be only a container for variant subfolders. It is not the identity
      // when another sibling folder has the actual base files (`谢妄/墨化/…` beside
      // `谢妄（男主）/谢妄.png`). Prefer a folder that directly contains asset files.
      const bareFolder = group.folders.find((entry) => entry.qualifier === null);
      const directBareFolder = group.folders.find((entry) => entry.qualifier === null && entry.hasDirectFiles);
      const directFolder = group.folders.find((entry) => entry.hasDirectFiles);
      const identityVariant = directBareFolder !== undefined
        ? (variants.includes('default') ? 'default' : variants[0])
        : (directFolder?.qualifier ?? soleQualifier ?? variants[0] ?? null);
      const identityFolderEntry = directBareFolder
        ?? directFolder
        ?? bareFolder
        ?? group.folders.find((entry) => entry.qualifier === identityVariant)
        ?? group.folders[0]
        ?? null;
      const identityFile = files.find((file) => (file.variantName ?? file.qualifier ?? 'default') === identityVariant);
      const identityFolder = identityFile === undefined
        ? (identityFolderEntry === null ? null : `${kindDir.name}/${identityFolderEntry.dir}`)
        : dirname(identityFile.relativePath).replace(/^资产\//u, '');
      assets.push({
        kind,
        folder: `${kindDir.name}/${subfolders.join(` + ${kindDir.name}/`)}`,
        identityFolder,
        assetName,
        qualifier: soleQualifier,
        identityVariant,
        files,
      });
    }

    // Loose files, grouped by the asset name that remains after the generator suffix is
    // stripped. `深夜公寓玄关.png` and `深夜公寓玄关_00001_.png` land in one group, and the
    // generator's number becomes the version - which is what it actually is.
    //
    // A qualified loose file is folded into the unqualified asset of the same name:
    // `深夜公寓玄关（新规范）_00001_.png` is the same scene rendered under a new spec, not a
    // second scene, and treating it as one would leave the episode bound to whichever
    // spelling happened to be typed. When only the qualified spelling exists it stands alone.
    const groups = new Map();
    const collect = (entry) => {
      const group = groups.get(entry.base) ?? { base: entry.base, variants: new Map(), files: [] };
      const variantName = entry.qualifier ?? 'default';
      group.variants.set(variantName, true);
      group.files.push({ ...entry, variantName });
      groups.set(entry.base, group);
    };

    const parsedLoose = [];
    for (const file of looseFiles) {
      const parsed = parseAssetFileStem(file.name);
      parsedLoose.push({ file, base: parsed.base, qualifier: parsed.variantName, copy: parsed.copy });
    }
    const bareNames = new Set(parsedLoose.filter((entry) => entry.qualifier === null).map((entry) => entry.base));
    for (const entry of parsedLoose) {
      // Fold a qualified file into its bare sibling when one exists.
      const base = entry.qualifier !== null && bareNames.has(entry.base) ? entry.base : entry.base;
      collect({ ...entry, base });
    }

    for (const [name, group] of groups.entries()) {
      const variantNames = [...group.variants.keys()];
      if (variantNames.length > 1) {
        problems.push({
          kind: 'mixed-qualifiers',
          detail: `${kindDir.name}/${name} mixes ${variantNames.length} spellings (${variantNames.join(', ')}); each is kept as its own variant of one asset`,
        });
      }
      const files = [];
      for (const entry of group.files) {
        files.push({
          ...(await describeFile(join(kindPath, entry.file.name), `${kindDir.name}/${entry.file.name}`, entry.qualifier)),
          copy: entry.copy,
          qualifier: entry.qualifier,
          variantName: entry.variantName,
        });
      }
      assets.push({
        kind,
        folder: kindDir.name,
        identityFolder: null,
        assetName: name,
        qualifier: variantNames.length === 1 && variantNames[0] !== 'default' ? variantNames[0] : null,
        // A loose scene writes its variants in the FILE names, so no folder equals the asset
        // name. The unqualified spelling is the identity one, and when every file is
        // qualified there is no identity reading at all - which is honest, and makes the
        // mention resolver ask rather than guess.
        identityVariant: variantNames.includes('default') ? 'default' : null,
        files,
      });
    }
  }

  await attachEpisodeCopies(root, assets, problems);
  return { assets, problems };
}

/** One file's metadata, without deciding anything about identity. */
async function describeFile(path, relativePath, qualifier) {
  const info = await stat(path);
  return {
    name: basename(path),
    relativePath: `资产/${relativePath}`,
    bytes: info.size,
    sha256: await hashFile(path),
    role: roleOf(path),
    qualifier: qualifier ?? null,
  };
}

/**
 * Inventory copies that exist only in an episode's `本集所需资产/`.
 *
 * The global asset tree is where new references are produced, but an episode copy is also a
 * real local file and can be the only surviving copy of an earlier scene. Those files were
 * invisible to the library, which made "the file is in this project" and "the asset page has
 * it" disagree. Attach them to the matching asset as historical versions; identical bytes are
 * already represented and are left alone.
 */
async function attachEpisodeCopies(root, assets, problems) {
  const episodesRoot = join(root, '剧集');
  let episodes = [];
  try {
    episodes = await readdir(episodesRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const byBase = new Map();
  for (const asset of assets) {
    const group = byBase.get(asset.assetName) ?? [];
    group.push(asset);
    byBase.set(asset.assetName, group);
  }
  const episodeCopiesByHash = new Map();

  for (const episode of episodes.filter((entry) => entry.isDirectory())) {
    const number = Number((/第\s*(\d+)\s*集/u.exec(episode.name) ?? [])[1]);
    if (!Number.isInteger(number) || number < 1) continue;
    const episodePath = join(episodesRoot, episode.name);
    const copyRoot = join(episodePath, '本集所需资产');
    let files = [];
    try {
      files = await readdir(copyRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const datasetKinds = await episodeDatasetKinds(episodePath);

    for (const file of files.filter((entry) => entry.isFile() && isAssetFile(entry.name))) {
      const parsed = parseAssetFileStem(file.name);
      const base = parsed.base;
      let candidates = byBase.get(base) ?? [];
      const kinds = datasetKinds.get(base);
      if (kinds !== undefined && kinds.size > 0) {
        const inDatasetKinds = candidates.filter((asset) => kinds.has(asset.kind));
        if (inDatasetKinds.length > 0) candidates = inDatasetKinds;
        else if (candidates.length === 0 && kinds.size === 1) {
          const [kind] = kinds;
          const created = {
            kind,
            folder: null,
            identityFolder: null,
            assetName: base,
            qualifier: null,
            identityVariant: 'default',
            files: [],
          };
          assets.push(created);
          byBase.set(base, [created]);
          candidates = [created];
        }
      }

      if (candidates.length === 0) {
        problems.push({
          kind: 'episode-copy-unmatched',
          detail: `剧集/${episode.name}/本集所需资产/${file.name} has no matching global asset`,
        });
        continue;
      }
      if (candidates.length > 1) {
        problems.push({
          kind: 'episode-copy-ambiguous',
          detail: `剧集/${episode.name}/本集所需资产/${file.name} matches ${candidates.map((asset) => asset.kind).join(', ')}`,
        });
        continue;
      }

      const target = candidates[0];
      if (!isAssetFile(file.name, target.kind)) continue;
      const path = join(copyRoot, file.name);
      const relativePath = `剧集/${episode.name}/本集所需资产/${file.name}`;
      const info = await stat(path);
      const sha256 = await hashFile(path);
      const variantName = parsed.variantName ?? target.identityVariant ?? 'default';
      const key = `${target.kind}\0${target.assetName}\0${variantName}\0${sha256}`;
      const existing = episodeCopiesByHash.get(key);
      if (existing !== undefined) {
        existing.episodeNumbers = [...new Set([...existing.episodeNumbers, number])].sort((left, right) => left - right);
        existing.paths = [...new Set([...existing.paths, relativePath])];
        continue;
      }
      const alreadyInVariant = (target.files ?? []).some((known) => known.sha256 === sha256
        && (known.variantName ?? target.identityVariant ?? 'default') === variantName);
      if (alreadyInVariant) continue;

      const copy = {
        name: file.name,
        relativePath,
        paths: [relativePath],
        bytes: info.size,
        sha256,
        role: roleOf(path),
        copy: parsed.copy,
        qualifier: parsed.variantName ?? target.identityVariant ?? null,
        variantName,
        source: 'episode-copy',
        historical: true,
        episodeNumbers: [number],
      };
      target.files.push(copy);
      episodeCopiesByHash.set(key, copy);
    }
  }
}

/** Asset kinds named by one episode's dataset, keyed by the base asset name. */
async function episodeDatasetKinds(episodePath) {
  let dataset = null;
  try {
    dataset = JSON.parse(await readFile(join(episodePath, 'dataset.json'), 'utf8'));
  } catch {
    return new Map();
  }
  const kinds = new Map();
  for (const [bucket, kind] of [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']]) {
    for (const value of Array.isArray(dataset?.[bucket]) ? dataset[bucket] : []) {
      const name = String(value).trim();
      if (name.length === 0) continue;
      const fileName = IMAGE_EXT.has(extname(name).toLowerCase()) ? name : `${name}.png`;
      const base = parseAssetFileStem(fileName).base;
      const set = kinds.get(base) ?? new Set();
      set.add(kind);
      kinds.set(base, set);
    }
  }
  return kinds;
}

/**
 * Turn a scan into the stored model.
 *
 * @param scan - the result of {@link scanAssets}.
 * @param previous - the stored `assets` array, so ids are reused rather than re-minted.
 * @param inventory - metadata-only assets parsed from 资产盘点稿. They fill names,
 *   descriptions and costume variants before the first picture exists.
 * @returns `{ assets, problems, stats }`.
 */
export function buildAssetModel(scan, previous = [], inventory = { assets: [] }) {
  const byKey = new Map();
  // The stored model uses `name`; the scan uses `assetName` for the same thing. Looking up
  // the stored shape with the scan's field name silently found nothing, so every scan minted
  // fresh ids and no binding could survive a re-scan. Accept both spellings.
  const previousPreference = (asset) => (assetHasPresentFile(asset) ? 1000 : 0)
    + (asset.manual === true ? 100 : 0)
    + (String(asset.description ?? '').trim().length > 0 ? 10 : 0)
    + (asset.inventory === true ? 1 : 0);
  for (const asset of previous) {
    const key = assetKey(asset.kind, asset.name ?? asset.assetName);
    const existing = byKey.get(key);
    // Legacy indexes can contain `1. 木牌` and the real file-backed `木牌`. `assetKey` now
    // canonicalizes the ordinal, so keep the useful identity rather than whichever happened
    // to be last in the old array.
    if (existing === undefined || previousPreference(asset) > previousPreference(existing)) {
      byKey.set(key, asset);
    }
  }
  const inventoryByKey = new Map((inventory.assets ?? []).map((asset) => [assetKey(asset.kind, asset.name), asset]));
  const consumed = new Set();

  const problems = [...scan.problems];
  const stats = {
    assets: 0,
    variants: 0,
    files: 0,
    newVersions: 0,
    duplicateContent: 0,
    superseded: 0,
    recoveredFiles: 0,
    reassignedFiles: 0,
    historicalFiles: 0,
  };
  const assets = [];
  const uniqueNumbers = (values) => [...new Set((values ?? []).filter((value) => Number.isInteger(value)))].sort((left, right) => left - right);
  const sortedVariantNames = (names, identity = 'default') => [...names].sort((left, right) => {
    if (left === identity) return -1;
    if (right === identity) return 1;
    return left.localeCompare(right);
  });

  /**
   * A loose prop may legitimately have a parenthesised name.
   *
   * The inventory says the asset is `手机（林妙）`; the scanner would otherwise read
   * `手机（林妙）.png` as the `林妙` variant of an asset called `手机`. When the full spelling
   * exists in the inventory and the base spelling does not, the inventory name is the asset and
   * the file belongs to its default variant. This keeps the panel from showing a second,
   * picture-less `手机（林妙）` asset and making every mention unresolved.
   */
  const scannedAssets = scan.assets.map((scanned) => {
    if (scanned.qualifier === null || scanned.qualifier === undefined) return scanned;
    const fullName = `${scanned.assetName}（${scanned.qualifier}）`;
    const exactInventory = inventoryByKey.get(assetKey(scanned.kind, fullName));
    const baseInventory = inventoryByKey.get(assetKey(scanned.kind, scanned.assetName));
    if (exactInventory === undefined || baseInventory !== undefined) return scanned;
    return {
      ...scanned,
      assetName: fullName,
      qualifier: null,
      identityVariant: 'default',
      files: scanned.files.map((file) => ({ ...file, variantName: 'default', qualifier: null })),
    };
  });

  for (const scanned of scannedAssets) {
    const key = assetKey(scanned.kind, scanned.assetName);
    const before = byKey.get(key);
    const inventoryAsset = inventoryByKey.get(key);
    const assetId = before?.assetId ?? newAssetId(scanned.kind);

    // Variants come from the files themselves. Reading only `file.qualifier` missed the
    // important half: a loose scene file records its variant in `variantName` (`default` when
    // it has no qualifier), so the default variant of a mixed set was never created and its
    // files were dropped from the model entirely.
    const identityVariant = canonicalVariantName(scanned.identityVariant ?? 'default');
    const canonicalForAsset = (value) => canonicalVariantName(value, { identityVariant });
    const variantNames = new Set();

    /**
     * Merge stored variant shells before rebuilding files.
     *
     * Earlier scans created `魔化`, `魔化·（四视图）` and `魔化·（四视图）3x` as three variants.
     * Once their names are canonicalized they must also share files, descriptions and the
     * selected version; otherwise the old cards survive even though the scan is correct.
     */
    const beforeVariants = new Map();
    const selectedQuality = (variant) => {
      const file = (variant.files ?? []).find((entry) => entry.assetVersionId === variant.selectedVersionId);
      if (file === undefined) return 0;
      if (file.role === 'quadview') return /(?:3x|3\s*倍|超分)/iu.test(String(file.fileName ?? '')) ? 4 : 3;
      if (file.role === 'front') return 2;
      if (file.role === 'primary') return 1;
      return 0;
    };
    for (const variant of before?.variants ?? []) {
      const rawName = cleanAssetLabel(variant.name);
      if (rawName.length === 0 || INTERNAL_ASSET_DIRECTORY.test(rawName)) continue;
      const name = canonicalForAsset(rawName);
      const previous = beforeVariants.get(name);
      const files = [...(variant.files ?? [])];
      if (previous === undefined) {
        beforeVariants.set(name, {
          ...variant,
          name,
          files,
          episodeNumbers: [...new Set(variant.episodeNumbers ?? [])],
          _exactName: rawName === name,
        });
        continue;
      }
      const knownIds = new Set(previous.files.map((file) => file.assetVersionId));
      previous.files.push(...files.filter((file) => !knownIds.has(file.assetVersionId)));
      previous.episodeNumbers = [...new Set([...(previous.episodeNumbers ?? []), ...(variant.episodeNumbers ?? [])])];
      if (!previous.description && variant.description) previous.description = variant.description;
      if (rawName === name && previous._exactName !== true) {
        previous.variantId = variant.variantId;
        previous._exactName = true;
      }
      if (selectedQuality(variant) > selectedQuality(previous)) {
        previous.selectedVersionId = variant.selectedVersionId ?? null;
        previous.selectionRole = variant.selectionRole ?? null;
        previous.selectedAt = variant.selectedAt ?? null;
        previous.selectionNote = variant.selectionNote ?? null;
      }
    }
    for (const [name, variant] of beforeVariants) {
      if ((before?.manual === true || (variant.files ?? []).length > 0) && !INTERNAL_ASSET_DIRECTORY.test(name)) {
        variantNames.add(name);
      }
    }
    if (scanned.qualifier !== null && scanned.qualifier !== undefined) {
      variantNames.add(canonicalForAsset(scanned.qualifier));
    }
    for (const file of scanned.files) {
      const own = file.variantName ?? file.qualifier ?? scanned.qualifier ?? identityVariant;
      variantNames.add(canonicalForAsset(own));
    }
    for (const variant of inventoryAsset?.variants ?? []) {
      variantNames.add(canonicalForAsset(variant.name));
    }
    if (variantNames.size === 0) variantNames.add(identityVariant);

    const inventoryVariants = new Map();
    for (const variant of inventoryAsset?.variants ?? []) {
      const name = canonicalForAsset(variant.name);
      const previous = inventoryVariants.get(name);
      if (previous === undefined) inventoryVariants.set(name, { ...variant, name });
      else {
        inventoryVariants.set(name, {
          ...previous,
          ...variant,
          name,
          description: previous.description ?? variant.description,
          episodeNumbers: [...new Set([...(previous.episodeNumbers ?? []), ...(variant.episodeNumbers ?? [])])],
        });
      }
    }
    const defaultVariantDescription = inventoryAsset?.defaultDescription ?? before?.defaultDescription ?? null;
    const variants = [];

    /**
     * A file can move between variants without changing its bytes: an early scanner put
     * `周砚（戏服）.png` under the folder qualifier `男主`, then a later scanner correctly
     * assigned it to `戏服`. The old identity variant kept a second copy of the same path
     * and hash, marked missing forever, while the real variant held another id for the same
     * file. Re-scanning could not repair it because each variant was reconciled in isolation.
     *
     * Build the counterpart once for the whole asset. Exact path+hash wins so a genuine
     * regeneration at the same path still creates a new version; a missing record with the
     * same hash is the recovery path for a file that moved.
     */
    const previousFiles = (before?.variants ?? []).flatMap((variant) => variant.files ?? []);
    const previousByPathAndHash = new Map();
    const previousMissingByHash = new Map();
    for (const file of previousFiles) {
      for (const path of [file.relativePath, ...(file.paths ?? [])].filter(Boolean)) {
        const key = `${String(path).replace(/\\/gu, '/')}\0${file.sha256}`;
        const existing = previousByPathAndHash.get(key);
        if (existing === undefined || (existing.missing === true && file.missing !== true)) {
          previousByPathAndHash.set(key, file);
        }
      }
      if (file.missing === true && !previousMissingByHash.has(file.sha256)) {
        previousMissingByHash.set(file.sha256, file);
      }
    }

    const counterpartByPath = new Map();
    const usedMovedCounterparts = new Set();
    for (const file of scanned.files) {
      const path = String(file.relativePath).replace(/\\/gu, '/');
      const exact = previousByPathAndHash.get(`${path}\0${file.sha256}`);
      if (exact !== undefined) {
        counterpartByPath.set(path, exact);
        continue;
      }
      const moved = previousMissingByHash.get(file.sha256);
      if (moved !== undefined && !usedMovedCounterparts.has(moved.assetVersionId)) {
        counterpartByPath.set(path, moved);
        usedMovedCounterparts.add(moved.assetVersionId);
      }
    }
    const activeVersionIds = new Set([...counterpartByPath.values()].map((file) => file.assetVersionId));
    const scannedByPath = new Map(scanned.files.map((file) => [
      String(file.relativePath).replace(/\\/gu, '/'),
      file,
    ]));
    const reassignedVersionIds = new Set(previousFiles
      .filter((file) => [file.relativePath, ...(file.paths ?? [])]
        .filter(Boolean)
        .some((path) => scannedByPath.get(String(path).replace(/\\/gu, '/'))?.sha256 === file.sha256))
      .map((file) => file.assetVersionId));
    const claimedVersionIds = new Set();

    for (const variantName of sortedVariantNames(variantNames, identityVariant)) {
      const beforeVariant = beforeVariants.get(variantName);
      const inventoryVariant = inventoryVariants.get(variantName);
      const variantId = beforeVariant?.variantId ?? newVariantId();
      // A file belongs to the variant it names, or to the asset's own qualifier, or to the
      // default one. Characters carry the qualifier on the folder, loose scene files on the
      // file name, so both spellings have to be honoured here.
      const inVariant = scanned.files.filter((file) => {
        const own = file.variantName ?? file.qualifier ?? scanned.qualifier;
        if (own !== null && own !== undefined) return canonicalForAsset(own) === variantName;
        const assetLevel = scanned.qualifier;
        if (assetLevel !== null) return canonicalForAsset(assetLevel) === variantName;
        return variantName === identityVariant;
      });
      const files = buildVersions(inVariant, beforeVariant?.files ?? [], problems, stats, {
        counterpartByPath,
        activeVersionIds,
        reassignedVersionIds,
        claimedVersionIds,
      });
      const previousSelectionId = beforeVariant?.selectedVersionId ?? null;
      const previousWasQuadviewDefault = beforeVariant?.selectionNote === '默认使用四视图';
      const selectionMoved = previousSelectionId !== null
        && reassignedVersionIds.has(previousSelectionId)
        && !files.some((file) => file.assetVersionId === previousSelectionId);
      const preservedSelection = !selectionMoved
        && !previousWasQuadviewDefault
        && previousSelectionId !== null
        && files.some((file) => file.assetVersionId === previousSelectionId && file.missing !== true);
      // A fresh character with a four-view should use that sheet by default. Without this the
      // "current input" fell back to whichever role happened to have the highest version number,
      // often the portrait, even though every H3 reference prefers the four-view.
      const defaultQuadview = files
        .filter((file) => file.role === 'quadview' && file.missing !== true)
        .reduce((best, file) => {
          if (best === undefined) return file;
          const quality = (entry) => (/(?:3x|3\s*倍|超分)/iu.test(String(entry.fileName ?? '')) ? 2 : 1);
          const qualityDelta = quality(file) - quality(best);
          return qualityDelta > 0 || (qualityDelta === 0 && (file.version ?? 0) > (best.version ?? 0))
            ? file
            : best;
        }, undefined);
      const selectedVersionId = preservedSelection
        ? previousSelectionId
        : (defaultQuadview?.assetVersionId ?? null);
      const selectedByDefault = !preservedSelection && defaultQuadview !== undefined;
      // The selection travels with the variant across a re-scan. Without this, every scan
      // rebuilds the variant record and the choice is lost - so a regeneration plus any refresh
      // would silently move the binding back to the newest file, which is exactly the defect
      // the selection exists to prevent.
      variants.push({
        variantId,
        name: variantName,
        description: inventoryVariant?.description
          ?? ((variantName === 'default' || variantName === scanned.identityVariant) ? defaultVariantDescription : null)
          ?? beforeVariant?.description
          ?? null,
        episodeNumbers: uniqueNumbers([...(beforeVariant?.episodeNumbers ?? []), ...(inventoryVariant?.episodeNumbers ?? [])]),
        files,
        selectedVersionId,
        selectionRole: selectedByDefault ? 'generation' : (preservedSelection ? beforeVariant?.selectionRole ?? null : null),
        selectedAt: selectedByDefault ? null : (preservedSelection ? beforeVariant?.selectedAt ?? null : null),
        selectionNote: selectedByDefault ? '默认使用四视图' : (preservedSelection ? beforeVariant?.selectionNote ?? null : null),
      });
    }

    assets.push({
      assetId,
      kind: scanned.kind,
      name: scanned.assetName,
      // Aliases are how a script's 角色名 and the folder's 资产名 are reconciled later.
      aliases: before?.aliases ?? [],
      description: inventoryAsset?.description ?? before?.description ?? null,
      defaultDescription: defaultVariantDescription,
      episodeNumbers: uniqueNumbers([...(before?.episodeNumbers ?? []), ...(inventoryAsset?.episodeNumbers ?? [])]),
      folder: scanned.folder,
      identityFolder: scanned.identityFolder ?? before?.identityFolder ?? null,
      qualifier: scanned.qualifier,
      // Which variant is the asset's identity rather than one of its variants. Carried
      // through from the scan: dropping it here made every character with two costumes
      // ambiguous to reference, which is how this was found.
      identityVariant: scanned.identityVariant ?? null,
      variants,
      planned: !variants.some((variant) => (variant.files ?? []).some((file) => file.missing !== true)),
      status: before?.status ?? 'unconfirmed',
      source: inventoryAsset !== undefined ? 'mixed' : (before?.manual === true ? 'manual' : 'files'),
      manual: before?.manual === true,
      inventory: inventoryAsset !== undefined || before?.inventory === true,
    });
    consumed.add(key);
  }

  const inventoryCandidates = (inventoryAsset) => {
    const exact = cleanAssetLabel(inventoryAsset.name);
    const parsed = parseAssetFolder(exact);
    const concatenated = parsed.qualifier === null
      ? null
      : cleanAssetLabel(`${parsed.name}${parsed.qualifier.replace(/[·・\s]+/gu, '')}`);
    return [...new Set([exact, concatenated, parsed.name].filter((name) => typeof name === 'string' && name.length > 0))];
  };

  // Inventory entries that have no file on disk yet. They are real assets for the panel:
  // a character without a picture still has a name, an introduction and costume variants.
  for (const inventoryAsset of inventory.assets ?? []) {
    const key = assetKey(inventoryAsset.kind, inventoryAsset.name);
    if (consumed.has(key)) continue;
    /**
     * A legacy inventory can spell one disk asset three ways:
     * `手机（林妙）`, `手机林妙`, or `手机`. The scanner already has a rule for all three.
     * Before creating another picture-less card, merge metadata into the matching real asset
     * and retain the old spellings as aliases. This is the root fix for an empty duplicate
     * sitting beside a file-backed asset.
     */
    const matchingExisting = inventoryCandidates(inventoryAsset)
      .map((name) => assets.find((asset) => assetKey(asset.kind, asset.name) === assetKey(inventoryAsset.kind, name)))
      .find(Boolean);
    if (matchingExisting !== undefined) {
      const spelling = cleanAssetLabel(inventoryAsset.name);
      const parsed = parseAssetFolder(spelling);
      matchingExisting.aliases = [...new Set([
        ...(matchingExisting.aliases ?? []),
        spelling,
        ...inventoryCandidates(inventoryAsset).filter((name) =>
          name !== matchingExisting.name
          && !assets.some((asset) => asset !== matchingExisting && assetKey(asset.kind, asset.name) === assetKey(inventoryAsset.kind, name))),
      ])];
      if (!matchingExisting.description && inventoryAsset.description) matchingExisting.description = inventoryAsset.description;
      matchingExisting.episodeNumbers = uniqueNumbers([
        ...(matchingExisting.episodeNumbers ?? []),
        ...(inventoryAsset.episodeNumbers ?? []),
      ]);
      const ensureVariant = (variantName, source) => {
        const cleanName = cleanAssetLabel(variantName);
        if (cleanName.length === 0) return;
        let variant = matchingExisting.variants.find((entry) => entry.name === cleanName);
        if (variant === undefined) {
          variant = {
            variantId: newVariantId(),
            name: cleanName,
            description: source?.description ?? null,
            episodeNumbers: uniqueNumbers(source?.episodeNumbers ?? []),
            files: [],
            selectedVersionId: null,
            selectionRole: null,
            selectedAt: null,
            selectionNote: null,
          };
          matchingExisting.variants.push(variant);
        } else {
          if (!variant.description && source?.description) variant.description = source.description;
          variant.episodeNumbers = uniqueNumbers([...(variant.episodeNumbers ?? []), ...(source?.episodeNumbers ?? [])]);
        }
      };
      for (const variant of inventoryAsset.variants ?? []) ensureVariant(variant.name, variant);
      if (inventoryAsset.kind === 'character'
        && parsed.qualifier !== null
        && matchingExisting.name === parsed.name
        && !/群演|配角|群众|声音|虚影|不做资产|不单列/u.test(parsed.qualifier)) {
        ensureVariant(parsed.qualifier, {
          description: inventoryAsset.description ?? null,
          episodeNumbers: inventoryAsset.episodeNumbers ?? [],
        });
      }
      matchingExisting.variants.sort((left, right) =>
        (left.name === 'default' ? -1 : right.name === 'default' ? 1 : left.name.localeCompare(right.name)));
      matchingExisting.planned = !matchingExisting.variants.some((variant) =>
        (variant.files ?? []).some((file) => file.missing !== true));
      matchingExisting.inventory = true;
      matchingExisting.source = matchingExisting.manual === true ? 'manual' : 'mixed';
      consumed.add(key);
      consumed.add(assetKey(matchingExisting.kind, matchingExisting.name));
      continue;
    }
    const before = byKey.get(key);
    const assetId = before?.assetId ?? newAssetId(inventoryAsset.kind);
    const beforeVariants = new Map((before?.variants ?? []).map((variant) => [variant.name, variant]));
    const inventoryVariants = new Map((inventoryAsset.variants ?? []).map((variant) => [variant.name, variant]));
    const defaultVariantDescription = inventoryAsset.defaultDescription ?? before?.defaultDescription ?? null;
    const names = new Set(['default', ...beforeVariants.keys(), ...inventoryVariants.keys()]);
    const variants = sortedVariantNames(names).map((name) => {
      const previousVariant = beforeVariants.get(name);
      const inventoryVariant = inventoryVariants.get(name);
      return {
        variantId: previousVariant?.variantId ?? newVariantId(),
        name,
        description: inventoryVariant?.description
          ?? (name === 'default' ? defaultVariantDescription : null)
          ?? previousVariant?.description
          ?? null,
        episodeNumbers: uniqueNumbers([...(previousVariant?.episodeNumbers ?? []), ...(inventoryVariant?.episodeNumbers ?? [])]),
        files: previousVariant?.files ?? [],
        selectedVersionId: previousVariant?.selectedVersionId ?? null,
        selectionRole: previousVariant?.selectionRole ?? null,
        selectedAt: previousVariant?.selectedAt ?? null,
        selectionNote: previousVariant?.selectionNote ?? null,
      };
    });
    assets.push({
      assetId,
      kind: inventoryAsset.kind,
      name: inventoryAsset.name,
      aliases: before?.aliases ?? [],
      description: inventoryAsset.description || before?.description || null,
      defaultDescription: defaultVariantDescription,
      episodeNumbers: uniqueNumbers([...(before?.episodeNumbers ?? []), ...(inventoryAsset.episodeNumbers ?? [])]),
      folder: before?.folder ?? null,
      identityFolder: before?.identityFolder ?? null,
      qualifier: before?.qualifier ?? null,
      identityVariant: before?.identityVariant ?? 'default',
      variants,
      planned: !variants.some((variant) => (variant.files ?? []).some((file) => file.missing !== true)),
      status: before?.status ?? 'unconfirmed',
      source: 'inventory',
      manual: false,
      inventory: true,
    });
    consumed.add(key);
  }

  // User-created assets have no inventory entry and may have no file yet. A refresh must
  // not make a character the user just added disappear.
  for (const before of previous) {
    const key = assetKey(before.kind, before.name ?? before.assetName);
    if (consumed.has(key) || before.manual !== true) continue;
    assets.push({
      ...before,
      source: before.source ?? 'manual',
      manual: true,
      variants: before.variants ?? [],
      planned: !assetHasPresentFile(before),
      episodeNumbers: uniqueNumbers(before.episodeNumbers ?? []),
    });
    consumed.add(key);
  }

  stats.assets = assets.length;
  stats.variants = 0;
  stats.files = 0;
  for (const asset of assets) {
    stats.variants += asset.variants.length;
    for (const variant of asset.variants) {
      stats.files += variant.files.length;
      for (const file of variant.files) if (file.historical === true) stats.historicalFiles += 1;
    }
  }

  return { assets, problems, stats };
}

/**
 * Collapse legacy `3x` / `超分` VARIANT records into the asset's real variant.
 *
 * Older scans treated the upscale suffix as a variant, which produced a picture-less-looking
 * extra dropdown entry beside the base scene. Upscaling is a file quality, not content. The
 * files are moved into the identity/default variant so reference selection can still prefer
 * the high-resolution file by name.
 */
export function normalizeStoredAsset(asset) {
  const variants = asset?.variants ?? [];
  const qualityVariants = variants.filter((variant) => isFileScaleName(variant.name));
  if (qualityVariants.length === 0) return asset;
  const namedIdentity = variants.find((variant) => variant.name === asset.identityVariant
    && !isFileScaleName(variant.name));
  const base = namedIdentity
    ?? variants.find((variant) => variant.name === 'default')
    ?? qualityVariants[0];
  const targetName = isFileScaleName(base.name) ? 'default'
    : (base.name === 'default' ? 'default' : (asset.identityVariant ?? base.name));
  const target = {
    ...base,
    name: targetName,
    files: [...(base.files ?? [])],
  };
  const seen = new Set(target.files.flatMap((file) => [
    file.assetVersionId,
    file.relativePath,
  ].filter(Boolean)));
  for (const variant of qualityVariants) {
    for (const file of variant.files ?? []) {
      if (seen.has(file.assetVersionId) || seen.has(file.relativePath)) continue;
      target.files.push(file);
      if (file.assetVersionId) seen.add(file.assetVersionId);
      if (file.relativePath) seen.add(file.relativePath);
    }
    if (target.selectedVersionId === null || target.selectedVersionId === undefined) {
      target.selectedVersionId = variant.selectedVersionId ?? target.selectedVersionId ?? null;
      target.selectionRole = variant.selectionRole ?? target.selectionRole ?? null;
      target.selectedAt = variant.selectedAt ?? target.selectedAt ?? null;
      target.selectionNote = variant.selectionNote ?? target.selectionNote ?? null;
    }
  }
  return {
    ...asset,
    identityVariant: isFileScaleName(asset.identityVariant) || asset.identityVariant === null || asset.identityVariant === undefined
      ? targetName
      : asset.identityVariant,
    variants: [
      target,
      ...variants.filter((variant) => variant !== base && !qualityVariants.includes(variant)),
    ],
  };
}

/** Whether an asset has at least one present file in any variant. */
export function assetHasPresentFile(asset) {
  return (asset?.variants ?? []).some((variant) => (variant.files ?? []).some((file) => file.missing !== true));
}

/** Names produced by inventory templates rather than by a production. */
export function isTemplateAssetName(value) {
  const name = String(value ?? '').trim();
  return name.length === 0
    || /^[-—_=·.]+$/u.test(name)
    || /^(?:资产名|变体资产名|角色资产名|场景资产名|道具资产名)$/u.test(name)
    || /仅供.*(?:不进入|后期配音)/u.test(name);
}

/**
 * Match scanned files against the recorded versions of one variant.
 *
 * Three identities are in play and they are not the same thing:
 *
 *   - **Content** (`sha256`) decides whether two files are the same bytes. Identical bytes at
 *     two paths are one content-library entry with two paths, not two versions.
 *   - **Role** decides what a file IS. A quadview is a reference sheet; the hero image is a
 *     different deliverable of the same character. They number independently, because
 *     `林晚四视图.png` is not "the second version of 林晚.png" - it is a different sheet.
 *   - **Generation order** decides which version is newer WITHIN a role. ComfyUI's `_00001_`
 *     suffix is the only signal available at scan time; the recorded history orders versions
 *     across scans.
 *
 * Numbering everything in one running counter was wrong twice over: two never-seen files both
 * became version 1, and a quadview inflated the hero image's version. Pure and synchronous -
 * it reconciles two lists the caller already read.
 */
function buildVersions(scannedFiles, previousFiles, problems, stats, {
  counterpartByPath = new Map(),
  activeVersionIds = new Set(),
  reassignedVersionIds = new Set(),
  claimedVersionIds = new Set(),
} = {}) {
  const byHash = new Map(previousFiles.map((file) => [file.sha256, file]));
  const byPath = new Map(previousFiles.map((file) => [file.relativePath, file]));
  const out = [];
  const outByHash = new Map();

  // Roles are independent sequences.
  const roles = new Set([...scannedFiles.map((file) => file.role), ...previousFiles.map((file) => file.role)]);
  for (const role of roles) {
    const inRole = scannedFiles.filter((file) => file.role === role);
    const previousInRole = previousFiles.filter((file) => file.role === role);
    allVersionsForRole(inRole, previousInRole, byHash, byPath, role, out, outByHash, problems, stats, {
      counterpartByPath,
      claimedVersionIds,
    });
  }

  // A recorded version whose file is gone is reported, not dropped: a shot may be bound to
  // it, and "the file moved" is something the user can fix.
  for (const before of previousFiles) {
    if (out.some((file) => file.assetVersionId === before.assetVersionId)) continue;
    if (outByHash.has(before.sha256)) continue;
    if (scannedFiles.some((file) => file.sha256 === before.sha256)) continue;
    // The same record now belongs to another variant. Keeping it here as missing is the
    // "local file exists but this card says it does not" bug: the file was reassigned, not
    // deleted. Only an old record whose path still exists with different bytes is a true
    // superseded version and stays in this variant as missing.
    if (reassignedVersionIds.has(before.assetVersionId) || activeVersionIds.has(before.assetVersionId)) {
      stats.reassignedFiles += 1;
      continue;
    }
    const currentAtPath = scannedFiles.find((file) => file.relativePath === before.relativePath);
    if (currentAtPath !== undefined && currentAtPath.sha256 !== before.sha256) {
      // A real regeneration at the same path. It remains below as a missing historical
      // version so an existing binding can still be reported honestly.
    }
    problems.push({ kind: 'missing-file', detail: `${before.relativePath} is recorded but is no longer on disk` });
    out.push({ ...before, missing: true });
  }

  return out.sort((a, b) => (a.role === b.role ? (a.version ?? 0) - (b.version ?? 0) : String(a.role).localeCompare(String(b.role))));
}

/** One role's version sequence: content dedupe, then generation order, then history. */
function allVersionsForRole(inRole, previousInRole, byHash, byPath, role, out, outByHash, problems, stats, {
  counterpartByPath,
  claimedVersionIds,
}) {
  const highest = previousInRole.reduce((max, file) => Math.max(max, file.version ?? 0), 0);
  let nextVersion = highest;

  // Generation order: explicit `_000NN_` first, then everything else by name, so an
  // un-suffixed original sorts before its later saves.
  const ordered = [...inRole].sort((a, b) => {
    const left = a.copy ?? -1;
    const right = b.copy ?? -1;
    if (left !== right) return left - right;
    return String(a.name).localeCompare(String(b.name));
  });

  for (const scanned of ordered) {
    const path = String(scanned.relativePath).replace(/\\/gu, '/');
    const counterpart = counterpartByPath.get(path);
    let known = counterpart?.sha256 === scanned.sha256
      ? counterpart
      : byHash.get(scanned.sha256);
    // One prior record can cover several historical paths. If it was already emitted in
    // another variant, registering it again would give two variants the same version id.
    // Keep the first assignment and create a distinct record for the second path.
    if (known !== undefined && claimedVersionIds.has(known.assetVersionId) && !outByHash.has(scanned.sha256)) {
      known = undefined;
    }
    if (known !== undefined) {
      const mergedPaths = [...new Set([
        ...(known.paths ?? []),
        ...(scanned.paths ?? []),
        known.relativePath,
        scanned.relativePath,
      ].filter(Boolean).map((entry) => String(entry).replace(/\\/gu, '/')))];
      const recovered = {
        ...known,
        // The canonical path must be one the scan just proved exists. Keeping a stale
        // historical path here made the record look present while media resolution looked
        // at a path that had moved.
        role,
        relativePath: scanned.relativePath,
        paths: mergedPaths,
        fileName: scanned.name,
        bytes: scanned.bytes,
        sha256: scanned.sha256,
        missing: false,
        source: scanned.source === 'episode-copy' ? 'episode-copy' : 'asset-tree',
        historical: scanned.source === 'episode-copy',
        episodeNumbers: [...new Set([
          ...(known.episodeNumbers ?? []),
          ...(scanned.episodeNumbers ?? []),
        ].filter((value) => Number.isInteger(value)))].sort((left, right) => left - right),
      };
      if (outByHash.has(scanned.sha256)) {
        stats.duplicateContent += 1;
        const existing = outByHash.get(scanned.sha256);
        existing.paths = [...new Set([...(existing.paths ?? []), ...mergedPaths])];
        existing.episodeNumbers = [...new Set([
          ...(existing.episodeNumbers ?? []),
          ...(scanned.episodeNumbers ?? []),
        ].filter((value) => Number.isInteger(value)))].sort((left, right) => left - right);
        continue;
      }
      if (known.missing === true) stats.recoveredFiles += 1;
      claimedVersionIds.add(recovered.assetVersionId);
      byHash.set(scanned.sha256, recovered);
      byPath.set(scanned.relativePath, recovered);
      outByHash.set(scanned.sha256, recovered);
      out.push(recovered);
      continue;
    }

    const atPath = byPath.get(scanned.relativePath);
    nextVersion += 1;
    if (atPath !== undefined) {
      // Same path, different bytes: a regeneration. The previous version is kept and marked,
      // so a shot bound to it still resolves - a binding is never silently moved forward.
      stats.superseded += 1;
      problems.push({
        kind: 'content-changed',
        detail: `${scanned.relativePath} changed on disk; recorded as version ${nextVersion} and the previous one is kept`,
      });
    } else {
      stats.newVersions += 1;
    }

    const file = {
      assetVersionId: newVersionId(),
      role,
      version: nextVersion,
      relativePath: scanned.relativePath,
      paths: [...new Set([...(scanned.paths ?? []), scanned.relativePath])],
      fileName: scanned.name,
      bytes: scanned.bytes,
      sha256: scanned.sha256,
      status: atPath?.status ?? 'candidate',
      derivedFromVersionId: atPath?.assetVersionId ?? null,
      registeredAt: new Date().toISOString(),
      source: scanned.source === 'episode-copy' ? 'episode-copy' : 'asset-tree',
      historical: scanned.source === 'episode-copy',
      episodeNumbers: [...new Set((scanned.episodeNumbers ?? []).filter((value) => Number.isInteger(value)))]
        .sort((left, right) => left - right),
    };
    byHash.set(scanned.sha256, file);
    byPath.set(scanned.relativePath, file);
    outByHash.set(scanned.sha256, file);
    claimedVersionIds.add(file.assetVersionId);
    out.push(file);
  }
}

/** A stable key for one logical asset inside a project. */
export function assetKey(kind, name) {
  return `${kind}:${cleanAssetLabel(name)}`;
}

/**
 * The asset library bound to one project root, stored beside the rest of the metadata.
 *
 * Stored in `.director/assets.json` rather than inside `资产/` so the asset folders remain
 * exactly what the user organised them into: a scan reads them, and nothing this module does
 * renames, moves or rewrites a single asset file.
 *
 * @param store - a `createDirectorStore` instance; the lock and atomic writer are shared, so
 *   a metadata write can never interleave with another process's.
 */
export function createAssetLibrary(store) {
  const read = async () => {
    const raw = await store.readAssetIndex();
    const index = raw ?? { schemaVersion: ASSET_SCHEMA_VERSION, assets: [], scannedAt: null };
    return {
      ...index,
      assets: (index.assets ?? []).map(normalizeStoredAsset),
    };
  };

  return {
    /** The stored model, or an empty one before the first scan. */
    async load() {
      return await read();
    },
    async useInEpisode(name, kind, number) {
      if (!Number.isInteger(number) || number < 1) return;
      await store.withLock(async () => {
        const index = await read();
        const asset = index.assets.find((entry) => entry.name === name && entry.kind === kind);
        if (!asset) return;
        asset.episodeNumbers = [...new Set([...(asset.episodeNumbers ?? []), number])];
        await store.writeAssetIndex(index, { locked: true });
      });
    },

    /**
     * Create an asset that has no picture yet.
     *
     * This is the panel's "新增人物 / 场景 / 道具" path. The inventory is the initial
     * source, but a production may need a character the script did not name yet; that
     * asset must survive refreshes just like one discovered from a folder.
     */
    async create({ kind, name, description = '', variantName = null, episodeNumbers = [] } = {}) {
      const allowed = new Set(['character', 'scene', 'prop', 'reference-audio']);
      if (!allowed.has(kind)) throw new Error('新增资产类型只能是人物、场景、道具或参考音频');
      const clean = String(name ?? '').trim();
      if (clean.length === 0) throw new Error('资产名称不能为空');
      if (/[\\/:*?"<>|\x00-\x1f]/u.test(clean)) throw new Error('资产名称不能包含路径字符');
      return await store.withLock(async () => {
        const stored = await read();
        if ((stored.assets ?? []).some((asset) => asset.kind === kind && asset.name === clean)) {
          throw new Error(`已存在同名${kind === 'character' ? '人物' : kind === 'scene' ? '场景' : kind === 'prop' ? '道具' : '参考音频'}：${clean}`);
        }
        const names = ['default', ...(typeof variantName === 'string' && variantName.trim().length > 0 && variantName.trim() !== 'default'
          ? [variantName.trim()]
          : [])];
        const variants = names.map((variant) => ({
        variantId: newVariantId(),
        name: variant,
        description: variant === 'default' ? String(description ?? '') : null,
        episodeNumbers: [...new Set(episodeNumbers.filter((value) => Number.isInteger(value)))],
        files: [],
        selectedVersionId: null,
        selectionRole: null,
        selectedAt: null,
        selectionNote: null,
        }));
        const asset = {
        assetId: newAssetId(kind),
        kind,
        name: clean,
        aliases: [],
        description: String(description ?? ''),
        episodeNumbers: [...new Set(episodeNumbers.filter((value) => Number.isInteger(value)))],
        identityVariant: 'default',
        variants,
        status: 'unconfirmed',
        source: 'manual',
        manual: true,
        inventory: false,
        };
        await store.writeAssetIndex({
          ...stored,
          deletedAssets: (stored.deletedAssets ?? []).filter((entry) => entry.kind !== kind || entry.name !== clean),
          assets: [...(stored.assets ?? []), asset],
        }, { locked: true });
        return summarizeAsset(asset);
      });
    },

    /** Add a costume/state variant to an existing character. */
    async addVariant({ asset, name, description = '', episodeNumbers = [] } = {}) {
      const clean = String(name ?? '').trim();
      if (clean.length === 0) throw new Error('变体名称不能为空');
      if (/[\\/:*?"<>|\x00-\x1f]/u.test(clean)) throw new Error('变体名称不能包含路径字符');
      return await store.withLock(async () => {
        const stored = await read();
        const target = (stored.assets ?? []).find((entry) => entry.assetId === asset
          || entry.name === asset
          || (entry.aliases ?? []).includes(asset));
        if (target === undefined) throw new Error(`没有找到资产：${String(asset)}`);
        if ((target.variants ?? []).some((variant) => variant.name === clean)) {
          throw new Error(`「${target.name}」已经有变体「${clean}」`);
        }
        const variant = {
        variantId: newVariantId(),
        name: clean,
        description: String(description ?? ''),
        episodeNumbers: [...new Set(episodeNumbers.filter((value) => Number.isInteger(value)))],
        files: [],
        selectedVersionId: null,
        selectionRole: null,
        selectedAt: null,
        selectionNote: null,
        };
        const next = {
        ...stored,
        assets: (stored.assets ?? []).map((entry) => (entry.assetId === target.assetId
          ? { ...entry, variants: [...(entry.variants ?? []), variant] }
          : entry)),
        };
        await store.writeAssetIndex(next, { locked: true });
        return summarizeAsset(next.assets.find((entry) => entry.assetId === target.assetId));
      });
    },

    /**
     * Scan the disk and reconcile against what is stored.
     *
     * @param options.commit - `false` computes and returns what WOULD be stored without
     *   writing, which is what a "what changed?" preview shows.
     */
    async refresh({ commit = true } = {}) {
      const scan = await scanAssets(store.root);
      const inventory = await readAssetInventory(store.root).catch(() => ({ assets: [], problems: [] }));
      return await store.withLock(async () => {
        const previous = await read();
        const model = buildAssetModel(scan, previous.assets ?? [], inventory);
        const scannedKeys = new Set((scan.assets ?? []).map((asset) => assetKey(asset.kind, asset.name)));
        const tombstones = (previous.deletedAssets ?? []).filter((entry) =>
          entry !== null && typeof entry === 'object'
            && typeof entry.kind === 'string' && typeof entry.name === 'string'
            && !scannedKeys.has(assetKey(entry.kind, entry.name)));
        const deletedKeys = new Set(tombstones.map((entry) => assetKey(entry.kind, entry.name)));
        const next = {
          schemaVersion: ASSET_SCHEMA_VERSION,
          assets: model.assets.filter((asset) => !deletedKeys.has(assetKey(asset.kind, asset.name))),
          deletedAssets: tombstones,
          scannedAt: new Date().toISOString(),
        };
        if (commit) await store.writeAssetIndex(next, { locked: true });
        return { ...model, assets: next.assets, committed: commit };
      });
    },

    /** A list view: one compact row per asset, optionally filtered. */
    async list(options = {}) {
      const stored = await read();
      return selectAssets(stored.assets ?? [], options).map(summarizeAsset);
    },

    /**
     * Choose which version of a variant a generation should use, or mark one approved.
     *
     * This is the operation that keeps "生成完成" and "审片通过" apart (G03). The selection is
     * recorded on the variant and survives re-scans and new files arriving, so a regeneration
     * never moves an approved binding.
     *
     * @param options.role - `generation` (the input to use next) or `approved` (passed review).
     */
    async select({ asset, variant, assetVersionId, role = SELECTION_ROLES.generation, note = null } = {}) {
      if (typeof assetVersionId !== 'string' || assetVersionId.length === 0) throw new Error('select needs assetVersionId');
      return await store.withLock(async () => {
      const stored = await read();
      // Select over the full index: `asset` may be an id, and the query filter only
      // searches user-facing names, so applying it first made id-based selection fail.
      const target = selectAssets(stored.assets ?? [])
        .find((entry) => entry.assetId === asset || entry.name === asset || (entry.aliases ?? []).includes(asset));
      if (target === undefined) throw new Error(`no asset matches ${JSON.stringify(asset)}`);
      const targetVariant = variant === undefined || variant === null
        ? target.variants[0]
        : target.variants.find((entry) => entry.variantId === variant || entry.name === variant);
      if (targetVariant === undefined) throw new Error(`no variant ${JSON.stringify(variant)} on ${target.name}`);
      const selectedFile = (targetVariant.files ?? []).find((file) => file.assetVersionId === assetVersionId);
      if (target.kind === 'character' && role === SELECTION_ROLES.generation && selectedFile?.role === 'voice') {
        throw new Error('人物音色是音频参考，不能设为画面的当前输入');
      }

      const updated = applySelection(targetVariant, assetVersionId, { role, note });
      const next = {
        ...stored,
        assets: (stored.assets ?? []).map((entry) => (entry.assetId !== target.assetId
          ? entry
          : {
            ...entry,
            // Approving a version says something about the ASSET too, so its status is what
            // records it: an asset with a reviewed version is no longer unreviewed.
            status: role === SELECTION_ROLES.approved ? 'approved' : entry.status,
            variants: entry.variants.map((candidate) => (candidate.variantId === targetVariant.variantId ? updated : candidate)),
          })),
      };
      await store.writeAssetIndex(next, { locked: true });
      return { assetId: target.assetId, variantId: targetVariant.variantId, assetVersionId, role, selectionBroken: selectionBroken(updated) };
      });
    },

    /** Remove one file version from the index after its file has been moved out of the asset tree. */
    async deleteVersion({ asset, variant, assetVersionId } = {}) {
      if (typeof assetVersionId !== 'string' || assetVersionId.length === 0) {
        throw new Error('deleteVersion needs assetVersionId');
      }
      return await store.withLock(async () => {
      const stored = await read();
      const target = selectAssets(stored.assets ?? [])
        .find((entry) => entry.assetId === asset || entry.name === asset || (entry.aliases ?? []).includes(asset));
      if (target === undefined) throw new Error(`no asset matches ${JSON.stringify(asset)}`);
      const targetVariant = variant === undefined || variant === null
        ? target.variants.find((entry) => (entry.files ?? []).some((file) => file.assetVersionId === assetVersionId))
        : target.variants.find((entry) => entry.variantId === variant || entry.name === variant);
      if (targetVariant === undefined) throw new Error(`no variant ${JSON.stringify(variant)} on ${target.name}`);
      const removed = (targetVariant.files ?? []).find((file) => file.assetVersionId === assetVersionId);
      if (removed === undefined) throw new Error(`version ${assetVersionId} is not part of ${target.name}`);
      const files = targetVariant.files.filter((file) => file.assetVersionId !== assetVersionId);
      const fallbackQuadview = files
        .filter((file) => file.role === 'quadview' && file.missing !== true)
        .reduce((best, file) => (best === undefined || (file.version ?? 0) > (best.version ?? 0) ? file : best), undefined);
      const selectionWasRemoved = targetVariant.selectedVersionId === assetVersionId;
      const updated = {
        ...targetVariant,
        files,
        selectedVersionId: selectionWasRemoved ? (fallbackQuadview?.assetVersionId ?? null) : targetVariant.selectedVersionId ?? null,
        selectionRole: selectionWasRemoved ? (fallbackQuadview === undefined ? null : SELECTION_ROLES.generation) : targetVariant.selectionRole ?? null,
        selectedAt: selectionWasRemoved ? null : targetVariant.selectedAt ?? null,
        selectionNote: selectionWasRemoved ? (fallbackQuadview === undefined ? null : '删除后默认使用四视图') : targetVariant.selectionNote ?? null,
      };
      const next = {
        ...stored,
        assets: (stored.assets ?? []).map((entry) => (entry.assetId !== target.assetId
          ? entry
          : { ...entry, variants: entry.variants.map((candidate) => (candidate.variantId === targetVariant.variantId ? updated : candidate)) })),
      };
      await store.writeAssetIndex(next, { locked: true });
      return {
        assetId: target.assetId,
        variantId: targetVariant.variantId,
        assetVersionId,
        removed,
        selectedVersionId: updated.selectedVersionId,
      };
      });
    },

    /**
     * Remove one whole asset while keeping every present file recoverable.
     *
     * Deleting `.director/assets.json` was the old workaround, but it also erased hand-written
     * descriptions. This action removes only the selected asset record and moves its present
     * files into `.director/asset-trash/<assetId>-<timestamp>/`, preserving their relative paths.
     */
    async remove(identifier, { removeFiles = true } = {}) {
      return await store.withLock(async () => {
        const stored = await read();
        const target = selectAssets(stored.assets ?? [])
          .find((entry) => entry.assetId === identifier || entry.name === identifier || (entry.aliases ?? []).includes(identifier));
        if (target === undefined) throw new Error(`没有找到资产：${String(identifier)}`);
        const pathsReferencedElsewhere = new Set();
        for (const asset of stored.assets ?? []) {
          if (asset.assetId === target.assetId) continue;
          for (const variant of asset.variants ?? []) {
            for (const file of variant.files ?? []) {
              for (const path of [file.relativePath, ...(file.paths ?? [])]) {
                if (typeof path === 'string' && path.length > 0) {
                  pathsReferencedElsewhere.add(path.replace(/\\/gu, '/'));
                }
              }
            }
          }
        }
        const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
        const trashRelative = `.director/asset-trash/${target.assetId}-${stamp}`;
        const filesMoved = [];
        const filesSkipped = [];
        if (removeFiles) {
          await mkdir(join(store.root, ...trashRelative.split('/')), { recursive: true });
          const visitedPaths = new Set();
          for (const variant of target.variants ?? []) {
            for (const file of variant.files ?? []) {
              const paths = [...new Set([file.relativePath, ...(file.paths ?? [])]
                .filter((path) => typeof path === 'string' && path.length > 0)
                .map((path) => path.replace(/\\/gu, '/')))];
              for (const normalized of paths) {
                if (visitedPaths.has(normalized)) continue;
                visitedPaths.add(normalized);
                if (pathsReferencedElsewhere.has(normalized)) {
                  filesSkipped.push({ relativePath: normalized, reason: 'shared-with-another-asset' });
                  continue;
                }
                const source = join(store.root, ...normalized.split('/'));
                const destinationRelative = `${trashRelative}/${normalized}`;
                const destination = join(store.root, ...destinationRelative.split('/'));
                try {
                  await mkdir(dirname(destination), { recursive: true });
                  await rename(source, destination);
                  filesMoved.push({ relativePath: normalized, trashRelativePath: destinationRelative });
                } catch (error) {
                  if (error?.code === 'ENOENT') continue;
                  throw error;
                }
              }
            }
          }
        }
        const next = {
          ...stored,
          deletedAssets: [
            ...(stored.deletedAssets ?? []).filter((entry) => entry.kind !== target.kind || entry.name !== target.name),
            { kind: target.kind, name: target.name, assetId: target.assetId, deletedAt: new Date().toISOString() },
          ],
          assets: (stored.assets ?? []).filter((asset) => asset.assetId !== target.assetId),
        };
        await store.writeAssetIndex(next, { locked: true });
        return {
          assetId: target.assetId,
          assetName: target.name,
          kind: target.kind,
          filesMoved,
          filesSkipped,
          trashRelativePath: filesMoved.length > 0 ? trashRelative : null,
        };
      });
    },

    /**
     * Select whichever version IS this file.
     *
     * The bridge between the two selection models. A candidate in the results area carries a
     * sha256 and a file name; an asset version carries an id. After a candidate is copied into the
     * asset tree, this is what points the asset side's selection at the file that just arrived -
     * otherwise the copy succeeds and the asset view still reports the old version as the one in
     * use, leaving the user to select it a second time for no reason they can see.
     *
     * Matched by PATH because that is what the caller knows after a copy. A file that has not been
     * scanned yet raises `NOT_INDEXED` rather than silently doing nothing.
     */
    async selectByPath(relativePath, { role = SELECTION_ROLES.approved, note = null } = {}) {
      const target = String(relativePath ?? '').replace(/\\/gu, '/');
      if (target.length === 0) throw new Error('selectByPath needs a path');
      return await store.withLock(async () => {
      const stored = await read();
      let hit = null;
      for (const asset of stored.assets ?? []) {
        for (const variant of asset.variants ?? []) {
          for (const file of variant.files ?? []) {
            const paths = (file.paths ?? [file.relativePath]).map((entry) => String(entry).replace(/\\/gu, '/'));
            if (paths.includes(target)) { hit = { asset, variant, file }; break; }
          }
          if (hit !== null) break;
        }
        if (hit !== null) break;
      }
      if (hit === null) {
        const error = new Error(`${target} is not a known asset version; refresh the asset library first`);
        error.code = 'NOT_INDEXED';
        throw error;
      }
      const updated = applySelection(hit.variant, hit.file.assetVersionId, { role, note });
      const next = {
        ...stored,
        assets: (stored.assets ?? []).map((entry) => (entry.assetId !== hit.asset.assetId
          ? entry
          : {
            ...entry,
            status: role === SELECTION_ROLES.approved ? 'approved' : entry.status,
            variants: entry.variants.map((candidate) => (candidate.variantId === hit.variant.variantId ? updated : candidate)),
          })),
      };
      await store.writeAssetIndex(next, { locked: true });
      return {
        assetId: hit.asset.assetId,
        assetName: hit.asset.name,
        variantId: hit.variant.variantId,
        assetVersionId: hit.file.assetVersionId,
        role,
      };
      });
    },

    /**
     * The filtered assets in full, including every file's path.
     *
     * `list` deliberately drops paths: that is the shape a picker needs, and a path is not
     * something a browser should ever receive. The one caller that DOES need them is the
     * panel's media layer, which turns a path into an opaque handle and sends the handle
     * instead. Keeping that need behind its own method means the ordinary list cannot leak a
     * path by accident, and `summarizeAsset` stays the only shape the panel sees.
     */
    async rows(options = {}) {
      const stored = await read();
      return selectAssets(stored.assets ?? [], options);
    },

    /**
     * The raw stored record for a Host-internal caller.
     *
     * The panel receives a summarized detail without filesystem paths. A replacement
     * needs the identity folder so a new version lands beside the existing four-view
     * instead of creating a second character folder, so that one caller asks for the
     * raw record and never forwards it to the browser.
     */
    async record(identifier) {
      const stored = await read();
      const key = String(identifier ?? '').trim();
      if (key.length === 0) return undefined;
      return (stored.assets ?? []).find((entry) => entry.assetId === key
        || entry.name === key
        || (entry.aliases ?? []).includes(key));
    },

    /**
     * Full detail for one asset.
     *
     * @param assetId - the asset's id, its display name, or an alias. Names are accepted
     *   because a chat request says "林晚" and a lookup that demanded an id would make the
     *   caller resolve it first through a second call.
     */
    async detail(identifier) {
      const stored = await read();
      const key = String(identifier ?? '').trim();
      if (key.length === 0) return undefined;
      const asset = (stored.assets ?? []).find((entry) => entry.assetId === key
        || entry.name === key
        || (entry.aliases ?? []).includes(key));
      if (asset === undefined) return undefined;
      return {
        ...summarizeAsset(asset),
        folder: asset.folder ?? null,
        identityFolder: asset.identityFolder ?? null,
        variants: identityFirst(asset).map((variant) => ({
          variantId: variant.variantId,
          name: variant.name,
          description: variant.description ?? null,
          episodeNumbers: variant.episodeNumbers ?? [],
          // Which version a generation would use, and whether that is a decision or a default.
          // The panel has to tell "you approved this" apart from "this is simply the newest",
          // and omitting these meant the detail view could say neither.
          selectedVersionId: variant.selectedVersionId ?? null,
          selectionRole: variant.selectionRole ?? null,
          selectedAt: variant.selectedAt ?? null,
          selectionNote: variant.selectionNote ?? null,
          selectionBroken: selectionBroken(variant),
          currentVersionId: currentAssetVersion(asset, variant)?.assetVersionId ?? null,
          newestVersion: (variant.files ?? []).reduce((max, file) => Math.max(max, file.version ?? 0), 0),
          files: variant.files.map((file) => ({
            assetVersionId: file.assetVersionId,
            role: file.role,
            version: file.version,
            fileName: file.fileName,
            relativePath: file.relativePath,
            paths: file.paths ?? [file.relativePath],
            bytes: file.bytes,
            sha256: file.sha256,
            status: file.status,
            // Whether THIS file is the chosen one, so a version row can show it without the
            // panel re-deriving it from two other fields.
            selected: variant.selectedVersionId === file.assetVersionId,
            current: currentAssetVersion(asset, variant)?.assetVersionId === file.assetVersionId,
            missing: file.missing === true,
            derivedFromVersionId: file.derivedFromVersionId ?? null,
            source: file.source ?? 'asset-tree',
            historical: file.historical === true,
            episodeNumbers: file.episodeNumbers ?? [],
          })),
        })),
      };
    },
  };
}

/** Ids carry their kind, so a log line says what it refers to without a lookup. */
let idCounter = 0;
function mintId(prefix) {
  idCounter += 1;
  // Time + counter + process entropy: unique within a run, and sortable by creation.
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const newAssetId = (kind) => mintId(`as${String(kind ?? 'x').slice(0, 2)}`);
export const newVariantId = () => mintId('vr');
export const newVersionId = () => mintId('av');

/**
 * The file version a reference should point at.
 *
 * Deliberately explicit rather than "the newest": binding a shot to whatever was generated
 * last is how a regenerated asset silently changes a finished shot. The caller names the
 * version, or takes the current one on purpose.
 */
export function currentVersion(variant) {
  if (variant === undefined || variant === null) return undefined;
  const present = (variant.files ?? []).filter((file) => file.missing !== true);
  if (present.length === 0) return undefined;
  // A selection wins over recency. Ranking by version number alone means a regeneration becomes
  // the version everything uses, which conflates "生成完成" with "审片通过" - the second is a
  // decision a person made, and it has to survive new files arriving or it means nothing.
  const selected = variant.selectedVersionId;
  if (typeof selected === 'string' && selected.length > 0) {
    const chosen = present.find((file) => file.assetVersionId === selected);
    if (chosen !== undefined) return chosen;
    // The chosen file is gone. Falling through to the newest is right - something has to be
    // usable - but it is a CHANGED answer, so `selectionBroken` reports it rather than letting
    // it pass as the selection.
  }
  // Episode copies can be older than the current asset-tree file and may receive a higher
  // bookkeeping version when they are first indexed. They are history, not the default input.
  // An explicit selection still wins above.
  const currentPool = present.filter((file) => file.historical !== true);
  const pool = currentPool.length > 0 ? currentPool : present;
  return pool.reduce((best, file) => (file.version > best.version ? file : best), pool[0]);
}

/**
 * The current version that can actually be used by this asset's main workflow.
 *
 * Character audio shares the character folder but is not a picture. An old index may still point
 * `selectedVersionId` at a voice file from before that distinction existed; the cover and "current
 * input" must ignore it instead of turning the character card into an audio player.
 */
function currentAssetVersion(asset, variant) {
  const current = currentVersion(variant);
  if (asset?.kind !== 'character' || current?.role !== 'voice') return current;
  return representativeVersion(variant);
}

/** What a selection means. Not the same question as "is it newer". */
export const SELECTION_ROLES = Object.freeze({
  /** Chosen as the input for the next generation. */
  generation: 'generation',
  /** Approved after looking at the result. */
  approved: 'approved',
});

/**
 * Whether a selection exists but can no longer be honoured.
 *
 * A different answer from "is something selected", because the two need different words: one is
 * "you approved this", the other is "the file you approved is gone, this is the nearest thing".
 * Reporting the second as the first is how an approval quietly transfers to a file nobody saw.
 */
export function selectionBroken(variant) {
  const selected = variant?.selectedVersionId;
  if (typeof selected !== 'string' || selected.length === 0) return false;
  return !(variant.files ?? []).some((file) => file.assetVersionId === selected && file.missing !== true);
}

/** Record a selection on a variant. Pure: the caller decides when to persist. */
export function applySelection(variant, assetVersionId, { role = SELECTION_ROLES.generation, note = null, at = null } = {}) {
  if (!Object.values(SELECTION_ROLES).includes(role)) throw new Error(`unknown selection role "${role}"`);
  if (!(variant.files ?? []).some((file) => file.assetVersionId === assetVersionId)) {
    const error = new Error(`${assetVersionId} is not a version of this variant, so it cannot be selected`);
    error.code = 'UNKNOWN_VERSION';
    throw error;
  }
  return {
    ...variant,
    selectedVersionId: assetVersionId,
    selectionRole: role,
    selectedAt: at ?? new Date().toISOString(),
    selectionNote: note,
  };
}

/** Every version of a variant, oldest first, so a history reads in the order it happened. */
export function versionHistory(variant) {
  return [...(variant?.files ?? [])].sort((left, right) => (left.version ?? 0) - (right.version ?? 0));
}

/** Role order for the file that represents an asset in the panel. */
export const REPRESENTATIVE_ROLE_ORDER = Object.freeze(['quadview', 'threeview', 'front', 'primary', 'closeup', 'side', 'back', 'night']);

/**
 * The newest present file of the most representative role.
 *
 * `variant.files` is sorted oldest-first for history. A replacement adds a higher version,
 * so picking the first role match showed the old picture after an upload. This helper keeps
 * role preference and recency in one place, so the grid and any future caller agree.
 */
export function representativeVersion(variant, roleOrder = REPRESENTATIVE_ROLE_ORDER, { allowVoice = false } = {}) {
  const present = (variant?.files ?? []).filter((file) => file.missing !== true
    && (allowVoice || file.role !== 'voice')
    && typeof file.relativePath === 'string');
  if (present.length === 0) return undefined;
  // An explicit choice is the card's cover as well as the generation input. Otherwise clicking a
  // version would update the details while the library kept advertising a different picture.
  const selected = typeof variant?.selectedVersionId === 'string'
    ? present.find((file) => file.assetVersionId === variant.selectedVersionId)
    : undefined;
  if (selected !== undefined) return selected;
  const current = present.filter((file) => file.historical !== true);
  const pool = current.length > 0 ? current : present;
  const newest = (files) => files.reduce((best, file) => {
    const versionDelta = (file.version ?? 0) - (best.version ?? 0);
    if (versionDelta !== 0) return versionDelta > 0 ? file : best;
    // Equal bookkeeping versions can happen after re-indexing legacy files. Pick by stable identity
    // instead of filesystem enumeration order so the same variant always resolves to the same file.
    return String(file.assetVersionId ?? '').localeCompare(String(best.assetVersionId ?? '')) > 0 ? file : best;
  }, files[0]);
  for (const role of roleOrder) {
    const candidates = pool.filter((file) => file.role === role);
    if (candidates.length > 0) return newest(candidates);
  }
  return newest(pool);
}

/** Every file version of one asset, flattened, with its variant name attached. */
export function flattenVersions(asset) {
  const out = [];
  for (const variant of asset.variants ?? []) {
    for (const file of variant.files ?? []) {
      out.push({ ...file, variantId: variant.variantId, variantName: variant.name });
    }
  }
  return out;
}

/**
 * The newest user-uploaded voice belonging to a character.
 *
 * Voice is character-level even when the character has costume variants: the uploaded file is
 * written into the identity variant, but the lookup deliberately spans all variants so older
 * projects that placed `角色音色.wav` beside a costume still work. This is a read-only choice;
 * generation never invents or edits a voice.
 */
export function characterVoiceVersion(asset) {
  if (asset?.kind !== 'character') return undefined;
  const voices = flattenVersions(asset).filter((file) => file.role === 'voice'
    && file.missing !== true
    && typeof file.relativePath === 'string');
  if (voices.length === 0) return undefined;
  const active = voices.filter((file) => file.historical !== true);
  return (active.length > 0 ? active : voices).reduce((best, file) => {
    const byVersion = (file.version ?? 0) - (best.version ?? 0);
    if (byVersion !== 0) return byVersion > 0 ? file : best;
    const fileAt = Date.parse(file.registeredAt ?? '') || 0;
    const bestAt = Date.parse(best.registeredAt ?? '') || 0;
    return fileAt > bestAt ? file : best;
  });
}

/**
 * A compact row for a list view: one line per asset, no file bodies.
 *
 * The list is what a picker shows, so it carries what a choice needs - kind, name, how many
 * variants and versions exist, whether anything is approved - and nothing that would make
 * the payload large. Full detail is a separate call.
 */
// Present old media folders in the new categories without migrating stable asset/version IDs.
export function displayAssetKind(asset) {
  if (asset.kind !== 'reference-media') return asset.kind;
  const files = flattenVersions(asset);
  const file = (asset.variants ?? []).map(currentVersion).find(Boolean) ?? files[0];
  const ext = extname(file?.fileName ?? '').toLowerCase();
  return AUDIO_EXT.has(ext) ? 'reference-audio' : VIDEO_EXT.has(ext) ? 'reference-video' : 'reference-image';
}

function identityFirst(asset) {
  return [...(asset.variants ?? [])].sort((left, right) => (left.name === asset.identityVariant
    ? -1
    : right.name === asset.identityVariant ? 1 : left.name.localeCompare(right.name)));
}

export function summarizeAsset(asset) {
  const files = flattenVersions(asset);
  const present = files.filter((file) => file.missing !== true);
  const visualPresent = present.filter((file) => file.role !== 'voice');
  const voice = characterVoiceVersion(asset);
  const brokenSelections = identityFirst(asset).filter((variant) => selectionBroken(variant));
  return {
    assetId: asset.assetId,
    kind: displayAssetKind(asset),
    name: asset.name,
    aliases: asset.aliases ?? [],
    description: asset.description ?? null,
    episodeNumbers: asset.episodeNumbers ?? [],
    qualifier: asset.qualifier ?? null,
    identityVariant: asset.identityVariant ?? 'default',
    source: asset.source ?? 'files',
    manual: asset.manual === true,
    inventory: asset.inventory === true,
    planned: asset.planned === true
      || (asset.kind === 'character' ? visualPresent.length === 0 : !assetHasPresentFile(asset)),
    status: asset.status ?? 'unconfirmed',
    variants: identityFirst(asset).map((variant) => ({
      variantId: variant.variantId,
      name: variant.name,
      description: variant.description ?? null,
      episodeNumbers: variant.episodeNumbers ?? [],
      versions: (variant.files ?? []).filter((file) => file.missing !== true).length,
      roles: [...new Set((variant.files ?? []).filter((file) => file.missing !== true).map((file) => file.role))],
      // Which version a generation would use, and whether that is a decision or a default. The
      // panel has to tell "you approved this" apart from "this is simply the newest".
      selectedVersionId: variant.selectedVersionId ?? null,
      selectionRole: variant.selectionRole ?? null,
      selectedAt: variant.selectedAt ?? null,
      selectionBroken: selectionBroken(variant),
      currentVersionId: currentAssetVersion(asset, variant)?.assetVersionId ?? null,
      newestVersion: (variant.files ?? []).reduce((max, file) => Math.max(max, file.version ?? 0), 0),
    })),
    versionCount: present.length,
    visualVersionCount: visualPresent.length,
    voiceCount: present.filter((file) => file.role === 'voice').length,
    voice: voice === undefined ? null : {
      assetVersionId: voice.assetVersionId,
      variantId: voice.variantId,
      variantName: voice.variantName,
      version: voice.version,
      fileName: voice.fileName,
      relativePath: voice.relativePath,
      bytes: voice.bytes,
      sha256: voice.sha256,
    },
    roles: [...new Set(present.map((file) => file.role))],
    // The card badge is an ACTION warning, not a history census. Replacing a portrait leaves
    // old versions on disk normally, but older projects did overwrite/remove them. Those absent
    // historical versions must stay visible in detail without making a fully usable asset say
    // "缺 3" forever. Only a missing SELECTED/current binding is actionable here.
    missingCount: brokenSelections.length,
    missingVersionCount: files.length - present.length,
  };
}

/**
 * Search and filter the flat asset list.
 *
 * Filtering by kind and by a text query are the two the pipeline actually needs - "本集要用
 * 的人物" and "找到 林晚" - so the matches are on the display name and the aliases, not on
 * file paths, because a path is not what the user is thinking about.
 */
export function selectAssets(assets, { kind = null, query = null, ids = null, includePlanned = true } = {}) {
  const wanted = ids === null || ids === undefined ? null : new Set(ids);
  const needle = query === null || query === undefined || String(query).trim().length === 0
    ? null
    : String(query).trim().toLowerCase();
  /**
   * Hide an EMPTY asset that shadows a real one of the same base name.
   *
   * Real libraries end up holding both `雷劫代练木牌` (has pictures) and `雷劫代练木牌（正面）` /
   * `雷劫代练木牌（天道同价）` / `1. 雷劫代练木牌` (zero files, created as metadata placeholders). The panel then shows
   * one prop two or three times - "一个有图，一个没图" - and a mention can bind to the empty one, which is the
   * unresolved-reference bug reported against this very project.
   *
   * Deliberately narrow: only an asset with NO file at all, whose base name (text before a trailing （…）, with
   * any leading "1. " numbering stripped) is also held by an asset that DOES have files. An empty asset with no
   * real sibling stays visible - v57 requires that, because 「还没有出图」 is a state the user must see.
   */
  const hasFile = assetHasPresentFile;
  const baseName = (name) => String(name ?? '')
    .replace(/^\s*\d+\s*[.、]\s*/u, '')
    .replace(/\s*[（(][^）)]*[）)]\s*$/u, '')
    .trim();
  const withFiles = new Set(assets.filter(hasFile).map((asset) => baseName(asset.name)).filter((name) => name.length > 0));
  const shadowed = (asset) => {
    if (hasFile(asset)) return false;
    const base = baseName(asset.name);
    return base.length > 0 && withFiles.has(base);
  };
  return assets.filter((asset) => {
    if (isTemplateAssetName(asset.name)) return false;
    if (!includePlanned && !hasFile(asset)) return false;
    if (!hasFile(asset) && /^\s*\d+\s*[.、]\s*/u.test(String(asset.name ?? ''))) return false;
    if (shadowed(asset)) return false;
    if (kind !== null && kind !== undefined && asset.kind !== kind && displayAssetKind(asset) !== kind) return false;
    if (wanted !== null && !wanted.has(asset.assetId)) return false;
    if (needle === null) return true;
    const haystack = [asset.name, asset.qualifier, ...(asset.aliases ?? [])].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}
