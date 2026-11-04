/**
 * Small cross-process file lock used by mutable JSON stores.
 *
 * The plugin keeps several read-modify-write stores on disk (state, the job
 * ledger and result indexes). A unique temp file makes each individual write
 * atomic, but it does not make "read, decide, write" atomic. This helper locks
 * that whole critical section.
 *
 * @module short-drama-director/file-lock
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Acquire a lock and return a release function that only removes the lock it
 * owns. The ownership token prevents a slow writer from deleting a successor's
 * lock after stale-lock recovery.
 */
export async function acquireFileLock(lockPath, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
  checkPath = null,
} = {}) {
  const target = typeof checkPath === 'function' ? await checkPath(lockPath) : lockPath;
  const token = randomUUID();
  const started = Date.now();
  await mkdir(dirname(target), { recursive: true });

  for (;;) {
    try {
      await writeFile(target, `${JSON.stringify({
        pid: process.pid,
        token,
        at: new Date().toISOString(),
      })}\n`, { encoding: 'utf8', flag: 'wx' });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = await readOwner(target);
        if (owner?.token === token) await rm(target, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const [owner, age] = await Promise.all([
      readOwner(target),
      stat(target).then((info) => Date.now() - info.mtimeMs, () => 0),
    ]);
    if (age > staleMs && !processIsAlive(owner?.pid)) {
      await rm(target, { force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${target}; it is held by pid ${String(owner?.pid ?? 'unknown')} since ${String(owner?.at ?? 'unknown')}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  }
}

/** Run one read-modify-write section while holding a cross-process lock. */
export async function withFileLock(lockPath, task, options = {}) {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await task();
  } finally {
    await release();
  }
}
