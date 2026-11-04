/**
 * Controlled media reads, so the panel can show an asset or play a finished shot.
 *
 * ## Why this is not "just send the file"
 *
 * The panel runs in a browser context and the web server listens on a port. A handler that
 * turned a path from the URL into a file read would expose the whole disk to anything that can
 * reach that port - and the port is reachable by other pages, other local users, and a
 * browser extension. So a request carries an opaque ID, the ID is resolved against a set THIS
 * PROCESS minted, and a path that was never handed out is not readable. That is the difference
 * between a preview endpoint and a file-disclosure bug.
 *
 * ## Why Range matters here
 *
 * A finished shot is 4-15 seconds of 720p video, tens of megabytes. Without Range support the
 * browser cannot seek, cannot start playing before the whole file arrives, and a `video`
 * element that re-requests on every render re-downloads everything. The handbook asks for
 * playback in place; this is what makes that possible rather than a spinner.
 *
 * @module dsh-plugin-short-drama-director/lib/media-service
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/** Extensions that may be served, and the content type each is served as. */
const MEDIA_TYPES = new Map(Object.entries({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}));

/** How long a minted handle stays valid. Long enough for a session, short enough to be a lease. */
export const HANDLE_TTL_MS = 12 * 60 * 60 * 1000;

/** Only this many entries are kept; the oldest are dropped, because a session mints a few hundred at most. */
const MAX_HANDLES = 4000;

/**
 * The media reader for one plugin lifetime.
 *
 * @param options.roots - directories a handle may point into. A path outside all of them is
 *   refused even when the handle is valid, so a bug that mints a handle for the wrong file
 *   still cannot serve something outside the user's projects.
 */
export function createMediaService({ roots = [] } = {}) {
  /** handle -> { path, mintedAt } */
  const handles = new Map();

  const allowedRoots = roots.map((root) => resolve(root));

  /** Is this path inside one of the allowed roots? */
  const insideRoots = (path) => {
    const target = resolve(path);
    return allowedRoots.some((root) => {
      const rel = relative(root, target);
      // `relative` returning a path that climbs out, or an absolute one (different drive on
      // Windows), both mean "not inside".
      return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    });
  };

  /** Resolve both sides before comparing, so a symlink or junction cannot escape a root. */
  const insideRealRoots = async (path) => {
    let target;
    try {
      target = await realpath(path);
    } catch {
      return false;
    }
    for (const root of allowedRoots) {
      const realRoot = await realpath(root).catch(() => resolve(root));
      const rel = relative(realRoot, target);
      if (rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
    }
    return false;
  };

  /**
   * Mint a handle for one file, or return the existing one while its BYTES are unchanged.
   *
   * Path alone is not identity for previews: replacing a portrait at the same path kept the old
   * handle, so the browser's in-memory preview URL cache continued to render the previous large
   * image while the content-addressed thumbnail showed the new one. Size + mtime + ctime is a
   * cheap file-version signature; a changed file gets a new opaque handle and therefore a new URL.
   */
  const mint = (path) => {
    const absolute = resolve(path);
    const signature = (() => {
      try {
        const info = statSync(absolute);
        return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch {
        return 'missing';
      }
    })();
    for (const [handle, entry] of handles) {
      if (entry.path === absolute && entry.signature === signature) return handle;
    }
    const handle = randomUUID().replace(/-/gu, '');
    handles.set(handle, { path: absolute, signature, mintedAt: Date.now() });
    if (handles.size > MAX_HANDLES) {
      // Drop the oldest rather than refusing new ones: a panel that has been open all day
      // would otherwise stop being able to show anything new.
      const oldest = [...handles.entries()].sort((a, b) => a[1].mintedAt - b[1].mintedAt)[0];
      if (oldest !== undefined) handles.delete(oldest[0]);
    }
    return handle;
  };

  /** Resolve a handle back to a path, or undefined when it is unknown or expired. */
  const resolveHandle = (handle) => {
    const entry = handles.get(String(handle));
    if (entry === undefined) return undefined;
    if (Date.now() - entry.mintedAt > HANDLE_TTL_MS) {
      handles.delete(String(handle));
      return undefined;
    }
    return entry.path;
  };

  return {
    mint,
    resolveHandle,
    insideRoots,
    insideRealRoots,
    allowRoot(root) {
      const absolute = resolve(root);
      if (!allowedRoots.includes(absolute)) allowedRoots.push(absolute);
    },
    get size() { return handles.size; },

    /** Mint for many paths at once, keyed by the caller's own id. */
    mintAll(entries) {
      const out = {};
      for (const [key, path] of Object.entries(entries ?? {})) {
        if (typeof path !== 'string' || path.length === 0) continue;
        out[key] = mint(path);
      }
      return out;
    },

    /**
     * Answer one ranged request.
     *
     * Returns the HTTP status it used, so the caller can assert on it. The response is written
     * by this function because streaming cannot be delegated without losing the Range logic.
     */
    async serve(req, res, { handle, contentType = null } = {}) {
      const path = resolveHandle(handle);
      if (path === undefined) {
        return sendError(res, 404, 'unknown or expired media handle; reload the panel to mint a new one');
      }
      let info;
      try {
        info = await stat(path);
      } catch {
        return sendError(res, 404, 'the file is no longer on disk');
      }
      if (!info.isFile()) return sendError(res, 404, 'not a file');
      if (!await insideRealRoots(path)) {
        // A valid handle pointing outside the configured roots means a bug here, not a hostile
        // request, but the answer is the same: refuse.
        return sendError(res, 403, 'this file is outside the directories the panel may read');
      }

      const type = contentType ?? MEDIA_TYPES.get(extname(path).toLowerCase());
      if (type === undefined) return sendError(res, 415, 'this file type is not served as media');

      const total = info.size;
      const range = parseRange(req.headers?.range, total);
      if (range === 'unsatisfiable') {
        res.writeHead(416, {
          'content-range': `bytes */${total}`,
          'accept-ranges': 'bytes',
        });
        res.end();
        return 416;
      }

      const etag = `"${createHash('sha256').update(`${path}:${total}:${info.mtimeMs}`).digest('hex').slice(0, 24)}"`;
      if (req.headers?.['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'accept-ranges': 'bytes' });
        res.end();
        return 304;
      }

      const common = {
        'content-type': type,
        'accept-ranges': 'bytes',
        etag,
        // The panel is same-origin with the server, and a media element needs no more than
        // that. Naming the policy beats leaving it to the browser's default.
        // A replaced asset commonly keeps the same path and therefore the same opaque handle.
        // Caching it for minutes made the large preview show the previous image while the
        // content-addressed thumbnail had already changed. Revalidate every time; ETag still
        // makes an unchanged file a cheap 304.
        'cache-control': 'private, no-cache, must-revalidate',
        'x-content-type-options': 'nosniff',
      };

      if (range === null) {
        res.writeHead(200, { ...common, 'content-length': String(total) });
        if (req.method === 'HEAD') { res.end(); return 200; }
        await pipe(createReadStream(path), res);
        return 200;
      }

      const { start, end } = range;
      const length = end - start + 1;
      res.writeHead(206, {
        ...common,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(length),
      });
      if (req.method === 'HEAD') { res.end(); return 206; }
      await pipe(createReadStream(path, { start, end }), res);
      return 206;
    },
  };
}

/**
 * Parse a `Range` header.
 *
 * Only the single-range form is honoured. A multi-range request (`bytes=0-1,5-6`) needs a
 * multipart body; answering it as if it were the first range would send the wrong bytes under
 * the right status code, so it is treated as absent and the whole file is sent instead - which
 * is always a correct answer to a range request.
 *
 * @returns `{start, end}`, `null` for "send everything", or `'unsatisfiable'`.
 */
export function parseRange(header, total) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null;

  const match = /^(\d*)-(\d*)$/u.exec(spec);
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;

  // `bytes=-500` is the LAST 500 bytes, not "from 0 to 500" - the single most misread form.
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, total - suffix);
    return { start, end: total - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= total) return 'unsatisfiable';
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Content type for a path, or undefined when it is not something this service serves. */
export function mediaTypeFor(path) {
  return MEDIA_TYPES.get(extname(String(path)).toLowerCase());
}

/** Whether a path is a media type this service will serve at all. */
export function isServableMedia(path) {
  return mediaTypeFor(path) !== undefined;
}

function sendError(res, status, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'x-content-type-options': 'nosniff' });
  res.end(body);
  return status;
}

/** Finish a stream before resolving, and never leave the response open on failure. */
function pipe(stream, res) {
  return new Promise((resolvePromise) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolvePromise();
    };
    stream.on('error', () => { res.destroy(); finish(); });
    stream.on('close', finish);
    res.on('close', () => { stream.destroy(); finish(); });
    stream.pipe(res);
    stream.on('end', finish);
  });
}

/**
 * The route paths the panel uses.
 *
 * A single prefix with the handle in the path, rather than a query string: a `video` element's
 * Range requests and a browser's cache both behave better with a stable path, and an opaque
 * path segment cannot be mistaken for a real filename when it shows up in a log.
 */
export const MEDIA_PREFIX = '/short-drama/media/';

/** Turn a request URL into the handle it names, or undefined. */
export function handleFromUrl(rawUrl) {
  const path = new URL(String(rawUrl ?? ''), 'http://localhost').pathname;
  if (!path.startsWith(MEDIA_PREFIX)) return undefined;
  const handle = decodeURIComponent(path.slice(MEDIA_PREFIX.length)).replace(/^\//u, '');
  // A handle is a bare 32-hex string. Anything else - a path, a traversal attempt, an empty
  // segment - never reaches the map.
  return /^[0-9a-f]{32}$/u.test(handle) ? handle : undefined;
}
