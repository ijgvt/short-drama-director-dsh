/**
 * Is this actually a usable picture?
 *
 * The failure this answers produced the worst kind of report: ComfyUI said
 * `Invalid argument returned 22` (an FFmpeg `EINVAL` from `av.error.ArgumentError`) and pointed at an
 * `LoadImage` node, while the real problem was that the uploaded file was a 1x1 PNG. Nothing in that
 * message names the file, its size, or the fact that it could never have worked, and the person on the
 * other end reads it as "the video workflow is broken".
 *
 * The check runs BEFORE the upload, so a bad file costs no network and no GPU time, and the message can
 * say what is wrong in the terms the user thinks in: which file, how many bytes, how many pixels, and
 * what to do about it.
 *
 * It is deliberately a STRUCTURE check, not a decode: no image library, no memory cost proportional to
 * the picture, and it still catches the two real cases - a file that is not an image at all, and one
 * whose header is intact but whose payload is missing (a truncated copy, an interrupted download).
 *
 * @module dsh-plugin-short-drama-director/lib/image-guard
 */

/**
 * Smallest side a reference picture may have.
 *
 * A four-view, a costume reference or an identity sheet is compared against a 1080x1920 portrait; at
 * 64 px a side there is nothing left to compare. 1x1 placeholders and icons land here, which is the
 * point: those are the files that reach `LoadImage` and fail inside FFmpeg.
 */
export const MIN_IMAGE_SIDE = 64;

/** Big-endian helpers over a Buffer, tolerant of short reads. */
const u16 = (bytes, at) => (at + 2 <= bytes.length ? bytes.readUInt16BE(at) : 0);
const u32 = (bytes, at) => (at + 4 <= bytes.length ? bytes.readUInt32BE(at) : 0);
const ascii = (bytes, from, to) => (to <= bytes.length ? bytes.toString('latin1', from, to) : '');

/** PNG: IHDR dimensions plus the IDAT payload and the IEND terminator. */
function parsePng(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  // Bounded by the buffer: at most one chunk per 12 bytes.
  for (let guard = 0; guard < 4096 && offset + 8 <= bytes.length; guard += 1) {
    const length = u32(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = u32(bytes, offset + 8);
      height = u32(bytes, offset + 12);
      sawHeader = true;
    } else if (type === 'IDAT') {
      sawData = true;
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    if (length > bytes.length) break;
    offset += 12 + length;
  }
  return {
    format: 'png',
    width,
    height,
    // A PNG missing IDAT or IEND is a file that was cut short, and ComfyUI reports it as a decoder
    // crash rather than as a truncated file.
    complete: sawHeader && sawData && sawEnd && width > 0 && height > 0,
    missing: [
      sawHeader ? '' : 'IHDR',
      sawData ? '' : 'IDAT',
      sawEnd ? '' : 'IEND',
    ].filter((part) => part.length > 0),
  };
}

/** JPEG: SOF dimensions plus the end-of-image marker. */
function parseJpeg(bytes) {
  let offset = 2;
  let width = 0;
  let height = 0;
  for (let guard = 0; guard < 8192 && offset + 4 <= bytes.length; guard += 1) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    const length = u16(bytes, offset + 2);
    if (length < 2) break;
    // Sof0..Sof15 carry the frame size; C4/C8/CC are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = u16(bytes, offset + 5);
      width = u16(bytes, offset + 7);
    }
    offset += 2 + length;
  }
  const ends = bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return {
    format: 'jpeg',
    width,
    height,
    complete: ends && width > 0 && height > 0,
    missing: [ends ? '' : 'EOI', width > 0 ? '' : 'SOF'].filter((part) => part.length > 0),
  };
}

/** WebP: RIFF container whose declared size must match the bytes present. */
function parseWebp(bytes) {
  // RIFF sizes are LITTLE-endian (the format's own convention, unlike PNG/JPEG above).
  const declared = (bytes.length >= 8 ? bytes.readUInt32LE(4) : 0) + 8;
  let width = 0;
  let height = 0;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
  } else if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    width = u16(bytes, 26) & 0x3fff;
    height = u16(bytes, 28) & 0x3fff;
  }
  const whole = declared <= bytes.length;
  return {
    format: 'webp',
    width,
    height,
    complete: whole && (width === 0 || height === 0 ? true : width > 0 && height > 0),
    missing: [whole ? '' : 'payload'].filter((part) => part.length > 0),
  };
}

/** GIF / BMP: dimensions are in the fixed header, and GIF needs its trailer byte. */
function parseGif(bytes) {
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  const ends = bytes[bytes.length - 1] === 0x3b;
  return { format: 'gif', width, height, complete: ends && width > 0 && height > 0, missing: [ends ? '' : 'trailer'] };
}

function parseBmp(bytes) {
  const width = Math.abs(bytes.length >= 26 ? bytes.readInt32LE(18) : 0);
  const height = Math.abs(bytes.length >= 26 ? bytes.readInt32LE(22) : 0);
  return { format: 'bmp', width, height, complete: width > 0 && height > 0, missing: [] };
}

/**
 * Identify one image buffer.
 *
 * @param bytes - the file's bytes (a Buffer).
 * @returns `{ ok, format, width, height, reason }`; `ok` is true only for a COMPLETE picture whose
 *   both sides are at least {@link MIN_IMAGE_SIDE}.
 */
export function inspectImageBytes(bytes) {
  if (bytes === undefined || bytes === null || typeof bytes.length !== 'number' || bytes.length === 0) {
    return { ok: false, format: null, width: 0, height: 0, reason: '文件是空的（0 字节），没有任何图像内容' };
  }
  let parsed = null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') parsed = parsePng(bytes);
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) parsed = parseJpeg(bytes);
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') parsed = parseWebp(bytes);
  else if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) parsed = parseGif(bytes);
  else if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM') parsed = parseBmp(bytes);

  const kb = Math.max(1, Math.round(bytes.length / 1024));
  if (parsed === null) {
    const head = ascii(bytes, 0, 8).replace(/[^\x20-\x7e]/gu, '·');
    return {
      ok: false,
      format: null,
      width: 0,
      height: 0,
      reason: `不是可识别的图片（PNG/JPEG/WebP/GIF/BMP 都不是；前 8 个字节 ${JSON.stringify(head)}，${String(bytes.length)} 字节）`,
    };
  }
  if (parsed.complete !== true) {
    const missing = (parsed.missing ?? []).join('/') || 'payload';
    return {
      ok: false,
      format: parsed.format,
      width: parsed.width ?? 0,
      height: parsed.height ?? 0,
      reason: `这个 ${parsed.format.toUpperCase()} 不完整（缺 ${missing}，只有 ${String(bytes.length)} 字节）——文件被截断或传输没有完成，请重新导出或复制完整文件后再上传`,
    };
  }
  const width = Number(parsed.width) || 0;
  const height = Number(parsed.height) || 0;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) {
    return {
      ok: false,
      format: parsed.format,
      width,
      height,
      reason: `这张图只有 ${String(width)}×${String(height)} 像素（${String(kb)}KB），小于 ${String(MIN_IMAGE_SIDE)}×${String(MIN_IMAGE_SIDE)}，`
        + '没有可用的画面内容（占位图/图标），送进 LoadImage 只会在 ComfyUI 里报 Invalid argument',
    };
  }
  return { ok: true, format: parsed.format, width, height, reason: '' };
}
