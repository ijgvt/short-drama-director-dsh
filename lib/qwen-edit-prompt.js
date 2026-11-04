/**
 * Qwen-Image-2.1 edit prompt contract.
 *
 * The official edit prompt is one continuous instruction paragraph. Multi-image edits
 * must use numbered <imageN> tags, a single-image edit must not, and wh_ratio /
 * ratio_follow are mutually exclusive. This is the deterministic compatibility formatter:
 * the general image-edit panel now asks the current session model for an authored rewrite,
 * while this module remains available to validation, older callers and asset submission paths.
 */

function replaceNaturalImageReferences(text, imageCount) {
  const quoted = [];
  let next = String(text).replace(/"[^"]*"|“[^”]*”/gu, (match) => {
    const index = quoted.push(match) - 1;
    return `\u0001Q${index}\u0001`;
  });
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const english = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  for (let index = 0; index < Math.min(imageCount, chinese.length); index += 1) {
    const number = index + 1;
    const marker = `<image${number}>`;
    next = next
      .replace(new RegExp(`第\\s*${chinese[index]}\\s*张?图`, 'gu'), marker)
      .replace(new RegExp(`第\\s*${number}\\s*张图`, 'gu'), marker)
      .replace(new RegExp(`(?:图|图片)\\s*${chinese[index]}`, 'gu'), marker)
      .replace(new RegExp(`(?:图|图片)\\s*${number}`, 'gu'), marker);
    if (!next.includes(marker)) {
      next = next
        .replace(new RegExp(`\\bimage\\s*${number}\\b`, 'giu'), marker)
        .replace(new RegExp(`\\bthe\\s+${english[index]}\\s+image\\b`, 'giu'), marker);
    }
  }
  return next.replace(/\u0001Q(\d+)\u0001/gu, (_match, index) => quoted[Number(index)] ?? '');
}

function stripRatioMentions(text, ratio) {
  const ratios = new Set([
    ratio,
    '1:1', '1:2', '2:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '5:7', '7:5',
    '9:16', '16:9', '18:39', '9:20', '21:9', '3:1',
  ].filter((value) => typeof value === 'string' && value.length > 0));
  const quoted = [];
  let next = String(text).replace(/"[^"]*"|“[^”]*”/gu, (match) => {
    const index = quoted.push(match) - 1;
    return `\u0001Q${index}\u0001`;
  });
  for (const value of ratios) {
    const body = value.split(':').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s*:\\s*');
    next = next.replace(new RegExp(`\\b${body}\\b`, 'giu'), '');
  }
  next = next.replace(/\u0001Q(\d+)\u0001/gu, (_match, index) => quoted[Number(index)] ?? '');
  return next
    .replace(/\s{2,}/gu, ' ')
    .replace(/\s+([\u3400-\u9fff])/gu, '$1')
    .replace(/([，,])\s*([，,])/gu, '$1')
    .replace(/。{2,}/gu, '。')
    .trim();
}

function ratioFromInstruction(text) {
  const source = String(text).replace(/"[^"]*"|“[^”]*”/gu, ' ');
  const direct = /(?:^|[^\d])(\d{1,2})\s*[:：]\s*(\d{1,2})(?:[^\d]|$)/u.exec(source);
  if (direct !== null) {
    const ratio = `${Number(direct[1])}:${Number(direct[2])}`;
    if (direct[1] !== '0' && direct[2] !== '0') return ratio;
  }
  if (/正方形|方形|头像|专辑封面|square|avatar/iu.test(source)) return '1:1';
  if (/竖版|竖屏|手机壁纸|短视频封面|portrait|stories|reels/iu.test(source)) return '9:16';
  if (/横版|横屏|宽屏|电脑壁纸|视频封面|landscape|widescreen|ppt/iu.test(source)) return '16:9';
  if (/电影画面|宽银幕|cinematic/iu.test(source)) return '21:9';
  if (/海报|poster/iu.test(source)) return '2:3';
  return '';
}

const CHINESE_PREFIX = '以输入图像为基础进行编辑：';
const CHINESE_MULTI_PREFIX = '以 <image1> 为主画布进行多图编辑：';
const CHINESE_PRESERVATION = '只改变上述明确要求的属性，严格保持参考图中的身份、未指定区域、构图、透视、光照、材质和原有文字不变。';
const ENGLISH_PREFIX = 'Edit the input image:';
const ENGLISH_MULTI_PREFIX = 'Edit the multi-image composition using <image1> as the canvas:';
const ENGLISH_PRESERVATION = 'Change only the explicitly requested attributes; preserve identity, unrelated areas, composition, perspective, lighting, materials, and existing text exactly.';

function stripExistingWrapper(text) {
  let next = String(text).trim();
  for (const prefix of [CHINESE_MULTI_PREFIX, CHINESE_PREFIX, ENGLISH_MULTI_PREFIX, ENGLISH_PREFIX]) {
    if (next.startsWith(prefix)) {
      next = next.slice(prefix.length).trim();
      break;
    }
  }
  for (const suffix of [CHINESE_PRESERVATION, ENGLISH_PRESERVATION]) {
    if (next.endsWith(suffix)) {
      next = next.slice(0, -suffix.length).trim();
      break;
    }
  }
  return next;
}

/**
 * Deterministically convert a free-form edit request into the Qwen-Image-2.1 Edit Prompt shape.
 */
export function normalizeQwenEditPrompt(input, {
  imageCount = 1,
  aspectRatio = '',
} = {}) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) throw new Error('图片编辑提示词不能为空');
  let parsed = null;
  if (raw.startsWith('{')) {
    try {
      const value = JSON.parse(raw);
      if (value !== null && typeof value === 'object' && typeof value.rewritten_prompt === 'string') parsed = value;
    } catch {
      // A normal prose prompt can begin with a brace; only a complete JSON object is special.
    }
  }
  const source = stripExistingWrapper(parsed?.rewritten_prompt ?? raw);
  const count = Math.max(1, Number.isInteger(imageCount) ? imageCount : 1);
  const explicitRatio = typeof aspectRatio === 'string' && aspectRatio.trim().length > 0
    ? aspectRatio.trim()
    : (typeof parsed?.wh_ratio === 'string' && parsed.wh_ratio.trim().length > 0
      ? parsed.wh_ratio.trim()
      : ratioFromInstruction(source));
  const taggedText = stripRatioMentions(replaceNaturalImageReferences(source, count), explicitRatio).replace(/\s+/gu, ' ').trim();
  const looksChinese = /[\u3400-\u9fff]/u.test(taggedText)
    && !/[\u3040-\u30ff\uac00-\ud7af]/u.test(taggedText);
  const withTags = count === 1 ? taggedText.replace(/<image\d+>/giu, looksChinese ? '图像' : 'the image') : taggedText;
  const instructionBody = withTags.replace(/[。.!！?？]\s*$/u, '').trim();
  const isChinese = looksChinese;
  const preservation = isChinese ? CHINESE_PRESERVATION : ENGLISH_PRESERVATION;
  let instruction;
  if (isChinese) {
    instruction = count > 1
      ? `${CHINESE_MULTI_PREFIX}${instructionBody}。${preservation}`
      : `${CHINESE_PREFIX}${instructionBody}。${preservation}`;
  } else {
    instruction = count > 1
      ? `${ENGLISH_MULTI_PREFIX} ${instructionBody}. ${preservation}`
      : `${ENGLISH_PREFIX} ${instructionBody}. ${preservation}`;
  }
  if (count > 1 && !/<image\d+>/iu.test(instruction)) {
    const roles = Array.from({ length: count }, (_, index) => `<image${index + 1}>`).join('、');
    instruction = `${isChinese ? `参考图依次为 ${roles}。` : `The reference images are ${roles}. `}${instruction}`;
  }
  return {
    rewritten_prompt: instruction.replace(/\s+/gu, ' ').trim(),
    wh_ratio: explicitRatio,
    ratio_follow: explicitRatio.length > 0
      ? ''
      : (typeof parsed?.ratio_follow === 'string' && /^<image[1-9]>$/u.test(parsed.ratio_follow.trim())
        ? parsed.ratio_follow.trim()
        : '<image1>'),
    language: isChinese ? 'zh' : 'en',
  };
}
