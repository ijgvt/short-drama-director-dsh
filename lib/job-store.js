/**
 * A durable job ledger, so a generation outlives the process that started it.
 *
 * ## What the in-memory table got wrong (R01)
 *
 * Jobs lived in a `Map` inside the tool module, and the entry was written AFTER the run had
 * already finished. Two consequences:
 *
 *   - **A restart lost the ledger.** The prompt id was gone, so a run that was queued or
 *     generating could neither be collected nor even named. The GPU kept working for nobody.
 *   - **The window was not covered.** Between `POST /prompt` succeeding and the entry being
 *     written, the process held the only record of that prompt id. A crash in that window
 *     left a job running on the instance with nothing on this side that knew it existed.
 *
 * The fix is an ordering change plus persistence: record the INTENT before contacting the
 * instance, attach the prompt id the moment it comes back, and keep the record on disk.
 *
 * ## Idempotency, stated honestly
 *
 * A `requestId` makes a submission safe to repeat: the same id returns the same job instead
 * of starting a second run. But there is one window where no amount of local bookkeeping
 * helps - the POST was sent and the reply never arrived. In that state the instance MIGHT be
 * generating, and re-posting could double the work while not re-posting could leave a
 * finished job uncollected. Neither is knowable from here, so the job enters
 * `submission_unknown`, is reported to the user, and is NEVER retried automatically. That is
 * the honest answer: a question for a human, not a decision for the code.
 *
 * @module dsh-plugin-short-drama-director/lib/job-store
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withFileLock } from './file-lock.js';

/** Ledger schema version. */
export const JOB_SCHEMA_VERSION = 1;

/**
 * The states a job moves through, in order.
 *
 * `download_failed` is deliberately not `error`: the generation succeeded and the bytes are
 * still on the instance, so the remedy is to retry the download, not to run the model again.
 * The handbook is explicit that "ComfyUI 运行完成", "文件已保存" and "用户已选用" are three
 * different facts, and this list is where that distinction lives.
 */
export const JOB_STATES = Object.freeze([
  'intent',             // recorded here, nothing sent yet
  'submitting',         // the POST is in flight
  'submission_unknown', // the POST went out and no reply came back - a human must check
  'queued',
  'running',
  'completed',          // the instance finished; outputs are named
  'downloading',
  'download_failed',    // outputs exist on the instance, the local copy does not
  'saved',              // local files written
  'failed',             // the instance reported a failure
  'cancelled',
]);

/** States that no longer change on their own. */
export const TERMINAL_STATES = Object.freeze(['saved', 'failed', 'cancelled', 'download_failed', 'submission_unknown']);

/** States where the instance may still be doing work. */
export const LIVE_STATES = Object.freeze(['submitting', 'queued', 'running', 'downloading', 'intent']);

let tempCounter = 0;

/** A unique temp path, so two writers never share one file. */
function tempPathFor(path) {
  tempCounter += 1;
  return `${path}.${process.pid}.${tempCounter}.${randomUUID().slice(0, 8)}.tmp`;
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

/** sha256 of a canonical JSON rendering, for the plan hash. */
export function hashPlan(plan) {
  return createHash('sha256').update(stableStringify(plan), 'utf8').digest('hex');
}

/**
 * A deterministic JSON rendering.
 *
 * Key order must not change the hash: two callers describing the same plan with their object
 * literals written in a different order are the same plan, and treating them as different
 * would make the same-request-different-plan check fire on nothing.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Where the ledger lives when no project owns the job. */
export function defaultLedgerDir(env = process.env) {
  const home = env.DSH_HOME ?? join(env.USERPROFILE ?? env.HOME ?? '.', '.dsh');
  return join(home, 'short-drama', 'jobs');
}

/**
 * Open the ledger.
 *
 * One directory, one JSON file per job. A single index file would be rewritten on every state
 * change - a write amplification on the hot path and a wider corruption window - while a file
 * per job makes each update independent. The directory listing IS the index, and it is cheap
 * because the count is in the hundreds, not millions.
 *
 * @param options.dir - ledger directory. Defaults to {@link defaultLedgerDir}.
 */
export function createJobStore({ dir = defaultLedgerDir() } = {}) {
  const pathFor = (jobId) => {
    const id = String(jobId ?? '');
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(id)) throw new Error(`invalid job id ${JSON.stringify(jobId)}`);
    return join(dir, `${id}.json`);
  };

  /** Read one job, or undefined. */
  const read = async (jobId) => {
    try {
      return JSON.parse(await readFile(pathFor(jobId), 'utf8'));
    } catch {
      return undefined;
    }
  };

  /** Write one job, atomically. */
  const write = async (job) => {
    const next = { ...job, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(pathFor(job.jobId), next);
    return next;
  };

  /** Apply a mutation under the current record, so callers never write a stale copy. */
  const update = async (jobId, mutate) => {
    const path = pathFor(jobId);
    return await withFileLock(`${path}.lock`, async () => {
      const current = await read(jobId);
      if (current === undefined) throw new Error(`no job ${jobId} in the ledger`);
      const next = (await mutate({ ...current })) ?? current;
      return await write(next);
    });
  };

  return {
    dir,
    pathFor,
    read,
    write,
    update,

    /** Every job, newest first. */
    async list({ state = null, limit = 100 } = {}) {
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const jobs = [];
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        try {
          jobs.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
        } catch {
          // A job file that cannot be parsed is reported by `corrupt`, not silently skipped.
          jobs.push({ jobId: name.replace(/\.json$/u, ''), corrupt: true });
        }
      }
      const filtered = state === null ? jobs : jobs.filter((job) => job.state === state);
      filtered.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      return filtered.slice(0, limit);
    },

    /** Jobs that may still be doing work on an instance. */
    async live() {
      const jobs = await this.list({ limit: 1000 });
      return jobs.filter((job) => LIVE_STATES.includes(job.state));
    },

    /**
     * Record the intent to submit, before anything is sent.
     *
     * This is the ordering fix. The record exists first, so a crash during the POST leaves a
     * recoverable trace instead of a prompt id nobody wrote down.
     */
    async beginIntent(options) {
      return await withFileLock(join(dir, '.begin-intent.lock'), async () => {
        const { requestId, plan, instanceId = null, projectId = null, shotId = null, name = null, output = null } = options;
        const planHash = hashPlan(plan);
        const existing = await this.findByRequestId(requestId);
        if (existing !== undefined) {
          // Same request id: return the SAME job rather than starting another run. A repeat must
          // be a no-op, which is what makes a double click harmless.
          if (existing.planHash !== planHash) {
            const error = new Error(
              `request id ${requestId} was already used for a different plan (${String(existing.planHash).slice(0, 12)} vs ${planHash.slice(0, 12)}). `
              + `A request id identifies ONE plan; use a new id for a new plan`,
            );
            error.code = 'IDEMPOTENCY_CONFLICT';
            throw error;
          }
          return { job: existing, reused: true };
        }
        const now = new Date().toISOString();
        const job = {
          schemaVersion: JOB_SCHEMA_VERSION,
          jobId: `job_${randomUUID().replace(/-/gu, '').slice(0, 20)}`,
          requestId,
          planHash,
          // The immutable snapshot: what was asked for, frozen at submit time. Later edits to
          // the prompt or the assets must not change what a finished run is recorded as having
          // used.
          plan,
          instanceId,
          projectId,
          shotId,
          name,
          output,
          promptId: null,
          state: 'intent',
          attempt: 1,
          createdAt: now,
          updatedAt: now,
          events: [{ at: now, state: 'intent' }],
        };
        return { job: await write(job), reused: false };
      });
    },

    /** Find a job by the request id that created it. */
    async findByRequestId(requestId) {
      if (typeof requestId !== 'string' || requestId.length === 0) return undefined;
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        return undefined;
      }
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        try {
          const job = JSON.parse(await readFile(join(dir, name), 'utf8'));
          if (job?.requestId === requestId) return job;
        } catch {
          // One corrupt unrelated record must not disable idempotency for every job.
        }
      }
      return undefined;
    },

    /**
     * Move a job to a new state, appending to its event trail.
     *
     * The trail is what makes "是排队、卡住还是失败" answerable after the fact: a state alone
     * says where it is, the trail says how long each step took and whether it moved backwards.
     */
    async setState(jobId, state, detail = {}) {
      if (!JOB_STATES.includes(state)) throw new Error(`unknown job state "${state}"`);
      return await update(jobId, (job) => {
        const now = new Date().toISOString();
        const changed = job.state !== state
          || (detail.note !== undefined && detail.note !== job.note);
        return {
          ...job,
          state,
          ...detail,
          updatedAt: now,
          // Polling is a heartbeat, not a state transition. Appending `running`, `completed`
          // and `saved` on every refresh produced thousands of duplicate UI steps for one job.
          events: changed
            ? [...(job.events ?? []), { at: now, state, ...(detail.note === undefined ? {} : { note: detail.note }) }]
            : (job.events ?? []),
        };
      });
    },

    /** Attach the prompt id the moment it comes back, and move to `queued`. */
    async attachPromptId(jobId, promptId) {
      return await this.setState(jobId, 'queued', { promptId: String(promptId) });
    },

    /**
     * Mark a submission whose reply never arrived.
     *
     * `detail.note` records how long the POST was allowed to run before this was decided, so
     * the user has something to judge by.
     */
    async markSubmissionUnknown(jobId, note) {
      return await this.setState(jobId, 'submission_unknown', { note, checkedAt: null });
    },

    /** Record that a human (or a later reconciliation) resolved an unknown submission. */
    async resolveSubmission(jobId, resolution) {
      return await update(jobId, (job) => ({
        ...job,
        resolution,
        resolvedAt: new Date().toISOString(),
      }));
    },
  };
}

/**
 * The synchronous face of the ledger, for the one caller that cannot await.
 *
 * The plugin's own mode/status path is synchronous, so it cannot use the async store; reading
 * a directory of small JSON files is cheap, and this exists mainly so the two paths cannot
 * disagree about what "unfinished" means.
 */
export function readLedgerSync(dir = defaultLedgerDir()) {
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      out.push({ jobId: name.replace(/\.json$/u, ''), corrupt: true });
    }
  }
  return out;
}

/** How many jobs are in a live state, synchronously. */
export function countLiveSync(dir = defaultLedgerDir()) {
  return readLedgerSync(dir).filter((job) => LIVE_STATES.includes(job.state)).length;
}
