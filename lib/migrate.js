/**
 * Migrate an existing project folder into the sidecar metadata.
 *
 * Old projects were written before any of this existed: a `剧集/第N集/` tree with prompt
 * files inside, and nothing that says which block is which. Migration reads that layout and
 * writes `.director/` next to it.
 *
 * ## The rules this follows (work manual §5.1)
 *
 * - **Read-only scan first.** {@link planMigration} touches nothing. It reports what it
 *   found and what it could not decide, so the user sees the outcome before any write.
 * - **The prompt files are never modified.** Not renamed, not reordered, not reformatted.
 *   Migration adds metadata; the content is the user's.
 * - **Idempotent.** Running twice produces the same ids, because every id is derived from
 *   what is already recorded when it exists. A second run must not mint a second set.
 * - **Ambiguity is reported, not guessed.** A file whose block count disagrees with what
 *   was recorded, or an H3 file that cannot be paired with its source by anything but
 *   position, is listed for human alignment.
 * - **Nothing is linked by position across documents.** The three files of an episode -
 *   the video prompts, the Chinese H3, the English H3 - are separate documents with their
 *   own shot ids. Assuming "block 3 of each is the same shot" is exactly the mistake the
 *   manual calls out, because their block counts routinely differ.
 *
 * @module dsh-plugin-short-drama-director/lib/migrate
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeBlocks } from './storyboard.js';
import { DIRECTOR_SCHEMA_VERSION, DIRECTOR_DIR, hashText } from './director-store.js';

/** Which prompt-file flavour a file is, by name. Matches the panel's own detection. */
function kindOf(fileName) {
  if (/H3/iu.test(fileName) && /英/u.test(fileName)) return 'h3-en';
  if (/H3/iu.test(fileName)) return 'h3-zh';
  if (/视频提示词/u.test(fileName)) return 'video';
  return 'other';
}

/** Episode number from a folder name like `第3集`, or null. */
function episodeNumberOf(name) {
  const match = /^第\s*(\d+)\s*集$/u.exec(String(name).trim());
  return match === null ? null : Number(match[1]);
}

/** Files in an episode folder that are prompt sources rather than output or notes. */
function isPromptFile(name) {
  if (!name.endsWith('.txt')) return false;
  if (/剧本/u.test(name)) return false;
  if (/dataset/iu.test(name)) return false;
  return /提示词/u.test(name);
}

/**
 * Read the filesystem only. No writes, no ids, no side effects.
 *
 * @param root - absolute project root.
 * @returns `{ name, episodes, documents, problems, totals }` where every `documents` entry
 *   carries its blocks described but not yet identified.
 */
export async function planMigration(root) {
  const problems = [];
  const episodes = [];
  const documents = [];

  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read the project root ${root}: ${error?.message ?? error}`);
  }

  const episodeRoot = entries.find((entry) => entry.isDirectory() && entry.name === '剧集');
  if (episodeRoot === undefined) {
    problems.push({ kind: 'no-episodes', detail: `no 剧集/ folder under ${root}` });
  }

  let episodeDirs = [];
  if (episodeRoot !== undefined) {
    episodeDirs = (await readdir(join(root, '剧集'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  for (const dirName of episodeDirs) {
    const number = episodeNumberOf(dirName);
    if (number === null) {
      problems.push({ kind: 'unparsed-episode-folder', detail: dirName });
      continue;
    }
    const relativeFolder = `剧集/${dirName}`;
    const files = (await readdir(join(root, relativeFolder), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isPromptFile(entry.name))
      .map((entry) => entry.name)
      .sort();

    const sources = [];
    for (const fileName of files) {
      const relativePath = `${relativeFolder}/${fileName}`;
      const text = await readFile(join(root, relativePath), 'utf8');
      const blocks = describeBlocks(text);
      if (blocks.length === 0) {
        // An empty prompt file is normal for an episode still being planned; an unparsed
        // one is not. Only the second is a problem.
        if (text.trim().length > 0) {
          problems.push({ kind: 'unparsed-document', detail: relativePath, note: 'no 大分镜 heading was recognised; it will be stored as a single whole-file block' });
        }
      }
      documents.push({ relativePath, kind: kindOf(fileName), fileHash: hashText(text), blocks, episodeNumber: number });
      sources.push({ file: fileName, kind: kindOf(fileName), blocks: blocks.length });
    }

    const script = (await readdir(join(root, relativeFolder), { withFileTypes: true }))
      .find((entry) => entry.isFile() && /剧本/u.test(entry.name));

    episodes.push({ displayNumber: number, folder: relativeFolder, script: script?.name ?? null, sources });
  }

  episodes.sort((a, b) => a.displayNumber - b.displayNumber);

  // Counts that let the user judge the plan without reading the whole thing.
  const duplicateAnchors = [];
  for (const document of documents) {
    const seen = new Map();
    for (const block of document.blocks) {
      const count = (seen.get(block.anchor) ?? 0) + 1;
      seen.set(block.anchor, count);
    }
    for (const [anchor, count] of seen.entries()) {
      if (count > 1) duplicateAnchors.push({ relativePath: document.relativePath, anchor, count });
    }
  }
  if (duplicateAnchors.length > 0) {
    // Not fatal: the reconciler tells duplicates apart by occurrence. Reported because it
    // is the case where "which block is the original?" cannot be answered from content.
    problems.push({ kind: 'duplicate-blocks', detail: `${duplicateAnchors.length} content anchor(s) appear more than once; they are told apart by position and will be flagged if their counts change`, anchors: duplicateAnchors });
  }

  return {
    name: null,
    episodes,
    documents,
    problems,
    totals: {
      episodes: episodes.length,
      documents: documents.length,
      blocks: documents.reduce((sum, entry) => sum + entry.blocks.length, 0),
      files: documents.filter((entry) => entry.blocks.length > 0).length,
    },
  };
}

/**
 * Write the metadata for a plan, reusing anything already recorded.
 *
 * @param store - a `createDirectorStore` instance for the same root.
 * @param plan - the result of {@link planMigration}.
 * @param options.commit - `false` performs the whole computation and returns what it WOULD
 *   write, without writing. Defaults to `true`.
 */
export async function applyMigration(store, plan, { commit = true } = {}) {
  const summary = { projectCreated: false, documentsCreated: 0, documentsUpdated: 0, shots: 0, reusedIds: 0, projectId: null };

  for (const document of plan.documents) {
    // Reconciliation is what makes a second run idempotent: it matches by content anchor
    // against what is already stored, so existing ids are reused rather than re-minted.
    // "Reused" is counted from the ids that survived, not from the blocks that exist.
    const previous = await store.readDocument(document.relativePath);
    if (previous === undefined) summary.documentsCreated += 1; else summary.documentsUpdated += 1;
    summary.shots += document.blocks.length;
    if (previous !== undefined) summary.reusedIds += (previous.shots ?? []).length;
  }

  if (commit === false) return summary;

  // PROJECT: created once, or refreshed in place. The id is stable across runs, which is
  // what makes the second migration a no-op instead of a second set of identities.
  const existedBefore = await store.isInitialised();
  await store.ensureProject({ name: plan.name });
  summary.projectCreated = !existedBefore;
  summary.projectId = (await store.readProject()).projectId;

  for (const document of plan.documents) {
    await store.reconcileDocument(document.relativePath, {
      kind: document.kind,
      fileHash: document.fileHash,
      blocks: document.blocks.map((block) => ({ anchor: block.anchor })),
      // Migration is the one writer that states no expected revision: it adopts the file as
      // it stands, it is explicit, and the user asked for it.
    });
  }

  // Record the episode tree so a later read does not have to re-walk the disk.
  await store.writeEpisodes(plan.episodes.map((episode) => ({
    displayNumber: episode.displayNumber,
    folder: episode.folder,
    script: episode.script,
    sources: episode.sources.map((source) => ({ file: source.file, kind: source.kind })),
  })));

  return summary;
}

/**
 * Write a migration log entry.
 *
 * Kept separate from the metadata it describes: the log is the rollback aid, so it must
 * survive the metadata being rewritten. `beforeCreated` records whether the project
 * existed, which is what makes "undo" a well-defined act the first time and a no-op after.
 */
export async function writeMigrationLog(root, entry) {
  const dir = join(root, DIRECTOR_DIR, 'migrations');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'log.json');
  let log = [];
  try {
    log = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    log = [];
  }
  if (!Array.isArray(log)) log = [];
  log.push({ schemaVersion: DIRECTOR_SCHEMA_VERSION, at: new Date().toISOString(), ...entry });
  await writeFile(path, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  return path;
}

/** Whether a directory looks like a project this migration can read. */
export async function looksLikeProject(root) {
  try {
    const info = await stat(join(root, '剧集'));
    return info.isDirectory();
  } catch {
    return false;
  }
}
