/**
 * Where a generated result lands, and how it becomes an asset.
 *
 * ## Why isolation
 *
 * A generation used to be written straight into the folder the caller named. In a drama project
 * that folder is the asset tree the user organised by hand, so the effect was that every
 * experiment became indistinguishable from a decision: four attempts at a character's costume
 * sat beside the approved file with nothing saying which was which, and the newest attempt was
 * silently the one the pipeline used.
 *
 * So a result is written to `.director/results/<jobId>/` first. It is a CANDIDATE there -
 * named, hashed, and recorded against the shot that asked for it - and nothing uses it until
 * someone selects it. Promotion to the asset tree is a separate, explicit step, which is what
 * makes "生成完成" and "审片通过" two facts instead of one.
 *
 * ## Why a candidate is not deleted when it loses
 *
 * The losing attempts are the record of what was tried. Removing them makes "why is this one
 * the good one" unanswerable, and a re-run to recover a discarded attempt costs GPU time. They
 * are kept until someone prunes them, and the prune is explicit.
 *
 * @module dsh-plugin-short-drama-director/lib/result-store
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { withFileLock } from './file-lock.js';

/** Schema version of a result index. */
export const RESULT_SCHEMA_VERSION = 1;

/** Where results live inside a project. */
export const RESULTS_DIR = '.director/results';
export const RESULT_TRASH_DIR = '.director/results/.trash';

export const RESULT_SELECTION_ROLES = Object.freeze({
  /** This is the input to use from now on. */
  generation: 'generation',
  /** This passed review. */
  approved: 'approved',
});

/** Media this store will accept as a result. */
const RESULT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.flac']);

/** Comparison/scratch outputs are diagnostics, never deliverables or candidates. */
export function isTransientResultName(name) {
  const file = basename(String(name ?? '').replace(/\\/gu, '/'));
  return /^(?:rgthree\.compare\._temp_|TE_compare_[AB]_|te_man_video_compare_[ab]_|VHS_compare_)/iu.test(file);
}

let counter = 0;
/** A unique temp path, so two writers never share one file. */
function tempPathFor(path) {
  counter += 1;
  return `${path}.${process.pid}.${counter}.${randomUUID().slice(0, 8)}.tmp`;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempPathFor(path);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** sha256 of a file, streamed so a large video does not sit in memory. */
export async function hashFile(path) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

/** A safe file name derived from a produced name, so a result cannot escape its own folder. */
export function safeResultName(name) {
  const raw = String(name ?? '');
  const ext = extname(raw);
  // Leading dots are stripped from the stem: a name like `.png` has NO extension (node treats
  // it as a dotfile) and would otherwise become a hidden file, which is a result the user cannot
  // see in their own folder browser.
  const stem = basename(raw, ext).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60).replace(/^[.]+/u, '') || 'result';
  return `${stem}${ext.toLowerCase()}`;
}

/**
 * The results of one project.
 *
 * @param options.root - absolute project root.
 * @param options.media - the media service, so a recorded candidate can be shown immediately.
 */
export function createResultStore(root, { media = null, fs = null, getPolicy = undefined } = {}) {
  const resultsRoot = join(root, RESULTS_DIR);
  const indexPath = join(resultsRoot, 'index.json');
  const policyFor = typeof getPolicy === 'function' ? getPolicy : () => undefined;

  const checkedPath = async (path) => {
    if (fs !== null && fs !== undefined && typeof fs.checkedTarget === 'function') {
      const target = await fs.resolve(path, { cwd: root });
      const checked = await fs.checkedTarget(target, policyFor());
      return checked?.targetKey ?? path;
    }
    const policy = policyFor();
    if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access') {
      const error = new Error(`cannot write "${path}": file access denied under ${String(policy.mode ?? 'workspace-write')} mode`);
      error.code = 'FS_SANDBOX_DENIED';
      throw error;
    }
    return path;
  };
  const writeCheckedJson = async (path, value) => {
    await writeJsonAtomic(await checkedPath(path), value);
  };
  const mkdirChecked = async (path) => mkdir(await checkedPath(path), { recursive: true });

  const read = async () => {
    try {
      return JSON.parse(await readFile(indexPath, 'utf8'));
    } catch {
      return { schemaVersion: RESULT_SCHEMA_VERSION, candidates: [] };
    }
  };

  /** Mint a media handle for a recorded path, so the panel can show it without a path. */
  const withMedia = (candidate) => (media === null || typeof media.mint !== 'function'
    ? candidate
    : { ...candidate, mediaHandle: media.mint(join(root, candidate.relativePath)) });
  const visibleCandidates = (stored) => (stored.candidates ?? []).filter((candidate) =>
    !isTransientResultName(candidate.fileName ?? candidate.relativePath));

  return {
    root: resultsRoot,

    /**
     * Copy one produced file into the candidate area for a shot.
     *
     * The copy is what makes the candidate durable: the instance's output directory is not this
     * machine's, and a result that exists only there is lost the moment the instance is rebuilt.
     *
     * @returns the recorded candidate.
     */
    async record({ jobId, shotId = null, episodeNumber = null, blockNumber = null, sourcePath, producedName = null, role = null, note = null }) {
      return await withFileLock(`${indexPath}.lock`, async () => {
        const absolute = resolve(sourcePath);
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error(`${absolute} is not a file`);

      const extension = extname(absolute).toLowerCase();
      if (!RESULT_EXTENSIONS.has(extension)) {
        const error = new Error(`${extension || '(no extension)'} is not a media result; the store only keeps images, video and audio`);
        error.code = 'UNSUPPORTED_RESULT';
        throw error;
      }
      if (isTransientResultName(basename(producedName ?? absolute))) {
        const error = new Error(`${basename(producedName ?? absolute)} is a temporary comparison artifact and cannot become a result candidate`);
        error.code = 'TRANSIENT_RESULT';
        throw error;
      }

      const sha256 = await hashFile(absolute);
      const stored = await read();

      // The same bytes arriving twice is one candidate. Re-recording the identical output - a
      // retry of a download, or the same file collected twice - must not create a second entry
      // the user then has to tell apart.
        const duplicate = stored.candidates.find((candidate) => candidate.sha256 === sha256 && candidate.jobId === jobId);
        if (duplicate !== undefined) return { ...withMedia(duplicate), duplicate: true };

        const folder = join(resultsRoot, safeResultName(jobId));
        await mkdirChecked(folder);
        const fileName = safeResultName(producedName ?? basename(absolute));
        let target = join(folder, fileName);
      // Two different files with the same produced name both have to be kept, so the second
      // gets a suffix rather than overwriting the first.
        let suffix = 1;
        while (await stat(target).then(() => true, () => false)) {
          suffix += 1;
          const ext = extname(fileName);
          target = join(folder, `${basename(fileName, ext)}_${suffix}${ext}`);
        }
        await copyFile(absolute, await checkedPath(target));

        const candidate = {
        candidateId: `res_${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
        jobId,
        shotId,
        // Which episode and which 大分镜 this belongs to. Stored so the name a user reads can be
        // built from the run itself rather than guessed from a file name later.
        episodeNumber: Number.isInteger(episodeNumber) ? episodeNumber : null,
        blockNumber: Number.isInteger(blockNumber) ? blockNumber : null,
        role,
        note,
        // Relative to the project root, so the record survives the project being moved.
        relativePath: join(RESULTS_DIR, safeResultName(jobId), basename(target)).replace(/\\/gu, '/'),
        fileName: basename(target),
        bytes: info.size,
        sha256,
        status: 'candidate',
        // The two facts this whole module exists to separate.
        generatedAt: new Date().toISOString(),
        selectedAt: null,
        };
        await writeCheckedJson(indexPath, { ...stored, candidates: [...stored.candidates, candidate] });
        return { ...withMedia(candidate), duplicate: false };
      });
    },

    /** Every candidate, newest first, optionally for one shot. */
    async list({ shotId = null, jobId = null, status = null } = {}) {
      const stored = await read();
      const rows = visibleCandidates(stored).filter((candidate) => {
        if (shotId !== null && candidate.shotId !== shotId) return false;
        if (jobId !== null && candidate.jobId !== jobId) return false;
        if (status !== null && candidate.status !== status) return false;
        return true;
      });
      return rows
        .sort((left, right) => String(right.generatedAt).localeCompare(String(left.generatedAt)))
        .map(withMedia);
    },

    /**
     * Mark one candidate selected, and every sibling for the same shot not selected.
     *
     * This is the "选用此版本" of G03, and it is a separate call from `record` on purpose:
     * recording happens when the instance finishes, selecting happens when a person has looked.
     *
     * @param options.role - `generation` (this is the input to use from now on) or `approved`
     *   (this passed review). The two are different decisions and a user may make only the first.
     */
    async select(candidateId, { note = null, role = null } = {}) {
      return await withFileLock(`${indexPath}.lock`, async () => {
      // D12: selecting used to OVERWRITE `role` with the generic `generation`, so a clip recorded as
      // `H3-外卖送到三年前-文戏` came back as `generation` - the only label saying which mode and
      // which production it came from was destroyed by the act of choosing it. The role now
      // defaults to whatever the candidate already had; a caller may still set one explicitly.
      if (role !== null && !Object.values(RESULT_SELECTION_ROLES).includes(role)) throw new Error(`unknown selection role "${role}"`);
      const stored = await read();
      const target = stored.candidates.find((candidate) => candidate.candidateId === candidateId);
      if (target === undefined) throw new Error(`no result candidate ${candidateId}`);
      const effectiveRole = role ?? target.role ?? RESULT_SELECTION_ROLES.generation;
      const at = new Date().toISOString();
      const superseded = [];
      const next = {
        ...stored,
        candidates: stored.candidates.map((candidate) => {
          if (candidate.candidateId === candidateId) return { ...candidate, status: 'selected', role: effectiveRole, selectedAt: at, note: note ?? candidate.note };
          // A shot has one selected result. Leaving the previous one selected would make "which
          // version is in use" a question with two answers.
          if (target.shotId !== null && candidate.shotId === target.shotId && candidate.status === 'selected') {
            superseded.push(candidate.candidateId);
            // A promoted candidate keeps its promotion: the file was already copied into the
            // user's tree, and un-selecting it here cannot un-copy it. Reporting it as merely
            // superseded without saying so would be a smaller lie than the truth allows.
            return { ...candidate, status: 'superseded', supersededBy: candidateId, supersededAt: at };
          }
          return candidate;
        }),
      };
      await writeCheckedJson(indexPath, next);
      const updated = next.candidates.find((candidate) => candidate.candidateId === candidateId);
      return { ...updated, superseded };
      });
    },

    /**
     * Copy a selected candidate to its final home.
     *
     * Promotion is explicit and separate from selection so a user can approve a result inside
     * the panel without it appearing in the asset tree - the tree is theirs to organise.
     *
     * `requireSelected` defaults to true: copying into the ASSET TREE is a promotion, and the tree
     * is what later generations read, so an un-reviewed take must not land there. It is false for
     * 「存到本集」, which files the finished clip into its own episode folder: that is archiving, not
     * approval, and requiring selection would deadlock the common single-take case - with one
     * candidate there is nothing to compare, so there would be no way to select it at all.
     *
     * @returns the destination path.
     */
    async promote(candidateId, destinationPath, { overwrite = false, requireSelected = true } = {}) {
      return await withFileLock(`${indexPath}.lock`, async () => {
      const stored = await read();
      const candidate = stored.candidates.find((entry) => entry.candidateId === candidateId);
      if (candidate === undefined) throw new Error(`no result candidate ${candidateId}`);
      if (requireSelected && candidate.status !== 'selected') {
        const error = new Error('只有选用的结果才能落到资产目录：先生成、再审片、再选用。这一步不会自动发生');
        error.code = 'NOT_SELECTED';
        throw error;
      }
      const from = join(root, candidate.relativePath);
      const to = resolve(destinationPath);
      if (!overwrite && await stat(to).then(() => true, () => false)) {
        const error = new Error(`${to} already exists; pass overwrite to replace it`);
        error.code = 'DESTINATION_EXISTS';
        throw error;
      }
      await mkdirChecked(dirname(to));
      await copyFile(from, await checkedPath(to));
      const next = {
        ...stored,
        candidates: stored.candidates.map((entry) => (entry.candidateId === candidateId
          ? { ...entry, promotedTo: to.replace(/\\/gu, '/'), promotedAt: new Date().toISOString() }
          : entry)),
      };
      await writeCheckedJson(indexPath, next);
      return to;
      });
    },

    /**
     * Move candidates that were never selected into project-local trash.
     *
     * Explicit, and it refuses to touch a selected one. A synchronous compare artifact is
     * always removable: it was never a user deliverable. Deletion is not final until another
     * prune replaces the undo record, so an accidental click cannot destroy a costly take.
     */
    async prune({ keepSelected = true, before = null } = {}) {
      return await withFileLock(`${indexPath}.lock`, async () => {
      const stored = await read();
      const doomed = stored.candidates.filter((candidate) => {
        const transient = isTransientResultName(candidate.fileName ?? candidate.relativePath);
        if (!transient && keepSelected && (candidate.status === 'selected' || candidate.promotedTo !== undefined)) return false;
        if (before !== null && String(candidate.generatedAt) >= String(before)) return false;
        return true;
      });
      const batchId = `prune_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
      const moves = [];
      for (const candidate of doomed) {
        const source = join(root, candidate.relativePath);
        const trashRelative = join(
          RESULT_TRASH_DIR,
          batchId,
          `${candidate.candidateId}-${basename(candidate.relativePath)}`,
        ).replace(/\\/gu, '/');
        const target = join(root, ...trashRelative.split('/'));
        await mkdirChecked(dirname(target));
        try {
          await rename(source, await checkedPath(target));
          moves.push({ candidateId: candidate.candidateId, trashRelativePath: trashRelative });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      const doomedIds = new Set(doomed.map((candidate) => candidate.candidateId));
      const remaining = stored.candidates.filter((candidate) => !doomedIds.has(candidate.candidateId));
      await writeCheckedJson(indexPath, {
        ...stored,
        candidates: remaining,
        lastPrune: {
          batchId,
          at: new Date().toISOString(),
          candidates: doomed,
          moves,
        },
      });
      return {
        removed: doomed.length,
        kept: visibleCandidates({ candidates: remaining }).length,
        bytes: doomed.reduce((sum, candidate) => sum + (Number(candidate.bytes) || 0), 0),
        batchId,
        undoAvailable: moves.length > 0,
      };
      });
    },

    /** Restore the most recent prune from the project-local trash. */
    async undoPrune(batchId = null) {
      return await withFileLock(`${indexPath}.lock`, async () => {
      const stored = await read();
      const last = stored.lastPrune ?? null;
      if (last === null || typeof last !== 'object') return { restored: 0, reason: '没有可撤销的清理记录' };
      if (batchId !== null && batchId !== last.batchId) return { restored: 0, reason: '清理批次不匹配' };
      const restored = [];
      for (const move of last.moves ?? []) {
        const candidate = (last.candidates ?? []).find((entry) => entry.candidateId === move.candidateId);
        if (candidate === undefined) continue;
        const source = join(root, ...String(move.trashRelativePath).split('/'));
        const target = join(root, candidate.relativePath);
        if (await stat(target).then(() => true, () => false)) continue;
        await mkdirChecked(dirname(target));
        await rename(source, await checkedPath(target));
        restored.push(candidate);
      }
      const restoredIds = new Set(restored.map((candidate) => candidate.candidateId));
      await writeCheckedJson(indexPath, {
        ...stored,
        candidates: [...stored.candidates.filter((candidate) => !restoredIds.has(candidate.candidateId)), ...restored],
        lastPrune: null,
      });
      return { restored: restored.length, batchId: last.batchId };
      });
    },

    /** How many candidates exist, without reading their bytes. */
    async stats() {
      const stored = await read();
      const candidates = visibleCandidates(stored);
      return {
        total: candidates.length,
        selected: candidates.filter((candidate) => candidate.status === 'selected').length,
        promoted: candidates.filter((candidate) => candidate.promotedTo !== undefined).length,
        candidates: candidates.filter((candidate) => candidate.status === 'candidate').length,
      };
    },

    /** Whether a results folder exists at all, for a cheap empty-state check. */
    async exists() {
      return await stat(resultsRoot).then((info) => info.isDirectory(), () => false);
    },
  };
}

/** Every result folder name under a project, for a scan that does not read the index. */
export async function listResultFolders(root) {
  try {
    const entries = await readdir(join(root, RESULTS_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name !== '.trash').map((entry) => entry.name);
  } catch {
    return [];
  }
}
