/**
 * Shared display/identity normalization for inventory metadata and disk scans.
 *
 * Markdown headings and summary tables routinely number rows (`### 1. 雷劫代练木牌`,
 * `1. 手机`). A disk folder usually does not. Treating those as different names creates a
 * picture-less duplicate of a real asset. Both sides therefore pass through this one function.
 *
 * Only a leading ordinal followed by a list delimiter is removed. A legitimate name such as
 * `1984` is left alone.
 */
export function cleanAssetLabel(value) {
  return String(value ?? '')
    .replace(/\*\*/gu, '')
    .replace(/^\s*[-*]\s*/u, '')
    .replace(/^\s*\d{1,4}\s*[.、．]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
