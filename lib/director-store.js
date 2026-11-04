/**
 * Sidecar project metadata: stable identities, revisions and conflict detection.
 *
 * ## Why this exists
 *
 * The prompt files stay exactly where they are and keep their format - they are the user's
 * content and other tools read them. But a text file cannot carry the things the product
 * needs to remember: which shot a finished video belongs to, which asset version a shot is
 * bound to, what was selected. Those live here, in `.director/`, next to the content rather
 * than inside it.
 *
 * ## The problem it solves
 *
 * Everything used to be addressed by position. `writeShot(file, 3, text)` meant "the fourth
 * block", and any insert shifted every later position. Two consequences, both real:
 *
 *   - Insert a block above a shot that already has a generated video, and the video now
 *     belongs to the wrong shot.
 *   - Read a file, let the user edit it elsewhere, then save from a stale panel, and the
 *     edit lands on whatever is in that position now.
 *
 * So every block gets a `shotId` that survives insertion, reordering and deletion, plus a
 * per-file `revision` that a write must state before it is allowed to proceed.
 *
 * ## Identity rules (work manual §5.2)
 *
 * Inserting allocates a NEW shotId; existing shots only have their order and display number
 * updated. Copying allocates a new shotId and may copy the bound asset versions, but never
 * pretends the original's results are the copy's. Deleting archives the id and its results
 * rather than reusing them. An external edit that cannot be matched unambiguously stops for
 * human alignment instead of guessing - the whole point is to not move a job onto "whatever
 * is in position 3 now".
 *
 * @module dsh-plugin-short-drama-director/lib/director-store
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Metadata layout version. Bump when the shape changes; older files stay readable. */
export const DIRECTOR_SCHEMA_VERSION = 1;

/** Directory name, relative to the project root. */
export const DIRECTOR_DIR = '.director';

/** A stale lock is only reclaimed after this long, and only after checking its owner. */
const LOCK_STALE_MS = 60_000;

/** How long to wait for another writer before giving up. */
const LOCK_WAIT_MS = 10_000;

let tempCounter = 0;

/**
 * A unique temporary path for one atomic write.
 *
 * Uniqueness matters more than it looks. The obvious `${path}.tmp` is shared by every
 * writer, so two concurrent saves interleave their bytes into one file and the rename
 * publishes the mixture - a corrupt state file that looks like a successful save. Including
 * pid, a monotonic counter and a random suffix makes each write its own file.
 */
function tempPathFor(path) {
  tempCounter += 1;
  return `${path}.${process.pid}.${tempCounter}.${randomUUID().slice(0, 8)}.tmp`;
}

/** Write JSON atomically: unique temp, then rename over the target. */
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

/** Read JSON, returning `undefined` for absent or unparseable files. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** sha256 of a string, used for content anchors and file revisions. */
export function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * The anchor that identifies one block by its content.
 *
 * Only the body counts, and only after normalisation, because the heading is the panel's
 * label and line endings differ between editors. Two blocks that differ solely in heading
 * numbering are the same content and must share an anchor - that is what lets a renumbered
 * file keep its identities.
 */
export function blockAnchor(bodyText) {
  const normalised = String(bodyText)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return hashText(normalised);
}

/** A stable id with a readable prefix, so a log line says what the id refers to. */
function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/gu, '').slice(0, 20)}`;
}

export const newProjectId = () => newId('proj');
export const newEpisodeId = () => newId('ep');
export const newShotId = () => newId('shot');
export const newDocumentId = () => newId('doc');

/** Thrown when a write states a revision that is no longer current. */
export class RevisionConflictError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'RevisionConflictError';
    this.code = 'REVISION_CONFLICT';
    Object.assign(this, detail);
  }
}

/** Thrown when a caller addresses a shot by an id this document does not have. */
export class UnknownShotError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UnknownShotError';
    this.code = 'UNKNOWN_SHOT';
    Object.assign(this, detail);
  }
}

/**
 * A project-level lock, so two Host processes never write the same metadata at once.
 *
 * The work manual asks for a project-level cross-process lock whose stale-lock recovery
 * verifies the holder rather than trusting file age alone. This implementation records the
 * owner pid and start time inside the lock file, and reclaims only when the file is older
 * than {@link LOCK_STALE_MS} AND the recorded pid is not alive - age by itself would break
 * a slow but healthy writer.
 */
async function acquireLock(lockPath, { checkPath = null } = {}) {
  const target = typeof checkPath === 'function' ? await checkPath(lockPath) : lockPath;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(dirname(target), { recursive: true });
      // `wx` fails when the file exists, which is the mutual exclusion we want.
      await writeFile(target, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
      return async () => { await rm(target, { force: true }).catch(() => undefined); };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await readJson(target).catch(() => undefined);
      const age = await stat(target).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS && !isAlive(info?.pid)) {
        // The holder is gone: reclaim it. A live pid keeps its lock however old the file is.
        await rm(target, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`another process is writing this project's metadata (lock ${target}, held by pid ${String(info?.pid ?? 'unknown')} since ${String(info?.at ?? 'unknown')}). Close the other window or retry`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    }
  }
}

/** Whether a pid currently exists. `EPERM` means it exists but belongs to someone else. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Match the current blocks of a document against the identities recorded for it.
 *
 * The rules, in order, and deliberately in this order:
 *
 *  1. **Anchor plus occurrence.** Blocks are grouped by content anchor. A unique anchor
 *     matches its recorded id outright. Duplicates (the copy button produces them) are
 *     told apart by which occurrence they are, counting from the top.
 *  2. **Unmatched earlier ids keep their order.** Anything the anchors could not place is
 *     paired with the surviving unmatched ids in file order. This is what makes a plain
 *     insertion cheap: the new block gets no id here, and every existing id keeps its own.
 *  3. **Anything left over is new.** A fresh id is allocated.
 *
 * `ambiguous` is reported rather than silently resolved: when an anchor that was unique has
 * become duplicated, or the counts no longer line up, a caller that cares about a specific
 * shot's results must stop and ask the user which block is which.
 *
 * @param blocks - `[{ anchor }]` in file order, one per block.
 * @param recorded - `[{ shotId, anchor, occurrence, archived }]` as previously stored.
 * @returns `{ assignments, ambiguous, added, removed }`.
 */
export function reconcileBlocks(blocks, recorded) {
  const live = (Array.isArray(recorded) ? recorded : []).filter((entry) => entry?.archived !== true && typeof entry?.shotId === 'string');
  const byAnchor = new Map();
  for (const entry of live) {
    const list = byAnchor.get(entry.anchor) ?? [];
    list.push(entry);
    byAnchor.set(entry.anchor, list);
  }

  const assignments = new Array(blocks.length).fill(null);
  const used = new Set();
  const counts = new Map();

  // Pass 1 - anchor plus occurrence.
  for (const [index, block] of blocks.entries()) {
    const occurrence = counts.get(block.anchor) ?? 0;
    counts.set(block.anchor, occurrence + 1);
    const candidates = byAnchor.get(block.anchor) ?? [];
    // Prefer the recorded entry that claimed this exact occurrence.
    const exact = candidates.find((entry) => entry.occurrence === occurrence && !used.has(entry.shotId));
    const fallback = candidates.find((entry) => !used.has(entry.shotId));
    const chosen = exact ?? fallback;
    if (chosen === undefined) continue;
    assignments[index] = chosen.shotId;
    used.add(chosen.shotId);
  }

  // Pass 2 - surviving ids in order fill the still-empty slots in order.
  const leftovers = live.filter((entry) => !used.has(entry.shotId)).map((entry) => entry.shotId);
  const emptySlots = assignments.map((id, index) => (id === null ? index : -1)).filter((index) => index >= 0);
  const paired = Math.min(leftovers.length, emptySlots.length);
  for (let i = 0; i < paired; i += 1) {
    assignments[emptySlots[i]] = leftovers[i];
    used.add(leftovers[i]);
  }

  // Pass 3 - whatever is still empty is a new shot.
  const added = [];
  for (const slot of emptySlots.slice(paired)) {
    const id = newShotId();
    assignments[slot] = id;
    added.push(id);
  }

  const removed = leftovers.slice(paired);

  // Duplicated anchors are the case where "which one is the original?" has no answer from
  // content alone. Report it; do not decide it.
  const ambiguous = [];
  for (const [anchor, count] of counts.entries()) {
    if (count <= 1) continue;
    const recordedCount = (byAnchor.get(anchor) ?? []).length;
    if (recordedCount !== count) ambiguous.push({ anchor, blocks: count, recorded: recordedCount });
  }

  return { assignments, ambiguous, added, removed };
}

/**
 * Build the store bound to one project root.
 *
 * @param fs - the Host `ctx.fs` service, or a compatible stand-in.
 * @param root - absolute project root; `.director/` lives directly inside it.
 * @param getPolicy - resolves the sandbox policy for writes, exactly as the storyboard
 *   reader does. Metadata is written into the project, so it is fenced the same way.
 */
export function createDirectorStore(fs, root, getPolicy) {
  const policyFor = typeof getPolicy === 'function' ? getPolicy : () => undefined;

  const paths = {
    project: join(root, DIRECTOR_DIR, 'project.json'),
    documents: join(root, DIRECTOR_DIR, 'documents.json'),
    episodes: join(root, DIRECTOR_DIR, 'episodes.json'),
    assets: join(root, DIRECTOR_DIR, 'assets.json'),
    migration: join(root, DIRECTOR_DIR, 'migrations', 'log.json'),
    lock: join(root, DIRECTOR_DIR, 'write.lock'),
  };

  /**
   * Metadata is inside the project too. Check the caller's policy before creating
   * the lock or any temp file, then write to the target the file service approved.
   */
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

  /** Write one metadata file under the project lock, atomically. */
  const mutate = async (fn) => {
    const release = await acquireLock(paths.lock, { checkPath: checkedPath });
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const readProject = async () => await readJson(paths.project);
  const readDocuments = async () => (await readJson(paths.documents)) ?? { schemaVersion: DIRECTOR_SCHEMA_VERSION, documents: [] };
  const readEpisodes = async () => {
    const stored = await readJson(paths.episodes);
    return Array.isArray(stored?.episodes) ? stored.episodes : [];
  };

  return {
    root,
    paths,

    readProject,
    readDocuments,

    /**
     * Capture only the named document records for a multi-file edit.
     *
     * Paired structural actions touch two prompt files. If the second write fails after the
     * first succeeded, restoring only file bytes would leave new shot ids, revisions and an
     * archived deletion in `documents.json`. These snapshots let a caller put those records back
     * without replacing unrelated documents that may have been updated concurrently.
     */
    async readDocumentSnapshots(relativePaths) {
      const store = await readDocuments();
      const paths = [...new Set((Array.isArray(relativePaths) ? relativePaths : []).filter((entry) => typeof entry === 'string'))];
      return paths.map((relativePath) => {
        const index = store.documents.findIndex((entry) => entry.relativePath === relativePath);
        const value = index < 0 ? undefined : store.documents[index];
        return {
          relativePath,
          index,
          present: value !== undefined,
          value: value === undefined ? null : structuredClone(value),
        };
      });
    },

    /** Restore document records captured by {@link readDocumentSnapshots}. */
    async restoreDocumentSnapshots(snapshots) {
      return await mutate(async () => {
        const store = await readDocuments();
        const list = store.documents;
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
          if (typeof snapshot?.relativePath !== 'string') continue;
          const index = list.findIndex((entry) => entry.relativePath === snapshot.relativePath);
          if (snapshot.present === true && snapshot.value !== null && typeof snapshot.value === 'object') {
            if (index < 0) {
              const insertAt = Number.isInteger(snapshot.index)
                ? Math.min(Math.max(snapshot.index, 0), list.length)
                : list.length;
              list.splice(insertAt, 0, structuredClone(snapshot.value));
            }
            else list[index] = structuredClone(snapshot.value);
          } else if (index >= 0) {
            list.splice(index, 1);
          }
        }
        await writeCheckedJson(paths.documents, store);
        return store;
      });
    },

    /** Whether this project has been initialised (has `.director/project.json`). */
    async isInitialised() {
      return await readProject() !== undefined;
    },

    /**
     * Create or refresh `project.json` for this root.
     *
     * @returns the project record. The id is stable: calling twice does not re-mint it,
     *   which is what makes migration idempotent (work manual §5.1 step 8).
     */
    async ensureProject({ name = null } = {}) {
      return await mutate(async () => {
        const existing = await readProject();
        const now = new Date().toISOString();
        const next = existing === undefined
          ? {
            schemaVersion: DIRECTOR_SCHEMA_VERSION,
            projectId: newProjectId(),
            name,
            createdAt: now,
            updatedAt: now,
            revision: 0,
          }
          : { ...existing, name: name ?? existing.name ?? null, updatedAt: now };
        if (existing === undefined) await writeCheckedJson(paths.project, next);
        return next;
      });
    },

    /**
     * Record the project's three upfront decisions (画幅 / 画风 / 分辨率).
     *
     * Kept separate from `ensureProject` on purpose: `ensureProject` is an idempotent
     * "make sure the record exists" call that runs on almost every read, while these are
     * a user's answers. Folding them together would let a routine read overwrite a decision
     * with a default, which is exactly the failure this record exists to prevent.
     *
     * @param patch - partial settings; `undefined` leaves a field alone.
     * @param options.decidedBy - who answered: `user` (asked and answered), `script`
     *   (stated in the script itself), or `agent` (inferred and to be confirmed).
     */
    async setSettings(patch, { decidedBy = 'user' } = {}) {
      return await mutate(async () => {
        const existing = await readProject();
        if (existing === undefined) throw new Error('this project has no .director/project.json yet; initialise it before setting defaults');
        const now = new Date().toISOString();
        const current = existing.settings ?? {};
        const next = {
          ...existing,
          settings: { ...current, ...patch, decidedAt: now, decidedBy },
          updatedAt: now,
          revision: (Number.isInteger(existing.revision) ? existing.revision : 0) + 1,
        };
        await writeCheckedJson(paths.project, next);
        return next;
      });
    },

    /**
     * Read one document's own metadata record.
     *
     * @param relativePath - project-relative path, forward slashes, as stored.
     */
    async readDocument(relativePath) {      const store = await readDocuments();
      return store.documents.find((entry) => entry.relativePath === relativePath);
    },

    /**
     * Record a document's current blocks and hand every block a stable id.
     *
     * This is the only place ids are minted or reconciled, so a document's identities can
     * never be produced by two different code paths disagreeing.
     *
     * @param relativePath - project-relative path with forward slashes.
     * @param options.kind - `video` | `h3-zh` | `h3-en` | `other`, for display only.
     * @param options.fileHash - hash of the whole file as read.
     * @param options.blocks - `[{ anchor }]` in file order.
     * @param options.expectedRevision - when given, the document's revision must match or
     *   {@link RevisionConflictError} is thrown. Omit on a first read.
     * @param options.force - adopt the new content and bump the revision even when the
     *   stored fileHash differs (an explicit "I know it changed" from the caller).
     */
    async reconcileDocument(relativePath, { kind = 'other', fileHash, blocks, expectedRevision, force = false } = {}) {
      return await mutate(async () => {
        // Minting an identity IS adoption. `readShots` reconciles on every read, so the very
        // first read of a project allocates shot ids as a side effect - and if that left
        // `documents.json` without a `project.json`, the store would sit in a state where
        // ids exist but `isInitialised()` is false, so a writer would refuse to resolve the
        // ids it had just handed out. The invariant this restores: an id that exists is
        // always resolvable. A deliberate `migrate` still runs first and writes its own
        // record with `adoptedBy: 'migrate'`, so the two paths are distinguishable.
        if (await readProject() === undefined) {
          const now = new Date().toISOString();
          await writeCheckedJson(paths.project, {
            schemaVersion: DIRECTOR_SCHEMA_VERSION,
            projectId: newProjectId(),
            name: basename(root),
            createdAt: now,
            updatedAt: now,
            revision: 0,
            adoptedBy: 'read',
          });
        }

        const store = await readDocuments();
        const list = store.documents;
        const index = list.findIndex((entry) => entry.relativePath === relativePath);
        const previous = index < 0 ? undefined : list[index];

        if (previous !== undefined && expectedRevision !== undefined && expectedRevision !== previous.revision) {
          throw new RevisionConflictError(
            `this document is at revision ${previous.revision}, not ${expectedRevision}: it changed on disk since you read it. Reload and compare before saving`,
            { relativePath, expected: expectedRevision, actual: previous.revision, fileHash: previous.fileHash },
          );
        }

        const changedOnDisk = previous !== undefined && fileHash !== undefined && previous.fileHash !== fileHash;
        const reconciled = reconcileBlocks(blocks, previous?.shots ?? []);

        // Touching the stored record when nothing changed would rewrite the file on every
        // read. Only a content change, an id change, or an explicit force bumps it.
        const idsChanged = previous === undefined
          || reconciled.added.length > 0
          || reconciled.removed.length > 0
          || reconciled.assignments.some((id, i) => previous.shots[i]?.shotId !== id);
        const blockMetadataChanged = previous !== undefined && reconciled.assignments.some((id, order) => {
          const before = previous.shots.find((entry) => entry.shotId === id);
          const sourceNumber = Number.isInteger(blocks[order].sourceNumber) ? blocks[order].sourceNumber : order + 1;
          return before !== undefined && before.sourceNumber !== sourceNumber;
        });

        const shots = reconciled.assignments.map((shotId, order) => {
          const before = (previous?.shots ?? []).find((entry) => entry.shotId === shotId);
          return {
            shotId,
            order,
            anchor: blocks[order].anchor,
            occurrence: blocks.slice(0, order).filter((entry) => entry.anchor === blocks[order].anchor).length,
            displayNumber: order + 1,
            sourceNumber: Number.isInteger(blocks[order].sourceNumber) ? blocks[order].sourceNumber : order + 1,
            // Carry forward what belongs to the identity, not to the position.
            assetBindings: before?.assetBindings ?? [],
            selectedResultId: before?.selectedResultId ?? null,
            // The @ bindings recorded for this shot. Kept across a re-scan for the same reason
            // the asset bindings are: a reference is a decision about which file version a shot
            // was built from, and rebuilding the record must not discard it.
            references: before?.references ?? [],
            referenceSlots: before?.referenceSlots ?? [],
            archived: false,
          };
        });

        const next = {
          documentId: previous?.documentId ?? newDocumentId(),
          relativePath,
          kind,
          fileHash: fileHash ?? previous?.fileHash ?? null,
          revision: previous === undefined
            ? 1
            : (changedOnDisk || idsChanged || blockMetadataChanged || force ? previous.revision + 1 : previous.revision),
          updatedAt: new Date().toISOString(),
          shots,
          // Archived ids are remembered so a deleted shot's results are never re-attached
          // to a new block that happens to look the same.
          archivedShots: [...(previous?.archivedShots ?? []), ...reconciled.removed.map((shotId) => ({ shotId, at: new Date().toISOString() }))],
        };

        if (index < 0) list.push(next); else list[index] = next;
        await writeCheckedJson(paths.documents, { schemaVersion: DIRECTOR_SCHEMA_VERSION, documents: list });

        return { document: next, added: reconciled.added, removed: reconciled.removed, ambiguous: reconciled.ambiguous, changedOnDisk };
      });
    },

    /**
     * Record that a document's block order changed without changing ids.
     *
     * Used by insert and reorder, where the id set is known and reconciliation would only
     * risk re-deriving it. `insert` allocates the new id and calls this.
     *
     * @param expectedRevision - required: a structural edit must state its base revision.
     */
    async setShots(relativePath, shots, { expectedRevision, fileHash } = {}) {
      return await mutate(async () => {
        const store = await readDocuments();
        const index = store.documents.findIndex((entry) => entry.relativePath === relativePath);
        if (index < 0) throw new Error(`no metadata for ${relativePath}; read the document before editing it structurally`);
        const previous = store.documents[index];
        if (expectedRevision !== undefined && expectedRevision !== previous.revision) {
          throw new RevisionConflictError(
            `this document is at revision ${previous.revision}, not ${expectedRevision}`,
            { relativePath, expected: expectedRevision, actual: previous.revision },
          );
        }
        const byId = new Map(previous.shots.map((entry) => [entry.shotId, entry]));
        const next = {
          ...previous,
          fileHash: fileHash ?? previous.fileHash,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString(),
          shots: shots.map((entry, order) => {
            const before = byId.get(entry.shotId);
            return {
              shotId: entry.shotId,
              order,
              anchor: entry.anchor,
              occurrence: entry.occurrence ?? 0,
              displayNumber: order + 1,
              sourceNumber: Number.isInteger(entry.sourceNumber) ? entry.sourceNumber : (before?.sourceNumber ?? order + 1),
              assetBindings: before?.assetBindings ?? entry.assetBindings ?? [],
              selectedResultId: before?.selectedResultId ?? null,
              references: before?.references ?? entry.references ?? [],
              referenceSlots: before?.referenceSlots ?? entry.referenceSlots ?? [],
              archived: false,
            };
          }),
          archivedShots: previous.archivedShots ?? [],
        };
        store.documents[index] = next;
        await writeCheckedJson(paths.documents, store);
        return next;
      });
    },

    /**
     * Move one document record when its physical prompt file is renamed.
     *
     * Per-shot H3 files carry the 大分镜 number in both the filename and the heading. A
     * structural insert renames every later file and heading; moving only the bytes would
     * orphan the old shot identity and make the next read mint a new id. Keeping the record
     * attached preserves the shot's results, references and selection across that rename.
     */
    async moveDocument(fromRelativePath, toRelativePath, { block = null, fileHash = null } = {}) {
      return await mutate(async () => {
        const store = await readDocuments();
        const fromIndex = store.documents.findIndex((entry) => entry.relativePath === fromRelativePath);
        const toIndex = store.documents.findIndex((entry) => entry.relativePath === toRelativePath);
        if (fromIndex < 0) throw new Error(`no metadata for ${fromRelativePath}; read the document before renaming it`);
        if (toIndex >= 0) throw new Error(`metadata already exists for ${toRelativePath}; refusing to overwrite it`);
        const previous = store.documents[fromIndex];
        const next = {
          ...previous,
          relativePath: toRelativePath,
          updatedAt: new Date().toISOString(),
          revision: (Number.isInteger(previous.revision) ? previous.revision : 0) + 1,
          ...(typeof fileHash === 'string' ? { fileHash } : {}),
          shots: previous.shots.map((entry, order) => (
            order === 0 && block !== null && typeof block === 'object'
              ? {
                ...entry,
                order: 0,
                displayNumber: 1,
                sourceNumber: Number.isInteger(block.sourceNumber) ? block.sourceNumber : entry.sourceNumber,
                anchor: typeof block.anchor === 'string' ? block.anchor : entry.anchor,
                occurrence: 0,
              }
              : entry
          )),
        };
        store.documents.splice(fromIndex, 1, next);
        await writeCheckedJson(paths.documents, store);
        return next;
      });
    },

    /**
     * Record the @ references resolved for one shot.
     *
     * Written separately from the shot list because resolving references does not change the text:
     * a binding can be re-established after an asset is re-scanned without touching a character of
     * the prompt, and bumping the document revision for that would make an unrelated panel believe
     * the file had been edited.
     */
    async setShotReferences(relativePath, shotId, references) {
      return await mutate(async () => {
        const store = await readDocuments();
        let index = store.documents.findIndex((entry) => entry.relativePath === relativePath);
        // A legacy document may still be keyed with the project folder in front. The shot id is
        // project-unique, so it can reconnect that record without minting a second identity.
        if (index < 0) {
          index = store.documents.findIndex((entry) =>
            (entry.shots ?? []).some((shot) => shot.shotId === shotId));
        }
        if (index < 0) throw new Error(`no metadata for ${relativePath}; read the document before recording references`);
        const previous = store.documents[index];
        const at = previous.shots.findIndex((entry) => entry.shotId === shotId);
        if (at < 0) throw new UnknownShotError(`no shot ${shotId} in ${relativePath}`, { relativePath, shotId });
        const next = {
          ...previous,
          updatedAt: new Date().toISOString(),
          shots: previous.shots.map((entry, order) => (order === at
            ? { ...entry, references: Array.isArray(references) ? references : [] }
            : entry)),
        };
        store.documents[index] = next;
        await writeCheckedJson(paths.documents, store);
        return next.shots[at];
      });
    },

    /**
     * Record panel-only decisions about numbered H3 reference slots.
     *
     * The prompt is user-authored, so removing a tile or replacing its file must not rewrite
     * the text. `definition` is the exact line the decision was made against; when the user
     * edits that line, the stale decision is ignored and normal text resolution wins again.
     */
    async setShotReferenceSlots(relativePath, shotId, referenceSlots) {
      return await mutate(async () => {
        const store = await readDocuments();
        let index = store.documents.findIndex((entry) => entry.relativePath === relativePath);
        if (index < 0) {
          index = store.documents.findIndex((entry) =>
            (entry.shots ?? []).some((shot) => shot.shotId === shotId));
        }
        if (index < 0) throw new Error(`no metadata for ${relativePath}; read the document before recording reference slots`);
        const previous = store.documents[index];
        const at = previous.shots.findIndex((entry) => entry.shotId === shotId);
        if (at < 0) throw new UnknownShotError(`no shot ${shotId} in ${relativePath}`, { relativePath, shotId });
        const next = {
          ...previous,
          updatedAt: new Date().toISOString(),
          shots: previous.shots.map((entry, order) => (order === at
            ? { ...entry, referenceSlots: Array.isArray(referenceSlots) ? referenceSlots : [] }
            : entry)),
        };
        store.documents[index] = next;
        await writeCheckedJson(paths.documents, store);
        return next.shots[at];
      });
    },

    /**
     * Preserve the exact text of a deleted block.
     *
     * `archivedShots` already kept removed ids so old results could not attach to a new block.
     * A user-triggered structural delete also needs the content: otherwise the only recovery
     * path is whatever backup the filesystem happens to provide.
     */
    async archiveShot(relativePath, shotId, { text = '', heading = '', fileName = null, index = null } = {}) {
      return await mutate(async () => {
        const store = await readDocuments();
        const indexAt = store.documents.findIndex((entry) => entry.relativePath === relativePath);
        if (indexAt < 0) throw new Error(`no metadata for ${relativePath}; read the document before deleting a shot`);
        const previous = store.documents[indexAt];
        const entry = {
          shotId,
          at: new Date().toISOString(),
          text: String(text ?? ''),
          heading: String(heading ?? ''),
          fileName: fileName === null ? null : String(fileName),
          index: Number.isInteger(index) ? index : null,
        };
        const next = {
          ...previous,
          updatedAt: new Date().toISOString(),
          archivedShots: [...(previous.archivedShots ?? []), entry],
        };
        store.documents[indexAt] = next;
        await writeCheckedJson(paths.documents, store);
        return entry;
      });
    },

    /** Look one shot up by id across every document of the project. */
    async findShot(shotId) {
      const store = await readDocuments();
      for (const document of store.documents) {
        const shot = (document.shots ?? []).find((entry) => entry.shotId === shotId);
        if (shot !== undefined) return { document, shot };
      }
      return undefined;
    },

    /** The episode tree as recorded at migration time, so a read need not re-walk the disk. */
    readEpisodes,

    /** The asset index, or undefined before the first scan. */
    async readAssetIndex() {
      return await readJson(paths.assets);
    },

    /** Replace the asset index. Shares the project lock, so it cannot interleave. */
    async writeAssetIndex(index, { locked = false } = {}) {
      if (locked) {
        await writeCheckedJson(paths.assets, index);
        return index;
      }
      return await mutate(async () => {
        await writeCheckedJson(paths.assets, index);
        return index;
      });
    },

    /**
     * Replace the recorded episode tree.
     *
     * Episodes get their own stable id here for the same reason shots do: "第 1 集" is a
     * display number that can be renumbered, and it is only unique inside one project. The
     * id is keyed on the folder, so re-running migration does not mint a second set.
     */
    async writeEpisodes(episodes) {
      return await mutate(async () => {
        const previous = await readEpisodes();
        const byFolder = new Map(previous.map((entry) => [entry.folder, entry]));
        const next = episodes.map((episode) => {
          const before = byFolder.get(episode.folder);
          return {
            episodeId: before?.episodeId ?? newEpisodeId(),
            displayNumber: episode.displayNumber,
            folder: episode.folder,
            script: episode.script ?? null,
            sources: episode.sources ?? [],
            updatedAt: new Date().toISOString(),
          };
        });
        await writeCheckedJson(paths.episodes, { schemaVersion: DIRECTOR_SCHEMA_VERSION, episodes: next });
        return next;
      });
    },

    /** Resolve a shot id to its current position in its document. */
    async locate(shotId) {
      const found = await this.findShot(shotId);
      if (found === undefined) return undefined;
      return { relativePath: found.document.relativePath, index: found.shot.order, revision: found.document.revision };
    },

    /** Run a function while holding the project write lock. */
    withLock: mutate,

    /** Exposed for tests and diagnostics. */
    _tempPathFor: tempPathFor,
  };
}
