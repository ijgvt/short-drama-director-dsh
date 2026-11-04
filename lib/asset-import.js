import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, relative } from 'node:path';
import { isScratchFile, parseAssetFolder, stripGeneratorSuffix } from './asset-store.js';
import { inspectImageBytes } from './image-guard.js';

export const REFERENCE_FOLDERS = {
  character: '人物资产', scene: '场景资产', prop: '道具资产',
  'reference-image': '其他参考图片', 'reference-video': '参考视频', 'reference-audio': '参考音频',
  'reference-media': '参考媒体', // Existing tool callers and projects remain supported.
};
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);
const MEDIA = new Set([...VIDEO, ...AUDIO]);

const IMAGE_FORMAT_EXTENSIONS = {
  png: new Set(['.png']),
  jpeg: new Set(['.jpg', '.jpeg']),
  webp: new Set(['.webp']),
  gif: new Set(['.gif']),
  bmp: new Set(['.bmp']),
};
const GUARDED_IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_FORMAT_EXTENSIONS).flatMap((values) => [...values]));

/**
 * Validate an upload, repair the common "complete JPEG, missing only EOI" case, and
 * canonicalise a mislabelled extension to the bytes actually supplied. A JPEG named `.png`
 * is still a valid JPEG; rejecting it forces a needless transcode and can lose quality.
 */
export function normalizeImageUpload(bytes, fileName) {
  const extension = extname(String(fileName ?? '')).toLowerCase();
  if (!GUARDED_IMAGE_EXTENSIONS.has(extension)) return { bytes, extension };
  const inspected = inspectImageBytes(bytes);
  const format = inspected.format === null ? null : String(inspected.format).toLowerCase();
  let normalized = bytes;
  if (format === 'jpeg' && inspected.ok !== true && /缺 EOI/u.test(String(inspected.reason ?? ''))) {
    const repaired = Buffer.concat([bytes, Buffer.from([0xFF, 0xD9])]);
    if (inspectImageBytes(repaired).ok === true) normalized = repaired;
  }
  const finalInspection = normalized === bytes ? inspected : inspectImageBytes(normalized);
  const incomplete = finalInspection.ok !== true && /不完整/u.test(String(finalInspection.reason ?? ''));
  if (incomplete || format === null) {
    throw new Error(`图片「${String(fileName ?? '未命名')}」无法使用：${finalInspection.reason}。本次没有写入资产库`);
  }
  const actualExtension = format === 'jpeg'
    ? (extension === '.jpeg' ? '.jpeg' : '.jpg')
    : format === 'png' ? '.png'
      : format === 'webp' ? '.webp'
        : format === 'gif' ? '.gif'
          : format === 'bmp' ? '.bmp'
            : extension;
  return { bytes: normalized, extension: actualExtension };
}

function automaticName(fileName) {
  let name = basename(fileName, extname(fileName)).trim()
    .replace(/[<>:"/\\|?*\s\x00-\x1f@、，,。；;｜]/gu, '_').replace(/[. ]+$/gu, '').slice(0, 90);
  if (!name) name = '素材';
  if (isScratchFile(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(name)) name = `素材_${name}`;
  return name;
}

export async function importReference({ fs, projectRoot, payload, getPolicy, known = null }) {
  const kind = payload.kindFilter;
  if (!Object.hasOwn(REFERENCE_FOLDERS, kind)) throw new Error('请选择素材分类');
  const supplied = payload.fileName ?? (typeof payload.sourcePath === 'string' ? basename(payload.sourcePath) : '');
  let extension = extname(supplied).toLowerCase();
  const allowed = kind === 'reference-video' ? VIDEO : kind === 'reference-audio' ? AUDIO : kind === 'reference-media' ? MEDIA : IMAGES;
  if (!allowed.has(extension)) throw new Error('文件类型与参考素材分类不匹配');
  const automatic = payload.assetName === undefined || payload.assetName === null;
  const name = automatic ? automaticName(supplied) : String(payload.assetName).trim();
  if (!name || name.length > 100 || /[<>:"/\\|?*\s\x00-\x1f@]/u.test(name) || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(name)) throw new Error('素材名称不能有空格、@ 或路径字符');
  /**
   * A name that already exists in ANOTHER category is not a second file - it is an ambiguity.
   *
   * Measured: a four-view uploaded through 其他参考图片 created a SECOND asset called 顾星野 beside the
   * character of that name. From then on `@顾星野` has two candidates, the panel can show the wrong
   * picture for either, and the person who uploaded it sees "my upload did nothing". Refusing here is
   * the only honest stop: the tool cannot know whether the file was meant to replace the character's
   * four-view or to be an independent reference.
   */
  if (known !== null && typeof known.entries === 'function' && name.length > 0) {
    for (const [existingName, existingKind] of known) {
      if (existingName !== name) continue;
      if (existingKind === kind) break;
      throw new Error(`库里已经有一个叫「${name}」的资产（${REFERENCE_FOLDERS[existingKind] ?? existingKind}）。`
        + `这一张不会在 ${REFERENCE_FOLDERS[kind]} 里再建一个同名副本——同名两个资产会让 @${name} 变成二义，面板就会显示不是你要的那张图。`
        + `两条出路：① 要换它现有的图，打开那张资产卡点「替换四视图 / 上传」；② 要作为独立参考图，给文件改个名字（例如 ${name}-动作参考）再上传`);
    }
  }
  const category = join(projectRoot, '资产', REFERENCE_FOLDERS[kind]);
  const destinationFor = (stem) => kind === 'character' ? join(category, stem, `${stem}${extension}`) : join(category, `${stem}${extension}`);
  const destination = destinationFor(name);
  const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
  let target = await fs.resolve(destination);
  if (typeof fs.checkedTarget === 'function') target = await fs.checkedTarget(target, policy);
  else if (policy && policy.mode !== 'danger-full-access') throw new Error('当前文件服务不支持按会话权限导入素材');
  let bytes;
  if (typeof payload.fileDataBase64 === 'string') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload.fileDataBase64)) throw new Error('素材数据无效');
    bytes = Buffer.from(payload.fileDataBase64, 'base64');
  } else if (typeof payload.sourcePath === 'string' && payload.sourcePath.trim()) {
    const source = await fs.resolve(payload.sourcePath.trim());
    bytes = typeof fs.readBytes === 'function' ? Buffer.from(await fs.readBytes(source)) : await readFile(source.targetKey);
  } else throw new Error('请选择本地素材文件');
  if (!bytes.length) throw new Error('素材文件为空');
  if (IMAGES.has(extension)) {
    const normalized = normalizeImageUpload(bytes, supplied);
    bytes = normalized.bytes;
    extension = normalized.extension;
  }
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const parsed = parseAssetFolder(name);
    const stem = suffix === 1 ? name : parsed.qualifier !== null ? `${parsed.name}-${suffix}（${parsed.qualifier}）` : `${name}-${suffix}`;
    const path = destinationFor(stem);
    target = await fs.resolve(path);
    if (typeof fs.checkedTarget === 'function') target = await fs.checkedTarget(target, policy);
    await mkdir(dirname(target.targetKey), { recursive: true });
    if (typeof fs.checkedTarget === 'function') target = await fs.checkedTarget(await fs.resolve(path), policy);
    try { await writeFile(target.targetKey, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A retry of the same upload is the same content, not a reason to create `name-1.mp3`.
      // Returning the existing path lets the host resolve a concrete asset version and bind
      // the H3 slot; the old behavior imported the file but left `binding: null`.
      let existingBytes = null;
      try {
        existingBytes = typeof fs.readBytes === 'function'
          ? Buffer.from(await fs.readBytes(await fs.resolve(path)))
          : await readFile(target.targetKey);
      } catch {
        existingBytes = null;
      }
      if (existingBytes !== null && Buffer.compare(existingBytes, bytes) === 0) {
        const existingAssetName = parseAssetFolder(kind === 'character' ? stem : stripGeneratorSuffix(`${stem}${extension}`).stem).name;
        return {
          name: existingAssetName,
          kind,
          relativePath: `资产/${REFERENCE_FOLDERS[kind]}/${kind === 'character' ? `${stem}/` : ''}${stem}${extension}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          reusedContent: true,
        };
      }
      if (!automatic) throw new Error('已有同名素材，请换一个名称');
      continue;
    }
    const assetName = parseAssetFolder(kind === 'character' ? stem : stripGeneratorSuffix(`${stem}${extension}`).stem).name;
    return {
      name: assetName,
      kind,
      relativePath: `资产/${REFERENCE_FOLDERS[kind]}/${kind === 'character' ? `${stem}/` : ''}${stem}${extension}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  throw new Error('同名素材过多，请修改文件名后重试');
}

const REPLACE_FOLDERS = {
  character: '人物资产',
  scene: '场景资产',
  prop: '道具资产',
  'reference-audio': '参考音频',
};

function safeStem(value) {
  const cleaned = String(value ?? '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/gu, '');
  return cleaned.length > 0 ? cleaned : '资产';
}

/**
 * Import one picture/audio file into an EXISTING asset variant.
 *
 * Unlike `importReference`, this does not create an asset from the uploaded name. The
 * target asset and variant are already decided by the panel, so a replacement keeps the
 * identity and adds a new file version. Character variants go into a variant subfolder;
 * scene/prop variants are written with the qualifier in the filename. Both shapes are
 * already understood by `scanAssets`.
 */
export async function replaceAssetFile({
  fs,
  projectRoot,
  asset,
  variantName = 'default',
  role = 'quadview',
  fileName,
  fileDataBase64,
  getPolicy,
  fileNameStem = null,
} = {}) {
  if (asset === null || typeof asset !== 'object') throw new Error('替换素材需要先选择资产');
  const kind = asset.kind;
  const folderName = REPLACE_FOLDERS[kind];
  if (folderName === undefined) throw new Error('这个资产类型不支持上传替换');
  const supplied = String(fileName ?? '');
  let extension = extname(supplied).toLowerCase();
  const imageKinds = new Set(['character', 'scene', 'prop']);
  const characterVoice = kind === 'character' && role === 'voice';
  if (characterVoice && !AUDIO.has(extension)) throw new Error('人物音色请上传 mp3/wav/flac 等音频');
  if (imageKinds.has(kind) && !characterVoice && !IMAGES.has(extension)) throw new Error('请上传 png/jpg/webp 等图片');
  if (kind === 'reference-audio' && !AUDIO.has(extension)) throw new Error('请上传 mp3/wav/flac 等音频');
  if (typeof fileDataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(fileDataBase64)) throw new Error('素材数据无效');
  let bytes = Buffer.from(fileDataBase64, 'base64');
  if (bytes.length === 0) throw new Error('素材文件是空的');
  if (imageKinds.has(kind) && !characterVoice) {
    const normalized = normalizeImageUpload(bytes, supplied);
    bytes = normalized.bytes;
    extension = normalized.extension;
  }
  if (kind === 'character' && role === 'auto') {
    const inspected = inspectImageBytes(bytes);
    const ratio = inspected.width > 0 && inspected.height > 0 ? inspected.width / inspected.height : 0;
    // The asset name is not a file-role marker. A character literally named "四视图人物"
    // must still accept an ordinary portrait; inspect only the qualifier after the base name.
    const qualifierText = asset.name === undefined || asset.name === null
      ? supplied
      : supplied.split(String(asset.name)).join('');
    role = /四视图|quadview|quad_view/iu.test(qualifierText) || ratio >= 1.35 ? 'quadview' : 'front';
  }
  const base = safeStem(asset.name);
  // Voice is a character capability, not a costume. Always store it with the identity
  // variant so switching from 礼服 to 家居服 cannot make the same person sound different.
  const variant = characterVoice
    ? safeStem(asset.identityVariant ?? 'default')
    : safeStem(variantName === null || variantName === undefined ? 'default' : variantName);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const targetIsIdentity = variant === 'default' || variant === asset.identityVariant;
  for (const candidate of asset.variants ?? []) {
    const sameVariant = candidate.name === variant
      || (targetIsIdentity && (candidate.name === 'default' || candidate.name === asset.identityVariant));
    if (!sameVariant) continue;
    const existing = (candidate.files ?? []).find((file) => file.missing !== true
      && file.sha256 === sha256
      && file.role === role);
    if (existing === undefined) continue;
    // Identical bytes in the same asset variant and role ARE that version. Writing another copy
    // only creates a misleading duplicate file while the index later folds both paths into one
    // content version, which also made the upload's binding lookup return null.
    return {
      kind,
      assetId: asset.assetId,
      assetName: asset.name ?? base,
      variantName: candidate.name,
      role: existing.role,
      fileName: existing.fileName,
      relativePath: existing.relativePath,
      assetVersionId: existing.assetVersionId,
      version: existing.version,
      sha256,
      reusedContent: true,
    };
  }
  const roleSuffix = kind === 'character'
    ? (role === 'voice' ? '音色' : role === 'quadview' ? '四视图' : role === 'front' ? '定妆照' : '')
    : kind === 'reference-audio' ? '声音' : '';
  const identityFolder = typeof asset.identityFolder === 'string' && asset.identityFolder.length > 0
    ? join(projectRoot, '资产', ...asset.identityFolder.split('/'))
    : null;
  const isIdentity = variant === 'default' || variant === asset.identityVariant;
  const characterRoot = identityFolder ?? join(projectRoot, '资产', folderName, base);
  const folder = kind === 'character'
    ? (isIdentity ? characterRoot : join(characterRoot, variant))
    : join(projectRoot, '资产', folderName);
  const stem = typeof fileNameStem === 'string' && fileNameStem.trim().length > 0
    ? safeStem(fileNameStem)
    : kind === 'character'
      ? `${base}${roleSuffix}`
    : `${base}${variant === 'default' ? '' : `（${variant}）`}${roleSuffix}`;
  const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
  let folderTarget = fs !== null && fs !== undefined && typeof fs.checkedTarget === 'function'
    ? (await fs.checkedTarget(folder, policy))?.targetKey ?? folder
    : folder;
  if ((fs === null || fs === undefined || typeof fs.checkedTarget !== 'function')
    && policy && policy.mode !== 'danger-full-access') {
    throw new Error('当前文件服务不支持按会话权限写入素材');
  }
  await mkdir(folderTarget, { recursive: true });
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? `${stem}${extension}` : `${stem}_${String(suffix).padStart(5, '0')}_${extension}`;
    const path = join(folder, name);
    let target = await fs.resolve(path);
    if (typeof fs.checkedTarget === 'function') target = await fs.checkedTarget(target, policy);
    else if (policy && policy.mode !== 'danger-full-access') throw new Error('当前文件服务不支持按会话权限写入素材');
    try {
      await writeFile(target.targetKey, bytes, { flag: 'wx' });
      return {
        kind,
        assetId: asset.assetId,
        assetName: base,
        variantName: variant,
        role,
        fileName: name,
        relativePath: relative(projectRoot, target.targetKey).replace(/\\/gu, '/'),
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名素材过多，请修改文件名后重试');
}
