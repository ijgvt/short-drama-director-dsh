/**
 * Storyboard Host entry points.
 *
 * Two things live here:
 *
 *  - a `/storyboard` command, so the UI can ask this process to read and write real
 *    files (`ctx.remote.commands.execute` is the client-callable form);
 *  - a `storyboard` tool, so the agent can do the same thing when the user asks in
 *    chat. Both call the same functions, so the two paths cannot drift.
 *
 * @module dsh-plugin-short-drama-director/lib/storyboard-tools
 */

import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { designRoot } from './design-root.js';
import { createReader, describeBlocks, sameBlockText, splitShotBlocks, withH3BlockHeading } from './storyboard.js';
import { createDirectorStore, hashText } from './director-store.js';
import { characterVoiceVersion, createAssetLibrary, parseAssetFileStem, representativeVersion, roleOf, summarizeAsset } from './asset-store.js';
import { addCharacterVoicesToReferences, buildReferences, buildH3References, looksLikeH3, mergeVideoPromptReferences, parseH3References, referenceFileIdentity, validateReferences } from './reference-service.js';
import { emptyDirectorContext, readState, setDirectorContext, updateState, upsertProject } from './state.js';
import { createJobStore } from './job-store.js';
import { createResultStore } from './result-store.js';
import { createThumbnailStore } from './thumbnail-service.js';
import { buildProgress, buildHealth, buildDiagnostic, compareSources, checkDurations } from './episode-report.js';
import { compileEpisodeToH3, englishSiblingName, h3FileName } from './h3-compile.js';
import { splitEpisodePrompt } from './episode-split.js';
import { importReference, replaceAssetFile } from './asset-import.js';
import { mediaTypeFor } from './media-service.js';
import { convertH3Block, translateH3 } from './h3-sync.js';
import { inspectImageBytes } from './image-guard.js';
import { generateH3, h3SettingsWithProjectDefaults } from './h3-generation.js';
import { listGeneralGenerationHistory, runGeneralGeneration } from './generation-panel.js';
import { refreshLedgerJob, runComfyWorkflow } from './tools.js';
import { inspectVideoWorkflowConfiguration, readGenerationConfiguration, saveGenerationConfiguration } from './generation-config.js';
import { createBlankDramaProject, createBlankEpisode } from './project-create.js';
import {
  savePromptSourceUpload,
  deletePromptSource,
  readPromptSourceConfiguration,
  selectPromptSource,
} from './prompt-sources.js';
import { hostIdentity } from './version.js';
import { applyMigration, planMigration } from './migrate.js';
import {
  ART_STYLES,
  ASPECT_RATIOS,
  RESOLUTIONS,
  SETTING_LABELS,
  emptySettings,
  intakeQuestions,
  missingSettings,
  normalizeSetting,
  settingsComplete,
  styleSentence,
} from './project-settings.js';

/** A saved four-view can be reused only when its frozen input hash matches today's portrait. */
export function quadviewInputMatchesSource(inputs, sourceSha256) {
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceSha256)) return false;
  return (Array.isArray(inputs) ? inputs : [])
    .some((input) => typeof input?.sha256 === 'string' && input.sha256 === sourceSha256);
}

/** `expectedText` is optional; when supplied it guards against a stale external edit. */
export function h3ExpectedTextMatches(currentText, expectedText) {
  return typeof expectedText !== 'string' || sameBlockText(currentText, expectedText);
}

function assetQuadviewRequestId({ supplied, prefix, assetId, variantId, sourceHash }) {
  if (typeof supplied === 'string' && supplied.trim().length > 0) return supplied.trim();
  const nonce = randomUUID().replace(/-/gu, '').slice(0, 12);
  return `${prefix}-${assetId}-${variantId}-${sourceHash.slice(0, 16)}-${nonce}`
    .replace(/[^A-Za-z0-9_-]/gu, '_')
    .slice(0, 120);
}

function stableRequestValue(value) {
  if (Array.isArray(value)) return value.map(stableRequestValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableRequestValue(value[key])]));
}

/**
 * A retry-safe request id for H3 generation.
 *
 * The caller no longer has to invent an opaque id just to get past validation. The id is derived
 * from the exact project, shot, prompt, output settings and ordered reference contents, so:
 *   - repeating the same submission returns the same ledger job;
 *   - editing the prompt or changing a reference produces a deliberate new intent;
 *   - two blocks or two projects cannot collide.
 */
export function h3StableRequestId({
  supplied = null,
  projectRoot,
  file = null,
  shot = null,
  blockNumber = null,
  text,
  seconds,
  settings = {},
  references = [],
} = {}) {
  if (typeof supplied === 'string' && supplied.trim().length > 0) {
    const explicit = supplied.trim();
    if (!/^[\w-]{8,160}$/u.test(explicit)) throw new Error('生成请求编号无效：只能用字母、数字、下划线或连字符，长度 8–160');
    return explicit;
  }
  const material = stableRequestValue({
    projectRoot: String(projectRoot ?? ''),
    file: String(file ?? '').replace(/\\/gu, '/'),
    shotId: shot?.shotId ?? null,
    sourceNumber: shot?.sourceNumber ?? null,
    blockNumber,
    text: String(text ?? ''),
    seconds,
    settings,
    references: (Array.isArray(references) ? references : []).map((entry) => ({
      assetVersionId: entry?.assetVersionId ?? null,
      referenceIndex: entry?.referenceIndex ?? null,
      mediaType: entry?.mediaType ?? 'Picture',
      role: entry?.role ?? null,
      sha256: entry?.sha256 ?? null,
      relativePath: entry?.relativePath ?? null,
      absolutePath: entry?.absolutePath ?? null,
    })),
  });
  const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24);
  return `h3-b${Number.isInteger(blockNumber) ? blockNumber : 'x'}-${digest}`;
}

/** Explain an H3 binding failure with the asset, variant and competing files. */
export function h3ReferenceFailureDetails(resolved = {}, references = []) {
  const lines = [];
  for (const entry of resolved.unresolved ?? []) {
    lines.push(`未解析 ${String(entry?.text ?? entry?.name ?? '(未命名引用)')}：${String(entry?.note ?? '没有可用资产')}`);
  }
  for (const entry of resolved.ambiguous ?? []) {
    const candidates = (entry?.candidateDetails ?? [])
      .map((candidate) => [
        candidate?.assetName,
        candidate?.variantName,
        candidate?.fileName,
      ].filter(Boolean).join(' / '))
      .filter(Boolean);
    lines.push(`存在歧义 ${String(entry?.name ?? entry?.text ?? entry?.note ?? '(同名引用)')}`
      + `：${candidates.length > 0 ? candidates.join('；') : String(entry?.note ?? '请指定资产和变体')}`);
  }
  for (const entry of references ?? []) {
    if (entry?.bindingState === 'resolved') continue;
    lines.push(`未绑定 ${String(entry?.display ?? entry?.assetName ?? entry?.assetVersionId ?? '(素材)')}`
      + `：${String(entry?.assetName ?? '未知资产')} / ${String(entry?.variantName ?? '未知变体')} / ${String(entry?.fileName ?? '无文件')}`);
  }
  return [...new Set(lines)];
}

/**
 * Resolve the 大分镜 number that owns one H3 document.
 *
 * The title, the standard filename and an explicitly supplied number are independent witnesses.
 * If they disagree, proceeding would attribute the video to one 大分镜 and name it after another,
 * so the only safe answer is to refuse before submission. The file-local `index + 1` fallback is
 * retained only for genuinely anonymous, single-document inputs that carry no number at all.
 */
export function resolveH3BlockNumber({ shot = null, index = null, file = null, requested = null } = {}) {
  const candidates = [];
  const add = (value, source) => {
    if (Number.isInteger(value) && value > 0) candidates.push({ value, source });
  };
  add(shot?.sourceNumber, 'H3 标题');
  add(requested, '调用参数');
  add(file?.blockNumber, '文件名');
  const path = typeof file === 'string'
    ? file
    : String(file?.path ?? file?.file ?? '');
  const fromName = Number(/大分镜\s*(\d+)/u.exec(path.replace(/\\/gu, '/').split('/').pop() ?? '')?.[1]);
  add(fromName, '文件名');
  const distinct = [...new Map(candidates.map((entry) => [entry.value, entry])).values()];
  if (distinct.length > 1) {
    throw new Error(`H3 大分镜编号冲突：${distinct.map((entry) => `${entry.source}=${String(entry.value)}`).join('，')}。为避免结果记到别的块，本次没有继续`);
  }
  if (distinct.length === 1) return distinct[0].value;
  if (Number.isInteger(index) && index >= 0) return index + 1;
  throw new Error('无法确认 H3 大分镜编号：标题和文件名都没有“大分镜N”，调用参数也没有 blockNumber');
}

import { projectCodeFor, readableNameFor, resultNameFor } from './result-naming.js';

/** Command name the UI calls; kept here so the client and host cannot disagree. */
export const STORYBOARD_COMMAND = 'storyboard';

/**
 * Whether a paired structural edit can keep existing block numbers aligned when the two
 * documents temporarily have different lengths.
 *
 * Equal counts were easy to check but too strict for the real intermediate state: a video
 * document can already have two new trailing shots while H3 has not caught up yet. Editing an
 * earlier common block is still safe because both files insert/delete at the same numbered
 * anchor. A gap before the last common block is not safe - renumbering would make the next
 * video block correspond to a different H3 block. In that case the caller must reconcile the
 * gap explicitly; this helper only authorizes edits that preserve the existing mapping.
 */
function pairedStructuralAlignment({ mainShots, companionShots, targetNumber, operation }) {
  const numbers = (shots) => shots.map((shot, index) =>
    Number.isInteger(shot?.sourceNumber) ? shot.sourceNumber : index + 1);
  const mainNumbers = numbers(mainShots);
  const companionNumbers = numbers(companionShots);
  const companionSet = new Set(companionNumbers);
  if (companionSet.size !== companionNumbers.length) {
    return 'H3 分镜编号有重复，无法确认对应关系';
  }
  const mainSet = new Set(mainNumbers);
  const extra = companionNumbers.filter((number) => !mainSet.has(number));
  if (extra.length > 0) {
    return `H3 第 ${extra.join('、')} 块在视频提示词中没有对应块`;
  }
  const targetIndex = mainNumbers.indexOf(targetNumber);
  if (targetIndex < 0 || !companionSet.has(targetNumber)) {
    return `视频与 H3 没有同为第 ${String(targetNumber)} 块的分镜`;
  }
  const lastCommon = Math.max(...companionNumbers);
  const missingInRange = operation === 'delete'
    ? mainNumbers.filter((number) => number <= lastCommon && !companionSet.has(number))
    : mainNumbers.slice(targetIndex + 1)
      .filter((number) => number <= lastCommon && !companionSet.has(number));
  if (missingInRange.length > 0) {
    return `视频在第 ${missingInRange.join('、')} 块有内容、H3 缺少对应块；直接${operation === 'delete' ? '删除' : '新增'}会让后续编号错位`;
  }
  return null;
}

/**
 * Snapshot the two physical prompt files and their metadata records before a paired structural
 * edit. The actual writes still go through the shared storyboard reader; this is only a rollback
 * boundary for the case where video succeeds and H3 fails (or the reverse).
 */
async function capturePairedDocuments({ fs, root, getPolicy, director, scoped, files }) {
  const captured = [];
  for (const filePath of [...new Set(files.filter((entry) => typeof entry === 'string' && entry.length > 0))]) {
    const absolutePath = await fs.resolve(filePath, { cwd: root });
    const absoluteHostPath = String(absolutePath?.targetKey ?? absolutePath);
    const projectRelative = director === undefined ? null : relative(director.root, absoluteHostPath);
    if (projectRelative !== null && (projectRelative.startsWith('..') || isAbsolute(projectRelative))) {
      throw new Error(`成对编辑的文件不在同一项目内，未修改任何文件：${filePath}`);
    }
    const existing = await fs.stat(absolutePath).catch(() => undefined);
    captured.push({
      filePath,
      absolutePath,
      absoluteHostPath,
      exists: existing !== undefined,
      text: existing === undefined ? null : await fs.readText(absolutePath),
      // `director` is rooted at the project, while `scoped` is rooted at the session workspace.
      // Using the latter keyed snapshots as `project/剧集/...` and never matched the metadata store's
      // `剧集/...` records, so a rollback reported success while leaving a new revision behind.
      metadataPath: projectRelative === null ? null : projectRelative.replace(/\\/gu, '/'),
    });
  }
  const metadata = director === undefined
    ? []
    : await director.readDocumentSnapshots(captured.map((entry) => entry.metadataPath).filter((entry) => typeof entry === 'string'));
  return { files: captured, metadata };
}

async function restorePairedDocuments(snapshot, { fs, getPolicy, director }) {
  const failures = [];
  for (const file of snapshot.files) {
    try {
      if (file.exists === false) {
        const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
        const checked = typeof fs.checkedTarget === 'function'
          ? await fs.checkedTarget(file.absolutePath, policy)
          : null;
        await rm(String(checked?.targetKey ?? file.absoluteHostPath ?? file.absolutePath), { force: true });
      } else {
        await fs.writeText(file.absolutePath, file.text, undefined, undefined, typeof getPolicy === 'function' ? getPolicy() : undefined);
      }
    } catch (error) {
      failures.push(`${file.exists === false ? '移除新建文件' : '恢复'} ${file.filePath} 失败：${String(error?.message ?? error)}`);
    }
  }
  if (director !== undefined && snapshot.metadata.length > 0) {
    try {
      await director.restoreDocumentSnapshots(snapshot.metadata);
    } catch (error) {
      failures.push(`恢复分镜元数据失败：${String(error?.message ?? error)}`);
    }
  }
  return failures;
}

async function checkedHostPath({ fs, root, getPolicy, filePath }) {
  const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
  const resolved = await fs.resolve(filePath, { cwd: root });
  const checked = typeof fs.checkedTarget === 'function'
    ? await fs.checkedTarget(resolved, policy)
    : null;
  return {
    resolved,
    checked,
    hostPath: String(checked?.targetKey ?? resolved?.targetKey ?? resolved),
  };
}

async function renameCheckedFile({ fs, root, getPolicy, from, to }) {
  const source = await checkedHostPath({ fs, root, getPolicy, filePath: from });
  const destination = await checkedHostPath({ fs, root, getPolicy, filePath: to });
  await rename(source.hostPath, destination.hostPath);
}

async function removeCheckedFile({ fs, root, getPolicy, filePath }) {
  const target = await checkedHostPath({ fs, root, getPolicy, filePath });
  await rm(target.hostPath, { force: true });
}

function renumberSingleH3Heading(text, fromNumber, toNumber) {
  const source = String(text ?? '');
  const patterns = [
    /^(\uFEFF?[^\S\r\n]*【\s*大分镜\s*)(\d+)(\s*】)/u,
    /^(\uFEFF?[^\S\r\n]*#{1,6}\s*大分镜\s*)(\d+)/u,
    /^(\uFEFF?[^\S\r\n]*大分镜\s*)(\d+)([^\S\r\n]*(?:\r?\n|$))/u,
  ];
  for (const pattern of patterns) {
    if (!pattern.test(source)) continue;
    return source.replace(pattern, (match, prefix, digits, suffix = '') => {
      const found = Number(digits);
      if (found !== fromNumber) {
        throw new Error(`H3 大分镜标题是 ${String(found)}，但文件编号是 ${String(fromNumber)}；本次没有新增任何文件`);
      }
      return `${prefix}${String(toNumber)}${suffix}`;
    });
  }
  throw new Error('H3 文件没有可识别的「大分镜 N」标题；本次没有新增任何文件');
}

/**
 * Insert one 大分镜 when H3 is stored as one file per block.
 *
 * The video prompt remains the canonical sequence. After inserting there, every existing H3
 * file from the insertion point onward is renumbered in descending order, its heading is
 * changed to match, and its metadata record moves with it so existing shot ids survive.
 * The new H3 file is then created with a copy of the anchor body or the normal blank H3
 * skeleton. Snapshotting every old and prospective filename makes this one rollback boundary.
 */
async function insertDedicatedH3Shot({
  fs,
  root,
  getPolicy,
  director,
  scoped,
  episode,
  videoSource,
  h3Source,
  locator,
  kind,
  requestedBlockNumber,
}) {
  let videoRead = null;
  let requested = Number.isInteger(requestedBlockNumber) ? requestedBlockNumber : null;
  let insertedAt = requested === null ? null : requested + 1;
  if (insertedAt === null) {
    videoRead = await scoped.readShots(videoSource.path);
    requested = Number.isInteger(locator) ? videoRead.shots[locator]?.sourceNumber : null;
    const anchor = videoRead.shots.find((shot, position) => (
      Number.isInteger(requested)
        ? (shot.sourceNumber ?? position + 1) === requested
        : (typeof locator === 'string' && shot.shotId === locator)
    ));
    if (anchor === undefined) throw new Error('找不到要新增分镜的原块；本次没有新增任何文件');
    requested = Number(anchor.sourceNumber ?? requested);
    insertedAt = requested + 1;
  }
  const h3Files = [...(h3Source.files ?? [])]
    .filter((entry) => Number.isInteger(entry.blockNumber) && entry.blockNumber > 0)
    .sort((left, right) => left.blockNumber - right.blockNumber);
  if (h3Files.length === 0) throw new Error('中文 H3 没有可重排的分镜文件；本次没有新增任何文件');
  const h3Numbers = new Set();
  const documents = [];
  for (const file of h3Files) {
    const number = Number(file.blockNumber);
    if (h3Numbers.has(number)) throw new Error(`中文 H3 有重复的第 ${String(number)} 分镜；本次没有新增任何文件`);
    h3Numbers.add(number);
    const filePath = file.path ?? `${episode.folder}/${file.file}`;
    const expectedName = h3FileName(episode.number, number, 'zh');
    if (basename(filePath.replace(/\\/gu, '/')) !== expectedName) {
      throw new Error(`中文 H3 第 ${String(number)} 分镜不是标准文件名 ${expectedName}；为避免重命名错文件，本次没有新增任何文件`);
    }
    const absolute = await checkedHostPath({ fs, root, getPolicy, filePath });
    const relativePath = director === undefined
      ? null
      : relative(director.root, absolute.hostPath).replace(/\\/gu, '/');
    if (relativePath !== null && (relativePath.startsWith('..') || isAbsolute(relativePath))) {
      throw new Error(`中文 H3 文件不在当前项目内：${filePath}`);
    }
    documents.push({
      ...file,
      path: filePath,
      read: null,
      text: null,
      relativePath,
      metadata: undefined,
    });
  }

  const plannedShifted = documents
    .filter((document) => document.blockNumber >= insertedAt)
    .map((document) => ({
      ...document,
      nextBlockNumber: document.blockNumber + 1,
      nextPath: `${episode.folder}/${h3FileName(episode.number, document.blockNumber + 1, 'zh')}`,
      nextRelativePath: document.relativePath === null
        ? null
        : `${document.relativePath.replace(/\/[^/]*$/u, '')}/${h3FileName(episode.number, document.blockNumber + 1, 'zh')}`,
    }));
  const insertedPath = `${episode.folder}/${h3FileName(episode.number, insertedAt, 'zh')}`;
  const futurePaths = [
    ...plannedShifted.map((document) => document.nextPath),
    insertedPath,
  ];
  const snapshot = await capturePairedDocuments({
    fs,
    root,
    getPolicy,
    director,
    scoped,
    files: [
      videoSource.path,
      ...documents.map((document) => document.path),
      ...futurePaths,
    ],
  });

  let videoResult = null;
  try {
    if (videoRead === null) videoRead = await scoped.readShots(videoSource.path);
    const anchorIndex = videoRead.shots.findIndex((shot, position) => (
      (shot.sourceNumber ?? position + 1) === requested
      || (typeof locator === 'string' && shot.shotId === locator)
    ));
    if (anchorIndex < 0) throw new Error('找不到要新增分镜的原块；本次没有新增任何文件');
    const anchorNumber = Number(videoRead.shots[anchorIndex].sourceNumber ?? anchorIndex + 1);
    if (anchorNumber !== requested) {
      throw new Error(`当前分镜编号是 ${String(anchorNumber)}，不是请求的 ${String(requested)}；本次没有新增任何文件`);
    }
    const videoNumbers = new Set(videoRead.shots.map((shot, position) => shot.sourceNumber ?? position + 1));
    for (const document of documents) {
      if (!videoNumbers.has(document.blockNumber)) {
        throw new Error(`中文 H3 的第 ${String(document.blockNumber)} 分镜在视频提示词中没有对应块；本次没有新增任何文件`);
      }
    }
    const storedDocuments = director === undefined ? [] : (await director.readDocuments()).documents;
    for (const document of documents) {
      const read = await scoped.readShots(document.path);
      const expectedName = h3FileName(episode.number, document.blockNumber, 'zh');
      if (read.shots.length !== 1 || Number(read.shots[0]?.sourceNumber) !== document.blockNumber) {
        throw new Error(`中文 H3 文件 ${expectedName} 不是单分镜文件或标题编号不一致；本次没有新增任何文件`);
      }
      document.read = read;
      document.text = read.text;
      document.metadata = storedDocuments.find((entry) =>
        (entry.shots ?? []).some((shot) => shot.shotId === read.shots[0]?.shotId));
      if (document.metadata !== undefined) document.relativePath = document.metadata.relativePath;
    }
    const shifted = documents
      .filter((document) => document.blockNumber >= insertedAt)
      .sort((left, right) => right.blockNumber - left.blockNumber)
      .map((document) => {
        const planned = plannedShifted.find((entry) => entry.blockNumber === document.blockNumber);
        return {
          ...document,
          nextBlockNumber: planned.nextBlockNumber,
          nextPath: planned.nextPath,
          nextRelativePath: planned.nextRelativePath,
        };
      });
    const targetRevision = videoRead.revision ?? undefined;
    videoResult = await scoped.insertShot(
      videoSource.path,
      anchorIndex,
      kind,
      targetRevision === undefined ? {} : { expectedRevision: targetRevision },
    );
    if (videoResult.shots[insertedAt - 1]?.sourceNumber !== insertedAt) {
      throw new Error(`视频提示词插入后没有形成第 ${String(insertedAt)} 分镜；已回滚`);
    }

    for (const document of shifted) {
      const source = await checkedHostPath({ fs, root, getPolicy, filePath: document.path });
      const destination = await checkedHostPath({ fs, root, getPolicy, filePath: document.nextPath });
      const currentText = await fs.readText(source.resolved);
      if (currentText !== document.text) {
        throw new Error(`中文 H3 文件 ${basename(document.path)} 在编辑期间发生了变化；已回滚`);
      }
      if (await fs.stat(destination.resolved).catch(() => undefined) !== undefined) {
        throw new Error(`重命名目标已存在：${document.nextPath}；已回滚`);
      }
      const nextText = renumberSingleH3Heading(currentText, document.blockNumber, document.nextBlockNumber);
      await renameCheckedFile({ fs, root, getPolicy, from: document.path, to: document.nextPath });
      await fs.writeText(destination.resolved, nextText, undefined, undefined, typeof getPolicy === 'function' ? getPolicy() : undefined);
      if (document.metadata !== undefined && director !== undefined && document.relativePath !== null) {
        await director.moveDocument(document.relativePath, document.nextRelativePath, {
          block: describeBlocks(nextText)[0] ?? null,
          fileHash: hashText(nextText),
          replaceExisting: true,
        });
      }
    }

    const copySource = documents.find((document) => document.blockNumber === anchorNumber);
    let created;
    if (kind === 'copy' && copySource !== undefined) {
      created = await scoped.writeShot(insertedPath, 0, copySource.read.shots[0].text, {
        createIfMissing: true,
        episodeNumber: episode.number,
        blockNumber: insertedAt,
      });
    } else {
      const insertedTarget = await checkedHostPath({ fs, root, getPolicy, filePath: insertedPath });
      await fs.writeText(
        insertedTarget.resolved,
        `【大分镜${String(insertedAt)}】\n`,
        { kind: 'createIfAbsent' },
        undefined,
        typeof getPolicy === 'function' ? getPolicy() : undefined,
      );
      created = { shotId: null, revision: null };
    }
    const createdRead = await scoped.readShots(insertedPath);
    if (kind === 'copy' && copySource !== undefined && copySource.read.shots[0]?.shotId !== undefined
      && createdRead.shots[0]?.shotId !== undefined && director !== undefined) {
      const stored = await director.readDocuments();
      const insertedDocument = stored.documents.find((document) =>
        (document.shots ?? []).some((shot) => shot.shotId === createdRead.shots[0].shotId));
      if (insertedDocument === undefined) throw new Error('新增 H3 后没有找到它的分镜元数据；已回滚');
      await director.copyShotBindings(insertedDocument.relativePath, copySource.read.shots[0].shotId, createdRead.shots[0].shotId);
    }
    return {
      ...videoResult,
      file: videoSource.path,
      blockNumber: insertedAt,
      companion: {
        file: insertedPath,
        virtual: false,
        insertedAt,
        shotId: created.shotId ?? createdRead.shots[0]?.shotId ?? null,
        revision: created.revision ?? createdRead.revision ?? null,
        shots: createdRead.shots,
        shiftedFiles: shifted.map((document) => ({ from: document.path, to: document.nextPath })),
      },
    };
  } catch (error) {
    const rollbackFailures = await restorePairedDocuments(snapshot, { fs, getPolicy, director });
    if (rollbackFailures.length > 0) {
      const rollbackError = new Error(`一镜一文件成对新增失败，且回滚不完整：${rollbackFailures.join('；')}。原始错误：${String(error?.message ?? error)}`);
      rollbackError.code = 'PAIRED_EDIT_ROLLBACK_FAILED';
      rollbackError.cause = error;
      throw rollbackError;
    }
    const rolledBack = new Error(`一镜一文件成对新增失败，已恢复视频提示词、全部 H3 文件和分镜身份：${String(error?.message ?? error)}`);
    rolledBack.code = 'PAIRED_EDIT_ROLLED_BACK';
    rolledBack.cause = error;
    throw rolledBack;
  }
}

/**
 * Delete one 大分镜 when H3 is stored as one file per block.
 *
 * The target H3 file disappears, later files move back by one number and their headings move
 * with them. Existing shot identities stay attached to their documents. File and metadata
 * snapshots cover the deleted target and every renamed path so a failed operation restores the
 * complete pre-delete tree.
 */
async function deleteDedicatedH3Shot({
  fs,
  root,
  getPolicy,
  director,
  scoped,
  episode,
  videoSource,
  h3Source,
  locator,
  requestedBlockNumber,
}) {
  let videoRead = null;
  let requested = Number.isInteger(requestedBlockNumber) ? requestedBlockNumber : null;
  if (requested === null) {
    videoRead = await scoped.readShots(videoSource.path);
    const anchor = videoRead.shots.find((shot, position) => (
      (typeof locator === 'string' && shot.shotId === locator)
      || (Number.isInteger(locator) && position === locator)
    ));
    if (anchor === undefined) throw new Error('找不到要删除的分镜；本次没有删除任何文件');
    requested = Number(anchor.sourceNumber);
  }
  if (!Number.isInteger(requested) || requested < 1) throw new Error('删除分镜需要有效的大分镜编号');

  const h3Files = [...(h3Source.files ?? [])]
    .filter((entry) => Number.isInteger(entry.blockNumber) && entry.blockNumber > 0)
    .sort((left, right) => left.blockNumber - right.blockNumber);
  const documents = [];
  const h3Numbers = new Set();
  for (const file of h3Files) {
    const number = Number(file.blockNumber);
    if (h3Numbers.has(number)) throw new Error(`中文 H3 有重复的第 ${String(number)} 分镜；本次没有删除任何文件`);
    h3Numbers.add(number);
    const filePath = file.path ?? `${episode.folder}/${file.file}`;
    const expectedName = h3FileName(episode.number, number, 'zh');
    if (basename(filePath.replace(/\\/gu, '/')) !== expectedName) {
      throw new Error(`中文 H3 第 ${String(number)} 分镜不是标准文件名 ${expectedName}；为避免删除错文件，本次没有删除任何文件`);
    }
    const absolute = await checkedHostPath({ fs, root, getPolicy, filePath });
    const relativePath = director === undefined
      ? null
      : relative(director.root, absolute.hostPath).replace(/\\/gu, '/');
    if (relativePath !== null && (relativePath.startsWith('..') || isAbsolute(relativePath))) {
      throw new Error(`中文 H3 文件不在当前项目内：${filePath}`);
    }
    documents.push({
      ...file,
      path: filePath,
      relativePath,
      read: null,
      text: null,
      metadata: undefined,
    });
  }
  const shiftedPlan = documents
    .filter((document) => document.blockNumber > requested)
    .map((document) => ({
      blockNumber: document.blockNumber,
      nextBlockNumber: document.blockNumber - 1,
      nextPath: `${episode.folder}/${h3FileName(episode.number, document.blockNumber - 1, 'zh')}`,
      nextRelativePath: document.relativePath === null
        ? null
        : `${document.relativePath.replace(/\/[^/]*$/u, '')}/${h3FileName(episode.number, document.blockNumber - 1, 'zh')}`,
    }));
  const snapshot = await capturePairedDocuments({
    fs,
    root,
    getPolicy,
    director,
    scoped,
    files: [
      videoSource.path,
      ...documents.map((document) => document.path),
      ...shiftedPlan.map((document) => document.nextPath),
    ],
  });

  let videoResult = null;
  try {
    if (videoRead === null) videoRead = await scoped.readShots(videoSource.path);
    const anchorIndex = videoRead.shots.findIndex((shot, position) => (
      (shot.sourceNumber ?? position + 1) === requested
      || (typeof locator === 'string' && shot.shotId === locator)
    ));
    if (anchorIndex < 0) throw new Error('找不到要删除的分镜；本次没有删除任何文件');
    const anchorNumber = Number(videoRead.shots[anchorIndex].sourceNumber ?? anchorIndex + 1);
    if (anchorNumber !== requested) {
      throw new Error(`当前分镜编号是 ${String(anchorNumber)}，不是请求的 ${String(requested)}；本次没有删除任何文件`);
    }
    const videoNumbers = new Set(videoRead.shots.map((shot, position) => shot.sourceNumber ?? position + 1));
    const storedDocuments = director === undefined ? [] : (await director.readDocuments()).documents;
    for (const document of documents) {
      if (!videoNumbers.has(document.blockNumber)) {
        throw new Error(`中文 H3 的第 ${String(document.blockNumber)} 分镜在视频提示词中没有对应块；本次没有删除任何文件`);
      }
      const read = await scoped.readShots(document.path);
      if (read.shots.length !== 1 || Number(read.shots[0]?.sourceNumber) !== document.blockNumber) {
        throw new Error(`中文 H3 文件 ${basename(document.path)} 不是单分镜文件或标题编号不一致；本次没有删除任何文件`);
      }
      document.read = read;
      document.text = read.text;
      document.metadata = storedDocuments.find((entry) =>
        (entry.shots ?? []).some((shot) => shot.shotId === read.shots[0]?.shotId));
      if (document.metadata !== undefined) document.relativePath = document.metadata.relativePath;
    }

    videoResult = await scoped.deleteShot(videoSource.path, anchorIndex, {
      expectedRevision: videoRead.revision ?? undefined,
    });

    const deletedDocument = documents.find((document) => document.blockNumber === requested);
    if (deletedDocument !== undefined) {
      await removeCheckedFile({ fs, root, getPolicy, filePath: deletedDocument.path });
      if (deletedDocument.relativePath !== null && director !== undefined) {
        await director.removeDocument(deletedDocument.relativePath);
      }
    }

    const shifted = documents
      .filter((document) => document.blockNumber > requested)
      .sort((left, right) => left.blockNumber - right.blockNumber)
      .map((document) => {
        const planned = shiftedPlan.find((entry) => entry.blockNumber === document.blockNumber);
        return {
          ...document,
          nextBlockNumber: planned.nextBlockNumber,
          nextPath: planned.nextPath,
          nextRelativePath: planned.nextRelativePath,
        };
      });
    for (const document of shifted) {
      const source = await checkedHostPath({ fs, root, getPolicy, filePath: document.path });
      const destination = await checkedHostPath({ fs, root, getPolicy, filePath: document.nextPath });
      const currentText = await fs.readText(source.resolved);
      if (currentText !== document.text) {
        throw new Error(`中文 H3 文件 ${basename(document.path)} 在编辑期间发生了变化；已回滚`);
      }
      if (await fs.stat(destination.resolved).catch(() => undefined) !== undefined) {
        throw new Error(`重命名目标已存在：${document.nextPath}；已回滚`);
      }
      const nextText = renumberSingleH3Heading(currentText, document.blockNumber, document.nextBlockNumber);
      await renameCheckedFile({ fs, root, getPolicy, from: document.path, to: document.nextPath });
      await fs.writeText(destination.resolved, nextText, undefined, undefined, typeof getPolicy === 'function' ? getPolicy() : undefined);
      if (document.metadata !== undefined && director !== undefined && document.relativePath !== null) {
        await director.moveDocument(document.relativePath, document.nextRelativePath, {
          block: describeBlocks(nextText)[0] ?? null,
          fileHash: hashText(nextText),
          replaceExisting: true,
        });
      }
    }

    return {
      ...videoResult,
      file: videoSource.path,
      blockNumber: requested,
      companion: {
        file: deletedDocument?.path ?? null,
        virtual: false,
        deleted: true,
        deletedAt: requested,
        shots: [],
        shiftedFiles: shifted.map((document) => ({ from: document.path, to: document.nextPath })),
      },
    };
  } catch (error) {
    const rollbackFailures = await restorePairedDocuments(snapshot, { fs, getPolicy, director });
    if (rollbackFailures.length > 0) {
      const rollbackError = new Error(`一镜一文件成对删除失败，且回滚不完整：${rollbackFailures.join('；')}。原始错误：${String(error?.message ?? error)}`);
      rollbackError.code = 'PAIRED_EDIT_ROLLBACK_FAILED';
      rollbackError.cause = error;
      throw rollbackError;
    }
    const rolledBack = new Error(`一镜一文件成对删除失败，已恢复视频提示词、全部 H3 文件和分镜身份：${String(error?.message ?? error)}`);
    rolledBack.code = 'PAIRED_EDIT_ROLLED_BACK';
    rolledBack.cause = error;
    throw rolledBack;
  }
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker(),
  ));
  return results;
}

function modelRouteFor(session) {
  try {
    return session?.requestHeader?.()?.config ?? null;
  } catch {
    return null;
  }
}

/**
 * HTTP path the 分镜管理 panel sends its reads and writes to.
 *
 * The command channel is a USER-facing surface, not a private one. Every call through
 * `remote.commands.execute` is admitted by `@deepseek-ai/dsh-commands`, which appends
 * `command/run` and `command/done` to the session log BEFORE the handler runs - and the Web
 * client renders that pair as a card in the conversation. For a person typing `/storyboard`
 * that card is the point. For the panel, which calls the Host dozens of times just by being
 * open, it is noise: a measured session carried 180 such pairs, 108 KB of request text (the
 * whole 大分镜 body, since a write names the text it is saving) and 125 KB of JSON answers.
 *
 * `recordInput: false` removes only the request half. A panel therefore needs a channel that
 * is private by construction, which is what this route is: `webServer.register` is the one
 * other client-callable surface this profile exposes, it already backs the panel's images,
 * and traffic on it never touches the session log.
 *
 * The panel still calls the tool by name through this route, so there is exactly one
 * implementation of every action and the two channels cannot drift.
 */
export const PANEL_PREFIX = '/short-drama/panel';

/**
 * Which directory to list projects from.
 *
 * The caller's choice wins. Failing that, the fixed design root - the folder the
 * pipeline's first step creates projects in, and the one the user expects to see - but
 * only when it exists, because a default pointing at nothing shows an empty list that is
 * indistinguishable from a bug. The session workspace is the last resort, since it always
 * exists.
 *
 * The sandbox fences mutations only: `listDir`, `stat` and `readText` take no policy, so
 * a directory outside the session workspace is still readable. The earlier "reads are
 * denied outside the workspace" theory came from a probe that included a write, on a
 * build that was itself stale. It was wrong.
 */
function projectsRoot({ explicit, workspace, drive } = {}) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const design = designRoot({ drive }).root;
  if (existsSync(design)) return design;
  if (typeof workspace === 'string' && workspace.trim().length > 0) return workspace.trim();
  return design;
}

/**
 * The message the panel's confirmed 重新拆分镜 action hands to the session's director.
 *
 * The panel cannot run the writing skill itself: the conversion needs the model, the scene
 * images, the asset library and the file tools. Enqueuing one explicit user turn keeps that
 * work in the agent that already owns those capabilities, while the panel only records the
 * user's confirmed choice.
 */
function resplitInstruction({ projectRoot, episodeNumber, scriptPath, targetPath, promptSource, currentVideoFiles }) {
  const existing = currentVideoFiles.length === 0
    ? '- （当前没有已存在的视频提示词文件）'
    : currentVideoFiles.map((file) => `- ${file}`).join('\n');
  return [
    '分镜管理面板发起了“重新拆分镜”。用户已经二次确认覆盖本集视频提示词。',
    '',
    `项目根目录：${projectRoot}`,
    `本集：第${episodeNumber}集`,
    `本集剧本：${scriptPath}`,
    `目标主文件：${targetPath}`,
    `使用提示词模板：${promptSource.label}`,
    `权威提示词文件：${promptSource.file}`,
    '',
    '当前已存在的视频提示词文件：',
    existing,
    '',
    '请现在执行：',
    '1. 完整读取全局配置指定的权威提示词文件，使用 drama-episode-video-prompts 技能；不要询问版本，不要混用其他版本。',
    `2. 读取本集剧本、场景图和项目资产，按该提示词把第${episodeNumber}集重新拆成分镜并生成《直出视频提示词》。`,
    `3. 写入 ${targetPath}，允许覆盖同名目标文件。`,
    `4. 写完后不要用 split-episode 只按标题机械切块；调用 storyboard action=model-parse project=${projectRoot} episodeNumber=${episodeNumber} file=${targetPath} task=split，让模型完整读取生成的视频提示词，重新判断并分配大分镜块。即使用户模板没有输出【大分镜N】，也必须由模型补出正确边界。`,
    '5. 只重做视频提示词和分大镜文件，不修改 H3 提示词，不调用 comfy_run，不启动 GPU 生成。',
    '6. 如果发现目标文件正在被用户编辑或存在未保存草稿，先停止并提示用户，不要覆盖。',
    '完成后用一两句话报告：使用的提示词版本、写入的文件、分出了几个大分镜。',
  ].join('\n');
}

/**
 * Hand one focused review to the same director that owns the conversation.
 *
 * This is a read-only request. The panel has already selected the exact source/shot, so the
 * director does not need to re-interpret the user's "this shot" and does not get permission to
 * rewrite files or spend GPU time.
 */
function reviewShotInstruction({ projectRoot, episodeNumber, sourceId, file, shotId, blockNumber }) {
  return [
    '分镜管理面板请求：导演检查当前镜头。',
    '',
    `项目根目录：${projectRoot}`,
    `本集：第${episodeNumber}集`,
    `提示词来源：${sourceId}`,
    `文件：${file}`,
    `大分镜：${blockNumber ?? '未编号'}`,
    `稳定镜头 ID：${shotId ?? '该项目尚未分配'}`,
    '',
    '请只读检查这一镜，不要修改文件，不要调用 comfy_run，不要启动 GPU 生成。',
    '重点看：画面与动作是否可执行，人物/场景/道具引用是否完整，站位与连续性是否有冲突，时长与镜头数量是否匹配，台词是否来自剧本。',
    '结尾给 2–4 条按重要性排序的具体改法；没有问题时明确说“这一镜可以生成”。',
  ].join('\n');
}

function inventoryParseInstruction({ projectRoot, scriptPath }) {
  return [
    '分镜管理面板新建了一个空白短剧项目，并上传了剧本。',
    '',
    `项目根目录：${projectRoot}`,
    `剧本文件：${scriptPath}`,
    '',
    '请只完成资产盘点：',
    '1. 使用 drama-asset-inventory 技能完整读取剧本。',
    '2. 把人物、场景、道具整理成资产盘点稿，写入 资产/资产盘点稿/资产盘点稿.md。',
    '3. 只保留资产名称、简介、变体与必要连续性信息；不要生成资产图片，不要写资产提示词，不要拆分镜。',
    `4. 完成后调用 storyboard action=assets project="${projectRoot}" assetAction=refresh，让资产库出现这些仅含名称的资产。`,
    '5. 不调用 comfy_run，不启动 GPU。',
    '完成后用一两句话报告识别出多少人物、场景和道具。',
  ].join('\n');
}

/** Read the bundled four-view prompt, which is the same one the director skill uses. */
async function readFourViewPrompt(config) {
  const skillDir = typeof config?.skillDir === 'string' && config.skillDir.length > 0
    ? config.skillDir
    : fileURLToPath(new URL('../skills/', import.meta.url));
  return await readFile(join(skillDir, 'costume-and-quadview', 'references', '四视图.txt'), 'utf8');
}

/**
 * Run one storyboard operation. Shared by the command and the tool.
 *
 * @param context.getPolicy - resolves the sandbox policy for this call. Writes are fenced
 *   by it, so it must be the CALLER's policy: without one the filesystem falls back to the
 *   deployment default, whose writable root does not contain the project folder, and every
 *   save is refused.
 */
export async function runStoryboardAction({ action, payload = {} }, context) {
  const { fs, root, registry, getPolicy, media = null, config = null, ctx = null, modelRoute = null, signal, onModeChange, runWorkflow, generateVideo } = context;
  if (fs === undefined || fs === null) throw new Error('the filesystem service is unavailable in this profile');
  if (action === 'panel-generate') {
    if (payload.generationAction === 'history') {
      return await listGeneralGenerationHistory({
        fs,
        root,
        media,
        config,
        getPolicy,
        signal,
        sessionId: context.sessionId ?? null,
      });
    }
    return await runGeneralGeneration(payload, {
      fs,
      root,
      media,
      config,
      getPolicy,
      signal,
      sessionId: context.sessionId ?? null,
      ctx,
      modelRoute,
      runWorkflow,
      generateVideo,
    });
  }
  const directorContext = async () => {
    const { state } = await readState();
    return {
      mode: state.mode,
      activeProject: state.activeProject ?? null,
      activeContext: state.activeContext ?? null,
    };
  };
  /**
   * The project's directory, from either a name under the projects root or an absolute path.
   *
   * `project` used to be joined onto the projects root unconditionally, so a project that lives
   * anywhere else was joined a second time, producing a malformed path and an ENOENT. A project
   * outside the root is a normal case (the panel can browse anywhere), so an absolute path is
   * honoured as given.
   */
  const projectRootFor = (name) => (isAbsolute(name) ? name : join(root, name));
  const assertProjectWritable = (projectRoot) => {
    const access = describeWriteAccess(typeof getPolicy === 'function' ? getPolicy() : undefined, projectRoot);
    if (access.writable === true) return;
    const error = new Error(access.reason === 'read-only'
      ? '当前会话是只读权限，不能创建项目或集数'
      : access.reason === 'outside-workspace'
        ? `项目目录不在当前会话工作区内：${projectRoot}。请切换到完全权限，或从项目目录所在工作区打开会话`
        : '无法确认当前会话的写权限，项目没有创建');
    error.code = 'FS_SANDBOX_DENIED';
    throw error;
  };
  /**
   * Does a recorded prompt file match what the caller named?
   *
   * Paths arrive spelled differently for the same file - an absolute path, a project-relative
   * path, forward slashes instead of backslashes - and the old `file.path === payload.file`
   * rejected every spelling except the one the plugin happened to build internally. The user-facing
   * symptom was 「此 H3 文件不属于当前项目」 for a file that plainly did, which reads as a wrong
   * project rather than a wrong string comparison.
   *
   * Compared by normalising separators and then by suffix, so `剧集/第1集/x.txt`,
   * `<root>/剧集/第1集/x.txt` and `D:\...\剧集\第1集\x.txt` are the same file. A suffix match is
   * safe here because the per-episode folder name is part of the path.
   */
  const samePath = (recorded, named) => {
    if (typeof recorded !== 'string' || typeof named !== 'string') return false;
    const normalize = (value) => value.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/^\.\//u, '').toLowerCase();
    const left = normalize(recorded);
    const right = normalize(named);
    if (left === right) return true;
    return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  };
  const fileMatches = (fileList, named) => (fileList ?? []).some((file) => samePath(file.path, named) || samePath(file.file, named));
  // The metadata store is bound to a PROJECT root, while the caller names paths relative to
  // the projects root. The project is always the first path segment, so it is derived from
  // the path rather than passed alongside it - one source of truth, and no way for a shotId
  // lookup to be answered by a different project's metadata.
  const directorForPath = (filePath, project) => {
    let name = typeof project === 'string' && project.trim().length > 0 ? project.trim() : null;
    if (name === null && typeof filePath === 'string') {
      const clean = filePath.replace(/\\/gu, '/');
      // An absolute episode file has no project name in its first segment: `D:` is a drive,
      // not a project under the session root. Use the marker every short-drama project has
      // instead, so a first save can resolve the shot id before the caller learns to send
      // `project` explicitly. Falling back to the old first-segment rule then binds `D:` as a
      // directory below the session root, which always looks like an unmigrated project.
      const episodeMarker = '/剧集/';
      const markerIndex = clean.toLowerCase().indexOf(episodeMarker.toLowerCase());
      if (isAbsolute(filePath) && markerIndex > 0) {
        name = clean.slice(0, markerIndex);
      } else {
        const first = clean.split('/').filter((part) => part.length > 0)[0];
        if (first !== undefined) name = first;
      }
    }
    if (name !== null && isAbsolute(name)) {
      // An explicit absolute project: the store is bound to it and no first-segment guessing.
      return { director: createDirectorStore(fs, name, getPolicy), projectRoot: name };
    }
    if (name === null || name.includes('/')) return { director: undefined, projectRoot: null };
    return { director: createDirectorStore(fs, join(root, name), getPolicy), projectRoot: join(root, name) };
  };
  const reader = createReader(fs, root, getPolicy);
  /**
   * The 画风 the user chose at the start of this production.
   *
   * `【画面风格和类型】` is the first line of every 大分镜, and what goes in it is a PROJECT decision
   * asked once at intake (真人 / 3D动漫 / 动画 / 其他) - not something each file reinvents. Compiling and
   * splitting took a `style` argument that nothing passed, so a project whose source file had no
   * style line produced blocks with no style line at all: a block copied out on its own then said
   * nothing about what the film looks like.
   */
  /**
   * The instruction for "let the MODEL parse this document".
   *
    * Two jobs need judgement rather than a regex: finding the block boundaries in a prompt whose headings
    * the code has never seen (段落 / 场次 / anything a user uploads next), and binding each block's
   * 人物/场景/道具 to names that actually exist in the library. A heading dialect hardcoded into the parser
   * only works until the next format arrives, and a mapping written against a name the library does not
   * hold becomes an `@` that cannot resolve - so the model reads, decides, and writes; the code only
   * validates what came back.
   */
  const modelParseInstruction = ({ projectRoot, episodeNumber, sourceFile, episodeFolder, task }) => {
    const goal = task === 'h3'
      ? [
        '先调用 `storyboard action=compile-h3 project=<项目> file=<本集视频提示词> language=zh` 取得映射骨架；不要用 `write=true` 覆盖已有 H3。只有编译器明确报告结构不认识时才按下面的规则手工转换。',
        '把本集每个大分镜的视频提示词转成中文 H3 提示词，不再生成或翻译英文稿，每块一个文件。',
        'H3 推荐使用 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music 这些字段；字段缺失或顺序不同不能阻止生成，按用户现有正文提交。',
        'detailed_description 只写镜头本身的白话描述，禁止把【人物映射】【光线与色温设定】【场景索引】【镜次序列】【固定尾声明】【段落N】这些结构行带进去；台词按原语言完整保留，并写成 <d>[原语言] …</d>。',
        '【初始站位】里的每条事实必须同步转换进 detailed_description，并放在 [Shot 1] 之前：每个人/物的画面左右、正背朝向、面对谁、彼此相对位置、进出场关系，以及原文明确写出的轴线规则。资产名换成对应的 <Subject N>，但不得只保留一句轴线说明，也不得省略站位条目。',
        '音色参考必须写成 `<Audio N> 是 <Subject N> (Sx) 的音色参考`，并在对应说话镜头里再次写“沿用 <Audio N> 的音色”；不要只写文件名或泛泛的“声音参考”。',
        '【参考音频映射】中的 `谢妄（声音参考: @音频文件）`，括号前的谢妄是声音所属人物，`@` 后是音频文件；不得把文件 mention 当成人物，也不得丢掉所属人物。',
      ]
      : [
        '完整读取最新的本集《直出视频提示词》。现有【大分镜N】、【段落N】、【场次N】或其他标题只能作为参考，不是必须保留的身份；如果标题缺失、数量明显不对或边界不合理，你要根据剧情节点重新分配大分镜块。',
        '重新分段必须满足：每个大分镜 1–4 个镜头、总时长不超过 15 秒；优先在完整句、语义转折、关键动作、听者反应或场景转换处切分；不得为了减少块数合并内容，也不得漏掉任何人物、台词、动作、站位、声音或转场。',
        '不要因为原文没有【大分镜N】就把整集压成一个块。只有内容确实只够一个不超过 15 秒、1–4 个镜头的段落时，才允许输出一个大分镜。',
        '你负责“分配分镜块”，代码随后只负责校验和落盘。每块写成 `第N集大分镜K视频提示词.txt`，文件开头必须有规范【大分镜K】，并保留该块完整正文。',
        '每个分块文件开头必须依次有【人物映射】【场景映射】【道具映射】，名字**只能取自本集资产库**，并写成 `@资产名`；本块没有的道具整段省略，不要写空映射。',
        '资产库里没有的名字不要写进映射（例如剧本里的「前台」只有台词、没有资产），否则那个 `@` 永远解析不到。',
      ];
    return [
      `分镜管理面板发起了一项需要模型判断的任务（${task === 'h3' ? '非标准格式的 H3 模型转换兜底' : '重新拆分镜'}）。`,
      '',
      `项目根目录：${projectRoot}`,
      `本集：第${episodeNumber}集`,
      `来源文件：${sourceFile}`,
      `本集目录：${episodeFolder}`,
      '',
      '请现在执行：',
      ...goal.map((item, index) => `${String(index + 1)}. ${item}`),
      `${String(goal.length + 1)}. 先读来源文件的全文再动手；分块边界由你判断，不要依赖固定标题。`,
      `${String(goal.length + 2)}. 只写视频提示词 / H3 提示词文件，不调用 comfy_run，不启动 GPU 生成。`,
      '完成后用一两句话报告：识别出几个分块、写了哪些文件、每个分块的映射分别绑定到哪些资产。',
    ].join('\n');
  };

  const projectStyleSentence = async (project) => {
    if (typeof project !== 'string' || project.trim().length === 0) return null;
    const { projectRoot } = directorForPath(null, project);
    if (projectRoot === null || projectRoot === undefined) return null;
    const record = await createDirectorStore(fs, projectRoot, getPolicy).readProject().catch(() => undefined);
    return styleSentence(record?.settings ?? null) ?? null;
  };
  /**
   * Every name and alias in the project's asset library, as a Set.
   *
   * Used to decide whether a `初始位置参考：@X` names a real file: a name that is not in here becomes
   * plain prose instead of a reference that binds to nothing.
   */
  const assetNameSet = async (project) => {
    if (typeof project !== 'string' || project.trim().length === 0) return null;
    const { projectRoot } = directorForPath(null, project);
    if (projectRoot === null || projectRoot === undefined) return null;
    try {
      const library = createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy));
      const assets = (await library.load()).assets ?? [];
      const names = new Set();
      for (const asset of assets) {
        if (typeof asset.name === 'string') names.add(asset.name);
        for (const alias of asset.aliases ?? []) if (typeof alias === 'string') names.add(alias);
        // Costume and state variants are addressable references in their own right
        // (`@林晚（家居服）`); they are not separate assets, but their full names must
        // pass the known-name check or a valid functional reference becomes prose.
        for (const variant of asset.variants ?? []) {
          const variantName = typeof variant.name === 'string' ? variant.name.trim() : '';
          if (variantName.length === 0) continue;
          names.add(`${asset.name}（${variantName}）`);
        }
      }
      return names;
    } catch {
      // A library that cannot be read must not block a compile: no names means no filtering.
      return null;
    }
  };
  switch (action) {
    case 'global-config': {
      const configAction = ['save', 'upload-prompt', 'delete-prompt', 'read-prompt-sources', 'select-prompt', 'inspect-video-workflow'].includes(payload.configAction)
        ? payload.configAction
        : 'read';
      const configProbe = payload.configProbe !== false;
      if (configAction === 'inspect-video-workflow') {
        const inspection = await inspectVideoWorkflowConfiguration(config ?? {}, {
          workflow: payload.videoWorkflow,
          kind: payload.videoEnvironmentKind,
          signal,
          probe: configProbe,
        });
        return {
          configAction,
          videoInspection: inspection,
          saved: false,
        };
      }
      if (configAction === 'read-prompt-sources') {
        return {
          configAction,
          promptSources: await readPromptSourceConfiguration({ skillDir: config?.skillDir }),
          saved: false,
        };
      }
      if (configAction === 'select-prompt') {
        const selected = await selectPromptSource(payload.promptSourceId, { skillDir: config?.skillDir });
        return {
          configAction,
          promptSources: selected.config,
          promptSource: {
            selected: selected.selected,
            label: selected.label,
            file: selected.file,
          },
          saved: true,
        };
      }
      if (configAction === 'upload-prompt') {
        const uploaded = await savePromptSourceUpload({
          fileName: payload.fileName,
          fileDataBase64: payload.fileDataBase64,
          text: payload.text,
          skillDir: config?.skillDir,
        });
        return {
          configAction,
          promptSources: uploaded.config,
          promptSource: {
            selected: uploaded.entry.id,
            label: uploaded.entry.label,
            file: uploaded.entry.file,
          },
          saved: true,
        };
      }
      if (configAction === 'delete-prompt') {
        const removed = await deletePromptSource(payload.promptSourceId, { skillDir: config?.skillDir });
        return {
          configAction,
          promptSources: removed.config,
          deleted: removed.deleted,
          saved: true,
        };
      }
      if (configAction === 'save') {
        const saved = await saveGenerationConfiguration(config ?? {}, payload.generationConfig ?? {}, { signal, probe: configProbe });
        return {
          configAction,
          globalConfig: saved.config,
          promptSources: saved.config.promptSources,
          promptSource: saved.promptSource,
          saved: true,
          workflows: saved.workflows,
          backups: saved.backups,
          writeModes: saved.writeModes,
        };
      }
      {
        const globalConfig = await readGenerationConfiguration(config ?? {}, { signal, probe: configProbe });
        return {
          configAction,
          globalConfig,
          promptSources: globalConfig.promptSources,
          saved: false,
        };
      }
    }
    case 'media-preview': {
      const path = media?.resolveHandle(payload.handle);
      if (!path || !await media.insideRealRoots(path)) throw new Error('图片引用已失效或超出项目范围，请刷新资产');
      const type = mediaTypeFor(path);
      /**
       * Video and audio go through the same channel as images - they used to be refused here.
       *
       * The gate read `if (!type?.startsWith('image/')) throw new Error('此预览通道仅支持图片')`, so every
       * `<video>` the panel built got a rejected source and the preview area stayed empty with no visible
       * reason. Everything else was already in place: `mediaTypeFor` maps `.mp4 -> video/mp4`, handles are
       * minted for result files of any kind, and the client renders `<video src=…>` - only this check said no.
       *
       * The answer is a data URL, so size is the real constraint (base64 inflates by ~4/3). The cap is raised
       * for moving media, and an over-size file gets a message naming the file instead of failing silently.
       */
      const isMoving = typeof type === 'string' && (type.startsWith('video/') || type.startsWith('audio/'));
      const isImage = typeof type === 'string' && type.startsWith('image/');
      if (!isImage && !isMoving) throw new Error('这个文件类型无法预览');
      // Full-resolution scene sheets are routinely 10-15 MB, and the old 12 MB image cap made
      // the only sharp view of those assets fail while the 56 px thumbnail still looked fine.
      // The detail/lightbox requests one image at a time, so allow a bounded full-size read.
      const cap = isMoving ? 32 * 1024 * 1024 : 64 * 1024 * 1024;
      const stat = await fs.stat(await fs.resolve(path)).catch(() => null);
      const size = stat?.size ?? 0;
      if (size > cap) {
        throw new Error(`这个文件 ${(size / 1024 / 1024).toFixed(1)}MB，超过内嵌预览上限 ${(cap / 1024 / 1024).toFixed(0)}MB；请用系统播放器打开：${path}`);
      }
      const bytes = await fs.readBytes(await fs.resolve(path), undefined, cap);
      return { dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`, mediaType: type };
    }
    case 'sync-h3': {
      const episodes = await reader.listEpisodes(payload.project);
      const requestedEpisode = Number.isInteger(payload.episodeNumber) ? payload.episodeNumber : null;
      const episode = requestedEpisode === null
        ? episodes.find((entry) => entry.sources.some((source) => fileMatches(source.files, payload.file)))
        : episodes.find((entry) => entry.number === requestedEpisode);
      if (!episode) throw new Error('找不到当前 H3 或视频提示词所属的剧集；请传 episodeNumber');
      const requestedSource = episode.sources.find((source) => fileMatches(source.files, payload.file));
      const fileBlock = Number(/大分镜\s*(\d+)/u.exec(String(payload.file).replace(/\\/gu, '/').split('/').pop() ?? '')?.[1]);
      const requestedBlock = Number.isInteger(payload.blockNumber) && payload.blockNumber > 0
        ? payload.blockNumber
        : (Number.isInteger(fileBlock) && fileBlock > 0 ? fileBlock : null);
      let blockNumber = requestedBlock;
      if (blockNumber === null && requestedSource?.id?.startsWith('h3')) {
        const matchedFile = (requestedSource.files ?? []).find((file) => fileMatches([file], payload.file));
        if (Number.isInteger(matchedFile?.blockNumber) && matchedFile.blockNumber > 0) {
          blockNumber = matchedFile.blockNumber;
        }
      }
      if (blockNumber === null && requestedSource?.id === 'video') {
        const video = episode.sources.find((source) => source.id === 'video');
        const available = await runStoryboardAction({
          action: 'episode-blocks',
          payload: { project: payload.project, file: video.path, organise: false },
        }, context);
        if (available.blocks.length === 1) blockNumber = available.blocks[0].blockNumber;
      }
      if (blockNumber === null) {
        throw new Error('一键同步需要知道大分镜编号：请传 blockNumber，或使用文件名带“大分镜N”的 H3 文件');
      }

      const expectedName = h3FileName(episode.number, blockNumber, 'zh');
      let target;
      if (requestedSource?.id?.startsWith('h3')) {
        const requestedFile = (requestedSource.files ?? []).find((file) => fileMatches([file], payload.file));
        target = {
          ...requestedSource,
          file: requestedFile?.file ?? requestedSource.file,
          path: requestedFile?.path ?? requestedSource.path,
        };
      }
      if (target === undefined) {
        // Accept BOTH the H3 target and the source video prompt. The old case demanded an H3
        // file first, so an agent holding the video prompt was told "only H3 is supported",
        // even though that video prompt is exactly what sync reads.
        const h3Source = episode.sources.find((source) => source.id === 'h3-zh');
        const existing = (h3Source?.files ?? []).find((file) => file.blockNumber === blockNumber);
        if (existing !== undefined) {
          target = {
            ...h3Source,
            file: existing.file,
            path: existing.path ?? `${episode.folder}/${existing.file}`,
          };
        }
      }
      if (target === undefined) {
        // The H3 tab exists before its first file does. Its card already names the standard
        // Chinese target, so sync must convert the latest video block without requiring an
        // empty placeholder file on disk. The subsequent panel write creates that file.
        const actualName = String(payload.file).replace(/\\/gu, '/').split('/').pop() ?? '';
        const isExpectedMissingTarget = actualName === expectedName
          && samePath(payload.file, `${episode.folder}/${expectedName}`);
        const episodeVideo = episode.sources.find((source) => source.id === 'video');
        const isVideoSource = requestedSource?.id === 'video'
          || fileMatches(episodeVideo?.files, payload.file)
          || (actualName.length > 0
            && actualName === String(episodeVideo?.path ?? episodeVideo?.file ?? '').replace(/\\/gu, '/').split('/').pop())
          || /^第\d+集视频提示词(?:-大分镜\d+)?\.txt$/u.test(actualName);
        if (!isVideoSource && !isExpectedMissingTarget) {
          throw new Error(`一键同步的目标不是本集标准中文 H3 文件：${expectedName}。收到的是「${actualName}」，来源类型 ${String(requestedSource?.id ?? '未识别')}`);
        }
        target = {
          id: 'h3-zh',
          label: 'H3',
          file: expectedName,
          path: `${episode.folder}/${expectedName}`,
          files: [{ file: expectedName, path: `${episode.folder}/${expectedName}`, blockNumber }],
        };
      }
      if (!target?.id?.startsWith('h3')) throw new Error('一键同步仅适用于 H3 提示词');
      if (requestedEpisode !== null && episode.number !== requestedEpisode) {
        throw new Error('H3 目标与当前集数不一致，本次没有同步');
      }

      if (target.id === 'h3-en') {
        throw new Error('H3 英文功能已停用。请打开中文 H3 使用「一键同步」；已有英文文件不会删除');
      }

      const video = episode.sources.find((source) => source.id === 'video');
      if (!video) throw new Error('本集没有视频提示词，无法同步');
      const blocks = await runStoryboardAction({ action: 'episode-blocks', payload: { project: payload.project, file: video.path, organise: false } }, context);
      const block = blocks.blocks.find((entry) => entry.blockNumber === blockNumber);
      if (!block) throw new Error(`视频提示词中没有大分镜 ${blockNumber}，已保留原 H3 内容`);
      const source = await reader.readShots(block.file);
      const mediaTypes = Object.fromEntries((block.references ?? []).filter((entry) => entry.fileName).map((entry) => [entry.assetName, mediaTypeFor(entry.fileName)?.startsWith('audio/') ? 'Audio' : mediaTypeFor(entry.fileName)?.startsWith('video/') ? 'Video' : 'Picture']));
      const compiled = compileEpisodeToH3(source.text, { language: 'zh', mediaTypes });
      const prompt = compiled.prompts[block.index];
      if (!prompt) throw new Error('无法确认视频提示词与当前大分镜的对应关系');
      // The metadata store is project-scoped. The outer `reader` is rooted at the session
      // workspace and therefore cannot see this document's recorded H3 slots. Reading with it
      // made the source-authoritative rebuild correct while `discardedReferenceSlots` stayed
      // empty, so the panel could not tell the user which old assets the latest video prompt
      // had removed. Read through the project-bound reader; the H3 file is still only read.
      const targetPath = target.path ?? `${episode.folder}/${target.file}`;
      const { director: h3Director } = directorForPath(targetPath, payload.project);
      const h3Reader = createReader(fs, root, getPolicy, { director: h3Director });
      const targetStat = await fs.stat(await fs.resolve(targetPath, { cwd: root })).catch(() => undefined);
      const currentH3 = targetStat === undefined ? null : await h3Reader.readShots(targetPath);
      const currentBlock = currentH3 === null ? null
        : (currentH3.shots.find((shot) => shot.sourceNumber === blockNumber)
          ?? currentH3.shots[blockNumber - 1]
          ?? null);
      const currentText = String(currentBlock?.text ?? '');

      /**
       * Source-authoritative rebuild. The latest video prompt decides which files belong to this
       * block and what each picture is FOR. An old H3 slot is not proof that it still belongs:
       * blindly carrying it is how duplicate 天机榜 pictures and a stale reference video survived.
       */
      const normalize = (value) => String(value ?? '')
        .trim()
        .replace(/^@/u, '')
        .replace(/\.[^.]+$/u, '')
        .replace(/\s+/gu, ' ')
        .toLowerCase();
      const refMediaType = (entry) => {
        if (entry.mediaType === 'Audio' || entry.mediaType === 'Video' || entry.mediaType === 'Picture') return entry.mediaType;
        if (entry.assetKind === 'reference-audio') return 'Audio';
        if (entry.assetKind === 'reference-video') return 'Video';
        return mediaTypeFor(entry.fileName ?? '')?.startsWith('audio/') ? 'Audio'
          : mediaTypeFor(entry.fileName ?? '')?.startsWith('video/') ? 'Video'
            : 'Picture';
      };
      const sourceReferences = [];
      const sourceReferenceKeys = new Set();
      for (const entry of (Array.isArray(block.references) ? block.references : [])
        .filter((candidate) => candidate !== null && typeof candidate === 'object')) {
        const identity = referenceFileIdentity(entry);
        if (sourceReferenceKeys.has(identity)) continue;
        sourceReferenceKeys.add(identity);
        sourceReferences.push(entry);
      }
      const sourceProblems = [];
      for (const entry of [
        ...sourceReferences.filter((entry) => entry.bindingState !== 'resolved' || typeof entry.assetVersionId !== 'string'),
        ...(Array.isArray(block.unresolved) ? block.unresolved : []),
        ...(Array.isArray(block.ambiguous) ? block.ambiguous : []),
      ]) {
        const name = entry?.assetName ?? entry?.name ?? entry?.display ?? entry?.text ?? '未命名素材';
        const state = entry?.bindingState ?? (entry?.note?.includes('多个') ? 'ambiguous' : 'unresolved');
        const key = `${String(name)}:${String(state)}`;
        if (sourceProblems.some((problem) => problem.key === key)) continue;
        sourceProblems.push({ key, name, state, note: entry?.note ?? null });
      }
      if (sourceProblems.length > 0) {
        const detail = sourceProblems.map((problem) => `${problem.name}（${problem.state}${problem.note === null ? '' : `：${problem.note}`}）`).join('；');
        const error = new Error(`当前视频提示词资产栏有未完成绑定：${detail}。为避免同步后少资产，本次没有生成 H3，原文件已保留；请先修正视频提示词资产栏再同步`);
        error.code = 'H3_SOURCE_REFERENCES_UNRESOLVED';
        throw error;
      }
      const unmappedMentions = Array.isArray(prompt.unmappedMentions) ? prompt.unmappedMentions : [];
      if (unmappedMentions.length > 0) {
        const error = new Error(`当前视频提示词的 ${unmappedMentions.join('、')} 没有可绑定映射。为避免把用户写的参考悄悄降级成普通文字，本次没有生成 H3，原文件已保留；请先把它们写进本大分镜的资产映射再同步`);
        error.code = 'H3_SOURCE_MENTIONS_UNMAPPED';
        throw error;
      }
      const expected = [];
      for (const subject of prompt.subjects) {
        if (Number.isInteger(subject.picture) && subject.picture > 0) {
          expected.push({ label: `<Picture ${subject.picture}>`, name: subject.name, mediaType: 'Picture', kind: 'subject' });
        } else if (subject.mediaType && Number.isInteger(subject.referenceIndex)) {
          expected.push({ label: `<${subject.mediaType} ${subject.referenceIndex}>`, name: subject.name, mediaType: subject.mediaType, kind: 'subject' });
        }
      }
      for (const functional of prompt.functional ?? []) {
        expected.push({ label: functional.label, name: functional.name, mediaType: functional.mediaType ?? 'Picture', kind: 'functional', role: functional.role ?? null });
      }
      const expectedByLabel = new Map(expected.map((entry) => [entry.label, entry]));
      if (expectedByLabel.size !== expected.length) {
        const error = new Error('本次 H3 编译产生了重复的资产槽位标签；为避免两个资产争用同一编号，本次没有生成 H3，原文件已保留');
        error.code = 'H3_REFERENCE_LABEL_DUPLICATE';
        throw error;
      }
      const referenceNames = (entry) => {
        const qualifiedVariant = typeof entry.assetName === 'string'
          && typeof entry.variantName === 'string'
          && entry.variantName !== '' && entry.variantName !== 'default'
          ? `${entry.assetName}（${entry.variantName}）`
          : null;
        return [entry.assetName, entry.display, qualifiedVariant, entry.fileName]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .map(normalize)
          .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);
      };
      const scoreReference = (wanted, entry) => {
        if (refMediaType(entry) !== wanted.mediaType) return 0;
        const target = normalize(wanted.name);
        const targetBase = normalize(String(wanted.name ?? '').replace(/[（(][^）)]*[）)]\s*$/u, ''));
        let score = 0;
        for (const candidate of referenceNames(entry)) {
          if (candidate === target) score = Math.max(score, 100);
          else if (target.length >= 2 && (candidate.startsWith(target) || target.startsWith(candidate))) score = Math.max(score, 80);
          const candidateBase = normalize(candidate.replace(/[（(][^）)]*[）)]\s*$/u, ''));
          if (targetBase.length >= 2 && candidateBase === targetBase) score = Math.max(score, 70);
        }
        return score;
      };
      const assignments = new Map();
      const usedReferences = new Set();
      const orderedByChoiceCount = expected.map((entry) => ({
        entry,
        candidates: sourceReferences
          .map((reference, index) => ({ reference, index, score: scoreReference(entry, reference) }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score),
      })).sort((left, right) => left.candidates.length - right.candidates.length);
      const unmatchedH3 = [];
      const ambiguousH3 = [];
      for (const { entry, candidates } of orderedByChoiceCount) {
        const available = candidates.filter((candidate) => !usedReferences.has(candidate.index));
        if (available.length === 0) {
          unmatchedH3.push(entry);
          continue;
        }
        const bestScore = available[0].score;
        const best = available.filter((candidate) => candidate.score === bestScore);
        const versions = new Set(best.map((candidate) => referenceFileIdentity(candidate.reference)));
        if (best.length > 1 && versions.size > 1) {
          ambiguousH3.push(entry);
          continue;
        }
        usedReferences.add(best[0].index);
        assignments.set(entry.label, best[0].reference);
      }
      const unusedReferences = sourceReferences.filter((_, index) => !usedReferences.has(index));
      if (unmatchedH3.length > 0 || ambiguousH3.length > 0 || unusedReferences.length > 0) {
        const details = [
          ...unmatchedH3.map((entry) => `${entry.label}「${entry.name}」在视频资产栏找不到唯一绑定`),
          ...ambiguousH3.map((entry) => `${entry.label}「${entry.name}」在视频资产栏有多个同等候选`),
          ...unusedReferences.map((entry) => `视频资产栏的「${entry.assetName ?? entry.display ?? entry.fileName ?? '未命名'}」没有进入 H3 映射`),
          ...(unmatchedH3.length === 0 ? [] : [
            `视频资产栏现有：${sourceReferences.length === 0
              ? '空'
              : sourceReferences.map((entry) => String(entry.assetName ?? entry.display ?? entry.fileName ?? '未命名')).join('、')}`,
          ]),
        ].join('；');
        const error = new Error(`一键同步没有做到资产栏一一对应：${details}。为避免静默少资产，本次没有生成 H3，原文件已保留`);
        error.code = 'H3_REFERENCE_MAPPING_MISMATCH';
        throw error;
      }
      const parsedDraft = parseH3References(prompt.text);
      const definitionByLabel = new Map([...parsedDraft.pictures, ...(parsedDraft.media ?? [])]
        .map((entry) => [`<${entry.mediaType ?? 'Picture'} ${entry.picture}>`, String(entry.definition ?? '').trim()]));
      const bindingFromReference = (reference) => {
        const {
          display,
          definition,
          occurrences,
          referenceIndex,
          thumbnailHandle,
          ...binding
        } = reference;
        void display;
        void definition;
        void occurrences;
        void referenceIndex;
        void thumbnailHandle;
        return binding;
      };
      const syncedReferenceSlots = expected.map((entry) => ({
        label: entry.label,
        definition: definitionByLabel.get(entry.label) ?? '',
        mode: 'bound',
        binding: bindingFromReference(assignments.get(entry.label)),
        source: { kind: 'latest-video-prompt', blockNumber, role: entry.kind },
      }));
      // The card paints its material bar from `displayReferences`. Returning the freshly mapped
      // rows with the sync result makes the bar update even before the follow-up resolve call,
      // and leaves a correct source projection on screen if that call fails. Without this the
      // text could be saved while the old H3 image tiles remained visible.
      const displayReferences = expected.map((entry) => {
        const reference = assignments.get(entry.label);
        if (reference === undefined) return null;
        const number = Number(/\d+/u.exec(entry.label)?.[0]);
        const {
          display,
          definition,
          occurrences,
          referenceIndex,
          thumbnailHandle,
          ...binding
        } = reference;
        void display;
        void occurrences;
        void referenceIndex;
        return {
          ...binding,
          display: entry.label,
          definition: definitionByLabel.get(entry.label) ?? definition ?? '',
          mediaType: entry.mediaType,
          referenceIndex: Number.isInteger(number) ? number : null,
          ...(entry.mediaType === 'Picture' && Number.isInteger(number) ? { picture: number } : {}),
          bindingState: 'resolved',
          thumbnailHandle: thumbnailHandle ?? null,
        };
      }).filter((entry) => entry !== null);
      const expectedVersionCounts = new Map();
      for (const slot of syncedReferenceSlots) {
        const version = slot.binding?.assetVersionId;
        if (typeof version === 'string') expectedVersionCounts.set(version, (expectedVersionCounts.get(version) ?? 0) + 1);
      }
      const consumedVersions = new Map();
      const discardedReferenceSlots = [];
      // Old H3 slots are an audit input only. They never contribute a binding above; this loop
      // reports exactly which old slots the latest video prompt no longer authorizes.
      const oldSlots = [];
      const oldLabels = new Set();
      for (const slot of [...(currentBlock?.referenceSlots ?? []), ...(Array.isArray(payload.referenceSlots) ? payload.referenceSlots : [])]) {
        if (slot === null || typeof slot !== 'object' || typeof slot.label !== 'string' || oldLabels.has(slot.label)) continue;
        oldLabels.add(slot.label);
        oldSlots.push(slot);
      }
      for (const slot of oldSlots) {
        if (slot?.mode !== 'bound' || typeof slot.label !== 'string' || typeof slot.binding?.assetVersionId !== 'string') continue;
        const version = slot.binding.assetVersionId;
        const allowed = expectedVersionCounts.get(version) ?? 0;
        const used = consumedVersions.get(version) ?? 0;
        if (used >= allowed) {
          discardedReferenceSlots.push({
            label: slot.label,
            name: slot.binding.assetName ?? slot.binding.fileName ?? null,
            assetVersionId: version,
            reason: allowed > 0 ? 'duplicate' : 'not-in-latest-video-prompt',
          });
          continue;
        }
        consumedVersions.set(version, used + 1);
      }
      const converted = await convertH3Block({
        sourceText: source.text,
        deterministicDraft: prompt.text,
        currentText,
        ctx: context.ctx,
        sessionId: context.sessionId,
        signal: context.signal,
        modelRoute: context.modelRoute ?? null,
        convert: context.convertH3 ?? null,
      });
      // Keep the block identity in the document even when the model returns only the H3 fields.
      // The panel writes this text back, so losing the heading here would make the next duration
      // lookup fall back to file-local index 1 again.
      const syncedText = withH3BlockHeading(converted.text, blockNumber);
      // `unmappedMentions` is what makes 一键同步 answerable: a `@` that is not in the block's mapping
      // cannot bind, so it is dropped from the H3 text - and the user needs to be told WHICH one, or
      // the sync looks like it did nothing.
      return {
        text: syncedText,
        sourceFile: block.file,
        file: targetPath,
        blockNumber,
        translatedFrom: null,
        unmappedMentions,
        referenceSlots: syncedReferenceSlots,
        displayReferences,
        discardedReferenceSlots,
        sourceAssetCount: sourceReferences.length,
        h3AssetCount: syncedReferenceSlots.length,
        modelConversion: converted.modelConversion ?? null,
        sourceAssetBar: expected.map((entry) => ({
          label: entry.label,
          name: entry.name,
          mediaType: entry.mediaType,
          role: entry.kind,
          assetVersionId: assignments.get(entry.label)?.assetVersionId ?? null,
        })),
      };
    }
    case 'generate-h3': {
      if (typeof payload.file !== 'string' || payload.file.trim().length === 0) {
        throw new Error('generate-h3 需要 file：先读取当前集 H3 中文或英文文件，并原样传入返回的 file');
      }
      const episodes = await reader.listEpisodes(payload.project);
      const episode = episodes.find((entry) => entry.sources.some((source) => source.id.startsWith('h3') && fileMatches(source.files, payload.file)));
      if (episode === undefined) throw new Error(`此 H3 文件不属于当前项目：${payload.file}。项目里的 H3 文件是 ${episodes.flatMap((entry) => entry.sources.filter((source) => source.id.startsWith('h3')).flatMap((source) => (source.files ?? []).map((file) => file.file ?? file.path))).slice(0, 6).join('、') || '（这个项目还没有 H3 文件，先编译）'}`);
      if (episode.sources.some((source) => source.id === 'h3-en' && fileMatches(source.files, payload.file))) {
        throw new Error('H3 英文功能已停用。请使用中文 H3 生成视频；已有英文文件不会删除');
      }
      const read = await reader.readShots(payload.file);
      let index = Number.isInteger(payload.index) ? payload.index : null;
      let shot = null;
      if (typeof payload.shotId === 'string' && payload.shotId.trim().length > 0) {
        shot = read.shots.find((entry) => entry.shotId === payload.shotId) ?? null;
        index = shot === null ? null : read.shots.indexOf(shot);
        if (shot === null) {
          // A shotId is an identity INSIDE ONE DOCUMENT. The one that reaches this branch almost
          // always came from another file - the video prompt, or another episode's H3 - where it
          // means a different block. Saying "no such shotId" alone sent people hunting a data bug;
          // naming the count and the index range is the actionable half.
          throw new Error(`H3 文件里没有 shotId=${payload.shotId}：shotId 是"某一份文件内"的身份，从别的文件（视频提示词 / 另一集）拿来的 shotId 在这里不存在。`
            + `改用 index（这份文件有 ${String(read.shots.length)} 块，index=${String(read.shots.length === 0 ? 0 : read.shots.length - 1)} 是最后一块），或重新 read 这份文件再取它自己的 shotId`);
        }
      } else {
        if (index === null) throw new Error('generate-h3 需要 index（从 0 开始）或 shotId；先 read 当前 H3 文件再调用');
        shot = read.shots[index] ?? null;
        if (shot === null) throw new Error(`index=${String(payload.index)} 超出范围；这个 H3 文件有 ${String(read.shots.length)} 个块，index 范围是 0–${String(Math.max(0, read.shots.length - 1))}`);
      }
      const h3Source = episode.sources.find((source) => source.id.startsWith('h3') && fileMatches(source.files, payload.file));
      const h3File = (h3Source?.files ?? []).find((file) => fileMatches([file], payload.file)) ?? payload.file;
      const blockNumber = resolveH3BlockNumber({
        shot,
        index,
        file: h3File,
        requested: payload.blockNumber,
      });
      // `expectedText` is an OPTIONAL stale-editor guard, not a second required copy of the
      // prompt. This action has already read the current block above; when the caller does not
      // provide an old copy there is nothing stale to compare, and requiring one made
      // `read → generate-h3` look like an impossible loop in older Host builds.
      if (!h3ExpectedTextMatches(shot.text, payload.expectedText)) {
        throw new Error(`H3 大分镜 ${String(blockNumber)} 在读取后已变化，本次没有提交。请重新 read 并复制新的 shot.text；expectedText 不包含标题行`);
      }
      const projectRoot = directorForPath(payload.file, payload.project).projectRoot;
      if (!projectRoot) throw new Error('无效的项目');
      const assets = await createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy))
        .rows({ includePlanned: false });
      const referenceSlots = Array.isArray(payload.referenceSlots)
        ? payload.referenceSlots
        : shot.referenceSlots ?? [];
      const parsedSlots = parseH3References(shot.text);
      const declaredSlots = new Set([...parsedSlots.pictures, ...(parsedSlots.media ?? [])]
        .map((entry) => `<${entry.mediaType ?? 'Picture'} ${entry.picture}>`));
      const orphanedBindings = referenceSlots.filter((slot) => slot?.autoVoice !== true
        && slot?.binding?.autoVoice !== true
        && slot?.mode === 'bound'
        && slot?.binding !== null
        && typeof slot?.binding === 'object'
        && !declaredSlots.has(slot.label));
      if (orphanedBindings.length > 0) {
        const names = orphanedBindings.map((slot) => `${slot.label} → ${String(slot.binding.fileName ?? slot.binding.assetName ?? '已上传素材')}`).join('；');
        throw new Error(`素材栏有绑定，但 H3 提示词里没有对应定义：${names}。为避免“上传了却没进工作流”，本次没有提交；请在面板重新上传或恢复该槽位，让定义写回提示词后再生成`);
      }
      const resolved = buildH3References(shot.text, assets, { slots: referenceSlots });
      const withVoices = addCharacterVoicesToReferences(resolved.references, assets, {
        slots: referenceSlots,
        h3: true,
        text: shot.text,
      });
      const enrichedReferences = withVoices.references;
      const enrichedReferenceSlots = withVoices.slots;
      if (resolved.unresolved.length || resolved.ambiguous.length || enrichedReferences.some((entry) => entry.bindingState !== 'resolved')) {
        const details = h3ReferenceFailureDetails(resolved, enrichedReferences);
        const error = new Error('有未绑定的 H3 参考资产，请先修正引用'
          + (details.length > 0 ? `\n${details.join('\n')}` : ''));
        error.code = 'H3_REFERENCE_UNBOUND';
        throw error;
      }
      // The panel sends its current slot snapshot with generation. Persist it before submitting so a
      // just-uploaded image cannot disappear from the next read or from a retry after a restart.
      if (typeof shot.shotId === 'string' && shot.shotId.length > 0) {
        try {
          const scoped = directorForPath(payload.file, payload.project).director;
          const documentPath = isAbsolute(payload.file)
            ? relative(root, payload.file).replace(/\\/gu, '/')
            : payload.file.replace(/\\/gu, '/');
          await scoped.setShotReferenceSlots(documentPath, shot.shotId, enrichedReferenceSlots);
        } catch {
          // Binding the submitted inputs is what matters; persistence is retryable metadata.
        }
      }
      const references = [];
      for (const reference of enrichedReferences) {
        const absolutePath = await realpath(join(projectRoot, reference.relativePath));
        const projectReal = await realpath(projectRoot);
        const rel = (await import('node:path')).relative(projectReal, absolutePath);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('参考资产超出项目目录');
        references.push({ ...reference, absolutePath });
      }
      // Duration: the panel's choice wins, the heading is the default.
      //
      // The 大分镜 heading states a length and that is what its prompt was written for, so it is the
      // default. A generation may still ask for a different one without editing the prompt, which is what
      // the 时长 control is for. H3 accepts 4–15 seconds inclusive; anything else is refused HERE rather
      // than sent, because a frame count outside the model's range is a wasted GPU run.
      const requestedSeconds = payload.settings?.seconds;
      let seconds = requestedSeconds === undefined || requestedSeconds === null || requestedSeconds === ''
        ? shot.seconds
        : Number(requestedSeconds);
      if (seconds === null || seconds === undefined) {
        // H3 split files intentionally have no duration in their heading. The matching video
        // prompt block is the source of truth, so use its heading before asking the agent to
        // pass a redundant number.
        const videoSource = (episode.sources ?? []).find((source) => source.id === 'video');
        for (const videoFile of videoSource?.files ?? []) {
          const path = videoFile.path ?? videoFile.file;
          if (typeof path !== 'string' || path.length === 0) continue;
          const videoRead = await reader.readShots(path).catch(() => null);
          const counterpart = (videoRead?.shots ?? []).find((entry, position) => (Number.isInteger(entry.sourceNumber) ? entry.sourceNumber : position + 1) === blockNumber);
          const bodySeconds = counterpart === undefined
            ? []
            : [...String(counterpart.text ?? '').matchAll(/[（(]\s*时长\s*[:：]\s*(\d+)\s*(?:秒|s)\s*[)）]/giu)]
              .map((match) => Number(match[1]))
              .filter((value) => Number.isInteger(value));
          const inferred = Number.isInteger(counterpart?.seconds)
            ? counterpart.seconds
            : (bodySeconds.length > 0 ? bodySeconds.reduce((total, value) => total + value, 0) : null);
          if (Number.isInteger(inferred)) {
            seconds = inferred;
            break;
          }
        }
      }
      if (seconds === null || seconds === undefined) {
        throw new Error(`大分镜 ${String(blockNumber)} 没有可推断的时长：对应视频提示词标题也没有总时长。请在 settings.seconds 明确传 4–15 的整数`);
      }
      if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
        throw new Error(`H3 单次时长必须是 4–15 秒的整数：块标题写的是 ${String(shot.seconds ?? '没有时长')}，这次选择的是 ${String(requestedSeconds ?? '未选择')}`);
      }
      // 画幅 / 分辨率 come from the PROJECT unless this call overrides them.
      //
      // The project record is the default the panel shows and the agent was told to use, so a
      // generation that quietly disagreed with it would produce a clip nobody can cut in beside
      // its neighbours. A missing 画幅 is refused rather than defaulted: `generateH3` would
      // otherwise assume 9:16, which is a decision, and it is not this layer's to make.
      const projectRecord = await createDirectorStore(fs, projectRoot, getPolicy).readProject();
      const projectSettings = projectRecord?.settings ?? {};
      const effectiveSettings = h3SettingsWithProjectDefaults(projectSettings, payload.settings ?? {});
      if (!effectiveSettings.aspectRatio) {
        throw new Error('这个项目还没定画幅。先调 storyboard action=settings 设 projectAspectRatio（竖屏 9:16 或横屏 16:9）再生成。');
      }
      // The episode and block number travel with the run so the recorded candidate can be
      // NAMED: `项目名_第1集_大分镜3（第2次）` is something a person can find again, while the
      // instance's own `YZ_H3__00003-audio.mp4` says nothing about which shot it belongs to.
      // Resolved here because this is the layer that knows which episode owns the file.
      const owningEpisode = episodes.find((episode) => episode.sources.some((source) => fileMatches(source.files, payload.file)));
      const requestId = h3StableRequestId({
        supplied: payload.requestId,
        projectRoot,
        file: payload.file,
        shot,
        blockNumber,
        text: shot.text,
        seconds,
        settings: effectiveSettings,
        references,
      });
      let generated;
      try {
        generated = await generateH3({
          // The authored H3 block is the payload. Resolved slot bindings decide which files are
          // uploaded; they do not rename or rewrite anything inside the prompt text.
          text: shot.text,
          seconds,
          references,
          projectRoot,
          shotId: shot.shotId,
          episodeNumber: Number.isInteger(owningEpisode?.number) ? owningEpisode.number : null,
          blockNumber,
          settings: effectiveSettings,
          requestId,
        }, context);
      } catch (error) {
        // Preserve the full stack for the one opaque failure this path has produced in the field:
        // a bare `.trim` TypeError cannot identify which argument was missing once the tool layer
        // reduces the error to its message.
        if (/reading ['"]trim['"]/u.test(String(error?.message ?? ''))) {
          const wrapped = new Error(`generate-h3 在提交前访问到了空字符串参数。原始错误：${String(error?.message ?? error)}`
            + `\n调用参数：${JSON.stringify({ file: payload.file, shotId: shot.shotId, blockNumber, settings: effectiveSettings, requestId: payload.requestId })}`
            + `\n原始堆栈：${String(error?.stack ?? '')}`);
          wrapped.code = 'H3_GENERATE_NULL_TRIM';
          wrapped.cause = error;
          throw wrapped;
        }
        throw error;
      }
      return {
        ...generated,
        requestId,
        blockNumber,
        referenceSlots: enrichedReferenceSlots,
        referenceCount: references.length,
        autoVoiceCount: withVoices.autoVoiceCount,
      };
    }
    case 'mode': {
      const modeAction = typeof payload.modeAction === 'string' && payload.modeAction.length > 0
        ? payload.modeAction
        : 'status';
      if (modeAction === 'status') {
        // The panel asks this on every load, so this is where it learns whether it may SAVE
        // before the user types a paragraph and finds out the hard way.
        const context = await directorContext();
        return {
          modeAction,
          ...context,
          writeAccess: describeWriteAccess(
            typeof getPolicy === 'function' ? getPolicy() : undefined,
            typeof context.activeProject === 'string' ? context.activeProject : null,
          ),
          changed: false,
        };
      }
      if (!['enter', 'exit', 'select-project', 'select-context'].includes(modeAction)) {
        throw new Error(`未知的 modeAction "${modeAction}"`);
      }
      const current = await readState();
      const requestedProject = typeof payload.project === 'string' && payload.project.trim().length > 0
        ? projectRootFor(payload.project.trim())
        : modeAction === 'select-context' ? current.state.activeProject ?? null : null;
      const project = requestedProject;
      if (project !== null) {
        const info = await fs.stat(await fs.resolve(project));
        if (info?.type !== 'directory') throw new Error(`项目目录不存在：${project}`);
      }
      if (modeAction === 'select-context' && project === null) {
        throw new Error('select-context 需要先有一个活动项目');
      }
      const next = await updateState((current) => {
        if (modeAction === 'enter') current.mode = 'drama';
        if (modeAction === 'exit') current.mode = 'general';
        if (project !== null) {
          upsertProject(current, { root: project, name: basename(project) });
        }
        if (modeAction === 'select-context') {
          setDirectorContext(current, {
            ...(payload.episodeNumber === undefined ? {} : { episodeNumber: payload.episodeNumber }),
            ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
            ...(payload.shotId === undefined ? {} : { shotId: payload.shotId }),
          });
        }
        return current;
      });
      if ((modeAction === 'enter' || modeAction === 'exit') && typeof onModeChange === 'function') {
        await onModeChange(next.state.mode);
      }
      return {
        modeAction,
        mode: next.state.mode,
        activeProject: next.state.activeProject ?? null,
        activeContext: next.state.activeContext ?? null,
        // Switching the project changes which DIRECTORY the boundary is judged against, so the
        // answer has to travel with the switch: a panel that kept the old verdict would either
        // promise a save that cannot land or refuse one that can.
        writeAccess: describeWriteAccess(
          typeof getPolicy === 'function' ? getPolicy() : undefined,
          next.state.activeProject ?? null,
        ),
        changed: true,
      };
    }
    case 'projects': {
      // One level only: `<root>/<script title>/剧集/...`. The root is known, so there is
      // nothing to search for and no budget to exhaust.
      /**
       * The candidate is `''` (the root itself), NOT `'.'`.
       *
       * `''` is deliberate: `scanProjects` builds each project's `path` from the relative it walked, and a
       * `'.'` candidate makes every path `./名字`, which `selftest-design-root.mjs` correctly rejects as
       * nesting ("the project path is one level under the root"). The reader maps `''` to `'.'` internally
       * (`target()`), so the empty string never reaches `fs.resolve`.
       */
      const scan = await reader.scanProjects({ candidates: [''], depth: 1 });
      // A folder can be removed in Explorer between panel opens. State is not the picker's
      // source of truth (the disk scan is), but a deleted active project must not keep steering
      // mode/project actions toward a path that no longer exists.
      const storedState = (await readState()).state;
      const staleProjects = [];
      for (const entry of Array.isArray(storedState.projects) ? storedState.projects : []) {
        if (typeof entry?.root !== 'string' || entry.root.length === 0) continue;
        const info = await fs.stat(await fs.resolve(entry.root, { cwd: root })).catch(() => undefined);
        if (info?.type !== 'directory') staleProjects.push(entry.root);
      }
      if (staleProjects.length > 0) {
        await updateState((next) => {
          const stale = new Set(staleProjects.map((entry) => entry.toLowerCase()));
          next.projects = (Array.isArray(next.projects) ? next.projects : [])
            .filter((entry) => typeof entry?.root !== 'string' || !stale.has(entry.root.toLowerCase()));
          if (typeof next.activeProject === 'string' && stale.has(next.activeProject.toLowerCase())) {
            next.activeProject = null;
            next.activeContext = emptyDirectorContext();
          }
          return next;
        });
      }
      // Each project carries its own defaults (画幅/画风/分辨率), so the panel can seed every
      // control from the SAME record the agent reads. Without this the panel had to guess
      // 9:16 / 720p, and a 16:9 project then opened with the wrong shape preselected - the
      // exact disagreement between panel and agent that the settings record exists to prevent.
      const projects = [];
      const { mode, activeProject, activeContext } = await directorContext();
      for (const entry of scan.projects ?? []) {
        let settings = null;
        const absolute = isAbsolute(entry.path) ? entry.path : join(root, entry.path ?? '');
        try {
          // `entry.path` is the project's path RELATIVE to the projects root (or '.' for the
          // root itself), which is exactly what the store wants.
          const store = createDirectorStore(fs, absolute, getPolicy);
          const record = await store.readProject();
          settings = record?.settings ?? null;
        } catch {
          // A project with no readable metadata simply has no defaults yet.
        }
        projects.push({
          ...entry,
          settings,
          active: activeProject !== null && samePath(absolute, activeProject),
        });
      }
      // An active project may live outside the directory currently being browsed. It belongs
      // in the picker anyway: the agent and the panel must be able to name the same project.
      if (activeProject !== null && !projects.some((entry) => entry.active)) {
        const info = await fs.stat(await fs.resolve(activeProject)).catch(() => undefined);
        if (info?.type === 'directory') {
          let settings = null;
          try {
            settings = (await createDirectorStore(fs, activeProject, getPolicy).readProject())?.settings ?? null;
          } catch {
            // Keep the entry usable even when its optional project record is unreadable.
          }
          projects.unshift({
            name: basename(activeProject),
            path: activeProject,
            label: activeProject,
            settings,
            active: true,
            external: true,
          });
        }
      }
      return {
        root,
        mode,
        activeProject,
        activeContext,
        // Same field as action=mode, because this is the call the panel makes first: the point of
        // reporting it here is that the boundary is known before the first keystroke, not after a
        // save is refused. `writable: null` means unknown, never "read only".
        writeAccess: describeWriteAccess(
          typeof getPolicy === 'function' ? getPolicy() : undefined,
          typeof activeProject === 'string' ? activeProject : null,
        ),
        projects,
        truncated: scan.truncated === true,
        scanned: scan.visited,
      };
    }
    case 'project-delete': {
      if (payload.confirmed !== true) {
        throw new Error('删除项目需要二次确认；本次没有移动或删除任何文件');
      }
      if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
        throw new Error('删除项目需要项目路径');
      }
      const requested = payload.project.trim();
      const absolute = isAbsolute(requested) ? requested : join(root, requested);
      const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
      const checkedSource = typeof fs.checkedTarget === 'function'
        ? await fs.checkedTarget(await fs.resolve(absolute, { cwd: root }), policy)
        : null;
      const projectPath = checkedSource?.targetKey ?? absolute;
      if (dirname(projectPath) === projectPath) throw new Error('不能删除磁盘根目录');
      const episodeMarker = await fs.stat(await fs.resolve(join(projectPath, '剧集'), { cwd: root })).catch(() => undefined);
      if (episodeMarker?.type !== 'directory') {
        throw new Error('目标不是可识别的短剧项目（缺少 剧集/ 目录）；本次没有删除任何文件');
      }
      const trashRoot = join(dirname(projectPath), '.trash');
      const checkedTrashRoot = typeof fs.checkedTarget === 'function'
        ? await fs.checkedTarget(await fs.resolve(trashRoot, { cwd: root }), policy)
        : null;
      const trashPath = checkedTrashRoot?.targetKey ?? trashRoot;
      await mkdir(trashPath, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
      const projectName = basename(projectPath);
      let movedTo = join(trashPath, `${projectName}-deleted-${stamp}`);
      let suffix = 2;
      while (await fs.stat(await fs.resolve(movedTo, { cwd: root })).catch(() => undefined) !== undefined) {
        movedTo = join(trashPath, `${projectName}-deleted-${stamp}-${String(suffix)}`);
        suffix += 1;
      }
      await rename(projectPath, movedTo);
      const stored = await updateState((next) => {
        next.projects = (Array.isArray(next.projects) ? next.projects : [])
          .filter((entry) => typeof entry?.root !== 'string' || !samePath(entry.root, projectPath));
        if (typeof next.activeProject === 'string' && samePath(next.activeProject, projectPath)) {
          next.activeProject = null;
          next.activeContext = emptyDirectorContext();
        }
        return next;
      });
      return {
        deleted: true,
        project: projectPath,
        movedTo,
        root,
        activeProject: stored.state.activeProject ?? null,
        activeContext: stored.state.activeContext,
        recoverable: true,
      };
    }
    case 'project-create': {
      const created = await createBlankDramaProject({
        root,
        name: payload.projectName,
        episodeCount: payload.projectEpisodeCount ?? payload.episodeCount,
        aspectRatio: payload.projectAspectRatio,
        artStyle: payload.projectArtStyle,
        artStyleNote: payload.projectArtStyleNote,
        resolution: payload.projectResolution ?? '720p',
        scriptText: payload.scriptText,
        assertWritable: assertProjectWritable,
        fs,
        getPolicy,
      });
      await updateState((current) => {
        upsertProject(current, {
          root: created.projectRoot,
          name: created.projectName,
          present: true,
          episodes: created.episodes.length,
        });
        setDirectorContext(current, {
          episodeNumber: 1,
          sourceId: 'video',
          shotId: null,
        });
        return current;
      });
      let scriptQueued = false;
      let scriptQueueError = null;
      if (created.scriptWritten) {
        const scriptPath = join(created.projectRoot, '剧本.txt');
        const agents = typeof context.ctx?.get === 'function' ? context.ctx.get('agents') : undefined;
        const agent = agents?.get?.(context.sessionId);
        if (agent === undefined || agent === null) {
          scriptQueueError = '当前会话没有可用的导演代理，项目已创建但剧本尚未解析';
        } else {
          try {
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: inventoryParseInstruction({ projectRoot: created.projectRoot, scriptPath }) }],
              source: { kind: 'short-drama-project-inventory' },
            }));
            scriptQueued = true;
          } catch (error) {
            scriptQueueError = `项目已创建，但交给导演解析失败：${String(error?.message ?? error)}`;
          }
        }
      }
      return {
        action: 'project-create',
        projectRoot: created.projectRoot,
        projectName: created.projectName,
        root,
        episodes: created.episodes,
        scriptWritten: created.scriptWritten,
        scriptQueued,
        scriptQueueError,
        storage: created.storage,
        spaceWarning: created.spaceWarning,
      };
    }
    case 'episode-create': {
      if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
        throw new Error('新增集数需要项目');
      }
      const projectRoot = projectRootFor(payload.project.trim());
      const created = await createBlankEpisode({
        projectRoot,
        episodeNumber: payload.episodeNumber,
        assertWritable: assertProjectWritable,
        fs,
        getPolicy,
      });
      const episodeCount = (await reader.listEpisodes(payload.project)).length;
      await updateState((current) => {
        upsertProject(current, {
          root: projectRoot,
          name: basename(projectRoot),
          present: true,
          episodes: episodeCount,
        });
        setDirectorContext(current, {
          episodeNumber: created.episodeNumber,
          sourceId: 'video',
          shotId: null,
        });
        return current;
      });
      return {
        action: 'episode-create',
        projectRoot,
        project: payload.project,
        episodeNumber: created.episodeNumber,
        folder: created.folder,
      };
    }
    case 'browse': {
      // The picker's data: this directory, its parent, and which children are projects.
      const listing = await reader.browse(typeof payload.path === 'string' && payload.path.length > 0 ? payload.path : '');
      return { root, browse: listing };
    }
    case 'episodes': {
      const episodes = await reader.listEpisodes(payload.project);
      // Each episode carries whether its prompt sources still agree (D08). Computed here rather than
      // in a separate call because this is the list the user looks at: a drift warning that needs its
      // own request is one that arrives after they have already started generating.
      const withSync = [];
      for (const episode of episodes) {
        const blocksBySource = {};
        const mtimes = {};
        for (const source of episode.sources) {
          const read = await reader.readShots(source.path, { reconcile: false }).catch(() => null);
          if (read === null) continue;
          blocksBySource[source.id] = read.shots.map((shot) => ({ anchor: shot.anchor ?? null }));
          const info = await fs.stat(await fs.resolve(source.path, { cwd: root })).catch(() => undefined);
          mtimes[source.id] = info?.mtime ?? null;
        }
        const sync = compareSources({ sources: episode.sources, blocksBySource, mtimes });
        withSync.push({ ...episode, sync });
      }
      return { project: payload.project, episodes: withSync };
    }
    case 'read': {
      if (typeof payload.file !== 'string') throw new Error('read needs the file path');
      const { director } = directorForPath(payload.file, payload.project);
      const scoped = createReader(fs, root, getPolicy, { director });
      // Reconciliation is what hands out and refreshes shot ids. It is skipped when the
      // caller only wants to display the file, because it writes metadata.
      const { text, shots, revision, documentId, changedOnDisk, added, ambiguous } = await scoped.readShots(payload.file, { reconcile: payload.reconcile !== false });
      // An empty list here is almost never "the file is empty" - it means the parser did not
      // recognise the file's heading dialect. Reporting that as a failure is the difference
      // between a blank panel the user cannot explain and a sentence telling them what to do.
      if (shots.length === 0 && text.trim().length > 0) {
        throw new Error(
          `no 大分镜 heading was recognised in ${payload.file}; `
          + 'headings may be written 【大分镜1】, ## 大分镜 1, or ### 大分镜 1（总时长：6 秒）',
        );
      }
      return {
        file: payload.file,
        shots,
        revision: revision ?? null,
        documentId: documentId ?? null,
        changedOnDisk: changedOnDisk === true,
        added: added ?? [],
        ambiguous: ambiguous ?? [],
      };
    }
    case 'write': {
      if (typeof payload.file !== 'string') throw new Error('write needs the file path');
      if (typeof payload.text !== 'string') throw new Error('write needs the new text');
      if (payload.createIfMissing === true) {
        if (!Number.isInteger(payload.episodeNumber) || payload.episodeNumber < 1
          || !Number.isInteger(payload.blockNumber) || payload.blockNumber < 1) {
          throw new Error('首次创建 H3 需要 episodeNumber 和 blockNumber');
        }
        const expectedName = h3FileName(payload.episodeNumber, payload.blockNumber, 'zh');
        const actualName = String(payload.file).replace(/\\/gu, '/').split('/').pop() ?? '';
        if (actualName !== expectedName) {
          throw new Error(`首次创建 H3 只能写入标准中文 H3 文件：${expectedName}`);
        }
      }
      // A block is addressed by `shotId` when the project has identities, and by `index`
      // otherwise. Accepting both keeps the older callers working while the panel migrates
      // to ids; the return value always carries the ids so a caller can adopt them.
      const locator = typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : payload.index;
      if (!Number.isInteger(locator) && typeof locator !== 'string') {
        throw new Error('write needs either shotId (string) or index (integer)');
      }
      const { director } = directorForPath(payload.file, payload.project);
      const scoped = createReader(fs, root, getPolicy, { director });
      const result = await scoped.writeShot(payload.file, locator, payload.text, {
        expectedRevision: payload.expectedRevision,
        expectedText: payload.expectedText,
        createIfMissing: payload.createIfMissing === true,
        episodeNumber: payload.episodeNumber,
        blockNumber: payload.blockNumber,
      });
      return {
        file: payload.file,
        changed: result.changed,
        created: result.created === true,
        revision: result.revision ?? null,
        shotId: result.shotId ?? null,
        shots: result.shots,
      };
    }
    case 'insert': {
      // The two panel buttons: duplicate the block after the addressed one, or drop a blank
      // skeleton there. Both are structural edits, so the whole file is rewritten and every
      // heading is renumbered - a file whose headings disagree with their order cannot be
      // talked about in chat. The inserted block receives a NEW shotId; the shots around it
      // keep theirs, which is the point of the whole identity scheme.
      if (typeof payload.file !== 'string') throw new Error('insert needs the file path');
      const locator = typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : payload.index;
      if (!Number.isInteger(locator) && typeof locator !== 'string') {
        throw new Error('insert needs either shotId (string) or index (integer)');
      }
      const kind = payload.kind === 'copy' ? 'copy' : 'blank';
      const paired = payload.pairWithCompanion === true;
      const { director } = directorForPath(payload.file, payload.project);
      const scoped = createReader(fs, root, getPolicy, { director });

      // A missing H3 document is represented by empty cards in the panel. Structural actions
      // still have to work there. Canonicalise the edit onto the episode's video document: its
      // block sequence is the shared structure, and the H3 tab will derive the new/removed empty
      // card after reload. No placeholder H3 file is created just because a button was pressed.
      if (paired && Number.isInteger(payload.episodeNumber) && Number.isInteger(payload.blockNumber)) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.number === payload.episodeNumber);
        const expectedH3 = episode === undefined ? null : h3FileName(episode.number, payload.blockNumber, 'zh');
        const h3IsMissing = episode !== undefined
          && expectedH3 !== null
          && !episode.sources.some((source) => source.id.startsWith('h3') && fileMatches(source.files, payload.file))
          && samePath(payload.file, `${episode.folder}/${expectedH3}`);
        if (h3IsMissing) {
          const video = episode.sources.find((source) => source.id === 'video');
          if (video === undefined) throw new Error('本集没有视频提示词，无法新增对应分镜');
          const before = await scoped.readShots(video.path);
          const index = before.shots.findIndex((shot, position) => (shot.sourceNumber ?? position + 1) === payload.blockNumber);
          if (index < 0) throw new Error(`视频提示词中没有大分镜 ${String(payload.blockNumber)}，本次没有新增任何文件`);
          const result = await scoped.insertShot(video.path, index, kind, {
            expectedRevision: Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : (before.revision ?? undefined),
          });
          return {
            file: video.path,
            changed: result.changed,
            insertedAt: result.insertedAt,
            blockNumber: result.shots[result.insertedAt]?.sourceNumber ?? (payload.blockNumber + 1),
            kind: result.kind,
            revision: result.revision ?? null,
            shotId: result.shotId ?? null,
            shots: result.shots,
            companion: {
              file: payload.file,
              virtual: true,
              insertedAt: result.insertedAt,
              shotId: null,
              revision: null,
              shots: [],
            },
          };
        }
      }

      if (paired && Number.isInteger(payload.episodeNumber)) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.number === payload.episodeNumber);
        if (!episode) throw new Error('找不到要新增分镜的剧集');
        const videoSource = episode.sources.find((source) => source.id === 'video');
        const h3Source = episode.sources.find((source) => source.id === 'h3-zh');
        const dedicatedH3 = (h3Source?.files ?? []).length > 0
          && (h3Source.files ?? []).every((file) => Number.isInteger(file.blockNumber) && file.blockNumber > 0);
        if (dedicatedH3) {
          if (videoSource === undefined) throw new Error('本集没有视频提示词，无法新增对应分镜');
          return await insertDedicatedH3Shot({
            fs,
            root,
            getPolicy,
            director,
            scoped,
            episode,
            videoSource,
            h3Source,
            locator,
            kind,
            requestedBlockNumber: payload.blockNumber,
          });
        }
      }

      // The panel's video and H3 cards are two views of the same 大分镜 sequence. Structural
      // actions therefore need one shared edit, not two buttons whose results drift apart.
      let companion = null;
      let snapshot = null;
      if (paired) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.sources.some((source) => fileMatches(source.files, payload.file)));
        if (!episode) throw new Error('找不到要新增分镜的剧集');
        const currentSource = episode.sources.find((source) => fileMatches(source.files, payload.file) && ['video', 'h3-zh'].includes(source.id));
        if (!currentSource) throw new Error('只有视频提示词和中文 H3 支持成对新增分镜');
        const companionId = currentSource.id === 'video' ? 'h3-zh' : 'video';
        const companionSource = episode.sources.find((source) => source.id === companionId);
        if (!companionSource) throw new Error(`本集没有${companionId === 'h3-zh' ? '中文 H3' : '视频提示词'}，不能成对新增；请先生成对应提示词`);
        const fileHasDedicatedShape = (companionSource.files ?? []).length > 0
          && (companionSource.files ?? []).every((file) => file.blockNumber > 0);
        const groupedFile = (companionSource.files ?? []).find((file) => file.blockNumber === 0) ?? null;
        if (groupedFile === null && fileHasDedicatedShape) {
          throw new Error('成对新增暂不支持“每条大分镜一个文件”的 H3；当前文件没有被修改。请先使用整集 H3 文档');
        }
        // Snapshot before the alignment reads below. Reconciliation on read can update timestamps,
        // so taking it afterwards made a failed pair look byte-identical in content while leaving
        // metadata timestamps changed.
        snapshot = await capturePairedDocuments({ fs, root, getPolicy, director, scoped, files: [payload.file, groupedFile.path] });
        const before = await scoped.readShots(payload.file);
        const beforeIndex = typeof locator === 'number' ? locator : before.shots.findIndex((shot) => shot.shotId === locator);
        const beforeShot = before.shots[beforeIndex];
        if (!beforeShot) throw new Error('找不到要新增分镜的原块');
        const blockNumber = Number.isInteger(payload.blockNumber) ? payload.blockNumber : beforeShot.sourceNumber;
        if (!Number.isInteger(blockNumber) || beforeShot.sourceNumber !== blockNumber) {
          throw new Error(`当前分镜编号是 ${String(beforeShot.sourceNumber ?? '未知')}，不是请求的 ${String(blockNumber ?? '未知')}；本次没有新增任何文件`);
        }
        const companionRead = await scoped.readShots(groupedFile.path);
        const matched = companionRead.shots.find((shot) => shot.sourceNumber === blockNumber);
        if (matched === undefined) {
          throw new Error(`视频与 H3 没有同为第 ${String(blockNumber)} 块的分镜；为避免新增后两边错位，本次没有新增任何文件`);
        }
        const alignmentProblem = pairedStructuralAlignment({
          mainShots: before.shots,
          companionShots: companionRead.shots,
          targetNumber: blockNumber,
          operation: 'insert',
        });
        if (alignmentProblem !== null) {
          throw new Error(`视频有 ${String(before.shots.length)} 块、H3 有 ${String(companionRead.shots.length)} 块；${alignmentProblem}。本次没有新增任何文件`);
        }
        companion = {
          episode,
          currentSource,
          source: companionSource,
          blockNumber,
          index: companionRead.shots.indexOf(matched),
          groupedFile,
          read: companionRead,
          mainRevision: before.revision ?? null,
        };
      }

      let result;
      let companionResult = null;
      try {
        result = await scoped.insertShot(payload.file, locator, kind, {
          expectedRevision: payload.expectedRevision ?? (paired ? companion.mainRevision : undefined),
        });
        if (paired) {
          const targetFile = companion.groupedFile.path;
          const targetIndex = companion.index;
          companionResult = await scoped.insertShot(targetFile, targetIndex, kind, {
            body: kind === 'blank' ? [] : null,
            expectedRevision: companion.read.revision,
          });
        }
      } catch (error) {
        if (snapshot === null) throw error;
        const rollbackFailures = await restorePairedDocuments(snapshot, { fs, getPolicy, director });
        if (rollbackFailures.length > 0) {
          const rollbackError = new Error(`成对新增失败，且回滚不完整：${rollbackFailures.join('；')}。原始错误：${String(error?.message ?? error)}`);
          rollbackError.code = 'PAIRED_EDIT_ROLLBACK_FAILED';
          rollbackError.cause = error;
          throw rollbackError;
        }
        const rolledBack = new Error(`成对新增失败，已恢复视频提示词和 H3 的原文与分镜身份，两边都没有净变化：${String(error?.message ?? error)}`);
        rolledBack.code = 'PAIRED_EDIT_ROLLED_BACK';
        rolledBack.cause = error;
        throw rolledBack;
      }
      return {
        file: payload.file,
        changed: result.changed,
        insertedAt: result.insertedAt,
        blockNumber: result.shots[result.insertedAt]?.sourceNumber
          ?? companionResult?.shots[companionResult.insertedAt]?.sourceNumber
          ?? null,
        kind: result.kind,
        revision: result.revision ?? null,
        shotId: result.shotId ?? null,
        shots: result.shots,
        companion: companionResult === null ? null : {
          file: companion.groupedFile.path,
          insertedAt: companionResult.insertedAt,
          shotId: companionResult.shotId ?? null,
          revision: companionResult.revision ?? null,
          shots: companionResult.shots,
        },
      };
    }
    case 'delete': {
      if (typeof payload.file !== 'string') throw new Error('delete needs the file path');
      const locator = typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : payload.index;
      if (!Number.isInteger(locator) && typeof locator !== 'string') {
        throw new Error('delete needs either shotId (string) or index (integer)');
      }
      const paired = payload.pairWithCompanion === true;
      const { director } = directorForPath(payload.file, payload.project);
      const scoped = createReader(fs, root, getPolicy, { director });
      if (paired && Number.isInteger(payload.episodeNumber) && Number.isInteger(payload.blockNumber)) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.number === payload.episodeNumber);
        const expectedH3 = episode === undefined ? null : h3FileName(episode.number, payload.blockNumber, 'zh');
        const h3IsMissing = episode !== undefined
          && expectedH3 !== null
          && !episode.sources.some((source) => source.id.startsWith('h3') && fileMatches(source.files, payload.file))
          && samePath(payload.file, `${episode.folder}/${expectedH3}`);
        if (h3IsMissing) {
          const video = episode.sources.find((source) => source.id === 'video');
          if (video === undefined) throw new Error('本集没有视频提示词，无法删除对应分镜');
          const before = await scoped.readShots(video.path);
          const index = before.shots.findIndex((shot, position) => (shot.sourceNumber ?? position + 1) === payload.blockNumber);
          if (index < 0) throw new Error(`视频提示词中没有大分镜 ${String(payload.blockNumber)}，本次没有删除任何文件`);
          const result = await scoped.deleteShot(video.path, index, {
            expectedRevision: Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : (before.revision ?? undefined),
          });
          return {
            file: video.path,
            changed: result.changed,
            deletedAt: result.deletedAt,
            blockNumber: payload.blockNumber,
            revision: result.revision ?? null,
            shots: result.shots,
            companion: {
              file: payload.file,
              virtual: true,
              deletedAt: result.deletedAt,
              revision: null,
              shots: [],
            },
          };
        }
      }

      if (paired && Number.isInteger(payload.episodeNumber)) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.number === payload.episodeNumber);
        if (!episode) throw new Error('找不到要删除分镜的剧集');
        const videoSource = episode.sources.find((source) => source.id === 'video');
        const h3Source = episode.sources.find((source) => source.id === 'h3-zh');
        const dedicatedH3 = (h3Source?.files ?? []).length > 0
          && (h3Source.files ?? []).every((file) => Number.isInteger(file.blockNumber) && file.blockNumber > 0);
        if (dedicatedH3) {
          if (videoSource === undefined) throw new Error('本集没有视频提示词，无法删除对应分镜');
          return await deleteDedicatedH3Shot({
            fs,
            root,
            getPolicy,
            director,
            scoped,
            episode,
            videoSource,
            h3Source,
            locator,
            requestedBlockNumber: payload.blockNumber,
          });
        }
      }
      let companion = null;
      let snapshot = null;
      if (paired) {
        const episodes = await reader.listEpisodes(payload.project);
        const episode = episodes.find((entry) => entry.sources.some((source) => fileMatches(source.files, payload.file)));
        if (!episode) throw new Error('找不到要删除分镜的剧集');
        const currentSource = episode.sources.find((source) => fileMatches(source.files, payload.file) && ['video', 'h3-zh'].includes(source.id));
        if (!currentSource) throw new Error('只有视频提示词和中文 H3 支持成对删除分镜');
        const companionSource = episode.sources.find((source) => source.id === (currentSource.id === 'video' ? 'h3-zh' : 'video'));
        if (!companionSource) throw new Error('本集缺少要成对删除的另一个提示词版本');
        const groupedFile = (companionSource.files ?? []).find((file) => file.blockNumber === 0) ?? null;
        if (groupedFile === null) {
          throw new Error('成对删除暂不支持“每条大分镜一个文件”的 H3；当前文件没有被修改');
        }
        snapshot = await capturePairedDocuments({ fs, root, getPolicy, director, scoped, files: [payload.file, groupedFile.path] });
        const before = await scoped.readShots(payload.file);
        const beforeIndex = typeof locator === 'number' ? locator : before.shots.findIndex((shot) => shot.shotId === locator);
        const beforeShot = before.shots[beforeIndex];
        if (!beforeShot) throw new Error('找不到要删除的分镜');
        const blockNumber = Number.isInteger(payload.blockNumber) ? payload.blockNumber : beforeShot.sourceNumber;
        if (!Number.isInteger(blockNumber) || beforeShot.sourceNumber !== blockNumber) {
          throw new Error(`当前分镜编号是 ${String(beforeShot.sourceNumber ?? '未知')}，不是请求的 ${String(blockNumber ?? '未知')}；本次没有删除任何文件`);
        }
        const companionRead = await scoped.readShots(groupedFile.path);
        const matched = companionRead.shots.find((shot) => shot.sourceNumber === blockNumber);
        if (matched === undefined) {
          throw new Error(`视频与 H3 没有同为第 ${String(blockNumber)} 块的分镜；为避免删除后两边错位，本次没有删除任何文件`);
        }
        const alignmentProblem = pairedStructuralAlignment({
          mainShots: before.shots,
          companionShots: companionRead.shots,
          targetNumber: blockNumber,
          operation: 'delete',
        });
        if (alignmentProblem !== null) {
          throw new Error(`视频有 ${String(before.shots.length)} 块、H3 有 ${String(companionRead.shots.length)} 块；${alignmentProblem}。本次没有删除任何文件`);
        }
        companion = {
          source: companionSource,
          groupedFile,
          blockNumber,
          read: companionRead,
          index: companionRead.shots.indexOf(matched),
          revision: before.revision ?? null,
        };
      }
      let result;
      let companionResult = null;
      try {
        result = await scoped.deleteShot(payload.file, locator, {
          expectedRevision: payload.expectedRevision ?? companion?.revision,
        });
        if (paired) {
          companionResult = await scoped.deleteShot(companion.groupedFile.path, companion.index, {
            expectedRevision: companion.read.revision,
          });
        }
      } catch (error) {
        if (snapshot === null) throw error;
        const rollbackFailures = await restorePairedDocuments(snapshot, { fs, getPolicy, director });
        if (rollbackFailures.length > 0) {
          const rollbackError = new Error(`成对删除失败，且回滚不完整：${rollbackFailures.join('；')}。原始错误：${String(error?.message ?? error)}`);
          rollbackError.code = 'PAIRED_EDIT_ROLLBACK_FAILED';
          rollbackError.cause = error;
          throw rollbackError;
        }
        const rolledBack = new Error(`成对删除失败，已恢复视频提示词和 H3 的原文与分镜身份，两边都没有净变化：${String(error?.message ?? error)}`);
        rolledBack.code = 'PAIRED_EDIT_ROLLED_BACK';
        rolledBack.cause = error;
        throw rolledBack;
      }
      return {
        file: payload.file,
        changed: result.changed,
        deletedAt: result.deletedAt,
        blockNumber: Number.isInteger(payload.blockNumber) ? payload.blockNumber : result.deletedAt + 1,
        revision: result.revision ?? null,
        shots: result.shots,
        companion: companionResult === null ? null : {
          file: companion.groupedFile.path,
          deletedAt: companionResult.deletedAt,
          revision: companionResult.revision ?? null,
          shots: companionResult.shots,
        },
      };
    }
    case 'results': {
      // The candidate area: what a generation produced, before anyone decided anything about it.
      // Kept apart from the asset tree on purpose, and keeping one is a separate call - which is
      // what makes "生成完成" and "审片通过" two facts rather than one (G03).
      const name = typeof payload.project === 'string' && payload.project.trim().length > 0
        ? payload.project.trim()
        : null;
      if (name === null) throw new Error('results needs the project name');
      const projectRoot = projectRootFor(name);
      const store = createResultStore(projectRoot, { media, fs, getPolicy });
      const resultAction = typeof payload.resultAction === 'string' && payload.resultAction.length > 0 ? payload.resultAction : 'list';

      // Where each shot lives (episode number, 大分镜 number), and how many attempts a block has had.
      // Both are needed by `list` (the label it shows) AND by `promote` (the file name it writes),
      // so they are computed once here rather than twice with a chance to drift apart.
      const projectDirector = createDirectorStore(fs, projectRoot, getPolicy);
      const projectRecord = await projectDirector.readProject();
      const projectCode = projectCodeFor({ settings: projectRecord?.settings ?? null, projectName: name }).code;
      const shotInfoById = new Map();
      for (const document of (await projectDirector.readDocuments())?.documents ?? []) {
        const episodeMatch = /第\s*(\d+)\s*集/u.exec(String(document.relativePath ?? ''));
        for (const shot of document.shots ?? []) {
          if (typeof shot?.shotId !== 'string' || shot.shotId.length === 0) continue;
          shotInfoById.set(shot.shotId, {
            episode: episodeMatch === null ? null : Number(episodeMatch[1]),
            blockNumber: Number.isInteger(shot.displayNumber) ? shot.displayNumber : null,
          });
        }
      }
      /**
       * Old candidates were recorded with `shotId: null` before production coordinates were
       * persisted. Their generation request is still on disk and contains the exact H3 text that
       * produced them. Matching that text to the current H3/video blocks restores episode + block
       * without guessing from file order, so old clips can appear in the shot preview immediately.
       */
      const normalizedPromptText = (text) => String(text ?? '')
        .replace(/[\u200b-\u200d\ufeff]/gu, '')
        .replace(/\s+/gu, '')
        .toLowerCase();
      const bigramCounts = (text) => {
        const counts = new Map();
        for (let index = 0; index < text.length - 1; index += 1) {
          const gram = text.slice(index, index + 2);
          counts.set(gram, (counts.get(gram) ?? 0) + 1);
        }
        return counts;
      };
      const promptSimilarity = (left, right) => {
        if (left.length === 0 || right.length === 0) return 0;
        const a = bigramCounts(left);
        const b = bigramCounts(right);
        let overlap = 0;
        let total = 0;
        for (const [gram, count] of a) {
          overlap += Math.min(count, b.get(gram) ?? 0);
          total += count;
        }
        for (const count of b.values()) total += count;
        return total === 0 ? 0 : (2 * overlap) / total;
      };
      let promptEntriesPromise = null;
      const promptEntries = async () => {
        if (promptEntriesPromise === null) {
          promptEntriesPromise = (async () => {
            const entries = [];
            for (const document of (await projectDirector.readDocuments())?.documents ?? []) {
              const read = await reader.readShots(document.relativePath, { reconcile: false }).catch(() => null);
              if (read === null) continue;
              const episodeMatch = /第\s*(\d+)\s*集/u.exec(String(document.relativePath ?? ''));
              for (let index = 0; index < read.shots.length; index += 1) {
                const metadataShot = document.shots?.[index];
                const text = normalizedPromptText(read.shots[index]?.text);
                if (text.length === 0) continue;
                entries.push({
                  shotId: typeof metadataShot?.shotId === 'string' ? metadataShot.shotId : null,
                  episode: episodeMatch === null ? null : Number(episodeMatch[1]),
                  blockNumber: Number.isInteger(metadataShot?.displayNumber) ? metadataShot.displayNumber : index + 1,
                  text,
                });
              }
            }
            return entries;
          })();
        }
        return await promptEntriesPromise;
      };
      const enrichLegacyCandidates = async (list) => {
        const needsRecovery = list.some((candidate) => typeof candidate.shotId !== 'string'
          || !Number.isInteger(candidate.episodeNumber)
          || !Number.isInteger(candidate.blockNumber));
        if (!needsRecovery) return list;
        const entries = await promptEntries();
        const byText = new Map();
        for (const entry of entries) {
          const matches = byText.get(entry.text) ?? [];
          matches.push(entry);
          byText.set(entry.text, matches);
        }
        const ledger = createJobStore();
        const enriched = [];
        for (const candidate of list) {
          if (typeof candidate.shotId === 'string'
            && Number.isInteger(candidate.episodeNumber)
            && Number.isInteger(candidate.blockNumber)) {
            enriched.push(candidate);
            continue;
          }
          let recovered = candidate;
          try {
            const job = await ledger.read(candidate.jobId);
            const requestPath = typeof job?.output === 'string' && job.output.length > 0
              ? join(job.output, 'request.json')
              : null;
            if (requestPath !== null) {
              const request = JSON.parse(await readFile(requestPath, 'utf8'));
              const requestText = normalizedPromptText(request?.text);
              let matches = byText.get(requestText) ?? [];
              if (matches.length === 0 && requestText.length > 0) {
                const scored = entries
                  .map((entry) => ({ entry, score: promptSimilarity(requestText, entry.text) }))
                  .sort((left, right) => right.score - left.score);
                const best = scored[0];
                if (best !== undefined && best.score >= 0.9) {
                  // Keep every source variant tied to the same episode/block, but never fold two
                  // different positions into one just because both are similar to the request.
                  matches = scored
                    .filter((row) => row.score >= Math.max(0.9, best.score - 0.005))
                    .map((row) => row.entry);
                }
              }
              const positions = new Map();
              for (const entry of matches) {
                if (!Number.isInteger(entry.episode) || !Number.isInteger(entry.blockNumber)) continue;
                positions.set(`${entry.episode}:${entry.blockNumber}`, entry);
              }
              if (positions.size === 1) {
                const [match] = positions.values();
                recovered = {
                  ...candidate,
                  shotId: typeof candidate.shotId === 'string' ? candidate.shotId : match.shotId,
                  episodeNumber: Number.isInteger(candidate.episodeNumber) ? candidate.episodeNumber : match.episode,
                  blockNumber: Number.isInteger(candidate.blockNumber) ? candidate.blockNumber : match.blockNumber,
                  recoveredFromRequest: true,
                };
              }
            }
          } catch {
            // Recovery is best effort; an unmatched candidate remains visible in 结果 with its
            // produced filename instead of being assigned to a shot by position.
          }
          enriched.push(recovered);
        }
        return enriched;
      };
      /** Episode and 大分镜 for a candidate: what the run recorded, else the shot record. */
      const positionOf = (candidate) => {
        const info = candidate.shotId === null || candidate.shotId === undefined ? undefined : shotInfoById.get(candidate.shotId);
        return {
          episode: Number.isInteger(candidate.episodeNumber) ? candidate.episodeNumber : (info?.episode ?? null),
          block: Number.isInteger(candidate.blockNumber) ? candidate.blockNumber : (info?.blockNumber ?? null),
        };
      };
      /**
       * The generation ordinal for one candidate: "is this my first or second try at that block?"
       *
       * Counted oldest-first within the same (episode, block), the only ordering a user can check
       * against what they remember doing. Keyed that way rather than by shotId so it stays
       * meaningful for a candidate recorded before shot ids existed.
       */
      const ordinalAmong = (all, candidate) => {
        const position = positionOf(candidate);
        const key = `${position.episode ?? '-'}/${position.block ?? '-'}`;
        const siblings = all
          .filter((entry) => { const other = positionOf(entry); return `${other.episode ?? '-'}/${other.block ?? '-'}` === key; })
          .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));
        const at = siblings.findIndex((entry) => entry.candidateId === candidate.candidateId);
        return at < 0 ? siblings.length + 1 : at + 1;
      };

      if (resultAction === 'record') {
        // The one entry point for "this generated file is now a candidate". `comfy_run` calls the
        // same action rather than copying files itself, because a second recording path would be
        // a second place for the candidate rules to live - and the two would drift.
        const produced = Array.isArray(payload.files) ? payload.files : (typeof payload.file === 'string' ? [payload.file] : []);
        if (produced.length === 0) throw new Error('results with resultAction=record needs file, or files with several paths');
        if (typeof payload.jobId !== 'string' || payload.jobId.length === 0) throw new Error('results with resultAction=record needs jobId, so a result can be traced back to the run that made it');
        const recorded = [];
        const rejected = [];
        for (const entry of produced) {
          try {
            const candidate = await store.record({
              jobId: payload.jobId,
              shotId: typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : null,
              sourcePath: isAbsolute(entry) ? entry : join(projectRoot, entry),
              producedName: payload.producedName ?? basename(entry),
              role: payload.role ?? null,
              note: payload.note ?? null,
            });
            recorded.push(candidate);
          } catch (error) {
            // One unusable file must not discard the others: a run that produced three images
            // where one has an unexpected extension should still yield the two that are usable.
            rejected.push({ file: entry, reason: String(error?.message ?? error), code: error?.code ?? null });
          }
        }
        return { project: name, projectRoot, resultAction, candidates: recorded, rejected, stats: await store.stats() };
      }
      if (resultAction === 'select') {
        if (typeof payload.candidateId !== 'string' || payload.candidateId.length === 0) throw new Error('results with resultAction=select needs candidateId');
        const selected = await store.select(payload.candidateId, { note: payload.note ?? null });
        return { project: name, projectRoot, resultAction, selected };
      }
      if (resultAction === 'redo') {
        // Re-run one candidate's generation with the SAME inputs.
        //
        // The plan comes from the ledger snapshot rather than from the current asset library,
        // because "the same inputs" means the files that produced this image - and the library
        // has moved on since. Resolving the mentions again would silently regenerate from
        // whatever is newest, which is a different picture.
        //
        // Nothing is submitted here. Starting a GPU job is a decision the conversation makes,
        // with the user watching; a button that starts one behind their back would be the
        // opposite of that, and would also make the panel a second submission path.
        if (typeof payload.candidateId !== 'string' || payload.candidateId.length === 0) throw new Error('results with resultAction=redo needs candidateId');
        const candidates = await store.list({});
        const candidate = candidates.find((entry) => entry.candidateId === payload.candidateId);
        if (candidate === undefined) throw new Error(`no result candidate ${payload.candidateId}`);
        const ledger = createJobStore();
        const job = await ledger.read(candidate.jobId);
        if (job === undefined) {
          throw new Error(`the ledger no longer holds ${candidate.jobId}, so its inputs cannot be recovered. The instance and workflow are unknown; start this shot again from the storyboard instead`);
        }
        const inputs = (job.plan?.inputs ?? []).map((input) => ({ fileName: input.fileName ?? null, localPath: input.localPath ?? null, sha256: input.sha256 ?? null }));
        return {
          project: name,
          projectRoot,
          resultAction,
          redoOf: candidate.candidateId,
          sourceJobId: candidate.jobId,
          workflow: job.plan?.workflow ?? null,
          instanceId: job.plan?.instanceId ?? null,
          patch: job.plan?.patch ?? null,
          shotId: candidate.shotId,
          inputs,
          instructions: `Run comfy_run with workflow ${String(job.plan?.workflow ?? '?')}, pass inputs keyed by node id, and pass resultsProjectRoot ${projectRoot} so the output is recorded as a new candidate beside this one. The inputs listed above are the exact files this image was made from.`,
        };
      }
      if (resultAction === 'promote') {
        if (typeof payload.candidateId !== 'string' || payload.candidateId.length === 0) throw new Error('results with resultAction=promote needs candidateId');
        // U4: 「存到本集」. The user's words were "改成存到每一集的文件夹里面，不用去资产了" - so the
        // destination is DERIVED from the candidate's own episode and block, and nothing is asked.
        // A destination may still be passed explicitly (the old behaviour, and the only way to file
        // something the candidate has no position for).
        let destination = typeof payload.destination === 'string' ? payload.destination.replace(/\\/gu, '/').trim() : '';
        let toEpisode = false;
        if (destination.length === 0) {
          const all = await enrichLegacyCandidates(await store.list({}));
          const candidate = all.find((entry) => entry.candidateId === payload.candidateId);
          if (candidate === undefined) throw new Error(`no result candidate ${payload.candidateId}`);
          const { episode, block } = positionOf(candidate);
          if (!Number.isInteger(episode)) {
            throw new Error('这条候选没有记录集数，无法存到本集。请用 destination 指定路径，或重新生成一次（生成时会记录集数）。');
          }
          // The same ordinal the grid displays, so the file on disk and the label in the panel are
          // the same name: both are derived from the candidate list by the same rule.
          const attempt = ordinalAmong(all, candidate);
          const extension = extname(String(candidate.fileName ?? candidate.relativePath ?? ''));
          const blockNumber = Number.isInteger(block) ? block : 1;
          const stem = resultNameFor({ code: projectCode, episode, block: blockNumber, attempt, extension: extension.length > 0 ? extension : null })
            ?? `${String(name).trim() || 'project'}_第${episode}集_大分镜${blockNumber}(${attempt})${extension}`;
          // 成片/, not 本集所需资产/: the latter holds reference material that generation READS,
          // while this is the finished clip a person watches. Mixing them makes a regenerated
          // reference and a finished film look the same in the folder.
          destination = `剧集/第${episode}集/成片/${stem}`;
          toEpisode = true;
        }
        if (destination.length === 0) throw new Error('results with resultAction=promote needs a destination, or a candidate with a recorded episode');
        const to = await store.promote(payload.candidateId, join(projectRoot, destination), { overwrite: payload.overwrite === true, requireSelected: !toEpisode });
        // 存到本集 does NOT go through the asset tree, so the asset-side selection is left alone:
        // running a scan and a select for a file outside 资产/ was both slow and misleading.
        if (toEpisode) {
          return {
            project: name,
            projectRoot,
            resultAction,
            promotedTo: to,
            savedTo: destination,
            toEpisode: true,
            selection: null,
            selectionNote: '已存到本集，不进资产目录（资产面板不会新增条目）。',
          };
        }
        // Point the ASSET side's selection at the file that just arrived. Otherwise the copy
        // succeeds, the asset view still reports the previous version as the one in use, and the
        // user selects the same file a second time for no reason they can see - which is exactly
        // the gap between the two selection models.
        //
        // A scan is attempted second because a file written a moment ago is not in the index yet;
        // that is a normal first-attempt outcome, not a failure.
        let selection = null;
        let selectionNote = null;
        const relativeDestination = destination;
        for (const attempt of ['first', 'after-scan']) {
          try {
            const scoped = createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy));
            if (attempt === 'after-scan') await scoped.refresh();
            selection = await scoped.selectByPath(relativeDestination);
            selectionNote = null;
            break;
          } catch (error) {
            if (error?.code !== 'NOT_INDEXED') { selectionNote = String(error?.message ?? error); break; }
            selectionNote = 'the file is in the asset tree but the library has not indexed it yet; run assets with assetAction=refresh';
          }
        }
        return { project: name, projectRoot, resultAction, promotedTo: to, selection, selectionNote };
      }
      if (resultAction === 'prune') {
        const outcome = await store.prune({ keepSelected: payload.keepSelected !== false, before: payload.before ?? null });
        return { project: name, projectRoot, resultAction, ...outcome };
      }
      if (resultAction === 'undo-prune') {
        const outcome = await store.undoPrune(typeof payload.batchId === 'string' && payload.batchId.length > 0 ? payload.batchId : null);
        return {
          project: name,
          projectRoot,
          resultAction,
          ...outcome,
          stats: await store.stats(),
        };
      }
      const candidates = await enrichLegacyCandidates(await store.list({
        shotId: typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : null,
        jobId: typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : null,
        status: typeof payload.status === 'string' && payload.status.length > 0 ? payload.status : null,
      }));
      // A readable name for every candidate: `<代号>_<集>_<块>(<第k次>)`.
      //
      // The instance's own file names (`YZ_H3__00003-audio.mp4`) say nothing about what a
      // candidate IS, so in a grid of attempts the user cannot tell which shot it belongs to
      // without opening each one. The name is derived at READ time rather than stored, so it
      // also applies to candidates recorded before this existed - and so it follows a renamed
      // project instead of freezing the old title into the record.
      const allForOrdinal = [...candidates];
      const ordered = allForOrdinal.sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));
      const displayNameFor = (candidate) => {
        const { episode, block } = positionOf(candidate);
        // A candidate nobody attached to a shot keeps its produced name: inventing a place for it
        // would be a claim about which shot it belongs to, and that is exactly what is unknown.
        if (episode === null && block === null) return null;
        const next = ordinalAmong(allForOrdinal, candidate);
        // U3: one assembly point (`lib/result-naming`), shared with the on-disk name a promote
        // writes. With a project code the result is `code_1_1(1)`; without one it is the readable
        // Chinese form - never an invented code, because a wrong code reads as authoritative.
        const compact = resultNameFor({ code: projectCode, episode: episode ?? 1, block: block ?? 1, attempt: next });
        if (compact !== null) return compact;
        return readableNameFor({ projectName: name, episode: episode ?? 1, block: block ?? 1, attempt: next });
      };
      for (const candidate of ordered) {
        const displayName = displayNameFor(candidate);
        if (displayName !== null) candidate.displayName = displayName;
      }
      // A thumbnail per image candidate, so a wall of twenty costs a wall of thumbnails rather
      // than twenty full-resolution stills. A video gets none: extracting a frame needs an
      // encoder this plugin does not ship, and the media element already shows a first frame
      // from the metadata it preloads.
      const thumbs = createThumbnailStore(projectRoot, { media, fs, getPolicy });
      const withThumbs = [];
      for (const candidate of candidates) {
        let thumbnailHandle = null;
        try {
          const thumb = await thumbs.ensure({
            sourcePath: join(projectRoot, candidate.relativePath),
            fileName: candidate.fileName,
            sha256: candidate.sha256,
            bytes: candidate.bytes,
          });
          if (thumb !== null && thumb.handle !== null) thumbnailHandle = thumb.handle;
        } catch {
          // A candidate that cannot be scaled is still a candidate.
        }
        withThumbs.push({ ...candidate, thumbnailHandle });
      }
      return { project: name, projectRoot, resultAction, stats: await store.stats(), candidates: withThumbs };
    }
    case 'jobs': {
      // The generation ledger, for the panel's task area. Read from disk rather than from
      // process memory, so a job started in an earlier session - or by `comfy_run` in the
      // conversation - appears here too. That is the point: the panel and the conversation
      // share one ledger, not two sets of bookkeeping that drift.
      const ledger = createJobStore();
      const requested = typeof payload.state === 'string' && payload.state.length > 0 ? payload.state : null;
      const requestedJobId = typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : null;
      const requestedRequestId = typeof payload.requestId === 'string' && payload.requestId.length > 0
        ? payload.requestId
        : null;
      let all = requestedJobId !== null
        ? [await ledger.read(requestedJobId)].filter(Boolean)
        : requestedRequestId !== null
          ? [await ledger.findByRequestId(requestedRequestId)].filter(Boolean)
          : await ledger.list({ state: requested, limit: Number.isInteger(payload.limit) ? payload.limit : 24 });
      if (payload.refresh === true) {
        const refreshable = new Set([
          'intent',
          'submitting',
          'queued',
          'running',
          'completed',
          'downloading',
          'download_failed',
          'submission_unknown',
        ]);
        all = await Promise.all(all.map(async (job) => {
          if (typeof job?.jobId !== 'string'
            || (requestedJobId === null && requestedRequestId === null && !refreshable.has(String(job.state ?? '')))) return job;
          try {
            return await refreshLedgerJob(job.jobId, {
              config: config ?? {},
              signal,
              fs,
              getPolicy,
            }) ?? job;
          } catch {
            // A temporarily unreachable instance must not erase the last known ledger state.
            return job;
          }
        }));
      }
      return {
        jobs: all.map((job) => ({
          jobId: job.jobId ?? null,
          requestId: job.requestId ?? null,
          corrupt: job.corrupt === true,
          state: job.state ?? 'unknown',
          // Kept apart deliberately: the instance finishing, the file being saved, and the
          // user having chosen something are three different facts.
          promptId: job.promptId ?? null,
          name: job.name ?? null,
          shotId: job.shotId ?? null,
          projectId: job.projectId ?? null,
          instanceId: job.instanceId ?? null,
          workflow: job.plan?.workflow ?? null,
          // The frozen snapshot of what this run WAS, recorded at submit time.
          inputs: (job.plan?.inputs ?? []).map((input) => ({ fileName: input.fileName ?? null, sha256: input.sha256 ?? null })),
          referenceIds: job.plan?.referenceIds ?? null,
          saved: Array.isArray(job.saved) ? job.saved : [],
          files: (Array.isArray(job.files) ? job.files : []).map((file) => {
            const value = file !== null && typeof file === 'object' ? file : { path: file };
            const path = typeof value.path === 'string' ? value.path : '';
            let mediaHandle = null;
            try {
              mediaHandle = typeof media?.mint === 'function' && path.length > 0
                ? media.mint(path)
                : null;
            } catch {
              // Saved output outside this session's media roots has no preview handle.
            }
            return {
              ...value,
              path,
              name: path.length > 0 ? basename(path) : null,
              mediaType: path.length > 0 ? mediaTypeFor(path) ?? null : null,
              mediaHandle,
            };
          }),
          note: job.note ?? null,
          refreshError: job.refreshError ?? null,
          resolution: job.resolution ?? null,
          createdAt: job.createdAt ?? null,
          updatedAt: job.updatedAt ?? null,
          events: (job.events ?? []).map((event) => ({ at: event.at ?? null, state: event.state ?? null, note: event.note ?? null })),
        })),
      };
    }
    case 'references': {
      // Resolve the `@资产` mentions in one block into bindings to concrete file versions. The
      // TEXT IS NEVER REWRITTEN: the chosen version lives in the binding record, because
      // rewriting the user's sentence on a version change is what makes a prompt
      // un-reviewable. Text in; bindings plus the ordered upload list out.
      const name = typeof payload.project === 'string' && payload.project.trim().length > 0
        ? payload.project.trim()
        : null;
      if (name === null) throw new Error('references needs the project name');
      const projectRoot = projectRootFor(name);
      const director = createDirectorStore(fs, projectRoot, getPolicy);
      const library = createAssetLibrary(director);
      if ((await library.rows({ includePlanned: false })).length === 0 && payload.refresh !== false) {
        // A project that has never been scanned has no assets to resolve against, and an empty
        // library would report every mention as missing - a misleading answer that sends the
        // user looking for a typo in a name that is perfectly correct.
        await library.refresh();
      }
      const assets = await library.rows({ includePlanned: false });

      let text = typeof payload.text === 'string' ? payload.text : null;
      let locator = null;
      let referenceSlots = Array.isArray(payload.referenceSlots) ? payload.referenceSlots : null;
      let recordedReferences = null;
      // The file's preamble carries the 资产映射 section, which is where the @ mentions live in a
      // real project. It is part of what this block refers to, so it is prepended to the text that
      // gets RESOLVED - while the block's own text stays untouched for display and for saving.
      //
      // Without this, every block of a real prompt file resolved to zero references while the file
      // named five assets in plain sight: the panel showed no reference images, and a generation
      // would have uploaded nothing.
      let context = '';
      if (text === null) {
        if (typeof payload.file !== 'string') throw new Error('references needs file (with shotId or index) or text');
        const scoped = createReader(fs, root, getPolicy, { director });
        const shots = (await scoped.readShots(payload.file)).shots;
        const index = Number.isInteger(payload.index)
          ? payload.index
          : shots.findIndex((entry) => entry.shotId === payload.shotId);
        if (index < 0 || shots[index] === undefined) {
          throw new Error(`no block ${String(payload.shotId ?? payload.index)} in ${payload.file}`);
        }
        text = shots[index].text;
        context = String(shots[index].preamble ?? '');
        locator = { file: payload.file, index, shotId: shots[index].shotId ?? null };
        recordedReferences = Array.isArray(shots[index].references) ? shots[index].references : null;
        if (referenceSlots === null) referenceSlots = shots[index].referenceSlots ?? [];
      }
      else if (typeof payload.file === 'string' && Number.isInteger(payload.index)) {
        // The panel sends the draft text, so this branch must still resolve the block's identity.
        // Reading through the outer (workspace-rooted) reader returned `shotId: null` and made
        // every resolved reference unrecordable, which is why a reopened panel forgot choices and
        // had to ask again.
        const { director: scopedDirector } = directorForPath(payload.file, payload.project);
        const scoped = createReader(fs, root, getPolicy, { director: scopedDirector });
        // The panel already sends the stable id with the draft. A presentation-only reference
        // resolve must not reconcile metadata and advance the document revision behind an
        // in-flight save; doing so made two rapid structural edits conflict with each other.
        const targetInfo = await fs.stat(await fs.resolve(payload.file, { cwd: root })).catch(() => undefined);
        const read = targetInfo?.type === 'file'
          ? await scoped.readShots(payload.file, { reconcile: false })
          : { shots: [] };
        const shot = read.shots[payload.index];
        context = String(shot?.preamble ?? '');
        recordedReferences = Array.isArray(shot?.references) ? shot.references : null;
        if (shot !== undefined) {
          let stableShotId = typeof payload.shotId === 'string' && payload.shotId.length > 0
            ? payload.shotId
            : null;
          if (stableShotId === null && scopedDirector !== undefined) {
            // `reconcile:false` deliberately does not re-derive identities, but the recorded
            // document still knows which stable id belongs to this block. Read it without touching
            // the revision, so an ordinary preview resolve cannot invalidate a queued save.
            try {
              const target = await fs.resolve(payload.file, { cwd: root });
              const storedPath = relative(scopedDirector.root, target?.targetKey ?? payload.file).replace(/\\/gu, '/');
              const stored = (await scopedDirector.readDocuments()).documents
                .find((document) => samePath(document.relativePath, storedPath));
              stableShotId = stored?.shots?.[payload.index]?.shotId ?? null;
            } catch {
              // Keep the reference answer usable; persistence below reports if no id is available.
            }
          }
          locator = {
            file: payload.file,
            index: payload.index,
            shotId: stableShotId,
          };
          if (referenceSlots === null) referenceSlots = shot.referenceSlots ?? [];
        } else {
          // A missing H3 target is a blank editable card, not an error. The panel may upload
          // a slot or resolve a draft there before the first write creates the file. Keep the
          // response usable; persistence begins after the card has a shot identity.
          locator = {
            file: payload.file,
            index: payload.index,
            shotId: typeof payload.shotId === 'string' && payload.shotId.length > 0 ? payload.shotId : null,
          };
        }
      }

      // Offsets from the resolve step are absolute in `resolutionText`. Kept as one variable used
      // by BOTH the build and the validate call, because a mention offset that means one thing to
      // the builder and another to the validator is how a "moved" reference is invented.
      const resolutionText = context.length > 0 ? `${context}\n\n${text}` : text;
      locator = locator === null ? null : { ...locator, sharedContext: context.length > 0 };

      const previous = Array.isArray(payload.known) && payload.known.length > 0
        ? payload.known
        : (recordedReferences ?? []);
      const choices = payload.choices !== null && typeof payload.choices === 'object' && !Array.isArray(payload.choices)
        ? payload.choices
        : {};
      const removeReferenceIds = (Array.isArray(payload.removeReferenceIds) ? payload.removeReferenceIds : [])
        .filter((value) => typeof value === 'string' && value.length > 0)
        .slice(0, 1000);
      // H3 files are dispatched to their OWN parser, all the way through.
      //
      // They are not 大分镜 documents at all: no headings, no `@`, and their references are declared
      // once as `<Subject N> 是 <Picture N> 中的资产名`. Running them through the `@` builder returned
      // zero references for the file the video model is actually fed from, which is why the panel's
      // reference bar was empty and showed no images on an H3 source.
      const sourceEpisodes = typeof payload.file === 'string'
        ? await reader.listEpisodes(name).catch(() => [])
        : [];
      const isH3Source = typeof payload.file === 'string'
        && sourceEpisodes.some((episode) => (episode.sources ?? []).some((source) =>
          source.id?.startsWith('h3') && fileMatches(source.files, payload.file)));
      const isH3 = payload.h3 === true
        || isH3Source
        || (text !== null && (looksLikeH3(text) || (context.length > 0 && looksLikeH3(context)) || looksLikeH3(resolutionText)));
      // For an H3 file, the sibling H3 file of the same episode supplies the asset names its own
      // translated text no longer carries. See buildH3References for why the numbering makes that safe.
      let hint = null;
      if (isH3 && typeof payload.file === 'string') {
        const siblingIds = sourceEpisodes
          .flatMap((episode) => episode.sources)
          .filter((source) => source.id !== 'video' && source.path !== payload.file);
        for (const sibling of siblingIds) {
          const read = await reader.readShots(sibling.path, { reconcile: false }).catch(() => null);
          if (read === null) continue;
          if (!looksLikeH3(read.text)) continue;
          hint = read.text;
          break;
        }
      }
      let built = isH3
        ? buildH3References(text ?? resolutionText, assets, { previous, hint, slots: referenceSlots ?? [] })
        : (typeof payload.validate === 'string'
          ? validateReferences(resolutionText, previous, assets)
          : buildReferences(resolutionText, assets, { previous, choices }));
      // A voice belongs to the person, not to an audio asset the user has to remember to add.
      // Existing explicit audio keeps its slot; the first three voiced characters in appearance
      // order fill whatever Audio slots remain. This adds material-column bindings only and
      // leaves the authored prompt byte-for-byte untouched.
      const withVoices = addCharacterVoicesToReferences(built.references, assets, {
        slots: referenceSlots ?? [],
        h3: isH3,
        text: resolutionText,
      });
      built = {
        ...built,
        references: withVoices.references,
        orderedInputs: withVoices.orderedInputs,
      };
      referenceSlots = withVoices.slots;

      // A video prompt's asset bar is a user decision, not a projection of its current
      // punctuation. Removing `@name` from the prose keeps the selected file; only the
      // explicit asset-card remove action names it in `removeReferenceIds`.
      if (!isH3) {
        const retained = mergeVideoPromptReferences(built.references, previous, { removeReferenceIds });
        built = {
          ...built,
          references: retained.references,
          orderedInputs: retained.orderedInputs,
        };
      }

      // A thumbnail handle per reference, so the bar can SHOW the file a shot is bound to.
      //
      // The record already carried `relativePath`, and the panel must never receive a path - which
      // left the reference bar as text only: a name, a role and a version number. The handbook asks
      // for images precisely here (D01 "重名时显示变体与图片", D02 "可点开预览"), and a character sheet
      // is the one thing a name cannot distinguish: `林晚四视图.png` and `林晚.png` read almost the
      // same and look nothing alike.
      //
      // Best effort: a reference whose thumbnail cannot be produced keeps its text and gets no
      // handle, because a missing preview must not make a binding look broken.
      const thumbs = createThumbnailStore(projectRoot, { media, fs, getPolicy });
      const references = [];
      for (const reference of built.references) {
        let thumbnailHandle = null;
        if (thumbs !== null
          && typeof reference.relativePath === 'string'
          && !/^(?:Audio|Video)$/u.test(String(reference.mediaType ?? ''))
          && !/\.(?:mp4|webm|mov|mkv|mp3|wav|flac|ogg|m4a|aac)$/iu.test(String(reference.fileName ?? ''))) {
          try {
            const thumb = await thumbs.ensure({
              // `relativePath` is relative to the PROJECT, not to the projects root - the asset index
              // stores it that way. Joining it to `root` alone pointed one directory too high, so
              // every thumbnail silently failed and the reference bar stayed imageless even though
              // the mechanism worked.
              sourcePath: join(projectRoot, reference.relativePath),
              fileName: reference.fileName,
              sha256: reference.sha256,
              bytes: reference.bytes,
            });
            if (thumb !== null && thumb.handle !== null) thumbnailHandle = thumb.handle;
          } catch {
            // See above.
          }
        }
        references.push({ ...reference, thumbnailHandle });
      }

      /**
       * Materialise resolved H3 bindings into the panel-owned slot table.
       *
       * The prompt is one way to derive a slot, not the slot's storage. Persisting the binding here
       * means deleting or replacing a sentence in the editor no longer blanks the asset column.
       */
      const effectiveReferenceSlots = (() => {
        if (!isH3) return referenceSlots ?? [];
        const byLabel = new Map();
        for (const slot of referenceSlots ?? []) {
          if (slot === null || typeof slot !== 'object' || typeof slot.label !== 'string') continue;
          byLabel.set(slot.label, slot.mode === 'detached' ? { label: slot.label, mode: 'empty' } : slot);
        }
        for (const reference of references) {
          const label = typeof reference.display === 'string' ? reference.display : '';
          if (!/^<(Picture|Audio|Video)\s+\d+>$/u.test(label)) continue;
          const {
            thumbnailHandle,
            display,
            definition,
            occurrences,
            referenceId,
            ...binding
          } = reference;
          void thumbnailHandle;
          void display;
          void occurrences;
          void referenceId;
          byLabel.set(label, {
            label,
            definition: typeof definition === 'string' ? definition : '',
            mode: 'bound',
            binding,
            ...(reference.autoVoice === true
              ? { autoVoice: true, voiceFor: reference.voiceFor ?? null }
              : {}),
          });
        }
        return [...byLabel.values()];
      })();
      referenceSlots = effectiveReferenceSlots;

      // Record the bindings on the shot, so they survive the panel being closed and reopened.
      // `known` is what the panel passes back on its next resolve, which is how a hand-pinned
      // version stays pinned: without this, every reload decided the binding from scratch and a
      // choice made yesterday was gone today.
      //
      // Best effort, deliberately: a shot with no identity yet (an un-migrated project, or a
      // `text`-only call) has nowhere to write, and refusing to ANSWER a resolution because it
      // could not be stored would make the panel unusable on exactly the projects that need
      // migrating first.
      let recorded = false;
      let recordNote = null;
      if (locator !== null && locator.shotId !== null && typeof payload.file === 'string') {
        try {
          const { director: scoped } = directorForPath(payload.file, name);
          // Metadata keys are relative to the session root and may include the project folder.
          // Normalise only an absolute spelling; otherwise pass the panel's key through unchanged.
          const documentPath = isAbsolute(payload.file)
            ? relative(root, payload.file).replace(/\\/gu, '/')
            : payload.file.replace(/\\/gu, '/');
          await scoped.setShotReferences(documentPath, locator.shotId, references);
          if ((referenceSlots ?? []).length > 0) {
            await scoped.setShotReferenceSlots(documentPath, locator.shotId, effectiveReferenceSlots);
          }
          recorded = true;
        } catch (error) {
          recordNote = String(error?.message ?? error);
        }
      }

      return {
        project: name,
        projectRoot,
        locator,
        recorded,
        recordNote,
        referenceSlots: referenceSlots ?? [],
        references,
        unresolved: built.unresolved ?? [],
        ambiguous: built.ambiguous ?? [],
        changes: built.changes ?? [],
        orderedInputs: built.orderedInputs ?? references.map((reference) => ({
          referenceIndex: reference.referenceIndex,
          assetVersionId: reference.assetVersionId,
          fileName: reference.fileName,
          role: reference.role,
          sha256: reference.sha256,
        })),
      };
    }
    case 'assets': {
      // The asset library, read or refreshed. Scanned from disk and kept as sidecar metadata;
      // no asset file is ever renamed, moved or rewritten by this.
      const name = typeof payload.project === 'string' && payload.project.trim().length > 0
        ? payload.project.trim()
        : null;
      // `projectRootFor` already accepts an absolute project path (the panel's browse picker can
      // select projects outside the design root). Rejecting every `:`/`\` here made the same
      // project readable by `episodes` and `episode-blocks` but impossible to refresh from the
      // asset tab - which surfaced as "没有图片" on a perfectly valid project.
      if (name === null || (!isAbsolute(name) && (name === '.' || name === '..' || /[\\/:\x00-\x1f]/u.test(name)))) {
        throw new Error('assets needs a project folder name or an absolute project path');
      }
      const projectRoot = projectRootFor(name);
      const library = createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy));
      const assetAction = typeof payload.assetAction === 'string' && payload.assetAction.length > 0 ? payload.assetAction : 'list';
      const panelAssets = async (rows, full) => {
        const withMedia = await attachAssetMedia(rows, media, full, projectRoot, fs, getPolicy);
        if (!Number.isInteger(payload.episodeNumber)) return withMedia;
        const episode = (await reader.listEpisodes(name)).find((entry) => entry.number === payload.episodeNumber);
        const used = new Set(full.filter((asset) => (asset.episodeNumbers ?? []).includes(payload.episodeNumber)).map((asset) => asset.assetId));
        const video = episode?.sources.find((source) => source.id === 'video');
        for (const item of video?.files ?? []) {
          const text = await fs.readText(await fs.resolve(item.path, { cwd: root }));
          for (const reference of buildReferences(text, full, {}).references) used.add(reference.assetId);
        }
        return withMedia.map((row) => ({ ...row, usedInEpisode: used.has(row.assetId) }));
      };

      if (assetAction === 'binding') {
        const identifier = payload.assetId ?? payload.asset;
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('从项目资产选择素材需要 assetId');
        }
        const detail = await library.detail(identifier);
        if (detail === undefined) throw new Error(`没有找到资产：${identifier}`);
        const requestedVariant = payload.variantId ?? payload.variantName ?? null;
        let variant = detail.variants.find((entry) =>
          (payload.variantId === undefined || payload.variantId === null || entry.variantId === payload.variantId)
          && (payload.variantName === undefined || payload.variantName === null
            || entry.variantId === payload.variantName
            || entry.name === payload.variantName))
          ?? (requestedVariant === null
            ? (detail.variants.find((entry) => entry.name === detail.identityVariant) ?? detail.variants[0])
            : undefined);
        if (variant === undefined) {
          throw new Error(`资产「${detail.name}」没有指定的变体「${String(requestedVariant)}」`);
        }
        const mediaKind = payload.mediaKind === 'audio' || payload.mediaKind === 'video' ? payload.mediaKind : 'image';
        let file;
        if (mediaKind === 'audio' && detail.kind === 'character') {
          if (payload.assetVersionId === undefined || payload.assetVersionId === null) {
            file = characterVoiceVersion(detail);
          } else {
            for (const candidate of detail.variants ?? []) {
              const found = (candidate.files ?? []).find((entry) =>
                entry.assetVersionId === payload.assetVersionId && entry.role === 'voice');
              if (found === undefined) continue;
              variant = candidate;
              file = found;
              break;
            }
          }
        } else {
          file = payload.assetVersionId === undefined || payload.assetVersionId === null
            ? representativeVersion(variant)
            : (variant.files ?? []).find((entry) => entry.assetVersionId === payload.assetVersionId);
        }
        if (file === undefined || file === null || file.missing === true) {
          throw new Error(mediaKind === 'audio' && detail.kind === 'character'
            ? `人物「${detail.name}」还没有上传音色`
            : `资产「${detail.name}」没有可用的素材文件`);
        }
        const expectedKind = mediaKind === 'audio' ? 'reference-audio' : mediaKind === 'video' ? 'reference-video' : null;
        if (expectedKind !== null && detail.kind !== expectedKind && !(mediaKind === 'audio' && detail.kind === 'character')) {
          throw new Error(`「${detail.name}」不是可用的${mediaKind === 'audio' ? '音频' : '视频'}资产`);
        }
        if (expectedKind === null && !['character', 'scene', 'prop', 'reference-image'].includes(detail.kind)) {
          throw new Error(`「${detail.name}」不是图片资产`);
        }
        if (expectedKind === null && detail.kind === 'character' && file.role === 'voice') {
          throw new Error(`「${detail.name}」选择的是人物音色，不能作为画面参考`);
        }
        const suffix = variant.name === 'default' || variant.name === detail.identityVariant ? '' : `（${variant.name}）`;
        const binding = {
          assetId: detail.assetId,
          assetName: detail.name,
          assetKind: detail.kind,
          variantId: variant.variantId,
          variantName: variant.name,
          assetVersionId: file.assetVersionId,
          role: file.role,
          fileName: file.fileName,
          relativePath: file.relativePath,
          bytes: file.bytes,
          sha256: file.sha256,
          version: file.version,
          bindingState: 'resolved',
          pinned: false,
        };
        if (Number.isInteger(payload.episodeNumber)) {
          await library.useInEpisode(detail.name, detail.kind, payload.episodeNumber);
        }
        return {
          project: name,
          projectRoot,
          assetAction,
          imported: { name: `${detail.name}${suffix}`, kind: detail.kind, assetId: detail.assetId },
          binding,
        };
      }
      if (assetAction === 'create') {
        const created = await library.create({
          kind: payload.kindFilter,
          name: payload.assetName ?? payload.name,
          description: payload.description,
          variantName: payload.variantName,
          episodeNumbers: Number.isInteger(payload.episodeNumber) ? [payload.episodeNumber] : [],
        });
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          created,
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'add-variant') {
        const created = await library.addVariant({
          asset: payload.assetId ?? payload.asset,
          name: payload.variantName,
          description: payload.description,
          episodeNumbers: Number.isInteger(payload.episodeNumber) ? [payload.episodeNumber] : [],
        });
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          created,
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'generate-quadview') {
        const workflowRunner = typeof runWorkflow === 'function' ? runWorkflow : runComfyWorkflow;
        const identifier = payload.assetId ?? payload.asset;
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('生成人物四视图需要 assetId');
        }
        const record = await library.record(identifier);
        const detail = await library.detail(identifier);
        if (record === undefined || detail === undefined) throw new Error(`没有找到人物资产：${identifier}`);
        if (detail.kind !== 'character') throw new Error('只有人物资产可以由定妆照生成四视图');
        const variant = detail.variants.find((entry) => entry.variantId === payload.variantName || entry.name === payload.variantName)
          ?? (payload.variantName === undefined || payload.variantName === null
            ? detail.variants.find((entry) => entry.name === detail.identityVariant) ?? detail.variants[0]
            : undefined);
        if (variant === undefined) throw new Error(`人物「${detail.name}」没有变体「${String(payload.variantName ?? '')}」`);
        const quadviewAction = payload.quadviewAction === 'upscale'
          ? 'upscale'
          : payload.quadviewAction === 'generate' ? 'generate' : 'combined';
        if (quadviewAction === 'upscale') {
          const quadviews = (variant.files ?? []).filter((file) => file.role === 'quadview'
            && file.missing !== true
            && typeof file.relativePath === 'string');
          const latestOf = (files) => files.reduce((best, file) => ((file.version ?? 0) > (best.version ?? 0) ? file : best), files[0]);
          const sourceQuadview = payload.sourceVersionId === undefined || payload.sourceVersionId === null
            ? ((variant.files ?? []).find((file) => file.assetVersionId === variant.selectedVersionId && file.role === 'quadview' && file.missing !== true)
              ?? (quadviews.length > 0 ? latestOf(quadviews) : undefined))
            : quadviews.find((file) => file.assetVersionId === payload.sourceVersionId);
          if (sourceQuadview === undefined) {
            throw new Error(`人物「${detail.name}」的「${variant.name}」还没有可超分的四视图，请先生成或上传四视图`);
          }
          if (config === null || config === undefined) throw new Error('图像生成配置不可用');
          const sourceCandidate = join(projectRoot, sourceQuadview.relativePath);
          const [projectReal, sourceReal] = await Promise.all([realpath(projectRoot), realpath(sourceCandidate)]);
          const sourceRelative = relative(projectReal, sourceReal);
          if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) {
            throw new Error('四视图超出当前项目目录');
          }
          const sourceBytes = await readFile(sourceReal);
          const image = inspectImageBytes(sourceBytes);
          if (!image.ok) throw new Error(`四视图「${sourceQuadview.fileName}」v${String(sourceQuadview.version ?? '?')}：${image.reason}。nothing was submitted and the instance was not contacted, so this cost no GPU time`);
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
          const requestId = assetQuadviewRequestId({
            supplied: payload.requestId,
            prefix: 'asset-quadview-upscale',
            assetId: record.assetId,
            variantId: variant.variantId,
            sourceHash,
          });
          const stageKey = requestId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 100);
          const output = join(projectRoot, '.director', 'character-quadview', record.assetId, stageKey);
          const quadviewPolicy = typeof getPolicy === 'function' ? getPolicy() : undefined;
          const workflowExec = {
            signal,
            ...(quadviewPolicy === undefined || quadviewPolicy === null ? {} : { sandboxPolicy: quadviewPolicy }),
            ...(typeof getPolicy === 'function' ? { getPolicy } : {}),
            agent: { session: { header: { cwd: projectRoot } } },
          };
          const upscale = await workflowRunner({ ...(config ?? {}), ctx }, {
            task: 'upscale-image',
            output,
            resultsProjectRoot: projectRoot,
            name: `${detail.name}（${variant.name}）四视图·3x`,
            requestId,
            upscaleImage: {
              sourcePath: sourceReal,
              factor: 3,
              filenamePrefix: `character-quadview-${record.assetId}-3x`,
            },
          }, workflowExec);
          const upscaled = (upscale.files ?? []).find((file) => String(file.kind).startsWith('image')) ?? null;
          if (upscaled === null) throw new Error(`3 倍超分没有返回可保存的图片（状态：${String(upscale.state ?? 'unknown')}）。四视图原图未修改`);
          const bytes = await readFile(upscaled.path);
          const existing = (variant.files ?? []).find((file) => file.role === 'quadview'
            && file.missing !== true
            && file.sha256 === createHash('sha256').update(bytes).digest('hex')) ?? null;
          let imported = null;
          let targetVersion = existing;
          if (existing === null) {
            imported = await replaceAssetFile({
              fs,
              projectRoot,
              asset: { ...detail, identityFolder: record.identityFolder ?? null, folder: record.folder ?? null },
              variantName: variant.name,
              role: 'quadview',
              fileNameStem: `${detail.name}四视图·3x`,
              fileName: basename(upscaled.path),
              fileDataBase64: bytes.toString('base64'),
              getPolicy,
            });
            await library.refresh();
            const refreshed = await library.detail(record.assetId);
            const refreshedVariant = refreshed?.variants.find((entry) => entry.name === variant.name);
            targetVersion = refreshedVariant?.files.find((file) => file.relativePath === imported.relativePath || file.fileName === imported.fileName) ?? null;
            if (targetVersion === null) throw new Error(`3x 四视图已经落盘到「${imported.relativePath}」，但资产索引没有识别；本次不会重复提交 GPU`);
          }
          await library.select({
            asset: record.assetId,
            variant: variant.name,
            assetVersionId: targetVersion.assetVersionId,
            role: 'generation',
            note: '四视图 3 倍超分结果',
          });
          if (Number.isInteger(payload.episodeNumber)) await library.useInEpisode(detail.name, detail.kind, payload.episodeNumber);
          const rows = await library.list({});
          return {
            project: name,
            projectRoot,
            assetAction,
            generated: {
              assetId: record.assetId,
              assetName: detail.name,
              variantName: variant.name,
              sourceVersionId: sourceQuadview.assetVersionId,
              sourceFileName: sourceQuadview.fileName,
              assetVersionId: targetVersion.assetVersionId,
              fileName: targetVersion.fileName,
              relativePath: targetVersion.relativePath,
              reusedContent: existing !== null,
              jobId: upscale.jobId ?? null,
              promptId: upscale.promptId ?? null,
              state: upscale.state ?? null,
              workflow: upscale.workflow ?? null,
              quadviewFileName: sourceQuadview.fileName,
              upscaleFileName: targetVersion.fileName,
              upscaleJobId: upscale.jobId ?? null,
              upscaleWorkflow: upscale.workflow ?? null,
              upscaled: true,
              recoveredExisting: false,
            },
            imported,
            assets: await panelAssets(rows, await library.rows({})),
          };
        }
        // A published character may still use the 9:16 portrait (`front`) or the legacy
        // single-image role (`primary`). Treat both as the variant's 定妆照. Most costume
        // and state variants in real projects are primary-only, and requiring a second upload
        // before they can produce a four-view is what left those variants stuck without one.
        const portraits = (variant.files ?? []).filter((file) => ['front', 'primary'].includes(file.role)
          && file.missing !== true
          && typeof file.relativePath === 'string');
        const latestOf = (files) => files.reduce((best, file) => ((file.version ?? 0) > (best.version ?? 0) ? file : best), files[0]);
        const frontPortraits = portraits.filter((file) => file.role === 'front');
        const primaryPortraits = portraits.filter((file) => file.role === 'primary');
        const sourcePortrait = payload.sourceVersionId === undefined || payload.sourceVersionId === null
          ? (frontPortraits.length > 0 ? latestOf(frontPortraits) : latestOf(primaryPortraits))
          : portraits.find((file) => file.assetVersionId === payload.sourceVersionId);
        if (sourcePortrait === undefined) {
          throw new Error(`人物「${detail.name}」的「${variant.name}」还没有可用的定妆照，请先上传`);
        }
        if (config === null || config === undefined) throw new Error('图像生成配置不可用');
        const sourcePath = join(projectRoot, sourcePortrait.relativePath);
        const [projectReal, sourceReal] = await Promise.all([realpath(projectRoot), realpath(sourcePath)]);
        const sourceRelative = relative(projectReal, sourceReal);
        if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) {
          throw new Error('定妆照超出当前项目目录');
        }
        const sourceBytes = await readFile(sourceReal);
        const image = inspectImageBytes(sourceBytes);
        if (!image.ok) {
          throw new Error(`定妆照「${sourcePortrait.fileName}」v${String(sourcePortrait.version ?? '?')}：${image.reason}。nothing was submitted and the instance was not contacted, so this cost no GPU time`);
        }
        const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
        const requestId = assetQuadviewRequestId({
          supplied: payload.requestId,
          prefix: 'asset-quadview',
          assetId: record.assetId,
          variantId: variant.variantId,
          sourceHash,
        });
        const stageKey = requestId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 100);
        const output = join(projectRoot, '.director', 'character-quadview', record.assetId, stageKey);
        const quadviewPolicy = typeof getPolicy === 'function' ? getPolicy() : undefined;
        const workflowExec = {
          signal,
          // The panel already resolved THIS session's policy. Re-resolving inside the runner
          // falls back to the deployment workspace-write default even when the user enabled
          // danger-full-access.
          ...(quadviewPolicy === undefined || quadviewPolicy === null ? {} : { sandboxPolicy: quadviewPolicy }),
          ...(typeof getPolicy === 'function' ? { getPolicy } : {}),
          agent: { session: { header: { cwd: projectRoot } } },
        };
        const promptText = await readFourViewPrompt(config);
        if (quadviewAction === 'generate') {
          const generation = await workflowRunner({ ...(config ?? {}), ctx }, {
            task: 'image-edit',
            output,
            resultsProjectRoot: projectRoot,
            name: `${detail.name}（${variant.name}）四视图`,
            requestId,
            characterQuadview: {
              referenceImage: sourceReal,
              promptText,
              filenamePrefix: `character-quadview-${record.assetId}`,
            },
          }, workflowExec);
          const produced = (generation.files ?? []).find((file) => String(file.kind).startsWith('image'));
          if (produced === undefined) {
            throw new Error(`四视图任务还没有返回可保存的图片（状态：${String(generation.state ?? 'unknown')}${generation.jobId === null || generation.jobId === undefined ? '' : `，任务：${String(generation.jobId)}`}）。请在任务页核对；不要直接重复提交`);
          }
          const bytes = await readFile(produced.path);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const existing = (variant.files ?? []).find((file) => file.role === 'quadview'
            && file.missing !== true
            && file.sha256 === sha256) ?? null;
          let imported = null;
          let targetVersion = existing;
          if (existing === null) {
            imported = await replaceAssetFile({
              fs,
              projectRoot,
              asset: { ...detail, identityFolder: record.identityFolder ?? null, folder: record.folder ?? null },
              variantName: variant.name,
              role: 'quadview',
              fileNameStem: `${detail.name}四视图`,
              fileName: basename(produced.path),
              fileDataBase64: bytes.toString('base64'),
              getPolicy,
            });
            await library.refresh();
            const refreshed = await library.detail(record.assetId);
            const refreshedVariant = refreshed?.variants.find((entry) => entry.name === variant.name);
            targetVersion = refreshedVariant?.files.find((file) =>
              file.relativePath === imported.relativePath || file.fileName === imported.fileName) ?? null;
            if (targetVersion === null) throw new Error(`四视图已经落盘到「${imported.relativePath}」，但资产索引没有识别；本次不会重复提交 GPU`);
          }
          await library.select({
            asset: record.assetId,
            variant: variant.name,
            assetVersionId: targetVersion.assetVersionId,
            role: 'generation',
            note: '四视图原图，待 3x 超分',
          });
          if (Number.isInteger(payload.episodeNumber)) await library.useInEpisode(detail.name, detail.kind, payload.episodeNumber);
          const rows = await library.list({});
          return {
            project: name,
            projectRoot,
            assetAction,
            generated: {
              assetId: record.assetId,
              assetName: detail.name,
              variantName: variant.name,
              sourceVersionId: sourcePortrait.assetVersionId,
              sourceFileName: sourcePortrait.fileName,
              assetVersionId: targetVersion.assetVersionId,
              fileName: targetVersion.fileName,
              relativePath: targetVersion.relativePath,
              reusedContent: existing !== null,
              jobId: generation.jobId ?? null,
              promptId: generation.promptId ?? null,
              state: generation.state ?? null,
              workflow: generation.workflow ?? null,
              quadviewFileName: targetVersion.fileName,
              quadviewJobId: generation.jobId ?? null,
              upscaleFileName: null,
              upscaleJobId: null,
              upscaleWorkflow: null,
              upscaled: false,
              recoveredExisting: false,
            },
            imported,
            assets: await panelAssets(rows, await library.rows({})),
          };
        }
        /**
         * Recover an already completed edit+upscale pair before spending GPU time again.
         *
         * Asset four-view used to save its files but fail while recording `assetVersionId`.
         * Those jobs are still valid, and the user should not pay for the same portrait twice.
         * Match on the source portrait hash and the exact character/variant name in the ledger.
         */
        const recentJobs = await createJobStore().list({ limit: 2000 });
        const generationByRequest = new Map(recentJobs
          .filter((job) => typeof job.requestId === 'string' && !job.requestId.endsWith('-upscale'))
          .map((job) => [job.requestId, job]));
        const recoveredUpscale = recentJobs
          .filter((job) => job.state === 'saved'
            && job.name === `${detail.name}（${variant.name}）四视图·3x`
            && typeof job.requestId === 'string'
            && job.requestId.endsWith('-upscale'))
          .find((job) => {
            const base = generationByRequest.get(job.requestId.replace(/-upscale$/u, ''));
            if (base === undefined) return false;
            const matchingSource = quadviewInputMatchesSource(base.plan?.inputs, sourceHash);
            if (!matchingSource) return false;
            return (job.files ?? []).some((file) =>
              typeof file.path === 'string'
              && /\.(?:png|jpe?g|webp)$/iu.test(file.path)
              && String(file.path).replace(/\\/gu, '/').includes('/upscale/'));
          }) ?? null;
        let generation = null;
        let produced = null;
        let upscale = null;
        let upscaled = null;
        if (recoveredUpscale !== null) {
          const recoveredFile = (recoveredUpscale.files ?? []).find((file) =>
            typeof file.path === 'string'
            && /\.(?:png|jpe?g|webp)$/iu.test(file.path)
            && String(file.path).replace(/\\/gu, '/').includes('/upscale/'));
          if (recoveredFile !== undefined && existsSync(recoveredFile.path)) {
            upscaled = { path: recoveredFile.path, fileName: basename(recoveredFile.path), kind: 'image' };
          }
        }
        if (upscaled === null) {
          generation = await workflowRunner({ ...(config ?? {}), ctx }, {
            task: 'image-edit',
            output,
            resultsProjectRoot: projectRoot,
            name: `${detail.name}（${variant.name}）四视图`,
            requestId,
            characterQuadview: {
              referenceImage: sourceReal,
              promptText,
              filenamePrefix: `character-quadview-${record.assetId}`,
            },
          }, workflowExec);
          produced = (generation.files ?? []).find((file) => String(file.kind).startsWith('image'));
          if (produced === undefined) {
            throw new Error(`四视图任务还没有返回可保存的图片（状态：${String(generation.state ?? 'unknown')}${generation.jobId === null || generation.jobId === undefined ? '' : `，任务：${String(generation.jobId)}`}）。请在任务页核对；不要直接重复提交`);
          }
          // A four-view is not finished at its native edit resolution. Run the image-upscale task
          // through the SAME global resolver as every other generation call: its own saved workflow
          // and its own configured local/cloud endpoint. Passing the edit run's base_url here would
          // silently override the user's upscale configuration. The raw four-view stays in the
          // job's result area if the upscale step fails, so a retry can reuse the expensive edit.
          upscale = await workflowRunner({ ...(config ?? {}), ctx }, {
            task: 'upscale-image',
            output: join(output, 'upscale'),
            resultsProjectRoot: projectRoot,
            name: `${detail.name}（${variant.name}）四视图·3x`,
            requestId: `${requestId}-upscale`,
            upscaleImage: {
              sourcePath: produced.path,
              factor: 3,
              filenamePrefix: `character-quadview-${record.assetId}-3x`,
            },
          }, workflowExec);
          upscaled = (upscale.files ?? []).find((file) => String(file.kind).startsWith('image')) ?? null;
        }
        if (upscaled === null) {
          throw new Error(`四视图已生成，但 3 倍超分没有返回可保存的图片（状态：${String(upscale?.state ?? 'unknown')}${upscale?.jobId === null || upscale?.jobId === undefined ? '' : `，任务：${String(upscale.jobId)}`}）。四视图原图保留在任务结果中；修正超分配置后可用同一请求继续`);
        }
        const bytes = await readFile(upscaled.path);
        if (bytes.length === 0) throw new Error('四视图文件是空的，未写入资产库');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const existing = (variant.files ?? []).find((file) => file.role === 'quadview'
          && file.missing !== true
          && file.sha256 === sha256) ?? null;
        let imported = null;
        let targetVersion = existing ?? null;
        if (existing === null) {
          imported = await replaceAssetFile({
            fs,
            projectRoot,
            asset: { ...detail, identityFolder: record.identityFolder ?? null, folder: record.folder ?? null },
            variantName: variant.name,
            role: 'quadview',
            fileName: basename(upscaled.path),
            fileDataBase64: bytes.toString('base64'),
            getPolicy,
          });
          await library.refresh();
          const refreshed = await library.detail(record.assetId);
          const refreshedVariant = refreshed?.variants.find((entry) => entry.name === variant.name);
          targetVersion = refreshedVariant?.files.find((file) =>
            file.relativePath === imported.relativePath
            || file.fileName === imported.fileName) ?? null;
          if (targetVersion === null) {
            throw new Error(`四视图已经落盘到「${imported.relativePath}」，但资产索引没有把它识别成人物版本。`
              + '本次不会再提交 GPU；请刷新资产库后重试，系统会用同一请求复用已生成结果。');
          }
          if (targetVersion !== null) {
            await library.select({
              asset: record.assetId,
              variant: variant.name,
              assetVersionId: targetVersion.assetVersionId,
              role: 'generation',
              note: `由定妆照 ${sourcePortrait.fileName} 生成四视图并 3 倍超分`,
            });
          }
        } else {
          await library.select({
            asset: record.assetId,
            variant: variant.name,
            assetVersionId: existing.assetVersionId,
            role: 'generation',
            note: '同内容四视图已存在，沿用原版本',
          });
        }
        if (Number.isInteger(payload.episodeNumber)) {
          await library.useInEpisode(detail.name, detail.kind, payload.episodeNumber);
        }
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          generated: {
            assetId: record.assetId,
            assetName: detail.name,
            variantName: variant.name,
            sourceVersionId: sourcePortrait.assetVersionId,
            sourceFileName: sourcePortrait.fileName,
            assetVersionId: targetVersion?.assetVersionId ?? null,
            fileName: targetVersion?.fileName ?? imported?.fileName ?? null,
            relativePath: targetVersion?.relativePath ?? imported?.relativePath ?? null,
            reusedContent: existing !== null,
            jobId: generation?.jobId ?? null,
            promptId: generation?.promptId ?? null,
            state: generation?.state ?? (recoveredUpscale === null ? null : 'saved'),
            workflow: generation?.workflow ?? null,
            quadviewFileName: produced?.fileName ?? basename(upscaled.path),
            quadviewJobId: generation?.jobId ?? null,
            upscaleFileName: upscaled.fileName ?? basename(upscaled.path),
            upscaleJobId: upscale?.jobId ?? recoveredUpscale?.jobId ?? null,
            upscaleWorkflow: upscale?.workflow ?? recoveredUpscale?.plan?.workflow ?? null,
            upscaled: true,
            recoveredExisting: recoveredUpscale !== null,
          },
          imported,
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'select') {
        const identifier = payload.assetId ?? payload.asset;
        const assetVersionId = typeof payload.assetVersionId === 'string' ? payload.assetVersionId.trim() : '';
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('选择版本需要 assetId');
        }
        if (assetVersionId.length === 0) throw new Error('选择版本需要 assetVersionId');
        const detail = await library.detail(identifier);
        if (detail === undefined) throw new Error(`没有找到资产：${identifier}`);
        const variant = detail.variants.find((entry) =>
          (payload.variantName === undefined || payload.variantName === null || entry.variantId === payload.variantName || entry.name === payload.variantName)
          && (entry.files ?? []).some((file) => file.assetVersionId === assetVersionId));
        if (variant === undefined) throw new Error(`版本 ${assetVersionId} 不属于该资产变体`);
        const chosen = (variant.files ?? []).find((file) => file.assetVersionId === assetVersionId);
        if (chosen?.missing === true) throw new Error('这个版本的文件已不在磁盘上，不能设为当前输入');
        const selection = await library.select({
          asset: detail.assetId,
          variant: variant.variantId,
          assetVersionId,
        });
        const refreshed = await library.detail(detail.assetId);
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          selection,
          asset: refreshed === undefined ? undefined : await attachVersionMedia(refreshed, media, projectRoot, fs, getPolicy),
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'delete-version') {
        const identifier = payload.assetId ?? payload.asset;
        const assetVersionId = typeof payload.assetVersionId === 'string' ? payload.assetVersionId.trim() : '';
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('删除图片需要 assetId');
        }
        if (assetVersionId.length === 0) throw new Error('删除图片需要 assetVersionId');
        const detail = await library.detail(identifier);
        if (detail === undefined) throw new Error(`没有找到资产：${identifier}`);
        const variant = detail.variants.find((entry) =>
          (payload.variantName === undefined || payload.variantName === null || entry.variantId === payload.variantName || entry.name === payload.variantName)
          && (entry.files ?? []).some((file) => file.assetVersionId === assetVersionId));
        if (variant === undefined) throw new Error(`版本 ${assetVersionId} 不属于该资产变体`);
        const file = (variant.files ?? []).find((entry) => entry.assetVersionId === assetVersionId);
        if (file?.missing === true) {
          if (variant.selectedVersionId === assetVersionId) {
            throw new Error('这个缺失版本仍是当前绑定，不能直接清理；请先选择一个仍存在的版本');
          }
          await library.deleteVersion({
            asset: detail.assetId,
            variant: variant.variantId,
            assetVersionId,
          });
          await library.refresh({ commit: true });
          const refreshed = await library.detail(detail.assetId);
          const rows = await library.list({});
          return {
            project: name,
            projectRoot,
            assetAction,
            removedVersion: {
              assetId: detail.assetId,
              assetName: detail.name,
              variantId: variant.variantId,
              variantName: variant.name,
              assetVersionId,
              fileName: file.fileName,
              trashPath: null,
              removedMissingRecord: true,
            },
            asset: refreshed === undefined ? undefined : await attachVersionMedia(refreshed, media, projectRoot, fs, getPolicy),
            assets: await panelAssets(rows, await library.rows({})),
          };
        }
        if (typeof file?.relativePath !== 'string') {
          throw new Error('这个版本缺少可删除的文件路径');
        }
        if (!file.relativePath.replace(/\\/gu, '/').startsWith('资产/')) {
          throw new Error('只能删除项目资产目录里的文件');
        }
        const [projectReal, sourceReal] = await Promise.all([
          realpath(projectRoot),
          realpath(join(projectRoot, file.relativePath)),
        ]);
        const sourceRelative = relative(projectReal, sourceReal).replace(/\\/gu, '/');
        if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || !sourceRelative.startsWith('资产/')) {
          throw new Error('这个文件超出当前项目资产目录，未删除');
        }
        const trashStamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const trashRelative = `.director/asset-trash/${trashStamp}/${file.assetVersionId}-${basename(file.fileName ?? sourceReal)}`;
        const trashPath = join(projectRoot, ...trashRelative.split('/'));
        await mkdir(join(projectRoot, '.director', 'asset-trash', trashStamp), { recursive: true });
        await rename(sourceReal, trashPath);
        await library.deleteVersion({
          asset: detail.assetId,
          variant: variant.variantId,
          assetVersionId,
        });
        await library.refresh({ commit: true });
        const refreshed = await library.detail(detail.assetId);
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          removedVersion: {
            assetId: detail.assetId,
            assetName: detail.name,
            variantId: variant.variantId,
            variantName: variant.name,
            assetVersionId,
            fileName: file.fileName,
            trashPath: trashRelative,
          },
          asset: refreshed === undefined ? undefined : await attachVersionMedia(refreshed, media, projectRoot, fs, getPolicy),
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'delete') {
        if (payload.confirmed !== true) throw new Error('删除资产需要二次确认；本次没有移动文件或修改资产索引');
        const identifier = payload.assetId ?? payload.asset;
        if (typeof identifier !== 'string' || identifier.trim().length === 0) throw new Error('删除资产需要 assetId');
        const removedAsset = await library.remove(identifier.trim());
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          deleted: true,
          removedAsset,
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'replace') {
        const identifier = payload.assetId ?? payload.asset;
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('替换素材需要 assetId');
        }
        const detail = await library.detail(identifier);
        if (detail === undefined) throw new Error(`没有找到资产：${identifier}`);
        const record = await library.record(identifier).catch(() => undefined);
        let replacementName = payload.fileName;
        let replacementBase64 = payload.fileDataBase64;
        if ((typeof replacementBase64 !== 'string' || replacementBase64.length === 0)
          && typeof payload.sourcePath === 'string' && payload.sourcePath.trim().length > 0) {
          const source = await fs.resolve(payload.sourcePath.trim(), { cwd: root });
          const bytes = typeof fs.readBytes === 'function'
            ? Buffer.from(await fs.readBytes(source))
            : await readFile(source.targetKey);
          replacementBase64 = bytes.toString('base64');
          replacementName = replacementName ?? basename(source.targetKey);
        }
        const imported = await replaceAssetFile({
          fs,
          projectRoot,
          asset: {
            ...detail,
            identityFolder: record?.identityFolder ?? detail.identityFolder ?? null,
            folder: record?.folder ?? detail.folder ?? null,
          },
          variantName: payload.variantName ?? 'default',
          role: payload.role ?? (detail.kind === 'character' ? 'quadview' : detail.kind === 'reference-audio' ? 'voice' : 'primary'),
          fileName: replacementName,
          fileDataBase64: replacementBase64,
          getPolicy,
        });
        await library.refresh();
        // An explicit portrait/image replacement is also the user's choice of the version
        // to use next. Without recording that selection, the detail view could keep showing
        // an older selected version and "generate four-view" would read the wrong portrait.
        const refreshedDetail = await library.detail(identifier);
        const replacedVariant = refreshedDetail?.variants.find((variant) =>
          variant.variantId === imported.variantId
          || variant.name === imported.variantName
          || (imported.variantName === 'default' && variant.name === refreshedDetail.identityVariant));
        const replacedFile = replacedVariant?.files.find((file) => {
          if (file.missing === true) return false;
          const paths = (file.paths ?? [file.relativePath]).map((entry) => String(entry).replace(/\\/gu, '/'));
          if (typeof imported.relativePath === 'string' && paths.includes(imported.relativePath.replace(/\\/gu, '/'))) return true;
          return typeof imported.sha256 === 'string' && file.sha256 === imported.sha256 && file.role === imported.role;
        });
        if (replacedVariant !== undefined && replacedFile !== undefined
          && !(detail.kind === 'character' && imported.role === 'voice')) {
          await library.select({
            asset: identifier,
            variant: replacedVariant.variantId,
            assetVersionId: replacedFile.assetVersionId,
          });
        }
        if (Number.isInteger(payload.episodeNumber)) await library.useInEpisode(detail.name, detail.kind, payload.episodeNumber);
        const rows = await library.list({});
        return {
          project: name,
          projectRoot,
          assetAction,
          imported: {
            ...imported,
            assetVersionId: replacedFile?.assetVersionId ?? null,
            version: replacedFile?.version ?? null,
          },
          assets: await panelAssets(rows, await library.rows({})),
        };
      }
      if (assetAction === 'import') {
        // Hand the import the names the library already knows, so a same-named file cannot become a
        // second asset in another category (the 顾星野 case: a four-view uploaded as 其他参考图片 beside
        // the character of that name, after which every @顾星野 was ambiguous).
        const fullRows = await library.rows({});
        const known = new Map((fullRows ?? []).map((row) => [row.name, row.kind]));
        const supplied = String(payload.fileName ?? (typeof payload.sourcePath === 'string' ? payload.sourcePath.replace(/^.*[\\/]/u, '') : ''));
        const parsedName = parseAssetFileStem(supplied);
        const baseName = parsedName.base || supplied.replace(/\.[^.]+$/u, '');
        const canonicalMatches = (fullRows ?? []).filter((asset) =>
          ['character', 'scene', 'prop'].includes(asset.kind)
          && [asset.name, ...(asset.aliases ?? [])].includes(baseName));
        const explicitTarget = typeof payload.assetId === 'string'
          ? (fullRows ?? []).find((asset) => asset.assetId === payload.assetId)
          : undefined;
        const sameKindMatch = canonicalMatches.find((asset) => asset.kind === payload.kindFilter);
        const mergeTarget = explicitTarget !== undefined
          ? explicitTarget
          : sameKindMatch ?? (canonicalMatches.length === 1 && payload.kindFilter === 'reference-image'
            ? canonicalMatches[0]
            : undefined);
        let importName = payload.fileName;
        let importBase64 = payload.fileDataBase64;
        if (mergeTarget !== undefined
          && (typeof importBase64 !== 'string' || importBase64.length === 0)
          && typeof payload.sourcePath === 'string' && payload.sourcePath.trim().length > 0) {
          const source = await fs.resolve(payload.sourcePath.trim(), { cwd: root });
          const bytes = typeof fs.readBytes === 'function'
            ? Buffer.from(await fs.readBytes(source))
            : await readFile(source.targetKey);
          importBase64 = bytes.toString('base64');
          importName = importName ?? basename(source.targetKey);
        }
        const imported = mergeTarget !== undefined && ['character', 'scene', 'prop'].includes(mergeTarget.kind)
          ? await replaceAssetFile({
            fs,
            projectRoot,
            asset: mergeTarget,
            variantName: parsedName.variantName ?? mergeTarget.identityVariant ?? 'default',
            role: roleOf(supplied),
            fileName: importName ?? supplied,
            fileDataBase64: importBase64,
            getPolicy,
          }).then((row) => ({ ...row, name: row.assetName, kind: row.kind, mergedIntoExisting: true }))
          : await importReference({ fs, projectRoot, payload, getPolicy, known });
        await library.refresh();
        await library.useInEpisode(imported.name, imported.kind, payload.episodeNumber);
        const rows = await library.list({});
        const refreshedAssets = await library.rows({});
        const importedPath = String(imported.relativePath ?? '').replace(/\\/gu, '/');
        // A failed historical upload can leave a file indexed under an older display name.
        // Retrying with a new filename which resolves to the SAME path (or content) must bind
        // that existing version, not look up the new filename, miss, and return binding=null.
        const pathObject = importedPath.length === 0 ? undefined : refreshedAssets.find((asset) =>
          (asset.variants ?? []).some((variant) =>
            (variant.files ?? []).some((file) =>
              (file.paths ?? [file.relativePath])
                .map((entry) => String(entry).replace(/\\/gu, '/'))
                .includes(importedPath))));
        const detail = await library.detail(imported.assetId ?? pathObject?.assetId ?? imported.name).catch(() => undefined);
        const bindingFile = detail === undefined ? undefined : (detail.variants ?? []).flatMap((variant) =>
          (variant.files ?? []).map((file) => ({ ...file, variantId: variant.variantId, variantName: variant.name })))
          .find((file) => {
            if (typeof imported.assetVersionId === 'string' && file.assetVersionId === imported.assetVersionId) return true;
            const paths = (file.paths ?? [file.relativePath]).map((entry) => String(entry).replace(/\\/gu, '/'));
            const wanted = importedPath;
            if (wanted.length > 0 && (paths.includes(wanted) || file.relativePath === wanted)) return true;
            // A content-deduped upload intentionally writes no second file. The index keeps one
            // version whose `paths` can contain several spellings, so content+role is the stable
            // fallback when neither the canonical filename nor path came from the upload.
            return typeof imported.sha256 === 'string'
              && file.sha256 === imported.sha256
              && (imported.role === undefined || file.role === imported.role);
          });
        const binding = detail === undefined || bindingFile === undefined ? null : {
          assetId: detail.assetId,
          assetName: detail.name,
          variantId: bindingFile.variantId,
          variantName: bindingFile.variantName,
          assetKind: detail.kind,
          assetVersionId: bindingFile.assetVersionId,
          role: bindingFile.role,
          fileName: bindingFile.fileName,
          relativePath: bindingFile.relativePath,
          bytes: bindingFile.bytes,
          sha256: bindingFile.sha256,
          version: bindingFile.version,
          bindingState: 'resolved',
          pinned: false,
        };
        const resolvedImported = binding === null ? imported : {
          ...imported,
          name: detail.name,
          assetId: detail.assetId,
          assetName: detail.name,
          assetVersionId: binding.assetVersionId,
          variantId: binding.variantId,
          variantName: binding.variantName,
          role: binding.role,
          relativePath: binding.relativePath,
          fileName: binding.fileName,
          bytes: binding.bytes,
        };
        return { project: name, projectRoot, assetAction, imported: resolvedImported, binding, assets: await panelAssets(rows, refreshedAssets) };
      }
      if (assetAction === 'refresh') {
        const outcome = await library.refresh({ commit: payload.commit !== false });
        return {
          project: name,
          projectRoot,
          assetAction,
          committed: outcome.committed,
          stats: outcome.stats,
          problems: outcome.problems,
          assets: await panelAssets(outcome.assets.map(summarizeAsset), outcome.assets),
        };
      }
      if (assetAction === 'detail') {
        const identifier = payload.asset ?? payload.assetId;
        if (typeof identifier !== 'string' || identifier.trim().length === 0) {
          throw new Error('assets with assetAction=detail needs asset: an id, a name, or an alias');
        }
        const detail = await library.detail(identifier);
        if (detail === undefined) {
          throw new Error(`no asset matches "${identifier}" in ${name}; run assets with assetAction=refresh first, or check the name against the 资产盘点稿`);
        }
        // Awaited, because attaching previews now produces thumbnails. Leaving the `await` off made
        // this return a pending Promise, which JSON-serializes to `{}` - so the detail view came back
        // completely empty with no error anywhere, which is a worse failure than a loud one.
        return { project: name, projectRoot, assetAction, asset: await attachVersionMedia(detail, media, projectRoot, fs, getPolicy) };
      }
      const filter = {
        kind: typeof payload.kindFilter === 'string' && payload.kindFilter.length > 0 ? payload.kindFilter : null,
        query: typeof payload.query === 'string' && payload.query.length > 0 ? payload.query : null,
      };
      let rows = await library.list(filter);
      let full = await library.rows(filter);
      let autoRefreshed = false;
      // An EMPTY library beside a non-empty asset tree is not "you have no assets": it is a
      // library nobody has scanned. Measured consequence: a user generated four images, had them
      // copied into the episodes, opened the panel, and saw nothing - the images were all there,
      // the index was not. Scanning is a read of the project's own folders, so doing it
      // uninvited costs a directory walk and saves a user from believing their work vanished.
      if (assetAction === 'list' && rows.length === 0 && payload.noAutoRefresh !== true) {
        const scanned = await library.refresh({ commit: true }).catch(() => null);
        if (scanned !== null && (scanned.assets ?? []).length > 0) {
          rows = await library.list(filter);
          full = await library.rows(filter);
          autoRefreshed = true;
        }
      }
      // A browser cannot read a filesystem path, so each row also carries an opaque media
      // handle per variant. Resolving the handle is the whole point: the panel never sees,
      // and therefore can never ask for, a path.
      return { project: name, projectRoot, assetAction, assets: await panelAssets(rows, full), autoRefreshed };
    }
    case 'migrate': {
      // Adopting an existing project is explicit and never a side effect: it writes sidecar
      // metadata and allocates identities, so a user has to ask for it. `commit: false`
      // reports what it WOULD do, which is what the panel shows before anything is written.
      const name = typeof payload.project === 'string' && payload.project.trim().length > 0
        ? payload.project.trim()
        : null;
      if (name === null) throw new Error('migrate needs the project name');
      const projectRoot = projectRootFor(name);
      const director = createDirectorStore(fs, projectRoot, getPolicy);
      const plan = await planMigration(projectRoot);
      const commit = payload.commit !== false;
      const summary = await applyMigration(director, plan, { commit });
      return {
        project: name,
        projectRoot,
        committed: commit,
        summary,
        totals: plan.totals,
        problems: plan.problems,
        episodes: plan.episodes.map((episode) => ({
          displayNumber: episode.displayNumber,
          folder: episode.folder,
          script: episode.script,
          sources: episode.sources,
        })),
      };
    }
    case 'progress': {
      // What still needs doing, bucketed by what BLOCKS the user rather than by how far along a shot
      // is. A shot whose assets went missing is reported as missing-assets even if it has a chosen
      // result, because the missing asset is the thing to fix.
      const { director, projectRoot } = directorForPath(null, payload.project);
      if (director === undefined) throw new Error('progress needs the project name');
      let allDocuments = ((await director.readDocuments())?.documents ?? []);
      let productionDocuments = allDocuments.filter((document) => document.kind === 'video'
        || /视频提示词/u.test(String(document.relativePath ?? '')));
      if (productionDocuments.length === 0) {
        // Opening a brand-new project, or a project whose prompt was just split, can reach the
        // progress request before any document metadata exists. Reconcile the visible video
        // prompts once; this never changes prompt text and keeps the strip from reporting 0/0.
        for (const episode of await reader.listEpisodes(payload.project).catch(() => [])) {
          const video = (episode.sources ?? []).find((source) => source.id === 'video');
          for (const file of video?.files ?? []) await reader.readShots(file.path).catch(() => null);
        }
        allDocuments = ((await director.readDocuments())?.documents ?? []);
        productionDocuments = allDocuments.filter((document) => document.kind === 'video'
          || /视频提示词/u.test(String(document.relativePath ?? '')));
      }
      const availableDocumentKinds = [...new Set(allDocuments.map((document) => document.kind ?? 'other'))];
      /**
       * Production progress follows the VIDEO PROMPT, not every prompt version.
       *
       * H3 Chinese and English are separate documents with separate shotIds. Counting all three
       * made one production shot appear three times and left the video row "ready" forever after
       * an H3 run. Candidates/jobs recorded against the H3 shot are brought back by the explicit
       * episode + 大分镜 number that the generator stores beside the run.
       */
      const documents = productionDocuments;
      const requestedEpisode = Number.isInteger(payload.episodeNumber) && payload.episodeNumber > 0
        ? payload.episodeNumber
        : null;
      const scopedDocuments = requestedEpisode === null
        ? documents
        : documents.filter((document) => {
          const match = /(?:^|[\\/])第\s*(\d+)\s*集(?:[\\/]|$)/u.exec(String(document.relativePath ?? ''));
          return match !== null && Number(match[1]) === requestedEpisode;
        });
      // Resolve each shot's @ mentions through the same service the panel uses, so a question asked
      // here and a question asked in the panel cannot give different answers.
      const library = createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy));
      const assets = await library.rows({});
      const shotsByDocument = {};
      for (const document of scopedDocuments) {
        const resolved = await reader.readShots(document.relativePath).catch(() => null);
        shotsByDocument[document.relativePath] = Object.fromEntries((resolved?.shots ?? []).map((shot) => {
          const built = buildReferences(shot.text ?? '', assets, {});
          return [shot.shotId, { unresolved: built.unresolved ?? [], checked: true }];
        }));
      }
      const allJobs = await createJobStore().list({ limit: 2000 });
      // The job ledger is shared by every project. Progress crosses episode/block identities on
      // purpose, so it MUST first fence the ledger to this project or an unrelated run with the
      // same 大分镜 number could make this episode look failed.
      const jobs = allJobs.filter((job) => {
        const candidates = [job.projectId, job.plan?.projectId, job.plan?.resultsProjectRoot];
        return candidates.some((value) => typeof value === 'string' && samePath(value, projectRoot));
      });
      const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
      const storedCandidates = await createResultStore(projectRoot, { media, fs, getPolicy }).list({});
      // Older asynchronous collections recorded the file and job id but omitted the production
      // coordinates. The ledger still has them in the immutable plan, so recover those before
      // scoring progress. This is what keeps a finished H3 out of "generating" and out of
      // "ready" without asking the user to press refresh.
      const candidates = storedCandidates.map((candidate) => {
        const job = jobsById.get(candidate.jobId);
        if (job === undefined) return candidate;
        return {
          ...candidate,
          shotId: typeof candidate.shotId === 'string' && candidate.shotId.length > 0
            ? candidate.shotId
            : (job.shotId ?? job.plan?.shotId ?? null),
          episodeNumber: Number.isInteger(candidate.episodeNumber)
            ? candidate.episodeNumber
            : (job.plan?.episodeNumber ?? job.episodeNumber ?? null),
          blockNumber: Number.isInteger(candidate.blockNumber)
            ? candidate.blockNumber
            : (job.plan?.blockNumber ?? job.blockNumber ?? null),
        };
      });
      // Duration consistency (D09). Read from the TEXT, which stays the only source of truth: this
      // stores nothing, it reports what the text says and where that looks wrong.
      const durationFindings = [];
      for (const document of scopedDocuments) {
        const read = await reader.readShots(document.relativePath).catch(() => null);
        if (read === null) continue;
        const checked = checkDurations({ blocks: read.shots });
        for (const finding of checked.findings) durationFindings.push({ ...finding, document: document.relativePath });
      }
      return {
        project: payload.project,
        projectRoot,
        sourceKind: 'video',
        episodeNumber: requestedEpisode,
        availableDocumentKinds,
        ...buildProgress({ documents: scopedDocuments, shotsByDocument, jobs, candidates }),
        durations: durationFindings,
      };
    }
    case 'settings': {
      // The three answers a production cannot generate without: 画幅 (aspectRatio),
      // 画风 (artStyle), and optionally 分辨率. Read with no patch, written with one.
      //
      // They live on the project (`.director/project.json` → `settings`) rather than in the
      // prompt text, because they are decisions about the WHOLE production: a 9:16 project
      // needs 9:16 character sheets, 9:16 shots and a 9:16 panel preview, and one record
      // means the panel and the agent cannot disagree about which shape that is.
      const { director } = directorForPath(null, payload.project);
      if (director === undefined) throw new Error('settings needs the project name');

      // The tool's parameter names are prefixed (`projectAspectRatio`) so an H3 call's
      // `settings` payload can never be mistaken for a project-wide decision. Map them to
      // the stored keys here, in one place.
      const parameterFor = {
        aspectRatio: 'projectAspectRatio',
        resolution: 'projectResolution',
        artStyle: 'projectArtStyle',
        artStyleNote: 'projectArtStyleNote',
        code: 'projectCode',
      };
      const patch = {};
      const rejected = [];
      for (const [key, parameter] of Object.entries(parameterFor)) {
        if (payload[parameter] === undefined) continue;
        const normalized = normalizeSetting(key, payload[parameter]);
        if (normalized.ok) patch[key] = normalized.value;
        else rejected.push({ key, reason: normalized.reason });
      }
      // Refuse the whole write rather than store half of it: a partially applied change
      // would leave the project in a state nobody asked for, and the caller sees only
      // "saved". One bad field means nothing is written.
      if (rejected.length > 0) {
        return {
          project: payload.project,
          rejected,
          message: `未保存：${rejected.map((entry) => `${SETTING_LABELS[entry.key] ?? entry.key} ${entry.reason}`).join('；')}`,
        };
      }

      const hasPatch = Object.keys(patch).length > 0;
      if (hasPatch) await director.setSettings(patch, { decidedBy: payload.decidedBy ?? 'user' });

      const record = await director.readProject();
      const settings = { ...emptySettings(), ...(record?.settings ?? {}) };
      const missing = missingSettings(settings);
      return {
        project: payload.project,
        projectRoot: director.root ?? null,
        saved: hasPatch,
        settings,
        complete: settingsComplete(settings),
        missing,
        // Enough for the panel to render the controls without hardcoding the option set
        // in a second place, which is how a client and a host drift apart.
        options: {
          aspectRatio: [...ASPECT_RATIOS],
          resolution: [...RESOLUTIONS],
          artStyle: ART_STYLES.map((entry) => ({ id: entry.id, sentence: entry.sentence ?? null, english: entry.english ?? null })),
        },
        styleSentence: styleSentence(settings),
        questions: settingsComplete(settings) ? [] : intakeQuestions().filter((entry) => missing.includes(entry.key)),
      };
    }
    case 'health': {
      const { director, projectRoot } = directorForPath(null, payload.project);
      if (director === undefined) throw new Error('health needs the project name');
      const documents = ((await director.readDocuments())?.documents ?? []);
      const library = createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy));
      const assets = await library.rows({});
      const candidates = await createResultStore(projectRoot, { media, fs, getPolicy }).list({});
      const jobs = await createJobStore().list({ limit: 2000 });
      const report = await buildHealth({ root, projectRoot, documents, candidates, assets, jobs, cacheDirs: ['.director/thumbnails'] });
      /**
       * The mapping belongs INSIDE each 大分镜.
       *
       * `drama-episode-video-prompts` fixes the output order: 画面风格 → 人物映射 → 场景映射 → 道具映射 →
       * 初始站位 → 分镜. A file that puts ONE mapping at the top and none inside its 大分镜 is a
       * deviation the plugin tolerated silently: reference resolution merges the file's preamble
       * into every block, so `@引用` still resolved and nothing looked broken. What does break is
       * the thing a user actually does with a 大分镜 - copy it out on its own. A block lifted from
       * such a file names people and props with no mapping to bind them.
       *
       * Reported per FILE, and only when the pattern is total: a shot with no characters may
       * legitimately omit 【人物映射】, so one block without it proves nothing.
       */
      const mappingFindings = [];
      for (const episode of await reader.listEpisodes(payload.project).catch(() => [])) {
        const video = (episode.sources ?? []).find((source) => source.id === 'video');
        for (const file of video?.files ?? []) {
          const read = await reader.readShots(file.path, { reconcile: false }).catch(() => null);
          const shots = read?.shots ?? [];
          if (shots.length === 0) continue;
          const declaredAbove = shots.some((shot) => /【人物映射】/u.test(String(shot.preamble ?? '')));
          if (!declaredAbove) continue;
          if (shots.some((shot) => /【人物映射】/u.test(String(shot.text ?? '')))) continue;
          mappingFindings.push({
            kind: 'mapping-not-per-block',
            severity: 'warning',
            detail: `${file.file ?? file.path}：映射只写在整集开头，${shots.length} 个大分镜里都没有。规范要求每个大分镜自带本段的【人物映射】【场景映射】【道具映射】——单独复制某一段时，人物和道具就没有绑定了。用 storyboard action=split-episode（write=true）可以拆成自带映射的分大镜文件。`,
          });
        }
      }
      return {
        project: payload.project,
        projectRoot,
        ...report,
        findings: [...(report.findings ?? []), ...mappingFindings],
        clean: (report.findings ?? []).length === 0 && mappingFindings.length === 0,
      };
    }
    case 'diagnose': {
      // A bundle the user can actually send: no prompt text, no file contents, no absolute path, and
      // no tunnel hostname - see the note in episode-report.js for why each is dropped.
      const named = typeof payload.project === 'string' && payload.project.trim().length > 0 ? payload.project : null;
      const { director, projectRoot } = named === null ? { director: undefined, projectRoot: null } : directorForPath(null, named);
      const documents = director === undefined ? [] : ((await director.readDocuments())?.documents ?? []);
      const jobs = await createJobStore().list({ limit: 2000 });
      const assets = projectRoot === null ? [] : await createAssetLibrary(createDirectorStore(fs, projectRoot, getPolicy)).rows({}).catch(() => []);
      const { mode } = await directorContext();
      return {
        // `project` is declared as a string, so a null here made the whole call fail validation
        // ("value.project must be a string") even though the bundle itself was fine. A diagnose
        // with no project is legitimate - it is the "what is broken overall" call - so the field
        // is omitted rather than filled with a placeholder that would then be read as a project.
        ...(named === null ? {} : { project: named }),
        bundle: buildDiagnostic({
          // hostIdentity() carries loadedAt, which is what tells a stale Host from a current one.
          host: { ...hostIdentity(), mode },
          project: projectRoot === null ? null : { name: named, episodes: 0, shots: documents.reduce((sum, entry) => sum + (entry.shots ?? []).length, 0) },
          jobs,
          problems: (await createAssetLibrary(createDirectorStore(fs, projectRoot ?? root, getPolicy)).problems?.() ?? []).map((problem) => String(problem).slice(0, 200)),
          assets: undefined,
        }),
        note: '这个包不含剧本正文、提示词原文、绝对路径和隧道地址，可以直接发给别人。',
        assets: assets.length,
      };
    }
    case 'compile-h3': {
      if (payload.language === 'en') {
        throw new Error('H3 英文功能已停用。分镜工作台和导演流程只生成、修改并使用中文 H3；已有的英文文件不会删除，但不会再自动生成或上传');
      }
      // Compile a 直出视频提示词 into one H3 prompt PER 大分镜.
      //
      // The two files have different jobs, and keeping them distinct is the point: 视频提示词 is what
      // the user EDITS (one document per episode, @资产名 in its mapping so a name is searchable and a
      // picker can complete it), while H3 is what the MODEL is fed (no @ at all - its mapping is
      // <Subject N>/<Picture N>, because the workflow needs a NUMBER per reference slot). H3 also
      // generates 4-15 seconds at a time, which is why one episode becomes one prompt per 大分镜.
      if (typeof payload.file !== 'string') throw new Error('compile-h3 needs file (the 视频提示词 to compile)');
      /**
       * Two jobs, one action - and only ONE of them reads a 视频提示词.
       *
       * `language: 'en'` is a TRANSLATION of the 中文 H3 (that is what the branch below does), so its
       * input is the Chinese H3 document itself. The "not an H3 file" guard ran before that branch
       * existed, so asking the panel for the English version answered with a message about the wrong
       * input format while the correct behaviour sat fifteen lines further down. A refusal that is
       * really a correct request in the wrong shape is the most expensive kind: it looks like a bug
       * in the caller.
       */
      const translateOnly = payload.language === 'en';
      const source = translateOnly ? '' : await fs.readText(await fs.resolve(payload.file, { cwd: root }));
      if (!translateOnly && looksLikeH3(source)) {
        throw new Error('compile-h3 takes a 直出视频提示词, not an H3 file: the @ mapping it reads is what gets compiled INTO H3。H3 英文已停用，中文 H3 直接用于上传和生成');
      }
      const compiled = translateOnly ? null : compileEpisodeToH3(source, {
        // The project's own 画风 when the caller did not name one - see `projectStyleSentence`.
        style: typeof payload.style === 'string' && payload.style.length > 0 ? payload.style : await projectStyleSentence(payload.project),
        language: payload.language === 'en' ? 'en' : 'zh',
        // The asset library is what decides whether a `初始位置参考：@X` names a real file. Without it
        // an unknown name becomes a reference that binds to nothing and is refused at generation.
        knownNames: await assetNameSet(payload.project),
      });
      // Written only when asked. A compile is a read until the caller says otherwise, so looking at
      // what would be produced never touches the episode folder.
      const written = [];
      /**
       * English output must be TRANSLATED, not just re-labelled.
       *
       * `compileEpisodeToH3(..., { language: 'en' })` emits the English FIELD names but leaves the
       * prose in the language it was written in - so writing that straight out produces a file whose
       * `subject_definitions` carries Chinese outside `<d>`, which is the exact validation error
       * users hit. Every block is translated BEFORE anything is written, so a mid-way failure (no
       * model configured, a drifted translation) leaves the episode folder as it was instead of
       * half-updated.
       */
      const texts = [];
      /**
       * English is TRANSLATED FROM THE CHINESE H3, never compiled fresh.
       *
       * The two files are companions: 中文 is what the user edits ("供审阅修改"), 英文 is what the model
       * is fed. Deriving English from the 视频提示词 instead - which this used to do - meant any edit
       * made in the Chinese H3 was silently dropped from the English one, and nothing in the panel
       * said so. The Chinese document is the authority, so it is the source.
       */
      if (payload.language === 'en') {
        const episodesForChinese = await reader.listEpisodes(payload.project);
        const episodeForChinese = episodesForChinese.find((entry) => entry.sources.some((source) => fileMatches(source.files, payload.file) || samePath(source.path, payload.file)));
        const chinese = episodeForChinese?.sources.find((source) => source.id === 'h3-zh');
        const chineseFiles = (chinese?.files ?? [])
          .filter((file) => typeof (file.path ?? file.file) === 'string' && (file.path ?? file.file).length > 0)
          .sort((left, right) => (left.blockNumber ?? 0) - (right.blockNumber ?? 0));
        if (chineseFiles.length === 0) {
          throw new Error('这一集没有中文 H3 文件（形如 第N集H3提示词.txt），没有可翻译的原文。先生成中文版（language=zh），确认内容后再翻译。');
        }
        // `path` is the path the reader resolved; `file` is only the NAME in some callers. Directory
        // operations must use the path, or the target loses its episode folder and the write lands
        // beside the project root.
        const pathOf = (file) => String(file.path ?? file.file ?? '').replace(/\\/gu, '/');
        const dirOf = (file) => pathOf(file).split('/').slice(0, -1).join('/');
        const nameOf = (file) => pathOf(file).split('/').pop() ?? '';
        const episodeNumber = Number.isInteger(episodeForChinese?.number) && episodeForChinese.number > 0
          ? episodeForChinese.number
          : Number(/第(\d+)集/u.exec(String(payload.file ?? '').replace(/\\/gu, '/').split('/').pop() ?? '')?.[1] ?? 1);
        /**
         * TWO shapes of Chinese H3, and only one of them used to work.
         *
         * `compile-h3` writes one document per 大分镜 (`-大分镜K（中文）.txt`), and the translation path was
         * written for exactly that. But a project also legitimately has ONE document holding every block -
         * a hand-written 第1集H3提示词.txt, or one 一键同步 filled before anything was compiled. Its file has
         * no 大分镜 NUMBER IN THE NAME, so `blockNumber` is 0, the old filter threw it away, and asking for
         * the English version answered 「这一集还没有中文 H3」 while a 53 KB Chinese document sat right
         * there. The shape on disk decides the output shape: split in, split out; one document in, one
         * `（英文）` document out.
         */
        const splitFiles = chineseFiles.filter((file) => Number.isInteger(file.blockNumber) && file.blockNumber > 0);
        const plans = [];
        if (splitFiles.length > 0) {
          for (const file of splitFiles) {
            const read = await reader.readShots(file.path);
            const shot = read.shots[0];
            if (shot === undefined) continue;
            plans.push({ target: `${dirOf(file)}/${h3FileName(episodeNumber, file.blockNumber, 'en')}`, body: [{ number: file.blockNumber, text: shot.text }], blockNumber: file.blockNumber });
          }
        } else if (chineseFiles.length === 1) {
          const only = chineseFiles[0];
          const read = await reader.readShots(only.path);
          const shots = read.shots ?? [];
          if (shots.length === 0) throw new Error(`中文 H3 文件里没有可翻译的内容：${pathOf(only)}`);
          // A heading-less H3 is ONE prompt; re-adding `【大分镜1】` would invent structure the file does
          // not have, so the marker is only re-emitted when the source actually used headings.
          const source = await fs.readText(await fs.resolve(only.path, { cwd: root })).catch(() => '');
          const headed = /【\s*大分镜/u.test(String(source ?? ''));
          plans.push({
            target: `${dirOf(only)}/${englishSiblingName(nameOf(only))}`,
            body: shots.map((shot) => ({ number: shot.sourceNumber ?? shot.index + 1, text: shot.text, heading: headed })),
            blockNumber: 0,
          });
        } else {
          throw new Error(`这一集的中文 H3 有 ${String(chineseFiles.length)} 个文件，但文件名里都没有大分镜编号，无法确定哪个对哪个。把名字写成 第N集H3提示词-大分镜K（中文）.txt 这样再试`);
        }
        // Translate everything BEFORE writing anything, so a failure leaves the folder untouched.
        // A one-document episode can hold a dozen-plus blocks. Translating those one at a time both
        // exceeded the tool deadline and made a 53 KB H3 appear permanently stuck; three concurrent
        // calls keep the same atomic result without opening a burst of requests.
        const jobs = plans.flatMap((plan, planIndex) => plan.body.map((entry, bodyIndex) => ({
          planIndex,
          bodyIndex,
          entry,
        })));
        const pieces = await mapConcurrent(jobs, 3, async (job) => {
          const translated = await translateH3(job.entry.text, { ...context, translate: context.translate ?? null });
          return {
            ...job,
            text: job.entry.heading === false
              ? translated
              : `【大分镜${String(job.entry.number)}】\n${translated}`,
          };
        });
        const translatedBlocks = plans.map((plan, planIndex) => ({
          ...plan,
          text: pieces
            .filter((piece) => piece.planIndex === planIndex)
            .sort((left, right) => left.bodyIndex - right.bodyIndex)
            .map((piece) => piece.text)
            .join('\n\n'),
        }));
        const englishWritten = [];
        if (payload.write === true) {
          const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
          for (const block of translatedBlocks) {
            await fs.writeText(await fs.resolve(block.target, { cwd: root }), block.text, undefined, undefined, policy);
            englishWritten.push(block.target);
          }
        }
        return {
          project: payload.project ?? null,
          file: payload.file,
          blockCount: translatedBlocks.length,
          englishCreated: englishWritten,
          englishSkipped: null,
          mapping: { characters: [], scenes: [], props: [] },
          unusedMapping: [],
          unmappedSubjects: [],
          prompts: translatedBlocks.map((block) => ({
            block: block.blockNumber,
            seconds: null,
            pictureCount: null,
            uploadOrder: [],
            subjects: [],
            text: payload.includeText === false ? null : block.text,
          })),
          written: englishWritten,
        };
      }
      for (const prompt of compiled.prompts) texts.push(prompt.text);
      const englishCreated = [];
      const englishSkipped = null;
      if (payload.write === true) {
        const directory = payload.file.replace(/\\/gu, '/').split('/').slice(0, -1).join('/');
        // Episode number from the FILE NAME only.
      //
      // `split('/')` does nothing on a Windows path, so `.pop()` returned the whole path and the FIRST
      // number in it won - `...\_v48temp外卖副本\...\第1集视频提示词.txt` produced episode 48, so split files
      // were written as `第48集大分镜N视频提示词.txt` while the real `第1集…` ones stayed stale.
      // Separators are normalised first, and `第N集` is tried before any bare number.
      const baseName = String(payload.file ?? '').replace(/\\/gu, '/').split('/').pop() ?? '';
      const episodeNumber = Number(/第(\d+)集/u.exec(baseName)?.[1] ?? /(\d+)/u.exec(baseName)?.[1] ?? 1);
        for (const [at, prompt] of compiled.prompts.entries()) {
          const name = h3FileName(episodeNumber, prompt.sourceNumber ?? prompt.blockIndex + 1, payload.language === 'en' ? 'en' : 'zh');
          const relative = `${directory}/${name}`;
          // `getPolicy` is optional in this boundary - a caller that does not resolve a sandbox policy means
          // the tool is being driven directly (tests, the panel's Host side) rather than by a session. The
          // write still goes through the caller's fs, which is where the policy actually applies.
          const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
          await fs.writeText(await fs.resolve(relative, { cwd: root }), texts[at], undefined, undefined, policy);
          written.push(relative);
        }
      }
      return {
        project: payload.project ?? null,
        file: payload.file,
        blockCount: compiled.blockCount,
        /** The English siblings this compile created (empty when they all already existed). */
        englishCreated,
        /** Why no English siblings were created, when that is the case. */
        englishSkipped,
        mapping: {
          characters: compiled.mapping.characters.map((entry) => entry.name),
          scenes: compiled.mapping.scenes.map((entry) => entry.name),
          props: compiled.mapping.props.map((entry) => entry.name),
        },
        // Reported, not repaired: a mapping entry no 大分镜 mentions is either an unused asset or a
        // 大分镜 that failed to name something it uses.
        unusedMapping: compiled.unmatched,
        // Names put on screen that no mapping entry covers. The words cannot be connected
        // automatically (see unmappedSubjects), so this is a question for the user.
        unmappedSubjects: compiled.unmappedSubjects,
        prompts: compiled.prompts.map((prompt) => ({
          block: prompt.sourceNumber,
          seconds: prompt.seconds,
          pictureCount: prompt.pictureCount,
          uploadOrder: prompt.uploadOrder,
          unmappedMentions: prompt.unmappedMentions ?? [],
          subjects: prompt.subjects.map((entry) => ({ subject: entry.subject, picture: entry.picture, name: entry.name, kind: entry.kind })),
          text: payload.includeText === false ? null : prompt.text,
        })),
        // Union of every block's unmapped mentions: the fix is per file (declare them in the mapping),
        // so reporting them once is what the caller needs.
        unmappedMentions: [...new Set(compiled.prompts.flatMap((prompt) => prompt.unmappedMentions ?? []))],
        written,
      };
    }
    case 'review-shot': {
      if (typeof payload.project !== 'string' || payload.project.trim().length === 0) throw new Error('检查镜头需要项目');
      if (!Number.isInteger(payload.episodeNumber) || payload.episodeNumber < 1) throw new Error('检查镜头需要集数');
      if (typeof payload.file !== 'string' || payload.file.trim().length === 0) throw new Error('检查镜头需要提示词文件');
      const episodeNumber = payload.episodeNumber;
      const episodes = await reader.listEpisodes(payload.project);
      const episode = episodes.find((entry) => entry.number === episodeNumber);
      if (episode === undefined) throw new Error(`项目里没有第${String(episodeNumber)}集`);
      const source = (episode.sources ?? []).find((entry) => fileMatches(entry.files, payload.file));
      if (source === undefined) throw new Error(`文件不属于第${String(episodeNumber)}集：${payload.file}`);
      const { director } = directorForPath(payload.file, payload.project);
      const scoped = createReader(fs, root, getPolicy, { director });
      const read = await scoped.readShots(payload.file);
      const shot = (typeof payload.shotId === 'string' && payload.shotId.length > 0
        ? read.shots.find((entry) => entry.shotId === payload.shotId)
        : undefined)
        ?? (Number.isInteger(payload.index) ? read.shots[payload.index] : undefined);
      if (shot === undefined) throw new Error('没有找到要检查的镜头，请刷新分镜后再试');
      const agents = typeof context.ctx?.get === 'function' ? context.ctx.get('agents') : undefined;
      const agent = agents?.get?.(context.sessionId);
      if (agent === undefined || agent === null) throw new Error('当前会话没有可用的导演代理，请重新打开会话再试');
      const projectRoot = projectRootFor(payload.project);
      const sourceId = source.id ?? payload.sourceId ?? 'unknown';
      await updateState((current) => setDirectorContext(current, {
        episodeNumber,
        sourceId,
        shotId: shot.shotId ?? null,
      }));
      const instruction = reviewShotInstruction({
        projectRoot,
        episodeNumber,
        sourceId,
        file: payload.file,
        shotId: shot.shotId,
        blockNumber: shot.displayNumber ?? (shot.index + 1),
      });
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'short-drama-review-shot' },
        }));
      } catch (error) {
        throw new Error(`无法把镜头检查交给导演：${String(error?.message ?? error)}`);
      }
      return {
        queued: true,
        task: 'review-shot',
        episodeNumber,
        sourceId,
        sourceFile: payload.file,
        blockNumber: shot.displayNumber ?? (shot.index + 1),
        instruction,
      };
    }
    case 'model-parse': {
      /**
       * Hand a parsing job to the director model instead of a regex.
       *
       * Used for the two steps that need judgement: re-splitting an episode whose prompt headings the code
       * does not know, and turning a per-block video prompt into H3 (where the wrong reading shows up as
       * structural lines inside `detailed_description`). The deterministic `split-episode` / `compile-h3`
       * stay as they are for the canonical format; this is the route for everything else.
       */
      if (typeof payload.project !== 'string' || payload.project.trim().length === 0) throw new Error('需要项目');
      if (!Number.isInteger(payload.episodeNumber) || payload.episodeNumber < 1) throw new Error('需要集数');
      const task = payload.task === 'h3' ? 'h3' : 'split';
      const episodeNumber = payload.episodeNumber;
      const episodes = await reader.listEpisodes(payload.project);
      const episode = episodes.find((entry) => entry.number === episodeNumber);
      if (episode === undefined) throw new Error(`项目里没有第${String(episodeNumber)}集`);
      const resolveEpisodePath = (path) => (isAbsolute(path) ? path : join(root, path));
      const projectRoot = projectRootFor(payload.project);
      const episodeFolder = resolveEpisodePath(episode.folder);
      const sourceFile = typeof payload.file === 'string' && payload.file.length > 0
        ? resolveEpisodePath(payload.file)
        : join(episodeFolder, `第${String(episodeNumber)}集视频提示词.txt`);
      const agents = typeof context.ctx?.get === 'function' ? context.ctx.get('agents') : undefined;
      const agent = agents?.get?.(context.sessionId);
      if (agent === undefined || agent === null) throw new Error('当前会话没有可用的导演代理，请重新打开会话再试');
      const instruction = modelParseInstruction({ projectRoot, episodeNumber, sourceFile, episodeFolder, task });
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: instruction }],
          source: { kind: task === 'h3' ? 'short-drama-h3-model' : 'short-drama-split-model' },
        }));
      } catch (error) {
        throw new Error(`无法把任务交给导演：${String(error?.message ?? error)}`);
      }
      return { queued: true, task, episodeNumber, sourceFile, instruction };
    }
    case 'split-episode': {
      if (payload.language === 'en') {
        throw new Error('H3 英文功能已停用。拆分只生成中文 H3 正文');
      }
      // Split one episode's 视频提示词 into ONE SELF-CONTAINED FILE PER 大分镜, and optionally compile
      // each of those into its own H3 prompt.
      //
      // The two halves go together because they are the same decision seen twice: the writing skill
      // requires the H3 output to be one prompt per 大分镜 (H3 generates 4-15 seconds at a time), and
      // that is only possible if the 视频提示词 it is compiled FROM is also per 大分镜. Splitting only
      // the H3 leaves the two documents describing different scopes.
      //
      // Each split file repeats the 【人物映射】/【场景映射】/【道具映射】 for the assets THAT 大分镜
      // uses, with the @ kept - so one file can be opened, previewed and compiled on its own.
      if (typeof payload.file !== 'string') throw new Error('split-episode needs file (the episode 视频提示词 to split)');
      const source = await fs.readText(await fs.resolve(payload.file, { cwd: root }));
      if (looksLikeH3(source)) {
        throw new Error('split-episode takes a 直出视频提示词; an H3 file is already per-大分镜');
      }
      // Episode number from the FILE NAME only.
      //
      // `split('/')` does nothing on a Windows path, so `.pop()` returned the whole path and the FIRST
      // number in it won - `...\_v48temp外卖副本\...\第1集视频提示词.txt` produced episode 48, so split files
      // were written as `第48集大分镜N视频提示词.txt` while the real `第1集…` ones stayed stale.
      // Separators are normalised first, and `第N集` is tried before any bare number.
      const baseName = String(payload.file ?? '').replace(/\\/gu, '/').split('/').pop() ?? '';
      const episodeNumber = Number(/第(\d+)集/u.exec(baseName)?.[1] ?? /(\d+)/u.exec(baseName)?.[1] ?? 1);
      const episodeTitle = payload.episodeTitle === undefined ? `第${String(episodeNumber)}集` : payload.episodeTitle;
      // The 画风 is the project's own decision, asked once at intake; a block that carries no style
      // line of its own gets this one rather than nothing. See `projectStyleSentence`.
      const projectStyle = typeof payload.style === 'string' && payload.style.length > 0
        ? payload.style
        : await projectStyleSentence(payload.project);
      /**
       * A missing or foreign block dialect belongs to the MODEL, not to a flattening fallback.
       *
       * `【大分镜N】` means the writer already made the directing decision: the code can reproduce it
       * mechanically. Without that heading, one block is not evidence of one 大分镜 - it is evidence
       * that the template did not emit our identity marker. The model must read the whole generated
       * video prompt and decide the boundaries, including when the document has NO `【…】` headings
       * at all. Silently writing it as `第N集大分镜1…` was the failure this gate exists to prevent.
       */
      const recognisedBlocks = describeBlocks(source).length;
      const hasOurHeading = /【\s*大分镜\s*\d+\s*】/u.test(source);
      if (recognisedBlocks <= 1 && !hasOurHeading) {
        const agents = typeof context.ctx?.get === 'function' ? context.ctx.get('agents') : undefined;
        const agent = agents?.get?.(context.sessionId);
        if (agent === undefined || agent === null) {
          throw new Error('这份视频提示词没有可确认的【大分镜N】边界，必须由导演模型重新分配分镜块；当前会话没有可用的导演模型，未写入任何分块文件');
        }
        const instruction = modelParseInstruction({
          projectRoot: projectRootFor(payload.project),
          episodeNumber,
          sourceFile: payload.file,
          episodeFolder: payload.file.replace(/\\/gu, '/').split('/').slice(0, -1).join('/'),
          task: 'split',
        });
        try {
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: instruction }],
            source: { kind: 'short-drama-split-model' },
          }));
          return {
            queued: true,
            task: 'split',
            episodeNumber,
            sourceFile: payload.file,
            instruction,
            reason: '这份视频提示词没有可确认的【大分镜N】边界，已交给导演模型读取全文并重新分配分镜块',
          };
        } catch (error) {
          throw new Error(`无法把分镜块分配任务交给导演模型：${String(error?.message ?? error)}`);
        }
      }
      const split = splitEpisodePrompt(source, { episodeTitle, episodeNumber, style: projectStyle });
      const directory = payload.file.replace(/\\/gu, '/').split('/').slice(0, -1).join('/');
      const language = 'zh';

      const prompts = [];
      const written = [];
      for (const document of split.documents) {
        // Each split file is compiled on its own, so the H3 prompt count follows the 大分镜 count by
        // construction rather than by matching two lists afterwards.
        const compiled = compileEpisodeToH3(document.text, { style: projectStyle, language });
        const h3 = compiled.prompts[0] ?? null;
        const videoPath = `${directory}/${document.fileName}`;
        const h3Path = `${directory}/${h3FileName(episodeNumber, document.blockNumber, language)}`;
        if (payload.write === true) {
          const policy = typeof getPolicy === 'function' ? getPolicy() : undefined;
          await fs.writeText(await fs.resolve(videoPath, { cwd: root }), document.text, undefined, undefined, policy);
          written.push(videoPath);
          if (h3 !== null) {
            await fs.writeText(await fs.resolve(h3Path, { cwd: root }), h3.text, undefined, undefined, policy);
            written.push(h3Path);
          }
        }
        prompts.push({
          block: document.blockNumber,
          seconds: document.seconds,
          videoFile: videoPath,
          h3File: h3Path,
          assets: document.assets,
          // The two counts are reported side by side because "视频提示词几个大分镜，h3就几个大分镜" is
          // the property being produced, and a silent mismatch would be the failure to catch.
          pictureCount: h3?.pictureCount ?? 0,
          uploadOrder: h3?.uploadOrder ?? [],
          h3Text: payload.includeText === false || h3 === null ? null : h3.text,
          videoText: payload.includeText === false ? null : document.text,
        });
      }
      return {
        project: payload.project ?? null,
        file: payload.file,
        blockCount: split.documents.length,
        prompts,
        written,
        unusedMapping: split.unusedMapping,
        // Reported so the equality the caller cares about is visible rather than inferred.
        videoPromptCount: split.documents.length,
        h3PromptCount: prompts.filter((entry) => entry.pictureCount > 0 || entry.h3Text !== null).length,
      };
    }
    case 'resplit-episode': {
      if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
        throw new Error('重新拆分镜需要项目');
      }
      if (!Number.isInteger(payload.episodeNumber) || payload.episodeNumber < 1) {
        throw new Error('重新拆分镜需要集数');
      }
      const episodeNumber = payload.episodeNumber;
      const episodes = await reader.listEpisodes(payload.project);
      const episode = episodes.find((entry) => entry.number === episodeNumber);
      if (episode === undefined) throw new Error(`项目里没有第${String(episodeNumber)}集`);
      if (typeof episode.script !== 'string' || episode.script.length === 0) {
        throw new Error(`第${String(episodeNumber)}集没有剧本文件，无法重新拆分镜`);
      }
      const resolveEpisodePath = (path) => isAbsolute(path) ? path : join(root, path);
      const projectRoot = projectRootFor(payload.project);
      const scriptPath = resolveEpisodePath(episode.script);
      const episodeFolder = resolveEpisodePath(episode.folder);
      const targetPath = join(episodeFolder, `第${String(episodeNumber)}集视频提示词.txt`);
      const video = (episode.sources ?? []).find((source) => source.id === 'video');
      const currentVideoFiles = (video?.files ?? [])
        .map((entry) => resolveEpisodePath(entry.path ?? entry.file))
        .filter((entry) => typeof entry === 'string' && entry.length > 0);
      const agents = typeof context.ctx?.get === 'function' ? context.ctx.get('agents') : undefined;
      const agent = agents?.get?.(context.sessionId);
      if (agent === undefined || agent === null) {
        throw new Error('当前会话没有可用的导演代理，请先重新打开会话再试');
      }
      const selected = await selectPromptSource(payload.promptSourceId, { skillDir: config?.skillDir });
      const instruction = resplitInstruction({
        projectRoot,
        episodeNumber,
        scriptPath,
        targetPath,
        promptSource: { label: selected.label, file: selected.file },
        currentVideoFiles,
      });
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'short-drama-resplit' },
        }));
      } catch (error) {
        throw new Error(`无法把重新拆分任务交给导演：${String(error?.message ?? error)}`);
      }
      return {
        queued: true,
        episodeNumber,
        script: scriptPath,
        target: targetPath,
        promptSource: {
          selected: selected.selected,
          label: selected.label,
          file: selected.file,
        },
        promptSources: selected.config,
        instruction,
      };
    }
    case 'episode-blocks': {
      // Every 大分镜 of one source, across all of its files, in shooting order.
      //
      // This is the panel's read. `read` answers about ONE file, which was right while a source was
      // one document; now that 视频提示词 and H3 are BOTH one file per 大分镜, a per-file read would
      // make the panel show whichever file happened to be selected and hide the rest - which is the
      // "还是一整块全文" the user was looking at.
      //
      // It also produces the split files when they are missing, so the episode-wide document the user
      // writes is organised into the per-大分镜 shape by opening the panel rather than by running a
      // command. Set organise:false to look without writing.
      if (typeof payload.project !== 'string') throw new Error('episode-blocks needs project');
      if (typeof payload.file !== 'string') throw new Error('episode-blocks needs file (the prompt file to read)');
      const episodes = await reader.listEpisodes(payload.project);
      const kind = episodes.flatMap((episode) => episode.sources).find((source) => samePath(source.path, payload.file) || fileMatches(source.files, payload.file));
      if (kind === undefined) throw new Error(`no prompt source for ${payload.file}`);
      // NOT split on read.
      //
      // An earlier version organised the episode-wide document here, on the theory that opening the
      // panel should produce the per-大分镜 shape without a command. It made a READ write to the project,
      // and that had two costs: two panel opens raced on the same files, and - worse - a later INSERT
      // landed in a file that had just been created rather than in the document the user was looking at.
      // Splitting is a deliberate act (`split-episode`), so this action only reports what is there.
      const files = kind.files;
      const written = [];
      // The file a NEW block belongs in: the 大分镜 with the HIGHEST number.
      //
      // A source spans several files now, and inserting into the source's first one puts a copy of
      // 大分镜2 into 大分镜1's document - where the panel would show it under the wrong heading and the
      // per-大分镜 compile would never see it. Taking the list's LAST entry is not the same thing: the
      // list is sorted by 大分镜 number and the files with no number sort first, but ties fall back to
      // the filename, where 第1集H3提示词… sorts after 第1集大分镜… and the episode-level document would
      // win. The highest numbered block file is unambiguous.
      // `files`, not `kind.files`: the auto-organise step replaced the list, and reading the stale one
      // meant a freshly split episode still reported the episode-level document as the insert target.
      const numbered = files.filter((item) => item.blockNumber > 0);
      const insertTarget = (numbered.length > 0 ? numbered[numbered.length - 1] : files[files.length - 1])?.path ?? payload.file;
      const blockRoot = directorForPath(payload.file, payload.project).projectRoot;
      // Bind the reads to THIS project's metadata. The outer reader is rooted at the session
      // workspace, so it needs this project's director to return shot ids and stored references.
      // The reader keeps the session root because metadata keys are session-relative by design.
      const blockDirector = createDirectorStore(fs, blockRoot, getPolicy);
      const blockReader = createReader(fs, root, getPolicy, { director: blockDirector });
      const blockThumbs = createThumbnailStore(blockRoot, { media, fs, getPolicy });
      // Each reference carries a scaled handle, so the panel can SHOW the file a 大分镜 is bound to.
      // Without it the reference bar is text only, and a name cannot distinguish 林晚四视图.png from
      // 林晚.png - which is what "还是没有图片" was about.
      const withPreview = async (list) => {
        const out = [];
        for (const reference of list) {
          let thumbnailHandle = null;
          if (typeof reference.relativePath === 'string') {
            try {
              const thumb = await blockThumbs.ensure({
                sourcePath: join(blockRoot, reference.relativePath),
                fileName: reference.fileName,
                sha256: reference.sha256,
                bytes: reference.bytes,
              });
              if (thumb !== null && thumb.handle !== null) thumbnailHandle = thumb.handle;
            } catch { /* no preview is not a broken binding */ }
          }
          out.push({ ...reference, thumbnailHandle });
        }
        return out;
      };
      // Read the asset index, never refresh it here.
      //
      // This action runs on every panel open, and refreshing writes assets.json - so opening the panel
      // wrote to the project. Concurrent opens then raced on the atomic rename and one of them failed
      // with EPERM, which is a failure the user would see as "the panel is broken". A refresh belongs
      // to the explicit assets action, where the user asked for it.
      const blockLibrary = createAssetLibrary(blockDirector);
      let blockAssets = (await blockLibrary.load()).assets ?? [];
      if (blockAssets.length === 0) {
        // A brand-new project, or a metadata write that was briefly unavailable, must not make
        // every `@` look missing. A dry-run scan resolves references from the files on disk
        // without writing assets.json; the explicit assets action still owns persistence.
        blockAssets = (await blockLibrary.refresh({ commit: false }).catch(() => null))?.assets ?? [];
      }

      // U1: the 大分镜's duration, for the panel's time selector.
      //
      // An H3 block has no duration of its own - the duration lives in the 视频提示词 the H3 file was
      // compiled from, in the `【大分镜N】` heading. Without it the panel's time selector opened EMPTY,
      // so the user had to pick a duration for every shot even though the shot already stated one.
      // The lookup is "same episode, same block number", which is exactly what `sync-h3` does when it
      // copies a block forward; the values are read, never written.
      const owningEpisode = episodes.find((episode) => episode.sources.some((source) => source === kind || source.id === kind.id));
      const secondsByBlock = new Map();
      const videoSource = owningEpisode?.sources.find((source) => source.id === 'video');
      for (const videoFile of videoSource?.files ?? []) {
        const read = await blockReader.readShots(videoFile.path, { reconcile: false }).catch(() => null);
        for (const [index, shot] of (read?.shots ?? []).entries()) {
          const number = Number.isInteger(shot.sourceNumber) ? shot.sourceNumber : index + 1;
          if (Number.isInteger(shot.seconds) && !secondsByBlock.has(number)) secondsByBlock.set(number, shot.seconds);
        }
      }

      const byNumber = new Map();
      for (const item of files) {
        const read = await blockReader.readShots(item.path).catch(() => null);
        if (read === null) continue;
        const isH3 = looksLikeH3(read.text ?? '');
        for (const [index, shot] of read.shots.entries()) {
          const resolutionText = `${shot.preamble ?? ''}\n${shot.text ?? ''}`;
          let scopedReferences;
          if (isH3) {
            scopedReferences = buildH3References(resolutionText, blockAssets, { slots: shot.referenceSlots ?? [] });
          } else {
            const currentReferences = buildReferences(resolutionText, blockAssets, { previous: shot.references ?? [] });
            const retained = mergeVideoPromptReferences(
              currentReferences.references,
              shot.references ?? [],
            );
            scopedReferences = {
              ...currentReferences,
              references: retained.references,
              orderedInputs: retained.orderedInputs,
            };
          }
          const number = resolveH3BlockNumber({ shot, index, file: item });
          // A dedicated per-大分镜 file wins over the episode-level one; a second file for the same
          // number never replaces it.
          const existing = byNumber.get(number);
          const dedicated = item.blockNumber > 0
            || (isH3 && read.shots.length === 1 && Number.isInteger(shot.sourceNumber));
          if (existing !== undefined && (existing.dedicated || !dedicated)) continue;
          let references = [];
          if (isH3) {
            // H3's references are the file's <Picture N> table, which is the upload order itself.
            references = await withPreview(scopedReferences.references ?? []);
          } else {
            // The @ mentions are in the file's 资产映射 preamble, shared by its blocks. The panel shows
            // them per block, so every block reports the same list plus its own resolved state.
            references = await withPreview(scopedReferences.references ?? []);
          }
          byNumber.set(number, {
            file: item.path,
            fileName: item.file,
            dedicated,
            blockNumber: number,
            index,
            // Own heading first; otherwise the duration the 视频提示词 states for this same block.
            // `secondsFromVideoPrompt` says which one it is, so the panel can show the default
            // without pretending the H3 file carried it.
            seconds: shot.seconds ?? secondsByBlock.get(number) ?? null,
            secondsFromVideoPrompt: shot.seconds === null || shot.seconds === undefined
              ? (secondsByBlock.has(number) ? true : false)
              : false,
            shotId: shot.shotId ?? null,
            h3: isH3,
            referenceSlots: shot.referenceSlots ?? [],
            references,
            unresolved: scopedReferences.unresolved ?? [],
            ambiguous: scopedReferences.ambiguous ?? [],
            orderedInputs: scopedReferences.orderedInputs ?? [],
            revision: read.revision ?? null,
            text: shot.text ?? '',
          });
        }
      }
      const blocks = [...byNumber.values()].sort((a, b) => a.blockNumber - b.blockNumber);
      return { project: payload.project, sourceId: kind.id, fileCount: files.length, insertTarget, blocks, written };
    }
    case 'registry': {
      // Asks the command registry what IT believes, from the plugin's own context. A
      // panel that shows an empty list because `execute` answered `undefined` cannot be
      // told apart from one whose command never registered, and this is the only place
      // that distinction is visible.
      const commands = registry;
      if (commands === undefined || commands === null) {
        return { registry: { available: false, note: 'the commands service is not visible from this context' } };
      }
      const probes = [];
      for (const key of ['storyboard', 'drama']) {
        let resolved = null;
        let failure = null;
        try {
          resolved = commands.find?.({ id: 'probe' }, key) ?? null;
        } catch (error) {
          failure = String(error?.message ?? error);
        }
        let listed = null;
        try {
          const all = await commands.list?.({ id: 'probe' });
          listed = Array.isArray(all) ? all.map((entry) => entry.name) : null;
        } catch (error) {
          listed = `list failed: ${String(error?.message ?? error)}`;
        }
        probes.push({ name: key, found: resolved !== null, failure, listed });
      }
      const { mode, activeProject } = await directorContext();
      return {
        registry: {
          available: true,
          hasRegister: typeof commands.register === 'function',
          hasFind: typeof commands.find === 'function',
          hasList: typeof commands.list === 'function',
          probes,
          // The panel can read the Host contract without a second call: `registry` is
          // already the "is this Host working?" probe, so the version belongs here.
          host: { ...hostIdentity(), mode, activeProject },
        },
      };
    }
    default:
      throw new Error(`unknown storyboard action "${String(action)}"`);
  }
}

/**
 * The sandbox policy a session is actually running under.
 *
 * Writes are fenced by this, and the deployment default is NOT a safe stand-in: its
 * writable root is the deployment's fallback directory, while a short-drama project lives
 * under the design root, so a write judged by the default is refused ("file access denied
 * under workspace-write mode"). Resolving the caller's own session gives the user's real
 * mode - `danger-full-access` lets the save through, `read-only` still refuses it - which is
 * the honest reading: the panel may write exactly as far as the user's own settings allow.
 *
 * @returns an `{ mode, workspaceRoot }` policy, or undefined to accept the default.
 */
export function policyForSession(ctx, invocation) {
  if (ctx === undefined || typeof ctx.get !== 'function') return undefined;
  const policy = ctx.get('sandboxPolicy');
  if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return undefined;
  const sessions = ctx.get('sessions');
  const directSession = invocation?.agent?.session;
  const sessionId = directSession?.header?.id ?? directSession?.id ?? invocation?.agent?.id;
  const lookedUpSession = typeof sessions?.get === 'function' && typeof sessionId === 'string'
    ? sessions.get(sessionId)
    : undefined;
  // Use the live session object when it is a real session (top-level id), otherwise fill a
  // header-only test projection from the session service. Never discard a full live object.
  const session = typeof directSession?.id === 'string'
    ? directSession
    : (lookedUpSession ?? directSession);
  try {
    return policy.resolve(session === undefined ? {} : { session });
  } catch {
    // A policy that cannot be read must not turn a read into a failure; the write path
    // falls back to the deployment default and reports its own refusal.
    return undefined;
  }
}

/**
 * Whether `target` sits at or under `root`.
 *
 * Case-insensitive on Windows: a drive letter and a folder name are the same thing in two
 * spellings, and a save must not be refused (or wrongly promised) over `D:\Project` vs
 * `d:\project`. The check is by path SEGMENT, never by string prefix - `D:\a` does not contain
 * `D:\ab`, which a `startsWith` would get wrong.
 */
export function isInsideWorkspaceRoot(root, target) {
  if (typeof root !== 'string' || root.length === 0) return null;
  if (typeof target !== 'string' || target.length === 0) return null;
  let base;
  let full;
  try {
    // The root is the WINDOWS spelling on this side of the boundary; `resolve` also normalises
    // trailing separators and `..` so `D:\a\..\a` and `D:\a` are one answer.
    base = resolvePath(root);
    full = resolvePath(target);
  } catch {
    return null;
  }
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = relative(fold(base), fold(full));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Can the PANEL save into this project, under the CALLER's own sandbox policy?
 *
 * This exists because the failure was only discoverable at the worst moment. The panel lives in
 * a session whose workspace is that session's `cwd`, and a short-drama project lives under the
 * design root - usually somewhere else entirely. So the panel could READ a whole episode, accept
 * 40 KB of edits, and only then answer `cannot write "...": file access denied under
 * workspace-write mode`, which reads like a save bug and is really a boundary. The answer is
 * computed from the same policy the write will be judged by, and reported when the panel loads,
 * not when the user has already typed.
 *
 * `writable: null` means UNKNOWN (no policy service, or no project chosen yet) and must not be
 * rendered as "read only": a panel that cries wolf about a boundary it could not read is the same
 * class of bug it is trying to fix.
 *
 * @param policy - the resolved caller policy, or undefined.
 * @param projectRoot - absolute project directory, or null before a project is picked.
 * @returns `{ mode, workspaceRoot, projectRoot, writable, reason }`.
 */
export function describeWriteAccess(policy, projectRoot) {
  const mode = typeof policy?.mode === 'string' ? policy.mode : null;
  const workspaceRoot = typeof policy?.workspaceRoot === 'string' && policy.workspaceRoot.length > 0
    ? policy.workspaceRoot
    : null;
  const project = typeof projectRoot === 'string' && projectRoot.length > 0 ? projectRoot : null;
  const base = { mode, workspaceRoot, projectRoot: project };
  if (mode === 'danger-full-access') return { ...base, writable: true, reason: 'full-access' };
  if (mode === 'read-only') return { ...base, writable: false, reason: 'read-only' };
  if (mode === null || workspaceRoot === null) return { ...base, writable: null, reason: 'unknown-policy' };
  if (project === null) return { ...base, writable: null, reason: 'no-project' };
  const inside = isInsideWorkspaceRoot(workspaceRoot, project);
  if (inside === null) return { ...base, writable: null, reason: 'unknown-policy' };
  return inside
    ? { ...base, writable: true, reason: 'inside-workspace' }
    : { ...base, writable: false, reason: 'outside-workspace' };
}

/**
 * Turn the filesystem sandbox's refusal into something a creator can act on.
 *
 * The raw text is `cannot write "D:\...": file access denied under workspace-write mode`. Every
 * word of that is accurate and none of it says what to do, so it was reported as "自动保存失败"
 * and read as a save bug. The two real exits are named instead: give the session full file access,
 * or open the session in the project's own folder. The original text is kept as `detail` - a
 * diagnosis without the evidence is not a diagnosis.
 *
 * Errors that are not sandbox denials pass through untouched: wrapping everything would hide the
 * ones that really are save failures.
 */
export function explainSandboxDenial(error) {
  const message = String(error?.message ?? error);
  if (error?.code !== 'FS_SANDBOX_DENIED' && !/file access denied under/u.test(message)) return error;
  const target = /cannot write "([^"]+)"/u.exec(message)?.[1] ?? '';
  // The mode travels into the sentence on purpose. 「只读」 and 「工作区外」 are different walls, and
  // the answer differs: one is about WHERE the project lives, the other about the ceiling the whole
  // session runs under. Keeping the wire spelling also keeps existing callers that branch on
  // `read-only` working.
  const mode = /file access denied under ([\w-]+) mode/u.exec(message)?.[1] ?? 'workspace-write';
  const readable = new Error(
    `存不进${target.length > 0 ? ` ${target}` : '这个文件'}：它不在当前会话允许写入的范围内（沙箱 mode=${mode}）。`
    + '两条出路：① 把当前会话权限切成「完全权限」后重试；'
    + '② 用项目目录（或项目根）新开一个会话再执行。'
    + '如果这是面板保存，浏览器草稿会由面板继续保留；agent 工具调用不涉及浏览器草稿。',
  );
  readable.code = typeof error?.code === 'string' ? error.code : 'FS_SANDBOX_DENIED';
  readable.detail = message;
  readable.sandboxMode = mode;
  if (target.length > 0) readable.target = target;
  return readable;
}

/**
 * Register the `/storyboard` command the UI calls.
 *
 * The invocation carries a JSON payload in `rawInput` because a slash-command line is
 * the only client-callable surface this profile already exposes, and it is designed to
 * carry text.
 */
/**
 * One short line describing what a storyboard action answered.
 *
 * A command's `text` is UI text - the adapter renders it into the conversation - so returning the whole
 * payload as JSON there printed the entire structure every time somebody typed `/storyboard {...}`.
 * The panel does not need it in `text` either: it is a field of the result, not a string that has to be
 * re-parsed, so the structured value travels in `data` and `text` says what happened in one line.
 *
 * An action this function does not know still gets a line rather than the payload: a new action is
 * better represented as "something happened" plus its own data than as a wall of JSON in the transcript.
 */
function summariseStoryboardResult(action, result) {
  const name = String(action ?? '?');
  const list = result?.blocks ?? result?.assets ?? result?.episodes ?? result?.projects ?? result?.candidates ?? result?.references;
  const count = Array.isArray(list) ? ` · ${String(list.length)} 项` : '';
  if (name === 'mode') {
    const active = result?.activeProject === null || result?.activeProject === undefined ? '' : ` · ${String(result.activeProject)}`;
    return `分镜管理 · ${String(result?.mode ?? '?')}${active}`;
  }
  if (name === 'episode-blocks') {
    const source = result?.sourceId ?? '?';
    const blocks = Array.isArray(result?.blocks) ? result.blocks.length : 0;
    const written = Array.isArray(result?.written) && result.written.length > 0 ? ` · 已生成 ${String(result.written.length)} 个文件` : '';
    return `分镜管理 · ${source} · ${String(blocks)} 个大分镜${written}`;
  }
  if (name === 'read') return `分镜管理 · 读取 ${String(result?.file ?? '')} · ${String(Array.isArray(result?.shots) ? result.shots.length : 0)} 个大分镜`;
  if (name === 'write' || name === 'insert') return `分镜管理 · 已保存${count}`;
  if (name === 'resplit-episode') return `分镜管理 · 已交给导演重新拆分第${String(result?.episodeNumber ?? '?')}集`;
  if (name === 'panel-generate') {
    const output = Array.isArray(result?.generatedFiles) ? result.generatedFiles.length : 0;
    return `通用生成 · ${String(result?.generationTask ?? '?')} · ${String(result?.state ?? '已提交')}${output > 0 ? ` · ${String(output)} 个文件` : ''}`;
  }
  return `分镜管理 · ${name}${count}`;
}

export function registerStoryboardCommand(commands, getFs, ctx, { media = null, config = {}, onModeChange } = {}) {
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return undefined;
  const fsFor = typeof getFs === 'function' ? getFs : () => undefined;

  return commands.register({
    name: STORYBOARD_COMMAND,
    description: '分镜管理面板的数据接口：读取项目、集数与大分镜，并把修改写回提示词文件',
    input: { hint: '{"action":"projects"}' },
    handler: async (invocation) => {
      // Resolved per call, not captured at registration: `fs` may arrive after the
      // command does, and a captured `undefined` would make every panel read fail with a
      // message that looks like a missing file rather than a missing service.
      const fs = fsFor();
      if (fs === undefined || fs === null) {
        return { kind: 'error', text: 'the filesystem service is unavailable in this profile' };
      }
      let request;
      try {
        request = JSON.parse(invocation.rawInput);
      } catch {
        return { kind: 'error', text: '参数必须是 JSON，例如 {"action":"projects"}' };
      }
      const sessionId = invocation?.agent?.session?.header?.id ?? invocation?.agent?.id;
      const shared = {
        fs,
        media,
        registry: commands,
        ctx,
        config,
        modelRoute: modelRouteFor(invocation?.agent?.session),
        getPolicy: () => policyForSession(ctx, invocation),
        onModeChange,
        runWorkflow: config.runWorkflow,
        generateVideo: config.generateVideo,
      };
      try {
        const result = await runPanelRequest(request, { ...shared, sessionId, signal: invocation.signal });
        // `text` is the ONLY channel a command result has, and it is ALSO what the conversation
        // renders - see `summariseStoryboardResult`. A caller that needs the object passes
        // `debug: true`; the panel no longer does, because it goes through the route above.
        return request.debug === true
          ? { kind: 'success', text: JSON.stringify(result) }
          : { kind: 'success', text: summariseStoryboardResult(request.action, result) };
      } catch (error) {
        // The command channel answers with `text` only, so the human sentence has to be the text.
        // A sandbox refusal is explained here too: the panel falls back to this channel on a
        // deployment with no web server, and "file access denied under workspace-write mode" in a
        // card is not something the person typing can act on.
        return { kind: 'error', text: String(explainSandboxDenial(error)?.message ?? error) };
      }
    },
    // The request half of a panel call is the 大分镜 body itself, up to a few KB of Chinese,
    // and it was landing in the session log on every save. The panel's own authoritative record
    // of what it asked for is the file it wrote, so the log does not need a second copy. A
    // hand-typed `/storyboard {...}` also stops being replayed into the log; the one-line result
    // is what a person reads there, and `debug: true` still answers with the structure.
    recordInput: false,
  });
}

/**
 * One panel request, whichever channel carried it.
 *
 * `invocation`-shaped callers (the command) and HTTP callers (the route) both land here, so an
 * action has one implementation and the two transports cannot answer differently. The shared
 * half - filesystem, media handles, the command registry, the caller's sandbox policy - is
 * resolved by the caller, because only it knows how to reach those services and whose policy
 * this is.
 *
 * @param request - `{ action, payload, root, debug }` as the panel sends it.
 */
export async function runPanelRequest(request, {
  fs,
  media = null,
  registry,
  ctx,
  config = {},
  getPolicy,
  sessionId,
  modelRoute = null,
  signal,
  convertH3 = null,
  onModeChange,
  runWorkflow,
  generateVideo,
} = {}) {
  if (fs === undefined || fs === null) throw new Error('the filesystem service is unavailable in this profile');
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('请求必须是 JSON 对象');
  if (typeof request.action !== 'string' || request.action.length === 0) throw new Error('缺少 action');
  const payload = request.payload ?? {};
  const mode = (await readState()).state.mode;
  /**
   * The panel route does not go through tool registration.
   *
   * Without this fence it could submit an H3 job or enqueue a director-only parsing task while
   * the model could see neither `storyboard` nor any drama skill. Reading and ordinary prompt
   * edits remain available in general mode, but pipeline work does not.
   */
  const pipelineAction = ['generate-h3', 'sync-h3', 'model-parse', 'resplit-episode', 'split-episode', 'review-shot', 'project-create', 'project-delete', 'episode-create'].includes(request.action)
    || (request.action === 'compile-h3' && (payload.language === 'en' || payload.write === true))
    || (request.action === 'episode-blocks' && payload.organise !== false)
    || (request.action === 'assets' && payload.assetAction === 'generate-quadview');
  if (pipelineAction && mode !== 'drama') {
    throw new Error('当前是通用模式。已有项目分镜的 H3 生成、同步和重新拆分属于短剧制作导演流程；请先在面板顶部或通过 /drama on 进入短剧模式。通用生成请使用「通用生成」页。');
  }
  // Only the panel's own choice overrides the default; a caller that names nothing gets the
  // design root, which is where the pipeline creates projects.
  //
  // `drive` and `workspace` are passed through because the design root is a PREFERENCE, not a
  // guarantee: on a machine where that folder does not exist yet (every fresh install), the
  // resolution falls back to the session workspace rather than handing the panel a directory
  // that is not there. Without them the panel would open on a nonexistent path and report
  // "cannot read this folder" to a first-time user.
  const root = projectsRoot({
    explicit: request.root,
    workspace: request.workspace,
    drive: config.projectDrive,
  });
  return runStoryboardAction(
    { action: request.action, payload },
    {
      fs,
      root,
      getPolicy,
      media,
      registry,
      ctx,
      config,
      sessionId,
      modelRoute,
      signal,
      convertH3: convertH3 ?? config?.convertH3 ?? null,
      onModeChange,
      runWorkflow,
      generateVideo,
    },
  );
}

/** Read one request body as JSON, with a bound so a stuck upload cannot hold the route open. */
async function readJsonBody(req, limit = 128 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    // A panel request carries a whole 大分镜, or a base64 asset import; anything past this is
    // not a request this route serves, and reading it to the end would just waste memory.
    if (total > limit) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) throw new Error('请求体是空的');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体必须是 JSON');
  }
}

/**
 * The panel's private channel: same actions, same files, no session-log entry.
 *
 * Registered as a PREFIX route on the composition's web server, which is the same surface that
 * already serves the panel's images. A route handler owns the full request lifecycle, so this
 * one applies the connection's trust fence itself - the Host/Origin check plus browser
 * authentication - before reading a single byte, exactly as the media route does. Without that
 * fence this would be the one unauthenticated endpoint on the port, and it can write files.
 *
 * Only POST is served. The panel probes with GET on mount to learn whether this route exists at
 * all, so a 405 here is a positive answer, not a failure: it means "use this channel".
 */
export function createPanelRouteHandler({ ctx, config = {}, media = null, getFs, onModeChange } = {}) {
  const owner = ctx?.root ?? ctx;
  const lookup = (name) => (typeof owner?.get === 'function' ? owner.get(name) : undefined);
  return async (req, res) => {
    const json = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const tail = url.pathname.slice(PANEL_PREFIX.length).replace(/^\/+/u, '');
    // The fence is asked even for the probe, so an unauthenticated probe cannot learn whether
    // this route exists.
    try {
      const connection = lookup('connection');
      if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('panel request rejected: connection trust service unavailable');
        return;
      }
      const rejection = await Promise.resolve(connection.requestRejection(req));
      if (rejection !== undefined && rejection !== null) {
        res.writeHead(rejection.status ?? 403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(rejection.message ?? 'rejected'));
        return;
      }
    } catch (error) {
      // A fence that cannot answer must not become an open door.
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`panel request rejected: ${String(error?.message ?? error)}`);
      return;
    }
    if (tail !== '') {
      json(404, { error: 'no such panel method' });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
      res.end('this panel endpoint answers POST only');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
      res.end();
      return;
    }
    const fs = typeof getFs === 'function' ? getFs() : lookup('fs');
    try {
      const request = await readJsonBody(req);
      const sessionId = typeof request.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : undefined;
      // Resolved per call, never captured: the panel mounts before the session store or the
      // policy service is guaranteed to be visible on this scope.
      const sessions = lookup('sessions');
      const sandboxPolicy = lookup('sandboxPolicy');
      const session = typeof sessions?.get === 'function' && sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (sessionId === undefined) throw new Error('panel request needs the current session id');
      if (session === undefined || session === null) throw new Error(`panel session ${sessionId} is no longer available; reopen the workbench from its conversation`);
      const modelRoute = modelRouteFor(session);
      const getPolicy = typeof sandboxPolicy?.resolve === 'function'
        ? () => {
          try {
            return sandboxPolicy.resolve(session === undefined ? {} : { session });
          } catch {
            // The write path reports its own refusal; a policy that cannot be read must not
            // turn a read into a failure.
            return undefined;
          }
        }
        : undefined;
      const result = await runPanelRequest(request, {
        fs,
        media,
        registry: lookup('commands'),
        ctx: owner,
        config,
        getPolicy,
        sessionId,
        modelRoute,
        signal: undefined,
        onModeChange,
        runWorkflow: config.runWorkflow,
        generateVideo: config.generateVideo,
      });
      json(200, result ?? null);
    } catch (error) {
      // Answered as a REQUEST failure, never as a transport failure: 404 and 405 are reserved
      // for "this route is not here", which is what tells the panel to fall back. A refused
      // save reported as 404 would make it re-send the write through the other channel.
      const explained = explainSandboxDenial(error);
      json(200, {
        error: String(explained?.message ?? explained),
        // Named so the panel can switch its own read/write verdict off, instead of showing the
        // same failure again on the next keystroke.
        ...(explained?.code === 'FS_SANDBOX_DENIED' ? { errorCode: 'SANDBOX_DENIED' } : {}),
      });
    }
  };
}

/** The same operations as an agent tool. */
/**
 * Attach media handles to one asset's file versions, for the panel.
 *
 * Minted HERE because this is the layer that knows both the real path and the media service.
 * The panel receives an opaque id and never a path, so a project's location is not disclosed
 * to the browser and the panel cannot ask for a file nobody offered it. A version with no
 * file on disk gets no handle rather than a broken one.
 */
async function attachVersionMedia(detail, media, projectRoot, fs = null, getPolicy = undefined) {
  if (media === null || media === undefined || typeof media.mint !== 'function') return detail;
  // Each version gets BOTH handles: the original, for a deliberate full-size look, and a thumbnail,
  // for the list it actually appears in. The detail view lists every version of a variant, so
  // handing it only the original meant a wall of ~1.9 MB PNGs - the same weight problem the grid
  // had, and the reason the user reported "资产部分也没有图片" while the images were in fact being
  // requested. A browser decoding megabytes of PNG inside a sidebar does not visibly finish, which
  // looks exactly like nothing loading.
  const thumbs = createThumbnailStore(projectRoot, { media, fs, getPolicy });
  const variants = [];
  for (const variant of detail.variants ?? []) {
    const files = [];
    for (const file of variant.files ?? []) {
      const usable = file.missing !== true && typeof file.relativePath === 'string';
      let thumbnailHandle = null;
      const isAudio = file.role === 'voice'
        || /\.(?:mp3|wav|flac|ogg|m4a|aac)$/iu.test(String(file.fileName ?? ''));
      if (usable && !isAudio) {
        try {
          const thumb = await thumbs.ensure({
            sourcePath: join(projectRoot, file.relativePath),
            fileName: file.fileName,
            sha256: file.sha256,
            bytes: file.bytes,
          });
          if (thumb !== null && thumb.handle !== null) thumbnailHandle = thumb.handle;
        } catch {
          // A version that cannot be scaled keeps its original handle and shows no preview.
        }
      }
      files.push({
        ...file,
        mediaHandle: usable ? media.mint(join(projectRoot, file.relativePath)) : null,
        thumbnailHandle,
      });
    }
    variants.push({ ...variant, files });
  }
  return { ...detail, variants };
}

/**
 * Attach a thumbnail handle to each asset row.
 *
 * One handle per variant: the newest version of its most useful role. `quadview` wins over
 * `primary`, because a reference sheet is what a character is recognised by and a list of
 * characters is being recognised. Variants whose files are all gone get no handle rather than
 * a broken one.
 *
 * The role order is deliberately explicit rather than "whatever sorts first": a version
 * ordering exists for history, not for choosing what represents an asset.
 */
const THUMBNAIL_ROLE_ORDER = ['quadview', 'threeview', 'front', 'primary', 'closeup', 'side', 'back', 'night'];

async function attachAssetMedia(rows, media, fullRows, projectRoot, fs = null, getPolicy = undefined) {
  if (media === null || media === undefined || typeof media.mint !== 'function') return rows;
  const thumbs = createThumbnailStore(projectRoot, { media, fs, getPolicy });
  const byId = new Map((fullRows ?? []).map((asset) => [asset.assetId, asset]));
  // Sequential rather than `Promise.all`: each iteration may open and encode an image, and doing
  // twenty at once on a laptop is how a preview of a preview stalls the panel.
  const out = [];
  for (const row of rows) {
    const full = byId.get(row.assetId);
    if (full === undefined) { out.push(row); continue; }
    const thumbnails = {};
    const thumbnailHandles = {};
    const roleHandles = {};
    const selectedHandles = {};
    for (const variant of full.variants ?? []) {
      const present = (variant.files ?? []).filter((file) => file.missing !== true && typeof file.relativePath === 'string');
      if (present.length === 0) continue;
      // An explicit selection is the card cover; otherwise the newest version wins within the
      // preferred role. `variant.files` is sorted oldest first for history, so picking the first
      // role match showed an older file while the replacement on disk stayed invisible.
      const pick = representativeVersion(variant, THUMBNAIL_ROLE_ORDER) ?? present[present.length - 1];
      thumbnails[variant.variantId] = media.mint(join(projectRoot, pick.relativePath));
      let pickThumbnailHandle = null;
      // A thumbnail when one can be made, and no entry at all when it cannot - the panel then
      // serves the original. Producing a COPY under a thumbnail's name would look like it worked
      // while making the grid exactly as heavy as before, which is worse than saying no.
      try {
        const thumb = await thumbs.ensure({
          sourcePath: join(projectRoot, pick.relativePath),
          fileName: pick.fileName ?? pick.relativePath,
          sha256: pick.sha256,
          bytes: pick.bytes,
        });
        if (thumb !== null && thumb.handle !== null) {
          pickThumbnailHandle = thumb.handle;
          thumbnailHandles[variant.variantId] = thumb.handle;
        }
      } catch {
        // A source that cannot be scaled is not a reason to fail the listing.
      }
      const explicitSelection = typeof variant.selectedVersionId === 'string'
        ? present.find((file) => file.assetVersionId === variant.selectedVersionId
          && !(full.kind === 'character' && file.role === 'voice'))
        : undefined;
      if (explicitSelection !== undefined) {
        selectedHandles[variant.variantId] = {
          assetVersionId: explicitSelection.assetVersionId,
          fileName: explicitSelection.fileName,
          version: explicitSelection.version,
          role: explicitSelection.role,
          handle: media.mint(join(projectRoot, explicitSelection.relativePath)),
          thumbnailHandle: explicitSelection.assetVersionId === pick.assetVersionId ? pickThumbnailHandle : null,
        };
      }
      const byRole = {};
      for (const roleName of ['front', 'quadview', 'primary']) {
        const current = present.filter((file) => file.historical !== true);
        const rolePool = current.length > 0 ? current : present;
        const candidates = rolePool.filter((file) => file.role === roleName);
        if (candidates.length === 0) continue;
        const newest = explicitSelection?.role === roleName
          ? explicitSelection
          : candidates.reduce(
            (best, file) => ((file.version ?? 0) > (best.version ?? 0) ? file : best),
            candidates[0],
          );
        let roleThumbnail = null;
        try {
          const thumb = await thumbs.ensure({
            sourcePath: join(projectRoot, newest.relativePath),
            fileName: newest.fileName ?? newest.relativePath,
            sha256: newest.sha256,
            bytes: newest.bytes,
          });
          if (thumb !== null && thumb.handle !== null) roleThumbnail = thumb.handle;
        } catch {
          // The original handle below still lets the panel show the image.
        }
        byRole[roleName] = {
          assetVersionId: newest.assetVersionId,
          fileName: newest.fileName,
          version: newest.version,
          handle: media.mint(join(projectRoot, newest.relativePath)),
          thumbnailHandle: roleThumbnail,
        };
      }
      roleHandles[variant.variantId] = byRole;
    }
    let voice = null;
    if (full.kind === 'character') {
      const voiceFile = characterVoiceVersion(full);
      if (voiceFile !== undefined) {
        try {
          voice = {
            ...voiceFile,
            handle: media.mint(join(projectRoot, voiceFile.relativePath)),
          };
        } catch {
          // A stale voice path must not prevent the rest of the character card from loading.
        }
      }
    }
    out.push({ ...row, thumbnails, thumbnailHandles, roleHandles, selectedHandles, voice });
  }
  return out;
}

export function storyboardTool(config) {
  return defineTool({
    name: 'storyboard',
    description: 'Read and edit the short-drama storyboard: list projects, list an episode\'s 大分镜, read one 大分镜 prompt, or write an edited prompt back into its file. The UI panel of the same name calls these exact operations, so the agent and the panel never disagree about what is on disk. Paths are relative to the session workspace; nothing is hardcoded, so it works for any project folder the user opened.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['mode', 'projects', 'project-create', 'project-delete', 'episode-create', 'browse', 'episodes', 'read', 'write', 'insert', 'delete', 'assets', 'references', 'jobs', 'results', 'migrate', 'registry', 'progress', 'health', 'diagnose', 'compile-h3', 'split-episode', 'model-parse', 'resplit-episode', 'review-shot', 'episode-blocks', 'global-config', 'panel-generate', 'media-preview', 'sync-h3', 'generate-h3', 'settings'],
        description: 'mode reads or changes the shared director context (project + episode/source/shot); projects lists projects and marks the active one; project-create creates a complete blank project; project-delete moves a confirmed short-drama project to a sibling .trash folder and clears its registration; episode-create adds one blank episode without touching project assets; browse lists a folder\'s subdirectories and projects; episodes lists one project\'s episodes and prompt files; read returns one file split into 大分镜 blocks with stable shotIds; write replaces one block; insert adds a copied or blank block and can edit its video/H3 companion in the same action; delete removes a block and can remove its companion; sync-h3 converts only the latest video-prompt block, lets code lock reference numbering, mirrors the video asset bar, and falls back to the structured conversion of that same source if the model output budget or format fails; resplit-episode enqueues a director turn that rewrites an episode from its script, then routes block allocation to the model; split-episode only splits confirmed 【大分镜N】 headings and sends missing or foreign headings to the model instead of flattening; review-shot queues a read-only director review of the exact open shot without writing files or starting a GPU; assets reads or refreshes the asset library; global-config manages task workflows and prompt sources; panel-generate runs the general-mode text-to-image, image-edit, image-upscale, video-upscale and H3 video forms through the configured workflows; image-edit can read ordered reference images and convert to the Qwen official contract before generation, submit an already converted prompt, or submit raw text; settings stores project 画幅 / 画风 / 分辨率; migrate adopts an existing project and assigns stable shotIds; progress rolls production state up onto video-prompt shots.',
      },
      modeAction: {
        type: 'string',
        enum: ['status', 'enter', 'exit', 'select-project', 'select-context'],
        description: 'For action=mode. enter/exit are explicit user mode changes; select-project marks the shared project; select-context records the panel\'s current episode/source/shot so the director can resolve “this shot” without guessing. Generation, H3 synchronization and model-based parsing are refused unless the stored mode is drama.',
      },
      project: { type: 'string', description: 'For action=episodes, assets, migrate or settings: the project directory, as returned by action=projects.' },
      projectName: { type: 'string', description: 'For action=project-create: the new production name. It becomes the project folder name and must not contain path characters.' },
      confirmed: { type: 'boolean', description: 'For action=project-delete: must be true after the user explicitly confirms moving the project to .trash.' },
      projectEpisodeCount: { type: 'integer', description: 'For action=project-create: how many blank episodes to create, starting at episode 1.' },
      scriptText: { type: 'string', description: 'For action=project-create: optional uploaded script text. When present, the director is queued to parse only the asset inventory.' },
      scriptFileName: { type: 'string', description: 'For action=project-create: original uploaded script filename, used for reporting.' },
      sourceId: { type: 'string', description: 'For action=mode modeAction=select-context: the prompt source currently open in the panel, either video or h3-zh.' },
      // Project defaults are separate parameters from `settings` (which is the H3
      // per-generation payload). Sharing one name would let an H3 call silently rewrite a
      // project-wide decision, so the two are deliberately spelled differently.
      projectAspectRatio: { type: 'string', enum: ['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'], description: 'For action=settings: the project 画幅. 9:16 for vertical short drama, 16:9 for landscape. Drives every asset and shot shape, and the panel\'s default.' },
      projectResolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'For action=settings: the project output resolution. Not required before starting; 720p is the assumption when unset.' },
      projectArtStyle: { type: 'string', enum: ['真人', '3D动漫', '动画', '其他'], description: 'For action=settings: the project 画风, one choice for the WHOLE production. Use 其他 plus projectArtStyleNote when the user describes a style in their own words.' },
      projectArtStyleNote: { type: 'string', description: 'For action=settings: the user\'s own style description. Required when projectArtStyle is 其他; otherwise optional extra guidance.' },
      projectCode: { type: 'string', description: 'For action=settings: the short file-name code for this production, e.g. wmsdsnq. Ask the user once - it is NOT derived from the title, because a guessed pinyin abbreviation ends up inside file names. When unset, result names use the readable Chinese form.' },
      decidedBy: { type: 'string', enum: ['user', 'script', 'agent'], description: 'For action=settings: who supplied the answer. user = asked and answered; script = stated in the script itself; agent = inferred and still to be confirmed. Defaults to user.' },
      assetAction: { type: 'string', enum: ['list', 'detail', 'refresh', 'import', 'binding', 'create', 'add-variant', 'select', 'replace', 'delete', 'delete-version', 'generate-quadview'], description: 'List, inspect, refresh, resolve an existing library version into a concrete H3 binding, create a metadata-only asset, add a costume variant, select the current input version, import/replace/delete a whole asset or one file version, or generate a four-view, upscale an existing four-view, or run the legacy combined operation through the configured workflows.' },
      assetName: { type: 'string', description: 'Optional asset name for @ mentions. Omit to derive from the selected filename and automatically number duplicates.' },
      assetId: { type: 'string', description: 'For action=assets with assetAction=replace, select or binding: the existing asset to receive the new file, whose current input version is being chosen, or whose file should fill an H3 slot.' },
      variantName: { type: 'string', description: 'For assetAction=add-variant, replace, select or binding: the costume/state variant. The default base variant is named default.' },
      sourceVersionId: { type: 'string', description: 'For assetAction=generate-quadview: the exact source version. generate/combined use a portrait version; upscale uses an existing quadview version. Omit to use the newest eligible version of that variant.' },
      quadviewAction: { type: 'string', enum: ['generate', 'upscale', 'combined'], description: 'For assetAction=generate-quadview: generate only a four-view, upscale an existing four-view by 3x, or run the legacy combined edit+upscale operation.' },
      assetVersionId: { type: 'string', description: 'For assetAction=select: the exact file version that should become the current generation input.' },
      description: { type: 'string', description: 'For assetAction=create or add-variant: the asset or variant introduction shown in the panel.' },
      role: { type: 'string', enum: ['auto', 'quadview', 'front', 'primary', 'voice'], description: 'For assetAction=replace: what the uploaded file represents. auto lets character uploads choose front for portrait-shaped images and quadview for wide images or four-view filenames; scenes and props use primary; audio uses voice.' },
      mediaKind: { type: 'string', enum: ['image', 'audio', 'video'], description: 'For assetAction=binding: the H3 slot family that the selected project asset must satisfy.' },
      sourcePath: { type: 'string', description: 'Local file to import.' },
      fileName: { type: 'string', description: 'Original filename when importing selected browser file data.' },
      fileDataBase64: { type: 'string', description: 'Base64 bytes of a file explicitly selected by the user.' },
      expectedText: { type: 'string', description: 'Optional previously read block text. When present, reject a save or generation if it changed on disk.' },
      removeReferenceIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'For action=references on a video prompt: explicit asset-card removals. Editing or deleting @ text alone never removes an asset from the bar.',
      },
      handle: { type: 'string', description: 'Opaque image handle for media-preview.' },
      blockNumber: { type: 'integer', description: 'Exact 大分镜 number to synchronize. Optional when the H3 filename states 大分镜N; required when passing the multi-block video prompt itself.' },
      settings: { type: 'json', description: 'H3 generation mode (drama/action), resolution (480p/720p/1080p), aspectRatio.' },
      requestId: { type: 'string', description: 'Optional stable generation intent id. generate-h3 derives it from the project, block, prompt, settings and ordered references when omitted, so a retry is idempotent; pass one only when deliberately overriding it.' },
      episodeNumber: { type: 'integer', description: 'Episode whose assets are shown or imported.' },
      asset: { type: 'string', description: 'For action=assets with assetAction=detail: the asset id, its name, or one of its aliases.' },
      validate: { type: 'string', description: 'For action=references: pass "known" to re-check references recorded earlier against the current text instead of parsing fresh. Use it after the file may have changed outside the panel.' },
      known: { type: 'json', description: 'For action=references: the reference records to re-check, as returned by a previous call.' },
      choices: { type: 'json', description: 'For action=references: the user\'s chosen asset for an ambiguous name, keyed by mention name. A value is { assetId, variantName } or just the asset id.' },
      referenceSlots: { type: 'json', description: 'For action=references, sync-h3 or generate-h3: panel-owned decisions for numbered H3 slots. Each item is { label, definition, mode: "empty"|"bound", binding? }. A decision is keyed by the slot label; prompt text no longer creates or destroys the material column.' },
      configAction: { type: 'string', enum: ['read', 'save', 'upload-prompt', 'delete-prompt', 'read-prompt-sources', 'select-prompt', 'inspect-video-workflow'], description: 'For action=global-config: read the recognised workflows, video controls and 剧本转视频提示词 sources; save the panel changes; upload a prompt document; delete an uploaded prompt; read only the prompt sources; select one prompt source; or inspect a newly selected video workflow without saving.' },
      videoEnvironmentKind: { type: 'string', enum: ['local', 'cloud'], description: 'For global-config configAction=inspect-video-workflow: which environment should supply model and scheduler options.' },
      videoWorkflow: { type: 'string', description: 'For global-config configAction=inspect-video-workflow: the workflow file selected in the panel.' },
      generationConfig: { type: 'json', description: 'For action=global-config configAction=save: the task workflow choices, the selected 剧本转视频提示词 source, and video model/sampling settings edited in the panel.' },
      generationTask: { type: 'string', enum: ['text-to-image', 'image-edit', 'upscale-image', 'upscale-video', 'video-generation'], description: 'For action=panel-generate: which global task form is being submitted.' },
      generationAction: { type: 'string', enum: ['generate', 'history', 'convert-edit-prompt'], description: 'For action=panel-generate: generate submits a task; history restores completed results from the 通用生成 folder; convert-edit-prompt reads all ordered image-edit references and returns a validated Qwen-Image-2.1 official prompt without touching ComfyUI or starting a GPU job.' },
      generationPrompt: { type: 'string', description: 'For action=panel-generate: the text-to-image prompt, edit instruction, or complete Chinese H3 prompt.' },
      generationPromptMode: { type: 'string', enum: ['qwen-official', 'qwen-converted', 'raw'], description: 'For action=panel-generate with generationTask=image-edit: qwen-official reads the reference images and converts before generation; qwen-converted directly submits prompt text returned by a prior convert-edit-prompt action; raw submits the user text byte-for-byte without model or local wrapping. Defaults to qwen-official.' },
      generationMedia: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fileName: { type: 'string', required: true },
            fileDataBase64: { type: 'string', required: true },
            kind: { type: 'string', enum: ['image', 'video', 'audio'], required: true },
            slotNumber: { type: 'integer' },
            order: { type: 'integer' },
            label: { type: 'string' },
          },
        },
        description: 'For action=panel-generate: browser-selected reference/media files. Image edit and image upscale use image; video upscale uses video; H3 video uses up to nine images.',
      },
      generationAssets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mediaHandle: { type: 'string', required: true },
            fileName: { type: 'string' },
            kind: { type: 'string', enum: ['image', 'video', 'audio'], required: true },
            slotNumber: { type: 'integer' },
            order: { type: 'integer' },
            label: { type: 'string' },
            assetId: { type: 'string' },
            variantName: { type: 'string' },
            role: { type: 'string' },
          },
        },
        description: 'For action=panel-generate: images, audio or video already in the selected project asset library. The Host resolves each opaque handle to a local file, so the browser never sends the full asset body.',
      },
      generationSettings: { type: 'json', description: 'For action=panel-generate: aspectRatio, megapixels, image scale, video targetResolution (480p/720p/1080p/2K/4K), seconds, mode and resolution for the selected task.' },
      promptSourceId: { type: 'string', description: 'For action=global-config configAction=delete-prompt/select-prompt or action=resplit-episode: the selected prompt source id. Built-in prompt sources cannot be deleted.' },
      configProbe: { type: 'boolean', description: 'For action=global-config: probe local and cloud ComfyUI for live status/model choices. Defaults to true; false is useful for deterministic offline inspection.' },
      state: { type: 'string', description: 'For action=jobs: only jobs in this ledger state, for example running or submission_unknown.' },
      limit: { type: 'integer', description: 'For action=jobs: how many jobs to return, newest first. Defaults to 50.' },
      resultAction: { type: 'string', enum: ['list', 'record', 'select', 'promote', 'prune', 'undo-prune', 'redo'], description: 'For action=results. list returns the candidates a generation produced; select marks one as the chosen result for its shot; promote copies a SELECTED candidate into the asset tree; prune moves candidates that were never selected into project-local trash; undo-prune restores the most recent prune. Defaults to list.' },
      candidateId: { type: 'string', description: 'For action=results with resultAction=select or promote: the candidate id from a previous list.' },
      batchId: { type: 'string', description: 'For action=results with resultAction=undo-prune: the cleanup batch returned by prune. Omit to undo the most recent batch.' },
      file: { type: 'string', description: 'For action=results with resultAction=record: one produced file (absolute, or relative to the project root).' },
      files: { type: 'array', items: { type: 'string' }, description: 'For action=results with resultAction=record: several produced files. One unusable file does not discard the others.' },
      jobId: { type: 'string', description: 'For action=jobs: read one ledger job by id so a submitted video can be followed to completion. For action=results with resultAction=record: the ledger job that produced these files, so a candidate can be traced back to its run.' },
      requestId: { type: 'string', description: 'For action=jobs: find the ledger job by its submission request id. This lets a panel restore a task that was still submitting when the view closed.' },
      role: { type: 'string', description: 'For action=results with resultAction=record: what this file is (a label, for example the run name).' },
      destination: { type: 'string', description: 'For action=results with resultAction=promote: where to copy the selected candidate, relative to the project root, for example 资产/人物资产/林晚（女主）/林晚.png.' },
      kindFilter: { type: 'string', enum: ['character', 'scene', 'prop', 'reference-image', 'reference-video', 'reference-audio', 'reference-media'], description: 'Asset category for listing or import. reference-media is retained for legacy callers; use reference-video or reference-audio for new imports.' },
      query: { type: 'string', description: 'For action=assets with assetAction=list: match the name or an alias, case-insensitively.' },
      file: { type: 'string', description: 'For action=read, write, insert or delete: the prompt file path, as returned by action=episodes.' },
      index: { type: 'integer', description: 'For action=write, insert or delete: the zero-based 大分镜 index from action=read. Fine for a click, but it moves when blocks are inserted - prefer shotId for anything durable.' },
      shotId: { type: 'string', description: 'For action=write, insert or delete: the stable block identity returned by action=read. Use this instead of index when the edit must land on the same shot it was read from, even after blocks were inserted above it.' },
      blockNumber: { type: 'integer', description: 'For paired insert/delete: the 大分镜 display number used to locate the same block in the video/H3 companion document.' },
      pairWithCompanion: { type: 'boolean', description: 'For action=insert or delete: apply the same structural edit to the matching video/H3 companion so the two cards stay aligned.' },
      expectedRevision: { type: 'integer', description: 'For action=write, insert or delete: the document revision returned by action=read. When given, the write is refused if the file changed since that read, so a stale panel cannot overwrite an edit made elsewhere.' },
      write: { type: 'boolean', description: 'For action=compile-h3 or split-episode: actually write the per-大分镜 files. Defaults to false, so a compile can be inspected before it touches the episode folder. The panel passes true.' },
      language: {
        type: 'string',
        enum: ['zh'],
        description: 'For action=compile-h3 or split-episode: produce the Chinese H3. The recommended English field names are optional; missing or reordered sections still submit unchanged. H3 English translation is disabled.',
      },
      reconcile: { type: 'boolean', description: 'For action=read: set false to display a file without allocating or refreshing shot identities. Defaults to true when the project has been migrated.' },
      commit: { type: 'boolean', description: 'For action=migrate: false reports what would be written without writing anything. Defaults to true.' },
      text: { type: 'string', description: 'For action=write: the full replacement text of that 大分镜. For action=global-config configAction=upload-prompt: plain prompt text when the caller already has it.' },
      kind: { type: 'string', description: 'For action=insert: copy duplicates the addressed block (same body, renumbered), blank inserts an empty skeleton. Defaults to blank.' },
      root: { type: 'string', description: 'For action=projects: the directory to search. Defaults to the session workspace. Pass another workspace\'s directory when the project lives outside it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          root: { type: 'string' },
          dataUrl: { type: 'string' },
          /** action=media-preview: the file's MIME type, so the panel can pick <img> or <video> without sniffing. */
          mediaType: { type: 'string' },
          text: { type: 'string' },
          sourceFile: { type: 'string' },
          blockNumber: { type: 'integer' },
          sourceNumber: { type: 'integer' },
          episodeNumber: { type: 'integer' },
          generation: { type: 'json' },
          message: { type: 'string' },
          project: { type: 'string' },
          mode: { type: 'string' },
          modeAction: { type: 'string' },
          activeProject: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          activeContext: { type: 'json' },
          /**
           * action=mode/projects: whether THIS session's sandbox may save into the active project,
           * said as `{ mode, workspaceRoot, projectRoot, writable, reason }`. `writable` is
           * `true` / `false` / `null` (unknown) - the panel must not turn "could not tell" into
           * "read only", so the tri-state is part of the contract.
           */
          writeAccess: { type: 'json' },
          truncated: { type: 'boolean' },
          scanned: { type: 'integer' },
          browse: { type: 'json' },
          write: { type: 'json' },
          projects: { type: 'json' },
          episodes: { type: 'json' },
          shots: { type: 'json' },
          file: { type: 'string' },
          changed: { type: 'boolean' },
          insertedAt: { type: 'integer' },
          deletedAt: { type: 'integer' },
          companion: { type: 'json' },
          kind: { type: 'string' },
          registry: { type: 'json' },
          /** Identity and freshness, present on read/write/insert once a project is migrated. */
          revision: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          shotId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          documentId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          changedOnDisk: { type: 'boolean' },
          added: { type: 'json' },
          ambiguous: { type: 'json' },
          /** Migration reporting. */
          committed: { type: 'boolean' },
          summary: { type: 'json' },
          totals: { type: 'json' },
          problems: { type: 'json' },
          projectRoot: { type: 'string' },
          storage: { type: 'json' },
          spaceWarning: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          /** Asset library reporting. */
          assetAction: { type: 'string' },
          assets: { type: 'json' },
          asset: { type: 'json' },
          created: { type: 'json' },
          imported: { type: 'json' },
           selection: { type: 'json' },
          removedVersion: { type: 'json' },
          removedAsset: { type: 'json' },
          binding: { type: 'json' },
          referenceSlots: { type: 'json' },
          displayReferences: { type: 'json' },
          modelConversion: { type: 'json' },
          discardedReferenceSlots: { type: 'json' },
          sourceAssetCount: { type: 'integer' },
          h3AssetCount: { type: 'integer' },
          sourceAssetBar: { type: 'json' },
          generated: { type: 'json' },
          stats: { type: 'json' },
          removed: { type: 'integer' },
          kept: { type: 'integer' },
          restored: { type: 'integer' },
          bytes: { type: 'integer' },
          batchId: { type: 'string' },
          undoAvailable: { type: 'boolean' },
          reason: { type: 'string' },
          /** Reference resolution. */
          references: { type: 'json' },
          /** Global generation configuration. */
          configAction: { type: 'string' },
          globalConfig: { type: 'json' },
          videoInspection: { type: 'json' },
          promptSources: { type: 'json' },
          promptSource: { type: 'json' },
          /** action=panel-generate: one form submission through the saved global workflow. */
          requestId: { type: 'string' },
          generationTask: { type: 'string' },
          generationAction: { type: 'string' },
          endpoint: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          workflow: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          workflowAdaptation: { type: 'json' },
          state: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          generatedFiles: { type: 'json' },
          cache: { type: 'json' },
          promptRewrite: { type: 'json' },
          referenceCount: { type: 'integer' },
          autoVoiceCount: { type: 'integer' },
          jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          promptId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          deleted: { type: 'boolean' },
          movedTo: { type: 'string' },
          recoverable: { type: 'boolean' },
          queued: { type: 'boolean' },
          /** action=model-parse: which job was handed to the director, and the text it was given. */
          task: { type: 'string' },
          instruction: { type: 'string' },
          script: { type: 'string' },
          target: { type: 'string' },
          backup: { type: 'string' },
          writeMode: { type: 'string' },
          workflows: { type: 'json' },
          backups: { type: 'json' },
          writeModes: { type: 'json' },
          /** Job ledger. */
          jobs: { type: 'json' },
          /** Result candidates. */
          candidates: { type: 'json' },
          selected: { type: 'json' },
          promotedTo: { type: 'string' },
          redoOf: { type: 'string' },
          sourceJobId: { type: 'string' },
          inputs: { type: 'json' },
          instructions: { type: 'string' },
          rejected: { type: 'json' },
          orderedInputs: { type: 'json' },
          /**
           * Project defaults (action=settings). These were RETURNED but not DECLARED, and with
           * `additionalProperties: false` that made every call throw
           * `"value.saved" is not a declared property` - so the画幅/画风 a project had stored could
           * be written but never read back. Four independent test sessions hit the same error and
           * all had to read `.director/project.json` by hand instead.
           */
          saved: { type: 'boolean' },
          settings: { type: 'json' },
          complete: { type: 'boolean' },
          missing: { type: 'json' },
          options: { type: 'json' },
          styleSentence: { type: 'string' },
          questions: { type: 'json' },
          /** action=health. Same omission, same consequence. */
          findings: { type: 'json' },
          checked: { type: 'json' },
          clean: { type: 'boolean' },
          /** action=diagnose: the bundle it returns, plus its own note. */
          bundle: { type: 'json' },
          note: { type: 'string' },
          /** Anything an action adds beyond the fields above, so a future action does not break reads. */
          extra: { type: 'json' },
          /** True when `assets` scanned the tree itself because the index was empty. */
          autoRefreshed: { type: 'boolean' },
          /**
           * action=compile-h3. These were RETURNED but never DECLARED, so every compile failed
           * validation with `"value.blockCount" is not a declared property` - and because the tool
           * also had no `write` argument, the compile could not save anything either. Both halves
           * of that are fixed here: the fields are declared, and `write` is a real parameter.
           */
          blockCount: { type: 'integer' },
          englishCreated: { type: 'json' },
          englishSkipped: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          mapping: { type: 'json' },
          unusedMapping: { type: 'json' },
          unmappedSubjects: { type: 'json' },
          prompts: { type: 'json' },
          written: { type: 'json' },
          /** action=split-episode, same omission. */
          documents: { type: 'json' },
          // Returned so the caller can see that the video-prompt count and the H3 count agree. They were
          // RETURNED but not DECLARED, so every split-episode call failed validation with
          // `"value.videoPromptCount" is not a declared property` - the files were written and the tool
          // still reported an error, which reads as "the split failed" when it had actually succeeded.
          videoPromptCount: { type: 'integer' },
          h3PromptCount: { type: 'integer' },
          sources: { type: 'json' },
          sourceId: { type: 'string' },
          sourceFile: { type: 'string' },
          translatedFrom: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          /** `@名字` written in the body that has no mapping entry; its `@` was dropped from the H3. */
          unmappedMentions: { type: 'json' },
          fileCount: { type: 'integer' },
          insertTarget: { type: 'string' },
          blocks: { type: 'json' },
          /** action=progress, same omission. */
          counts: { type: 'json' },
          total: { type: 'integer' },
          next: { type: 'json' },
          todo: { type: 'json' },
          durations: { type: 'json' },
          sourceKind: { type: 'string' },
          availableDocumentKinds: { type: 'json' },
          /** action=results: echoed back so a caller can tell list from select from promote. */
          resultAction: { type: 'string' },
          selection: { type: 'json' },
          selectionNote: { type: 'string' },
          savedTo: { type: 'string' },
          toEpisode: { type: 'boolean' },
          /** action=references. */
          locator: { type: 'json' },
          recorded: { type: 'boolean' },
          recordNote: { type: 'string' },
          unresolved: { type: 'json' },
          changes: { type: 'json' },
          /** action=generate-h3 / sync-h3 echoes: `text` and `generation` are declared above. */
        },
      },
      render: (_args, value) => {
        const lines = [`${value.action}${value.root === undefined ? '' : ` in ${value.root}`}`];
        if (typeof value.mode === 'string') {
          lines.push(`  director mode: ${value.mode}${value.activeProject === null || value.activeProject === undefined ? '' : ` · ${String(value.activeProject)}`}`);
        }
        if (value.action === 'generate-h3' && typeof value.message === 'string') {
          lines.push(`  ${value.message}`);
          const generation = value.generation ?? {};
          if (generation.state !== undefined) lines.push(`  state: ${String(generation.state)}`);
          if (generation.workflow !== undefined) lines.push(`  workflow: ${String(generation.workflow)}`);
        }
        if (value.action === 'sync-h3') {
          if (Number.isInteger(value.blockNumber)) lines.push(`  block: ${String(value.blockNumber)}`);
          if (typeof value.sourceFile === 'string') lines.push(`  source: ${value.sourceFile}`);
          if (typeof value.text === 'string' && value.text.length > 0) {
            lines.push('', '----- synced H3 text -----', value.text, '----- end synced H3 text -----', '');
          }
        }
        if (typeof value.generationTask === 'string') {
          lines.push(`  general task: ${value.generationTask}`);
          lines.push(`  endpoint: ${String(value.endpoint ?? 'configured')}`);
          lines.push(`  state: ${String(value.state ?? 'submitted')}`);
          if (typeof value.workflow === 'string') lines.push(`  workflow: ${value.workflow}`);
          if (Array.isArray(value.generatedFiles) && value.generatedFiles.length > 0) {
            lines.push(`  files: ${String(value.generatedFiles.length)}`);
            for (const file of value.generatedFiles) lines.push(`    ${String(file?.name ?? file?.mediaHandle ?? 'result')}`);
          } else {
            lines.push('  no completed file yet; the task ledger is authoritative');
          }
          if (typeof value.promptRewrite?.rewritten_prompt === 'string') {
            lines.push(`  rewritten prompt: ${value.promptRewrite.rewritten_prompt.slice(0, 240)}`);
          }
        }
        if (value.globalConfig !== undefined && value.globalConfig !== null) {
          const configValue = value.globalConfig;
          lines.push(`  workflow directory: ${String(configValue.workflowDirectory ?? '(none)')}`);
          for (const task of configValue.tasks ?? []) {
            lines.push(`  ${task.label}: ${task.selectable ? `${String((task.workflows ?? []).length)} workflow(s)` : 'fixed H3 workflow'}`);
          }
          for (const kind of ['local', 'cloud']) {
            const environment = configValue.environments?.[kind] ?? {};
            lines.push(`  ${kind}: ${environment.configured === false ? 'not configured' : environment.reachable === true ? `ready at ${String(environment.baseUrl ?? '?')}` : 'configured but not answering'}`);
          }
          if (configValue.video?.workflow !== null && configValue.video?.workflow !== undefined) {
            lines.push(`  video workflow: ${String(configValue.video.workflow.name ?? configValue.video.workflow.file ?? '?')}`);
          }
          if (typeof configValue.video?.error === 'string') lines.push(`  video problem: ${configValue.video.error}`);
        }
        for (const project of value.projects ?? []) lines.push(`  project: ${project.name} (${project.path})`);
        if (value.registry !== undefined && value.registry !== null) {
          const r = value.registry;
          lines.push(`  commands service visible: ${String(r.available)}${r.note === undefined ? '' : ` (${String(r.note)})`}`);
          lines.push(`  register/find/list: ${String(r.hasRegister)}/${String(r.hasFind)}/${String(r.hasList)}`);
          for (const probe of r.probes ?? []) {
            lines.push(`  /${probe.name}: found=${String(probe.found)}${probe.failure === null || probe.failure === undefined ? '' : ` failure=${String(probe.failure)}`}`);
            if (Array.isArray(probe.listed)) lines.push(`      registry lists: ${probe.listed.join(', ') || '(nothing)'}`);
            else if (typeof probe.listed === 'string') lines.push(`      ${probe.listed}`);
          }
        }
        if (value.browse !== undefined && value.browse !== null) {
          lines.push(`  browsing: ${String(value.browse.path)}${value.browse.readable ? '' : ' (NOT readable)'}`);
          if (value.browse.error !== null && value.browse.error !== undefined) lines.push(`  browse error: ${String(value.browse.error)}`);
          if (value.browse.parent !== null && value.browse.parent !== undefined) lines.push(`  up: ${String(value.browse.parent)}`);
          for (const row of value.browse.directories ?? []) lines.push(`  ${row.isProject ? '[项目]' : '[目录]'} ${row.name}`);
        }
        if (value.truncated === true) lines.push('the listing was cut short, so it may be incomplete');
        // `episodes` arrives in TWO shapes and the renderer must accept both:
        //   action=episodes   → `{ number, sources: [{ id, label, files: [{ file, blockNumber }] }] }`
        //   action=migrate    → `{ displayNumber, folder, script, sources: [{ file, kind, blocks }] }`
        // Reading one shape's keys off the other printed `第undefined集` and `[?]`, which reads as a
        // broken report rather than a migration with nothing to say.
        for (const episode of value.episodes ?? []) {
          const number = Number.isInteger(episode.number) ? episode.number : episode.displayNumber;
          lines.push(`  第${number ?? '?'}集`);
          const sources = episode.sources ?? [];
          const flat = sources.some((source) => source.file !== undefined && source.files === undefined);
          if (flat) {
            // migrate's shape: one row per file, already carrying its kind.
            for (const source of sources) {
              const blocks = Number.isInteger(source.blocks) && source.blocks > 0 ? `（${source.blocks} 块）` : '';
              lines.push(`      [${source.kind ?? '?'}] ${source.file ?? '?'}${blocks}`);
            }
            continue;
          }
          for (const source of sources) {
            // D6: a source spans SEVERAL files (one per 大分镜). Printing `source.file` showed only
            // the first of six H3 files, so the episode list under-reported the work.
            const files = Array.isArray(source.files) && source.files.length > 0 ? source.files : [{ file: source.file, path: source.path }];
            for (const file of files) {
              const block = Number.isInteger(file.blockNumber) && file.blockNumber > 0 ? ` 大分镜${file.blockNumber}` : '';
              lines.push(`      [${source.label ?? source.id ?? '?'}]${block} ${file.file ?? file.path ?? ''}`);
            }
          }
          if (typeof episode.script === 'string' && episode.script.length > 0) lines.push(`      剧本: ${episode.script}`);
        }
        // `shots` is an ARRAY for action=read but an OBJECT (keyed by document) for action=progress.
        // Iterating it unguarded made the progress render throw
        // `Cannot read properties of undefined (reading 'length')` - a crash in the renderer, which
        // surfaces as "the tool returned invalid output" and hides the fact that progress itself
        // worked. Guarded, and progress gets its own branch below.
        if (Array.isArray(value.shots)) {
          for (const shot of value.shots) {
            const id = typeof shot.shotId === 'string' ? `  ${shot.shotId}` : '';
            const chars = typeof shot.text === 'string' ? shot.text.length : 0;
            lines.push(`  [${shot.index}] ${shot.title}${shot.seconds === null || shot.seconds === undefined ? '' : ` ${shot.seconds}s`} — ${shot.shotCount ?? '?'} 小分镜, ${chars} 字符${id}`);
            if (value.action === 'read' && typeof shot.text === 'string' && shot.text.length > 0) {
              lines.push('', '----- shot.text (optional expectedText; copy verbatim if you want the stale-edit guard) -----', shot.text, '----- end shot.text -----', '');
            }
          }
        }
        if (value.revision !== undefined && value.revision !== null) lines.push(`  document revision: ${String(value.revision)}`);
        if (value.changedOnDisk === true) lines.push('  this file changed on disk since it was last recorded; the identities were reconciled against the new content');
        if (Array.isArray(value.added) && value.added.length > 0) lines.push(`  ${value.added.length} new block(s) were given fresh shot ids`);
        if (Array.isArray(value.ambiguous) && value.ambiguous.length > 0) lines.push(`  ${value.ambiguous.length} block(s) could not be told apart by content alone; check which is which before generating`);
        if (value.insertedAt !== undefined) lines.push(`  inserted a ${String(value.kind)} block at 大分镜 ${value.insertedAt + 1}${typeof value.shotId === 'string' ? ` (new ${value.shotId})` : ''}`);
        if (value.deletedAt !== undefined) lines.push(`  deleted 大分镜 ${value.deletedAt + 1}`);
        if (value.companion !== null && typeof value.companion === 'object') {
          if (Number.isInteger(value.companion.insertedAt)) lines.push(`  companion inserted at 大分镜 ${value.companion.insertedAt + 1}`);
          if (Number.isInteger(value.companion.deletedAt)) lines.push(`  companion deleted at 大分镜 ${value.companion.deletedAt + 1}`);
        }
        if (value.changed !== undefined) lines.push(value.changed ? 'written' : 'no change needed');
        if (value.committed !== undefined) {
          lines.push(value.committed ? 'migrated: sidecar metadata written, prompt files untouched' : 'dry run: nothing was written');
          const s = value.summary ?? {};
          // `stats` from an ASSET refresh does not carry these fields, so the migrate wording used
          // to read "undefined document(s) created, undefined refreshed" on an asset scan - which
          // looks like an error and tells the user nothing. Only say what is actually present.
          const detail = [
            Number.isFinite(s.documentsCreated) ? `${s.documentsCreated} document(s) created` : null,
            Number.isFinite(s.documentsUpdated) ? `${s.documentsUpdated} refreshed` : null,
            Number.isFinite(s.shots) ? `${s.shots} block(s) identified` : null,
            Number.isFinite(s.reusedIds) ? `${s.reusedIds} id(s) reused` : null,
          ].filter((part) => part !== null);
          if (detail.length > 0) lines.push(`  ${detail.join(', ')}`);
          if (typeof value.projectRoot === 'string') lines.push(`  metadata: ${value.projectRoot}\\.director`);
        }
        for (const problem of value.problems ?? []) lines.push(`  ⚠ ${String(problem.kind)}: ${String(problem.detail).slice(0, 160)}`);

        // ---- a `@` in the body that has no mapping entry (compile-h3 AND sync-h3) ----
        //
        // This used to travel into the H3 prompt verbatim, so `初始位置参考：@外卖袋` produced a file that
        // looked synced but which generate-h3 refused outright. It is dropped now, and said out loud -
        // otherwise 一键同步 looks like it did nothing.
        if (Array.isArray(value.unmappedMentions) && value.unmappedMentions.length > 0) {
          lines.push(`  ⚠ 这些 @ 引用没有映射条目，已按普通文字写进 H3（去掉 @）：${value.unmappedMentions.map((entry) => String(entry)).join('、')}`);
          lines.push('    要作为参考图上传，请把它们写进本大分镜的【人物映射】/【场景映射】/【道具映射】，再同步一次');
        }

        // ---- action=compile-h3 / split-episode ----
        // These used to render NOTHING (the fields were not even declared), so a successful compile
        // and a silent no-op looked identical to the caller.
        if (Number.isInteger(value.blockCount) && Array.isArray(value.prompts ?? value.documents)) {
          lines.push(`  ${value.blockCount} 个大分镜`);
          if (value.mapping !== undefined && value.mapping !== null) {
            const counts = [['characters', '人物'], ['scenes', '场景'], ['props', '道具']]
              .map(([key, label]) => `${Array.isArray(value.mapping[key]) ? value.mapping[key].length : 0} ${label}`)
              .join(' / ');
            lines.push(`  映射：${counts}`);
          }
          for (const prompt of value.prompts ?? []) {
            const pictures = Number.isInteger(prompt.pictureCount) ? prompt.pictureCount : (Array.isArray(prompt.subjects) ? prompt.subjects.length : 0);
            lines.push(`    大分镜 ${String(prompt.block ?? '?')} — ${String(prompt.seconds ?? '?')}s，${pictures} 张参考图`);
          }
          for (const document of value.documents ?? []) {
            lines.push(`    大分镜 ${String(document.blockNumber ?? '?')} — ${String(document.fileName ?? document.file ?? '')}`);
          }
          if (Array.isArray(value.unusedMapping) && value.unusedMapping.length > 0) {
            lines.push(`  ⚠ 有 ${value.unusedMapping.length} 条映射没被任何大分镜用到：${value.unusedMapping.slice(0, 6).map((entry) => String(entry.name ?? entry)).join(', ')}`);
          }
          if (Array.isArray(value.unmappedSubjects) && value.unmappedSubjects.length > 0) {
            // The entries are objects, and `?? entry` printed `[object Object]` - a message that
            // tells the user nothing about which name is unmapped.
            const label = (entry) => (typeof entry === 'string'
              ? entry
              : String(entry?.subject ?? entry?.name ?? entry?.text ?? entry?.label ?? JSON.stringify(entry)));
            lines.push(`  ⚠ 有 ${value.unmappedSubjects.length} 个称呼没有映射条目：${value.unmappedSubjects.slice(0, 6).map(label).join(', ')}（需要用户确认对应哪个资产）`);
          }
          if (Array.isArray(value.written) && value.written.length > 0) {
            lines.push(`  已写 ${value.written.length} 份：`);
            for (const file of value.written) lines.push(`    ${String(file)}`);
          } else if (value.written !== undefined) {
            lines.push('  没有写文件（write=false，只做了检查）');
          }
          // 伴生: the English siblings created alongside the Chinese ones.
          if (Array.isArray(value.englishCreated) && value.englishCreated.length > 0) {
            lines.push(`  同时生成英文伴生稿 ${value.englishCreated.length} 份（模型喂这一份）：`);
            for (const file of value.englishCreated) lines.push(`    ${String(file)}`);
          }
          if (typeof value.englishSkipped === 'string' && value.englishSkipped.length > 0) {
            lines.push(`  ⚠ 英文伴生稿没有生成：${value.englishSkipped}`);
          }
        }

        // ---- action=resplit-episode ----
        if (value.queued === true) {
          lines.push(`  已交给导演重新拆分第${String(value.episodeNumber ?? '?')}集`);
          if (typeof value.promptSource?.label === 'string') lines.push(`  使用提示词：${value.promptSource.label}`);
          if (typeof value.target === 'string') lines.push(`  目标文件：${value.target}`);
        }

        // ---- action=episode-blocks ----
        if (Array.isArray(value.blocks) && value.blocks.length > 0) {
          lines.push(`  ${value.blocks.length} 块（${String(value.fileCount ?? '?')} 个文件，source=${String(value.sourceId ?? '?')}）`);
          for (const block of value.blocks) {
            const refs = Array.isArray(block.references) ? block.references.length : 0;
            lines.push(`    大分镜 ${String(block.blockNumber)} — ${String(block.seconds ?? '?')}s${block.secondsFromVideoPrompt === true ? '（取自视频提示词）' : ''}，${refs} 个引用${block.dedicated === true ? '，独立文件' : ''}`);
          }
          if (typeof value.insertTarget === 'string') lines.push(`  新块插入到：${value.insertTarget}`);
        }

        // ---- action=progress / health / settings ----
        if (value.counts !== undefined && value.counts !== null) {
          const parts = Object.entries(value.counts).map(([key, count]) => `${key} ${String(count)}`);
          lines.push(`  进度：${parts.join(' / ')}${Number.isInteger(value.total) ? `（共 ${value.total}）` : ''}`);
          for (const item of (value.todo ?? []).slice(0, 8)) lines.push(`    · ${String(item.label ?? item.kind ?? JSON.stringify(item))}`);
          if (Array.isArray(value.durations) && value.durations.length > 0) {
            lines.push(`  ⚠ ${value.durations.length} 处时长不一致：${value.durations.slice(0, 4).map((entry) => String(entry.message ?? entry.kind ?? '')).join('；')}`);
          }
        }
        if (value.saved !== undefined && value.settings !== undefined) {
          const settings = value.settings ?? {};
          lines.push(`  画幅=${String(settings.aspectRatio ?? '未定')} 画风=${String(settings.artStyle ?? '未定')} 分辨率=${String(settings.resolution ?? '未定')} 代号=${String(settings.code ?? '未设')}`);
          lines.push(value.complete === true ? '  项目默认设置齐全，可以开始生成' : `  还缺：${(value.missing ?? []).join('、') || '（无）'}`);
          if (typeof value.styleSentence === 'string' && value.styleSentence.length > 0) lines.push(`  风格句：${value.styleSentence}`);
          for (const question of value.questions ?? []) lines.push(`  待问：${String(question.question ?? '')}`);
        }
        if (Array.isArray(value.findings)) {
          lines.push(value.clean === true ? '  检查通过，没有发现问题' : `  ${value.findings.length} 个问题：`);
          for (const finding of value.findings.slice(0, 10)) lines.push(`    ⚠ ${String(finding.kind ?? '')}: ${String(finding.detail ?? finding.message ?? '')}`);
          if (Array.isArray(value.checked) && value.checked.length > 0) lines.push(`  检查过 ${value.checked.length} 项`);
        }

        // ---- action=diagnose ----
        // Rendered nothing before: a successful diagnose and a broken one both printed the action
        // name, so the bundle the user is supposed to send away was invisible.
        if (value.bundle !== undefined && value.bundle !== null) {
          const bundle = value.bundle;
          const host = bundle.host ?? {};
          lines.push(`  契约版本 ${String(host.contractVersion ?? '?')}，加载于 ${String(host.loadedAt ?? '?')}，模式 ${String(host.mode ?? '?')}`);
          if (bundle.project !== null && bundle.project !== undefined) {
            lines.push(`  项目 ${String(bundle.project.name ?? '?')}：${String(bundle.project.episodes ?? 0)} 集 / ${String(bundle.project.shots ?? 0)} 个大分镜`);
          }
          const problems = Array.isArray(bundle.problems) ? bundle.problems : [];
          lines.push(problems.length === 0 ? '  没有记录到问题' : `  ${problems.length} 个问题：`);
          for (const problem of problems.slice(0, 8)) lines.push(`    ⚠ ${String(problem)}`);
          if (typeof value.note === 'string' && value.note.length > 0) lines.push(`  ${value.note}`);
        }

        // ---- action=references ----
        if (Array.isArray(value.references) && value.locator !== undefined) {
          lines.push(`  ${value.references.length} 个引用${value.recorded === true ? '（已记入该块）' : ''}`);
          for (const reference of value.references) lines.push(`    @${String(reference.assetName ?? reference.name ?? '?')} → ${String(reference.fileName ?? reference.bindingState ?? '?')}`);
          for (const unresolved of value.unresolved ?? []) lines.push(`  ⚠ 未解析：@${String(unresolved.name ?? unresolved)}`);
          for (const entry of (value.changes ?? []).slice(0, 6)) lines.push(`    变更：${String(entry.kind ?? '')} ${String(entry.assetName ?? '')}`);
          if (typeof value.recordNote === 'string' && value.recordNote.length > 0) lines.push(`  未能记入该块：${value.recordNote}`);
        }

        // ---- action=results ----
        if (typeof value.resultAction === 'string' && value.resultAction !== 'list') {
          lines.push(`  ${value.resultAction}：${Array.isArray(value.candidates) ? `${value.candidates.length} 个候选` : '完成'}`);
          if (value.selection !== undefined && value.selection !== null) lines.push('  该文件已记入资产库');
          if (typeof value.selectionNote === 'string' && value.selectionNote.length > 0) lines.push(`  资产库提示：${value.selectionNote}`);
          for (const candidate of value.candidates ?? []) lines.push(`    ${String(candidate.displayName ?? candidate.fileName ?? candidate.candidateId ?? '?')}`);
        } else if (Array.isArray(value.candidates) && value.candidates.length > 0 && typeof value.resultAction === 'string') {
          for (const candidate of value.candidates) lines.push(`    ${String(candidate.displayName ?? candidate.fileName ?? '?')} — ${String(candidate.status ?? '')}`);
        }

        if (Array.isArray(value.candidates) || value.selected !== undefined) {
          if (value.stats !== undefined && value.stats !== null) {
            lines.push(`  ${value.stats.total} candidate(s): ${value.stats.candidates} unreviewed, ${value.stats.selected} selected, ${value.stats.promoted} promoted`);
          }
          for (const candidate of value.candidates ?? []) {
            const when = String(candidate.generatedAt ?? '').slice(0, 19).replace('T', ' ');
            lines.push(`  ${String(candidate.status).padEnd(10)} ${candidate.candidateId}  ${candidate.fileName}  ${when}`);
            if (candidate.shotId !== null && candidate.shotId !== undefined) lines.push(`      shot ${candidate.shotId}${candidate.jobId === null ? '' : `  job ${candidate.jobId}`}`);
            if (candidate.note !== null && candidate.note !== undefined) lines.push(`      note: ${candidate.note}`);
            if (candidate.promotedTo !== undefined) lines.push(`      copied to ${candidate.promotedTo}`);
          }
          if (value.selected !== undefined && value.selected !== null) {
            lines.push(`  selected ${value.selected.candidateId} (${value.selected.role})${value.selected.selectionBroken === true ? '  - the chosen file is gone' : ''}`);
          }
          if (value.promotedTo !== undefined) lines.push(`  copied to ${value.promotedTo}`);
          // A finished generation is not a decision. Saying so at the point where the model would
          // otherwise report "done" and move on is what keeps the two apart.
          if ((value.candidates ?? []).some((candidate) => candidate.status === 'candidate')) {
            lines.push('  these are unreviewed: nothing uses them until one is selected (results with resultAction=select)');
          }
        }
        if (Array.isArray(value.jobs)) {
          if (value.jobs.length === 0) lines.push('  no generation job in the ledger');
          for (const job of value.jobs) {
            if (job.corrupt === true) { lines.push(`  ⚠ ${job.jobId}: unreadable ledger entry`); continue; }
            lines.push(`  ${job.jobId}  ${job.state}${job.name === null ? '' : `  "${job.name}"`}${job.promptId === null ? '' : `  prompt ${job.promptId}`}`);
            if (job.shotId !== null) lines.push(`      shot ${job.shotId}${job.workflow === null ? '' : `   workflow ${String(job.workflow).replace(/.*[\\/]/u, '')}`}`);
            if (job.inputs.length > 0) lines.push(`      ${job.inputs.length} input(s): ${job.inputs.map((input) => input.fileName).join(', ')}`);
            if (job.saved.length > 0) lines.push(`      saved ${job.saved.length} file(s)`);
            const trail = job.events.map((event) => event.state).join(' -> ');
            if (trail.length > 0) lines.push(`      ${trail}`);
            // The two states a caller must act on, stated rather than left to be noticed.
            if (job.state === 'submission_unknown') lines.push('      ⛔ submission never confirmed: check the instance queue, then resolve it by hand. It will NOT be retried automatically.');
            if (job.state === 'download_failed') lines.push('      ⚠ the run finished and the local copy does not exist. Retry the download; do not re-run the model.');
          }
        }
        if (Array.isArray(value.references)) {
          if (value.locator !== undefined && value.locator !== null) lines.push(`  resolving @ for ${value.locator.file} block ${value.locator.index + 1}`);
          lines.push(`  ${value.references.length} reference(s), ${(value.orderedInputs ?? []).length} distinct input file(s):`);
          for (const reference of value.references) {
            lines.push(`    ${reference.referenceIndex}. ${reference.display} -> ${reference.assetName}（${reference.variantName}） ${reference.role} ${reference.fileName}  ×${(reference.occurrences ?? []).length}${reference.pinned === true ? '  [pinned]' : ''}  ${reference.bindingState}`);
          }
          for (const input of value.orderedInputs ?? []) {
            lines.push(`    input ${input.referenceIndex}: ${input.fileName}  ${String(input.sha256 ?? '').slice(0, 10)}`);
          }
          for (const entry of value.unresolved ?? []) lines.push(`    ⚠ unresolved ${entry.text} at ${entry.start}: ${entry.note}`);
          for (const entry of value.ambiguous ?? []) lines.push(`    ⚠ ambiguous ${entry.text} at ${entry.start}: ${entry.note}`);
          for (const change of value.changes ?? []) lines.push(`    ↻ ${String(change.kind)} at ${String(change.at ?? change.from)}${change.expected === undefined ? '' : `: expected ${String(change.expected)}`}`);
          // A generation must never be submitted with an unresolved or ambiguous mention, so
          // the condition that blocks it is stated rather than left to be inferred.
          if ((value.unresolved ?? []).length > 0 || (value.ambiguous ?? []).length > 0) {
            lines.push('  ⛔ resolve every @ above before generating: a mention that binds to nothing would generate from the wrong inputs');
          }
        }
        if (value.assetAction !== undefined) {
          if (value.generated !== undefined && value.generated !== null) {
            const generated = value.generated;
            lines.push(`  four-view: ${String(generated.assetName ?? '')}（${String(generated.variantName ?? '')}） -> ${String(generated.relativePath ?? 'not saved')}`);
            if (generated.sourceFileName !== null && generated.sourceFileName !== undefined) {
              lines.push(`  from portrait: ${String(generated.sourceFileName)}`);
            }
            if (generated.reusedContent === true) lines.push('  identical four-view already existed; reused that version');
          }
          const rows = value.assets;
          if (Array.isArray(rows)) {
            lines.push(`  asset library: ${rows.length} asset(s)`);
            for (const row of rows) {
              const where = row.kind === 'character' ? '人物' : row.kind === 'scene' ? '场景' : '道具';
              const variants = (row.variants ?? []).map((variant) => `${variant.name}(${variant.versions}版 ${variant.roles.join('/')})`).join(', ');
              lines.push(`    [${where}] ${row.name}  ${row.assetId}`);
              lines.push(`        ${variants}${row.missingCount > 0 ? `  ⚠ ${row.missingCount} 个文件已不在磁盘上` : ''}`);
            }
          }
          if (value.asset !== undefined && value.asset !== null) {
            const asset = value.asset;
            lines.push(`  ${asset.name}  ${asset.assetId}  (${asset.kind}${asset.qualifier === null ? '' : `, ${asset.qualifier}`})`);
            for (const variant of asset.variants ?? []) {
              lines.push(`    [${variant.name}]`);
              for (const file of variant.files ?? []) {
                lines.push(`        ${file.role} v${file.version}  ${file.fileName}  ${file.sha256.slice(0, 10)}${file.historical === true ? `  [EPISODE COPY${(file.episodeNumbers ?? []).length > 0 ? ` 第${(file.episodeNumbers ?? []).join('、')}集` : ''}]` : ''}${file.missing === true ? '  [MISSING]' : ''}  ${file.status}`);
              }
            }
          }
          if (value.stats !== undefined && value.stats !== null && value.assets !== undefined && value.committed !== undefined) {
            lines.push(`  ${value.committed ? 'scanned and recorded' : 'dry run: nothing was written'}: ${String(value.stats.assets)} asset(s), ${String(value.stats.variants)} variant(s), ${String(value.stats.files)} file version(s), ${String(value.stats.newVersions ?? 0)} new, ${String(value.stats.superseded ?? 0)} superseded, ${String(value.stats.duplicateContent ?? 0)} duplicate content, ${String(value.stats.recoveredFiles ?? 0)} recovered, ${String(value.stats.reassignedFiles ?? 0)} reassigned, ${String(value.stats.historicalFiles ?? 0)} episode copies`);
          }
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    // A one-document English H3 translates every 大分镜 before the first write. Three concurrent
    // model calls still need room for a long episode; the Host must not cancel a valid translation
    // halfway through and report the whole feature as broken.
    timeoutMs: 900000,
    async execute(args, exec) {
      const root = projectsRoot({
        explicit: args.root,
        workspace: exec?.agent?.session?.header?.cwd,
        drive: config.projectDrive,
      });
      // The agent's own session drives the policy here, exactly as the command path does
      // for the panel: a write is judged by the mode the user is in, not by the deployment
      // default whose writable root excludes the project folder.
      const sessionId = exec?.agent?.session?.header?.id;
      const modelRoute = modelRouteFor(exec?.agent?.session);
      // DSH's own tools resolve policy from `exec.agent.session`, the exact session that
      // carries the current sandbox/mode event. Looking the same id up through config.sessions
      // can return undefined (or a different projection) and silently falls back to the
      // deployment's workspace-write default.
      const directSession = exec?.agent?.session;
      const lookedUpSession = typeof config.sessions?.get === 'function' && typeof sessionId === 'string'
        ? config.sessions.get(sessionId)
        : undefined;
      const session = typeof directSession?.id === 'string'
        ? directSession
        : (lookedUpSession ?? directSession);
      const getPolicy = typeof config.sandboxPolicy?.resolve === 'function'
        ? () => {
          try {
            return config.sandboxPolicy.resolve(session === undefined ? {} : { session });
          } catch {
            return undefined;
          }
        }
        : undefined;
      // A sandbox refusal on this path reaches the MODEL, and the model then explains it to the
      // user. Handing the raw `file access denied under workspace-write mode` upward is how that
      // ended up paraphrased as "the save failed"; the explained form names both exits.
      const value = await runStoryboardAction({
          action: args.action,
          payload: {
            project: args.project,
            modeAction: args.modeAction,
            file: args.file,
            index: args.index,
            shotId: args.shotId,
            expectedRevision: args.expectedRevision,
            reconcile: args.reconcile,
            commit: args.commit,
            // Without this mapping the tool could never write a compile: the action only writes
            // when `payload.write === true`, and `args.write` had nowhere to go.
            write: args.write,
            // Same omission: `compile-h3` reads `payload.language`, but the parameter did not exist,
            // so English H3 was unreachable - the compiler supports it, nothing could ask for it.
            language: args.language,
            text: args.text,
            kind: args.kind,
            assetAction: args.assetAction,
            assetName: args.assetName,
            assetId: args.assetId,
            assetVersionId: args.assetVersionId,
            sourceVersionId: args.sourceVersionId,
            quadviewAction: args.quadviewAction,
            variantName: args.variantName,
            description: args.description,
            role: args.role,
            mediaKind: args.mediaKind,
            sourcePath: args.sourcePath,
            fileName: args.fileName,
            fileDataBase64: args.fileDataBase64,
            expectedText: args.expectedText,
            removeReferenceIds: args.removeReferenceIds,
            handle: args.handle,
            blockNumber: args.blockNumber,
            sourceId: args.sourceId,
            settings: args.settings,
            // Project defaults travel under their own names; see the schema note on why they
            // are not `aspectRatio`/`artStyle` directly.
            projectAspectRatio: args.projectAspectRatio,
            projectResolution: args.projectResolution,
            projectArtStyle: args.projectArtStyle,
            projectArtStyleNote: args.projectArtStyleNote,
            projectCode: args.projectCode,
            confirmed: args.confirmed,
            decidedBy: args.decidedBy,
            requestId: args.requestId,
            episodeNumber: args.episodeNumber,
            asset: args.asset,
            kindFilter: args.kindFilter,
            query: args.query,
            validate: args.validate,
            known: args.known,
            choices: args.choices,
            referenceSlots: args.referenceSlots,
            configAction: args.configAction,
            videoEnvironmentKind: args.videoEnvironmentKind,
            videoWorkflow: args.videoWorkflow,
            generationConfig: args.generationConfig,
            generationTask: args.generationTask,
            generationAction: args.generationAction,
            generationPrompt: args.generationPrompt,
            generationPromptMode: args.generationPromptMode,
            generationMedia: args.generationMedia,
            generationAssets: args.generationAssets,
            generationSettings: args.generationSettings,
            promptSourceId: args.promptSourceId,
            configProbe: args.configProbe,
            state: args.state,
            limit: args.limit,
            resultAction: args.resultAction,
            candidateId: args.candidateId,
            destination: args.destination,
            status: args.status,
            files: args.files,
            jobId: args.jobId,
            role: args.role,
            note: args.note,
          },
        },
        {
          fs: config.fs,
          root,
          registry: config.registry,
          getPolicy,
          media: config.media,
          config,
          ctx: config.ctx,
          sessionId,
          modelRoute,
          signal: exec.signal,
          translate: config.translate,
          convertH3: config.convertH3,
          onModeChange: config.onModeChange,
          runWorkflow: config.runWorkflow,
          generateVideo: config.generateVideo,
        },
      ).catch((error) => {
        const explained = explainSandboxDenial(error);
        if (args.action === 'generate-h3' && /reading ['"]trim['"]/u.test(String(explained?.message ?? error))) {
          const wrapped = new Error(`generate-h3 在进入模型调用前访问到空值：${String(explained?.message ?? error)}`
            + `\n参数快照：${JSON.stringify({
              project: args.project,
              file: args.file,
              index: args.index,
              expectedTextLength: typeof args.expectedText === 'string' ? args.expectedText.length : null,
              settings: args.settings ?? null,
              referenceSlotCount: Array.isArray(args.referenceSlots) ? args.referenceSlots.length : null,
            })}`
            + `\n原始堆栈：${String(error?.stack ?? explained?.stack ?? '')}`);
          wrapped.code = 'H3_GENERATE_NULL_TRIM';
          wrapped.cause = error;
          throw wrapped;
        }
        throw explained;
      });
      return { action: args.action, ...value };
    },
  });
}
