/**
 * Read 资产盘点稿 into metadata-only assets.
 *
 * The inventory is a Markdown document, not a database. It is deliberately parsed
 * conservatively: names, episode numbers and the prose fields the inventory prompt
 * requires are enough to populate the asset panel before any image exists. Files and
 * variants found on disk remain authoritative; this module only supplies the initial
 * names, descriptions and costume variants that a production starts from.
 *
 * @module dsh-plugin-short-drama-director/lib/asset-inventory
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanAssetLabel } from './asset-name.js';

const KIND_ORDER = ['character', 'scene', 'prop', 'reference-audio'];
const ASSET_NAME_HEADERS = Object.freeze(['资产名', '角色资产名', '场景资产名', '道具资产名']);
const PLACEHOLDER_ASSET_NAMES = new Set([
  '---',
  '资产名',
  '变体资产名',
  '角色资产名',
  '场景资产名',
  '道具资产名',
  '群体资产',
]);

function normalize(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n');
}

function sectionOf(text, pattern) {
  const lines = normalize(text).split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##(?!#)\s/u.test(lines[index]) && pattern.test(lines[index])) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##(?!#)\s/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function assetBlocks(section) {
  const matches = [...section.matchAll(/^###\s+(.+)$/gmu)];
  return matches.map((match, index) => ({
    title: match[1].trim(),
    text: section.slice(match.index + match[0].length, matches[index + 1]?.index ?? section.length),
  }));
}

/** Key/value bullets, with Markdown bold markers removed from the label. */
function fieldRows(block) {
  return normalize(block)
    .split('\n')
    .map((line) => {
      const match = /^\s*[-*]\s*(.+?)\s*[：:]\s*(.*)$/u.exec(line);
      if (match === null) return null;
      const label = match[1].replace(/\*\*/gu, '').trim();
      const value = match[2].trim();
      return label.length === 0 ? null : { label, value };
    })
    .filter(Boolean);
}

function field(block, labels) {
  const wanted = Array.isArray(labels) ? labels : [labels];
  return fieldRows(block).find((row) => wanted.some((label) => row.label.includes(label)))?.value ?? null;
}

function episodeNumbers(value) {
  const text = String(value ?? '');
  const explicit = [...text.matchAll(/第\s*(\d+)\s*集/gu)].map((match) => Number(match[1]));
  if (explicit.length > 0) return [...new Set(explicit)];
  const numbers = [];
  for (const part of text.split(/[、,，;；\s]+/u)) {
    const range = /^(\d+)\s*[-~至]\s*(\d+)$/u.exec(part);
    if (range !== null) {
      for (let value = Number(range[1]); value <= Number(range[2]); value += 1) numbers.push(value);
      continue;
    }
    const number = Number.parseInt(part, 10);
    if (Number.isInteger(number)) numbers.push(number);
  }
  return [...new Set(numbers)];
}

function joinParts(parts) {
  const seen = new Set();
  return parts
    .map((part) => String(part ?? '').trim().replace(/[；;。]\s*$/u, ''))
    .filter((part) => {
      if (part.length === 0 || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join('；');
}

function parseFolderName(value) {
  const text = cleanAssetLabel(value);
  const match = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/u.exec(text);
  return match === null
    ? { name: text, qualifier: null }
    : { name: cleanAssetLabel(match[1]), qualifier: cleanAssetLabel(match[2]) };
}

function characterVariants(block, baseName) {
  const parts = normalize(block).split(/(?=^\s*[-*]\s*(?:\*\*)?变体资产名(?:\*\*)?\s*[：:])/gmu).slice(1);
  const variants = [];
  for (const part of parts) {
    const rawName = cleanAssetLabel(field(part, ['变体资产名']));
    if (rawName === null || rawName.length === 0) continue;
    const parsed = parseFolderName(rawName);
    const name = parsed.qualifier ?? (parsed.name === baseName ? rawName : parsed.name);
    if (name.length === 0 || name === baseName) continue;
    const description = joinParts([
      field(part, ['变体类型']) === null ? null : `类型：${field(part, ['变体类型'])}`,
      field(part, ['变化说明']),
      field(part, ['服装/状态外观描述', '外观描述']),
    ]);
    variants.push({
      name,
      description,
      episodeNumbers: episodeNumbers(field(part, ['出现集数'])),
    });
  }

  // The professional inventory format uses a Markdown table:
  // | 变体资产名 | 变体类型 | 变化说明 | 出现集数 | 服装/状态外观描述 | 依赖 |
  // That table describes variants OF the current character. It is not a list of new assets.
  for (const table of tablesOf(block)) {
    if (!table.header.includes('变体资产名')) continue;
    for (const row of table.rows) {
      const rawName = cleanAssetLabel(row['变体资产名']);
      if (rawName.length === 0) continue;
      const parsed = parseFolderName(rawName);
      const name = parsed.qualifier ?? (parsed.name === baseName ? '' : parsed.name);
      if (name.length === 0 || name === baseName) continue;
      variants.push({
        name,
        description: joinParts([
          row['变体类型'] === undefined ? null : `类型：${row['变体类型']}`,
          row['变化说明'],
          row['服装/状态外观描述'],
          row['依赖'],
        ]),
        episodeNumbers: episodeNumbers(row['出现集数']),
      });
    }
  }

  // Some older inventories describe the table in prose instead of real pipe rows.
  if (variants.length === 0) {
    const table = field(block, ['形态变体表']);
    if (table !== null && !/无变体|无/u.test(table)) {
      for (const match of table.matchAll(/[（(]\s*([^）)]+?)\s*[）)]/gu)) {
        const name = cleanAssetLabel(match[1]);
        if (name.length > 0) variants.push({ name, description: '', episodeNumbers: [] });
      }
    }
  }
  const byName = new Map();
  for (const variant of variants) {
    const before = byName.get(variant.name);
    byName.set(variant.name, {
      name: variant.name,
      description: joinParts([before?.description, variant.description]),
      episodeNumbers: [...new Set([...(before?.episodeNumbers ?? []), ...variant.episodeNumbers])],
    });
  }
  return [...byName.values()];
}

function descriptionFor(kind, block, fallbackName) {
  if (kind === 'character') {
    return joinParts([
      field(block, ['姓名']),
      field(block, ['基础形象描述']),
      field(block, ['性格关键词']) === null ? null : field(block, ['性格关键词']),
    ]) || fallbackName;
  }
  if (kind === 'scene') {
    return joinParts([
      field(block, ['场景名称']),
      field(block, ['内景/外景', '日/夜']),
      field(block, ['空间结构']),
      field(block, ['固定元素']),
      field(block, ['光源与氛围']),
    ]) || fallbackName;
  }
  return joinParts([
    field(block, ['道具名称']),
    field(block, ['外观、材质', '外观']),
    field(block, ['使用方式']),
    field(block, ['需要状态']),
    field(block, ['是否带文字']),
  ]) || fallbackName;
}

function splitNames(value) {
  const text = String(value ?? '');
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of text) {
    if (char === '（' || char === '(') depth += 1;
    else if (char === '）' || char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[、,，;；]/u.test(char)) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts
    .map((entry) => cleanAssetLabel(entry.replace(/^复用\s*/u, '')))
    .filter((entry) => entry.length > 0 && !/^(?:无|暂无|—|-)$/u.test(entry));
}

function summaryRows(section) {
  const summaries = [];
  for (const table of tablesOf(section)) {
    const column = (...labels) => table.header.findIndex((cell) => labels.some((label) => cell.includes(label)));
    const columns = {
      episode: column('集号', '集数', '集'),
      character: column('出场人物', '人物'),
      variant: column('人物形态变体', '形态变体', '状态变体'),
      scene: column('使用场景', '场景'),
      prop: column('关键道具', '道具'),
      note: column('资产备注', '备注'),
    };
    if (columns.character < 0 || columns.prop < 0) continue;
    for (const row of table.rows) {
      const cells = table.header.map((name) => row[name] ?? '');
      summaries.push({
        episodeNumbers: episodeNumbers(cells[columns.episode] ?? cells[0]),
        characters: splitNames(cells[columns.character]),
        variants: columns.variant < 0 ? [] : splitNames(cells[columns.variant]),
        scenes: splitNames(cells[columns.scene]),
        props: splitNames(cells[columns.prop]),
        note: cells[columns.note] ?? '',
      });
    }
  }
  return summaries;
}

function addVariant(asset, variant) {
  if (variant === null || typeof variant !== 'object') return;
  const name = cleanAssetLabel(variant.name);
  if (name.length === 0) return;
  const existing = asset.variants.find((entry) => entry.name === name);
  if (existing === undefined) {
    asset.variants.push({
      name,
      description: String(variant.description ?? ''),
      episodeNumbers: [...new Set(variant.episodeNumbers ?? [])],
    });
    return;
  }
  existing.description = joinParts([existing.description, variant.description]);
  existing.episodeNumbers = [...new Set([...(existing.episodeNumbers ?? []), ...(variant.episodeNumbers ?? [])])];
}

function addAsset(map, kind, name, patch = {}) {
  const clean = cleanAssetLabel(name);
  if (clean.length === 0 || PLACEHOLDER_ASSET_NAMES.has(clean)) return null;
  const key = `${kind}:${clean}`;
  let asset = map.get(key);
  if (asset === undefined) {
    asset = {
      kind,
      name: clean,
      description: '',
      episodeNumbers: [],
      variants: [],
    };
    map.set(key, asset);
  }
  if (typeof patch.description === 'string' && patch.description.trim().length > 0) {
    asset.description = joinParts([asset.description, patch.description]);
  }
  if (typeof patch.defaultDescription === 'string' && patch.defaultDescription.trim().length > 0) {
    asset.defaultDescription = patch.defaultDescription.trim();
  }
  asset.episodeNumbers = [...new Set([...(asset.episodeNumbers ?? []), ...(patch.episodeNumbers ?? [])])];
  for (const variant of patch.variants ?? []) addVariant(asset, variant);
  return asset;
}

/**
 * Read every CONTIGUOUS Markdown table in a section.
 *
 * A character section can contain both its 形态变体表 and, later in the section, a
 * 群体资产 table. Reading only the first table made the variant rows look like top-level
 * assets; concatenating all pipe rows into one table corrupts both schemas.
 */
function tablesOf(text) {
  const tables = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2) {
      const header = current[0];
      const start = current[1].every((cell) => /^:?-{2,}:?$/u.test(cell)) ? 2 : 1;
      tables.push({
        header,
        rows: current.slice(start).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']))),
      });
    }
    current = [];
  };
  for (const raw of normalize(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      current.push(line.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\*\*/gu, '')));
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

function rowValue(row, labels) {
  const key = Object.keys(row).find((name) => labels.some((label) => name.includes(label)));
  return key === undefined ? '' : row[key];
}

function rowValueExact(row, labels) {
  const key = Object.keys(row).find((name) => labels.includes(name));
  return key === undefined ? '' : row[key];
}

function hasStructuredAssetTable(text) {
  return tablesOf(text).some((table) => table.header.some((name) => ASSET_NAME_HEADERS.includes(name)));
}

function variantsFromCell(value, baseName) {
  const text = cleanAssetLabel(value);
  if (text.length === 0 || /^无/u.test(text)) return [];
  const variants = [];
  for (const raw of splitNames(text)) {
    if (/^无|无变体|同一套/u.test(raw)) continue;
    const parsed = parseFolderName(raw);
    if (parsed.qualifier !== null) {
      if (!/不做资产|不单列|附属物|群演/u.test(parsed.qualifier)) {
        variants.push({ name: parsed.qualifier, description: '', episodeNumbers: [] });
      }
    } else if (raw !== baseName) {
      variants.push({ name: raw, description: '', episodeNumbers: [] });
    }
  }
  return variants;
}

function summaryVariantOf(raw) {
  const text = cleanAssetLabel(raw);
  if (text.length === 0) return null;
  const arrowTail = text.split('→').at(-1)?.trim() ?? text;
  const parsed = parseFolderName(arrowTail);
  if (parsed.qualifier === null || parsed.name.length === 0) return null;
  return { baseName: parsed.name, variantName: parsed.qualifier };
}

function summaryNameIsNonAsset(raw, note) {
  const text = cleanAssetLabel(raw);
  if (text.length === 0) return true;
  const parsed = parseFolderName(text);
  if (/声音|虚影|旁白|影子/u.test(parsed.qualifier ?? '')) return true;
  const mentions = note.includes(text) || note.includes(parsed.name);
  return mentions && /不做资产|群演|群体资产|只出群像|仅声音|无画面|仅以.*虚影|不用实体|不单列/u.test(note);
}

/**
 * Newer inventories describe assets as tables instead of `### 名称` blocks.
 * Both shapes are accepted; the table rows are the same identities and prose.
 */
function tableAssets(map, kind, sectionText) {
  for (const table of tablesOf(sectionText)) {
    // EXACT header identity is the guard. `变体资产名`.includes(`资产名`) was true, which
    // turned every costume/state row into a separate top-level asset.
    if (!table.header.some((name) => ASSET_NAME_HEADERS.includes(name))) continue;
    for (const row of table.rows) {
      const name = cleanAssetLabel(rowValueExact(row, ASSET_NAME_HEADERS));
      if (name.length === 0) continue;
      const episodes = episodeNumbers(rowValue(row, ['集', '集号', '集数']));
      if (kind === 'character') {
        const identity = rowValue(row, ['身份']);
        const age = rowValue(row, ['年龄']);
        const appearance = rowValue(row, ['外形', '外形要点']);
        const clothing = rowValue(row, ['服装']);
        const variantCell = rowValue(row, ['状态变体', '形态变体']);
        addAsset(map, kind, name, {
          description: joinParts([
            identity,
            age,
            appearance,
            clothing,
            /^无/u.test(variantCell) ? null : variantCell,
          ]),
          defaultDescription: clothing,
          episodeNumbers: episodes,
          variants: variantsFromCell(variantCell, name),
        });
      } else if (kind === 'scene') {
        addAsset(map, kind, name, {
          description: joinParts([
            rowValue(row, ['时段']),
            rowValue(row, ['内外', '内景/外景']),
            rowValue(row, ['空间要点', '空间结构']),
          ]),
          episodeNumbers: episodes,
        });
      } else {
        addAsset(map, kind, name, {
          description: joinParts([
            rowValue(row, ['形态']),
            rowValue(row, ['关键细节', '外观、材质']),
            rowValue(row, ['画幅建议']),
          ]),
          episodeNumbers: episodes,
        });
      }
    }
  }
}

function isNonAssetBlock(title, blockText) {
  const heading = cleanAssetLabel(title);
  const body = String(blockText ?? '');
  return /不进入资产生图|仅供后期配音|不做资产|不生成任何.{0,12}资产|非资产生成项/u.test(`${heading}\n${body}`)
    || (/^(?:声音|语气|音色|旁白说明|群演说明|字段说明|解析说明)/u.test(heading)
      && /声音|配音|无形象|无实体|说明/u.test(body));
}

/**
 * The episode summary is a cast/use plan, not an asset declaration.
 *
 * It may enrich an asset that already has a detailed block or a structured asset table, but a
 * name mentioned only in the plan must not mint a picture-less card. This is the rule that
 * removes empty 保安 / 手机 / 主持人 entries while keeping their episode usage on real assets.
 */
function enrichExistingAsset(map, kind, rawName, patch = {}) {
  const exact = cleanAssetLabel(rawName);
  if (exact.length === 0) return null;
  if (map.has(`${kind}:${exact}`)) return addAsset(map, kind, exact, patch);
  const parsed = parseFolderName(exact);
  if (parsed.qualifier === null || !map.has(`${kind}:${parsed.name}`)) return null;
  const variants = patch.variants ?? [];
  if (!/不做资产|不单列|附属物|群演|虚影|声音/u.test(parsed.qualifier)) {
    variants.push({ name: parsed.qualifier, description: '', episodeNumbers: patch.episodeNumbers ?? [] });
  }
  return addAsset(map, kind, parsed.name, { ...patch, variants });
}

/** Parse one or more inventory documents into metadata-only asset records. */
export function parseAssetInventory(text) {
  const source = normalize(text);
  const map = new Map();
  const sections = [
    { kind: 'character', text: sectionOf(source, /输出\s*2|人物资产盘点|角色资产盘点/u) },
    { kind: 'scene', text: sectionOf(source, /输出\s*3|场景资产盘点/u) },
    { kind: 'prop', text: sectionOf(source, /输出\s*4|道具资产盘点/u) },
  ];
  for (const section of sections) {
    for (const block of assetBlocks(section.text)) {
      const blockText = block.text;
      const declaredName = field(blockText, ['角色资产名', '场景资产名', '道具资产名']);
      // A section such as `### 群像资产（群演合并处理，不做特写与四视图）` is a table
      // container, not an asset. Without this guard the heading became a seventh asset and
      // appeared as a completely empty card beside the six real rows in its table.
      if (declaredName === null && hasStructuredAssetTable(blockText)) continue;
      if (declaredName === null && isNonAssetBlock(block.title, blockText)) continue;
      const name = cleanAssetLabel(declaredName) || cleanAssetLabel(block.title);
      if (name.length === 0) continue;
      const patch = {
        description: descriptionFor(section.kind, blockText, name),
        defaultDescription: section.kind === 'character' ? field(blockText, ['服装/状态外观描述']) : null,
        episodeNumbers: episodeNumbers(field(blockText, ['出现集数'])),
        variants: section.kind === 'character' ? characterVariants(blockText, name) : [],
      };
      addAsset(map, section.kind, name, patch);
    }
    tableAssets(map, section.kind, section.text);
  }

  // The summary table only enriches structured declarations above. A passing mention is not
  // an asset declaration; creating one here is what produced empty cards with no prose, variant
  // or file and made mentions bind to the wrong duplicate.
  for (const row of summaryRows(sectionOf(source, /输出\s*1|分集资产需求总表/u))) {
    for (const raw of row.characters) {
      if (summaryNameIsNonAsset(raw, row.note)) continue;
      enrichExistingAsset(map, 'character', raw, { episodeNumbers: row.episodeNumbers });
    }
    for (const raw of row.variants) {
      const variant = summaryVariantOf(raw);
      if (variant === null) continue;
      enrichExistingAsset(map, 'character', variant.baseName, {
        episodeNumbers: row.episodeNumbers,
        variants: [{ name: variant.variantName, description: '', episodeNumbers: row.episodeNumbers }],
      });
    }
    for (const raw of row.scenes) {
      const parsed = parseFolderName(raw);
      if (/不单列|附属物|群演/u.test(parsed.qualifier ?? '')) continue;
      enrichExistingAsset(map, 'scene', raw, { episodeNumbers: row.episodeNumbers });
    }
    for (const raw of row.props) {
      const parsed = parseFolderName(raw);
      if (/不单列|附属物|群演/u.test(parsed.qualifier ?? '')) continue;
      enrichExistingAsset(map, 'prop', raw, { episodeNumbers: row.episodeNumbers });
    }
  }

  return [...map.values()]
    .map((asset) => ({
      ...asset,
      variants: [...asset.variants].sort((left, right) => left.name.localeCompare(right.name)),
      episodeNumbers: [...asset.episodeNumbers].sort((left, right) => left - right),
    }))
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
      || left.name.localeCompare(right.name));
}

/**
 * The inventory directory is also where creators keep 《资产提示词》 and notes.
 * Parsing every Markdown file there produced assets literally named `---`,
 * `变体资产名` and numbered prose fragments. Only a document that contains the
 * inventory's own section structure may contribute metadata.
 */
export function looksLikeAssetInventory(text) {
  const source = normalize(text);
  const sectionHeadings = [...source.matchAll(/^##(?!#)\s*(.+)$/gmu)]
    .map((match) => match[1].trim());
  const recognised = sectionHeadings.filter((heading) =>
    /输出\s*[1-4]|分集资产需求总表|人物资产盘点|场景资产盘点|道具资产盘点/u.test(heading));
  return recognised.length >= 2
    || (/资产盘点稿/u.test(source) && recognised.length >= 1);
}

/** Locate and read every inventory document in one project. */
export async function readAssetInventory(root) {
  const directory = join(root, '资产', '资产盘点稿');
  const files = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:md|markdown|txt)$/iu.test(entry.name)) files.push(join(directory, entry.name));
    }
  } catch {
    // A project without an inventory directory is a valid project with no initial assets.
  }
  for (const loose of [join(root, '资产', '资产盘点稿.md'), join(root, '资产盘点稿.md')]) {
    try {
      if ((await stat(loose)).isFile()) files.push(loose);
    } catch {
      // optional
    }
  }
  const sources = [...new Set(files)].sort();
  if (sources.length === 0) return { assets: [], sources: [], problems: [] };
  const documents = await Promise.all(sources.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8').catch(() => ''),
  })));
  const inventoryDocuments = documents.filter((entry) => looksLikeAssetInventory(entry.text));
  return {
    assets: parseAssetInventory(inventoryDocuments.map((entry) => entry.text).join('\n\n')),
    sources: inventoryDocuments.map((entry) => entry.file),
    ignoredSources: sources.filter((source) => !inventoryDocuments.some((entry) => entry.file === source)),
    problems: [],
  };
}
