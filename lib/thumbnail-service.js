/**
 * Thumbnails, so a wall of candidates costs a wall of thumbnails.
 *
 * ## Why this is not optional
 *
 * The results grid and the compare view both load original files. A 9:16 character sheet is
 * around 1.2 MB at 928x1664; a 720p clip is tens of megabytes. Twenty candidates in a grid, or
 * two side by side, makes opening a tab the panel's heaviest operation - and the handbook lists
 * exactly this under desktop usability (H06: 大图视频按需加载).
 *
 * ## Why it is a cache and not a replacement
 *
 * The full-resolution file is the deliverable and must never be replaced by a smaller one. A
 * thumbnail is a separate, regenerable artefact derived from it, keyed by the source's sha256, so
 * a changed source produces a changed thumbnail and nothing stale is ever served. Deleting the
 * whole cache costs one regeneration and loses nothing.
 *
 * ## About the image library
 *
 * Scaling needs a native encoder, and this plugin ships none: `sharp` is reached for through the
 * harness installation, which has it for its own use. That is a deliberate, soft dependency:
 *
 *   - when `sharp` is present, a thumbnail is a real downscale (a 928x1664 PNG becomes 20 KB)
 *   - when it is absent, NO thumbnail is produced and the caller serves the original
 *
 * The second case is the important one. Copying the original under a thumbnail's name would look
 * like it worked while making the grid exactly as heavy as before, which is worse than saying no.
 *
 * @module dsh-plugin-short-drama-director/lib/thumbnail-service
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

/** Where thumbnails live, inside the project. Regenerable, so never a backup concern. */
export const THUMBNAIL_DIR = '.director/thumbnails';

/**
 * The box a thumbnail fits inside.
 *
 * Sized against what it is displayed at: a card is about 130-180 px wide and the compare pane is
 * half the sidebar. Encoding at 256 for a 160 px slot cost about 100 KB per image, which for a
 * grid of twenty is 2 MB - most of a full-size still, and the exact weight this cache exists to
 * remove. 180 lands at a third of that with no visible difference at the size it is shown.
 */
export const THUMBNAIL_BOX = Object.freeze({ width: 180, height: 180 });

/** Extensions a thumbnail can be made for. */
const THUMBNAILABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.avif']);

let sharpModule;
let sharpLooked = false;

/**
 * Locate `sharp`, once.
 *
 * Resolved as a bare specifier from this module, which finds it wherever the harness installation
 * has it. That works because the plugin is loaded from its real path on disk, so node's upward
 * `node_modules` walk reaches the harness's own tree. In a deployment where `sharp` is not on that
 * walk, this returns undefined and no thumbnail is produced - which is a documented, working
 * state, not a failure. See the module note.
 */
function loadSharp() {
  if (sharpLooked) return sharpModule;
  sharpLooked = true;
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('sharp');
    if (typeof loaded === 'function') sharpModule = loaded;
  } catch {
    sharpModule = undefined;
  }
  return sharpModule;
}

/** Whether a thumbnail can be produced here at all: the source type AND the encoder. */
export function thumbnailsAvailable() {
  return typeof loadSharp() === 'function';
}

/** Whether a thumbnail can be made for this file name. */
export function canThumbnail(fileName) {
  return THUMBNAILABLE.has(extname(String(fileName)).toLowerCase());
}

/** Cache key for one source: content plus size, so a changed file never reuses an entry. */
export function thumbnailKey({ sha256, bytes }) {
  return createHash('sha256').update(`${String(sha256)}:${Number(bytes) ?? 0}`).digest('hex').slice(0, 32);
}

/**
 * The thumbnail cache for one project.
 *
 * @param options.media - the media service, so a produced thumbnail gets an opaque handle like any
 *   other file and the panel still never receives a path.
 */
export function createThumbnailStore(root, { media = null, fs = null, getPolicy = undefined } = {}) {
  const cacheRoot = join(root, THUMBNAIL_DIR);
  const policyFor = typeof getPolicy === 'function' ? getPolicy : () => undefined;
  const handleFor = (path) => (media === null || typeof media.mint !== 'function' ? null : media.mint(path));
  const checkedPath = async (path) => {
    if (fs !== null && fs !== undefined && typeof fs.checkedTarget === 'function') {
      const target = await fs.resolve(path, { cwd: root });
      return (await fs.checkedTarget(target, policyFor()))?.targetKey ?? path;
    }
    const policy = policyFor();
    if (policy !== null && policy !== undefined && policy.mode !== 'danger-full-access') {
      const error = new Error(`cannot write "${path}": file access denied under ${String(policy.mode ?? 'workspace-write')} mode`);
      error.code = 'FS_SANDBOX_DENIED';
      throw error;
    }
    return path;
  };

  /**
   * Produce or reuse a thumbnail for one file.
   *
   * @returns `{ handle, thumbnailPath, bytes, cached }`, or `null` when no thumbnail is possible.
   *   `null` means "use the original" - never an error, and never a copy pretending to be one.
   */
  const ensure = async ({ sourcePath, fileName, sha256, bytes }) => {
    if (!canThumbnail(fileName)) return null;
    const encoder = loadSharp();
    if (typeof encoder !== 'function') return null;
    const policy = policyFor();
    if (policy?.mode === 'read-only') return null;

    const key = thumbnailKey({ sha256, bytes });
    const targetRoot = await checkedPath(cacheRoot).catch(() => null);
    if (targetRoot === null) return null;
    // PNG out, so a transparent character sheet does not gain a black box.
    const target = join(targetRoot, `${key}.png`);

    if (existsSync(target)) {
      return { handle: handleFor(target), thumbnailPath: target, bytes: (await stat(target)).size, cached: true };
    }

    try {
      await mkdir(targetRoot, { recursive: true });
      const buffer = await encoder(sourcePath)
        // `inside` keeps the aspect ratio: a squashed face is worse than a large file, because it
        // makes the choice the panel exists for harder rather than easier.
        .resize(THUMBNAIL_BOX.width, THUMBNAIL_BOX.height, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      // Written through the cache key, so a stale entry cannot survive a content change.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, buffer);
    } catch {
      // An unreadable or corrupt source is the caller's problem to report; failing the whole
      // listing over one bad file would be worse.
      return null;
    }
    const info = await stat(target);
    return { handle: handleFor(target), thumbnailPath: target, bytes: info.size, cached: false };
  };

  return {
    root: cacheRoot,
    ensure,

    /** Total size of the cache, for a panel that wants to say what it costs. */
    async stats() {
      let entries = [];
      try {
        entries = await readdir(cacheRoot);
      } catch {
        return { files: 0, bytes: 0 };
      }
      let total = 0;
      for (const name of entries) {
        total += await stat(join(cacheRoot, name)).then((info) => info.size, () => 0);
      }
      return { files: entries.length, bytes: total };
    },

    /** Delete the cache. Nothing is lost: every entry is derived and regenerable. */
    async clear() {
      const before = await this.stats();
      await rm(await checkedPath(cacheRoot), { recursive: true, force: true });
      return before;
    },
  };
}
