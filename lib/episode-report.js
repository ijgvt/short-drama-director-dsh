/**
 * Reports about a project: what still needs doing, what is broken, and what to send when asking for
 * help.
 *
 * ## Why one module
 *
 * These three answer the same shape of question - "what is the state of this project" - at three
 * levels of detail. Kept together they share one scan of the disk, which matters because the whole
 * value of a progress list is that it is cheap enough to look at on every open. Split into three
 * modules they would each walk the project, and the panel would pay for it three times.
 *
 * ## What "progress" means here
 *
 * Not a percentage. A percentage of an unknown total is a number that goes DOWN when the user adds
 * work, which is discouraging and false. Each shot is placed in exactly one bucket, and the buckets
 * are the things a person can act on: missing assets, ready to generate, running, waiting for a
 * decision, decided.
 *
 * @module dsh-plugin-short-drama-director/lib/episode-report
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The buckets a shot can be in, in the order a person works through them. */
export const SHOT_STATES = Object.freeze([
  'missing-assets',   // something it references is not there, so it cannot be generated
  'needs-attention',  // the last run failed, or its submission/download needs a human
  'ready',            // everything it needs is present and it has never been generated
  'running',          // the instance is working on it
  'awaiting-review',  // candidates exist and none has been chosen
  'decided',          // a version has been chosen
]);

const ACTIVE_JOB_STATES = Object.freeze(['submitting', 'queued', 'running', 'downloading', 'intent']);
const ACTIVE_JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function jobActivityTime(job) {
  const values = [
    job?.updatedAt,
    job?.createdAt,
    ...(Array.isArray(job?.events) ? job.events.slice(-1).map((event) => event?.at) : []),
  ];
  for (const value of values) {
    const parsed = Date.parse(String(value ?? ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isLiveJob(job, now) {
  if (!ACTIVE_JOB_STATES.includes(job?.state)) return false;
  const activity = jobActivityTime(job);
  // Active-looking records without timestamps are legacy fixtures. Once time is available,
  // an abandoned queue entry must not make a shot look like it is generating forever.
  return activity === null || now - activity <= ACTIVE_JOB_MAX_AGE_MS;
}

/**
 * Which bucket one shot belongs in.
 *
 * Ordered by what BLOCKS the user, not by how far along the shot is: a shot whose assets went
 * missing is `missing-assets` even if it has a chosen result, because the thing the user has to fix
 * is the missing asset. Reporting it as `decided` would hide the problem.
 */
export function stateOfShot({ unresolved = [], jobs = [], candidates = [], selected = null, now = Date.now() }) {
  const liveJobs = jobs.filter((job) => !ACTIVE_JOB_STATES.includes(job?.state) || isLiveJob(job, now));
  const candidateJobIds = new Set(candidates
    .map((candidate) => candidate?.jobId)
    .filter((jobId) => typeof jobId === 'string' && jobId.length > 0));
  const latestCandidateAt = candidates
    .map((candidate) => Date.parse(String(candidate?.generatedAt ?? candidate?.createdAt ?? '')))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0] ?? null;
  // A candidate is proof that its own job finished. Separate, older attempts that are still
  // marked queued/running in the ledger must not hide that finished video either: real project
  // data had v14/v15 stranded as `queued` while the v16 candidate and file already existed.
  // Only a job that began after the latest candidate can represent a newer retry.
  const currentJobs = liveJobs.filter((job) => {
    if (candidateJobIds.has(job?.jobId)) return false;
    if (latestCandidateAt === null) return true;
    const activity = jobActivityTime(job);
    return activity === null || activity > latestCandidateAt;
  });
  if (unresolved.length > 0) return 'missing-assets';
  if (selected === null && candidates.length === 0
    && liveJobs.some((job) => ['failed', 'download_failed', 'submission_unknown'].includes(job.state))) {
    return 'needs-attention';
  }
  if (currentJobs.some((job) => ACTIVE_JOB_STATES.includes(job.state))) return 'running';
  if (selected !== null) return 'decided';
  if (candidates.length > 0) return 'awaiting-review';
  return 'ready';
}

/** A one-line, human-readable reason a shot is not `ready`, for the list to show. */
export function reasonFor(state, { unresolved = [], jobs = [], candidates = [] }) {
  if (state === 'missing-assets') return `缺 ${String(unresolved.length)} 项引用：${unresolved.slice(0, 3).map((item) => item.name ?? item).join('、')}`;
  if (state === 'needs-attention') {
    const job = jobs.find((entry) => ['failed', 'download_failed', 'submission_unknown'].includes(entry.state));
    if (job?.state === 'submission_unknown') return '提交状态未知，需要先核对队列';
    if (job?.state === 'download_failed') return '已生成，但下载失败';
    return `上次生成失败${job?.note ? `：${String(job.note).slice(0, 60)}` : ''}`;
  }
  if (state === 'running') {
    const live = jobs.find((job) => ACTIVE_JOB_STATES.includes(job.state)
      && isLiveJob(job, Date.now()));
    return `实例处理中（${String(live?.state ?? '?')}）`;
  }
  if (state === 'awaiting-review') return `${String(candidates.length)} 个候选待选用`;
  if (state === 'decided') return '已选用';
  return '可以生成';
}

/** The episode number in a project-relative prompt path, or null for an unnumbered document. */
function episodeNumberInPath(relativePath) {
  const match = /(?:^|[\\/])第\s*(\d+)\s*集(?:[\\/]|$)/u.exec(String(relativePath ?? ''));
  return match === null ? null : Number(match[1]);
}

/**
 * Build the episode progress report.
 *
 * @param input.documents - the director store's document records.
 * @param input.shotsByDocument - shotId -> resolved reference info, supplied by the caller which
 *   already parses the prompt files. Passed in rather than re-parsed here so the panel's open and
 *   the model's question produce the SAME answer.
 * @param input.jobs - ledger rows.
 * @param input.candidates - result candidates.
 * @param input.shotAliases - companion shotId -> production video shotId. H3 files have their own
 *   stable ids, so progress must carry that explicit relation instead of falling back to a raw
 *   block number after an insertion.
 */
export function buildProgress({
  documents = [],
  shotsByDocument = {},
  jobs = [],
  candidates = [],
  shotAliases = new Map(),
} = {}) {
  const shotKeys = new Map();
  const maxBlockByEpisode = new Map();
  for (const document of documents) {
    const episodeNumber = document.episodeNumber ?? episodeNumberInPath(document.relativePath);
    for (const shot of document.shots ?? []) {
      const blockNumber = Number.isInteger(shot.sourceNumber)
        ? shot.sourceNumber
        : (Number.isInteger(shot.displayNumber) ? shot.displayNumber : null);
      shotKeys.set(shot.shotId, { episodeNumber, blockNumber });
      if (episodeNumber !== null && blockNumber !== null) {
        maxBlockByEpisode.set(episodeNumber, Math.max(maxBlockByEpisode.get(episodeNumber) ?? 0, blockNumber));
      }
    }
  }
  const belongsToShot = (entry, shotId, identity) => {
    // A recorded identity is authoritative. Falling back to block number when it does not match
    // is how a completed clip for old block 4 could reappear on whichever shot became block 4
    // after an insertion. Use positional matching only for legacy entries that have no shotId.
    if (typeof entry?.shotId === 'string' && entry.shotId.length > 0) {
      return entry.shotId === shotId || shotAliases.get(entry.shotId) === shotId;
    }
    if (identity.episodeNumber === null || identity.blockNumber === null) return false;
    if (entry?.episodeNumber !== identity.episodeNumber || !Number.isInteger(entry?.blockNumber)) return false;
    const maxBlock = maxBlockByEpisode.get(identity.episodeNumber) ?? entry.blockNumber;
    return Math.min(entry.blockNumber, maxBlock) === identity.blockNumber;
  };

  const byShot = new Map();
  for (const candidate of candidates) {
    for (const [shotId, identity] of shotKeys.entries()) {
      if (!belongsToShot(candidate, shotId, identity)) continue;
      const list = byShot.get(shotId) ?? [];
      if (!list.some((entry) => entry.candidateId === candidate.candidateId)) list.push(candidate);
      byShot.set(shotId, list);
    }
  }
  const jobsByShot = new Map();
  for (const job of jobs) {
    for (const [shotId, identity] of shotKeys.entries()) {
      const jobIdentity = {
        shotId: job.shotId,
        episodeNumber: job.plan?.episodeNumber ?? job.episodeNumber ?? null,
        blockNumber: job.plan?.blockNumber ?? job.blockNumber ?? null,
      };
      if (!belongsToShot(jobIdentity, shotId, identity)) continue;
      const list = jobsByShot.get(shotId) ?? [];
      if (!list.some((entry) => entry.jobId === job.jobId)) list.push(job);
      jobsByShot.set(shotId, list);
    }
  }

  const shots = [];
  for (const document of documents) {
    const resolved = shotsByDocument[document.relativePath] ?? {};
    for (const shot of document.shots ?? []) {
      const info = resolved[shot.shotId] ?? {};
      const own = byShot.get(shot.shotId) ?? [];
      const ownJobs = jobsByShot.get(shot.shotId) ?? [];
      const selected = own.find((candidate) => candidate.selectedAt !== null || candidate.status === 'selected') ?? null;
      const episodeNumber = document.episodeNumber ?? episodeNumberInPath(document.relativePath);
      const blockNumber = Number.isInteger(shot.sourceNumber)
        ? shot.sourceNumber
        : (Number.isInteger(shot.displayNumber) ? shot.displayNumber : null);
      const state = stateOfShot({
        unresolved: info.unresolved ?? [],
        jobs: ownJobs,
        candidates: own,
        selected,
      });
      shots.push({
        shotId: shot.shotId,
        displayNumber: shot.displayNumber ?? null,
        episodeNumber,
        blockNumber,
        document: document.relativePath,
        documentKind: document.kind ?? null,
        state,
        reason: reasonFor(state, { unresolved: info.unresolved ?? [], jobs: ownJobs, candidates: own }),
        candidates: own.length,
        hasSelected: selected !== null,
        directIdentity: own.some((candidate) => candidate.shotId === shot.shotId
            || shotAliases.get(candidate.shotId) === shot.shotId)
          || ownJobs.some((job) => job.shotId === shot.shotId
            || shotAliases.get(job.shotId) === shot.shotId),
        // A shot with no resolved references at all is reported rather than assumed fine: silence
        // here would look identical to "checked and everything is present".
        referencesChecked: info.checked === true,
      });
    }
  }

  const counts = Object.fromEntries(SHOT_STATES.map((state) => [state, 0]));
  for (const shot of shots) counts[shot.state] += 1;

  const workOrder = ['missing-assets', 'needs-attention', 'awaiting-review', 'ready', 'running', 'decided'];
  const next = workOrder
    .map((state) => shots.find((shot) => shot.state === state))
    .find((shot) => shot !== undefined) ?? null;

  return {
    shots,
    counts,
    total: shots.length,
    next,
    // The actionable subset, in the order a person would work: what is broken, then what is
    // waiting on them, then what is in flight.
    todo: shots.filter((shot) => ['missing-assets', 'needs-attention', 'awaiting-review'].includes(shot.state)),
  };
}

/** Which files a project's health check protects from any cleanup. */
export const PROTECTED_KINDS = Object.freeze(['selected', 'promoted', 'referenced']);

/**
 * Health check.
 *
 * Reports rather than repairs, and every finding names what it would cost to act on. A health check
 * that deletes things is a health check nobody runs twice.
 */
export async function buildHealth({ root, projectRoot, documents = [], candidates = [], assets = [], jobs = [], cacheDirs = [] } = {}) {
  const findings = [];

  // 0. A parenthetical qualifier in a SCENE / PROP / group asset's name. Only a character's costume
  //    variant may use one, because the asset library reads the first `（…）` in a FILE name as the
  //    variant: `青岚宗弟子（群像）.png` becomes asset 青岚宗弟子 + variant 群像, and `@青岚宗弟子` may
  //    then bind to a different group's picture. Measured: it grabbed 纸鹤镇镇民, and the mismatch is
  //    silent until the generated shot is obviously wrong.
  const parenthesisedNames = assets.filter((asset) => {
    if (asset.kind === 'character') return false;
    return /（[^）]*）|\([^)]*\)/u.test(String(asset.name ?? ''));
  });
  if (parenthesisedNames.length > 0) {
    findings.push({
      kind: 'asset-name-parenthesis',
      severity: 'warn',
      detail: `${String(parenthesisedNames.length)} 个非人物资产的名称里带括号`,
      action: '括号只用于人物变体（角色名（造型））。改成不带括号的独立名字（青岚宗弟子群像 / 问雪剑纸化）再重新扫描，否则 @引用 会被解析成"资产 + 变体"，绑到不确定的图片上',
      items: parenthesisedNames.slice(0, 20).map((asset) => ({ assetId: asset.assetId, kind: asset.kind, name: asset.name })),
    });
  }

  // 1. A reference to an asset version that no longer exists. This is the one that silently breaks a
  //    generation much later, so it is worth surfacing even though nothing is obviously wrong now.
  const knownVersionIds = new Set();
  for (const asset of assets) {
    for (const variant of asset.variants ?? []) {
      for (const file of variant.files ?? []) if (file.missing !== true) knownVersionIds.add(file.assetVersionId);
    }
  }
  const danglingByShot = [];
  for (const document of documents) {
    for (const shot of document.shots ?? []) {
      for (const reference of shot.references ?? []) {
        if (typeof reference.assetVersionId === 'string' && !knownVersionIds.has(reference.assetVersionId)) {
          danglingByShot.push({ document: document.relativePath, shotId: shot.shotId, name: reference.name ?? reference.fileName ?? '?' });
        }
      }
    }
  }
  if (danglingByShot.length > 0) {
    findings.push({
      kind: 'dangling-reference',
      severity: 'warn',
      detail: `${String(danglingByShot.length)} 个引用指向已经不存在的资产版本`,
      action: '重新扫描资产库；若文件被改名或移动，用 relocate 指认它，或删掉引用后重选',
      items: danglingByShot.slice(0, 20),
    });
  }

  // 0b. A character variant with a picture but NO 四视图. The four-view is not decoration: it is the
  //     file the video model is fed when a shot references that costume, so a variant without one
  //     either falls back to the identity variant (the wrong costume on screen) or cannot bind at
  //     all. Reported, never queued: starting GPU work from a health check is what hard constraint
  //     10 forbids, and it would also spend the card on every project that merely opened health.
  const missingQuadview = [];
  for (const asset of assets) {
    if (asset.kind !== 'character') continue;
    for (const variant of asset.variants ?? []) {
      const files = (variant.files ?? []).filter((file) => file.missing !== true);
      if (files.length === 0) continue;
      if (files.some((file) => file.role === 'quadview')) continue;
      missingQuadview.push({
        assetId: asset.assetId ?? null,
        name: asset.name,
        variant: variant.name ?? 'default',
        files: files.length,
      });
    }
  }
  if (missingQuadview.length > 0) {
    findings.push({
      kind: 'variant-missing-quadview',
      severity: 'warn',
      detail: `${String(missingQuadview.length)} 个人物变体只有定妆照，没有四视图`,
      action: '主角色的每个造型都要在资产页点一次「生成四视图并 3x 超分」：四视图才是视频模型真正喂进去的那张，缺了它这一集引用这个造型只能退回基础造型。次要角色／群像可以只有定妆照，这条按需要忽略',
      items: missingQuadview.slice(0, 20),
    });
  }


  // 2. A candidate whose file is gone. The alternative is a play button for a missing file.
  const missingCandidates = candidates.filter((candidate) => candidate.exists === false);
  if (missingCandidates.length > 0) {
    findings.push({
      kind: 'missing-candidate',
      severity: 'warn',
      detail: `${String(missingCandidates.length)} 个候选的文件已不在磁盘上`,
      action: '这些候选无法播放或选用；用 prune 清掉它们（已选用和已存入的不受影响）',
      items: missingCandidates.slice(0, 20).map((candidate) => ({ candidateId: candidate.candidateId, fileName: candidate.fileName })),
    });
  }

  // 3. Jobs the ledger still calls live, on an instance that may no longer be reachable. Not an
  //    error: this is exactly what "restart and reconcile" is for.
  const live = jobs.filter((job) => ['intent', 'submitting', 'submission_unknown', 'queued', 'running', 'downloading'].includes(job.state));
  if (live.length > 0) {
    findings.push({
      kind: 'unfinished-job',
      severity: 'info',
      detail: `${String(live.length)} 个任务还没结束`,
      action: '用 comfy_job 核对：只有 submission_unknown 需要人工确认，其余可以等或取消',
      items: live.slice(0, 20).map((job) => ({ jobId: job.jobId, state: job.state, promptId: job.promptId ?? null })),
    });
  }

  // 4. Cache sized, so "clean up" has a number attached instead of being a leap of faith.
  const caches = [];
  for (const dir of cacheDirs) {
    const absolute = join(projectRoot ?? root ?? '.', dir);
    if (!existsSync(absolute)) continue;
    let bytes = 0;
    let files = 0;
    const walk = async (at) => {
      for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(at, entry.name));
        else { files += 1; bytes += await stat(join(at, entry.name)).then((info) => info.size, () => 0); }
      }
    };
    await walk(absolute);
    caches.push({ dir, files, bytes, safe: true });
  }
  if (caches.length > 0) {
    findings.push({
      kind: 'cache',
      severity: 'info',
      detail: `可清理的派生数据：${caches.map((cache) => `${cache.dir}（${String(Math.round(cache.bytes / 1024))} KB / ${String(cache.files)} 个）`).join('、')}`,
      action: '这些是缩略图等派生数据，删掉只会重新生成一次；已选用素材和运行中任务依赖的东西不在此列',
      items: caches,
    });
  }

  return {
    findings,
    // Stated so a caller does not have to infer it: a clean health check is not the same as a
    // project that has been generated.
    checked: ['dangling-reference', 'missing-candidate', 'unfinished-job', 'cache'],
    clean: findings.filter((finding) => finding.severity === 'warn').length === 0,
  };
}

/**
 * A diagnostic bundle, redacted.
 *
 * ## What it must not contain
 *
 * A diagnostic that carries the script, the prompt text or an absolute user path is one the user
 * cannot safely share, and a diagnostic nobody shares is one that never helps. So: no narrative
 * text, no file contents, and paths reduced to their shape (`<project>/资产/...`) rather than their
 * location. The tunnel address and any token are dropped entirely - the handbook names that
 * explicitly - because a credential in a support bundle is a worse outcome than a slower diagnosis.
 */
export function buildDiagnostic({ host = {}, project = null, instance = null, jobs = [], workflows = null, problems = [] } = {}) {
  const shapeOfPath = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    // Keep only the last two segments: enough to recognise which file, not enough to locate the
    // machine. The drive letter and every parent directory are dropped.
    const parts = value.replace(/\\/gu, '/').split('/').filter((part) => part.length > 0 && !/^[a-z]:$/iu.test(part));
    return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
  };

  const redactAddress = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
      const url = new URL(value);
      // The PORT is kept: it is what tells instances apart. The HOST is dropped, because a tunnel
      // hostname can be a per-user subdomain and is the part that identifies the account.
      return `${url.protocol}//<host>:${url.port.length > 0 ? url.port : '(default)'}`;
    } catch {
      return '<unparseable address>';
    }
  };

  return {
    generatedAt: new Date().toISOString(),
    host: {
      contractVersion: host.contractVersion ?? null,
      capabilities: Array.isArray(host.capabilities) ? host.capabilities.length : 0,
      loadedAt: host.loadedAt ?? null,
      mode: host.mode ?? null,
    },
    // The project NAME is dropped, not shortened. It is the script's title - the user's own work -
    // and a support bundle has no use for it: what a diagnosis needs is how big the project is, not
    // what it is called. Keeping it would make the bundle something the user has to think about
    // before sending, and a bundle nobody sends helps nobody.
    project: project === null ? null : { episodes: project.episodes ?? 0, shots: project.shots ?? 0 },
    instance: instance === null ? null : {
      // Redacted on purpose: see the note above.
      address: redactAddress(instance.baseUrl),
      comfyuiVersion: instance.comfyuiVersion ?? null,
      devices: Array.isArray(instance.devices) ? instance.devices.map((device) => ({ name: device.name ?? null, vramTotal: device.vramTotal ?? null })) : [],
    },
    jobs: {
      total: jobs.length,
      byState: jobs.reduce((accumulator, job) => ({ ...accumulator, [job.state]: (accumulator[job.state] ?? 0) + 1 }), {}),
      // The most recent few, with paths reduced to shape and no prompt text.
      recent: jobs.slice(0, 10).map((job) => ({
        jobId: job.jobId,
        state: job.state,
        workflow: shapeOfPath(job.plan?.workflow),
        inputs: (job.plan?.inputs ?? []).length,
        note: typeof job.note === 'string' ? job.note.slice(0, 200) : null,
      })),
    },
    workflows: workflows === null ? null : {
      count: workflows.count ?? 0,
      missingModels: (workflows.missingModels ?? []).slice(0, 40),
      withBypassedOutput: workflows.withBypassedOutput ?? 0,
    },
    problems: problems.slice(0, 40),
  };
}

/**
 * Whether an episode's prompt sources still agree (D08).
 *
 * ## Why this cannot be a comparison of text
 *
 * The three sources are the same shots written for different consumers: 视频提示词 is the readable
 * one, H3 中文 and H3 英文 are the model inputs. Their TEXT is supposed to differ - that is the whole
 * point of having three. So "they differ" is the normal state and says nothing.
 *
 * What actually indicates drift is STRUCTURE and TIME:
 *
 *   - a different number of 大分镜 means one source has a shot the others do not, which is drift by
 *     definition and needs no interpretation;
 *   - the same count but different content hashes is AMBIGUOUS. It is either a legitimate
 *     translation or an edit that was never carried across, and nothing here can tell those apart.
 *     So it is reported as "review", not as "stale" - claiming to know would be the more expensive
 *     mistake, because a false "up to date" is what ships the wrong prompt.
 *   - modification times order the sources, so the newest one is named as the likely source of
 *     truth. That is evidence, not proof, and it is labelled as such.
 */
export function compareSources({ sources = [], blocksBySource = {}, mtimes = {} } = {}) {
  const present = sources.filter((source) => blocksBySource[source.id] !== undefined);
  if (present.length < 2) {
    return { status: 'single', sources: [], note: present.length === 0 ? '这一集还没有提示词文件' : '只有一个来源，无从比对' };
  }

  const counts = new Map(present.map((source) => [source.id, blocksBySource[source.id].length]));
  const distinctCounts = new Set(counts.values());

  // Different counts: unambiguous drift. Name which source is the odd one out, because that is the
  // only thing the user needs to know to fix it.
  if (distinctCounts.size > 1) {
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      status: 'count-mismatch',
      sources: present.map((source) => ({
        id: source.id,
        label: source.label,
        blocks: counts.get(source.id),
        differs: counts.get(source.id) !== modal[1],
      })),
      note: `块数不一致：${present.map((source) => `${source.label} ${String(counts.get(source.id))} 块`).join('、')}。有来源多了或少了镜头，需要人工对齐`,
    };
  }

  // Same count: compare content, and report a difference as something to REVIEW rather than as
  // staleness, because a translation and an unapplied edit look identical from here.
  const hashes = new Map(present.map((source) => [source.id, blocksBySource[source.id].map((block) => block.anchor ?? '').join('|')]));
  const distinctHashes = new Set(hashes.values());
  const ordered = present
    .map((source) => ({ id: source.id, label: source.label, blocks: counts.get(source.id), mtime: mtimes[source.id] ?? null }))
    .sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')));

  if (distinctHashes.size === 1) {
    return { status: 'identical', sources: ordered, newest: ordered[0]?.id ?? null, note: '三个来源内容一致' };
  }
  return {
    status: 'review',
    sources: ordered,
    newest: ordered[0]?.id ?? null,
    note: `块数一致但内容不同（最新改动的是「${ordered[0]?.label ?? '?'}」）。中英文提示词本来就不一样，所以这既可能是正常翻译，也可能是改了没同步 —— 需要你自己看一眼`,
  };
}

/**
 * Duration consistency (D09).
 *
 * The prompt text is the ONLY source of truth for duration (hard constraint 7); nothing here stores
 * a competing value. What it does is state what the text SAYS and where that looks wrong, so a
 * contradiction is visible before a generation is attempted rather than after a clip comes back the
 * wrong length.
 */
export function checkDurations({ blocks = [], declaredTotal = null, minSeconds = 4, maxSeconds = 15 } = {}) {
  const findings = [];
  const parsed = blocks.map((block, index) => {
    const text = String(block.text ?? '');
    const shotDurations = [...text.matchAll(/[（(]\s*时长\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[)）]/giu)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    const bodySeconds = shotDurations.length > 0
      ? shotDurations.reduce((total, value) => total + value, 0)
      : null;
    const headingSeconds = typeof block.seconds === 'number' ? block.seconds : null;
    return {
      index,
      title: block.title ?? `第 ${String(index + 1)} 块`,
      seconds: headingSeconds,
      bodySeconds,
      shotDurations,
      // Per-shot body durations are the executable truth. When both exist, use the body sum
      // for range checking and report the heading mismatch separately.
      effectiveSeconds: bodySeconds ?? headingSeconds,
    };
  });

  const missing = parsed.filter((block) => block.effectiveSeconds === null);
  if (missing.length > 0) {
    findings.push({
      kind: 'duration-missing',
      severity: 'info',
      detail: `${String(missing.length)} 个块没有解析出时长`,
      action: '正文里没有写时长。生成时将由模型自行决定，成片长度不可预期 —— 需要可控时长就在正文里写明',
      items: missing.map((block) => ({ title: block.title })),
    });
  }

  const outOfRange = parsed.filter((block) => block.effectiveSeconds !== null
    && (block.effectiveSeconds < minSeconds || block.effectiveSeconds > maxSeconds));
  if (outOfRange.length > 0) {
    findings.push({
      kind: 'duration-out-of-range',
      severity: 'warn',
      detail: `${String(outOfRange.length)} 个块的时长超出 ${String(minSeconds)}–${String(maxSeconds)} 秒`,
      action: `当前视频模型单次生成有秒数上下限，超出的块要么拆开要么缩短。正文仍是唯一依据，这里只提示`,
      items: outOfRange.map((block) => ({ title: block.title, seconds: block.effectiveSeconds, headingSeconds: block.seconds, bodySeconds: block.bodySeconds })),
    });
  }

  const mismatchedBlocks = parsed.filter((block) => block.seconds !== null
    && block.bodySeconds !== null
    && Math.abs(block.seconds - block.bodySeconds) > 0.5);
  if (mismatchedBlocks.length > 0) {
    findings.push({
      kind: 'duration-body-mismatch',
      severity: 'warn',
      detail: `${String(mismatchedBlocks.length)} 个块的标题总时长与正文小分镜之和不一致`,
      action: 'H3 以实际镜头正文为准。请修正标题或正文，避免面板选择时长时和实际提示词冲突',
      items: mismatchedBlocks.map((block) => ({
        title: block.title,
        headingSeconds: block.seconds,
        bodySeconds: block.bodySeconds,
        shotDurations: block.shotDurations,
      })),
    });
  }

  const malformedSilence = blocks.flatMap((block, index) => {
    const text = String(block.text ?? '');
    const lines = [...text.matchAll(/无台词[，,]\s*只有([^。\r\n]*)/gu)];
    return lines
      .filter((match) => match[1].trim() !== '呼吸与眼神变化')
      .map((match) => ({ title: block.title ?? `第 ${String(index + 1)} 块`, actual: match[0] }));
  });
  if (malformedSilence.length > 0) {
    findings.push({
      kind: 'no-dialogue-phrase',
      severity: 'warn',
      detail: `${String(malformedSilence.length)} 处无台词镜头没有使用固定句式`,
      action: '有人物时统一写“无台词，只有呼吸与眼神变化”；画面无人时写“无台词，无人物”',
      items: malformedSilence,
    });
  }

  const sum = parsed.reduce((total, block) => total + (block.effectiveSeconds ?? 0), 0);
  if (declaredTotal !== null && parsed.every((block) => block.effectiveSeconds !== null) && Math.abs(sum - declaredTotal) > 0.5) {
    findings.push({
      kind: 'duration-mismatch',
      severity: 'warn',
      detail: `各块时长之和是 ${String(sum)} 秒，但本集声明的是 ${String(declaredTotal)} 秒`,
      action: '两者对不上。以正文各块为准，请检查本集总时长是否该改，或者是否有块漏写了时长',
      items: [{ sum, declaredTotal }],
    });
  }

  return { sum, declaredTotal, perBlock: parsed, findings, consistent: findings.filter((finding) => finding.severity === 'warn').length === 0 };
}

/** Hash one project file, for a migration package manifest. */
export async function hashFileAt(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** A file's name without its extension, for a display label. */
export const stemOf = (path) => basename(String(path)).replace(/\.[^.]+$/u, '');
