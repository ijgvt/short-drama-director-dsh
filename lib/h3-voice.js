/**
 * H3 voice-reference helpers.
 *
 * H3 treats an uploaded `<Audio N>` as a numbered input, not as an instruction by itself. The
 * official Ref2VA guide requires the definition, the spoken shot, and `retention_analysis` to agree
 * on both the visible subject and the global speaker ID. These helpers repair that relationship
 * before a prompt is saved; they are deliberately not called by `generate-h3`, which must submit the
 * authored text byte-for-byte.
 */

const H3_FIELDS = Object.freeze([
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
]);

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function sectionBounds(source, field) {
  const headers = [...source.matchAll(new RegExp(`^(${H3_FIELDS.map(escapeRegExp).join('|')})[ \\t]*:[ \\t]*$`, 'gmu'))];
  const index = headers.findIndex((match) => match[1] === field);
  if (index < 0) return null;
  const header = headers[index];
  let start = header.index + header[0].length;
  if (source[start] === '\r') start += 1;
  if (source[start] === '\n') start += 1;
  return { start, end: headers[index + 1]?.index ?? source.length };
}

function readSection(source, field) {
  const bounds = sectionBounds(source, field);
  return bounds === null ? null : source.slice(bounds.start, bounds.end);
}

function writeSection(source, field, body) {
  const bounds = sectionBounds(source, field);
  if (bounds === null) return source;
  const before = source.slice(0, bounds.start).replace(/[ \t]*\n?$/u, '\n');
  const after = source.slice(bounds.end).replace(/^\s*/u, '');
  return `${before}${String(body).trim()}\n\n${after}`;
}

function subjectNames(source) {
  const body = readSection(source, 'subject_definitions');
  const names = new Map();
  if (body === null) return names;
  for (const line of body.split(/\r?\n/u)) {
    const match = /^<Subject\s+(\d+)>\s*(?:是|is)\s+(.+)$/u.exec(line.trim());
    if (match === null) continue;
    const subject = Number(match[1]);
    const rest = match[2];
    const name = /中的\s*([^，,。\n]+)/u.exec(rest)?.[1]
      ?? /^(.+?)\s+(?:from|in)\s+<Picture\s+\d+>/iu.exec(rest)?.[1]
      ?? null;
    if (name !== null && name.trim().length > 0) names.set(subject, name.trim());
  }
  return names;
}

function expandSpeakerIds(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^S\d+$/u.test(entry));
}

/**
 * Speakers actually vocalising in the target prompt, in first-event order.
 *
 * The compiler writes `<Subject N> (Sx)` immediately before the delivery clause. Older hand-written
 * H3 may use the bare subject name instead, so that form is accepted through the subject table too.
 */
export function h3VoiceCandidates(text) {
  const source = String(text ?? '');
  const names = subjectNames(source);
  const detail = readSection(source, 'detailed_description') ?? '';
  const shots = detail.split(/(?=\[Shot\s+\d+\])/u).filter((shot) => shot.includes('<d>'));
  const found = [];
  const seen = new Set();
  const add = (subject, speaker) => {
    if (!Number.isInteger(subject) || !/^S\d+$/u.test(speaker)) return;
    const key = `${subject}:${speaker}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ subject, speaker });
  };
  for (const shot of shots) {
    const beforeDialogue = shot.slice(0, shot.indexOf('<d>'));
    for (const match of beforeDialogue.matchAll(/<Subject\s+(\d+)>\s*\(([^)]*)\)/gu)) {
      for (const speaker of expandSpeakerIds(match[2])) add(Number(match[1]), speaker);
    }
    for (const [subject, name] of names) {
      const pattern = new RegExp(`${escapeRegExp(name)}\\s*\\(([^)]*)\\)`, 'gu');
      for (const match of beforeDialogue.matchAll(pattern)) {
        for (const speaker of expandSpeakerIds(match[1])) add(subject, speaker);
      }
    }
  }
  return found;
}

function currentAudioTargets(source) {
  const definitions = readSection(source, 'subject_definitions') ?? '';
  const names = subjectNames(source);
  const targets = [];
  for (const line of definitions.split(/\r?\n/u)) {
    const label = /^\s*(<Audio\s+\d+>)/u.exec(line)?.[1] ?? null;
    if (label === null) continue;
    const subjectMatch = /(?:是|for)\s*<Subject\s+(\d+)>/iu.exec(line);
    if (subjectMatch === null) continue;
    const currentSubject = Number(subjectMatch[1]);
    const speaker = /\((S\d+)\)/u.exec(line)?.[1] ?? null;
    targets.push({
      label,
      currentSubject,
      name: names.get(currentSubject) ?? null,
      speaker,
    });
  }
  return targets;
}

function insertVoiceIntoDialogue(source, { audioLabel, subject, speaker }) {
  const detail = readSection(source, 'detailed_description');
  if (detail === null) return source;
  const subjectLabel = `<Subject ${subject}>`;
  const speakerId = speaker;
  const speakerPair = new RegExp(`${escapeRegExp(subjectLabel)}\\s*\\(${escapeRegExp(speakerId)}\\)`, 'u');
  const rewritten = detail.split(/(?=\[Shot\s+\d+\])/u).map((shot) => {
    if (!shot.includes('<d>') || !shot.includes(subjectLabel)) return shot;
    const dialogueAt = shot.indexOf('<d>');
    const before = shot.slice(0, dialogueAt);
    if (before.includes(audioLabel) || /沿用\s*<Audio\s+\d+>\s*的音色/u.test(before)) return shot;
    if (!speakerPair.test(before)) return shot;
    const voiced = before.replace(speakerPair, (match) => `${match} 沿用 ${audioLabel} 的音色，`);
    return `${voiced}${shot.slice(dialogueAt)}`;
  }).join('');
  return writeSection(source, 'detailed_description', rewritten);
}

function upsertDefinitionLine(source, label, line) {
  let body = readSection(source, 'subject_definitions');
  if (body === null) return source;
  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*.*$`, 'mu');
  body = pattern.test(body) ? body.replace(pattern, line) : `${body.trimEnd()}\n${line}`;
  return writeSection(source, 'subject_definitions', body);
}

function upsertAudioRetention(source, label, subject) {
  let body = readSection(source, 'retention_analysis');
  if (body === null) return source;
  const line = `${label}: reference - 其音色用于 <Subject ${subject}> 的台词演绎，不复制原音频信号。`;
  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:.*$`, 'mu');
  body = pattern.test(body) ? body.replace(pattern, line) : `${body.trimEnd()}\n${line}`;
  return writeSection(source, 'retention_analysis', body);
}

/**
 * Make one audio slot an explicit voice clone for a subject.
 *
 * This changes the authored prompt, so callers must run it during conversion/synchronisation or
 * another explicit edit action. Generation itself never invokes it.
 */
export function bindH3VoiceReference(text, { audioLabel, subject, speaker }) {
  if (!/^<Audio\s+\d+>$/u.test(String(audioLabel ?? ''))) return String(text ?? '');
  if (!Number.isInteger(subject) || subject < 1) return String(text ?? '');
  if (!/^S\d+$/u.test(String(speaker ?? ''))) return String(text ?? '');
  let source = String(text ?? '');
  const subjectLabel = `<Subject ${subject}>`;
  const definition = `${audioLabel} 是 ${subjectLabel} (${speaker}) 的音色参考，其中包含人声层；仅复刻声音音色与表达，不复制原句内容。`;
  source = upsertDefinitionLine(source, audioLabel, definition);
  source = upsertAudioRetention(source, audioLabel, subject);
  return insertVoiceIntoDialogue(source, { audioLabel, subject, speaker });
}

function extractMediaDefinitions(source) {
  const definitions = readSection(source, 'subject_definitions') ?? '';
  return definitions.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^<(?:Audio|Video)\s+\d+>/u.test(line));
}

/**
 * Keep media slots that live only in the H3 document when its video-prompt source is re-synced.
 *
 * Reference audio/video are uploaded from the H3 asset column and have no row in the video prompt's
 * `@` mapping. Recompiling the source text therefore used to drop them. The current H3 document is
 * the authority for these external slots; subject/picture numbering still comes from the fresh
 * compile.
 */
export function preserveH3MediaReferences(compiledText, currentText) {
  let source = String(compiledText ?? '');
  const current = String(currentText ?? '');
  const definitions = readSection(source, 'subject_definitions');
  if (definitions === null) return source;
  for (const line of extractMediaDefinitions(current)) {
    const label = /^<(?:Audio|Video)\s+\d+>/u.exec(line)?.[0];
    if (label === undefined) continue;
    if (new RegExp(`^${escapeRegExp(label)}`, 'mu').test(definitions)) continue;
    source = upsertDefinitionLine(source, label, line);
  }

  const compiledNames = subjectNames(source);
  const candidates = h3VoiceCandidates(source);
  for (const target of currentAudioTargets(current)) {
    let subject = target.currentSubject;
    if (target.name !== null) {
      const named = [...compiledNames].find(([, name]) => name === target.name);
      if (named !== undefined) subject = named[0];
    }
    const candidate = target.speaker === null
      ? candidates.find((entry) => entry.subject === subject)
      : { subject, speaker: target.speaker };
    if (candidate === undefined) continue;
    source = bindH3VoiceReference(source, {
      audioLabel: target.label,
      subject: candidate.subject,
      speaker: candidate.speaker,
    });
  }
  return source;
}


