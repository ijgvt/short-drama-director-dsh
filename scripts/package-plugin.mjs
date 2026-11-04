import AdmZip from '../vendor/adm-zip/adm-zip.js';
import { createHash } from 'node:crypto';
import {
  copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_FOLDER = 'dsh-plugin-short-drama-director';
const TOP_LEVEL_FILES = [
  'index.js',
  'client.js',
  'package.json',
  'cordis.patch.yml',
  '安装说明.md',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
const TOP_LEVEL_DIRECTORIES = ['lib', 'skills', 'vendor'];
const SKIPPED_NAMES = new Set(['__pycache__', '_backup-before-user-restore']);

function shouldSkip(relativePath) {
  const parts = relativePath.split(/[\\/]/u);
  const name = parts.at(-1) ?? '';
  if (parts.some((part) => SKIPPED_NAMES.has(part))) return true;
  if (/^selftest-.*\.(?:cjs|js|mjs)$/iu.test(name)) return true;
  return /(?:\.orig(?:-user)?|\.pyc|\.log)$/iu.test(relativePath);
}

async function copyFiltered(source, target, root = source) {
  const info = await stat(source);
  const path = relative(root, source);
  if (path !== '' && shouldSkip(path)) return;
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyFiltered(join(source, entry.name), join(target, entry.name), root);
    }
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function buildPackage(options = {}) {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version = String(packageJson.version ?? '0.0.0');
  const outputDir = resolve(options.outputDir ?? join(ROOT, 'release'));
  const workDir = await mkdtemp(join(tmpdir(), 'sdd-package-'));
  const stageRoot = join(workDir, PACKAGE_FOLDER);
  const zipName = `${packageJson.name}-v${version}.zip`;
  const zipPath = join(outputDir, zipName);
  const hashPath = `${zipPath}.sha256`;

  try {
    await mkdir(stageRoot, { recursive: true });
    for (const file of TOP_LEVEL_FILES) {
      await copyFile(join(ROOT, file), join(stageRoot, file));
    }
    for (const directory of TOP_LEVEL_DIRECTORIES) {
      await copyFiltered(join(ROOT, directory), join(stageRoot, directory));
    }

    const packageInfo = {
      name: packageJson.name,
      version,
      builtAt: new Date().toISOString(),
      entry: 'index.js',
      client: 'client.js',
      preset: 'preset-short-drama',
      desktop: true,
      hostPeers: Object.keys(packageJson.peerDependencies ?? {}),
      runtimeDependencies: ['vendor/adm-zip'],
    };
    await writeFile(join(stageRoot, 'PACKAGE-INFO.json'), `${JSON.stringify(packageInfo, null, 2)}\n`, 'utf8');

    await mkdir(outputDir, { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFolder(stageRoot, PACKAGE_FOLDER);
    zip.writeZip(zipPath);
    const bytes = await readFile(zipPath);
    const digest = sha256(bytes);
    await writeFile(hashPath, `${digest}  ${zipName}\n`, 'utf8');

    return {
      zipPath,
      hashPath,
      sha256: digest,
      bytes: bytes.length,
      version,
      entries: zip.getEntries().map((entry) => entry.entryName),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildPackage();
  console.log(`PASS package ${basename(output.zipPath)} (${output.bytes} bytes)`);
  console.log(`PASS sha256 ${output.sha256}`);
  console.log(output.zipPath);
}
