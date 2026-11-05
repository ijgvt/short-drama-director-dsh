/**
 * 创作台 — the left-docked short-drama workbench.
 *
 * It renders a project picker, an episode picker, a prompt-source switch, and one collapsible
 * card per 大分镜 whose text can be edited and saved back into the file it came from. The same
 * workbench also owns the general-mode generation surface.
 *
 * Data comes from the Host over `/short-drama/panel`, the plugin's own prefix route on the
 * composition's web server, with `/storyboard` (`remote.commands.execute`) as the fallback for a
 * deployment where that route does not exist. The route is not a preference: a command execution
 * appends `command/run` and `command/done` to the session log and the Web client renders that pair
 * as a conversation card, so a panel that talks over the command channel writes into the user's
 * transcript every time it loads, switches a tab or saves. Both channels run the same Host
 * function, and the agent's `storyboard` tool runs it too, so no two of them can disagree.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-short-drama-director',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'storyboardManager';
    /**
 * The session a `main`-slot panel should address, or `undefined`.
 *
 * `mainSessionId` is NOT a method on `uiWorkspace` - it is a module-level helper in the workspace
 * package that computes `Object.values(list.byId).find(s => s.retainedBy.mainView > 0)?.id`. The
 * first version of this probe looked for `uiWorkspace.mainSessionId`, found nothing, and the
 * workbench opened as 「需要在一个会话里打开」. This mirrors the app's own computation, then falls back
 * to the last session seen by the workbench, so reopening it does not lose its data boundary.
 *
 * Everything is probed defensively: these are not our APIs, and a rename must degrade to "no
 * session" (one readable line) rather than throw inside render and take the view down.
 */
let lastKnownSessionId = null;
function readMemoSession() {
  return typeof lastKnownSessionId === 'string' && lastKnownSessionId.length > 0 ? lastKnownSessionId : null;
}
function writeMemoSession(id) {
  if (typeof id !== 'string' || id.length === 0) return;
  lastKnownSessionId = id;
}
function readMainSessionId(ctx) {
  // 1. The session the main view is holding - the app's own definition of "current".
  try {
    const list = ctx?.sessions?.list?.getSnapshot?.();
    const byId = list?.byId ?? {};
    const main = Object.values(byId).find((session) => (session?.retainedBy?.mainView ?? 0) > 0);
    if (typeof main?.id === 'string' && main.id.length > 0) {
      writeMemoSession(main.id);
      return main.id;
    }
  } catch { /* fall through */ }
  try {
    const direct = ctx?.sessions?.currentSessionId;
    const value = typeof direct === 'function' ? direct() : direct;
    if (typeof value === 'string' && value.length > 0) {
      writeMemoSession(value);
      return value;
    }
  } catch { /* fall through */ }
  /**
   * Never guess a session from the global session list. The chosen id controls the caller's
   * sandbox policy and model route; "newest session" is not the same thing as "this panel's
   * session" and can write or queue work in another conversation.
   */
  return readMemoSession();
}

/** The workbench's panel id, used by both the `main` view and the left panel list entry. */
const PANEL_ID = 'dsh-short-drama-workbench';
    const COMMAND = 'storyboard';

    /**
     * Where the Host serves media from.
     *
     * Duplicated from `lib/media-service.js` rather than imported, because this file is a
     * browser bundle and that module is Host code that reads the filesystem. The two must agree,
     * so `selftest-client.mjs` asserts they do - a silent divergence would show up as every
     * thumbnail 404ing with nothing to explain why.
     */
    const MEDIA_PREFIX = '/short-drama/media/';
    const SHOT_STATE_LABELS = {
      'missing-assets': '缺资产',
      'needs-attention': '需处理',
      ready: '可生成',
      running: '生成中',
      'awaiting-review': '待选用',
      decided: '已选用',
    };
    const SHOT_STATE_COLORS = {
      'missing-assets': '#b42318',
      'needs-attention': '#b54708',
      ready: '#1769aa',
      running: '#0f766e',
      'awaiting-review': '#8a4b08',
      decided: '#1f7a45',
    };
    const SHOT_FILTERS = [
      ['all', '全部'],
      ['todo', '待处理'],
      ['missing-assets', '缺资产'],
      ['needs-attention', '需处理'],
      ['ready', '可生成'],
      ['running', '生成中'],
      ['awaiting-review', '待选用'],
      ['decided', '已选用'],
    ];
    const DRAMA_PANE_STORAGE_KEY = 'dsh-sdd-drama-pane-widths-v2';
    const SHOT_SOURCE_STORAGE_KEY = 'dsh-sdd-shot-sources-v1';
    const DEFAULT_DRAMA_PANE_WIDTHS = Object.freeze({ assets: 236, prompt: 390 });
    const DRAMA_PANE_MIN_WIDTHS = Object.freeze({ assets: 184, prompt: 280, preview: 210 });
    const DRAMA_PANE_SPLITTER_TOTAL = 16;

    function clampDramaPane(value, minimum, maximum) {
      return Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
    }

    function readDramaPaneWidths() {
      try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(DRAMA_PANE_STORAGE_KEY) ?? 'null');
        if (Number.isFinite(raw?.assets) && Number.isFinite(raw?.prompt)) {
          return {
            assets: clampDramaPane(Math.round(raw.assets), DRAMA_PANE_MIN_WIDTHS.assets, 1600),
            prompt: clampDramaPane(Math.round(raw.prompt), DRAMA_PANE_MIN_WIDTHS.prompt, 1800),
          };
        }
      } catch {
        // Defaults still work when storage is unavailable.
      }
      return { ...DEFAULT_DRAMA_PANE_WIDTHS };
    }

    function saveDramaPaneWidths(widths) {
      try {
        globalThis.localStorage?.setItem(DRAMA_PANE_STORAGE_KEY, JSON.stringify(widths));
      } catch {
        // Resizing remains usable without storage.
      }
    }

    function readShotSourceChoices() {
      try {
        const value = JSON.parse(globalThis.localStorage?.getItem(SHOT_SOURCE_STORAGE_KEY) ?? '{}');
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    }

    function writeShotSourceChoices(choices) {
      try {
        globalThis.localStorage?.setItem(SHOT_SOURCE_STORAGE_KEY, JSON.stringify(choices));
      } catch {
        // The in-memory choice still applies for this session.
      }
    }

    function fitDramaPaneWidths(widths, containerWidth) {
      let assets = clampDramaPane(Math.round(widths.assets), DRAMA_PANE_MIN_WIDTHS.assets, 1600);
      let prompt = clampDramaPane(Math.round(widths.prompt), DRAMA_PANE_MIN_WIDTHS.prompt, 1800);
      const width = Number(containerWidth);
      if (!Number.isFinite(width) || width <= 0) return { assets, prompt };
      const budget = Math.max(
        DRAMA_PANE_MIN_WIDTHS.assets + DRAMA_PANE_MIN_WIDTHS.prompt,
        width - DRAMA_PANE_SPLITTER_TOTAL - DRAMA_PANE_MIN_WIDTHS.preview,
      );
      const overflow = assets + prompt - budget;
      if (overflow <= 0) return { assets, prompt };
      const shrinkable = (assets - DRAMA_PANE_MIN_WIDTHS.assets)
        + (prompt - DRAMA_PANE_MIN_WIDTHS.prompt);
      if (overflow >= shrinkable) {
        return {
          assets: DRAMA_PANE_MIN_WIDTHS.assets,
          prompt: DRAMA_PANE_MIN_WIDTHS.prompt,
        };
      }
      assets -= Math.round(overflow * ((assets - DRAMA_PANE_MIN_WIDTHS.assets) / shrinkable));
      prompt = budget - assets;
      return { assets, prompt };
    }

    /**
     * The panel's visual layer.
     *
     * React output in the sidebar is long-lived and tightly packed, so hover, focus, scrollbar
     * and narrow-width behaviour cannot be expressed with inline styles alone. This sheet is
     * scoped to the panel root and only changes presentation.
     */
    const UI_CSS = `
      .dsh-sdd {
        --sdd-bg: #f3f5f9;
        --sdd-surface: #ffffff;
        --sdd-subtle: #f7f8fb;
        --sdd-sunken: #e9edf4;
        --sdd-border: #cbd4e0;
        --sdd-border-strong: #8793a3;
        --sdd-text: #172033;
        --sdd-muted: #58677b;
        --sdd-accent: #315eea;
        --sdd-accent-hover: #254bc2;
        --sdd-accent-subtle: rgba(49,94,234,.09);
        --sdd-accent-contrast: #ffffff;
        --sdd-focus: #6687ff;
        --sdd-success: #24734b;
        --sdd-running: #176c8a;
        --sdd-danger: #b42318;
        --sdd-warning: #865a00;
        --sdd-preview: #0d121a;
        --sdd-shadow-sm: 0 1px 2px rgba(15,23,42,.06);
        --sdd-shadow-md: 0 10px 28px rgba(15,23,42,.12);
        --dsw-bg-base: #f3f5f9;
        --dsw-surface-raised: #ffffff;
        --dsw-surface-subtle: #f7f8fb;
        --dsw-surface-sunken: #e9edf4;
        --dsw-border-default: #cbd4e0;
        --dsw-border-strong: #8793a3;
        --dsw-text-primary: #172033;
        --dsw-text-secondary: #58677b;
        --dsw-accent-default: #315eea;
        --dsw-accent-subtle: rgba(49,94,234,.09);
        --dsw-accent-on: #ffffff;
        --dsw-danger-default: #b42318;
        --dsw-warning-default: #865a00;
        color-scheme: light;
        isolation: isolate;
        background: var(--sdd-bg);
        color: var(--sdd-text);
        font-family: "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
        font-size: 13px;
        letter-spacing: 0;
        -webkit-font-smoothing: antialiased;
      }
      body[data-ds-dark-theme] .dsh-sdd,
      html[data-ds-dark-theme] .dsh-sdd,
      body[data-theme="dark"] .dsh-sdd,
      [data-theme="dark"] .dsh-sdd {
        --sdd-bg: #0d1117;
        --sdd-surface: #151b24;
        --sdd-subtle: #1a222d;
        --sdd-sunken: #202a37;
        --sdd-border: #293545;
        --sdd-border-strong: #3b4a5e;
        --sdd-text: #eef3fa;
        --sdd-muted: #a8b4c5;
        --sdd-accent: #8da9ff;
        --sdd-accent-hover: #a9bdff;
        --sdd-accent-subtle: rgba(116,146,255,.14);
        --sdd-accent-contrast: #0b1220;
        --sdd-focus: #b3c3ff;
        --sdd-success: #6bd5a1;
        --sdd-running: #7dd0e8;
        --sdd-danger: #ff9c96;
        --sdd-warning: #f0c465;
        --sdd-preview: #070b10;
        --sdd-shadow-sm: 0 1px 2px rgba(0,0,0,.28);
        --sdd-shadow-md: 0 12px 32px rgba(0,0,0,.38);
        --dsw-bg-base: #0d1117;
        --dsw-surface-raised: #151b24;
        --dsw-surface-subtle: #1a222d;
        --dsw-surface-sunken: #202a37;
        --dsw-border-default: #293545;
        --dsw-border-strong: #3b4a5e;
        --dsw-text-primary: #eef3fa;
        --dsw-text-secondary: #a8b4c5;
        --dsw-accent-default: #8da9ff;
        --dsw-accent-subtle: rgba(116,146,255,.14);
        --dsw-accent-on: #0b1220;
        --dsw-danger-default: #ff9c96;
        --dsw-warning-default: #f0c465;
        color-scheme: dark;
      }
      .dsh-sdd *, .dsh-sdd *::before, .dsh-sdd *::after { box-sizing: border-box; }
      .dsh-sdd button, .dsh-sdd select, .dsh-sdd textarea, .dsh-sdd input {
        font-family: inherit;
      }
      .dsh-sdd button, .dsh-sdd select {
        transition: border-color .14s ease, background-color .14s ease, color .14s ease,
          box-shadow .14s ease, transform .14s ease, opacity .14s ease;
      }
      .dsh-sdd button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .dsh-sdd button:hover:not(:disabled) {
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-mini-btn:hover:not(:disabled), .sdd-card-actions button:hover:not(:disabled) {
        border-color: var(--sdd-border-strong) !important;
      }
      .dsh-sdd button:active:not(:disabled) { transform: translateY(1px); }
      .dsh-sdd button:focus-visible, .dsh-sdd select:focus-visible,
      .dsh-sdd textarea:focus-visible, .dsh-sdd input:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--sdd-accent) 42%, transparent);
        outline-offset: 2px;
      }
      .dsh-sdd button:disabled { cursor: not-allowed !important; opacity: .48; }
      .dsh-sdd [data-lucide] {
        width: 14px;
        height: 14px;
        flex: none;
        stroke-width: 1.8;
      }
      .sdd-icon { display: block; }
      .sdd-icon-spin { animation: sdd-icon-spin .9s linear infinite; }
      @keyframes sdd-icon-spin { to { transform: rotate(360deg); } }
      .dsh-sdd select {
        box-shadow: var(--sdd-shadow-sm);
      }
      .dsh-sdd select:hover { border-color: var(--sdd-border-strong) !important; }
      .dsh-sdd input:not([type="file"]):not([type="checkbox"]):not([type="radio"]) {
        min-height: 32px;
        padding: 0 9px;
        border: 1px solid var(--sdd-border);
        border-radius: 7px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        font-size: 12px;
      }
      .dsh-sdd input[type="file"] {
        max-width: 100%;
        color: var(--sdd-muted);
        font-size: 11px;
      }
      .dsh-sdd input[type="file"]::file-selector-button {
        margin-right: 7px;
        padding: 5px 8px;
        border: 1px solid var(--sdd-border);
        border-radius: 6px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        font: inherit;
        cursor: pointer;
      }
      .dsh-sdd ::placeholder { color: var(--sdd-muted); opacity: .72; }
      .dsh-sdd ::-webkit-scrollbar { width: 9px; height: 9px; }
      .dsh-sdd ::-webkit-scrollbar-track { background: transparent; }
      .dsh-sdd ::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sdd-border-strong) 72%, transparent);
        border: 2px solid transparent;
        border-radius: 999px;
        background-clip: padding-box;
      }
      .dsh-sdd ::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--sdd-muted) 55%, transparent);
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .sdd-tabs {
        flex: none;
        min-height: 40px !important;
        overflow-x: auto !important;
        overflow-y: hidden;
        scrollbar-width: none;
        background: var(--sdd-bg);
      }
      .sdd-tabs::-webkit-scrollbar { display: none; }
      .sdd-tab {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex: 0 0 auto;
        height: 34px;
        border-radius: 7px 7px 0 0 !important;
        letter-spacing: 0;
      }
      .sdd-tab:hover:not(:disabled) { opacity: 1 !important; }
      .sdd-tab[data-active="true"] {
        background: var(--sdd-subtle) !important;
        box-shadow: inset 0 -1px 0 var(--sdd-bg);
      }
      .sdd-modebar {
        flex: none;
        margin-top: -2px;
        border: 1px solid var(--sdd-border) !important;
        border-radius: 8px;
        min-height: 32px;
        padding: 5px 9px !important;
        gap: 6px !important;
        background: var(--sdd-subtle) !important;
      }
      .sdd-modebar[data-mode="drama"] { box-shadow: inset 3px 0 0 #2f855a; }
      .sdd-modebar[data-mode="general"] { box-shadow: inset 3px 0 0 #b7791f; }
      .sdd-modebar strong { font-size: 11px !important; font-weight: 650 !important; }
      .sdd-mode-hint { display: none !important; }
      .sdd-workspace-summary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-context-toggle,
      .sdd-mode-switch {
        min-height: 26px !important;
        height: 26px;
        padding: 0 8px !important;
        font-size: 10.5px !important;
      }
      .sdd-context-chip {
        padding-left: 8px;
        border-left: 1px solid var(--sdd-border);
      }
      .sdd-control-row {
        min-height: 30px;
        gap: 8px !important;
      }
      .sdd-control-row > select { flex: 1 1 150px; }
      .sdd-context-grid {
        display: grid;
        grid-template-columns: minmax(130px, .8fr) minmax(170px, 1.2fr) minmax(110px, .65fr);
        gap: 7px;
      }
      .sdd-context-grid > :nth-child(4) { grid-column: 1 / -1; }
      .sdd-folder-control button { flex: 1 1 auto; }
      .sdd-path-note {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-source-group {
        gap: 3px !important;
        padding: 3px;
        border: 1px solid var(--sdd-border);
        border-radius: 9px;
        background: var(--sdd-subtle);
      }
      .sdd-source {
        min-height: 27px;
        border-color: transparent !important;
        background: transparent !important;
        font-weight: 550;
      }
      .sdd-source[data-active="true"] {
        background: var(--sdd-surface) !important;
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-source[data-missing="true"] { color: var(--sdd-muted); }
      .sdd-production {
        border-color: var(--sdd-border) !important;
        background: var(--sdd-subtle) !important;
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--sdd-accent) 72%, transparent);
        gap: 6px !important;
        padding: 8px 9px !important;
      }
      .sdd-production button { background: var(--sdd-surface); }
      .sdd-production [data-dsh-production-filters] {
        flex-wrap: nowrap !important;
        overflow-x: auto;
        padding: 1px 0 2px;
        scrollbar-width: none;
      }
      .sdd-production [data-dsh-production-filters]::-webkit-scrollbar { display: none; }
      .sdd-production [data-dsh-production-filters] > button {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .sdd-production-summary { font-variant-numeric: tabular-nums; }
      .sdd-status {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border-radius: 999px !important;
        line-height: 18px !important;
        font-weight: 600;
        white-space: nowrap;
      }
      .sdd-status::before {
        content: "";
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 14%, transparent);
      }
      .sdd-promptbar {
        background: var(--sdd-surface) !important;
        border-color: var(--sdd-border) !important;
        box-shadow: var(--sdd-shadow-sm);
        gap: 5px !important;
        padding: 6px 8px !important;
      }
      .sdd-promptbar [data-dsh-script-prompt-current] { display: none !important; }
      .sdd-promptbar button, .sdd-promptbar select { min-height: 28px !important; height: 28px; }
      .sdd-shot-list {
        gap: 10px !important;
        padding: 4px 2px 18px !important;
      }
      .sdd-script-view {
        container-name: sdd-drama-script;
        container-type: inline-size;
      }
      .sdd-drama-stage {
        min-width: 0;
        min-height: 0;
      }
      .sdd-drama-workbench {
        display: grid;
        grid-template-columns: clamp(90px, 9%, 104px) minmax(0, 1fr);
        gap: 10px;
        width: 100%;
        min-width: 0;
        min-height: 0;
        flex: 1 1 0;
      }
      .sdd-drama-rail {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-surface);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-drama-rail-section {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
      }
      .sdd-drama-shots {
        flex: 1 1 0;
      }
      .sdd-drama-section-head {
        display: flex;
        min-height: 42px;
        align-items: center;
        gap: 7px;
        padding: 7px 9px;
        border-bottom: 1px solid var(--sdd-border);
        background: var(--sdd-subtle);
      }
      .sdd-drama-section-head > div:first-child > .sdd-icon,
      .sdd-drama-section-head > div:first-child > span {
        display: none;
      }
      .sdd-drama-section-head > div:first-child {
        justify-content: center;
      }
      .sdd-drama-section-head strong { font-size: 9.5px; }
      .sdd-drama-section-head > div:first-child {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        align-items: baseline;
        gap: 6px;
        flex-wrap: nowrap;
      }
      .sdd-drama-section-head strong {
        overflow: hidden;
        font-size: 11px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-drama-section-head span {
        color: var(--sdd-muted);
        font-size: 9px;
        font-variant-numeric: tabular-nums;
      }
      .sdd-icon-button {
        width: 28px;
        min-width: 28px;
        height: 28px;
        padding: 0;
        flex: none;
        border: 1px solid var(--sdd-border-strong);
        border-radius: 6px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        box-shadow: 0 1px 2px rgba(15,23,42,.08);
        cursor: pointer;
      }
      .sdd-icon-button:hover:not(:disabled) {
        border-color: var(--sdd-accent);
        color: var(--sdd-accent);
      }
      .sdd-drama-shot-select {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 4px;
        margin: 4px;
        padding: 0 4px;
        border: 1px solid var(--sdd-border);
        border-radius: 6px;
        background: var(--sdd-bg);
        color: var(--sdd-muted);
      }
      .sdd-drama-shot-select select {
        width: 100%;
        min-width: 0;
        height: 28px;
        min-height: 28px !important;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        color: var(--sdd-text);
        font-size: 8.5px;
      }
      .sdd-drama-shot-select > .sdd-icon { display: none; }
      .sdd-drama-shot-scroll {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-content: start;
        gap: 4px;
        min-height: 0;
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 0 4px 8px;
      }
      .sdd-drama-shot {
        position: relative;
        display: flex;
        width: 100%;
        min-width: 0;
        aspect-ratio: 1 / 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        padding: 5px;
        border: 1px solid var(--sdd-border);
        border-radius: 7px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        text-align: center;
        cursor: pointer;
      }
      .sdd-drama-shot:hover {
        border-color: var(--sdd-border-strong);
        background: var(--sdd-subtle);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-drama-shot.active {
        border-color: var(--sdd-accent);
        background: var(--sdd-accent-subtle);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sdd-accent) 28%, transparent);
      }
      .sdd-drama-shot-number {
        font-size: 18px;
        font-weight: 700;
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .sdd-drama-shot-label {
        color: var(--sdd-muted);
        font-size: 6.5px;
        font-weight: 600;
      }
      .sdd-drama-shot-dot {
        position: absolute;
        top: 5px;
        right: 5px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent);
      }
      .sdd-drama-editor {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        gap: 7px;
        overflow: hidden;
        container-name: sdd-drama-editor;
        container-type: inline-size;
      }
      .sdd-drama-editor-bar {
        display: flex;
        min-height: 42px;
        flex: none;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-surface);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-drama-editor-bar > div {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
      }
      .sdd-drama-editor-bar > div:first-child {
        flex: 1 1 auto;
      }
      .sdd-drama-editor-bar span {
        overflow: hidden;
        color: var(--sdd-muted);
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-drama-editor-bar strong {
        overflow: hidden;
        font-size: 11px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-drama-editor-feed {
        min-height: 0;
        flex: 1 1 auto;
        overflow-y: auto;
        overscroll-behavior: contain;
        scroll-behavior: smooth;
        scrollbar-gutter: stable;
      }
      .sdd-drama-shot-section {
        height: 100%;
        min-height: 100%;
        padding-bottom: 10px;
      }
      .sdd-drama-shot-section > .sdd-card {
        height: 100% !important;
        min-height: 0 !important;
        overflow: hidden !important;
      }
      .sdd-shot-workbench-grid > * {
        min-width: 0;
        min-height: 0;
      }
      .sdd-shot-reference-panel { order: 1; }
      .sdd-shot-splitter[data-dsh-drama-splitter="assets-prompt"] { order: 2; }
      .sdd-shot-prompt-panel { order: 3; }
      .sdd-shot-splitter[data-dsh-drama-splitter="prompt-preview"] { order: 4; }
      .sdd-shot-preview-panel { order: 5; }
      .sdd-shot-splitter {
        position: relative;
        width: 8px;
        min-width: 8px;
        align-self: stretch;
        cursor: col-resize;
        touch-action: none;
        outline: none;
      }
      .sdd-shot-splitter::after {
        content: "";
        position: absolute;
        top: 8px;
        bottom: 8px;
        left: 3px;
        width: 2px;
        border-radius: 2px;
        background: var(--sdd-border);
        transition: background .14s ease, box-shadow .14s ease;
      }
      .sdd-shot-splitter:hover::after,
      .sdd-shot-splitter:focus-visible::after {
        background: var(--sdd-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--sdd-accent) 18%, transparent);
      }
      .sdd-shot-column-head {
        display: flex;
        min-height: 28px;
        flex: none;
        align-items: center;
        gap: 6px;
        padding: 0 2px 6px;
        border-bottom: 1px solid var(--sdd-border);
      }
      .sdd-shot-column-head strong {
        font-size: 10.5px;
        font-weight: 650;
      }
      .sdd-shot-column-head span {
        overflow: hidden;
        margin-left: auto;
        color: var(--sdd-muted);
        font-size: 8.5px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-reference-tile {
        position: relative;
        min-width: 0;
        overflow: hidden;
        border: 1px solid var(--sdd-border-strong) !important;
        border-top: 2px solid var(--sdd-accent) !important;
        border-radius: 7px !important;
        background: var(--sdd-surface) !important;
        box-shadow: 0 2px 7px rgba(20,34,29,.09);
        transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease;
      }
      .sdd-reference-tile:hover {
        border-color: var(--sdd-accent) !important;
        box-shadow: 0 5px 14px rgba(20,34,29,.14);
        transform: translateY(-1px);
      }
      .sdd-reference-tile[data-dsh-reference-kind="参考音频"] { border-top-color: #d8a93e !important; }
      .sdd-reference-tile[data-dsh-reference-kind="参考视频"] { border-top-color: #53aebd !important; }
      .sdd-reference-tile[data-dsh-reference-kind="场景"] { border-top-color: #55c7a1 !important; }
      .sdd-reference-tile[data-dsh-reference-kind="道具"] { border-top-color: #dcae58 !important; }
      .sdd-reference-thumb {
        border-bottom: 1px solid var(--sdd-border);
      }
      .sdd-reference-copy {
        background: var(--sdd-subtle);
      }
      .sdd-reference-remove {
        display: grid !important;
        width: 24px !important;
        height: 24px !important;
        min-width: 24px !important;
        min-height: 24px !important;
        place-items: center;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        color: #fff !important;
        cursor: pointer;
      }
      .sdd-reference-remove-mark {
        display: grid;
        width: 19px;
        height: 19px;
        place-items: center;
        border: 1px solid rgba(255,255,255,.3);
        border-radius: 999px;
        background: rgba(12,16,18,.72);
        box-shadow: 0 1px 4px rgba(0,0,0,.28);
        transition: background .14s ease, border-color .14s ease, transform .14s ease;
      }
      .sdd-reference-remove:hover:not(:disabled) .sdd-reference-remove-mark,
      .sdd-reference-remove:focus-visible .sdd-reference-remove-mark {
        border-color: color-mix(in srgb, var(--sdd-danger) 70%, white);
        background: color-mix(in srgb, var(--sdd-danger) 78%, black);
        transform: scale(1.05);
      }
      .sdd-reference-empty {
        border: 1px dashed var(--sdd-border-strong) !important;
        border-top: 1px dashed var(--sdd-border-strong) !important;
        background: color-mix(in srgb, var(--sdd-subtle) 82%, transparent) !important;
        box-shadow: none;
      }
      @container sdd-drama-editor (max-width: 585px) {
        .sdd-shot-workbench-grid {
          grid-template-columns: minmax(0, 1fr) !important;
          overflow-y: auto;
        }
        .sdd-shot-splitter { display: none; }
        .sdd-shot-workbench-grid > * {
          height: auto !important;
          min-height: 180px;
        }
      }
      @container sdd-drama-script (max-width: 720px) {
        .sdd-drama-workbench {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: auto minmax(0, 1fr);
        }
        .sdd-drama-rail {
          max-height: 210px;
        }
        .sdd-drama-shots {
          flex: 1 1 auto;
        }
        .sdd-drama-shot-scroll {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .sdd-card {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: 0 2px 6px rgba(16,24,40,.08);
        transition: border-color .16s ease, box-shadow .16s ease;
      }
      .sdd-card:hover {
        border-color: color-mix(in srgb, var(--sdd-accent) 34%, var(--sdd-border-strong)) !important;
        box-shadow: 0 6px 18px rgba(16,24,40,.10);
      }
      .sdd-card[data-open="true"] {
        border-color: color-mix(in srgb, var(--sdd-accent) 42%, var(--sdd-border-strong)) !important;
        box-shadow: 0 8px 24px rgba(16,24,40,.11);
      }
      .sdd-card-head {
        min-height: 42px;
        background: var(--sdd-surface);
      }
      .sdd-card-head:hover { background: var(--sdd-subtle) !important; }
      .sdd-card-actions {
        gap: 5px !important;
        row-gap: 5px !important;
      }
      .sdd-card-actions button {
        min-height: 26px;
        padding: 0 8px !important;
        background: var(--sdd-surface);
        font-weight: 540;
      }
      .sdd-card-source-host { display: inline-flex; flex: none; }
      .sdd-inline-source-switch {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border: 1px solid var(--sdd-border);
        border-radius: 6px;
        background: var(--sdd-subtle);
      }
      .sdd-inline-source-switch button {
        min-height: 22px !important;
        height: 22px;
        padding: 0 6px !important;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--sdd-muted);
        font-size: 9px;
        box-shadow: none !important;
      }
      .sdd-inline-source-switch button.active {
        border-color: var(--sdd-border-strong);
        background: var(--sdd-surface);
        color: var(--sdd-text);
        box-shadow: var(--sdd-shadow-sm) !important;
      }
      .sdd-inline-source-switch button[data-dsh-source-missing="true"] {
        border-style: dashed;
        opacity: .7;
      }
      .sdd-source-preview .sdd-card-head {
        cursor: default;
      }
      .sdd-source-preview .sdd-editor-shell {
        flex: 1 1 auto;
      }
      .sdd-editor {
        background: var(--sdd-surface) !important;
      }
      .sdd-fullscreen [data-dsh-asset-column] {
        padding: 8px !important;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-subtle);
      }
      .sdd-fullscreen [data-dsh-preview] {
        border: 1px solid var(--sdd-border) !important;
        border-style: solid !important;
        border-radius: 8px !important;
        background: var(--sdd-subtle) !important;
      }
      [data-dsh-generation-controls] {
        border-radius: 0;
      }
      .sdd-preview-empty {
        display: flex;
        min-height: 150px;
        flex: 1 1 auto;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        color: var(--sdd-muted);
        font-size: 10px;
        text-align: center;
      }
      .sdd-preview-active {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 7px;
      }
      .sdd-preview-caption {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
      }
      .sdd-preview-caption strong {
        overflow: hidden;
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-preview-caption span {
        color: var(--sdd-muted);
        font-size: 8.5px;
      }
      .sdd-video-cache {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 6px;
        padding-top: 8px;
        border-top: 1px solid var(--sdd-border);
      }
      .sdd-video-cache-head,
      .sdd-video-cache-head > div {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 5px;
      }
      .sdd-video-cache-head { justify-content: space-between; }
      .sdd-video-cache-head strong { font-size: 9.5px; font-weight: 650; }
      .sdd-video-cache-head span {
        color: var(--sdd-muted);
        font-size: 8px;
      }
      .sdd-video-cache-grid {
        display: grid;
        grid-auto-columns: minmax(112px, 1fr);
        grid-auto-flow: column;
        gap: 6px;
        min-width: 0;
        overflow-x: auto;
        padding-bottom: 2px;
        scrollbar-width: thin;
      }
      .sdd-cache-video {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) 14px;
        min-height: 46px;
        align-items: center;
        gap: 6px;
        padding: 5px 6px;
        border: 1px solid var(--sdd-border);
        border-radius: 6px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        text-align: left;
        cursor: pointer;
      }
      .sdd-cache-video:hover {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-cache-video.active {
        border-color: var(--sdd-accent) !important;
        background: var(--sdd-accent-subtle);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sdd-accent) 28%, transparent);
      }
      .sdd-cache-video-index {
        display: grid;
        width: 24px;
        height: 30px;
        place-items: center;
        border-radius: 4px;
        background: var(--sdd-sunken);
        color: var(--sdd-muted);
        font-size: 9px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .sdd-cache-video-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
      }
      .sdd-cache-video-copy strong {
        overflow: hidden;
        font-size: 9px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-cache-video-copy span {
        overflow: hidden;
        color: var(--sdd-muted);
        font-size: 7.5px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-general-result-cache {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 6px;
      }
      .sdd-general-result-cache-head {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--sdd-muted);
        font-size: 9.5px;
      }
      .sdd-general-result-cache-head strong {
        color: var(--sdd-text);
        font-size: 10.5px;
      }
      .sdd-general-result-cache-strip {
        display: grid;
        grid-auto-columns: minmax(104px, 132px);
        grid-auto-flow: column;
        gap: 7px;
        min-width: 0;
        overflow-x: auto;
        padding: 1px 1px 4px;
        scroll-snap-type: x proximity;
        scrollbar-width: thin;
        touch-action: pan-x;
      }
      .sdd-general-result-thumb {
        display: flex;
        min-width: 0;
        min-height: 88px;
        flex-direction: column;
        overflow: hidden;
        padding: 0;
        border: 1px solid var(--sdd-border);
        border-radius: 6px;
        background: var(--sdd-surface);
        color: var(--sdd-text);
        text-align: left;
        scroll-snap-align: start;
        cursor: pointer;
      }
      .sdd-general-result-thumb:hover {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-general-result-thumb[data-active="true"] {
        border-color: var(--sdd-accent) !important;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sdd-accent) 32%, transparent);
      }
      .sdd-general-result-thumb-media {
        position: relative;
        display: grid;
        width: 100%;
        height: 60px;
        place-items: center;
        overflow: hidden;
        background: var(--sdd-preview);
      }
      .sdd-general-result-thumb-media img,
      .sdd-general-result-thumb-media video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .sdd-general-result-thumb-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1px;
        padding: 4px 6px 5px;
      }
      .sdd-general-result-thumb-copy strong,
      .sdd-general-result-thumb-copy span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-general-result-thumb-copy strong {
        font-size: 9px;
        font-weight: 650;
      }
      .sdd-general-result-thumb-copy span {
        color: var(--sdd-muted);
        font-size: 8px;
      }
      .sdd-card-foot {
        min-height: 36px;
        background: var(--sdd-subtle);
      }
      .sdd-asset-card, .sdd-result-card, .sdd-job-card {
        border-color: var(--sdd-border-strong) !important;
        transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      .sdd-asset-card {
        position: relative;
        border: 2px solid var(--sdd-border-strong) !important;
        border-top: 3px solid var(--sdd-asset-accent, var(--sdd-accent)) !important;
        border-radius: 8px !important;
        overflow: hidden;
        background: var(--sdd-surface) !important;
        box-shadow: 0 2px 8px rgba(20,34,29,.08);
      }
      .sdd-asset-card::before {
        content: "资产";
        position: absolute;
        top: 9px;
        left: 9px;
        z-index: 3;
        min-height: 20px;
        padding: 2px 6px;
        border: 1px solid color-mix(in srgb, var(--sdd-asset-accent, var(--sdd-accent)) 38%, var(--sdd-border));
        border-radius: 5px;
        background: color-mix(in srgb, var(--sdd-surface) 91%, transparent);
        color: var(--sdd-asset-accent, var(--sdd-accent));
        font-size: 8px;
        font-weight: 700;
        line-height: 14px;
        backdrop-filter: blur(6px);
      }
      .sdd-asset-card[data-dsh-asset-kind="character"] {
        --sdd-asset-accent: #4a91dc;
      }
      .sdd-asset-card[data-dsh-asset-kind="character"]::before { content: "人物"; }
      .sdd-asset-card[data-dsh-asset-kind="scene"] {
        --sdd-asset-accent: #2d9b78;
      }
      .sdd-asset-card[data-dsh-asset-kind="scene"]::before { content: "场景"; }
      .sdd-asset-card[data-dsh-asset-kind="prop"] {
        --sdd-asset-accent: #b77a24;
      }
      .sdd-asset-card[data-dsh-asset-kind="prop"]::before { content: "道具"; }
      .sdd-asset-card[data-dsh-asset-kind="reference-audio"] {
        --sdd-asset-accent: #a17719;
      }
      .sdd-asset-card[data-dsh-asset-kind="reference-audio"]::before { content: "音频"; }
      .sdd-asset-card[data-dsh-asset-kind="reference-video"] {
        --sdd-asset-accent: #2e8093;
      }
      .sdd-asset-card[data-dsh-asset-kind="reference-video"]::before { content: "视频"; }
      .sdd-asset-card[data-dsh-asset-kind="reference-image"],
      .sdd-asset-card[data-dsh-asset-kind="reference-media"] {
        --sdd-asset-accent: #8064b3;
      }
      .sdd-asset-tile {
        --sdd-asset-accent: var(--sdd-accent);
        border-top: 3px solid var(--sdd-asset-accent) !important;
      }
      .sdd-asset-tile::before {
        content: "资产";
        position: absolute;
        top: 13px;
        left: 13px;
        z-index: 3;
        min-height: 20px;
        padding: 2px 6px;
        border: 1px solid color-mix(in srgb, var(--sdd-asset-accent) 42%, var(--sdd-border));
        border-radius: 5px;
        background: color-mix(in srgb, var(--sdd-surface) 92%, transparent);
        color: var(--sdd-asset-accent);
        font-size: 8px;
        font-weight: 700;
        line-height: 14px;
        backdrop-filter: blur(6px);
      }
      .sdd-asset-tile[data-dsh-asset-kind="character"] {
        --sdd-asset-accent: #4a91dc;
      }
      .sdd-asset-tile[data-dsh-asset-kind="character"]::before { content: "人物"; }
      .sdd-asset-tile[data-dsh-asset-kind="scene"] {
        --sdd-asset-accent: #2d9b78;
      }
      .sdd-asset-tile[data-dsh-asset-kind="scene"]::before { content: "场景"; }
      .sdd-asset-tile[data-dsh-asset-kind="prop"] {
        --sdd-asset-accent: #b77a24;
      }
      .sdd-asset-tile[data-dsh-asset-kind="prop"]::before { content: "道具"; }
      .sdd-asset-tile[data-dsh-asset-kind="reference-audio"] {
        --sdd-asset-accent: #a17719;
      }
      .sdd-asset-tile[data-dsh-asset-kind="reference-audio"]::before { content: "音频"; }
      .sdd-asset-tile[data-dsh-asset-kind="reference-video"] {
        --sdd-asset-accent: #2e8093;
      }
      .sdd-asset-tile[data-dsh-asset-kind="reference-video"]::before { content: "视频"; }
      .sdd-asset-tile:hover {
        border-color: var(--sdd-asset-accent) !important;
        box-shadow: 0 8px 22px rgba(20,34,29,.16) !important;
        transform: translateY(-2px);
      }
      .sdd-asset-tile:focus-visible {
        outline: 2px solid var(--sdd-asset-accent);
        outline-offset: 2px;
      }
      .sdd-asset-card-simple {
        padding: 10px !important;
        gap: 8px !important;
      }
      .sdd-asset-card-visual {
        padding: 10px !important;
        gap: 9px !important;
      }
      .sdd-asset-card [data-dsh-character-reference="true"] {
        grid-template-columns: 84px minmax(0, 1fr) !important;
        gap: 9px !important;
      }
      .sdd-asset-card img {
        border: 1px solid var(--sdd-border);
        box-shadow: 0 1px 4px rgba(20,34,29,.08);
      }
      .sdd-asset-tile img {
        display: block;
        border: 0;
        box-shadow: none;
      }
      .sdd-asset-card:hover {
        border-color: var(--sdd-accent) !important;
        box-shadow: 0 7px 20px rgba(20,34,29,.14);
        transform: translateY(-1px);
      }
      .sdd-result-card:hover, .sdd-job-card:hover {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-md);
        transform: translateY(-1px);
      }
        .sdd-asset-detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(170px, .8fr);
          gap: 12px;
          align-items: start;
        }
        @media (max-width: 720px) {
          .sdd-asset-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      .sdd-picker { box-shadow: var(--sdd-shadow-md); }
      .sdd-config-page {
        width: 100%;
        min-width: 0;
        color: var(--sdd-text);
      }
      .sdd-config-header {
        display: flex;
        min-height: 48px;
        align-items: center;
        gap: 9px;
        padding: 9px 11px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--sdd-surface) 94%, transparent);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-config-header > span {
        color: var(--sdd-muted);
        font-size: 10px;
      }
      .sdd-config-header > span:last-child {
        overflow: hidden;
        margin-left: auto;
        max-width: 45%;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-config-section {
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-config-prompt-source {
        border-color: var(--sdd-border-strong) !important;
      }
      .sdd-config-task-tabs {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(118px, 100%), 1fr));
        width: 100%;
        min-width: 0;
        max-width: 100%;
        gap: 5px;
        padding: 4px;
        overflow: visible;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-subtle);
      }
      .sdd-config-task-tab {
        display: inline-flex;
        width: 100%;
        min-width: 0;
        min-height: 34px;
        justify-content: center;
        align-items: center;
        gap: 5px;
        padding: 0 10px !important;
        border-radius: 6px !important;
        background: transparent !important;
        color: var(--sdd-muted) !important;
        opacity: 1 !important;
        font-size: 11px !important;
        line-height: 1.15 !important;
        white-space: nowrap;
        box-shadow: none !important;
      }
      .sdd-config-task-tab .sdd-icon {
        flex: none;
      }
      .sdd-config-task-tab:hover {
        color: var(--sdd-text) !important;
        background: color-mix(in srgb, var(--sdd-surface) 62%, transparent) !important;
      }
      .sdd-config-task-tab.active {
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        box-shadow: var(--sdd-shadow-sm) !important;
      }
      .sdd-config-runtime {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 9px 10px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-surface);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-config-endpoint-switch {
        display: inline-flex;
        flex: none;
        gap: 2px;
        padding: 2px;
        border: 1px solid var(--sdd-border);
        border-radius: 7px;
        background: var(--sdd-subtle);
      }
      .sdd-config-endpoint-switch button {
        min-height: 27px !important;
        padding: 0 9px !important;
        border-radius: 5px !important;
        background: transparent !important;
        font-size: 10.5px !important;
        opacity: 1 !important;
      }
      .sdd-config-endpoint-switch button[data-active="true"] {
        background: var(--sdd-surface) !important;
        box-shadow: var(--sdd-shadow-sm) !important;
      }
      .sdd-config-environments {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr));
        gap: 10px;
        min-width: 0;
      }
      .sdd-config-video-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(285px, 100%), 1fr));
        gap: 10px;
        min-width: 0;
      }
      .sdd-config-env,
      .sdd-config-video-env {
        transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
      }
      .sdd-config-env:hover,
      .sdd-config-video-env:hover {
        box-shadow: var(--sdd-shadow-md) !important;
        transform: translateY(-1px);
      }
      .sdd-config-footer {
        position: sticky;
        bottom: -1px;
        z-index: 3;
        display: flex;
        min-height: 52px;
        align-items: center;
        gap: 8px;
        padding: 9px 10px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--sdd-surface) 94%, transparent);
        box-shadow: 0 -4px 16px rgba(16,24,40,.08);
        backdrop-filter: blur(10px);
      }
      .sdd-config-save {
        min-width: 132px;
      }
      .sdd-config-runtime-note {
        min-width: 0;
        flex: 1 1 180px;
        overflow-wrap: anywhere;
      }
      .sdd-generation-toolbar {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 7px;
        flex-wrap: wrap;
      }
      .sdd-generation-task-tabs {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(126px, 100%), 1fr));
        min-width: 0;
        flex: 1 1 100%;
        gap: 5px;
      }
      .sdd-generation-task-tab {
        width: 100%;
        min-width: 0;
        min-height: 34px !important;
        padding: 0 10px !important;
        border-radius: 6px !important;
        font-size: 11px !important;
        line-height: 1.15 !important;
        white-space: nowrap;
      }
      .sdd-generation-toolbar-actions {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        flex: 1 1 auto;
        margin-left: auto;
      }
      .sdd-general-upload-row {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .sdd-general-upload-button {
        display: inline-flex !important;
        min-height: 34px !important;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 11px !important;
        border-radius: 7px !important;
        font-size: 11.5px !important;
        line-height: 1 !important;
        white-space: nowrap;
      }
      .sdd-general-upload-button .sdd-icon {
        flex: none;
      }
      .sdd-general-upload-count {
        display: inline-flex;
        min-width: 34px;
        height: 24px;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        padding: 0 7px;
        border: 1px solid var(--sdd-border);
        border-radius: 999px;
        background: var(--sdd-subtle);
        color: var(--sdd-muted);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .sdd-config-page select,
      .sdd-config-page input {
        max-width: 100%;
        min-width: 0;
      }
      .sdd-empty {
        padding: 18px 14px !important;
        border: 1px dashed var(--sdd-border) !important;
        border-radius: 8px;
        text-align: center;
      }
      .sdd-fullscreen[data-fullscreen="true"] {
        padding: 12px 22px 0 !important;
        background: var(--sdd-bg) !important;
      }
      .sdd-fullscreen[data-fullscreen="true"] .sdd-tabs {
        position: sticky;
        top: 0;
        z-index: 3;
      }
      .sdd-workbench-overlay {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        min-height: 0;
        overflow: visible;
        background: var(--sdd-bg);
        border-right: 1px solid var(--sdd-border);
        box-shadow: 12px 0 32px rgba(16, 24, 40, .14);
        animation: sdd-workbench-in .16s ease-out both;
      }
      .sdd-workbench-overlay[data-resizing="true"] { user-select: none; }
      .sdd-workbench-resizer {
        position: absolute;
        top: 0;
        right: -5px;
        bottom: 0;
        z-index: 4;
        width: 10px;
        cursor: col-resize;
        touch-action: none;
        outline: none;
      }
      .sdd-workbench-resizer::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 4px;
        width: 2px;
        border-radius: 2px;
        background: transparent;
        transition: background .12s ease, box-shadow .12s ease;
      }
      .sdd-workbench-resizer:hover::after,
      .sdd-workbench-resizer:focus-visible::after,
      .sdd-workbench-overlay[data-resizing="true"] .sdd-workbench-resizer::after {
        background: var(--dsw-accent-default, #2f6fed);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-accent-default, #2f6fed) 18%, transparent);
      }
      @keyframes sdd-workbench-in {
        from { opacity: .72; transform: translateX(-8px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .sdd-workbench-overlay { animation: none; }
      }
      /*
       * The host keeps a desktop minimum for the conversation column. Below this width the
       * side-by-side geometry can extend past the viewport, so the workbench takes the screen
       * and its own close control returns to the conversation.
       */
      @media (max-width: 900px) {
        .sdd-workbench-overlay[data-dsh-workbench-overlay="true"] {
          top: 0 !important;
          right: auto !important;
          bottom: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100dvh !important;
          max-width: 100vw !important;
          border-right: 0;
          z-index: 80 !important;
          animation: none !important;
          transform: none !important;
        }
        .sdd-workbench-overlay[data-dsh-workbench-overlay="true"] > .dsh-sdd {
          width: 100%;
          max-width: 100vw;
        }
      }
      @media (max-width: 430px) {
        .dsh-sdd { padding: 8px !important; gap: 7px !important; }
        .sdd-mode-hint { display: none !important; }
        .sdd-context-chip { flex-basis: 100% !important; border-left: 0; padding-left: 0; }
        .sdd-control-row { gap: 6px !important; }
        .sdd-control-row > select { flex-basis: 116px; }
        .sdd-context-grid { grid-template-columns: 1fr; gap: 6px; }
        .sdd-context-grid > :nth-child(4) { grid-column: auto; }
        .sdd-modebar { padding: 7px 8px !important; }
        .sdd-card-head { align-items: flex-start; flex-wrap: wrap; }
        .sdd-card-actions { width: 100%; margin-left: 22px !important; justify-content: flex-start !important; }
        .sdd-card-actions button { flex: 1 1 auto; }
        .sdd-production { padding: 8px !important; }
        .sdd-shot-list { gap: 8px !important; padding-inline: 0 !important; }
      }
      @media (max-width: 650px) {
        .sdd-video-workbench { gap: 10px !important; }
      }
      [data-dsh-video-compose-layout="split"] {
        container-name: sdd-video-compose;
        container-type: inline-size;
      }
      .sdd-video-workbench {
        display: grid;
        width: 100%;
        min-width: 0;
        align-items: stretch;
        height: clamp(460px, calc(100dvh - 260px), 760px);
        min-height: 0;
      }
      .sdd-video-assets-pane,
      .sdd-video-prompt-pane,
      .sdd-video-preview-pane {
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow-y: auto;
        scrollbar-gutter: stable;
      }
      .sdd-video-assets-pane > [data-dsh-h3-asset-bar] {
        height: 100%;
        border-radius: 8px;
        border-color: var(--sdd-border) !important;
        background: var(--sdd-surface) !important;
      }
      .sdd-video-prompt-pane {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-surface);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-video-prompt-pane > label[data-dsh-video-prompt="true"] {
        flex: 1 1 auto;
        min-height: 270px;
      }
      .sdd-video-prompt-pane > label[data-dsh-video-prompt="true"] > span {
        color: var(--sdd-text);
        font-size: 12px;
        font-weight: 600;
      }
      .sdd-video-prompt-pane textarea {
        min-height: 260px !important;
        flex: 1 1 auto;
        resize: none !important;
        border-color: var(--sdd-border) !important;
        background: var(--sdd-bg) !important;
        color: var(--sdd-text) !important;
      }
      .sdd-video-prompt-pane > button[data-dsh-generate-submit] {
        display: inline-flex;
        width: 100%;
        min-height: 36px;
        align-items: center;
        justify-content: center;
        gap: 7px;
        align-self: stretch !important;
        box-shadow: 0 2px 7px color-mix(in srgb, var(--sdd-accent) 24%, transparent);
      }
      .sdd-video-splitter {
        position: relative;
        width: 10px;
        min-width: 10px;
        cursor: col-resize;
        touch-action: none;
        outline: none;
        align-self: stretch;
      }
      .sdd-video-splitter::after {
        content: "";
        position: absolute;
        top: 8px;
        bottom: 8px;
        left: 4px;
        width: 2px;
        border-radius: 2px;
        background: var(--sdd-border);
        transition: background .14s ease, box-shadow .14s ease;
      }
      .sdd-video-splitter:hover::after,
      .sdd-video-splitter:focus-visible::after {
        background: var(--sdd-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--sdd-accent) 18%, transparent);
      }
      .sdd-video-preview-pane {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border: 1px solid var(--sdd-border);
        border-radius: 8px;
        background: var(--sdd-surface);
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-video-preview-head {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .sdd-video-preview-head > div:first-child {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
      }
      .sdd-video-preview-head strong { font-size: 12px; font-weight: 600; }
      .sdd-video-preview-head span {
        overflow: hidden;
        color: var(--sdd-muted);
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-video-preview-stage {
        width: min(100%, 270px);
        min-height: 270px;
        max-height: 460px;
        flex: 0 1 auto;
        aspect-ratio: 9 / 16;
        margin: 0 auto;
        overflow: hidden;
        border: 1px solid var(--sdd-border-strong);
        border-radius: 7px;
        background: #050707;
      }
      .sdd-video-preview-empty {
        display: flex;
        width: 100%;
        height: 100%;
        min-height: 270px;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 18px;
        color: #d9e3df;
        text-align: center;
      }
      .sdd-video-preview-empty-mark {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 50%;
        background: rgba(255,255,255,.05);
      }
      .sdd-video-preview-empty strong { font-size: 12px; font-weight: 600; }
      .sdd-video-preview-empty span { max-width: 210px; color: #8fa19a; font-size: 9px; line-height: 1.55; }
      .sdd-video-preview-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--sdd-muted);
        font-size: 9px;
      }
      .sdd-video-preview-meta span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-video-preview-meta span:last-child { margin-left: auto; white-space: nowrap; }
      .sdd-video-preview-timeline {
        display: block;
        height: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--sdd-border);
      }
      .sdd-video-preview-timeline span {
        display: block;
        width: 42%;
        height: 100%;
        background: var(--sdd-accent);
      }
      .sdd-video-preview-actions {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 30px;
      }
      .sdd-video-preview-actions .selection-note { flex: 1; }
      @container sdd-video-compose (max-width: 759px) {
        .sdd-video-workbench {
          display: flex !important;
          height: auto;
          flex-direction: column;
          gap: 10px;
        }
        .sdd-video-splitter { display: none; }
        .sdd-video-assets-pane,
        .sdd-video-prompt-pane,
        .sdd-video-preview-pane {
          height: auto;
          max-height: none;
          overflow-y: visible;
        }
        .sdd-video-assets-pane > [data-dsh-h3-asset-bar] { height: auto; }
        .sdd-video-prompt-pane { min-height: 480px; }
        .sdd-video-preview-stage { width: 100%; max-width: 320px; max-height: 500px; }
      }
      @media (max-width: 760px) {
        .sdd-video-workbench {
          display: flex !important;
          height: auto;
          flex-direction: column;
          gap: 10px;
        }
        .sdd-video-splitter { display: none; }
        .sdd-video-assets-pane,
        .sdd-video-prompt-pane,
        .sdd-video-preview-pane {
          height: auto;
          max-height: none;
          overflow-y: visible;
        }
        .sdd-video-assets-pane > [data-dsh-h3-asset-bar] { height: auto; }
        .sdd-video-prompt-pane { min-height: 480px; }
        .sdd-video-preview-stage { width: 100%; max-width: 320px; max-height: 500px; }
      }
      @media (min-width: 900px) {
        .sdd-fullscreen .sdd-card-head { min-height: 46px; }
        .sdd-fullscreen .sdd-card-actions { flex-wrap: nowrap !important; }
        .sdd-fullscreen .sdd-mode-hint { display: inline !important; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-sdd *, .dsh-sdd *::before, .dsh-sdd *::after {
          scroll-behavior: auto !important;
          transition-duration: .01ms !important;
          animation-duration: .01ms !important;
        }
      }

      /*
       * v76 DeepSeek Studio visual pass.
       *
       * The workbench is a production surface, not a settings form: navigation, editing and
       * review need three visibly different rhythms. These rules keep the same DOM and actions,
       * but make the primary path readable at normal desktop distance and give both themes the
       * same information hierarchy.
       */
      .dsh-sdd {
        --sdd-radius-sm: 6px;
        --sdd-radius-md: 8px;
        --sdd-ease: cubic-bezier(.2, .7, .2, 1);
        position: relative;
        gap: 10px;
        padding: 12px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--sdd-bg) 92%, var(--sdd-surface)) 0, var(--sdd-bg) 180px);
      }
      .dsh-sdd button,
      .dsh-sdd select,
      .dsh-sdd textarea,
      .dsh-sdd input {
        accent-color: var(--sdd-accent);
      }
      .dsh-sdd button,
      .dsh-sdd select,
      .dsh-sdd textarea {
        transition:
          border-color .16s var(--sdd-ease),
          background-color .16s var(--sdd-ease),
          color .16s var(--sdd-ease),
          box-shadow .16s var(--sdd-ease),
          opacity .16s var(--sdd-ease);
      }
      .dsh-sdd button:focus-visible,
      .dsh-sdd select:focus-visible,
      .dsh-sdd textarea:focus-visible,
      .dsh-sdd input:focus-visible,
      .dsh-sdd [role="button"]:focus-visible,
      .dsh-sdd [role="separator"]:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--sdd-focus) 54%, transparent);
        outline-offset: 2px;
      }
      .dsh-sdd select {
        min-height: 34px;
        border-color: var(--sdd-border) !important;
        background-color: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        font-size: 12px !important;
      }
      .dsh-sdd select:hover:not(:disabled) {
        border-color: var(--sdd-border-strong) !important;
      }
      .dsh-sdd select:disabled {
        background: var(--sdd-subtle) !important;
        color: var(--sdd-muted) !important;
      }
      .dsh-sdd textarea::selection {
        background: color-mix(in srgb, var(--sdd-accent) 24%, transparent);
      }

      /* Navigation: one quiet toolbar, with the active destination carrying the only strong fill. */
      .sdd-tabs {
        min-height: 48px !important;
        gap: 4px !important;
        padding: 6px !important;
        border: 1px solid var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: color-mix(in srgb, var(--sdd-surface) 96%, var(--sdd-bg)) !important;
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-tab {
        height: 34px;
        min-height: 34px !important;
        padding: 0 10px !important;
        border: 1px solid transparent !important;
        border-bottom-color: transparent !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: transparent !important;
        color: var(--sdd-muted) !important;
        font-size: 11.5px !important;
        font-weight: 560 !important;
        opacity: 1 !important;
      }
      .sdd-tab:hover:not(:disabled) {
        border-color: var(--sdd-border) !important;
        background: var(--sdd-subtle) !important;
        color: var(--sdd-text) !important;
        box-shadow: none !important;
      }
      .sdd-tab[data-active="true"] {
        border-color: color-mix(in srgb, var(--sdd-accent) 24%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        color: var(--sdd-accent) !important;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sdd-accent) 12%, transparent) !important;
      }
      .sdd-tab[data-active="true"] .sdd-icon {
        color: var(--sdd-accent);
      }
      .sdd-fullscreen-toggle,
      .sdd-workbench-close {
        margin-left: auto !important;
        border-color: var(--sdd-border) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        font-weight: 600 !important;
        white-space: nowrap;
      }
      .sdd-tabs > .sdd-tab:last-child {
        margin-left: auto;
      }

      /* Context strip: product identity, current episode and mode controls read as one unit. */
      .sdd-modebar {
        min-height: 46px;
        padding: 8px 10px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
        box-shadow: var(--sdd-shadow-sm) !important;
      }
      .sdd-modebar > .sdd-icon {
        width: 18px;
        height: 18px;
        color: var(--sdd-accent);
      }
      .sdd-modebar > strong {
        color: var(--sdd-text);
        font-size: 12px !important;
        font-weight: 680 !important;
      }
      .sdd-workspace-summary {
        padding-left: 9px;
        border-left: 1px solid var(--sdd-border);
        color: var(--sdd-muted);
        font-size: 11px;
        line-height: 1.45;
      }
      .sdd-context-toggle,
      .sdd-mode-switch {
        height: 30px !important;
        min-height: 30px !important;
        padding: 0 10px !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        font-size: 11px !important;
      }
      .sdd-mode-switch {
        border-color: var(--sdd-border-strong) !important;
      }
      .sdd-context-grid {
        gap: 8px !important;
        padding: 10px !important;
        border: 1px solid var(--sdd-border);
        border-radius: var(--sdd-radius-md);
        background: var(--sdd-subtle);
      }
      .sdd-control-row {
        min-height: 34px;
        gap: 7px !important;
        min-width: 0;
      }
      .sdd-control-row > span:first-child {
        color: var(--sdd-muted);
        font-size: 10.5px;
        font-weight: 620;
      }
      .sdd-control-row > select,
      .sdd-control-row > button {
        min-width: 0;
      }
      .sdd-create-inline-button {
        min-height: 30px !important;
        height: 30px;
        padding: 0 9px !important;
        flex: none;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        font-size: 10.5px !important;
        font-weight: 620;
        white-space: nowrap;
      }
      .sdd-create-inline-button:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--sdd-accent) 42%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        color: var(--sdd-accent) !important;
      }
      .sdd-context-note {
        grid-column: 1 / -1;
        padding: 7px 9px;
        border: 1px solid color-mix(in srgb, var(--sdd-accent) 24%, var(--sdd-border));
        border-radius: var(--sdd-radius-sm);
        background: var(--sdd-accent-subtle);
        color: var(--sdd-text);
        font-size: 11px;
        line-height: 1.45;
      }
      .sdd-dialog-scrim {
        position: absolute;
        inset: 0;
        z-index: 80;
        display: grid;
        place-items: center;
        padding: 18px;
        background: color-mix(in srgb, var(--sdd-bg) 45%, transparent);
        backdrop-filter: blur(7px);
      }
      .sdd-dialog {
        display: flex;
        width: min(620px, 100%);
        max-height: calc(100% - 8px);
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
        padding: 16px;
        border: 1px solid var(--sdd-border-strong);
        border-radius: var(--sdd-radius-md);
        background: var(--sdd-surface);
        color: var(--sdd-text);
        box-shadow: 0 24px 64px rgba(0,0,0,.26);
      }
      .sdd-dialog.compact {
        width: min(360px, 100%);
      }
      .sdd-dialog-head {
        display: flex;
        min-width: 0;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .sdd-dialog-head > div {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 3px;
      }
      .sdd-dialog-head strong {
        font-size: 15px;
        font-weight: 720;
      }
      .sdd-dialog-head span {
        overflow: hidden;
        color: var(--sdd-muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-dialog-close {
        display: grid !important;
        width: 28px;
        min-width: 28px;
        height: 28px;
        min-height: 28px !important;
        place-items: center;
        padding: 0 !important;
        border: 1px solid var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-subtle) !important;
        color: var(--sdd-muted) !important;
        font-size: 16px;
      }
      .sdd-dialog-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .sdd-dialog-field {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
      }
      .sdd-dialog-field.wide {
        grid-column: 1 / -1;
      }
      .sdd-dialog-field > span {
        color: var(--sdd-muted);
        font-size: 10.5px;
        font-weight: 620;
      }
      .sdd-dialog-field > input,
      .sdd-dialog-field > select {
        width: 100%;
        min-width: 0;
        height: 36px;
        min-height: 36px;
        padding: 0 9px;
        border: 1px solid var(--sdd-border);
        border-radius: var(--sdd-radius-sm);
        background: var(--sdd-surface);
        color: var(--sdd-text);
        font: inherit;
        font-size: 12px;
      }
      .sdd-dialog-upload {
        display: flex;
        min-height: 38px;
        align-items: center;
        gap: 7px;
        padding: 0 10px;
        border: 1px dashed var(--sdd-border-strong);
        border-radius: var(--sdd-radius-sm);
        background: var(--sdd-subtle);
        color: var(--sdd-text);
        font-size: 11px;
        cursor: pointer;
      }
      .sdd-dialog-upload:hover {
        border-color: var(--sdd-accent);
        color: var(--sdd-accent);
      }
      .sdd-dialog-upload input { display: none; }
      .sdd-dialog-upload span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-dialog-text-button {
        align-self: flex-start;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        color: var(--sdd-muted) !important;
        font-size: 10px !important;
      }
      .sdd-dialog-error {
        grid-column: 1 / -1;
        padding: 7px 9px;
        border: 1px solid color-mix(in srgb, var(--sdd-danger) 30%, var(--sdd-border));
        border-radius: var(--sdd-radius-sm);
        background: color-mix(in srgb, var(--sdd-danger) 8%, var(--sdd-surface));
        color: var(--sdd-danger);
        font-size: 11px;
        line-height: 1.45;
      }
      .sdd-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 7px;
      }
      .sdd-dialog-primary,
      .sdd-dialog-secondary {
        min-height: 34px !important;
        padding: 0 13px !important;
        border-radius: var(--sdd-radius-sm) !important;
        font-size: 11.5px !important;
        font-weight: 650 !important;
      }
      .sdd-dialog-primary {
        border-color: var(--sdd-accent) !important;
        background: var(--sdd-accent) !important;
        color: var(--sdd-accent-contrast) !important;
      }
      .sdd-dialog-secondary {
        border-color: var(--sdd-border) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
      }
      .sdd-promptbar {
        padding: 10px !important;
        gap: 8px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
      }
      .sdd-promptbar strong {
        font-size: 12px !important;
      }
      .sdd-promptbar button,
      .sdd-promptbar select {
        height: 32px !important;
        min-height: 32px !important;
      }

      /* Episode status: a compact production strip, not another card stack. */
      .sdd-production {
        padding: 10px 11px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
        box-shadow: inset 3px 0 0 var(--sdd-warning), var(--sdd-shadow-sm) !important;
      }
      .sdd-production strong {
        color: var(--sdd-text);
        font-size: 12px !important;
      }
      .sdd-production-summary {
        color: var(--sdd-muted) !important;
        font-size: 10.5px !important;
        opacity: 1 !important;
      }
      .sdd-production [data-dsh-production-next="true"] {
        padding-top: 8px;
        border-top: 1px solid var(--sdd-border);
        color: var(--sdd-muted);
        font-size: 11px !important;
      }
      .sdd-production button {
        height: 30px;
        min-height: 30px;
        border-radius: var(--sdd-radius-sm) !important;
      }

      /* Workbench geometry: a readable navigator beside a focused three-pane editor. */
      .sdd-script-view {
        gap: 9px !important;
      }
      .sdd-drama-workbench {
        grid-template-columns: clamp(132px, 12%, 158px) minmax(0, 1fr) !important;
        gap: 10px !important;
      }
      .sdd-drama-rail,
      .sdd-drama-editor-bar {
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
        box-shadow: var(--sdd-shadow-sm);
      }
      .sdd-drama-rail {
        overflow: hidden;
      }
      .sdd-drama-section-head {
        min-height: 48px;
        padding: 8px 9px;
        gap: 6px;
        border-bottom-color: var(--sdd-border);
        background: var(--sdd-subtle);
      }
      .sdd-drama-section-head > div:first-child > .sdd-icon,
      .sdd-drama-section-head > div:first-child > span {
        display: inline-flex !important;
      }
      .sdd-drama-section-head > div:first-child > .sdd-icon {
        width: 15px;
        height: 15px;
        color: var(--sdd-accent);
      }
      .sdd-drama-section-head strong {
        overflow: hidden;
        font-size: 11.5px !important;
        font-weight: 680;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-drama-section-head span {
        color: var(--sdd-muted) !important;
        font-size: 9.5px !important;
      }
      .sdd-icon-button {
        width: 30px;
        min-width: 30px;
        height: 30px;
        border-color: var(--sdd-border-strong) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-muted) !important;
        box-shadow: 0 1px 2px rgba(15,23,42,.08);
      }
      .sdd-icon-button:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--sdd-accent) 48%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        color: var(--sdd-accent) !important;
      }
      .sdd-drama-shot-select {
        margin: 6px !important;
        padding: 0 5px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
      }
      .sdd-drama-shot-select select {
        height: 32px !important;
        min-height: 32px !important;
        color: var(--sdd-text) !important;
        font-size: 10px !important;
      }
      .sdd-drama-shot-scroll {
        gap: 6px !important;
        padding: 0 6px 9px !important;
      }
      .sdd-drama-shot {
        display: grid !important;
        grid-template-columns: 34px minmax(0, 1fr) 7px;
        grid-template-rows: auto auto;
        min-height: 60px;
        aspect-ratio: auto !important;
        align-content: center;
        align-items: center;
        justify-content: stretch;
        gap: 2px 7px;
        padding: 8px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
        text-align: left !important;
      }
      .sdd-drama-shot:hover {
        border-color: var(--sdd-border-strong) !important;
        background: var(--sdd-subtle) !important;
      }
      .sdd-drama-shot.active {
        border-color: color-mix(in srgb, var(--sdd-accent) 62%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        box-shadow: inset 3px 0 0 var(--sdd-accent) !important;
      }
      .sdd-drama-shot-number {
        grid-column: 1;
        grid-row: 1 / 3;
        color: var(--sdd-text);
        font-size: 18px !important;
        font-weight: 720 !important;
        line-height: 1;
        text-align: center;
      }
      .sdd-drama-shot-label {
        grid-column: 2;
        grid-row: 1;
        align-self: end;
        color: var(--sdd-muted) !important;
        overflow: hidden;
        font-size: 10.5px !important;
        font-weight: 650 !important;
        line-height: 1.2;
        text-align: left !important;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdd-drama-shot::after {
        grid-column: 2;
        grid-row: 2;
        align-self: start;
        color: var(--sdd-muted);
        font-size: 10px;
        font-weight: 620;
        line-height: 1.35;
        white-space: nowrap;
      }
      .sdd-drama-shot[data-dsh-shot-status="missing-assets"]::after { content: "缺资产"; color: var(--sdd-danger); }
      .sdd-drama-shot[data-dsh-shot-status="needs-attention"]::after { content: "需处理"; color: var(--sdd-warning); }
      .sdd-drama-shot[data-dsh-shot-status="ready"]::after { content: "可生成"; color: var(--sdd-accent); }
      .sdd-drama-shot[data-dsh-shot-status="running"]::after { content: "生成中"; color: var(--sdd-running); }
      .sdd-drama-shot[data-dsh-shot-status="awaiting-review"]::after { content: "待选用"; color: var(--sdd-warning); }
      .sdd-drama-shot[data-dsh-shot-status="decided"]::after { content: "已选用"; color: var(--sdd-success); }
      .sdd-drama-shot[data-dsh-shot-status="unknown"]::after { content: "未检查"; }
      .sdd-drama-shot-dot {
        position: static !important;
        grid-column: 3;
        grid-row: 1 / 3;
        width: 7px !important;
        height: 7px !important;
        align-self: center;
      }
      .sdd-drama-shot[data-dsh-shot-status="missing-assets"] .sdd-drama-shot-dot { background: var(--sdd-danger) !important; color: var(--sdd-danger); }
      .sdd-drama-shot[data-dsh-shot-status="needs-attention"] .sdd-drama-shot-dot { background: var(--sdd-warning) !important; color: var(--sdd-warning); }
      .sdd-drama-shot[data-dsh-shot-status="ready"] .sdd-drama-shot-dot { background: var(--sdd-accent) !important; color: var(--sdd-accent); }
      .sdd-drama-shot[data-dsh-shot-status="running"] .sdd-drama-shot-dot { background: var(--sdd-running) !important; color: var(--sdd-running); }
      .sdd-drama-shot[data-dsh-shot-status="awaiting-review"] .sdd-drama-shot-dot { background: var(--sdd-warning) !important; color: var(--sdd-warning); }
      .sdd-drama-shot[data-dsh-shot-status="decided"] .sdd-drama-shot-dot { background: var(--sdd-success) !important; color: var(--sdd-success); }
      .sdd-drama-editor {
        gap: 9px !important;
      }
      .sdd-drama-editor-bar {
        min-height: 50px;
        padding: 9px 11px !important;
      }
      .sdd-drama-editor-bar > div:first-child {
        gap: 7px !important;
      }
      .sdd-drama-editor-bar .sdd-icon {
        color: var(--sdd-accent);
      }
      .sdd-drama-editor-bar span {
        color: var(--sdd-muted) !important;
        font-size: 10px !important;
        font-weight: 620;
      }
      .sdd-drama-editor-bar > div:first-child > span::after {
        content: " /";
        color: var(--sdd-border-strong);
      }
      .sdd-drama-editor-bar strong {
        color: var(--sdd-text);
        font-size: 12.5px !important;
        font-weight: 680;
      }
      .sdd-drama-editor-feed {
        scrollbar-gutter: stable;
      }

      /* Shot surface and three columns. */
      .sdd-card {
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
        box-shadow: var(--sdd-shadow-sm) !important;
      }
      .sdd-card:hover {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-md) !important;
      }
      .sdd-card[data-open="true"] {
        border-color: color-mix(in srgb, var(--sdd-accent) 32%, var(--sdd-border)) !important;
        box-shadow: var(--sdd-shadow-md) !important;
      }
      .sdd-card-head {
        min-height: 48px;
        padding: 9px 11px !important;
        border-bottom: 1px solid var(--sdd-border);
        background: var(--sdd-surface) !important;
      }
      .sdd-card-title {
        color: var(--sdd-text);
        font-size: 13px !important;
        font-weight: 680 !important;
      }
      .sdd-card-actions {
        gap: 6px !important;
      }
      .sdd-card-actions button {
        min-height: 30px !important;
        padding: 0 9px !important;
        border-color: var(--sdd-border-strong) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-text) !important;
        font-size: 10.5px !important;
        box-shadow: 0 1px 2px rgba(15,23,42,.08);
      }
      .sdd-card-actions button:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--sdd-accent) 42%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        color: var(--sdd-accent) !important;
      }
      .sdd-status {
        min-height: 22px;
        padding: 1px 8px !important;
        border-color: color-mix(in srgb, currentColor 28%, var(--sdd-border)) !important;
        background: color-mix(in srgb, currentColor 9%, var(--sdd-surface)) !important;
        font-size: 10px !important;
        font-weight: 650 !important;
      }
      .sdd-status[data-dsh-shot-status="missing-assets"] { color: var(--sdd-danger) !important; }
      .sdd-status[data-dsh-shot-status="needs-attention"],
      .sdd-status[data-dsh-shot-status="awaiting-review"] { color: var(--sdd-warning) !important; }
      .sdd-status[data-dsh-shot-status="ready"] { color: var(--sdd-accent) !important; }
      .sdd-status[data-dsh-shot-status="running"] { color: var(--sdd-running) !important; }
      .sdd-status[data-dsh-shot-status="decided"] { color: var(--sdd-success) !important; }
      .sdd-inline-source-switch {
        padding: 3px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        background: var(--sdd-subtle) !important;
      }
      .sdd-inline-source-switch button {
        min-height: 25px !important;
        height: 25px !important;
        padding: 0 7px !important;
        font-size: 9.5px !important;
      }
      .sdd-inline-source-switch button.active {
        background: var(--sdd-surface) !important;
        color: var(--sdd-accent) !important;
      }
      .sdd-shot-reference-panel,
      .sdd-shot-prompt-panel,
      .sdd-shot-preview-panel {
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        align-self: stretch;
        height: 100% !important;
        min-height: clamp(440px, 64vh, 780px);
      }
      .sdd-shot-reference-panel,
      .sdd-shot-preview-panel {
        background: var(--sdd-subtle) !important;
      }
      .sdd-shot-prompt-panel {
        background: var(--sdd-surface) !important;
      }
      .sdd-shot-preview-panel {
        overflow-x: hidden !important;
        overflow-y: auto !important;
        scrollbar-gutter: stable;
      }
      .sdd-preview-active {
        min-height: 0;
        flex: 1 1 auto;
        overflow: hidden;
      }
      .sdd-preview-active > video {
        width: 100% !important;
        height: 100% !important;
        min-height: 220px;
        max-height: 100% !important;
        flex: 1 1 auto;
        object-fit: contain;
      }
      .sdd-video-cache-preview {
        flex: 0 0 auto;
      }
      .sdd-video-cache-compact {
        flex: 0 0 auto;
        align-items: center;
        padding-top: 7px;
        border-top: 1px solid var(--sdd-border);
      }
      .sdd-video-cache-compact .sdd-video-cache-nav {
        width: 100%;
        justify-content: center;
        margin-left: 0;
        gap: 8px;
      }
      .sdd-video-cache-compact .sdd-video-cache-position {
        min-width: 44px;
        color: var(--sdd-text) !important;
        font-size: 10px !important;
        text-align: center;
      }
      .sdd-shot-column-head {
        min-height: 36px !important;
        padding: 0 2px 8px !important;
        border-bottom-color: var(--sdd-border) !important;
      }
      .sdd-shot-column-head::before {
        content: "";
        width: 3px;
        height: 14px;
        flex: none;
        border-radius: 2px;
        background: var(--sdd-accent);
      }
      .sdd-shot-column-head strong {
        color: var(--sdd-text);
        font-size: 11.5px !important;
        font-weight: 680;
      }
      .sdd-shot-column-head span {
        color: var(--sdd-muted) !important;
        font-size: 9.5px !important;
      }
      .sdd-shot-preview-panel .sdd-shot-column-head::before {
        background: var(--sdd-warning);
      }
      .sdd-shot-splitter::after {
        top: 12px;
        bottom: 12px;
        width: 1px;
        background: color-mix(in srgb, var(--sdd-border-strong) 72%, transparent);
      }
      .sdd-reference-tile {
        border-top-width: 1px !important;
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-sm) !important;
        box-shadow: none;
      }
      .sdd-reference-tile:hover {
        border-color: var(--sdd-border-strong) !important;
        box-shadow: var(--sdd-shadow-sm);
        transform: none !important;
      }
      .sdd-reference-copy {
        background: var(--sdd-surface) !important;
      }
      .sdd-editor-shell {
        border-color: var(--sdd-border) !important;
        border-radius: var(--sdd-radius-md) !important;
        background: var(--sdd-surface) !important;
        box-shadow: inset 0 1px 0 color-mix(in srgb, var(--sdd-text) 3%, transparent);
      }
      .sdd-editor-shell:focus-within {
        border-color: color-mix(in srgb, var(--sdd-accent) 58%, var(--sdd-border)) !important;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sdd-accent) 13%, transparent);
      }
      .sdd-editor-shell .sdd-textarea {
        padding: 15px 17px !important;
        font-size: 14px !important;
        line-height: 1.68 !important;
      }
      .sdd-editor-shell .sdd-textarea-mirror {
        color: inherit !important;
        pointer-events: none;
      }
      .sdd-preview-empty {
        min-height: 190px;
        gap: 10px;
        border: 1px dashed var(--sdd-border-strong);
        border-radius: var(--sdd-radius-sm);
        background:
          linear-gradient(135deg, color-mix(in srgb, var(--sdd-sunken) 54%, transparent), transparent 58%);
        color: var(--sdd-muted);
        font-size: 10.5px;
      }
      .sdd-preview-empty .sdd-icon {
        width: 28px;
        height: 28px;
        color: var(--sdd-accent);
      }
      .sdd-preview-caption strong {
        font-size: 11px;
      }
      .sdd-preview-caption span {
        font-size: 9.5px;
      }
      .sdd-video-cache-head strong {
        font-size: 10.5px;
      }
      .sdd-video-cache-head span {
        font-size: 9px;
      }
      .sdd-video-cache-head {
        min-height: 28px;
        gap: 8px;
      }
      .sdd-video-cache-head > div:first-child {
        flex: 1 1 auto;
      }
      .sdd-video-cache-count {
        display: inline-grid;
        min-width: 19px;
        height: 19px;
        place-items: center;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--sdd-accent-subtle);
        color: var(--sdd-accent) !important;
        font-size: 9.5px !important;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .sdd-video-cache-nav {
        display: flex;
        flex: none;
        align-items: center;
        gap: 3px;
        margin-left: auto;
      }
      .sdd-video-cache-position {
        min-width: 38px;
        color: var(--sdd-muted);
        font-size: 9.5px !important;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .sdd-cache-nav-button {
        width: 27px;
        min-width: 27px;
        height: 27px;
        min-height: 27px !important;
        padding: 0 !important;
        border: 1px solid var(--sdd-border) !important;
        border-radius: 5px !important;
        background: var(--sdd-surface) !important;
        color: var(--sdd-muted) !important;
      }
      .sdd-cache-nav-button:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--sdd-accent) 42%, var(--sdd-border)) !important;
        background: var(--sdd-accent-subtle) !important;
        color: var(--sdd-accent) !important;
      }
      .sdd-cache-nav-button:disabled {
        opacity: .34;
      }
      .sdd-video-cache-grid {
        grid-auto-columns: minmax(138px, 156px);
        gap: 7px;
        overflow-x: auto;
        overflow-y: hidden;
        overscroll-behavior-x: contain;
        scroll-snap-type: x proximity;
        scroll-padding-inline: 1px;
        touch-action: pan-x;
        padding: 2px 1px 5px;
      }
      .sdd-cache-video {
        min-height: 54px;
        grid-template-columns: 26px minmax(0, 1fr) 14px;
        border-color: var(--sdd-border);
        border-radius: var(--sdd-radius-sm);
        background: var(--sdd-surface);
        scroll-snap-align: start;
        user-select: none;
      }
      .sdd-cache-video.active {
        border-color: var(--sdd-accent) !important;
        background: var(--sdd-accent-subtle);
      }
      .sdd-cache-video-copy strong {
        font-size: 10.5px;
      }
      .sdd-cache-video-copy span {
        font-size: 9.5px;
      }

      /* Review and generation footer: readable state, one obvious primary action. */
      .sdd-card-foot {
        min-height: 38px;
        padding: 8px 11px !important;
        border-top-color: var(--sdd-border) !important;
        background: var(--sdd-surface);
        color: var(--sdd-muted);
        font-size: 10.5px;
      }
      .sdd-card-foot [data-dsh-autosave] {
        color: var(--sdd-muted);
        font-size: 10.5px;
      }
      .sdd-generation-controls {
        display: grid !important;
        grid-template-columns: minmax(104px, auto) minmax(64px, auto) minmax(64px, auto) repeat(3, minmax(76px, 1fr)) minmax(118px, auto) !important;
        align-items: center;
        gap: 7px !important;
        padding: 10px 11px !important;
        border-top-color: var(--sdd-border) !important;
        background: var(--sdd-subtle) !important;
      }
      .sdd-generation-controls > button,
      .sdd-generation-controls > select {
        width: 100%;
        min-width: 0;
        height: 34px !important;
        min-height: 34px !important;
        border-radius: var(--sdd-radius-sm) !important;
      }
      .sdd-generation-controls > button:last-child {
        border-color: var(--sdd-accent) !important;
        background: var(--sdd-accent) !important;
        color: var(--sdd-accent-contrast) !important;
        font-weight: 680 !important;
        box-shadow: 0 4px 12px color-mix(in srgb, var(--sdd-accent) 22%, transparent) !important;
      }
      .sdd-generation-controls > button:last-child:hover:not(:disabled) {
        border-color: var(--sdd-accent-hover) !important;
        background: var(--sdd-accent-hover) !important;
      }
      .sdd-production-reason,
      .sdd-drama-shot-section > .sdd-card > div[data-dsh-shot-reason] {
        color: var(--sdd-muted);
      }

      /* Generic controls elsewhere in the plugin follow the same compact, accessible scale. */
      .sdd-mini-btn,
      .sdd-card-actions button,
      .sdd-promptbar button,
      .sdd-production button {
        font-size: 10.5px !important;
      }
      .sdd-mini-btn,
      .sdd-icon-button,
      .sdd-card-actions button,
      .sdd-promptbar button,
      .sdd-inline-source-switch button {
        min-height: 32px !important;
      }
      .sdd-icon-button {
        width: 32px !important;
        min-width: 32px !important;
        height: 32px !important;
      }
      .sdd-reference-remove {
        display: grid !important;
        width: 32px !important;
        height: 32px !important;
        min-width: 32px !important;
        min-height: 32px !important;
        place-items: center;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        color: #fff !important;
        cursor: pointer;
      }
      @media (pointer: coarse) {
        .sdd-mini-btn,
        .sdd-icon-button,
        .sdd-card-actions button,
        .sdd-promptbar button,
        .sdd-promptbar select,
        .sdd-inline-source-switch button,
        .sdd-reference-remove {
          width: 44px !important;
          height: 44px !important;
          min-width: 44px !important;
          min-height: 44px !important;
        }
        .sdd-reference-remove-mark {
          width: 22px;
          height: 22px;
        }
      }
      .sdd-tab-badge {
        background: color-mix(in srgb, var(--sdd-warning) 14%, transparent);
        color: var(--sdd-warning);
      }
      [data-dsh-reference-kind="参考音频"] {
        --sdd-reference-state: var(--sdd-warning);
      }
      [data-dsh-reference-kind="参考视频"] {
        --sdd-reference-state: var(--sdd-running);
      }

      /* Fixed media art for audio/video files, independent of font glyph coverage. */
      .sdd-media-placeholder {
        --sdd-media-accent: var(--sdd-running);
        display: flex;
        width: 100%;
        height: 100%;
        min-height: 54px;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: var(--sdd-media-accent);
        background:
          linear-gradient(145deg,
            color-mix(in srgb, var(--sdd-media-accent) 14%, var(--sdd-subtle)),
            color-mix(in srgb, var(--sdd-surface) 92%, var(--sdd-media-accent)));
      }
      .sdd-media-placeholder-audio {
        --sdd-media-accent: var(--sdd-warning);
        color: var(--sdd-warning) !important;
      }
      .sdd-media-placeholder-video {
        --sdd-media-accent: var(--sdd-running);
        color: var(--sdd-running) !important;
      }
      .sdd-media-placeholder-icon {
        display: grid;
        width: 42px;
        height: 38px;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--sdd-media-accent) 34%, var(--sdd-border));
        border-radius: var(--sdd-radius-md);
        background: color-mix(in srgb, var(--sdd-surface) 76%, transparent);
        box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 28%, transparent);
      }
      .sdd-media-placeholder-label {
        font-size: 10px;
        font-weight: 650;
        line-height: 1;
      }
      .sdd-media-placeholder.compact {
        min-height: 100%;
        gap: 0;
      }
      .sdd-media-placeholder.compact .sdd-media-placeholder-icon {
        width: 30px;
        height: 30px;
        border-radius: var(--sdd-radius-sm);
      }
      .sdd-media-group-icon {
        display: inline-grid;
        width: 20px;
        height: 20px;
        flex: none;
        place-items: center;
        border-radius: 5px;
        background: color-mix(in srgb, currentColor 10%, transparent);
      }

      /* Dark mode is a tonal variant, not an inversion of the light surfaces. */
      body[data-ds-dark-theme] .dsh-sdd,
      html[data-ds-dark-theme] .dsh-sdd,
      body[data-theme="dark"] .dsh-sdd,
      [data-theme="dark"] .dsh-sdd {
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--sdd-surface) 60%, var(--sdd-bg)) 0, var(--sdd-bg) 220px);
      }
      body[data-ds-dark-theme] .sdd-tabs,
      body[data-ds-dark-theme] .sdd-modebar,
      body[data-ds-dark-theme] .sdd-production,
      body[data-ds-dark-theme] .sdd-drama-rail,
      body[data-ds-dark-theme] .sdd-drama-editor-bar,
      body[data-ds-dark-theme] .sdd-card,
      body[data-ds-dark-theme] .sdd-shot-prompt-panel,
      body[data-ds-dark-theme] .sdd-editor-shell,
      html[data-ds-dark-theme] .sdd-tabs,
      html[data-ds-dark-theme] .sdd-modebar,
      html[data-ds-dark-theme] .sdd-production,
      html[data-ds-dark-theme] .sdd-drama-rail,
      html[data-ds-dark-theme] .sdd-drama-editor-bar,
      html[data-ds-dark-theme] .sdd-card,
      html[data-ds-dark-theme] .sdd-shot-prompt-panel,
      html[data-ds-dark-theme] .sdd-editor-shell {
        box-shadow: 0 1px 0 color-mix(in srgb, #ffffff 3%, transparent), var(--sdd-shadow-sm) !important;
      }
      body[data-ds-dark-theme] .sdd-card-head,
      body[data-ds-dark-theme] .sdd-card-foot,
      body[data-ds-dark-theme] .sdd-shot-reference-panel,
      body[data-ds-dark-theme] .sdd-drama-section-head,
      html[data-ds-dark-theme] .sdd-card-head,
      html[data-ds-dark-theme] .sdd-card-foot,
      html[data-ds-dark-theme] .sdd-shot-reference-panel,
      html[data-ds-dark-theme] .sdd-drama-section-head {
        background: var(--sdd-surface) !important;
      }
      body[data-ds-dark-theme] .sdd-shot-reference-panel,
      body[data-ds-dark-theme] .sdd-shot-preview-panel,
      body[data-ds-dark-theme] .sdd-generation-controls,
      body[data-ds-dark-theme] .sdd-preview-empty,
      html[data-ds-dark-theme] .sdd-shot-reference-panel,
      html[data-ds-dark-theme] .sdd-shot-preview-panel,
      html[data-ds-dark-theme] .sdd-generation-controls,
      html[data-ds-dark-theme] .sdd-preview-empty {
        background-color: var(--sdd-subtle) !important;
      }
      body[data-ds-dark-theme] [data-dsh-active-video],
      body[data-ds-dark-theme] [data-dsh-active-image],
      body[data-ds-dark-theme] .sdd-video-preview-stage {
        background: var(--sdd-preview) !important;
      }
      @media (prefers-color-scheme: dark) {
        .dsh-sdd input[type="file"]::file-selector-button {
          background: var(--sdd-surface);
          color: var(--sdd-text);
        }
      }

      @media (max-width: 1180px) {
        .sdd-generation-controls {
          grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
        }
        .sdd-generation-controls > button:last-child {
          grid-column: span 3;
        }
      }
      @media (max-width: 900px) {
        .dsh-sdd {
          padding: 10px;
        }
        .sdd-drama-workbench {
          grid-template-columns: 124px minmax(0, 1fr) !important;
        }
        .sdd-drama-shot {
          grid-template-columns: 30px minmax(0, 1fr) 7px;
          min-height: 56px;
          padding: 7px !important;
        }
      }
      @container sdd-drama-script (max-width: 720px) {
        .sdd-drama-workbench {
          grid-template-columns: minmax(0, 1fr) !important;
        }
        .sdd-drama-rail {
          max-height: 188px !important;
        }
        .sdd-drama-shot-scroll {
          grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)) !important;
        }
        .sdd-drama-shot {
          min-height: 58px;
        }
      }
      @media (max-width: 650px) {
        .dsh-sdd {
          gap: 8px;
          padding: 8px;
        }
        .sdd-tabs {
          min-height: 44px !important;
          padding: 4px !important;
        }
        .sdd-workspace-summary {
          flex-basis: 100% !important;
          padding-top: 5px;
          padding-left: 0;
          border-top: 1px solid var(--sdd-border);
          border-left: 0;
        }
        .sdd-drama-shot-scroll {
          grid-template-columns: minmax(0, 1fr) !important;
        }
        .sdd-generation-controls {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
        .sdd-generation-controls > button:last-child {
          grid-column: 1 / -1;
        }
        .sdd-editor-shell .sdd-textarea {
          padding: 14px 15px !important;
          font-size: 16px !important;
          line-height: 1.65 !important;
        }
        .sdd-drama-shot-label {
          font-size: 11px !important;
        }
        .sdd-drama-shot::after {
          font-size: 10.5px;
        }
        .sdd-dialog-scrim {
          padding: 10px;
        }
        .sdd-dialog {
          width: 100%;
          max-height: 100%;
          padding: 13px;
        }
        .sdd-dialog-grid {
          grid-template-columns: minmax(0, 1fr);
        }
        .sdd-dialog-field.wide,
        .sdd-dialog-error {
          grid-column: auto;
        }
      }
      @media (forced-colors: active) {
        .dsh-sdd button,
        .dsh-sdd select,
        .dsh-sdd textarea,
        .sdd-card,
        .sdd-tabs,
        .sdd-modebar {
          border: 1px solid ButtonText !important;
          forced-color-adjust: auto;
        }
        .sdd-drama-shot.active,
        .sdd-tab[data-active="true"] {
          outline: 2px solid Highlight;
          outline-offset: -2px;
        }
      }
    `;

    const SDD_ICON_PATHS = Object.freeze({
      play: ['M6 3l14 9-14 9V3z'],
      plus: ['M12 5v14', 'M5 12h14'],
      'chevron-left': ['m15 18-6-6 6-6'],
      'chevron-right': ['m9 18 6-6-6-6'],
      check: ['M20 6 9 17l-5-5'],
      save: [
        'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
        'M17 21v-8H7v8',
        'M7 3v5h8',
      ],
      'maximize-2': [
        'M15 3h6v6',
        'M9 21H3v-6',
        'M21 3l-7 7',
        'M3 21l7-7',
      ],
      sparkles: [
        'M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z',
        'M19 3v4',
        'M21 5h-4',
        'M5 17v4',
        'M7 19H3',
      ],
      clapperboard: [
        'M20.2 6 3 11l-.9-2.4a2 2 0 0 1 1.3-2.5l13.5-4a2 2 0 0 1 2.5 1.3L20.2 6z',
        'm6.2 5.3 3.1 3.9',
        'm12.4 3.4 3.1 4',
        'M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8z',
      ],
      images: [
        'M18 22H4a2 2 0 0 1-2-2V6',
        'M22 2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z',
        'M10 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
        'm22 15-3.1-3.1a2 2 0 0 0-2.8 0L8 20',
      ],
      library: ['m16 6 4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16'],
      'refresh-cw': [
        'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
        'M3 3v5h5',
        'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
        'M21 21v-5h-5',
      ],
      'scan-eye': [
        'M3 7V5a2 2 0 0 1 2-2h2',
        'M17 3h2a2 2 0 0 1 2 2v2',
        'M21 17v2a2 2 0 0 1-2 2h-2',
        'M7 21H5a2 2 0 0 1-2-2v-2',
        'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z',
        'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
      ],
      'sliders-horizontal': [
        'M21 4h-7',
        'M10 4H3',
        'M21 12h-9',
        'M8 12H3',
        'M21 20h-5',
        'M12 20H3',
        'M14 2v4',
        'M8 10v4',
        'M16 18v4',
      ],
      'repeat-2': [
        'm17 2 4 4-4 4',
        'M3 11V9a3 3 0 0 1 3-3h15',
        'm7 22-4-4 4-4',
        'M21 13v2a3 3 0 0 1-3 3H3',
      ],
      'clock-3': [
        'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
        'M12 6v6h5',
      ],
      film: [
        'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
        'M7 3v18',
        'M17 3v18',
        'M3 8h4',
        'M17 8h4',
        'M3 16h4',
        'M17 16h4',
      ],
      'circle-dashed': [
        'M10.1 2.2a10 10 0 0 1 3.8 0',
        'M17.1 3.7a10 10 0 0 1 3.2 3.2',
        'M21.8 10.1a10 10 0 0 1 0 3.8',
        'M20.3 17.1a10 10 0 0 1-3.2 3.2',
        'M13.9 21.8a10 10 0 0 1-3.8 0',
        'M6.9 20.3a10 10 0 0 1-3.2-3.2',
        'M2.2 13.9a10 10 0 0 1 0-3.8',
        'M3.7 6.9a10 10 0 0 1 3.2-3.2',
      ],
      languages: [
        'M5 8l6 6',
        'M4 14l6-6 2-3',
        'M2 5h12',
        'M7 2h1',
        'M22 22l-5-10-5 10',
        'M14 18h6',
      ],
      'monitor-play': [
        'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
        'M8 21h8',
        'M12 17v4',
        'm10 7 5 3-5 3V7z',
      ],
      'user-round': [
        'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
        'M4 21a8 8 0 0 1 16 0',
      ],
      mountain: ['m8 3 4 8 5-5 5 15H2L8 3z'],
      package: [
        'm12 2 9 5-9 5-9-5 9-5z',
        'm3 7 9 5v10l-9-5V7z',
        'm21 7-9 5v10l9-5V7z',
        'M12 12v10',
      ],
      image: [
        'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
        'M8 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
        'm21 15-5-5L5 21',
      ],
      video: [
        'M4 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
        'm22 8-6 4 6 4V8z',
      ],
      'audio-lines': ['M3 10v4', 'M7 6v12', 'M11 3v18', 'M15 7v10', 'M19 5v14', 'M23 10v4'],
      'file-play': [
        'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
        'M14 2v6h6',
        'm10 12 5 3-5 3v-6z',
      ],
      'layers-3': [
        'm12 2 9 5-9 5-9-5 9-5z',
        'm3 12 9 5 9-5',
        'm3 17 9 5 9-5',
      ],
      'gallery-horizontal-end': [
        'M3 5h10v14H3z',
        'M7 9h10v10H7z',
        'M11 3h10v10H11z',
      ],
      'list-checks': ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
      'settings-2': ['M20 7h-9', 'M14 17H5', 'M17 3v4', 'M7 13v4'],
      circle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'],
      x: ['M18 6 6 18', 'm6 6 12 12'],
      file: [
        'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
        'M14 2v6h6',
      ],
      'loader-circle': ['M21 12a9 9 0 1 1-6-8.5'],
    });

    function SddIcon({ name, size = 14, className = '', ...props }) {
      const paths = SDD_ICON_PATHS[name] ?? SDD_ICON_PATHS.circle;
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: ['sdd-icon', name === 'loader-circle' ? 'sdd-icon-spin' : '', className].filter(Boolean).join(' '),
        'data-lucide': name,
        'aria-hidden': 'true',
        ...props,
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    // Desktop uses an RPC transport, and may have no HTTP origin/cookie for <img>.
    // Reuse that authenticated channel for bounded image previews only.
    const previewLoaders = new Map();
    const previewCache = new Map();
    const videoPreviewCache = new Map();
    const audioPreviewCache = new Map();
    function PreviewImage({ src, ...props }) {
      const [shown, setShown] = React.useState(null);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        let live = true;
        setShown(null); setError('');
        const load = previewLoaders.get(src);
        if (load === undefined) { setShown(src); return undefined; }
        let pending = previewCache.get(src);
        if (pending === undefined) {
          pending = load();
          previewCache.set(src, pending);
          if (previewCache.size > 256) previewCache.delete(previewCache.keys().next().value);
        }
        pending.then((data) => { if (live) setShown(data.dataUrl); }).catch((failure) => {
          previewCache.delete(src);
          if (live) setError(/unknown.*action|unrecognised.*action/iu.test(String(failure?.message ?? failure)) ? '请从托盘退出 DSH 后重新打开，以加载图片预览修复' : String(failure?.message ?? failure));
        });
        return () => { live = false; };
      }, [src]);
      if (error) return h('span', { style: { ...props.style, display: 'inline-flex', fontSize: '10px', overflow: 'auto' }, title: error, role: 'alert' }, `图片加载失败：${error}`);
      return h('img', { ...props, src: shown ?? undefined, onError: () => setError('图片文件无法解码，请检查原图或重新导入'), 'data-dsh-preview': shown ? 'loaded' : 'loading' });
    }

    /**
     * Video via the authenticated panel channel.
     *
     * A raw `/short-drama/media/<handle>` URL works in a normal browser, but the desktop renderer
     * does not always have the same origin/cookie as that route. `media-preview` already returns a
     * bounded data URL for moving media, so use it here instead of leaving a player pointed at a
     * source it may never be allowed to fetch.
     */
    function PreviewVideo({ src, fallbackLabel = '视频', ...props }) {
      const [shown, setShown] = React.useState(src ?? null);
      const [error, setError] = React.useState('');
      const fallbackTried = React.useRef(false);
      React.useEffect(() => {
        fallbackTried.current = false;
        setShown(src ?? null);
        setError('');
      }, [src]);
      /**
       * A data URL is a useful fallback, but Chromium's media pipeline rejects some large
       * data: sources even when the decoded MP4 is valid. Try the same-origin ranged media
       * route first; only fetch the bounded data URL when that route cannot be loaded.
       */
      const handleMediaError = () => {
        const load = previewLoaders.get(src);
        if (load === undefined || fallbackTried.current) {
          setError('视频文件无法解码，请检查编码格式或改用 MP4/H.264');
          return;
        }
        fallbackTried.current = true;
        let pending = videoPreviewCache.get(src);
        if (pending === undefined) {
          pending = load();
          videoPreviewCache.set(src, pending);
          if (videoPreviewCache.size > 8) videoPreviewCache.delete(videoPreviewCache.keys().next().value);
        }
        pending.then((data) => {
          if (typeof data?.dataUrl === 'string' && data.dataUrl.length > 0) setShown(data.dataUrl);
          else setError('媒体通道没有返回可播放的视频');
        }).catch((failure) => {
          videoPreviewCache.delete(src);
          setError(String(failure?.message ?? failure));
        });
      };
      if (error.length > 0) {
        return h('div', { style: css.error, role: 'alert' }, `${fallbackLabel}加载失败：${error}`);
      }
      return h('video', {
        ...props,
        src: shown ?? undefined,
        controls: props.controls !== false,
        preload: 'metadata',
        playsInline: true,
        onError: handleMediaError,
        'data-dsh-video-preview': shown ? 'loaded' : 'loading',
      });
    }

    /**
     * Audio through the same authenticated panel channel as image/video previews.
     *
     * A bare `/short-drama/media/<handle>` source works in the web panel but can fail in the
     * desktop renderer, where the media element may not share the route's origin/cookie. Voice
     * audition therefore has to use `media-preview`, like PreviewImage and PreviewVideo.
     */
    function PreviewAudio({ src, fallbackLabel = '音频', ...props }) {
      const [shown, setShown] = React.useState(null);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        let live = true;
        setShown(null);
        setError('');
        const load = previewLoaders.get(src);
        if (load === undefined) {
          setShown(src);
          return undefined;
        }
        let pending = audioPreviewCache.get(src);
        if (pending === undefined) {
          pending = load();
          audioPreviewCache.set(src, pending);
          if (audioPreviewCache.size > 16) audioPreviewCache.delete(audioPreviewCache.keys().next().value);
        }
        pending.then((data) => {
          if (live) setShown(data?.dataUrl ?? null);
        }).catch((failure) => {
          audioPreviewCache.delete(src);
          if (live) setError(String(failure?.message ?? failure));
        });
        return () => { live = false; };
      }, [src]);
      if (error.length > 0) {
        return h('div', { style: css.error, role: 'alert' }, `${fallbackLabel}加载失败：${error}`);
      }
      return h('audio', {
        ...props,
        src: shown ?? undefined,
        controls: true,
        preload: 'metadata',
        'data-dsh-audio-preview': shown ? 'loaded' : 'loading',
        onError: () => setError('音频文件无法解码，请改用 MP3/WAV 后重新上传'),
      });
    }

    /**
     * How many candidates may be compared at once.
     *
     * Three, not two: "which of these" very often has a third option - a regeneration that fixed
     * one thing, or the version already in use - and making the user leave a two-up comparison to
     * fetch it loses the look they were in the middle of. Not more than three, because a fourth
     * pane makes every one of them too small to judge, which defeats the comparison.
     */
    const COMPARE_LIMIT = 3;
    const displayShotText = (value) => String(value ?? '').replace(/大分镜/gu, '分镜');

    const COPY = {
      zh: {
        'entry.label': '创作台',
        'pick.folder': '项目位置',
        'pick.choose': '选择目录…',
        'pick.close': '收起',
        'pick.up': '上一层',
        'pick.useThis': '就用这个目录',
        'pick.isProject': '项目',
        'pick.none': '这个目录下没有子目录。',
        'pick.workspace': '工作区',
        'pick.root': '当前目录：',
        'pick.project': '选择项目',
        'pick.episode': '选择集数',
        'pick.source': '提示词版本',
        'mode.drama': '短剧模式',
        'mode.general': '通用模式',
        'mode.unknown': '模式未确认',
        'mode.dramaHint': '分镜、资产与导演对话共用当前项目和生成配置。',
        'mode.generalHint': '通用生成、项目浏览和资产查看可用；已有分镜的 H3 同步与重新拆分需进入短剧模式。',
        'mode.enter': '进入短剧模式',
        'mode.exit': '回到通用模式',
        'mode.switching': '切换中…',
        'mode.required': '这项操作属于短剧制作导演流程，请先进入短剧模式。',
        'mode.locked': '先进入短剧模式',
        'mode.projectSynced': '当前项目',
        'empty.projects': '这个目录里没有短剧项目。项目需要包含「剧集/第N集」；用上面的「选择目录…」换一个位置。',
        'empty.episodes': '这个项目里没有找到集数目录。',
        'empty.shots': '这个文件里没有「分镜 N」小节，整份内容显示在一块里。',
  // The file changed outside the panel. The Host reconciles identities against the new
  // content on every read, so this is informational, not an error: nothing was lost, but
  // the user should confirm the shot correspondence before generating from it.
  'drift': '⚠ 此文件在面板之外被改过，区块身份已按新内容重新对齐；生成前请确认镜头对应关系。',
        'loading': '读取中…',
        'save': '保存',
        'saving': '保存中…',
        'saved': '已保存',
        'unchanged': '没有改动',
        'revert': '撤销改动',
        'draft.restored': '⚠ 这段文字是从草稿恢复的，还没保存到文件',
        'draft.conflict': '⚠ 文件在你看这份草稿期间被改过。两边都没有丢，请选一个：',
        'draft.conflictDisk': '文件里现在是',
        'draft.conflictMine': '你草稿里是',
        'draft.useDisk': '用文件里的（丢弃草稿）',
        'draft.keepMine': '留我的草稿',
        'draft.keepBoth': '两个都留（拼在一起）',
        'draft.tookDisk': '已改用文件内容，草稿已丢弃',
        'draft.keptMine': '保留草稿；保存时会覆盖文件',
        'draft.keptBoth': '已拼在一起，请自行取舍后保存',
        'draft.conflictMarker': '===== 以下是文件里原来的内容 =====',
        'retry': '重试',
        'dirty': '有未保存的改动',
        'copy': '复制',
        'copyHint': '在本分镜下新增一个提示词与资产绑定相同的分镜（不复制生成视频）',
        'add': '添加',
        'addHint': '在本分镜下新增一个无资产、无提示词的空白分镜',
        'shots': '个分镜',
        'seconds': '秒',
        'error.noSession': '这个面板需要一个会话才能读取工作区文件。',
        'error.noCommand': '宿主没有暴露 storyboard 命令，面板读不到文件。',
        'error.unreadable': '无法读取这个目录，请检查目录是否存在及访问权限。',
        'warn.truncated': '目录太多，扫描达到上限——列表可能不全。',

        // ── tabs ──
        'view.generate': '通用生成',
        'view.script': '分镜',
        'view.assets': '资产',
        'view.results': '结果',
        'view.jobs': '任务',
        'view.config': '全局配置',

        // ── results ──
        'results.refresh': '刷新',
        'results.loading': '读取候选中…',
        'results.empty': '还没有生成结果',
        'results.stats': '个候选',
        'results.unreviewed': '未审',
        'results.selected': '已选用',
        'results.superseded': '已让位',
        'results.filter.all': '全部',
        'results.filter.unreviewed': '只看未审',
        'results.select': '选用此版本',
        'results.selecting': '选用中…',
        'results.promote': '存到本集',
        'results.promoting': '存到本集中…',
        'results.promoted': '已存到本集',
        'results.prune': '清理未选用的',
        'results.pruned': '已清理',
        'results.pruneHint': '只删从未选用的候选。已选用和已存入的一律不碰。',
        'results.needSelect': '这条候选没有记录集数/分镜号，存不了本集；请用下面的「存入哪里」指定路径。',
        'results.duplicate': '与已有候选同内容',
        'results.play': '播放',
        'results.destination': '存入哪里（可选）',
        'results.destinationHint': '留空则存到 剧集/第N集/成片/<代号>_<集>_<块>(<k>)。要换位置时才填，相对项目根。',
        'results.needDestination': '这条候选没有记录集数/分镜号，无法自动存到本集；请填写存入路径。',
        'results.shot': '分镜',
        // The two facts, stated where the decision is made. A finished generation is not a
        // decision, and a panel that blurs them is what lets an unreviewed file become the
        // version in use.
        'results.twoFacts': '生成完成 ≠ 审片通过：这些还没人看过，没有任何东西在用它们。',

        // ── side-by-side comparison ──
        'results.compare': '并排对比',
        'results.compareExit': '退出对比',
        'results.compareHint': '点两张（最多三张）卡片选进对比。同类型才能并排——图和视频放一起看不出差别。',
        'results.comparePick': '选进对比',
        'results.compareChosen': '对比中',
        'results.compareFull': '对比已满，先取消一张',
        'results.compareMixed': '只能同类型对比：这两张一个是图一个是视频。',
        'results.compareClear': '清空',
        'results.compareOpen': '开始对比',
        'results.compareBackToGrid': '回到候选列表',
        'results.compareTitle': '并排对比',
        'results.redo': '重做这一张',
        'results.redoing': '读取输入中…',
        'results.redoReady': '已取回这一张的原始输入。让导演按这些输入再跑一次即可 —— 我不会替你启动 GPU。',

        // ── assets ──
        'assets.refresh': '重新扫描',
        'assets.scanning': '扫描中…',
        'assets.filter': '筛选',
        'assets.all': '全部',
        'assets.character': '人物',
        'assets.scene': '场景',
        'assets.prop': '道具',
        'assets.search': '按名字找…',
        'assets.empty': '还没有扫描过资产。点「重新扫描」从项目目录里认一遍人物、场景和道具。',
        'assets.none': '没有匹配的资产。',
        'assets.variants': '变体',
        'assets.versions': '版本',
        'assets.missing': '个文件已不在磁盘上',
        'assets.historical': '集内旧版',
        'assets.detail': '详情',
        'assets.back': '返回列表',
        'assets.noThumb': '无图',
        'assets.newVersions': '新增版本',
        'assets.superseded': '被替换',
        'assets.problems': '提示',
        'assets.scanned': '扫描完成',
        'assets.dryRun': '试算，未写入',

        // ── references ──
        'ref.title': '这一块的引用',
        'ref.none': '这一块还没有 @ 引用。在正文里输入 @ 可以选资产。',
        'ref.loading': '解析引用中…',
        'ref.refreshing': '更新中…',
        'ref.resolved': '已绑定',
        'ref.noPreview': '无预览',
        'ref.needsReview': '待复核',
        'ref.pinned': '已钉住',
        'ref.pin': '钉住当前版本',
        'ref.unpin': '取消钉住',
        'ref.uses': '处',
        'ref.inputs': '个输入文件',
        'ref.unresolved': '找不到这个资产',
        'ref.ambiguous': '有多个可能',
        'ref.pick': '选一个',
        'ref.blocked': '引用没解析完，不能生成：会绑到错的输入上。',
        'ref.blockedShort': '先修引用',
        'ref.changed': '引用与正文不一致，需要复核',
        'ref.versionGone': '绑定的文件版本不在了',
        'ref.moved': '引用位置变了，已重新对齐',

        // ── mention picker ──
        'at.hint': '输入 @ 选资产',
        'at.none': '没有匹配的资产',
        'at.insert': '插入引用',

        // ── jobs ──
        'jobs.refresh': '刷新任务与结果',
        'jobs.empty': '还没有生成任务。',
        'jobs.state': '状态',
        'jobs.shot': '分镜',
        'jobs.inputs': '输入',
        'jobs.saved': '已保存文件',
        'jobs.trail': '过程',
        'jobs.unknown': '提交结果未确认',
        'jobs.unknownHint': '这一条的结果无法从这里判断：实例上可能正在生成。先查实例队列，不要直接重投——重投可能让工作量翻倍。',
        'jobs.downloadFailed': '下载失败',
        'jobs.downloadFailedHint': '生成已经完成，字节还在实例上，只是本地没有。重试下载即可，不要重跑模型。',
        'jobs.corrupt': '这一条台账记录读不出来',
        'jobs.state.intent': '准备提交',
        'jobs.state.submitting': '提交中',
        'jobs.state.submission_unknown': '提交结果未确认',
        'jobs.state.queued': '排队中',
        'jobs.state.running': '生成中',
        'jobs.state.completed': '实例已完成',
        'jobs.state.downloading': '下载中',
        'jobs.state.download_failed': '下载失败',
        'jobs.state.saved': '已保存',
        'jobs.state.failed': '失败',
        'jobs.state.cancelled': '已取消',
      },
      en: {
        'entry.label': 'Creator Workspace',
        'pick.folder': 'Projects in',
        'pick.choose': 'Choose folder…',
        'pick.close': 'Close',
        'pick.up': 'Up',
        'pick.useThis': 'Use this folder',
        'pick.isProject': 'project',
        'pick.none': 'No subfolders here.',
        'pick.root': 'Folder: ',
        'pick.project': 'Project',
        'pick.episode': 'Episode',
        'pick.source': 'Prompt',
        'mode.drama': 'Drama mode',
        'mode.general': 'General mode',
        'mode.unknown': 'Mode unknown',
        'mode.dramaHint': 'Storyboard, assets and the director share this project and generation settings.',
        'mode.generalHint': 'General generation, project browsing and assets work here; H3 sync and re-split of existing shots require drama mode.',
        'mode.enter': 'Enter drama mode',
        'mode.exit': 'Return to general mode',
        'mode.switching': 'Switching…',
        'mode.required': 'This operation belongs to the short-drama director workflow. Enter drama mode first.',
        'mode.locked': 'Enter drama mode first',
        'mode.projectSynced': 'Current project',
        'empty.projects': 'No short-drama project in this folder. A project contains 「剧集/第N集」 — use "Choose folder…" to look somewhere else.',
        'empty.episodes': 'No episode folder found in this project.',
        'empty.shots': 'This file has no 「分镜 N」 section, so its whole content is shown as one block.',
        'drift': '⚠ This file was changed outside the panel. Block identities were realigned against the new content; confirm the shot correspondence before generating.',
        'loading': 'Loading…',
        'save': 'Save',
        'saving': 'Saving…',
        'saved': 'Saved',
        'unchanged': 'No change',
        'revert': 'Revert',
        'draft.restored': '⚠ This text was restored from a draft and is not saved to the file',
        'draft.conflict': '⚠ The file changed while you had this draft open. Nothing was lost - choose one:',
        'draft.conflictDisk': 'The file now says',
        'draft.conflictMine': 'Your draft says',
        'draft.useDisk': 'Use the file (discard my draft)',
        'draft.keepMine': 'Keep my draft',
        'draft.keepBoth': 'Keep both (joined together)',
        'draft.tookDisk': 'Using the file; the draft was discarded',
        'draft.keptMine': 'Draft kept; saving will overwrite the file',
        'draft.keptBoth': 'Joined together - edit down and save',
        'draft.conflictMarker': '===== the file said this =====',
        'retry': 'Retry',
        'dirty': 'Unsaved changes',
        'copy': 'Copy',
        'copyHint': 'Add a block below this one with the same prompt and asset bindings (no generated video)',
        'add': 'Add',
        'addHint': 'Add a block below this one with no assets or prompt text',
        'shots': 'shots',
        'seconds': 's',
        'error.noSession': 'This panel needs a session before it can read workspace files.',
        'error.noCommand': 'The Host does not expose the storyboard command, so the panel cannot read files.',
        'error.unreadable': 'Cannot read this folder. Check that it exists and that you have access.',
        'warn.truncated': 'Too many folders — the scan hit its budget, so the list may be incomplete.',

        // ── tabs ──
        'view.generate': 'Generate',
        'view.script': 'Shots',
        'view.assets': 'Assets',
        'view.results': 'Results',
        'view.jobs': 'Jobs',
        'view.config': 'Global config',

        // ── results ──
        'results.refresh': 'Refresh',
        'results.loading': 'Reading candidates…',
        'results.empty': 'No generated results yet.',
        'results.stats': 'candidate(s)',
        'results.unreviewed': 'unreviewed',
        'results.selected': 'selected',
        'results.superseded': 'superseded',
        'results.filter.all': 'All',
        'results.filter.unreviewed': 'Unreviewed only',
        'results.select': 'Use this version',
        'results.selecting': 'Selecting…',
        'results.promote': 'Save to this episode',
        'results.promoting': 'Saving…',
        'results.promoted': 'saved',
        'results.prune': 'Prune the unreviewed',
        'results.pruned': 'pruned',
        'results.pruneHint': 'Only candidates that were never selected are deleted. Selected and copied ones are never touched.',
        'results.needSelect': 'This candidate has no recorded episode/block, so it cannot be saved to an episode. Use the destination field below.',
        'results.duplicate': 'same content as an existing candidate',
        'results.play': 'Play',
        'results.destination': 'Copy to',
        'results.destinationHint': 'relative to the project root, e.g. 资产/人物资产/林晚（女主）/林晚.png',
        'results.needDestination': 'This candidate has no recorded episode/block; fill in a destination.',
        'results.shot': 'shot',
        'results.twoFacts': 'Finished is not approved: nobody has looked at these, and nothing is using them.',

        // ── side-by-side comparison ──
        'results.compare': 'Compare',
        'results.compareExit': 'Exit compare',
        'results.compareHint': 'Click two cards (up to three) to compare them. Same media type only — an image beside a video shows nothing.',
        'results.comparePick': 'Add to compare',
        'results.compareChosen': 'comparing',
        'results.compareFull': 'Compare is full — drop one first',
        'results.compareMixed': 'Same type only: one of these is an image and the other a video.',
        'results.compareClear': 'Clear',
        'results.compareOpen': 'open the comparison',
        'results.compareBackToGrid': 'Back to the candidates',
        'results.compareTitle': 'Side by side',
        'results.redo': 'Redo this one',
        'results.redoing': 'Reading its inputs…',
        'results.redoReady': 'Recovered the exact inputs this image was made from. Ask the director to run again with them — this panel does not start a GPU job on its own.',

        // ── assets ──
        'assets.refresh': 'Rescan',
        'assets.scanning': 'Scanning…',
        'assets.filter': 'Filter',
        'assets.all': 'All',
        'assets.character': 'Character',
        'assets.scene': 'Scene',
        'assets.prop': 'Prop',
        'assets.search': 'Find by name…',
        'assets.empty': 'No asset has been scanned yet. Press Rescan to recognise the characters, scenes and props in the project folder.',
        'assets.none': 'No asset matches.',
        'assets.variants': 'variants',
        'assets.versions': 'versions',
        'assets.missing': 'file(s) are no longer on disk',
        'assets.historical': 'episode copy',
        'assets.detail': 'Detail',
        'assets.back': 'Back to list',
        'assets.noThumb': 'no image',
        'assets.newVersions': 'new',
        'assets.superseded': 'superseded',
        'assets.problems': 'Notes',
        'assets.scanned': 'Scan complete',
        'assets.dryRun': 'dry run, nothing written',

        // ── references ──
        'ref.title': 'References in this block',
        'ref.none': 'This block has no @ reference yet. Type @ in the body to pick an asset.',
        'ref.loading': 'Resolving references…',
        'ref.refreshing': 'updating…',
        'ref.resolved': 'bound',
        'ref.needsReview': 'needs review',
        'ref.pinned': 'pinned',
        'ref.pin': 'Pin this version',
        'ref.unpin': 'Unpin',
        'ref.uses': 'use(s)',
        'ref.inputs': 'input file(s)',
        'ref.unresolved': 'no such asset',
        'ref.ambiguous': 'more than one reading',
        'ref.pick': 'Pick one',
        'ref.blocked': 'A reference did not resolve, so this cannot be generated: it would bind to the wrong input.',
        'ref.blockedShort': 'Fix references first',
        'ref.changed': 'The reference no longer matches the text and needs review',
        'ref.versionGone': 'the bound file version is gone',
        'ref.moved': 'The reference moved and was realigned',

        // ── mention picker ──
        'at.hint': 'Type @ to pick an asset',
        'at.none': 'No asset matches',
        'at.insert': 'Insert reference',

        // ── jobs ──
        'jobs.refresh': 'Refresh jobs & results',
        'jobs.empty': 'No generation job yet.',
        'jobs.state': 'State',
        'jobs.shot': 'Shot',
        'jobs.inputs': 'Inputs',
        'jobs.saved': 'Saved files',
        'jobs.trail': 'Trail',
        'jobs.unknown': 'Submission not confirmed',
        'jobs.unknownHint': 'The outcome cannot be known from here: the instance may be generating right now. Check the instance queue first and do not resubmit — resubmitting could double the work.',
        'jobs.downloadFailed': 'Download failed',
        'jobs.downloadFailedHint': 'The generation finished and the bytes are still on the instance; only the local copy is missing. Retry the download, do not re-run the model.',
        'jobs.corrupt': 'This ledger entry cannot be read',
        'jobs.state.intent': 'Intent',
        'jobs.state.submitting': 'Submitting',
        'jobs.state.submission_unknown': 'Submission not confirmed',
        'jobs.state.queued': 'Queued',
        'jobs.state.running': 'Generating',
        'jobs.state.completed': 'Instance finished',
        'jobs.state.downloading': 'Downloading',
        'jobs.state.download_failed': 'Download failed',
        'jobs.state.saved': 'Saved',
        'jobs.state.failed': 'Failed',
        'jobs.state.cancelled': 'Cancelled',
      },
    };

    /** Minimal inline styles built from theme tokens, so the panel follows the theme. */
    const css = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
        gap: '8px',
        padding: '10px',
        color: 'var(--dsw-text-primary, inherit)',
        fontSize: '13px',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      label: {
        flexShrink: 0,
        color: 'var(--dsw-text-secondary, #687385)',
        fontSize: '11px',
        fontWeight: 600,
      },
      select: {
        flex: '1 1 120px',
        minWidth: '96px',
        height: '32px',
        padding: '0 9px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-border-strong, #8793a3)',
        background: 'var(--dsw-surface-raised, #ffffff)',
        color: 'inherit',
        fontSize: '12px',
      },
      sources: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      sourceButton: (active) => ({
        minHeight: '28px',
        padding: '0 10px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '12px',
        border: `1px solid ${active ? 'var(--dsw-border-strong, #8793a3)' : 'var(--dsw-border-default, #cbd4e0)'}`,
        background: active ? 'var(--dsw-surface-raised, #ffffff)' : 'color-mix(in srgb, var(--dsw-surface-raised, #fff) 72%, transparent)',
        color: 'inherit',
      }),
      list: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        flexShrink: 0,
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        borderRadius: '8px',
        overflow: 'hidden',
        background: 'var(--dsw-surface-raised, #ffffff)',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '9px 11px',
        cursor: 'pointer',
        userSelect: 'none',
      },
      caret: { width: '12px', opacity: 0.48, flexShrink: 0, fontSize: '11px' },
      cardTitle: {
        fontWeight: 650,
        fontSize: '13px',
        flexShrink: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      /** Director review + the two structural actions, pushed to the end of the header. */
      headActions: { display: 'flex', gap: '5px', marginLeft: 'auto', flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
      miniButton: {
        minHeight: '26px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-border-strong, #8793a3)',
        background: 'color-mix(in srgb, var(--dsw-surface-raised, #fff) 94%, var(--dsw-border-default, #cbd4e0))',
        color: 'inherit',
        boxShadow: '0 1px 2px rgba(15,23,42,.09), inset 0 1px 0 rgba(255,255,255,.62)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
        fontWeight: 550,
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '240px',
        resize: 'vertical',
        padding: '13px 15px',
        border: 'none',
        background: 'var(--dsw-surface-raised, #ffffff)',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.7,
        outline: 'none',
      },
      cardFoot: {
        display: 'flex',
        gap: '7px',
        alignItems: 'center',
        padding: '7px 11px',
        borderTop: '1px solid var(--dsw-border-default, #e1e5ea)',
      },
      button: (primary) => ({
        minHeight: '32px',
        padding: '0 12px',
        borderRadius: '7px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: primary ? 600 : 550,
        border: `1px solid ${primary ? 'var(--dsw-accent-default, #2f6fed)' : 'var(--dsw-border-strong, #8793a3)'}`,
        background: primary
          ? 'var(--dsw-accent-default, #2f6fed)'
          : 'color-mix(in srgb, var(--dsw-surface-raised, #fff) 94%, var(--dsw-border-default, #cbd4e0))',
        color: primary ? 'var(--dsw-accent-on, #fff)' : 'inherit',
        boxShadow: primary
          ? '0 1px 2px rgba(16,24,40,.12)'
          : '0 1px 2px rgba(15,23,42,.09), inset 0 1px 0 rgba(255,255,255,.62)',
      }),
      note: { color: 'var(--dsw-text-secondary, #687385)', fontSize: '11.5px', lineHeight: 1.5 },
      // A caution row, not an error: nothing failed, the file simply is not where the panel
      // last saw it. Styled as a warning so it reads differently from a real failure.
      drift: {
        fontSize: '11.5px',
        lineHeight: 1.55,
        padding: '8px 10px',
        borderRadius: '7px',
        border: '1px solid rgba(183,121,31,.25)',
        background: 'rgba(214,158,46,0.10)',
      },

      // ── tabs ──
      tabs: {
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        padding: '0 2px',
        borderBottom: '1px solid var(--dsw-border-default, #e1e5ea)',
      },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--dsw-accent-default, #2f6fed)' : 'transparent'}`,
        background: active ? 'var(--dsw-surface-subtle, #f7f8fa)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: active ? 600 : 500,
        padding: '0 11px',
        opacity: active ? 1 : 0.66,
      }),
      tabBadge: {
        marginLeft: '4px',
        fontSize: '10px',
        fontWeight: 650,
        padding: '1px 5px',
        borderRadius: '999px',
        background: 'rgba(183,121,31,.13)',
        color: 'var(--dsw-warning-default, #9a6700)',
      },

      // ── episode production strip ──
      productionBar: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 11px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        borderRadius: '8px',
        background: 'var(--dsw-surface-subtle, #f7f8fa)',
      },
      productionHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      productionNext: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        fontSize: '11.5px',
        lineHeight: 1.5,
      },
      productionChip: (state, active) => ({
        appearance: 'none',
        border: `1px solid ${active ? (SHOT_STATE_COLORS[state] ?? 'var(--dsw-accent, #4b8bf5)') : 'var(--dsw-border-default, #d0d5dd)'}`,
        borderRadius: '999px',
        background: active ? `${SHOT_STATE_COLORS[state] ?? '#4b8bf5'}20` : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '10.5px',
        fontWeight: active ? 600 : 500,
        height: '24px',
        padding: '0 9px',
      }),
      productionTag: (state) => ({
        flexShrink: 0,
        fontSize: '10px',
        lineHeight: '19px',
        padding: '0 7px',
        borderRadius: '999px',
        color: SHOT_STATE_COLORS[state] ?? 'inherit',
        background: `${SHOT_STATE_COLORS[state] ?? '#777777'}18`,
        border: `1px solid ${SHOT_STATE_COLORS[state] ?? '#777777'}55`,
      }),
      productionReason: {
        padding: '7px 11px',
        fontSize: '11px',
        lineHeight: 1.5,
        borderTop: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-subtle, #f7f8fa)',
      },

      // ── assets ──
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(188px, 1fr))', gap: '14px' },
      assetCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '7px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-raised, #ffffff)',
        cursor: 'pointer',
        overflow: 'hidden',
      },
      assetThumb: {
        width: '100%',
        aspectRatio: '1 / 1',
        objectFit: 'cover',
        borderRadius: '6px',
        background: 'rgba(127,127,127,0.14)',
        display: 'block',
      },
      assetThumbEmpty: {
        width: '100%',
        aspectRatio: '1 / 1',
        borderRadius: '6px',
        background: 'var(--dsw-surface-subtle, rgba(127,127,127,0.08))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        opacity: 0.6,
      },
      assetName: { fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      assetMeta: { fontSize: '10.5px', color: 'var(--dsw-text-secondary, #687385)', lineHeight: 1.45 },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      chip: (active) => ({
        appearance: 'none',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
        fontWeight: active ? 600 : 500,
        height: '26px',
        padding: '0 9px',
        borderRadius: '999px',
        border: `1px solid ${active ? 'var(--dsw-accent-default, #2f6fed)' : 'var(--dsw-border-default, #e1e5ea)'}`,
        background: active ? 'var(--dsw-accent-subtle, rgba(47,111,237,.10))' : 'var(--dsw-surface-raised, #ffffff)',
        color: active ? 'var(--dsw-accent-default, #2f6fed)' : 'inherit',
      }),
      // A version strip: one row per variant, oldest first, so a regeneration reads as a NEW
      // entry rather than as a replacement of what was there before.
      versionRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', flexWrap: 'wrap' },
      versionTag: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-surface-subtle, rgba(127,127,127,0.10))',
        color: 'var(--dsw-text-secondary, #687385)',
        fontVariantNumeric: 'tabular-nums',
      },
      versionGone: { opacity: 0.5, textDecoration: 'line-through' },
      detailImage: { width: '100%', borderRadius: '7px', display: 'block', background: 'rgba(127,127,127,0.10)' },

      // ── mention picker ──
      // Anchored under the editor rather than at the caret: a caret-anchored popup needs the
      // textarea's scroll offset and font metrics, and getting that subtly wrong puts the list
      // in the wrong place. A visible, honest panel beats precise placement that misfires.
      mentionBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        maxHeight: '220px',
        overflowY: 'auto',
        padding: '5px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-raised, #ffffff)',
        boxShadow: '0 10px 26px rgba(16,24,40,.14)',
        zIndex: 10000,
      },
      mentionRow: (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minHeight: '40px',
        padding: '4px 7px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '12px',
        background: active ? 'rgba(127,127,127,0.22)' : 'transparent',
      }),
      mentionThumb: { width: '34px', height: '34px', objectFit: 'cover', borderRadius: '4px', flex: '0 0 auto' },

      // ── references ──
      refBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-subtle, rgba(127,127,127,0.06))',
        fontSize: '12px',
      },
      refRow: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' },
      refIndex: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-text-secondary, #687385)', minWidth: '14px' },
      // A blocked reference is the one thing that must not be missable: generating from it
      // would bind the wrong input, so it gets a colour of its own rather than a footnote.
      refBlocked: {
        fontSize: '11.5px',
        lineHeight: 1.5,
        padding: '7px 9px',
        borderRadius: '7px',
        border: '1px solid rgba(180,35,24,.20)',
        background: 'rgba(180,35,24,.08)',
      },
      stateTag: (state) => ({
        fontSize: '10px',
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: '999px',
        background: state === 'resolved'
          ? 'color-mix(in srgb, var(--sdd-success) 10%, var(--sdd-surface))'
          : 'color-mix(in srgb, var(--sdd-warning) 12%, var(--sdd-surface))',
        color: state === 'resolved' ? 'var(--sdd-success)' : 'var(--sdd-warning)',
      }),

      // ── jobs ──
      jobCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-raised, #ffffff)',
        fontSize: '12px',
      },
      jobHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      jobId: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', opacity: 0.7 },
      jobTrail: { display: 'flex', flexWrap: 'wrap', gap: '3px', alignItems: 'center' },
      jobStep: { fontSize: '10px', padding: '1px 5px', borderRadius: '999px', background: 'var(--dsw-surface-subtle, rgba(127,127,127,.10))' },
      jobWarn: {
        fontSize: '11.5px',
        lineHeight: 1.55,
        padding: '8px 9px',
        borderRadius: '7px',
        border: '1px solid rgba(180,35,24,.18)',
        background: 'rgba(180,35,24,.07)',
      },

      // ── results ──
      resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(138px, 1fr))', gap: '10px' },
      resultCard: (status) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '7px',
        borderRadius: '8px',
        // The border is what carries "chosen" at a glance. A selected result has to be findable
        // in a wall of twenty attempts without reading any of them.
        border: `1px solid ${status === 'selected' ? 'var(--dsw-accent-default, #2f6fed)' : 'var(--dsw-border-default, #e1e5ea)'}`,
        boxShadow: status === 'selected' ? 'inset 0 0 0 1px var(--dsw-accent-default, #2f6fed)' : 'none',
        background: status === 'selected' ? 'var(--dsw-accent-subtle, rgba(47,111,237,.08))' : 'var(--dsw-surface-raised, #ffffff)',
        opacity: status === 'superseded' ? 0.6 : 1,
        overflow: 'hidden',
      }),
      resultMedia: {
        width: '100%',
        aspectRatio: '1 / 1',
        objectFit: 'contain',
        borderRadius: '4px',
        background: 'rgba(127,127,127,0.14)',
        display: 'block',
      },
      // The clickable area that puts a candidate into the comparison. Cursor and a hover outline
      // are what tell a user this is a gesture rather than a decoration; without them the card
      // looks inert and the only way to compare appears to be missing.
      resultMediaHit: {
        display: 'block',
        cursor: 'pointer',
        borderRadius: '4px',
        outline: '1px solid transparent',
      },
      resultMeta: { fontSize: '10.5px', color: 'var(--dsw-text-secondary, #687385)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      resultActions: { display: 'flex', gap: '5px', flexWrap: 'wrap' },
      resultNote: {
        fontSize: '11.5px',
        lineHeight: 1.55,
        padding: '8px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-subtle, rgba(127,127,127,.06))',
      },

      // ── side-by-side comparison ──
      // Two up, never more: the question a comparison answers is "which of these two", and a
      // third pane makes each one too small to answer it.
      // The column count follows the pane count, so a third pane makes each narrower rather than
      // wrapping onto a second row where it could not be compared with the others at a glance.
      // Big enough to tell two versions of one character apart, which is the whole reason it is
      // here; small enough that five references do not push the prompt off the screen.
      refThumb: { width: '44px', height: '58px', objectFit: 'cover', borderRadius: '3px', flex: '0 0 auto', background: '#1b1b1f' },
      refThumbEmpty: { width: '44px', height: '58px', borderRadius: '3px', flex: '0 0 auto', background: '#1b1b1f', color: '#6a6a72', fontSize: '9px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' },
      compareGrid: (columns) => ({ display: 'grid', gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gap: '8px' }),
      comparePane: (chosen) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        borderRadius: '8px',
        border: `1px solid ${chosen ? 'var(--dsw-accent-default, #2f6fed)' : 'var(--dsw-border-default, #e1e5ea)'}`,
        background: 'var(--dsw-surface-raised, #ffffff)',
        overflow: 'hidden',
        cursor: 'pointer',
      }),
      compareMedia: {
        width: '100%',
        maxHeight: '46vh',
        objectFit: 'contain',
        borderRadius: '4px',
        background: 'rgba(127,127,127,0.14)',
        display: 'block',
      },
      // A picked card has to be distinguishable in a grid of twenty without reading anything.
      pickedBadge: { fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '999px', background: 'var(--dsw-accent-subtle, rgba(47,111,237,.12))', color: 'var(--dsw-accent-default, #2f6fed)' },
      picker: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-border-default, #e1e5ea)',
        background: 'var(--dsw-surface-raised, #ffffff)',
      },
      pickerBar: { display: 'flex', alignItems: 'center', gap: '6px' },
      pickerPath: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        opacity: 0.75,
        direction: 'rtl',
        textAlign: 'left',
      },
      pickerList: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '220px', overflowY: 'auto' },
      pickerRow: (isProject) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        borderRadius: '6px',
        background: isProject ? 'var(--dsw-accent-subtle, rgba(75,139,245,0.12))' : 'transparent',
      }),
      pickerName: {
        flex: '1 1 auto',
        textAlign: 'left',
        padding: '6px 7px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pickerTag: { flex: '0 0 auto', fontSize: '10px', opacity: 0.6, paddingRight: '6px' },
      error: {
        padding: '8px 10px',
        borderRadius: '7px',
        border: '1px solid rgba(180,35,24,.20)',
        background: 'rgba(180,35,24,.06)',
        color: 'var(--dsw-danger-default, #b42318)',
        fontSize: '11.5px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      },
    };

    /**
     * How the panel talks to the Host: the private route when it is there, the `/storyboard`
     * command when it is not.
     *
     * The command channel is a user-facing surface. `@deepseek-ai/dsh-commands` appends
     * `command/run` and `command/done` for every admitted line, and the Web client renders that
     * pair as a card in the conversation - so a panel that called the Host on mount, on every
     * tab switch and on every save wrote a card each time. A measured session held 180 of them.
     *
     * `/short-drama/panel` is the same actions on a channel that is private by construction.
     * The command stays as the fallback, because a deployment can legitimately have no web
     * server, and an older Host has no route at all.
     *
     * Which one is in use is decided ONCE per session by a GET probe: the route answers 405 (it
     * serves POST only), and an absent route answers 404 because nothing else claims the prefix.
     * Probing once is what keeps the fallback safe - a write that failed for any OTHER reason is
     * reported, never re-sent through the second channel, where its `expectedText` would describe
     * a file the first attempt had already changed.
     */
    const PANEL_PREFIX = '/short-drama/panel';
    /** Session ids whose transport is decided; the value is `true` for the route, `false` for the command. */
    const panelRouteBySession = new Map();
    const probePanelRoute = async (sessionId) => {
      if (panelRouteBySession.has(sessionId)) return panelRouteBySession.get(sessionId);
      let available = false;
      try {
        const response = await fetch(PANEL_PREFIX, { method: 'GET', credentials: 'same-origin' });
        // 405 is this route declining the method, which means it exists. Anything else - 404, a
        // 401 from the trust fence, an opaque failure - is not a promise that POST would work.
        available = response.status === 405;
      } catch {
        // No fetch, no route, or nothing listening: the command channel is the answer, and the
        // decision is deliberately NOT cached so a later call can still find the route.
        return false;
      }
      panelRouteBySession.set(sessionId, available);
      return available;
    };

    /** One panel request over the private route. Throws when the route reports a refusal. */
    const callPanelRoute = async (sessionId, action, payload, root) => {
      const body = { action, payload: payload ?? {}, sessionId };
      if (typeof root === 'string' && root.length > 0) body.root = root;
      const response = await fetch(PANEL_PREFIX, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 404 || response.status === 405) {
        // The route is gone after all; let the caller fall back.
        panelRouteBySession.set(sessionId, false);
        return undefined;
      }
      if (!response.ok) throw new Error(`the panel route answered ${String(response.status)}`);
      let parsed;
      try {
        parsed = await response.json();
      } catch {
        throw new Error('the panel route returned an invalid storyboard result');
      }
      // A refusal is a RESULT, not a transport failure: the route answers 200 with `error` so
      // that the panel can tell "the Host said no" from "this channel is not here" and never
      // re-sends a write that the Host already judged. The Host's own `errorCode` travels with
      // it, because "the sandbox refused this path" and "the save went wrong" call for different
      // answers and the sentence alone is what made them look alike.
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
        const failure = new Error(parsed.error);
        failure.hostRejected = true;
        if (typeof parsed.errorCode === 'string') failure.errorCode = parsed.errorCode;
        throw failure;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the panel route returned an invalid storyboard result');
      }
      return parsed;
    };

    /**
     * Run one storyboard action on the Host.
     *
     * Remote calls return RemoteResult<CommandExecution | undefined>. Unwrap that
     * envelope before reading the command's result; treating the envelope as the
     * execution hides both successful data and remote errors behind an empty list.
     */
    /**
     * One call to the Host, and the payload out of it.
     *
     * A command result carries ONLY `kind`, `text` and `sourceEventSeq` - the runtime rebuilds it field
     * by field (`normalizeResult`), so a `data` field would be dropped before the panel could see it.
     * The panel is a command caller, so the payload has to arrive in `text`.
     *
     * `text` is also what the conversation renders, and a hand-typed `/storyboard {...}` was printing
     * the entire structure into the transcript. The Host therefore answers with a one-line summary by
     * default and sends raw JSON only when the request says `debug: true`.
     *
     * The panel asks for `debug` on its FIRST call, never as a retry.
     *
     * That is not a style choice. An earlier version parsed `text` and, when that failed, repeated the
     * call with `debug`. For a read that costs one round trip; for a WRITE it means the same write is
     * sent TWICE, and the second one carries the `expectedText` / `expectedRevision` of a file the first
     * call already changed - so the Host correctly reports "nothing changed", and a save that in fact
     * succeeded looks like it did not. A machine caller should ask for the machine form once.
     *
     * The non-JSON path is kept for a Host older than this Client, which answers with a summary it
     * cannot parse; there the retry is the only way to get data, and an older Host has no `debug` to
     * misunderstand.
     */
    async function callHost(ctx, sessionId, action, payload, root, options = {}) {
      // The private route first. Its answers are already objects, so the parsing dance below only
      // runs on the command channel that a deployment without a web server falls back to.
      try {
        if (await probePanelRoute(sessionId)) {
          const direct = await callPanelRoute(sessionId, action, payload, root);
          if (direct !== undefined) return direct;
        }
      } catch (error) {
        // A refusal from the Host is the answer; it must not be retried on the other channel.
        if (error?.hostRejected === true) throw error;
        throw error;
      }
      const send = async (withDebug) => {
        const body = { action, payload: payload ?? {} };
        // A project does not have to live in the session's own workspace, so the panel
        // names the directory it is browsing whenever it knows one.
        if (typeof root === 'string' && root.length > 0) body.root = root;
        if (withDebug) body.debug = true;
        const line = `/${COMMAND} ${JSON.stringify(body)}`;
        const response = await ctx.remote.commands.execute(sessionId, line, []);
        if (response?.ok === false) {
          const error = response.error;
          throw new Error(`${error?.message ?? 'storyboard remote call failed'}${error?.code ? ` (${error.code})` : ''}`);
        }
        if (response?.ok !== true) throw new Error('the Host returned an invalid RemoteResult');
        const execution = response.value;
        if (execution === undefined) throw new Error(ctx.locale.bind(NS)('error.noCommand'));
        const result = execution?.result;
        if (result?.kind === 'error') {
          const error = new Error(String(result.text ?? 'unknown failure'));
          error.hostRejected = true;
          throw error;
        }
        if (result?.kind !== 'success') {
          throw new Error('the Host returned an invalid storyboard result');
        }
        return result;
      };

      // `undefined` means "this answer holds no payload"; a different value means it does. Only the
      // caller knows whether a second call is safe, so the decision is left to it via `options.retry`.
      const read = (result) => {
        if (result.data !== undefined && result.data !== null && typeof result.data === 'object') {
          return result.data;
        }
        if (typeof result.text !== 'string') {
          throw new Error('the Host returned an invalid storyboard result');
        }
        let data;
        try {
          data = JSON.parse(result.text);
        } catch {
          return undefined;
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('the Host returned an invalid storyboard result');
        }
        return data;
      };

      // Ask for the machine form straight away. `options.debug === false` opts out, which is how a
      // caller says it wants the human summary and will not need the object.
      const wantDebug = options.debug !== false;
      const first = read(await send(wantDebug));
      if (first !== undefined) return first;
      // The answer was a summary even though JSON was requested: an older Host. Safe to ask again only
      // when the caller says the action can be repeated - a write must not be.
      if (options.retry === false) {
        throw new Error('the Host answered with a summary and this call must not be repeated');
      }
      const second = read(await send(true));
      if (second !== undefined) return second;
      throw new Error('the Host returned something that is not JSON, even with debug');
    }

    /**
     * The episode's production answer, above the shot list.
     *
     * This is deliberately a status strip rather than a dashboard page: the user is already
     * looking at the prompts, and the useful question is "what blocks this episode, and where is
     * it?". Each count filters the list below; the next actionable shot is one click away.
     */
    function EpisodeProductionBar({ data, busy, error, filter, onFilter, onFocusShot, onRefresh }) {
      const counts = data?.counts ?? {};
      const total = Number.isInteger(data?.total) ? data.total : 0;
      const todoCount = (counts['missing-assets'] ?? 0) + (counts['needs-attention'] ?? 0) + (counts['awaiting-review'] ?? 0);
      const next = data?.next ?? null;
      const countFor = (id) => id === 'all' ? total : id === 'todo' ? todoCount : (counts[id] ?? 0);
      const nextLabel = next === null
        ? (total > 0 && (counts.decided ?? 0) === total ? '本集镜头都已选用' : '还没有可定位的镜头')
        : `${SHOT_STATE_LABELS[next.state] ?? next.state} · 分镜 ${String(next.blockNumber ?? next.displayNumber ?? '?')} · ${String(next.reason ?? '')}`;
      return h('section', {
        'data-dsh-production-bar': 'true',
        className: 'sdd-production',
        style: css.productionBar,
      },
        h('div', { style: css.productionHead },
          h('strong', { style: { fontSize: '11px' } }, '本集制作'),
          h('span', { 'data-dsh-production-summary': 'true', className: 'sdd-production-summary', style: { fontSize: '10px', opacity: 0.72 } },
            busy ? '正在核对进度…' : `${String(counts.decided ?? 0)} / ${String(total)} 个镜头已选用`),
          h('select', {
            'data-dsh-production-filter': 'true',
            'aria-label': '按制作状态筛选分镜',
            value: filter,
            onChange: (event) => onFilter(event.target.value),
            style: {
              ...css.select,
              flex: '0 1 118px',
              minWidth: '104px',
              height: '26px',
              padding: '0 7px',
              fontSize: '10.5px',
            },
          }, SHOT_FILTERS.map(([id, label]) => h('option', {
            key: id,
            value: id,
          }, `${label} ${String(countFor(id))}`))),
          h('button', {
            type: 'button',
            style: { ...css.miniButton, marginLeft: 'auto' },
            disabled: busy,
            onClick: onRefresh,
          }, busy ? '刷新中' : '刷新进度')),
        h('div', { 'data-dsh-production-next': 'true', style: css.productionNext },
          h('span', { style: { minWidth: 0, flex: '1 1 220px' } }, `下一件：${nextLabel}`),
          next === null ? null : h('button', {
            type: 'button',
            'data-dsh-production-locate': next.shotId ?? `${String(next.episodeNumber ?? '')}:${String(next.blockNumber ?? '')}`,
            style: css.miniButton,
            onClick: () => {
              onFilter(next.state);
              onFocusShot(next);
            },
          }, '定位这一镜')),
        error.length > 0 ? h('div', { style: css.error }, displayShotText(error)) : null,
      );
    }

    /**
     * Put text on the clipboard, and say whether it worked.
     *
     * A draft the Host refused to save exists in exactly ONE place - the browser - so the panel
     * offers to hand it back as plain text. `navigator.clipboard` is the modern path and is
     * refused in some embedded renderers, hence the selection-copy fallback: telling a user
     * "copy failed" while their text sits two inches away on screen is not an answer.
     */
    async function copyText(text) {
      const value = String(text ?? '');
      if (value.length === 0) return false;
      try {
        if (typeof globalThis.navigator?.clipboard?.writeText === 'function') {
          await globalThis.navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        // Permission denied or no gesture: the fallback below still works.
      }
      try {
        const doc = globalThis.document;
        if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return false;
        const area = doc.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        doc.body.appendChild(area);
        area.select();
        const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }

    /**
     * Is this refusal the filesystem sandbox talking?
     *
     * Two spellings arrive here and they mean one thing: the Host's `errorCode` on the private
     * route, and its explained sentence (which starts with 存不进) on the command channel that a
     * deployment without a web server falls back to. A real save failure - a stale revision, a
     * full disk - must NOT be read as a boundary, or the panel would tell the user their folder is
     * out of reach when it is not.
     */
    function isSandboxDenial(error) {
      if (error?.errorCode === 'SANDBOX_DENIED') return true;
      return /file access denied under workspace-write|file access denied under read-only|^存不进/u.test(String(error?.message ?? error));
    }

    /**
     * One 大分镜: a collapsible card whose body is the editable prompt.
     *
     * The block IS the prompt - one block is pasted into the video model on its own - so the
     * header carries no duration, no shot count and no file name. Those live where they are
     * actually used: the duration in the 生成视频 panel, the count in the text the writer edits,
     * the file in the source picker. A badge that recomputed any of them would be a second,
     * competing reading of one value. The header is the 大分镜 number and the two structural
     * actions, nothing else.
     */
    function ShotCard({ t, shot, onSave, onInsert, onDelete, onSync, onGenerate, onReview, settings, onSettings, assets = [], mediaUrl, previewUrl, references = null, onRequestReferences, draftKey = null, wide = false, candidates = [], onUpload, onPickAsset, onMention, modeReady = false, productionState = null, sourceSwitch = null, onFocus, shouldOpen = false }) {
      // A reference that has not resolved would bind to the wrong input, so generation is refused
      // here rather than after a press. `onPin` used to be a prop of this component and was never
      // passed by the parent - the pin control therefore never rendered, and no Host action can set
      // that flag either, so it was removed rather than left as a button nobody can reach.
      const referencesBlocked = (references?.unresolved?.length ?? 0) + (references?.ambiguous?.length ?? 0) > 0;
      const mentionAssets = mentionAssetsForReferences(references);
      const [open, setOpen] = React.useState(shot.index === 0);
      React.useEffect(() => {
        if (shouldOpen) setOpen(true);
      }, [shouldOpen]);
      const [previewCandidateId, setPreviewCandidateId] = React.useState(null);
      const videoCandidates = (candidates ?? [])
        .filter((row) => mediaKindOf(row.fileName ?? row.relativePath) === 'video')
        .sort((left, right) => String(right.generatedAt ?? '').localeCompare(String(left.generatedAt ?? '')));
      const activePreviewCandidate = videoCandidates.find((row) => row.candidateId === previewCandidateId)
        ?? videoCandidates[0]
        ?? (candidates ?? [])[0]
        ?? null;
      const activeVideoIndex = Math.max(0, videoCandidates.findIndex((row) => row.candidateId === activePreviewCandidate?.candidateId));
      const selectRelativeVideo = (direction) => {
        if (videoCandidates.length === 0) return;
        const nextIndex = (activeVideoIndex + direction + videoCandidates.length) % videoCandidates.length;
        setPreviewCandidateId(videoCandidates[nextIndex].candidateId);
      };
      React.useEffect(() => {
        if (previewCandidateId !== null && !videoCandidates.some((row) => row.candidateId === previewCandidateId)) {
          setPreviewCandidateId(null);
        }
      }, [previewCandidateId, candidates]);
      const [widePaneWidths, setWidePaneWidths] = React.useState(readDramaPaneWidths);
      const [widePaneContainerWidth, setWidePaneContainerWidth] = React.useState(720);
      const widePaneRef = React.useRef(null);
      const displayedWidePaneWidths = fitDramaPaneWidths(widePaneWidths, widePaneContainerWidth);
      React.useEffect(() => {
        if (!wide || !open) return undefined;
        const container = widePaneRef.current;
        if (container === null || container === undefined
          || typeof container.getBoundingClientRect !== 'function') return undefined;
        const measure = () => {
          const width = container.getBoundingClientRect().width;
          if (!Number.isFinite(width) || width <= 0) return;
          setWidePaneContainerWidth((previous) => Math.abs(previous - width) < 1 ? previous : width);
        };
        measure();
        const observer = typeof globalThis.ResizeObserver === 'function'
          ? new globalThis.ResizeObserver(measure)
          : null;
        observer?.observe(container);
        if (observer === null) globalThis.window?.addEventListener?.('resize', measure);
        return () => {
          observer?.disconnect();
          if (observer === null) globalThis.window?.removeEventListener?.('resize', measure);
        };
      }, [open, wide]);
      const updateWidePaneWidths = (next, persist = true) => {
        setWidePaneWidths(next);
        if (persist) saveDramaPaneWidths(next);
      };
      const beginWidePaneResize = (divider, event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const container = widePaneRef.current;
        if (container === null || container === undefined || typeof event.clientX !== 'number') return;
        const width = container.getBoundingClientRect().width;
        if (width < DRAMA_PANE_MIN_WIDTHS.assets + DRAMA_PANE_MIN_WIDTHS.prompt
          + DRAMA_PANE_MIN_WIDTHS.preview + DRAMA_PANE_SPLITTER_TOTAL) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const start = { ...displayedWidePaneWidths };
        const body = globalThis.document?.body;
        const previousCursor = body?.style?.cursor ?? '';
        const previousUserSelect = body?.style?.userSelect ?? '';
        if (body?.style) {
          body.style.cursor = 'col-resize';
          body.style.userSelect = 'none';
        }
        let last = start;
        const move = (moveEvent) => {
          moveEvent.preventDefault?.();
          const delta = moveEvent.clientX - startX;
          if (divider === 'assets-prompt') {
            const maximumAssets = start.assets + start.prompt - DRAMA_PANE_MIN_WIDTHS.prompt;
            const assets = clampDramaPane(
              start.assets + delta,
              DRAMA_PANE_MIN_WIDTHS.assets,
              maximumAssets,
            );
            last = {
              assets,
              prompt: start.prompt - (assets - start.assets),
            };
          } else {
            const maximumPrompt = width - DRAMA_PANE_SPLITTER_TOTAL
              - start.assets - DRAMA_PANE_MIN_WIDTHS.preview;
            last = {
              assets: start.assets,
              prompt: clampDramaPane(
                start.prompt + delta,
                DRAMA_PANE_MIN_WIDTHS.prompt,
                maximumPrompt,
              ),
            };
          }
          setWidePaneWidths(last);
        };
        const finish = () => {
          globalThis.window?.removeEventListener?.('pointermove', move);
          globalThis.window?.removeEventListener?.('pointerup', finish);
          globalThis.window?.removeEventListener?.('pointercancel', finish);
          if (body?.style) {
            body.style.cursor = previousCursor;
            body.style.userSelect = previousUserSelect;
          }
          saveDramaPaneWidths(last);
        };
        globalThis.window?.addEventListener?.('pointermove', move);
        globalThis.window?.addEventListener?.('pointerup', finish);
        globalThis.window?.addEventListener?.('pointercancel', finish);
      };
      const nudgeWidePane = (divider, event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -24 : 24;
        const displayed = displayedWidePaneWidths;
        if (divider === 'assets-prompt') {
          const maximumAssets = displayed.assets + displayed.prompt - DRAMA_PANE_MIN_WIDTHS.prompt;
          const assets = clampDramaPane(
            displayed.assets + delta,
            DRAMA_PANE_MIN_WIDTHS.assets,
            maximumAssets,
          );
          updateWidePaneWidths({
            assets,
            prompt: displayed.prompt - (assets - displayed.assets),
          });
          return;
        }
        const container = widePaneRef.current;
        const width = container?.getBoundingClientRect?.().width ?? widePaneContainerWidth;
        updateWidePaneWidths({
          assets: displayed.assets,
          prompt: clampDramaPane(
            displayed.prompt + delta,
            DRAMA_PANE_MIN_WIDTHS.prompt,
            width - DRAMA_PANE_SPLITTER_TOTAL - displayed.assets - DRAMA_PANE_MIN_WIDTHS.preview,
          ),
        });
      };
      const videoCacheStrip = videoCandidates.length < 2 ? null : h(
        'div',
        {
          className: 'sdd-video-cache sdd-video-cache-preview sdd-video-cache-compact',
          'data-dsh-video-cache': shot.shotId ?? String(shot.sourceNumber ?? ''),
        },
        h('div', { className: 'sdd-video-cache-nav' },
          h('button', {
            type: 'button',
            className: 'sdd-cache-nav-button',
            title: '上一个候选视频',
            'aria-label': '上一个候选视频',
            'data-dsh-cache-step': 'previous',
            onClick: () => selectRelativeVideo(-1),
          }, h(SddIcon, { name: 'chevron-left', size: 14 })),
          h('span', {
            className: 'sdd-video-cache-position',
            'data-dsh-cache-position': 'true',
          }, `${String(activeVideoIndex + 1)} / ${String(videoCandidates.length)}`),
          h('button', {
            type: 'button',
            className: 'sdd-cache-nav-button',
            title: '下一个候选视频',
            'aria-label': '下一个候选视频',
            'data-dsh-cache-step': 'next',
            onClick: () => selectRelativeVideo(1),
          }, h(SddIcon, { name: 'chevron-right', size: 14 }))),
      );
      // What the last 「清理无法解析的引用」 press did. Visible feedback, because a no-op looked broken.
      const [cleanNote, setCleanNote] = React.useState('');
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [h3Uploading, setH3Uploading] = React.useState(null);
      const [projectAssetPicker, setProjectAssetPicker] = React.useState(null);
      const [draft, setDraft] = React.useState(shot.text);
      const latest = React.useRef(draft);
      // The editor owns the uncommitted keystroke buffer. Only advance `latest` when the card's
      // committed draft actually changes; otherwise an unrelated card render would overwrite the
      // newer text held by the editor and make Save operate on a stale snapshot.
      const renderedDraft = React.useRef(draft);
      if (renderedDraft.current !== draft) {
        renderedDraft.current = draft;
        latest.current = draft;
      }
      const settingsRef = React.useRef(settings);
      settingsRef.current = settings;
      const updateSettings = (patch) => {
        const next = { ...(settingsRef.current ?? settings ?? {}), ...patch };
        settingsRef.current = next;
        onSettings(next);
      };
      /**
       * Append `@名字` after an upload.
       *
       * A file in the library is not a reference: the block only binds it once the text names it. The
       * card owns the draft and its autosave, so the insertion belongs here rather than in the panel.
       */
      /**
       * Empty an H3 material slot without editing the prompt.
       *
       * The authored `<Picture N>` definition and any `<Subject>` prose stay byte-for-byte as typed.
       * The empty decision lives in shot metadata and is keyed by the slot label, so prompt edits and
       * one-click sync remain independent from what the material column currently contains.
       */
      /**
       * Which reference lines cannot resolve, read straight from the DRAFT.
       *
       * Reading `references.unresolved` made the button dead: that object is filled only after a resolve
       * round trip, and only for the block the panel happened to load, so the count was 0 - and the button
       * disabled - on exactly the blocks that needed it. The draft always exists and the asset library is
       * already here, so the check runs locally: every name a definition line points at must be an asset
       * name, an alias, or a file name in the library.
       */
      const knownAssetNames = React.useMemo(() => {
        const known = new Set();
        for (const asset of assets) {
          for (const value of [asset.name, ...(asset.aliases ?? [])]) {
            if (typeof value === 'string') known.add(value.trim().toLowerCase());
          }
        }
        return known;
      }, [assets]);
      const unresolvedLines = React.useMemo(() => {
        const slotLabels = new Set((references?.referenceSlots ?? [])
          .map((slot) => slot?.label)
          .filter((label) => typeof label === 'string'));
        /**
         * STRICT: only real asset names and aliases count as "resolved".
         *
         * File names are deliberately NOT included. `外卖袋_00001_.png` is a file the library holds, so
         * including its stem made the line look fine and the button did nothing - while the reference line
         * still said `外卖袋_00001_`, which is not an asset name and cannot be referenced again after the
         * file is renamed or re-exported. The button's job is to remove lines whose name is not an asset
         * name, and that is what this measures.
         */
        const resolvedLabels = new Set((references?.references ?? [])
          .filter((entry) => entry?.bindingState === 'resolved')
          .map((entry) => entry.display)
          .filter((label) => typeof label === 'string'));
        const found = [];
        for (const line of String(draft ?? '').split('\n')) {
          const trimmed = line.trim();
          const picture = /^<(\w+) (\d+)>\s*是\s*(.+?)\s*的参考/u.exec(trimmed);
          const cast = /^<Subject (\d+)>\s*是\s*<(\w+) (\d+)>\s*中的\s*(.+?)(?:[，,]|$)/u.exec(trimmed);
          const name = picture !== null ? picture[3] : (cast !== null ? cast[4] : null);
          if (name === null || name.trim().length === 0) continue;
          const bare = name.trim().toLowerCase();
          // A name that is not an asset name is what this button removes - see `known` above.
          if (knownAssetNames.has(bare)) continue;
          const label = picture !== null ? `<${picture[1]} ${picture[2]}>` : `<${cast[2]} ${cast[3]}>`;
          if (!slotLabels.has(label) && !resolvedLabels.has(label)) found.push(label);
        }
        return found;
      }, [draft, knownAssetNames, references]);
      /**
       * Everything worth cleaning: what the DRAFT cannot resolve, plus what the HOST reported.
       *
       * The two disagree in a way that matters - the library already holds `外卖袋_00001_.png`, so the
       * local check resolves it, while an un-restarted Host still reports it unresolved. The button
       * therefore never disables: it cleans the union, so a press can only help, and a press with nothing
       * to do is a no-op instead of a dead control.
       */
      const cleanTargets = React.useMemo(() => {
        const labels = new Set(unresolvedLines);
        const slotLabels = new Set((references?.referenceSlots ?? [])
          .map((slot) => slot?.label)
          .filter((label) => typeof label === 'string'));
        for (const item of references?.unresolved ?? []) {
          const shown = /^<(\w+)\s+(\d+)>/u.exec(String(item.text ?? '').trim());
          if (shown !== null && !slotLabels.has(`<${shown[1]} ${shown[2]}>`)) labels.add(`<${shown[1]} ${shown[2]}>`);
        }
        return [...labels];
      }, [references, unresolvedLines]);
      /**
       * Drop every line whose slot number is in `targets`.
       *
       * Line filtering, not a built RegExp: the dynamic pattern (`^<Picture 5>(?!\d)...`) silently failed to
       * match, so the button appeared to do nothing. A predicate over `split('\n')` has no escaping to get
       * wrong and is the same approach the per-tile `×` uses.
       */
      const dropSlots = (source, targets) => {
        const wanted = new Set();
        for (const item of targets) {
          const shown = /^<(\w+)\s+(\d+)>/u.exec(String(item).trim());
          if (shown !== null) wanted.add(`${shown[1]} ${shown[2]}`);
        }
        if (wanted.size === 0) return source;
        return source.split('\n').filter((line) => {
          const trimmed = line.trim();
          const own = /^<(\w+) (\d+)>/u.exec(trimmed);
          if (own !== null && wanted.has(`${own[1]} ${own[2]}`)) return false;
          const cast = /^<Subject \d+>.*<(\w+) (\d+)>/u.exec(trimmed);
          if (cast !== null && wanted.has(`${cast[1]} ${cast[2]}`)) return false;
          return true;
        }).join('\n');
      };
      /**
       * Delete `@name` (and the bare name it may leave behind) from a text.
       *
       * Shared by the per-tile `×` and the cleanup sweep so both remove exactly the same thing: the
       * mention token, its optional `@`, and any tail glued to it (a trailing full stop), then collapse the
       * spacing that is left.
       */
      const removeMentionIn = (source, name) => {
        if (typeof name !== 'string' || name.length === 0) return source;
        const escape = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        return String(source)
          .replace(new RegExp(`@${escape}(?![\\w\\u4e00-\\u9fa5])`, 'gu'), '')
          .replace(new RegExp(`(?<![\\w\\u4e00-\\u9fa5])${escape}(?![\\w\\u4e00-\\u9fa5])`, 'gu'), '')
          .replace(/[ \t]{2,}/gu, ' ');
      };
      /**
       * Unresolved `@名字` mentions - the VIDEO-PROMPT form of a reference.
       *
       * A video prompt binds by `@name`; only the H3 cards bind by `<Picture N>`. The cleanup was written
       * against the H3 shape, so on a video-prompt card it found nothing to do and reported 「没有可清理的
       * 引用」 while the asset column still showed an error. This is the same check for the `@` form: a name
       * is fine only when the library really has it.
       */
      const unresolvedMentions = React.useMemo(() => {
        if (shot.h3 === true) return [];
        const found = new Set();
        for (const match of String(draft ?? '').matchAll(/@([^\s，。、；：（）()\[\]<>"@]+)/gu)) {
          const name = match[1].trim();
          if (name.length === 0) continue;
          if (!knownAssetNames.has(name.toLowerCase())) found.add(name);
        }
        return [...found];
      }, [draft, knownAssetNames, shot.h3]);
      const cleanUnresolved = () => {
        if (shot.h3 !== true) {
          // Video prompt: drop the `@name` itself, which is the whole binding.
          if (unresolvedMentions.length === 0) return;
          let next = latest.current;
          for (const name of unresolvedMentions) next = removeMentionIn(next, name);
          latest.current = next;
          setDraft(next);
          return;
        }
        if (cleanTargets.length === 0) return;
        const next = dropSlots(latest.current, cleanTargets);
        latest.current = next;
        setDraft(next);
      };
      // What the button reports and counts: `@` mentions for a video prompt, `<Picture N>` lines for H3.
      const cleanCount = shot.h3 === true ? cleanTargets.length : unresolvedMentions.length;
      // Kept for the legacy call below; the button uses `cleanCount`.
      void cleanTargets;
      // Same line-filter approach as `dropSlots` - the per-tile `×` must not have the dynamic-RegExp
      // problem either.
      const removeH3Reference = ({ slotPrefix, slotNumber }) => {
        const label = `<${slotPrefix} ${slotNumber}>`;
        const referenceSlots = [
          ...(references?.referenceSlots ?? []).filter((slot) => slot?.label !== label),
          { label, mode: 'empty' },
        ];
        setCleanNote(`已清空 ${label}`);
        if (typeof onRequestReferences === 'function') {
          onRequestReferences(shot, latest.current, null, referenceSlots);
        }
      };
      /**
       * Add a chosen library asset to the matching 映射 section.
       *
       * Appending a naked `@name` at the end of the prose looked successful but did not survive the
       * compiler: only the mapping sections are authoritative. The category-specific row is what
       * makes a selected character/scene/prop an actual upload.
       */
      const appendAssetReference = (name, category, kindFilter = null) => {
        const clean = String(name ?? '').trim();
        if (clean.length === 0) return latest.current;
        const kind = kindFilter ?? (category === '场景' ? 'scene' : category === '道具' ? 'prop'
          : category === '参考音频' ? 'reference-audio' : category === '参考视频' ? 'reference-video'
            : category === '其他参考图片' ? 'reference-image' : 'character');
        const heading = kind === 'scene' ? '【场景映射】' : kind === 'prop' ? '【道具映射】'
          : kind === 'reference-audio' ? '【参考音频映射】' : kind === 'reference-video' ? '【参考视频映射】'
            : kind === 'reference-image' ? '【其他参考图片映射】' : '【人物映射】';
        const role = kind === 'character' ? '形象及服装参考' : kind === 'scene' ? '场景画面布置参考'
          : kind === 'prop' ? '道具外观参考' : kind === 'reference-audio' ? '声音参考'
            : kind === 'reference-video' ? '镜头参考' : '参考图';
        const row = `${clean}（${role}: @${clean}）`;
        const previous = latest.current;
        const lines = String(previous).split('\n');
        const headingAt = lines.findIndex((line) => line.trim().startsWith(heading));
        if (headingAt < 0) {
          const next = `${heading}\n${row}\n\n${previous}`;
          latest.current = next;
          setDraft(next);
          return next;
        }
        let end = headingAt + 1;
        while (end < lines.length && !/^\s*【/u.test(lines[end])) end += 1;
        const section = lines.slice(headingAt + 1, end);
        if (section.some((line) => line.includes(`@${clean}`))) return previous;
        const insertAt = headingAt + 1 + section.length;
        lines.splice(insertAt, 0, row);
        const next = lines.join('\n');
        latest.current = next;
        setDraft(next);
        return next;
      };
      /**
       * Bind a freshly uploaded file into an H3 prompt.
       *
       * An H3 slot shows what the PROMPT references, not what the library holds. Uploading a picture
       * therefore left the slot empty - the file existed, but no `<Picture N>` line named it, so the next
       * resolve found nothing and the upload looked broken. This appends the line that binds it:
       * `<Picture 4> 是 <名字> 的参考。`, numbered after the highest index already in use and refusing to
       * exceed the workflow's caps (9 pictures, 3 audio, 3 video).
       */
      const bindH3ReferenceText = (previous, prefix, name, wanted = null) => {
        const used = [...previous.matchAll(new RegExp(`<${prefix} (\\d+)>`, 'gu'))].map((match) => Number(match[1]));
        const cap = prefix === 'Picture' ? 9 : 3;
        // The slot the user clicked wins, unconditionally.
        //
        // The UI only offers upload on an EMPTY slot, so its number is by definition free. The previous
        // version also required `!used.includes(n)`, and a stale `<Picture 4>` left in the text by an
        // earlier attempt made that check fail - the line then fell back to "highest + 1" and a file
        // chosen for slot 4 landed in slot 9. A stale binding for the same number is REPLACED, not
        // worked around.
        const wantedNumber = Number(wanted);
        const useWanted = Number.isFinite(wantedNumber) && wantedNumber > 0 && wantedNumber <= cap;
        const next = useWanted ? wantedNumber : (used.length === 0 ? 1 : Math.max(...used) + 1);
        if (next > cap) return previous;
        const role = prefix === 'Audio' ? '音色' : '';
        const line = `<${prefix} ${next}> 是 ${name} 的${role}参考。`;
        // A stale line for this same number is dropped first, so the block never ends up with two
        // definitions competing for one slot.
        const cleaned = previous.replace(new RegExp(`^<${prefix} ${next}>[^\\n]*\\n?`, 'gmu'), '');
        const source = useWanted ? cleaned : previous;
        // Append inside `subject_definitions:` when it exists, right after its last entry line.
        const head = /subject_definitions:\s*\n/u.exec(source);
        if (head === null) return `subject_definitions:\n${line}\n\n${source}`;
        const start = head.index + head[0].length;
        const rest = source.slice(start);
        const end = rest.search(/\n\s*\n/u);
        if (end < 0) return `${source}${source.endsWith('\n') ? '' : '\n'}${line}`;
        const body = rest.slice(0, end);
        return `${source.slice(0, start)}${body}${body.endsWith('\n') ? '' : '\n'}${line}${rest.slice(end)}`;
      };
      /**
       * Bind an uploaded file to a slot while preserving text the user already wrote.
       *
       * The prompt is the user's document, not a mirror of the asset column. An existing
       * `<Picture N>` definition is never rewritten; only a truly missing definition gets the
       * default line needed to make the prompt syntactically complete.
       */
      const ensureH3SlotDefinition = (prefix, name, wanted) => {
        const number = Number(wanted);
        const label = `<${prefix} ${String(number)}>`;
        const slotPattern = Number.isFinite(number) ? new RegExp(`<${prefix}\\s+${number}>`, 'u') : null;
        const lines = String(latest.current).split('\n').map((line) => line.trim());
        const existing = slotPattern === null ? undefined
          : (lines.find((line) => new RegExp(`^<${prefix}\\s+${number}>\\s*是`, 'u').test(line))
            ?? lines.find((line) => /^<Subject\s+\d+>\s*是/u.test(line) && slotPattern.test(line)));
        if (existing !== undefined) {
          return { text: latest.current, definition: existing };
        }
        const next = bindH3ReferenceText(latest.current, prefix, name, wanted);
        latest.current = next;
        setDraft(next);
        const definition = String(next).split('\n').find((line) => line.trim().startsWith(label))?.trim() ?? '';
        return { text: next, definition };
      };
      const h3MediaKind = (prefix) => prefix === 'Audio' ? 'audio' : prefix === 'Video' ? 'video' : 'image';
      const h3AllowedKinds = (prefix) => prefix === 'Audio'
        ? ['reference-audio']
        : prefix === 'Video'
          ? ['reference-video']
          : ['character', 'scene', 'prop', 'reference-image'];
      const applyH3SlotAsset = (imported, prefix, slotNumber, preferredName = null) => {
        const binding = imported?.binding ?? null;
        if (binding === null) throw new Error('素材已解析，但没有生成可用的 H3 槽位绑定');
        const bound = String(preferredName ?? imported?.name ?? binding.assetName ?? binding.fileName ?? '').trim();
        if (bound.length === 0) throw new Error('素材缺少可写入提示词的资产名');
        const slot = ensureH3SlotDefinition(prefix, bound, slotNumber);
        const label = `<${prefix} ${slotNumber}>`;
        const referenceSlots = [
          ...(references?.referenceSlots ?? []).filter((entry) => entry?.label !== label),
          { label, definition: slot.definition, mode: 'bound', binding },
        ];
        return { imported, draft: slot.text, referenceSlots };
      };
      const openProjectAssetPicker = (target, { prefix = null, slotNumber = null, mediaKind = 'image', allowedKinds = [], category = null, title = '选择项目资产' } = {}) => {
        setProjectAssetPicker({ target, prefix, slotNumber, mediaKind, allowedKinds, category, title });
      };
      const chooseProjectAsset = async (choice) => {
        const picker = projectAssetPicker;
        if (picker === null || choice === null || choice === undefined) return;
        setProjectAssetPicker(null);
        if (picker.target === 'video') {
          const name = String(choice.label ?? choice.assetName ?? '');
          const next = appendAssetReference(name, picker.category, picker.allowedKinds?.[0] ?? null);
          if (typeof onRequestReferences === 'function') {
            onRequestReferences(shot, next, {
              [name]: { assetId: choice.assetId, variantName: choice.variantName },
            });
          }
          setCleanNote(`已从项目资产加入 @${name}`);
          return;
        }
        if (picker.target !== 'h3' || typeof onPickAsset !== 'function') return;
        try {
          setCleanNote('');
          const imported = await onPickAsset({
            assetId: choice.assetId,
            variantName: choice.variantName,
            mediaKind: picker.mediaKind,
          });
          const result = applyH3SlotAsset(imported, picker.prefix, picker.slotNumber, imported?.name);
          if (picker.prefix === 'Audio') {
            setCleanNote(`音频已接入 <Audio ${String(picker.slotNumber)}>。生成前可点“一键同步”绑定到本镜说话人。`);
          } else {
            setCleanNote(`已把项目资产「${String(imported?.name ?? '')}」放入 <${picker.prefix} ${String(picker.slotNumber)}>`);
          }
          if (typeof onRequestReferences === 'function') {
            onRequestReferences(shot, result.draft, null, result.referenceSlots);
          }
        } catch (failure) {
          setCleanNote(`项目资产选择失败：${String(failure?.message ?? failure)}`);
        }
      };
      /**
       * Explicitly remove one card from the video-prompt asset bar.
       *
       * Editing the prompt is not an asset action. This handler is reached only by the card's
       * remove button, so it both deletes the mention text and names the selected reference for
       * Host-side removal. Ordinary text edits keep the card.
       */
      const removeMention = ({ name, display, fileName, referenceId, assetVersionId, occurrences = [] }) => {
        const mention = typeof display === 'string' && display.startsWith('@')
          ? display
          : (typeof name === 'string' && name.length > 0 ? `@${name}` : '');
        if (mention.length === 0 && occurrences.length === 0) return;
        let next = latest.current;
        let removedSpan = false;
        const spans = (Array.isArray(occurrences) ? occurrences : [])
          .filter((entry) => Number.isInteger(entry?.start) && Number.isInteger(entry?.end) && entry.end > entry.start)
          .sort((left, right) => right.start - left.start);
        for (const span of spans) {
          const actual = next.slice(span.start, span.end);
          if (!actual.startsWith('@')) continue;
          next = `${next.slice(0, span.start)}${next.slice(span.end)}`;
          removedSpan = true;
        }
        // Deleting an asset card removes its exact @mention, never the surrounding descriptive
        // wrapper. `谢妄（形象及服装参考: @谢妄）` becomes `谢妄（形象及服装参考: ）`.
        if (!removedSpan && mention.length > 0) {
          const escape = mention.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          next = next.replace(new RegExp(`${escape}(?=$|[\\s，。；、）)】\\n])`, 'gu'), '');
        }
        next = next.replace(/[ \t]{2,}/gu, ' ');
        latest.current = next;
        // This is an explicit removal, not a debounced text edit. Advancing the key prevents
        // the normal autosave resolve from immediately re-adding the card before Host answers.
        lastKey.current = mentionKey(next);
        setDraft(next);
        setCleanNote(`已从素材栏移除 ${name ?? display ?? fileName ?? '素材'}`);
        if (typeof onRequestReferences === 'function') {
          const removeReferenceIds = [referenceId, assetVersionId]
            .filter((value) => typeof value === 'string' && value.length > 0);
          void onRequestReferences(shot, next, null, null, removeReferenceIds);
        }
      };
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      // Whether the text on screen came back from a draft rather than from the file. Shown to the
      // user, because restored text that looks like the file's own is how someone saves a
      // half-finished paragraph over a finished one.
      const [restored, setRestored] = React.useState(false);
      // Set when the file changed underneath an open draft. Holds both texts, because the point is
      // to show the user what each choice would keep.
      const [conflict, setConflict] = React.useState(null);
      /**
       * What the file said when this draft was STARTED - the baseline a conflict is detected against.
       *
       * Held in state, not read from `shot.text`: following the file would move the baseline onto the
       * document as soon as it changed, and the very change that should be reported would silently
       * become "what my draft was based on". It is state rather than a ref so the conflict can be
       * computed during render instead of in an effect - an effect ordering mistake here is a bug
       * that survives review, and a pure computation cannot have one.
       */
      const [baseText, setBaseText] = React.useState(shot.text);
      const savedText = React.useRef(null);
      const saving = React.useRef(false);
      const accepted = React.useRef({ text: shot.text, revision: shot.revision, shotId: shot.shotId });
      const [actionBusy, setActionBusy] = React.useState(false);
      const [saveError, setSaveError] = React.useState('');
      const leaving = React.useRef(false);
      const leaveSave = React.useRef(null);
      const actionLock = React.useRef(false);

      /**
       * Reload from the file, then prefer a stored draft if one is newer than nothing.
       *
       * Order matters: the file's text is the truth, so a draft is only ever offered as a
       * RECOVERY of unsaved work, never as a replacement for what is on disk.
       */
      /**
       * Reconcile the stored draft with what the file says now. PURE - given the same three inputs it
       * always returns the same answer, which is why it can be asserted and why it cannot depend on
       * which effect ran first.
       *
       * A conflict is: a draft exists, the draft was based on something the file no longer says, and
       * the draft is not simply the new file. That last clause matters - if the user's edit and the
       * new file agree, there is nothing to reconcile.
       */

      React.useEffect(() => {
        if (savedText.current !== null && savedText.current.trim() === shot.text.trim()) {
          accepted.current = { text: shot.text, revision: shot.revision, shotId: shot.shotId };
          setBaseText(shot.text);
          return;
        }
        // A revision change from saving another card must not replace this card's draft.
        if (accepted.current.text === shot.text && latest.current !== shot.text) return;
        const stored = draftKey === null ? null : draftStore.read(draftKey.project, draftKey.file, draftKey.shotId);
        // The panel does not choose between the two. Picking the file loses the user's typing;
        // picking the draft loses somebody's edit. Both are real work, so the choice is theirs, and
        // until they make it nothing is written anywhere.
        const outcome = reconcileDraft(stored, shot.text);
        setDraft(outcome.draft);
        setRestored(outcome.restored);
        setConflict(outcome.conflict);
        setBaseText(outcome.base);
        accepted.current = { text: shot.text, revision: shot.revision, shotId: shot.shotId };
        setState('idle');
        setNote(savedText.current !== null && savedText.current.trim() === shot.text.trim() ? t('saved') : '');
        savedText.current = null;
      }, [shot.text, draftKey?.project, draftKey?.file, draftKey?.shotId]);

      /** Keep the draft current, so a reload or a crash cannot lose typing. */
      React.useEffect(() => {
        if (draftKey === null) return;
        if (draft === shot.text) draftStore.clear(draftKey.project, draftKey.file, draftKey.shotId);
        // The base is captured from the file as it stands, so a later change to the file is
        // detectable rather than invisible.
        else draftStore.write(draftKey.project, draftKey.file, draftKey.shotId, draft, baseText);
      }, [draft, shot.text, draftKey?.project, draftKey?.file, draftKey?.shotId]);

      /**
       * Re-resolve the references whenever the mentions in the draft change.
       *
       * Mentions are how assets are ADDED to the video-prompt bar. Deleting an `@` from prose
       * does not remove the card; the Host retains explicit asset selections until the card's
       * own remove button is used. The key remains the mention set so ordinary prose edits do
       * not cause repeated resolves.
       *
       * Debounced, because a mention is typed one character at a time and each keystroke would
       * otherwise be a round trip to the Host.
       */
      const mentionKey = (text) => (String(text).match(/@[\p{L}\p{N}（）()·・\-_.]+/gu) ?? []).join('\u0000');
      /**
       * What an H3 block's references actually depend on.
       *
       * The binding is decided by `subject_definitions` (which asset each `<Picture N>` is) and by
       * which picture numbers the prompt uses. The rest of the prompt - `detailed_description`,
       * `overall_soundscape`, `summary` - is prose: editing it cannot change a binding.
       *
       * The key used to be the WHOLE draft, so every keystroke re-resolved after the 350 ms pause.
       * That is what made the 引用 bar flash on every edit: a request per sentence, each one flipping
       * the bar through its loading state. Prose edits now cost nothing.
       */
      const h3Key = (text) => {
        const source = String(text);
        const definitions = /subject_definitions:\s*([\s\S]*?)(?:\n\s*summary:|$)/u.exec(source)?.[1] ?? '';
        const pictures = [...source.matchAll(/<Picture\s+(\d+)>/gu)].map((match) => match[1]).sort((left, right) => Number(left) - Number(right)).join(',');
        const media = [...source.matchAll(/<(Video|Audio)\s+(\d+)>/gu)].map((match) => `${match[1]}${match[2]}`).sort().join(',');
        return `${pictures}\u0000${media}\u0000${definitions}`;
      };
      const lastKey = React.useRef(null);
      // The timer must not be cancelled by renders that change nothing relevant.
      //
      // `shot` is a fresh object on every parent render, so having it in the dependency list rebuilt
      // this effect constantly and cleared the pending debounce each time - whether a re-resolution
      // happened at all then depended on how often the parent re-rendered. The refs carry the latest
      // values into the timer; the dependencies are the two things that actually decide the key.
      const shotRef = React.useRef(shot);
      const draftRef = React.useRef(draft);
      shotRef.current = shot;
      draftRef.current = draft;
      React.useEffect(() => {
        if (onRequestReferences === undefined) return undefined;
        const key = shot.h3 === true ? h3Key(draft) : mentionKey(draft);
        if (key === lastKey.current) return undefined;
        const timer = setTimeout(() => {
          lastKey.current = key;
          onRequestReferences(shotRef.current, draftRef.current, null, null, null, { background: true });
        }, 350);
        return () => clearTimeout(timer);
      }, [draft, shot.h3, onRequestReferences]);

      const dirty = draft !== accepted.current.text;
      const visibleNote = note.length > 0 && note !== t('saved') && note !== t('unchanged')
        ? note
        : '';
      const save = async () => {
        if (saving.current || conflict !== null || latest.current === accepted.current.text) return;
        saving.current = true;
        const snapshot = latest.current;
        const baseline = accepted.current;
        setState('saving');
        setNote('');
        setSaveError('');
        savedText.current = snapshot;
        try {
          // The shotId travels with the block, so the save lands on the shot the user was
          // looking at even if the list shifted underneath the card.
          const outcome = await onSave({
            shotId: baseline.shotId ?? null,
            index: shot.index,
            blockNumber: shot.sourceNumber,
            file: shot.file,
            revision: baseline.revision,
            baseText: baseline.text,
            createIfMissing: shot.missingH3File === true,
          }, snapshot);
          const persisted = outcome.text ?? snapshot;
          accepted.current = { text: persisted, revision: outcome.revision, shotId: outcome.shotId ?? baseline.shotId };
          savedText.current = persisted;
          setBaseText(persisted);
          if (latest.current === snapshot) { latest.current = persisted; setDraft(persisted); }
          setState('idle');
          setNote(outcome.changed ? t('saved') : t('unchanged'));
            // The draft has become the file, so keeping it would offer to restore work that is
            // already saved - and a later edit would then look like it came from nowhere.
            if (draftKey !== null && latest.current === persisted) draftStore.clear(draftKey.project, draftKey.file, draftKey.shotId);
            setRestored(false);
        } catch (error) {
          savedText.current = null;
          setState('idle');
          setSaveError(String(error?.message ?? error));
          throw error;
        } finally {
          saving.current = false;
          if (leaving.current && latest.current !== accepted.current.text && savedText.current !== null) leaveSave.current?.().catch(() => {});
        }
      };
      leaveSave.current = save;
      React.useEffect(() => {
        leaving.current = false;
        return () => { leaving.current = true; leaveSave.current?.().catch(() => {}); };
      }, []);

      React.useEffect(() => {
        if (!dirty || conflict !== null || state === 'saving' || saveError) return undefined;
        const timer = setTimeout(() => { save().catch(() => {}); }, 650);
        return () => clearTimeout(timer);
      }, [draft, conflict, state, saveError, shot.text]);

      const runAction = async (kind) => {
        if (actionLock.current || saving.current || conflict !== null) return;
        if (modeReady !== true) {
          setNote(t('mode.required'));
          return;
        }
        actionLock.current = true;
        setActionBusy(true);
        setNote('');
        try {
          await save();
          if (kind === 'review') {
            const result = await onReview({
              ...shot,
              text: accepted.current.text,
              revision: accepted.current.revision,
              shotId: accepted.current.shotId,
            });
            setNote(result.message ?? '已交给导演检查这一镜，回复会出现在左侧对话。');
          } else if (kind === 'sync') {
            setNote('正在让模型转换最新视频提示词…');
            const result = await onSync({ ...shot, text: accepted.current.text, revision: accepted.current.revision, shotId: accepted.current.shotId });
            const syncedText = typeof result.text === 'string' ? result.text : accepted.current.text;
            accepted.current = {
              text: syncedText,
              revision: result.revision ?? accepted.current.revision,
              shotId: result.shotId ?? accepted.current.shotId,
            };
            savedText.current = syncedText;
            setBaseText(syncedText);
            setDraft(syncedText);
            setSaveError('');
            // Say what actually happened. A bare 「已同步」 on an unchanged file is indistinguishable
            // from a dead button, and an unbound `@` is the case that needs the user's attention.
            const unmapped = Array.isArray(result.unmappedMentions) ? result.unmappedMentions : [];
            const sourceAssets = Array.isArray(result.sourceAssetBar) ? result.sourceAssetBar : [];
            const displayedAssets = Array.isArray(result.displayReferences) ? result.displayReferences : [];
            const syncedAssetCount = sourceAssets.length > 0
              ? sourceAssets.length
              : (displayedAssets.length > 0
                ? displayedAssets.length
                : (Array.isArray(result.referenceSlots) ? result.referenceSlots : []).filter((slot) => slot?.mode === 'bound').length);
            const assetNote = `；资产栏已按最新视频提示词同步 ${syncedAssetCount} 项`;
            const fallbackNote = result.modelConversion?.mode === 'deterministic-fallback'
              ? `；模型输出未完成（${String(result.modelConversion.reasonCode ?? '格式不完整')}），已用同一份最新视频提示词的结构化 H3 转换结果完成同步`
              : '';
            if (unmapped.length > 0) {
              setNote(`已同步，但 ${unmapped.join('、')} 没有映射条目：已去掉 @ 当普通文字写进 H3。要作为参考图上传，请写进本段的【人物映射】/【场景映射】/【道具映射】再同步一次${assetNote}${fallbackNote}`);
            } else {
              setNote(result.changed === false
                ? `视频提示词与 H3 已一致${assetNote}${fallbackNote}`
                : `已把当前视频提示词转换为 H3 并自动保存${assetNote}${fallbackNote}`);
            }
          } else {
            const result = await onGenerate(
              shot,
              latest.current,
              settingsRef.current,
              Array.isArray(references?.referenceSlots) ? references.referenceSlots : [],
            );
            setNote(result.message ?? '已提交生成，可在任务中查看');
          }
        } catch (error) { setNote(String(error?.message ?? error)); }
        finally { actionLock.current = false; setActionBusy(false); }
      };

      const insert = async (kind) => {
        if (actionLock.current || actionBusy || saving.current || conflict !== null) return;
        actionLock.current = true;
        setActionBusy(true);
        try {
          try { await save(); } catch { return; }
          setState('saving');
          setNote('');
          try {
            const result = await onInsert({
              shotId: accepted.current.shotId ?? null,
              index: shot.index,
              blockNumber: shot.sourceNumber,
              file: shot.file,
              revision: accepted.current.revision,
            }, kind);
            if (result?.companion !== null && result?.companion !== undefined) {
              setNote(`已新增视频与 H3 对应分镜；新 H3 块可再用“一键同步”细化`);
            }
            setState('idle');
          } catch (error) {
            setState('idle');
            setNote(String(error?.message ?? error));
          }
        } finally {
          actionLock.current = false;
          setActionBusy(false);
        }
      };

      const removeShot = async () => {
        if (!confirmDelete) {
          setConfirmDelete(true);
          setNote('再次点击“确认删除”会同时删除视频提示词和 H3 的对应分镜；删除内容会保存在项目元数据中');
          return;
        }
        if (saving.current || conflict !== null || actionBusy) return;
        actionLock.current = true;
        setActionBusy(true);
        setNote('');
        try {
          await save();
          const result = await onDelete({
            shotId: accepted.current.shotId ?? null,
            index: shot.index,
            blockNumber: shot.sourceNumber,
            file: shot.file,
            revision: accepted.current.revision,
          });
          setNote(result?.companion !== null && result?.companion !== undefined
            ? '已删除视频与 H3 的对应分镜'
            : '已删除这个分镜');
        } catch (error) {
          setNote(String(error?.message ?? error));
          setConfirmDelete(false);
        } finally {
          actionLock.current = false;
          setActionBusy(false);
        }
      };

      return h('div', {
        'data-dsh-shot-card': shot.shotId ?? `${shot.file ?? ''}#${shot.index}`,
        'data-dsh-shot-state': productionState?.state ?? 'unknown',
        'data-open': open ? 'true' : 'false',
        className: 'sdd-card',
        // In the workbench one 大分镜 claims a full screen: three columns of real work need the height,
        // and a card that is only as tall as its prompt leaves the preview and the asset grid cramped.
        // A workbench card claims a screen, but ONLY through its content area.
        //
        // The card is a flex column and the body below the header takes `flex: 1`, so the spare height
        // goes into the three columns. The save-state footer keeps its natural height - when the CARD
        // itself carried the height, the footer was the last child and swallowed every spare pixel,
        // which is why 「已自动保存」 turned into a huge band.
        style: wide && open
          ? {
            ...css.card,
            position: 'relative',
            height: '100%',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }
          : { ...css.card, position: 'relative' },
      },
        h('div', {
          className: 'sdd-card-head',
          style: css.cardHead,
          onClick: () => {
            const next = !open;
            setOpen(next);
            if (next && typeof onFocus === 'function') onFocus(shot);
          },
          role: 'button',
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              const next = !open;
              setOpen(next);
              if (next && typeof onFocus === 'function') onFocus(shot);
            }
          },
        },
          h('span', { style: css.caret }, open ? '▾' : '▸'),
          h('span', { className: 'sdd-card-title', style: css.cardTitle }, displayShotText(shot.title)),
          productionState === null
            ? null
            : h('span', {
              'data-dsh-shot-status': productionState.state,
              className: 'sdd-status',
              title: productionState.reason ?? '',
              style: css.productionTag(productionState.state),
            }, SHOT_STATE_LABELS[productionState.state] ?? productionState.state),
          sourceSwitch === null || sourceSwitch === undefined
            ? null
            : h('span', { className: 'sdd-card-source-host' }, sourceSwitch),
          // The header carries the number and nothing else. It used to also show the FILE this
          // 大分镜 saves back into and the duration parsed from the heading; the user asked for both
          // to go, and neither is lost by removing them: the file is what the panel's source picker
          // names, and the duration still shows in the 生成视频 panel, which is where it is actually
          // chosen. Keeping a still-visible number here would also be a second reading of one value
          // the heading already states.
          //
          // The buttons must not toggle the card, so their clicks stop here.
          h('span', {
            className: 'sdd-card-actions',
            style: css.headActions,
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => event.stopPropagation(),
          },
            h('button', {
              type: 'button',
              className: 'sdd-mini-btn',
              style: css.miniButton,
              disabled: actionBusy || state === 'saving' || conflict !== null || modeReady !== true,
              title: modeReady === true ? '让导演只读检查这一镜，不改文件、不生成' : t('mode.required'),
              onClick: () => { void runAction('review'); },
            },
            h(SddIcon, { name: actionBusy ? 'loader-circle' : 'scan-eye' }),
            actionBusy ? '处理中…' : '审镜'),
            h('button', {
              type: 'button',
              className: 'sdd-mini-btn',
              style: css.miniButton,
              disabled: actionBusy || state === 'saving' || conflict !== null,
              title: t('copyHint'),
              onClick: () => insert('copy'),
            }, `⧉ ${t('copy')}`),
            h('button', {
              type: 'button',
              className: 'sdd-mini-btn',
              style: css.miniButton,
              disabled: actionBusy || state === 'saving' || conflict !== null,
              title: t('addHint'),
              onClick: () => insert('blank'),
            }, `＋ ${t('add')}`),
            h('button', {
              type: 'button',
              className: 'sdd-mini-btn',
              style: confirmDelete ? { ...css.miniButton, color: 'var(--sdd-danger, #d14343)' } : css.miniButton,
              disabled: actionBusy || state === 'saving' || conflict !== null,
              title: confirmDelete ? '确认同时删除视频提示词与 H3 的对应分镜' : '删除这个分镜',
              onClick: () => { void removeShot(); },
            }, h(SddIcon, { name: 'trash-2', size: 12 }), confirmDelete ? '确认删除' : '删除'),
          ),
        ),
        open && h('div', {
          // The body owns the spare height; the footer below it is `flex: none` so it stays one line.
          style: wide ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '6px' } : null,
        },
          // Workbench layout: the prompt and its references sit side by side instead of stacked.
          //
          // Only these two blocks are regrouped. Everything else on the card (draft conflict, save
          // state, generation controls) stays in normal flow below, so this cannot disturb the
          // editing path - `minWidth: 0` on both cells is what keeps a long prompt from pushing into
          // the reference column, which is the failure the earlier grid attempt had.
          h('div', {
            ref: wide ? widePaneRef : null,
            className: wide ? 'sdd-shot-workbench-grid' : undefined,
            'data-dsh-drama-pane-layout': wide ? 'true' : undefined,
            style: wide
              // 资产 ｜ 提示词 ｜ 视频预览, separated by two draggable splitters.
              ? {
                display: 'grid',
                gridTemplateColumns: `${displayedWidePaneWidths.assets}px 8px ${displayedWidePaneWidths.prompt}px 8px minmax(${DRAMA_PANE_MIN_WIDTHS.preview}px, 1fr)`,
                gap: 0,
                alignItems: 'stretch',
                flex: '1 1 auto',
                minHeight: 0,
              }
              : null,
          },
            // 左：资产，按类别分组的可折叠缩略图网格
            h('div', {
              'data-dsh-asset-column': 'true',
              className: 'sdd-shot-panel sdd-shot-reference-panel',
              style: wide
                ? {
                  minWidth: 0,
                  minHeight: 0,
                  height: '100%',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '9px',
                  border: '1px solid var(--sdd-border)',
                  borderRadius: '7px',
                  background: 'var(--sdd-subtle)',
                }
                : null,
            },
              wide
                ? [
                  h('div', { key: 'reference-head', className: 'sdd-shot-column-head' },
                    h('strong', null, '本镜参考'),
                    h('span', null, `${String((references?.references ?? []).length)} 项已绑定`)),
                  /**
                   * 「清理无法解析的引用」 - one press removes every reference line whose name matches
                   * nothing in the library.
                   *
                   * A block accumulates these from earlier uploads that wrote a file name instead of an
                   * asset name, and each one blocks generation. They are safe to delete: an unresolved
                   * reference contributes no upload, so removing it changes nothing except the error.
                   * Rendered only in the workbench, where there is room for it.
                   */
                  h('div', { key: 'asset-tools', style: { display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '2px' } },
                    h('button', {
                      type: 'button',
                      'data-dsh-clean-unresolved': 'true',
                      // Never disabled, and it always REPORTS what it did: a silent no-op is
                      // indistinguishable from a broken button, which is exactly what 「点了没反应」 was.
                      onClick: () => {
                        const ambiguous = references?.ambiguous?.length ?? 0;
                        if (cleanCount === 0 && ambiguous > 0) {
                          // An ambiguous mention is not a missing name, so it is not safe to delete
                          // it from the prompt. Ask the Host again instead: a stale answer from an
                          // older Host is exactly what made five valid `@外卖袋` look unresolvable
                          // while every name still existed in the library.
                          setCleanNote(`Host 报的是二义（${ambiguous} 条），不是名字缺失；正在重新解析引用`);
                          if (typeof onRequestReferences === 'function') onRequestReferences(shot, latest.current);
                          return;
                        }
                        setCleanNote(cleanCount === 0
                          ? '没有可清理的引用（每个名字都在资产库里）'
                          : `已清理 ${cleanCount} 条`);
                        cleanUnresolved();
                      },
                      title: '删掉所有指向库里不存在的资产的引用',
                      style: { ...css.miniButton, fontSize: '10px' },
                    }, `清理无法解析的引用${cleanCount === 0 ? '' : `（${cleanCount}）`}`),
                    cleanNote.length > 0 ? h('span', { 'data-dsh-clean-note': 'true', style: { fontSize: '10px', opacity: 0.7 } }, cleanNote) : null,
                    // Manual re-resolve. The automatic path runs only when the block identity changes, so
                    // after a HOST fix the panel can keep showing the previous answer until something forces
                    // a round trip - which looks exactly like the fix not working.
                    h('button', {
                      type: 'button',
                      'data-dsh-resolve-now': 'true',
                      onClick: () => {
                        setCleanNote('');
                        if (typeof onRequestReferences === 'function') onRequestReferences(shot, latest.current);
                      },
                      title: '重新解析本块的引用（Host 重启后用它刷新状态）',
                      style: { ...css.miniButton, fontSize: '10px' },
                    }, '重新解析引用'),
                    // What the HOST could not bind, verbatim - including AMBIGUOUS ones, which is what
                    // 「5 个待修」 actually was: a name that matches more than one asset, so nothing can be
                    // chosen. Printing only `unresolved` showed nothing and the count could not be explained.
                    ((references?.unresolved ?? []).length + (references?.ambiguous ?? []).length) > 0
                      ? h('span', { 'data-dsh-host-unresolved': 'true', style: { fontSize: '10px', color: 'var(--sdd-danger)', wordBreak: 'break-all' } },
                        `Host 未解析：${[...(references?.unresolved ?? []), ...(references?.ambiguous ?? [])].map((item) => String(item.text ?? '')).join('；')}`)
                      : null,
                  ),
                  (shot.h3 === true
                    ? h3SlotGroups({ t, references, previewUrl, uploading: h3Uploading, onUploading: setH3Uploading, onError: setCleanNote, onPickProject: ({ slot, slotNumber }) => openProjectAssetPicker('h3', {
                      prefix: slot.prefix,
                      slotNumber,
                      mediaKind: h3MediaKind(slot.prefix),
                      allowedKinds: h3AllowedKinds(slot.prefix),
                      title: `为 ${slot.name} ${String(slotNumber)} 选择项目资产`,
                    }), onUpload: async (payload) => {
                    // Import first, then bind: the slot only fills once the prompt references the file.
                    const imported = await onUpload(payload);
                    const prefix = payload.kindFilter === 'reference-audio' ? 'Audio' : payload.kindFilter === 'reference-video' ? 'Video' : 'Picture';
                    // The library's name (`外卖袋`) rather than the file name (`外卖袋_00001_`): only the
                    // library name resolves on the next parse.
                    const bound = String(imported?.name ?? String(payload.fileName ?? '').replace(/\.[^.]+$/u, ''));
                    const result = applyH3SlotAsset(imported, prefix, payload.slotNumber, bound);
                    if (prefix === 'Audio') {
                      setCleanNote(`音频已接入 <Audio ${String(payload.slotNumber)}>。生成前可点“一键同步”绑定到本镜说话人 (Sx)。`);
                    }
                    return result;
                  }, onRemove: removeH3Reference, onChanged: (result) => {
                    if (typeof onRequestReferences === 'function') {
                      onRequestReferences(shot, result?.draft ?? latest.current, null, result?.referenceSlots ?? null);
                    }
                  } })
                  : assetGroups(
                    t, references, previewUrl, assets, false, onUpload, appendAssetReference, removeMention,
                    (name, choice) => {
                      if (typeof onRequestReferences === 'function') {
                        onRequestReferences(shot, latest.current, { [name]: choice });
                      }
                    },
                    ({ category, allowedKinds, title }) => openProjectAssetPicker('video', {
                      mediaKind: 'image',
                      allowedKinds,
                      category,
                      title,
                    }),
                  )),
                ]
                : [references !== null && h(ReferencesBar, { t, references, previewUrl })],
            ),
            h('div', {
              className: 'sdd-shot-splitter',
              role: 'separator',
              tabIndex: 0,
              'aria-label': '调节本镜参考与提示词宽度',
              'aria-orientation': 'vertical',
              'aria-valuemin': DRAMA_PANE_MIN_WIDTHS.assets,
              'aria-valuemax': displayedWidePaneWidths.assets + displayedWidePaneWidths.prompt - DRAMA_PANE_MIN_WIDTHS.prompt,
              'aria-valuenow': displayedWidePaneWidths.assets,
              'data-dsh-drama-splitter': 'assets-prompt',
              onPointerDown: (event) => beginWidePaneResize('assets-prompt', event),
              onKeyDown: (event) => nudgeWidePane('assets-prompt', event),
            }),
            // 中：提示词
            h('div', {
              className: wide ? 'sdd-shot-panel sdd-shot-prompt-panel' : undefined,
              style: wide
                ? {
                  minWidth: 0,
                  minHeight: 0,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '9px',
                  border: '1px solid var(--sdd-border)',
                  borderRadius: '7px',
                  background: 'var(--sdd-surface)',
                }
                : null,
            },
              wide && h('div', { className: 'sdd-shot-column-head' },
                h('strong', null, shot.h3 === true ? 'H3 提示词' : '视频提示词')),
              h(PromptEditor, {
                t,
                value: draft,
                assets: mentionAssets,
                mediaUrl,
                previewUrl,
                onLiveChange: (next) => { latest.current = next; },
                onChange: setDraft,
                deferCommitMs: 160,
                allowMentions: shot.h3 !== true,
              }),
            ),
            h('div', {
              className: 'sdd-shot-splitter',
              role: 'separator',
              tabIndex: 0,
              'aria-label': '调节提示词与视频预览宽度',
              'aria-orientation': 'vertical',
              'aria-valuemin': DRAMA_PANE_MIN_WIDTHS.prompt,
              'aria-valuemax': Math.max(
                DRAMA_PANE_MIN_WIDTHS.prompt,
                widePaneContainerWidth - DRAMA_PANE_SPLITTER_TOTAL
                  - displayedWidePaneWidths.assets - DRAMA_PANE_MIN_WIDTHS.preview,
              ),
              'aria-valuenow': displayedWidePaneWidths.prompt,
              'data-dsh-drama-splitter': 'prompt-preview',
              onPointerDown: (event) => beginWidePaneResize('prompt-preview', event),
              onKeyDown: (event) => nudgeWidePane('prompt-preview', event),
            }),
            h('div', {
              'data-dsh-preview': 'true',
              className: 'sdd-shot-panel sdd-shot-preview-panel',
              style: wide
                ? {
                  minWidth: 0,
                  minHeight: 0,
                  height: '100%',
                  overflow: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  border: '1px solid var(--sdd-border)',
                  borderRadius: '7px',
                  padding: '9px',
                  background: 'var(--sdd-subtle)',
                }
                : { display: 'none' },
            },
              wide && h('div', { className: 'sdd-shot-column-head' },
                h('strong', null, '视频预览')),
              activePreviewCandidate === null
                ? h('div', { className: 'sdd-preview-empty' },
                  h(SddIcon, { name: 'monitor-play', size: 24 }),
                  h('span', null, '生成后可在这里预览'))
                : h('div', { className: 'sdd-preview-active' },
                  activePreviewCandidate.mediaHandle !== undefined
                    && activePreviewCandidate.mediaHandle !== null
                    && (previewUrl !== undefined || mediaUrl !== undefined)
                    ? (mediaKindOf(activePreviewCandidate.fileName ?? activePreviewCandidate.relativePath) === 'video'
                      ? h(PreviewVideo, {
                        'data-dsh-active-video': activePreviewCandidate.candidateId,
                        src: previewUrl(activePreviewCandidate.mediaHandle),
                        fallbackLabel: '视频',
                        style: { width: '100%', height: '100%', minHeight: '360px', background: '#000', borderRadius: '6px', objectFit: 'contain' },
                      })
                      : h(PreviewImage, {
                        'data-dsh-active-image': activePreviewCandidate.candidateId,
                        src: previewUrl(activePreviewCandidate.mediaHandle),
                        alt: activePreviewCandidate.displayName ?? '',
                        loading: 'lazy',
                        style: { width: '100%', maxHeight: '300px', objectFit: 'contain', borderRadius: '6px' },
                      }))
                    : h('div', { style: css.note }, activePreviewCandidate.displayName ?? activePreviewCandidate.fileName ?? '（无预览）'),
                  h('div', { className: 'sdd-preview-caption' },
                    h('strong', null, String(activePreviewCandidate.displayName ?? activePreviewCandidate.fileName ?? '')),
                    h('span', null, String(activePreviewCandidate.status ?? 'candidate')))),
              videoCacheStrip,
            ),
          ),
          // The file changed while this draft was open. Both versions are real work, so the panel
          // shows both and writes neither until the user chooses. Silently preferring one is how the
          // other is lost - and the user cannot tell which happened.
          conflict === null ? null : h('div', { style: css.resultNote, 'data-dsh-draft-conflict': 'true' },
            h('div', null, t('draft.conflict')),
            h('div', { style: css.resultMeta }, `${t('draft.conflictDisk')}: ${conflict.diskText.slice(0, 60)}${conflict.diskText.length > 60 ? '…' : ''}`),
            h('div', { style: css.resultMeta }, `${t('draft.conflictMine')}: ${conflict.draftText.slice(0, 60)}${conflict.draftText.length > 60 ? '…' : ''}`),
            h('div', { style: css.row },
              h('button', {
                type: 'button',
                style: css.miniButton,
                'data-dsh-draft-choice': 'disk',
                // Discard the draft and show the file. The draft is removed only here, by an explicit
                // choice, never as a side effect of something else.
                onClick: () => {
                  if (draftKey !== null) draftStore.clear(draftKey.project, draftKey.file, draftKey.shotId);
                  setDraft(shot.text);
                  setConflict(null);
                  setRestored(false);
                  setNote(t('draft.tookDisk'));
                },
              }, t('draft.useDisk')),
              h('button', {
                type: 'button',
                style: css.miniButton,
                'data-dsh-draft-choice': 'mine',
                // Keep the draft. Saving it afterwards overwrites the file, which is why this is a
                // deliberate press rather than the default.
                onClick: () => { setConflict(null); setNote(t('draft.keptMine')); },
              }, t('draft.keepMine')),
              h('button', {
                type: 'button',
                style: css.miniButton,
                'data-dsh-draft-choice': 'both',
                // Neither is thrown away: the file's version is appended below the draft so the user
                // can merge by hand. Losing the ability to compare is worse than a longer edit.
                onClick: () => {
                  setDraft(`${conflict.draftText}\n\n${t('draft.conflictMarker')}\n${conflict.diskText}`);
                  setConflict(null);
                  setNote(t('draft.keptBoth'));
                },
              }, t('draft.keepBoth')),
            ),
          ),
          visibleNote.length > 0 && h('div', {
            className: 'sdd-card-note',
            'data-dsh-card-note': 'true',
            role: 'status',
            style: {
              position: 'absolute',
              top: '50px',
              right: '12px',
              zIndex: 4,
              maxWidth: 'min(360px, calc(100% - 24px))',
              padding: '6px 9px',
              border: '1px solid var(--sdd-border)',
              borderRadius: '6px',
              background: 'var(--sdd-surface)',
              boxShadow: 'var(--sdd-shadow-md)',
              color: 'var(--sdd-muted)',
              fontSize: '10.5px',
              lineHeight: 1.45,
              pointerEvents: 'none',
            },
          }, displayShotText(visibleNote)),
          (saveError || (restored && dirty))
            ? h('div', {
              className: 'sdd-card-foot',
              style: css.cardFoot,
            },
            saveError && h('span', { style: css.error, role: 'alert' }, `自动保存失败，草稿已保留：${saveError}`),
            saveError && h('button', { type: 'button', style: css.miniButton, onClick: () => { setSaveError(''); } }, '重试'),
            // A refusal that is a BOUNDARY, not a hiccup: retrying fails exactly the same way, so
            // the useful action is to get the text back out of the browser. The draft is the only
            // copy that exists at that moment.
            saveError && h('button', {
              type: 'button',
              style: css.miniButton,
              'data-dsh-copy-draft': 'true',
              onClick: () => {
                void copyText(latest.current).then((ok) => setNote(ok
                  ? '草稿已复制到剪贴板'
                  : '复制失败：请在编辑器里手动全选复制'));
              },
            }, '复制草稿'),
            // Restored text that looked like the file's own is how someone saves a half-finished
            // paragraph over a finished one, so the fact is stated rather than implied.
            restored && dirty && h('span', { style: css.drift }, t('draft.restored')),
          ) : null,
          shot.h3 === true && h('div', {
            className: 'sdd-generation-controls',
            style: {
              ...css.row,
              padding: '9px 11px',
              borderTop: '1px solid var(--dsw-border-default, #e1e5ea)',
              background: 'var(--dsw-surface-raised, #ffffff)',
            },
            'data-dsh-generation-controls': 'true',
          },
            h('button', {
              type: 'button',
              style: css.button(false),
              disabled: actionBusy || state === 'saving' || conflict !== null || modeReady !== true,
              title: modeReady === true ? undefined : t('mode.required'),
              onClick: () => runAction('sync'),
            },
            h(SddIcon, { name: actionBusy ? 'loader-circle' : 'refresh-cw' }),
            actionBusy ? '处理中…' : '一键同步'),
            ...['drama', 'action'].map((mode) => h('button', { type: 'button', key: mode, style: css.sourceButton(settings?.mode === mode), 'aria-pressed': settings?.mode === mode, onClick: () => updateSettings({ mode }) }, mode === 'drama' ? '文戏' : '武打')),
            h('select', { style: css.select, 'aria-label': '清晰度', value: settings?.resolution ?? '720p', onChange: (event) => updateSettings({ resolution: event.target.value }) }, ['480p', '720p', '1080p'].map((value) => h('option', { key: value, value }, value))),
            h('select', {
              style: css.select,
              'aria-label': '宽高比',
              'data-dsh-generation-aspect': 'true',
              value: settings?.aspectRatio ?? '9:16',
              onChange: (event) => updateSettings({ aspectRatio: event.target.value }),
            }, ['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'].map((value) => h('option', { key: value, value }, value))),
            // 时长. The 大分镜 heading already states one, so that is the default and the list is offered
            // as an override - the heading stays the content's own record, and a generation may still ask
            // for a different length without editing the prompt. H3 accepts 4–15 seconds inclusive, so a
            // heading outside that range cannot be the default; it is then shown as a disabled option
            // rather than silently replaced, because a value the file states must not vanish.
            h('select', {
              style: css.select,
              'aria-label': '时长',
              'data-dsh-generation-seconds': 'true',
              value: String(settings?.seconds ?? shot.seconds ?? ''),
              onChange: (event) => updateSettings({ seconds: Number(event.target.value) }),
            },
            (() => {
              const options = [];
              const fromHeading = Number.isInteger(shot.seconds) ? shot.seconds : null;
              if (fromHeading !== null && (fromHeading < 4 || fromHeading > 15)) {
                options.push(h('option', { key: 'heading', value: String(fromHeading), disabled: true }, `${String(fromHeading)}s（超出 4–15）`));
              }
              for (let seconds = 4; seconds <= 15; seconds += 1) options.push(h('option', { key: seconds, value: String(seconds) }, `${String(seconds)}s`));
              return options;
            })()),
            // Generation is BLOCKED while a reference is unresolved, and the button says so instead
            // of letting the user press it and wait for the Host to refuse. The bar below already
            // explains why; a button that looks pressable and then fails ~1 s later reads as the
            // panel being broken rather than as the prompt needing one more binding.
            h('button', {
              type: 'button',
              style: css.button(true),
              disabled: actionBusy || state === 'saving' || conflict !== null || referencesBlocked || modeReady !== true,
              title: modeReady !== true ? t('mode.required') : (referencesBlocked ? t('ref.blocked') : undefined),
              'data-dsh-generate': 'true',
              onClick: () => runAction('generate'),
            },
            h(SddIcon, { name: actionBusy ? 'loader-circle' : 'play' }),
            actionBusy ? '处理中…' : (modeReady !== true ? t('mode.locked') : (referencesBlocked ? t('ref.blockedShort') : '生成视频'))),
          ),
          h(GeneralAssetPicker, {
            open: projectAssetPicker !== null,
            title: projectAssetPicker?.title ?? '选择项目资产',
            assets,
            task: 'video-generation',
            mediaKind: projectAssetPicker?.mediaKind ?? 'image',
            allowedKinds: projectAssetPicker?.allowedKinds ?? null,
            previewUrl,
            onChoose: chooseProjectAsset,
            onClose: () => setProjectAssetPicker(null),
          }),
        ),
      );
    }

    /** Characters an asset name may contain, mirroring the Host's parser. */
    const MENTION_CHAR = /[\p{L}\p{N}（）()·・\-_.]/u;

    /**
     * The `@…` being typed at the caret, if there is one.
     *
     * Returns the query and the span it occupies so the picker can replace exactly that text.
     * `caret` is a UTF-16 offset, which is what a textarea reports and what `String.slice`
     * counts, so the two never disagree - including in front of an emoji.
     */
    function mentionAtCaret(text, caret) {
      if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
      let start = caret;
      while (start > 0 && MENTION_CHAR.test(text[start - 1])) start -= 1;
      if (start === 0 || text[start - 1] !== '@') return null;
      // A second `@` inside the same run means the run starts at the LATER one, so the query is
      // what follows it - otherwise `a@b@林` would offer a picker for `b@林`.
      const run = text.slice(start, caret);
      if (run.includes('@')) return null;
      return { start: start - 1, end: caret, query: run };
    }

    /**
     * One asset picker row: the asset, and for a character with costumes, one row per variant.
     *
     * Variants are listed rather than hidden behind the asset, because the mention TEXT differs
     * between them (`@林晚` and `@林晚（家居服）` are different references). Offering only the
     * asset and silently binding the identity variant would make the costume unreachable from
     * the picker.
     */
    function mentionCandidates(assets, query) {
      const needle = String(query ?? '').trim().toLowerCase();
      const out = [];
      const imageScore = (entry) => (entry.thumbnail !== null && entry.thumbnail !== undefined
        || entry.thumbnailPreview !== null && entry.thumbnailPreview !== undefined ? 4 : 0)
        + ((entry.roles ?? []).length > 0 ? 1 : 0);
      for (const asset of assets ?? []) {
        const names = [asset.name, ...(asset.aliases ?? [])];
        const variants = asset.variants ?? [];
        // The identity variant needs no suffix; the others do.
        const hasIdentity = variants.length > 1;
        const perMention = new Map();
        for (const variant of variants.length === 0 ? [{ variantId: null, name: 'default', roles: [] }] : variants) {
          const needsSuffix = hasIdentity && variant.name !== 'default' && variants.length > 1 && asset.identityVariant !== variant.name;
          const defaultText = needsSuffix ? `@${asset.name}（${variant.name}）` : `@${asset.name}`;
          const defaultLabel = needsSuffix ? `${asset.name}（${variant.name}）` : asset.name;
          const text = typeof variant.mentionText === 'string' && variant.mentionText.length > 0
            ? variant.mentionText
            : defaultText;
          const label = typeof variant.mentionLabel === 'string' && variant.mentionLabel.length > 0
            ? variant.mentionLabel
            : defaultLabel;
          const haystack = `${label} ${names.join(' ')} ${asset.kind}`.toLowerCase();
          if (needle.length > 0 && !haystack.includes(needle)) continue;
          const candidate = {
            key: `${asset.assetId}:${variant.variantId ?? 'x'}`,
            text,
            label,
            kind: asset.kind,
            variantName: variant.name,
            roles: variant.roles ?? [],
            // The picker shows a picture per candidate; the scaled handle is what makes that cheap.
            thumbnail: variant.thumbnailHandle
              ?? asset.thumbnailHandles?.[variant.variantId]
              ?? asset.thumbnails?.[variant.variantId]
              ?? null,
            thumbnailPreview: variant.thumbnailPreview
              ?? asset.thumbnailPreviews?.[variant.variantId]
              ?? asset.thumbnailPreview
              ?? null,
          };
          /**
           * A character model can carry both a `default` placeholder and a named identity variant.
           * Both spell the same mention (`@林晚`), but only one owns the picture. Keep one row and
           * prefer the image-bearing identity variant; actual costume variants have different text
           * and are still listed separately.
           */
          const previous = perMention.get(text);
          if (previous === undefined) {
            perMention.set(text, candidate);
            continue;
          }
          const score = (entry) => imageScore(entry)
            + (entry.variantName === asset.identityVariant ? 2 : 0)
            + (entry.variantName !== 'default' ? 1 : 0);
          if (score(candidate) > score(previous)) perMention.set(text, candidate);
        }
        out.push(...perMention.values());
      }
      /**
       * Cross-category duplicates are common after an asset has both a typed record and an imported
       * reference image. If the final text is identical and only one side has a picture, keep the
       * picture. Two genuinely different categories with their own pictures remain separate.
       */
      const merged = [];
      for (const candidate of out) {
        const at = merged.findIndex((entry) => entry.text === candidate.text);
        if (at < 0) {
          merged.push(candidate);
          continue;
        }
        const previous = merged[at];
        const sameKind = previous.kind === candidate.kind;
        const pictureMismatch = (previous.thumbnail === null || previous.thumbnail === undefined)
          !== (candidate.thumbnail === null || candidate.thumbnail === undefined);
        if (sameKind || pictureMismatch) {
          if (imageScore(candidate) > imageScore(previous)) merged[at] = candidate;
          continue;
        }
        merged.push(candidate);
      }
      return merged.slice(0, 40);
    }

    /**
     * One mention candidate per tile in THIS block's left asset column.
     *
     * The `@` menu is a shortcut for what is already bound to the shot, not a second library
     * browser. Building directly from resolved references keeps deleted/stale audio and unrelated
     * assets out, avoids expanding a character into every costume variant, and covers picture,
     * audio and video references because all of them participate in the mapping sections.
     */
    function mentionAssetsForReferences(references) {
      const resolved = (references?.references ?? []).filter((entry) =>
        entry?.bindingState === 'resolved'
        && typeof (entry.assetName ?? entry.name) === 'string'
        && String(entry.assetName ?? entry.name).trim().length > 0);
      if (resolved.length === 0) return [];

      const byKey = new Map();
      for (const [index, entry] of resolved.entries()) {
        const name = String(entry.assetName ?? entry.name).trim();
        const variantName = typeof entry.variantName === 'string' ? entry.variantName : 'default';
        const display = typeof entry.display === 'string' && entry.display.startsWith('@')
          ? entry.display.trim()
          : null;
        const identityLike = variantName === 'default' || variantName.length === 0;
        const text = display ?? (identityLike ? `@${name}` : `@${name}（${variantName}）`);
        const declaredKind = entry.assetKind ?? entry.kind ?? null;
        const sourceName = String(entry.fileName ?? entry.relativePath ?? '');
        const mediaType = entry.mediaType
          ?? (/\.(?:mp3|wav|flac|ogg|m4a|aac)$/iu.test(sourceName) ? 'Audio'
            : /\.(?:mp4|webm|mov|mkv)$/iu.test(sourceName) ? 'Video'
              : null);
        const kind = mediaType === 'Audio' || declaredKind === 'reference-audio'
          ? 'reference-audio'
          : mediaType === 'Video' || declaredKind === 'reference-video'
            ? 'reference-video'
            : ['character', 'scene', 'prop'].includes(declaredKind) ? declaredKind : 'reference-image';
        const dedupeKey = `${kind}\0${text}`;
        const variantId = String(entry.variantId ?? `${entry.assetId ?? name}:${variantName}:${index}`);
        const thumbnail = entry.thumbnailHandle ?? null;
        const row = {
          assetId: `mention:${entry.assetId ?? name}:${variantId}:${index}`,
          kind,
          name: text.slice(1),
          aliases: [],
          identityVariant: 'default',
          variants: [{
            variantId,
            name: 'default',
            roles: typeof entry.role === 'string' ? [entry.role] : [],
            mentionText: text,
            mentionLabel: text.slice(1),
            thumbnailHandle: thumbnail,
          }],
          thumbnails: thumbnail === null ? {} : { [variantId]: thumbnail },
          thumbnailHandles: thumbnail === null ? {} : { [variantId]: thumbnail },
        };
        const previous = byKey.get(dedupeKey);
        if (previous === undefined || (thumbnail !== null && previous.variants?.[0]?.thumbnailHandle == null)) {
          byKey.set(dedupeKey, row);
        }
      }
      return [...byKey.values()];
    }

    /** The `@` menu for general video uses only the slots already present in its left asset bar. */
    function mentionAssetsForGeneralMedia(media, previews = {}) {
      const slotEntries = (Array.isArray(media) ? media : [])
        .filter((entry) => Number.isInteger(entry?.slotNumber) && entry.slotNumber > 0)
        .map((entry) => {
          const stem = String(entry.fileName ?? '').replace(/\.[^.]+$/u, '');
          const label = String(entry.label ?? '').replace(/^@/u, '').trim();
          const base = stem.trim() || label || `资产${String(entry.slotNumber)}`;
          const kind = entry.kind === 'audio' ? 'reference-audio'
            : entry.kind === 'video' ? 'reference-video'
              : 'reference-image';
          const prefix = entry.kind === 'audio' ? 'Audio' : entry.kind === 'video' ? 'Video' : 'Picture';
          return { entry, base, kind, prefix };
        });
      const counts = new Map();
      for (const row of slotEntries) counts.set(row.base, (counts.get(row.base) ?? 0) + 1);
      return slotEntries.map(({ entry, base, kind, prefix }, index) => {
        const label = (counts.get(base) ?? 0) > 1 ? `${base}（${prefix} ${String(entry.slotNumber)}）` : base;
        const mentionText = `@${label} `;
        const thumbnail = entry.thumbnailHandle
          ?? (entry.kind === 'image' ? entry.mediaHandle ?? null : null);
        const thumbnailPreview = previews[entry.id] ?? null;
        return {
          assetId: `general-slot:${kind}:${String(entry.slotNumber)}:${String(index)}`,
          kind,
          name: label,
          aliases: [],
          identityVariant: 'default',
          slotNumber: entry.slotNumber,
          prefix,
          variants: [{
            variantId: `slot-${String(entry.slotNumber)}`,
            name: 'default',
            roles: [],
            mentionText,
            mentionLabel: label,
            thumbnailHandle: thumbnail,
            thumbnailPreview,
          }],
          thumbnails: thumbnail === null ? {} : { [`slot-${String(entry.slotNumber)}`]: thumbnail },
          thumbnailHandles: thumbnail === null ? {} : { [`slot-${String(entry.slotNumber)}`]: thumbnail },
          thumbnailPreviews: thumbnailPreview === null ? {} : { [`slot-${String(entry.slotNumber)}`]: thumbnailPreview },
        };
      });
    }

    /**
     * Resolve visible `@asset` mentions into H3 slot tags at submit time.
     *
     * This is deliberately one-way: it changes only the text sent to ComfyUI. Adding or removing
     * a prompt mention never adds or removes an entry from the left asset bar.
     */
    function promptWithH3Mentions(value, mentionAssets) {
      const mapping = new Map((mentionAssets ?? [])
        .map((asset) => [`@${asset.name}`, `<${asset.prefix} ${String(asset.slotNumber)}>`])
        .sort((left, right) => right[0].length - left[0].length));
      return String(value ?? '').replace(/@[\p{L}\p{N}（）()·・\-_.]+/gu, (token) => mapping.get(token) ?? token);
    }

    const KIND_LABEL = { character: '人物', scene: '场景', prop: '道具', 'reference-image': '其他参考图片', 'reference-video': '参考视频', 'reference-audio': '参考音频' };
    const KIND_COLOR = { character: '#72a7ff', scene: '#55c7a1', prop: '#efba67', 'reference-image': '#c09bff', 'reference-video': '#ef91c6', 'reference-audio': '#65cedc', 'reference-media': '#ef91c6' };
    const isMediaKind = (kind) => ['reference-video', 'reference-audio', 'reference-media'].includes(kind);

    /**
     * A fixed visual stand-in for media that has no image thumbnail.
     *
     * Audio and video used to be drawn as text glyphs. Those glyphs inherit the surrounding font
     * and could collapse to an empty white box in the embedded renderer, which made a perfectly
     * valid upload look missing. The vector glyph and its tinted surface are now independent of
     * font coverage and work in both themes.
     */
    function MediaPlaceholder({ kind, compact = false, label, style }) {
      const audio = kind === 'audio';
      const name = audio ? 'audio-lines' : 'video';
      return h('div', {
        className: `sdd-media-placeholder sdd-media-placeholder-${audio ? 'audio' : 'video'}${compact ? ' compact' : ''}`,
        'data-dsh-media-placeholder': audio ? 'audio' : 'video',
        role: 'img',
        'aria-label': label ?? (audio ? '音频' : '视频'),
        style,
      },
        h('span', { className: 'sdd-media-placeholder-icon' },
          h(SddIcon, { name, size: compact ? 18 : 26 })),
        compact ? null : h('span', { className: 'sdd-media-placeholder-label' }, audio ? '音频' : '视频'),
      );
    }

    // A textarea preserves native editing, selection and IME. A matching, non-interactive layer
    // supplies the colours; every node is plain React text, so prompt HTML cannot execute.
    function highlightedPrompt(value, assets, anchorOffset = null, anchorRef = null) {
      const text = String(value);
      const result = [];
      const pattern = /@[\p{L}\p{N}（）()·・\-_.]+/gu;
      let offset = 0;
      let markerInserted = false;
      const marker = () => {
        markerInserted = true;
        return h('span', {
          key: `caret-anchor-${String(anchorOffset)}`,
          ref: anchorRef,
          'data-dsh-caret-anchor': 'true',
          style: {
            display: 'inline-block',
            width: 0,
            height: '1em',
            overflow: 'hidden',
            verticalAlign: 'baseline',
          },
        }, '\u200b');
      };
      const pushPlain = (segment, start) => {
        if (!markerInserted && anchorOffset !== null
          && anchorOffset >= start && anchorOffset <= start + segment.length) {
          const inside = anchorOffset - start;
          result.push(segment.slice(0, inside), marker(), segment.slice(inside));
          return;
        }
        result.push(segment);
      };
      const pushToken = (token, start, color) => {
        if (!markerInserted && anchorOffset !== null
          && anchorOffset >= start && anchorOffset <= start + token.length) {
          const inside = anchorOffset - start;
          if (inside > 0) {
            result.push(h('span', {
              key: `${String(start)}-before`,
              style: { color, WebkitTextFillColor: color },
            }, token.slice(0, inside)));
          }
          result.push(marker());
          if (inside < token.length) {
            result.push(h('span', {
              key: `${String(start)}-after`,
              style: { color, WebkitTextFillColor: color },
            }, token.slice(inside)));
          }
          return;
        }
        result.push(h('span', {
          key: start,
          'data-dsh-highlight': token,
          style: { color, WebkitTextFillColor: color },
        }, token));
      };
      for (const match of text.matchAll(pattern)) {
        let token = match[0];
        while ((token.match(/[）)]/gu) ?? []).length > (token.match(/[（(]/gu) ?? []).length && /[）)]$/u.test(token)) token = token.slice(0, -1);
        token = token.replace(/[.\-·]+$/u, '');
        if (token.length < 2) continue;
        pushPlain(text.slice(offset, match.index), offset);
        const name = token.slice(1);
        const asset = (assets ?? []).find((entry) => entry.name === name || (entry.aliases ?? []).includes(name)
          || (entry.variants ?? []).some((variant) => `${entry.name}（${variant.name}）` === name));
        const color = KIND_COLOR[asset?.kind] ?? '#c09bff';
        pushToken(token, match.index, color);
        offset = match.index + token.length;
      }
      pushPlain(text.slice(offset), offset);
      result.push('\n');
      return result;
    }

    /**
     * The prompt editor with an `@` picker.
     *
     * Composing state is read from the event, which is what the DOM itself reports, rather than
     * kept in a ref. A ref works, but it is a second copy of a fact the browser already knows and
     * the two can disagree. On a Chinese IME the keystrokes that compose a name arrive as
     * `onChange` values too, so opening the picker mid-composition would offer candidates for half
     * a character and Enter would commit a row instead of the character being composed.
     */
    function PromptEditor({
      t,
      value,
      assets,
      mediaUrl,
      previewUrl,
      onChange,
      onLiveChange = null,
      deferCommitMs = 0,
      allowMentions = true,
      readOnly = false,
    }) {
      const ref = React.useRef(null);
      const highlightRef = React.useRef(null);
      const mentionAnchorRef = React.useRef(null);
      const mentionPopupRef = React.useRef(null);
      const composing = React.useRef(false);
      const commitDelay = Math.max(0, Number(deferCommitMs) || 0);
      const buffered = commitDelay > 0;
      // Keep the visual editor local and cheap. The card receives one idle-time commit instead of
      // rebuilding every asset column, reference check and action row for each character.
      const [bufferedValue, setBufferedValue] = React.useState(value);
      const bufferedValueRef = React.useRef(value);
      const externalValueRef = React.useRef(value);
      const commitTimerRef = React.useRef(null);
      const shownValue = buffered ? bufferedValue : value;
      const [mentionPosition, setMentionPosition] = React.useState(null);

      const cancelPendingCommit = () => {
        if (commitTimerRef.current === null) return;
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      };
      const commitNow = (next) => {
        cancelPendingCommit();
        if (next === externalValueRef.current) return;
        onChange(next);
      };
      const changeValue = (next, { immediate = false, schedule = true } = {}) => {
        if (!buffered) {
          onChange(next);
          return;
        }
        bufferedValueRef.current = next;
        setBufferedValue(next);
        if (typeof onLiveChange === 'function') onLiveChange(next);
        cancelPendingCommit();
        if (immediate) {
          commitNow(next);
          return;
        }
        if (!schedule) return;
        commitTimerRef.current = setTimeout(() => {
          commitTimerRef.current = null;
          commitNow(bufferedValueRef.current);
        }, commitDelay);
      };

      React.useEffect(() => {
        if (externalValueRef.current === value) return;
        externalValueRef.current = value;
        if (!buffered || bufferedValueRef.current === value) return;
        cancelPendingCommit();
        bufferedValueRef.current = value;
        setBufferedValue(value);
      }, [buffered, value]);

      React.useEffect(() => () => cancelPendingCommit(), []);

      React.useEffect(() => {
        const area = ref.current;
        const layer = highlightRef.current;
        if (!allowMentions || !area || !layer?.style) return undefined;
        const align = () => {
          layer.style.width = `${area.clientWidth}px`;
          layer.style.height = `${Math.max(area.scrollHeight, area.clientHeight)}px`;
          layer.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
        };
        align();
        if (typeof globalThis.ResizeObserver !== 'function') return undefined;
        const observer = new globalThis.ResizeObserver(align);
        observer.observe(area);
        return () => observer.disconnect();
      }, [allowMentions, shownValue]);
      const [query, setQuery] = React.useState(null);
      const [active, setActive] = React.useState(0);
      /** Why the last insert attempt did nothing, or null. A click that silently does nothing
       * looks like a dead button, so the reason is kept where it can be seen. */
      const [lastRefusal, setLastRefusal] = React.useState(null);

      const caretOf = (element) => (element === null ? null : element.selectionStart);
      const candidates = query === null ? [] : mentionCandidates(assets, query.query);
      /** `isComposing` as the browser reports it, tolerating a synthetic event in a test. */
      const composingOf = (event) => event?.nativeEvent?.isComposing === true || event?.isComposing === true;

      const sync = (element, composing) => {
        if (composing === true || !allowMentions) return;
        setQuery(mentionAtCaret(element.value, caretOf(element)));
        setActive(0);
      };

      const positionMentionPicker = React.useCallback(() => {
        const anchor = mentionAnchorRef.current;
        const rect = typeof anchor?.getBoundingClientRect === 'function'
          ? anchor.getBoundingClientRect()
          : null;
        if (rect === null) return;
        const viewportWidth = Number(globalThis.innerWidth)
          || Number(globalThis.document?.documentElement?.clientWidth)
          || 1280;
        const viewportHeight = Number(globalThis.innerHeight)
          || Number(globalThis.document?.documentElement?.clientHeight)
          || 800;
        const width = Math.max(220, Math.min(360, viewportWidth - 16));
        const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
        const belowTop = rect.bottom + 5;
        const availableBelow = viewportHeight - belowTop - 8;
        const maxHeight = Math.max(96, Math.min(240, availableBelow));
        const top = availableBelow >= 96
          ? belowTop
          : Math.max(8, viewportHeight - maxHeight - 8);
        setMentionPosition((previous) => (
          previous !== null
            && Math.abs(previous.left - left) < 1
            && Math.abs(previous.top - top) < 1
            && previous.width === width
            && previous.maxHeight === maxHeight
            ? previous
            : { left, top, width, maxHeight }
        ));
      }, []);

      React.useEffect(() => {
        if (query === null || !allowMentions) {
          setMentionPosition(null);
          return undefined;
        }
        const popup = mentionPopupRef.current;
        try {
          if (typeof popup?.showPopover === 'function' && popup.matches?.(':popover-open') !== true) {
            popup.showPopover();
          }
        } catch {
          // The inline position still keeps the list usable if the top-layer API is absent.
        }
        const cleanupPopup = () => {
          try {
            if (typeof popup?.hidePopover === 'function' && popup.matches?.(':popover-open') === true) {
              popup.hidePopover();
            }
          } catch {
            // Already closed by the browser.
          }
        };
        const schedule = globalThis.requestAnimationFrame ?? ((callback) => callback());
        const frame = schedule(positionMentionPicker);
        const view = globalThis.window;
        view?.addEventListener?.('resize', positionMentionPicker);
        return () => {
          const cancel = globalThis.cancelAnimationFrame;
          if (typeof cancel === 'function' && typeof frame === 'number') cancel(frame);
          view?.removeEventListener?.('resize', positionMentionPicker);
          cleanupPopup();
        };
      }, [allowMentions, positionMentionPicker, query?.end, query?.start, shownValue]);

      React.useEffect(() => {
        // Choosing a candidate is done; nothing may keep the picker open.
        if (query !== null && candidates.length === 0) setActive(0);
      }, [query, candidates.length]);

      const insert = (candidate) => {
        const element = ref.current;
        // A refusal here is silent by nature - a click that does nothing looks like a dead
        // button - so the reason is recorded where a caller (or a test) can read it.
        if (element === null || element === undefined || query === null) {
          setLastRefusal(element === null || element === undefined ? 'no-editor' : 'no-query');
          return;
        }
        const source = buffered ? bufferedValueRef.current : value;
        const next = `${source.slice(0, query.start)}${candidate.text}${source.slice(query.end)}`;
        changeValue(next, { immediate: true });
        setQuery(null);
        // The caret goes after the inserted mention, and the textarea takes focus back so the
        // user keeps typing where they were. Without the explicit focus a click on the row
        // would leave focus on the button and swallow the next keystrokes.
        const caret = query.start + candidate.text.length;
        // `requestAnimationFrame` is not React's, so it is reached for with a fallback to a
        // direct call: in a browser the frame lets React finish the re-render the insert
        // triggered before the caret is placed, and anywhere else the caret still lands.
        const schedule = globalThis.requestAnimationFrame ?? ((callback) => callback());
        schedule(() => {
          if (ref.current === null) return;
          ref.current.focus();
          try { ref.current.setSelectionRange(caret, caret); } catch { /* not focusable yet */ }
        });
      };

      const onKeyDown = (event) => {
        // Enter during a composition belongs to the IME, not to the picker: committing a
        // candidate there would insert a name the user had not finished typing.
        if (composing.current || composingOf(event) || event.keyCode === 229) return;
        if (query === null) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => (candidates.length === 0 ? 0 : (index + 1) % candidates.length));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (candidates.length === 0 ? 0 : (index - 1 + candidates.length) % candidates.length));
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const candidate = candidates[active];
          if (candidate === undefined) return;
          event.preventDefault();
          insert(candidate);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setQuery(null);
        }
      };

      // `flex: 1` makes the editor fill the column it is given (workbench), and costs nothing where
      // there is no flex parent (sidebar): the textarea's own 180px floor still applies there.
      return h('div', {
        className: 'sdd-editor-shell',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          flex: '1 1 auto',
          minHeight: 0,
          border: '1px solid var(--dsw-border-default, #e1e5ea)',
          borderRadius: '8px',
          overflow: 'visible',
          background: 'var(--dsw-surface-raised, #ffffff)',
        },
      },
        h('div', { className: 'sdd-editor', style: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-surface-raised, #ffffff)' } },
        allowMentions && h('div', {
          'aria-hidden': true,
          'data-dsh-highlight-layer': 'true',
          style: {
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            overflow: 'hidden',
            pointerEvents: 'none',
            background: 'transparent',
          },
        }, h('div', {
          ref: highlightRef,
          className: 'sdd-textarea sdd-textarea-mirror',
          style: {
            ...css.textarea,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 'auto',
            bottom: 'auto',
            boxSizing: 'border-box',
            minHeight: 0,
            height: 'auto',
            resize: 'none',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            overflow: 'visible',
            background: 'transparent',
            // This layer is the only visible copy of the prompt. State it explicitly instead
            // of inheriting a fill colour from the transparent textarea or host theme.
            color: 'var(--sdd-text, var(--dsw-text-default, #17202a))',
            WebkitTextFillColor: 'var(--sdd-text, var(--dsw-text-default, #17202a))',
          },
        }, highlightedPrompt(
          shownValue,
          assets,
          query === null ? null : query.start,
          mentionAnchorRef,
        ))),
        h('textarea', {
          ref,
          className: 'sdd-textarea',
          // The text is drawn by the highlight layer (so @mentions can be coloured), which means the
          // textarea's own glyphs are transparent. Its CARET must not be: `caretColor` inherited from the
          // theme and disappeared against the light column, which is why the field felt like it had no
          // cursor at all. A fixed colour is visible on both themes, and the selection is repainted too.
          style: {
            ...css.textarea,
            display: 'block',
            position: 'relative',
            zIndex: 1,
            flex: '1 1 auto',
            minHeight: '240px',
            background: 'transparent',
            overflowWrap: 'break-word',
            ...(allowMentions
              ? { color: 'transparent', caretColor: '#2f6fed', WebkitTextFillColor: 'transparent' }
              : {}),
          },
          'data-dsh-prompt-editor': allowMentions ? 'video' : 'h3',
          'data-dsh-prompt-readonly': readOnly ? 'true' : 'false',
          value: shownValue,
          readOnly,
          'aria-readonly': readOnly,
          spellCheck: false,
          placeholder: allowMentions ? t('at.hint') : '',
          onScroll: (event) => {
            if (highlightRef.current?.style) highlightRef.current.style.transform = `translate(${-event.target.scrollLeft}px, ${-event.target.scrollTop}px)`;
            positionMentionPicker();
          },
          onChange: (event) => {
            const composingNow = composing.current || composingOf(event);
            changeValue(event.target.value, { schedule: !composingNow });
            if (!composingNow) sync(event.target);
          },
          onKeyDown,
          onClick: (event) => sync(event.target, composingOf(event)),
          onKeyUp: (event) => {
            // Arrow keys and clicks move the caret without changing the value, so the picker
            // has to follow the caret and not only the text.
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) sync(event.target, composingOf(event));
          },
          // A composition end is the moment the picker becomes safe to open: the IME has
          // committed its text, and `isComposing` is false by then. No flag is kept between
          // events, so there is nothing that can be left in the wrong state.
          onBlur: () => { if (buffered) changeValue(bufferedValueRef.current, { immediate: true, schedule: false }); },
          onCompositionStart: () => { composing.current = true; cancelPendingCommit(); setQuery(null); },
          onCompositionEnd: (event) => {
            composing.current = false;
            changeValue(event.target.value, { immediate: true, schedule: false });
            sync(event.target, false);
          },
        }),
        ),
        query !== null && h('div', {
          ref: mentionPopupRef,
          popover: 'manual',
          style: {
            ...css.mentionBox,
            position: 'fixed',
            left: mentionPosition?.left ?? 12,
            top: mentionPosition?.top ?? 12,
            right: 'auto',
            bottom: 'auto',
            margin: 0,
            width: mentionPosition?.width ?? 320,
            maxHeight: mentionPosition?.maxHeight ?? 220,
            boxSizing: 'border-box',
          },
          role: 'listbox',
          'data-dsh-mention': 'list',
          'data-dsh-query': query.query,
          'data-dsh-refusal': lastRefusal ?? '',
        },
          candidates.length === 0 && h('div', { style: css.note }, t('at.none')),
          candidates.map((candidate, index) => h('div', {
            key: candidate.key,
            // A role and a marker attribute rather than only a style: assistive technology and
            // the test harness both need to identify a candidate row, and a style object is not
            // an identity.
            role: 'option',
            'aria-selected': index === active,
            'data-dsh-mention': candidate.text,
            style: css.mentionRow(index === active),
            // mousedown, not click: the textarea blurs on mousedown and a click handler would
            // then run after the selection was already lost.
            onMouseDown: (event) => { event.preventDefault(); insert(candidate); },
            onMouseEnter: () => setActive(index),
          },
            isMediaKind(candidate.kind)
              ? h(MediaPlaceholder, {
                kind: candidate.kind === 'reference-audio' ? 'audio' : 'video',
                compact: true,
                label: KIND_LABEL[candidate.kind] ?? '媒体',
                style: css.refThumbEmpty,
              })
              : candidate.thumbnailPreview !== null && candidate.thumbnailPreview !== undefined
                ? h(PreviewImage, { src: candidate.thumbnailPreview, style: css.mentionThumb, alt: '' })
                : candidate.thumbnail === null || candidate.thumbnail === undefined
                  || typeof previewUrl !== 'function'
                ? null
                : h(PreviewImage, { src: previewUrl(candidate.thumbnail), style: css.mentionThumb, alt: '' }),
            h('span', null, candidate.label),
          )),
        ),
      );
    }

    /**
     * The references resolved for one block.
     *
     * This is where "仅插入名字不算完成" becomes visible. A mention that resolved to nothing, or
     * that could mean two things, is shown by NAME and POSITION rather than as a count, because
     * the user has to fix the sentence and needs to know which one. The block is not
     * generatable while any of them is unresolved, and that is stated rather than implied.
     */
    /**
     * The workbench's asset column: one collapsible `<details>` per category.
     *
     * Categories follow the reference page and the asset library's own kinds: 人物 / 场景 / 道具 /
     * 其他参考图片 / 参考音频 / 参考视频. `<details>` is used instead of React state so every card keeps its
     * own open/closed state with no bookkeeping, and the groups stay open when a card re-renders.
     * Tiles are small (72px minimum) - this column is a checklist, not a gallery.
     */
    function assetGroups(t, references, previewUrl, assets = [], h3Mode = false, onUpload = null, onMention = null, onRemove = null, onChooseAmbiguous = null, onPickProject = null) {
      const slotKey = (entry) => {
        const display = String(entry?.display ?? '').trim();
        return display.length > 0
          ? `display:${display}`
          : `asset:${entry?.assetId ?? ''}:${entry?.variantId ?? entry?.variantName ?? ''}:${entry?.role ?? ''}`;
      };
      const slotQuality = (entry) => (Array.isArray(entry?.occurrences) && entry.occurrences.length > 0 ? 100 : 0)
        + (typeof entry?.thumbnailHandle === 'string' && entry.thumbnailHandle.length > 0 ? 10 : 0)
        + (Number.isFinite(entry?.version) ? entry.version : 0);
      const uniqueReferences = new Map();
      for (const entry of references?.references ?? []) {
        const key = slotKey(entry);
        const previous = uniqueReferences.get(key);
        if (previous === undefined || slotQuality(entry) > slotQuality(previous)) uniqueReferences.set(key, entry);
      }
      // Legacy saved shots can contain two versions under the same visible @name. They are one
      // asset-bar slot; keeping both produced a duplicate card, often with a white thumbnail.
      const all = [...uniqueReferences.values()];
      const unresolved = references?.unresolved ?? [];
      const ambiguous = references?.ambiguous ?? [];
      // The H3 reference itself carries no category, so fall back to the ASSET LIBRARY: the same
      // picture is called 林川 here and is a 人物 there. Without this every reference landed in
      // 「其他参考图片」 and the 人物/场景/道具 groups stayed empty.
      const kindByName = new Map();
      for (const asset of assets) {
        const declared = asset.kind ?? asset.category ?? null;
        if (declared === null) continue;
        for (const name of [asset.name, ...(asset.aliases ?? [])]) if (typeof name === 'string') kindByName.set(name, declared);
      }
      const bucketOf = (entry) => {
        const media = entry.mediaType ?? null;
        if (media === 'Audio') return '参考音频';
        if (media === 'Video') return '参考视频';
        /**
         * A video-prompt reference carries no `mediaType`; its category arrives as `assetKind`
         * (`reference-audio` / `reference-video`). Checking only `entry.kind` therefore dropped audio and
         * video assets into 「其他参考图片」 and the two media groups were always empty.
         */
        const declaredKind = entry.assetKind ?? entry.kind ?? null;
        if (declaredKind === 'reference-audio') return '参考音频';
        if (declaredKind === 'reference-video') return '参考视频';
        if (declaredKind === 'reference-image' || declaredKind === 'reference-media') return '其他参考图片';
        /**
         * An H3 prompt refers to its references ONLY as <Picture N> / <Audio N> / <Video N>, so for H3
         * the useful question is not "character or prop" but "which slot does this take, and is the slot
         * about to overflow". The workflow accepts at most 9 pictures, 3 audios and 3 videos.
         */
        if (h3Mode) return '参考图片';
        // Priority: the category the HOST resolved (authoritative - it looked the asset up), then the
        // library rows the panel has, then the reference's own generic `kind` (usually
        // `reference-image`, which is why trusting it first put every character in 其他参考图片).
        const kind = entry.assetKind ?? kindByName.get(entry.name) ?? entry.kind ?? null;
        if (kind === 'character' || kind === '人物') return '人物';
        if (kind === 'scene' || kind === '场景') return '场景';
        if (kind === 'prop' || kind === '道具') return '道具';
        return '其他参考图片';
      };
      const H3_CAPS = { '参考图片': 9, '参考音频': 3, '参考视频': 3 };
      const h3Prefix = (bucket) => (bucket === '参考音频' ? 'Audio' : bucket === '参考视频' ? 'Video' : 'Picture');
      const kindLabel = (kind) => ({
        character: '人物',
        scene: '场景',
        prop: '道具',
        'reference-image': '其他参考图片',
        'reference-media': '其他参考图片',
        'reference-audio': '参考音频',
        'reference-video': '参考视频',
      }[kind] ?? String(kind ?? '资产'));
      const order = h3Mode ? ['参考图片', '参考音频', '参考视频'] : ['人物', '场景', '道具', '其他参考图片', '参考音频', '参考视频'];
      const groups = new Map(order.map((name) => [name, []]));
      for (const entry of all) groups.get(bucketOf(entry)).push(entry);

      const tile = (entry) => h('div', {
        key: entry.referenceId,
        'data-dsh-asset-card': 'true',
        'data-dsh-reference-kind': bucketOf(entry),
        className: 'sdd-reference-tile',
        // `position: relative` so the delete control can sit in the corner of the tile.
        style: { position: 'relative', minWidth: 0, border: '1px solid var(--dsw-border-default, #ddd)', borderRadius: '4px', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--dsw-bg-base, #fff)' },
      },
        // The card's × is the explicit asset removal action. Editing the prompt itself never
        // removes a card; this click removes both the card binding and its mention text.
        typeof onRemove === 'function' ? h('button', {
          type: 'button',
          title: `从素材栏移除 ${entry.name ?? entry.display ?? entry.fileName ?? '素材'}（同时删除提示词中的引用）`,
          'data-dsh-asset-remove': 'true',
          className: 'sdd-reference-remove',
          onClick: () => onRemove({
            name: entry.name,
            display: entry.display,
            fileName: entry.fileName,
            referenceId: entry.referenceId,
            assetVersionId: entry.assetVersionId,
            occurrences: entry.occurrences,
          }),
          style: { position: 'absolute', top: '2px', right: '2px', zIndex: 2 },
        }, h('span', {
          className: 'sdd-reference-remove-mark',
          'data-dsh-reference-remove-mark': 'true',
        }, h(SddIcon, { name: 'x', size: 11 }))) : null,
        h('div', {
          className: 'sdd-reference-thumb',
          style: { height: '54px', background: 'var(--dsw-bg-subtle, #f5f5f5)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
        },
          mediaKindOf(entry.fileName ?? '') !== 'image'
            ? h(MediaPlaceholder, {
              kind: mediaKindOf(entry.fileName ?? ''),
              compact: true,
              label: bucketOf(entry),
            })
            : entry.thumbnailHandle !== null && entry.thumbnailHandle !== undefined && previewUrl !== undefined
              ? h(PreviewImage, { src: previewUrl(entry.thumbnailHandle), alt: entry.fileName ?? '', loading: 'lazy', style: { width: '100%', height: '100%', objectFit: 'cover' } })
              : h('span', { style: { fontSize: '10px', opacity: 0.6 } }, '无预览'),
        ),
        h('div', { className: 'sdd-reference-copy', style: { padding: '3px 5px', fontSize: '10px', lineHeight: 1.35 } },
          h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: String(entry.display ?? entry.fileName ?? '') }, String(entry.display ?? entry.fileName ?? '')),
          // In H3 the label IS the identity: this tile is <Picture 3>, not "林川" - that is the only
          // name the prompt itself uses, and the only one the workflow binds to a slot.
          h('div', { style: { opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            h3Mode && entry.referenceIndex !== undefined
              ? `<${h3Prefix(bucketOf(entry))} ${entry.referenceIndex}>`
              : (entry.bindingState === 'resolved' ? '已解析' : '待确认')),
        ),
      );
      /**
       * A name that could not be bound, with the candidate list when the Host knows one.
       *
       * Multiple categories can legitimately contain the same name after a file is imported or
       * copied more than once. Deleting the mention would discard a valid reference, so the only
       * honest action is to show WHAT the readings are and let the user pick one.
       */
      const pendingTile = (entry, index) => h('div', {
        key: `pending:${entry.name ?? entry.text ?? index}:${index}`,
        'data-dsh-pending-reference': 'true',
        style: { minWidth: 0, border: '1px solid var(--sdd-danger)', borderRadius: '4px', padding: '5px', fontSize: '10px', color: 'var(--sdd-danger)', background: 'color-mix(in srgb, var(--sdd-danger) 8%, var(--sdd-surface))', wordBreak: 'break-word' },
      },
        h('div', { style: { fontWeight: 600 } },
          `⛔ ${String(entry.text ?? entry.name ?? '未解析')}${entry.occurrenceCount > 1 ? ` ×${entry.occurrenceCount}` : ''}`),
        entry.note !== undefined ? h('div', { style: { opacity: 0.72, marginTop: '2px' } }, String(entry.note)) : null,
        Array.isArray(entry.candidateDetails) && entry.candidateDetails.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '5px' } },
            entry.candidateDetails.map((candidate, candidateIndex) => h('button', {
              key: `${candidate.assetId}:${candidate.variantName ?? ''}:${candidateIndex}`,
              type: 'button',
              'data-dsh-choose-ambiguous': String(entry.name ?? ''),
              onClick: () => {
                if (typeof onChooseAmbiguous === 'function') onChooseAmbiguous(entry.name, {
                  assetId: candidate.assetId,
                  variantName: candidate.variantName ?? null,
                });
              },
              title: candidate.fileName ?? candidate.assetName ?? '',
              style: { ...css.miniButton, fontSize: '10px', textAlign: 'left', padding: '3px 5px' },
            }, `${kindLabel(candidate.kind)} · ${String(candidate.fileName ?? candidate.assetName ?? candidate.assetId)}`)))
          : null,
      );

      return order.map((name) => {
        const entries = groups.get(name);
        // Unresolved and ambiguous mentions are image references that bound to no file. They live
        // beside the resolved tiles, not only when the group happens to be empty. Five occurrences
        // of one name are one question, so group them into one tile with an occurrence count.
        const pending = (() => {
          if (name !== '其他参考图片') return [];
          const grouped = new Map();
          for (const entry of [...unresolved, ...ambiguous]) {
            const key = String(entry.name ?? entry.text ?? '');
            const previous = grouped.get(key);
            if (previous === undefined) grouped.set(key, { ...entry, occurrenceCount: 1 });
            else previous.occurrenceCount += 1;
          }
          return [...grouped.values()];
        })();
        /**
         * A dashed `＋ 上传` cell closes every group.
         *
         * The video prompt refers to assets by `@name`, so the upload has to end with that name in the
         * text - otherwise the file lands in the library and the block still references nothing. The
         * Host derives the asset name from the file name, so the mention is the file name without its
         * extension, and `onMention` appends it to the draft.
         */
        const uploadTile = () => {
          const libraryOnlyKind = name === '人物' ? 'character'
            : name === '场景' ? 'scene'
              : name === '道具' ? 'prop'
                : null;
          if (libraryOnlyKind !== null) return h('button', {
            key: `${name}-project-asset`,
            type: 'button',
            'data-dsh-project-asset-pick': libraryOnlyKind,
            disabled: typeof onPickProject !== 'function',
            style: { ...css.miniButton, minWidth: 0, minHeight: '54px', borderStyle: 'dashed', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', fontSize: '10px', opacity: typeof onPickProject === 'function' ? 0.82 : 0.45, cursor: typeof onPickProject === 'function' ? 'pointer' : 'not-allowed' },
            onClick: () => onPickProject?.({ category: name, allowedKinds: [libraryOnlyKind], title: `选择${name}资产` }),
          },
            h(SddIcon, { name: 'library', size: 13 }),
            h('span', null, `选择${name}`),
          );
          return h('label', {
            key: `${name}-upload`,
            'data-dsh-local-asset-upload': name,
            style: { minWidth: 0, minHeight: '54px', border: '1px dashed var(--dsw-border-default, #bbb)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', fontSize: '10px', opacity: 0.75, cursor: typeof onUpload === 'function' ? 'pointer' : 'not-allowed' },
          },
            h('input', {
              type: 'file',
              accept: name === '参考音频' ? 'audio/*' : name === '参考视频' ? 'video/*' : 'image/*',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event?.target?.files?.[0];
                if (file === undefined || file === null || typeof onUpload !== 'function') return;
                const reader = new globalThis.FileReader();
                reader.onload = () => {
                  const encoded = String(reader.result ?? '').replace(/^data:[^,]*,/u, '');
                  const kindFilter = name === '参考音频' ? 'reference-audio' : name === '参考视频' ? 'reference-video'
                    : name === '人物' ? 'character' : name === '场景' ? 'scene' : name === '道具' ? 'prop' : 'reference-image';
                  Promise.resolve(onUpload({ kindFilter, fileName: file.name, fileDataBase64: encoded }))
                    .then((imported) => {
                      // The library's name, not the file's: the suffix is stripped (`外卖袋_00001_` -> `外卖袋`),
                      // and only the library name resolves as a mention.
                      const bound = String(imported?.name ?? file.name.replace(/\.[^.]+$/u, ''));
                      if (typeof onMention === 'function') onMention(bound, name, kindFilter);
                    })
                    .catch(() => { /* the panel reports the failure */ });
                };
                reader.readAsDataURL(file);
                event.target.value = '';
              },
            }),
            h('span', { style: { fontSize: '14px', lineHeight: 1 } }, '＋'),
            h('span', null, '上传'),
          );
        };
        /**
         * An empty group is still rendered.
         *
         * `return null` here hid 参考音频 and 参考视频 completely, so a block with no audio yet looked like
         * the panel had no such categories at all - and the upload cell (the only way to add one) was
         * unreachable. H3 always draws its slots for the same reason.
         */
        if (entries.length === 0 && h3Mode) return null;
        // H3 shows the slot budget (`4/9`): the workflow takes at most 9 pictures, 3 audios, 3 videos,
        // and an over-full block is refused at generation time - visible here, it is fixable here.
        const cap = h3Mode ? H3_CAPS[name] : null;
        const over = cap !== null && cap !== undefined && entries.length > cap;
        return h('details', { key: name, open: true, style: { fontSize: '11px' } },
          h('summary', { style: { cursor: 'pointer', padding: '2px 0', opacity: 0.8 } },
            cap === null || cap === undefined
              ? `${name}（${entries.length + pending.length}${pending.length > 0 ? ` · ${pending.length} 个待修` : ''}）`
              : `${name}（${entries.length}/${cap}）`,
            over ? h('span', { style: { color: 'var(--sdd-danger)', marginLeft: '4px' } }, `超出上限 ${entries.length - cap} 个`) : null),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '6px', marginTop: '4px' } },
            [...entries.map(tile), ...pending.map(pendingTile), uploadTile()]),
        );
      }).filter(Boolean);
    }

    /**
     * The H3 asset column: FIXED slots, always drawn.
     *
     * H3 addresses its references only as `<Picture N>` / `<Audio N>` / `<Video N>`, and the workflow
     * takes at most 9 pictures, 3 audios and 3 videos. So the column shows every slot of every type -
     * occupied or not - and an empty slot is an upload target. That is what makes the numbering visible
     * before anything is bound, and what lets a new asset be added from inside the block.
     *
     * A slot's TYPE comes from the FILE EXTENSION, not from the reference's `kind`: a .png that arrived
     * through the audio mapping was listed under 参考音频, which cannot be uploaded there at all.
     */
    const H3_SLOTS = [
      { name: '参考图片', cap: 9, prefix: 'Picture', accept: 'image/*', kindFilter: 'reference-image', ext: /\.(png|jpe?g|webp|gif|bmp)$/iu },
      { name: '参考音频', cap: 3, prefix: 'Audio', accept: 'audio/*', kindFilter: 'reference-audio', ext: /\.(mp3|wav|flac|ogg|m4a|aac)$/iu },
      { name: '参考视频', cap: 3, prefix: 'Video', accept: 'video/*', kindFilter: 'reference-video', ext: /\.(mp4|webm|mov|mkv)$/iu },
    ];

    function h3FileBase64(file) {
      if (file !== null && file !== undefined && typeof file.arrayBuffer === 'function') {
        return file.arrayBuffer().then((buffer) => {
          const bytes = new Uint8Array(buffer);
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          const output = [];
          for (let index = 0; index < bytes.length; index += 3) {
            const first = bytes[index];
            const second = bytes[index + 1];
            const third = bytes[index + 2];
            const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
            output.push(
              alphabet[(triple >> 18) & 63],
              alphabet[(triple >> 12) & 63],
              second === undefined ? '=' : alphabet[(triple >> 6) & 63],
              third === undefined ? '=' : alphabet[triple & 63],
            );
          }
          return output.join('');
        });
      }
      return new Promise((resolve, reject) => {
        if (typeof globalThis.FileReader !== 'function') {
          reject(new Error('当前环境无法读取这个文件'));
          return;
        }
        const reader = new globalThis.FileReader();
        reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/u, ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.onabort = () => reject(new Error('读取文件已取消'));
        reader.readAsDataURL(file);
      });
    }

    function h3SlotGroups({ t, references, previewUrl, onUpload, onPickProject, onChanged, onRemove, uploading = null, onUploading, onError }) {
      const all = references?.references ?? [];
      const mediaTypeOf = (entry) => {
        const fileName = String(entry.fileName ?? '');
        for (const slot of H3_SLOTS) if (slot.ext.test(fileName)) return slot.name;
        const media = entry.mediaType ?? null;
        if (media === 'Audio') return '参考音频';
        if (media === 'Video') return '参考视频';
        return '参考图片';
      };
      const bySlot = new Map(H3_SLOTS.map((slot) => [slot.name, new Map()]));
      /**
       * Which `<Picture N>` a reference actually occupies.
       *
       * The number comes from the PROMPT, not from the list position: a block whose references are
       * <Picture 1>, <Picture 2>, <Picture 3>, <Picture 5>, <Picture 7> (gaps happen when a picture is
       * dropped from subject_definitions) must show those exact slots. Laying the list out sequentially
       * labelled 外卖袋 as <Picture 4> while the prompt said <Picture 5> - the two disagreed, and the
       * number is what the workflow binds to.
       */
      const numberOf = (entry) => {
        const shown = /^<(\w+)\s+(\d+)>$/u.exec(String(entry.display ?? '').trim());
        if (shown !== null) return Number(shown[2]);
        const numeric = Number(entry.picture ?? entry.referenceIndex);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      };
      for (const entry of all) {
        const bucket = bySlot.get(mediaTypeOf(entry));
        const number = numberOf(entry);
        if (number === null || bucket.has(number)) continue;
        bucket.set(number, entry);
      }
      const upload = async (event, slot, slotNumber) => {
        const file = event?.target?.files?.[0];
        if (event?.target) event.target.value = '';
        if (file === undefined || file === null || typeof onUpload !== 'function') return;
        const label = `<${slot.prefix} ${slotNumber}>`;
        const key = `${slot.kindFilter}:${slotNumber}`;
        if (uploading !== null) return;
        onError?.('');
        onUploading?.(key);
        try {
          const encoded = await h3FileBase64(file);
          // `slotNumber` is the slot the user actually clicked. The binding must land THERE: numbering
          // the new reference "highest + 1" put a file chosen for <Picture 4> into <Picture 8> whenever
          // the block's numbering had gaps (1, 2, 3, 5, 7 -> new one became 8).
          const result = await onUpload({ kindFilter: slot.kindFilter, fileName: file.name, fileDataBase64: encoded, slotNumber });
          const binding = result?.imported?.binding ?? result?.binding ?? null;
          if (result === null || result === undefined || binding === null) {
            throw new Error('文件已导入，但没有生成可用的素材槽位绑定。请刷新资产库后再试');
          }
          if (typeof onChanged === 'function') await onChanged(result);
        } catch (failure) {
          onError?.(`${label} 上传失败：${String(failure?.message ?? failure)}`);
        } finally {
          onUploading?.(null);
        }
      };
      const voiceTargetOf = (definition) => {
        const match = /<Audio\s+\d+>.*<Subject\s+(\d+)>.*\((S\d+)\)/u.exec(String(definition ?? ''));
        return match === null ? null : { subject: Number(match[1]), speaker: match[2] };
      };

      return H3_SLOTS.map((slot) => {
        const slotMap = bySlot.get(slot.name);
        const numbers = [...slotMap.keys()].sort((left, right) => left - right);
        const highestNumber = Math.max(0, ...numbers);
        // Always draw the full budget, and never fewer slots than the block already uses: an over-full
        // block, or one whose numbering skips ahead, must still show those slots.
        const slotCount = Math.max(slot.cap, highestNumber);
        const over = numbers.length > slot.cap;
        return h('details', { key: slot.name, open: true, style: { fontSize: '11px' } },
          h('summary', { style: { cursor: 'pointer', padding: '2px 0', opacity: 0.8 } },
            `${slot.name}（${numbers.length}/${slot.cap}）`,
            over ? h('span', { style: { color: 'var(--sdd-danger)', marginLeft: '4px' } }, `超出上限 ${numbers.length - slot.cap} 个`) : null),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '6px', marginTop: '4px' } },
            Array.from({ length: slotCount }, (unused, index) => {
              // The slot's identity is its NUMBER, so a gap shows as an empty slot rather than shifting
              // every later picture down by one.
              const entry = slotMap.get(index + 1);
              const label = `<${slot.prefix} ${index + 1}>`;
              if (entry !== undefined) {
                return h('div', {
                  key: entry.referenceId ?? label,
                  'data-dsh-asset-card': 'true',
                  'data-dsh-reference-kind': slot.name,
                  className: 'sdd-reference-tile',
                  // `position: relative` so the delete control sits in the tile's corner.
                  style: { position: 'relative', minWidth: 0, border: '1px solid var(--dsw-border-default, #ddd)', borderRadius: '4px', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--dsw-bg-base, #fff)' },
                },
                  // Removing a material tile detaches this slot in shot metadata. The authored
                  // `<Picture N>` line is the user's document and is never rewritten by this action.
                  typeof onRemove === 'function' ? h('button', {
                    type: 'button',
                    title: `删除素材 ${label}（只从素材栏移除，不改提示词原文）`,
                    'data-dsh-asset-remove': 'true',
                    'data-dsh-h3-asset-delete': label,
                    ...(slot.prefix === 'Picture' ? { 'data-dsh-h3-delete-image': label } : {}),
                    className: 'sdd-reference-remove',
                    onClick: () => onRemove({ slotPrefix: slot.prefix, slotNumber: index + 1, fileName: entry.fileName }),
                    style: { position: 'absolute', top: '2px', right: '2px', zIndex: 2 },
                  }, h('span', {
                    className: 'sdd-reference-remove-mark',
                    'data-dsh-reference-remove-mark': 'true',
                  }, h(SddIcon, { name: 'x', size: 11 }))) : null,
                  h('div', {
                    className: 'sdd-reference-thumb',
                    style: { height: '54px', background: 'var(--dsw-bg-subtle, #f5f5f5)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
                  },
                    slot.name === '参考图片'
                      ? (entry.thumbnailHandle !== null && entry.thumbnailHandle !== undefined && previewUrl !== undefined
                        ? h(PreviewImage, { src: previewUrl(entry.thumbnailHandle), alt: entry.fileName ?? '', loading: 'lazy', style: { width: '100%', height: '100%', objectFit: 'cover' } })
                        : h('span', { style: { fontSize: '10px', opacity: 0.6 } }, '无预览'))
                      : h(MediaPlaceholder, {
                        kind: slot.name === '参考音频' ? 'audio' : 'video',
                        compact: true,
                        label: slot.name,
                      }),
                  ),
                  h('div', { className: 'sdd-reference-copy', style: { padding: '3px 5px', fontSize: '10px', lineHeight: 1.35 } },
                    // The FILE name, not `display`: an H3 reference's display IS `<Picture N>`, so showing
                    // both printed the number twice and hid which file was bound.
                    h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: String(entry.fileName ?? '') }, String(entry.fileName ?? entry.display ?? '')),
                    h('div', { style: { opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
                    slot.name === '参考音频'
                      ? (() => {
                        const voice = voiceTargetOf(entry.definition);
                        return h('div', {
                          'data-dsh-h3-voice-target': voice === null ? 'unbound' : `${voice.subject}:${voice.speaker}`,
                          style: {
                            marginTop: '2px',
                            color: voice === null ? 'var(--dsw-warning-default, #9b6b12)' : 'var(--dsw-accent-default, #087b67)',
                            fontSize: '9px',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          },
                        }, voice === null ? '未绑定说话人' : `音色 → <Subject ${String(voice.subject)}> (${voice.speaker})`);
                      })()
                      : null,
                  ),
                  h('div', {
                    style: { display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: '1px solid var(--dsw-border-default, #ddd)' },
                  },
                    typeof onPickProject === 'function' ? h('button', {
                      type: 'button',
                      'data-dsh-h3-asset-pick': `${slot.prefix}:${index + 1}`,
                      title: `为 ${label} 从项目资产选择`,
                      style: { minHeight: '24px', padding: '0 4px', border: 0, borderRight: '1px solid var(--dsw-border-default, #ddd)', background: 'transparent', color: 'inherit', fontSize: '10px', cursor: 'pointer' },
                      onClick: () => onPickProject({ slot, slotNumber: index + 1 }),
                    }, '项目') : null,
                    typeof onUpload === 'function' ? h('label', {
                      'data-dsh-h3-asset-replace': label,
                      title: `替换 ${label} 的素材`,
                      style: { display: 'grid', placeItems: 'center', minHeight: '24px', padding: '0 4px', fontSize: '10px', cursor: uploading === `${slot.kindFilter}:${index + 1}` ? 'wait' : 'pointer' },
                    },
                      uploading === `${slot.kindFilter}:${index + 1}` ? '上传中…' : '本地',
                      h('input', {
                        type: 'file',
                        accept: slot.accept,
                        disabled: uploading !== null,
                        style: { display: 'none' },
                        onChange: (event) => upload(event, slot, index + 1),
                      })) : null,
                  ),
                );
              }
              // An empty slot IS the upload button: the label says which slot the next file occupies.
              const uploadKey = `${slot.kindFilter}:${index + 1}`;
              const isUploading = uploading === uploadKey;
              return h('div', {
                key: label,
                className: 'sdd-reference-tile sdd-reference-empty',
                'data-dsh-h3-upload-label': `${slot.prefix}:${index + 1}`,
                style: { minWidth: 0, minHeight: '94px', border: '1px dashed var(--dsw-border-default, #bbb)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: '4px', padding: '5px', boxSizing: 'border-box', fontSize: '10px', opacity: isUploading ? 0.65 : 0.9 },
              },
                h('span', { style: { fontSize: '16px', lineHeight: 1, textAlign: 'center' } }, isUploading ? '…' : '＋'),
                h('span', { style: { textAlign: 'center', fontFamily: 'monospace' } }, isUploading ? `上传 ${label} 中` : label),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } },
                  h('button', {
                    type: 'button',
                    'data-dsh-h3-asset-pick': `${slot.prefix}:${index + 1}`,
                    style: { ...css.miniButton, minHeight: '24px', padding: '0 3px', fontSize: '10px' },
                    disabled: uploading !== null || typeof onPickProject !== 'function',
                    onClick: () => onPickProject?.({ slot, slotNumber: index + 1 }),
                  }, '项目'),
                  h('label', {
                    'data-dsh-h3-asset-upload': `${slot.prefix}:${index + 1}`,
                    style: { ...css.miniButton, minHeight: '24px', padding: '0 3px', fontSize: '10px', display: 'grid', placeItems: 'center', cursor: uploading !== null || typeof onUpload !== 'function' ? 'not-allowed' : 'pointer', opacity: typeof onUpload === 'function' ? 1 : 0.45 },
                  },
                    '本地',
                    h('input', {
                      type: 'file',
                      accept: slot.accept,
                      disabled: uploading !== null || typeof onUpload !== 'function',
                      style: { display: 'none' },
                      onChange: (event) => upload(event, slot, index + 1),
                    }))),
              );
            }),
          ),
        );
      });
    }

    function ReferencesBar({ t, references, previewUrl }) {
      const { references: list = [], unresolved = [], ambiguous = [], orderedInputs = [], changes = [], loading = false, error = null } = references;
      // Only the FIRST load replaces the bar with a placeholder. A re-resolution that already has
      // something to show keeps showing it and says "更新中" instead.
      //
      // The H3 key is the block text, so every keystroke re-resolved the references after a 350 ms
      // pause; with `loading` blanking the whole bar, the block visibly flashed 「解析引用中…」 on each
      // edit. Losing the content you were reading is the flicker - the request itself is harmless.
      const hasSomething = list.length > 0 || unresolved.length > 0 || ambiguous.length > 0;
      if (loading && !hasSomething) return h('div', { style: css.refBox }, t('ref.loading'));
      if (!hasSomething) {
        return h('div', { style: css.refBox },
          error !== null
            ? h('div', { style: css.error }, `引用刷新失败：${String(error)}`)
            : h('div', { style: css.note }, t('ref.none')));
      }

      const blocked = unresolved.length + ambiguous.length;
      const moved = changes.filter((change) => change.kind === 'moved').length;
      // A mention and its concrete binding are two different facts. `@林妙` can bind to the
      // identity variant while `@林妙（保洁工服）` binds to a costume; showing only the mention
      // made both look identical, so the filename - the only thing actually uploaded - was the
      // only clue. Name the resolved variant explicitly when the mention did not.
      const referenceLabel = (reference) => {
        const variant = reference.variantName;
        if (typeof variant !== 'string' || variant.length === 0 || variant === 'default') return reference.display;
        if (String(reference.display ?? '').includes(`（${variant}）`)) return reference.display;
        return `${reference.display} → ${reference.assetName ?? ''}（${variant}）`;
      };

      return h('div', { style: css.refBox },
        h('div', { style: css.note }, `${t('ref.title')} · ${list.length} · ${orderedInputs.length} ${t('ref.inputs')}${loading ? ` · ${t('ref.refreshing')}` : ''}`),
        error !== null ? h('div', { style: css.error }, `引用刷新失败：${String(error)}`) : null,

        list.map((reference) => h('div', { key: reference.referenceId, style: css.refRow },
          h('span', { style: css.refIndex }, String(reference.referenceIndex)),
          // The picture, before the words. A binding is a FILE, and a file name cannot tell two
          // character sheets apart: `林晚四视图.png` and `林晚.png` read almost the same and look
          // nothing alike. Without this the bar was text only, which is what "分镜板没有图片"
          // looked like from the outside.
          mediaKindOf(reference.fileName ?? '') !== 'image'
            ? h(MediaPlaceholder, {
              kind: mediaKindOf(reference.fileName ?? ''),
              compact: true,
              label: reference.fileName ?? undefined,
              style: css.refThumbEmpty,
            })
            : reference.thumbnailHandle !== null && reference.thumbnailHandle !== undefined && previewUrl !== undefined
            ? h(PreviewImage, {
              src: previewUrl(reference.thumbnailHandle),
              style: css.refThumb,
              alt: reference.fileName ?? '',
              loading: 'lazy',
              'data-dsh-ref-thumb': reference.referenceId,
            })
            : h('span', { style: css.refThumbEmpty, title: reference.fileName ?? '' }, t('ref.noPreview')),
          h('span', { title: `实际上传：${reference.fileName ?? ''}` }, referenceLabel(reference)),
          h('span', { style: css.assetMeta }, `${reference.variantName} · ${reference.role} · v${reference.version ?? ''} ${reference.fileName}`),
          h('span', { style: css.stateTag(reference.bindingState) }, reference.bindingState === 'resolved' ? t('ref.resolved') : t('ref.needsReview')),
          reference.pinned === true ? h('span', { style: css.stateTag('resolved') }, t('ref.pinned')) : null,
          h('span', { style: css.assetMeta }, `${(reference.occurrences ?? []).length} ${t('ref.uses')}`),
        )),

        moved > 0 && h('div', { style: css.note }, t('ref.moved')),

        unresolved.map((entry) => h('div', { key: `u${entry.start}`, style: css.refBlocked },
          `⛔ ${entry.text} — ${t('ref.unresolved')}：${entry.note}`)),

        ambiguous.map((entry) => h('div', { key: `a${entry.start}`, style: css.refBlocked },
          `⛔ ${entry.text} — ${t('ref.ambiguous')}：${entry.note}`)),

        blocked > 0 ? h('div', { style: css.refBlocked }, `⛔ ${t('ref.blocked')}`) : null,
      );
    }

    /**
     * The asset library.
     *
     * Two levels, list and detail, because they answer different questions: the grid is "what do
     * I have", the detail is "which version, and is the file still there". A version that has
     * gone missing stays in the list, struck through - reporting it is the point, since a
     * binding may still point at it.
     */
    function AssetsView({
      t,
      assets,
      mediaUrl,
      previewUrl,
      onOpen,
      onRefresh,
      onBack,
      onImport,
      onCreate,
      onAddVariant,
      onReplace,
      onDeleteAsset,
      onDeleteVersion,
      onGenerateQuadview,
      onSelectVersion,
      detail,
      busy,
      summary,
      episodeAssets = null,
      modeReady = false,
    }) {
      const ASSET_KINDS = [['character', '人物'], ['scene', '场景'], ['prop', '道具'], ['reference-audio', '参考音频']];
      const KIND_LABEL_LOCAL = Object.fromEntries(ASSET_KINDS);
      const [kind, setKind] = React.useState('all');
      const [search, setSearch] = React.useState('');
      const [importNote, setImportNote] = React.useState('');
      const [importError, setImportError] = React.useState(false);
      const [importBusy, setImportBusy] = React.useState(null);
      const importing = React.useRef(false);
      // The library is a library: opening it must show what exists. Filtering to one episode
      // is useful, but it is an explicit refinement. Defaulting it on made a project with 53
      // assets look empty whenever the episode/used-asset join had no match.
      const [onlyEpisode, setOnlyEpisode] = React.useState(false);
      const [showEmpty, setShowEmpty] = React.useState(false);
      const [selectedVariantId, setSelectedVariantId] = React.useState(null);
      const [selectedFileId, setSelectedFileId] = React.useState(null);
      const [viewer, setViewer] = React.useState(null);
      const [viewerZoom, setViewerZoom] = React.useState(false);
      const [createKind, setCreateKind] = React.useState(null);
      const [createName, setCreateName] = React.useState('');
      const [createDescription, setCreateDescription] = React.useState('');
      const [createBusy, setCreateBusy] = React.useState(false);
      const [expanded, setExpanded] = React.useState({});
      const [variantForms, setVariantForms] = React.useState({});
      const [deleteArmedAssetId, setDeleteArmedAssetId] = React.useState(null);
      const [variantBusy, setVariantBusy] = React.useState(null);
      const [uploadBusy, setUploadBusy] = React.useState(null);
      const [versionSelecting, setVersionSelecting] = React.useState(null);
      const [deleteConfirmId, setDeleteConfirmId] = React.useState(null);
      const [deleteBusy, setDeleteBusy] = React.useState(null);
      const [quadviewBusy, setQuadviewBusy] = React.useState(null);

      React.useEffect(() => {
        if ((assets ?? []).some((asset) => asset.inventory === true)) setShowEmpty(true);
      }, [assets]);

      React.useEffect(() => {
        setImportNote('');
        setImportError(false);
        setSelectedVariantId(null);
        setSelectedFileId(null);
        setViewer(null);
        setViewerZoom(false);
        setDeleteConfirmId(null);
        setDeleteBusy(null);
      }, [detail?.assetId]);

      const variantLabel = (asset, variantName) => {
        if (variantName === 'default' || variantName === asset?.identityVariant) {
          return asset?.kind === 'character' ? '基础形象' : asset?.kind === 'scene' ? '基础场景' : '基础外观';
        }
        return String(variantName ?? '');
      };

      const encodeBase64 = (bytes) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const output = [];
        for (let index = 0; index < bytes.length; index += 3) {
          const first = bytes[index];
          const second = bytes[index + 1];
          const third = bytes[index + 2];
          const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
          output.push(
            alphabet[(triple >> 18) & 63],
            alphabet[(triple >> 12) & 63],
            second === undefined ? '=' : alphabet[(triple >> 6) & 63],
            third === undefined ? '=' : alphabet[triple & 63],
          );
        }
        return output.join('');
      };
      const readFileBase64 = async (file) => {
        if (typeof file.arrayBuffer === 'function') return encodeBase64(new Uint8Array(await file.arrayBuffer()));
        return await new Promise((resolve, reject) => {
          const reader = new globalThis.FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('读取素材失败'));
          reader.onabort = () => reject(new Error('读取素材已取消'));
          reader.readAsDataURL(file);
        });
      };
      const isAssetCategory = (asset) => ASSET_KINDS.some(([id]) => id === asset.kind);
      const visible = (asset) => isAssetCategory(asset) && (showEmpty || (asset.versionCount ?? 0) > 0);
      const labelOf = (id) => KIND_LABEL_LOCAL[id] ?? id;
      const variantSelected = (asset, variantId) => {
        if (variantId === null || variantId === undefined) return null;
        return asset?.selectedHandles?.[variantId] ?? null;
      };
      const variantHandle = (asset, variantId) => {
        const selected = variantSelected(asset, variantId);
        if (selected !== null) return selected.thumbnailHandle ?? selected.handle ?? null;
        const handles = asset?.thumbnailHandles ?? {};
        if (variantId !== null && variantId !== undefined && typeof handles[variantId] === 'string') return handles[variantId];
        const originals = asset?.thumbnails ?? {};
        return variantId !== null && variantId !== undefined && typeof originals[variantId] === 'string' ? originals[variantId] : null;
      };
      const variantRole = (asset, variantId, role) => {
        if (variantId === null || variantId === undefined) return null;
        return asset?.roleHandles?.[variantId]?.[role] ?? null;
      };
      const variantRoleHandle = (asset, variantId, role) => {
        const entry = variantRole(asset, variantId, role);
        if (entry === null) return null;
        return entry.thumbnailHandle ?? entry.handle ?? null;
      };

      const importFiles = async (category, event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length === 0 || importing.current || typeof onImport !== 'function') return;
        importing.current = true;
        setImportBusy(category);
        setImportNote('');
        const errors = [];
        let added = 0;
        try {
          for (const file of files) {
            try {
              await onImport({ kindFilter: category, fileName: file.name, fileDataBase64: await readFileBase64(file) });
              added += 1;
            } catch (error) {
              errors.push(`${file.name}：${String(error?.message ?? error)}`);
            }
          }
          if (added > 0) setSearch('');
          setImportError(errors.length > 0);
          setImportNote(errors.length ? `${added > 0 ? `已添加 ${added} 个素材。` : ''}${errors.join('；')}` : '');
        } finally {
          importing.current = false;
          setImportBusy(null);
        }
      };

      const uploadReplacement = async (asset, variantName, role, event) => {
        const file = event?.target?.files?.[0];
        event.target.value = '';
        if (file === undefined || file === null || typeof onReplace !== 'function') return;
        const key = `${asset.assetId}:${variantName}:${role}`;
        setUploadBusy(key);
        setImportNote('');
        try {
          const replaced = await onReplace({
            assetId: asset.assetId,
            variantName,
            role,
            fileName: file.name,
            fileDataBase64: await readFileBase64(file),
          });
          // The Host can canonicalize an old split variant name while importing the file. Follow
          // that canonical id immediately; otherwise the detail view falls back to the identity
          // variant and the uploaded file is marked current in one variant while another image is
          // shown in the preview.
          if (typeof replaced?.variantId === 'string' && replaced.variantId.length > 0) {
            setSelectedVariantId(replaced.variantId);
          }
          if (role !== 'voice') {
            setSelectedFileId(typeof replaced?.assetVersionId === 'string' ? replaced.assetVersionId : null);
          }
          setImportError(false);
          setImportNote(role === 'voice'
            ? `音色已更新：${asset.name}。人物引用时会自动带入，不写入 H3 提示词正文。`
            : `已更新：${variantName === 'default' || variantName === asset.identityVariant
              ? `${asset.name}·${variantLabel(asset, variantName)}`
              : `${asset.name}（${variantName}）`}。已设为当前输入。`);
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setUploadBusy(null);
        }
      };

      const selectAssetVersion = async (asset, variant, file) => {
        if (file?.missing === true) return;
        if (file?.role === 'voice') {
          setSelectedFileId(file.assetVersionId);
          setImportError(false);
          setImportNote(`正在试听音色：${file.fileName}。音色不会成为人物画面输入。`);
          return;
        }
        const previous = selectedFileId;
        setSelectedVariantId(variant.variantId);
        setSelectedFileId(file.assetVersionId);
        setVersionSelecting(file.assetVersionId);
        setImportNote('');
        try {
          if (typeof onSelectVersion !== 'function') throw new Error('当前环境无法保存版本选择');
          await onSelectVersion({
            assetId: asset.assetId,
            variantName: variant.name,
            assetVersionId: file.assetVersionId,
          });
          setImportError(false);
          setImportNote(`已设为当前输入：${file.fileName}`);
        } catch (error) {
          setSelectedFileId(previous);
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setVersionSelecting(null);
        }
      };

      const deleteAssetVersion = async (asset, variant, file) => {
        if (file?.missing === true || file?.historical === true || typeof onDeleteVersion !== 'function') return;
        if (deleteConfirmId !== file.assetVersionId) {
          setDeleteConfirmId(file.assetVersionId);
          setImportError(false);
          setImportNote(`再次点击“确认删除”会删除${file.role === 'voice' ? '音色' : '图片'}「${file.fileName}」，文件会移到项目回收站。`);
          return;
        }
        setDeleteBusy(file.assetVersionId);
        setImportNote('');
        try {
          const removed = await onDeleteVersion({
            assetId: asset.assetId,
            variantName: variant.name,
            assetVersionId: file.assetVersionId,
          });
          setSelectedFileId(null);
          setDeleteConfirmId(null);
          setImportError(false);
          setImportNote(`已删除：${file.fileName}。文件已移到项目回收站：${removed?.trashPath ?? '.director/asset-trash'}`);
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setDeleteBusy(null);
        }
      };
      const uploadControl = (asset, variantName, role, label) => {
        const key = `${asset.assetId}:${variantName}:${role}`;
        return h('label', {
          style: { ...css.miniButton, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: uploadBusy === key ? 'wait' : 'pointer', fontSize: '10px' },
        },
          uploadBusy === key ? '上传中…' : label,
          h('input', {
            type: 'file',
            accept: role === 'voice' ? '.mp3,.wav,.flac,.ogg,.m4a,.aac,audio/*' : '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,image/*',
            disabled: uploadBusy === key || typeof onReplace !== 'function',
            style: { display: 'none' },
            'data-dsh-replace-asset': key,
            onChange: (event) => uploadReplacement(asset, variantName, role, event),
          }));
      };

      const newestRoleFile = (files, role) => files
        .filter((file) => file.role === role && file.missing !== true && typeof file.relativePath === 'string')
        .reduce((best, file) => {
          if (best === null) return file;
          return (file.version ?? 0) > (best.version ?? 0) ? file : best;
        }, null);

      const isUpscaledQuadview = (file) => file?.role === 'quadview'
        && file.missing !== true
        && /(?:3x|3\s*倍|超分)/iu.test(String(file.fileName ?? ''));
      const newestQuadview = (variant) => (variant?.files ?? [])
        .filter((file) => file.role === 'quadview' && file.missing !== true)
        .reduce((best, file) => {
          const quality = isUpscaledQuadview(file) ? 2 : 1;
          if (best === null) return file;
          const bestQuality = isUpscaledQuadview(best) ? 2 : 1;
          return quality > bestQuality || (quality === bestQuality && (file.version ?? 0) > (best.version ?? 0))
            ? file
            : best;
        }, null);

      const generateQuadview = async (asset, variant, source, action) => {
        if (source === null || source === undefined || typeof onGenerateQuadview !== 'function') return;
        const key = `${asset.assetId}:${variant.name}:${action}:${source.assetVersionId ?? 'missing'}`;
        setQuadviewBusy(key);
        setImportNote('');
        try {
          const result = await onGenerateQuadview({
            assetId: asset.assetId,
            variantName: variant.name,
            sourceVersionId: source.assetVersionId,
            quadviewAction: action,
          });
          setImportError(false);
          setImportNote(result?.recoveredExisting === true
            ? `已恢复之前生成的四视图并追加到人物资产：${asset.name}（${variant.name}）`
            : result?.reusedContent === true
              ? `${action === 'upscale' ? '3x 四视图' : '四视图'}内容已存在，已沿用：${asset.name}（${variant.name}）`
              : action === 'upscale'
                ? `四视图已 3 倍超分并保存：${asset.name}（${variant.name}）`
                : `四视图已生成：${asset.name}（${variant.name}）。需要提升清晰度时再点“3x 超分”。`);
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setQuadviewBusy(null);
        }
      };

      const quadviewControl = (asset, variant, source, action) => {
        const key = `${asset.assetId}:${variant.name}:${action}:${source?.assetVersionId ?? 'missing'}`;
        const blocked = source === null || source === undefined || modeReady !== true || typeof onGenerateQuadview !== 'function';
        return h('button', {
          type: 'button',
          'data-dsh-generate-quadview': key,
          'data-dsh-quadview-action': action,
          style: { ...css.miniButton, fontSize: '10px' },
          disabled: blocked || quadviewBusy === key,
          title: source === null || source === undefined
            ? action === 'upscale' ? '先生成或上传这个变体的四视图' : '先上传这个变体的定妆照'
            : modeReady !== true ? t('mode.required')
              : action === 'upscale' ? '把当前四视图用 VOSR2 超分 3 倍' : '按当前定妆照生成四视图',
          onClick: () => { void generateQuadview(asset, variant, source, action); },
        }, quadviewBusy === key
          ? action === 'upscale' ? '超分中…' : '生成中…'
          : action === 'upscale' ? '3x 超分' : '生成四视图');
      };

      const representativeFileForVariant = (asset, variant) => {
        const present = (variant?.files ?? []).filter((file) => file.missing !== true);
        if (present.length === 0) return null;
        const selected = present.find((file) => file.assetVersionId === variant.selectedVersionId);
        if (asset.kind === 'character') {
          const upscaled = present
            .filter((file) => isUpscaledQuadview(file)
              || (file.assetVersionId === variant.selectedVersionId && /(?:3x|3\s*倍|超分)/iu.test(String(variant.selectionNote ?? ''))))
            .reduce((best, file) => (best === null || (file.version ?? 0) > (best.version ?? 0) ? file : best), null);
          if (upscaled !== null) return upscaled;
          const currentQuadview = selected?.role === 'quadview'
            ? selected
            : present.find((file) => file.role === 'quadview' && file.current === true) ?? null;
          const manuallyUploaded = currentQuadview?.role === 'quadview'
            && variant.selectionNote !== '四视图原图，待 3x 超分'
            ? currentQuadview
            : null;
          if (manuallyUploaded !== null) return manuallyUploaded;
          return selected && ['front', 'primary'].includes(selected.role)
            ? selected
            : (newestRoleFile(present, 'front') ?? newestRoleFile(present, 'primary') ?? selected ?? present[0]);
        }
        return selected ?? present.reduce((best, file) => ((file.version ?? 0) > (best.version ?? 0) ? file : best), present[0]);
      };

      const submitCreate = async () => {
        if (createKind === null || typeof onCreate !== 'function') return;
        if (createName.trim().length === 0) {
          setImportError(true);
          setImportNote('新增资产必须填写名称');
          return;
        }
        setCreateBusy(true);
        setImportNote('');
        try {
          await onCreate({ kind: createKind, name: createName, description: createDescription });
          setImportError(false);
          setImportNote(`已新增：${createName}`);
          // A brand-new asset has no episode history yet. Leaving the episode-only
          // filter on would create it and immediately hide it, which looks like a failure.
          setOnlyEpisode(false);
          setShowEmpty(true);
          setKind(createKind);
          setCreateKind(null);
          setCreateName('');
          setCreateDescription('');
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setCreateBusy(false);
        }
      };

      const submitVariant = async (asset) => {
        const form = variantForms[asset.assetId] ?? {};
        if (typeof onAddVariant !== 'function' || typeof form.name !== 'string' || form.name.trim().length === 0) {
          setImportError(true);
          setImportNote('新增服装变体必须填写名称');
          return;
        }
        setVariantBusy(asset.assetId);
        setImportNote('');
        try {
          await onAddVariant({ assetId: asset.assetId, variantName: form.name, description: form.description ?? '' });
          setVariantForms((previous) => ({ ...previous, [asset.assetId]: { name: '', description: '', open: false } }));
          setImportError(false);
          setImportNote(`已为「${asset.name}」新增变体：${form.name}`);
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setVariantBusy(null);
        }
      };

      const deleteAssetAction = async (asset) => {
        if (typeof onDeleteAsset !== 'function') return;
        if (deleteArmedAssetId !== asset.assetId) {
          setDeleteArmedAssetId(asset.assetId);
          setImportError(false);
          setImportNote(`再次点击「确认删除」才会移除资产「${asset.name}」；图片会移到 .director/asset-trash。`);
          return;
        }
        setImportBusy(asset.assetId);
        setImportNote('');
        try {
          const removed = await onDeleteAsset({ assetId: asset.assetId });
          setDeleteArmedAssetId(null);
          setImportError(false);
          setImportNote(`已删除资产「${asset.name}」${removed?.filesMoved?.length > 0 ? `，${removed.filesMoved.length} 个文件已移到资产回收站` : ''}`);
        } catch (error) {
          setImportError(true);
          setImportNote(String(error?.message ?? error));
        } finally {
          setImportBusy(null);
        }
      };

      /**
       * One card for characters, scenes and props.
       *
       * All three have the same data shape - an asset with variants and file versions - but the
       * old page only exposed that shape for characters. A scene could contain `日 / 夜 / 反打`
       * variants in the library and still show just one picture, with no way to add or upload the
       * others. The labels change by kind; the interaction does not.
       */
      const visualCard = (asset) => {
        const variants = asset.variants ?? [];
        const identity = variants.find((variant) => variant.name === asset.identityVariant)
          ?? variants.find((variant) => variant.name === 'default')
          ?? variants[0]
          ?? null;
        const isCharacter = asset.kind === 'character';
        const identityFront = isCharacter ? variantRole(asset, identity?.variantId, 'front') : null;
        const identityFrontHandle = isCharacter ? variantRoleHandle(asset, identity?.variantId, 'front') : null;
        const identitySelected = variantSelected(asset, identity?.variantId);
        const identityHandle = identitySelected === null
          ? (isCharacter
            ? (identityFrontHandle ?? variantHandle(asset, identity?.variantId))
            : variantHandle(asset, identity?.variantId))
          : (identitySelected.thumbnailHandle ?? identitySelected.handle ?? null);
        const identityImageLabel = identitySelected === null
          ? (isCharacter
            ? (identityFrontHandle === null ? '旧四视图 · 待补 9:16 定妆照' : '全身定妆照 · 9:16')
            : '')
          : `当前输入 · ${identitySelected.fileName ?? '已选版本'}`;
        const open = expanded[asset.assetId] === true;
        const form = variantForms[asset.assetId] ?? {};
        const isScene = asset.kind === 'scene';
        const variantNoun = isCharacter ? '服装' : isScene ? '场景图' : '状态';
        const identityLabel = isCharacter ? '基础形象' : isScene ? '基础场景' : '基础外观';
        const role = isCharacter ? 'front' : 'primary';
        const uploadLabel = isCharacter ? '上传/替换定妆照' : '上传/替换图片';
        const emptyLabel = isCharacter ? '9:16 全身定妆照待上传' : isScene ? '场景图待上传' : '外观图待上传';
        const aspectRatio = isCharacter ? '9 / 16' : asset.kind === 'prop' ? '1 / 1' : '16 / 9';
        const identityAspectRatio = identitySelected?.role === 'quadview' ? '16 / 9' : aspectRatio;
        return h('div', {
          key: asset.assetId,
          ...(isCharacter ? { 'data-dsh-character': asset.assetId } : {}),
          'data-dsh-visual-asset': asset.assetId,
          'data-dsh-asset-kind': asset.kind,
          className: 'sdd-asset-card sdd-asset-card-visual',
          style: { ...css.assetCard, cursor: 'default', padding: '8px', gap: '8px', minWidth: 0 },
        },
          h('div', {
            role: 'button',
            tabIndex: 0,
            'data-dsh-asset': asset.assetId,
            'data-dsh-character-reference': isCharacter ? 'true' : 'false',
            style: isCharacter
              ? { display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: '8px', cursor: 'pointer', minWidth: 0, alignItems: 'start' }
              : { display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'pointer', minWidth: 0 },
            onClick: () => onOpen(asset),
            onKeyDown: (event) => { if (event.key === 'Enter') onOpen(asset); },
          },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
              identityHandle !== null && typeof previewUrl === 'function'
                ? h(PreviewImage, {
                  src: previewUrl(identityHandle),
                  'data-dsh-asset-cover': identitySelected?.assetVersionId ?? undefined,
                  style: { width: '100%', aspectRatio: identityAspectRatio, objectFit: 'contain', borderRadius: '4px', background: 'rgba(127,127,127,0.12)' },
                  alt: `${asset.name} ${identityImageLabel}`,
                  loading: 'lazy',
                })
                : h('div', {
                  style: { width: '100%', aspectRatio: identityAspectRatio, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', background: 'rgba(127,127,127,0.10)', fontSize: '10px', opacity: 0.65, textAlign: 'center', padding: '4px', boxSizing: 'border-box' },
                }, emptyLabel),
              isCharacter
                ? h('span', { style: { fontSize: '9px', opacity: 0.62, textAlign: 'center' } }, identityImageLabel)
                : null),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
              h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: '13px' } }, asset.name),
                isCharacter && asset.identityVariant !== null && asset.identityVariant !== undefined
                  ? h('span', { style: css.stateTag('resolved') }, `基础绑定：${asset.identityVariant}`)
                  : null,
                asset.manual === true ? h('span', { style: css.stateTag('review') }, '手动新增') : null,
                asset.inventory === true ? h('span', { style: css.stateTag('resolved') }, '盘点稿') : null,
                asset.versionCount === 0 ? h('span', { style: css.stateTag('review') }, '待图片') : null),
              h('div', { title: asset.description ?? '', style: { fontSize: '10px', lineHeight: 1.45, opacity: 0.78, maxHeight: '5.8em', overflowY: 'auto', whiteSpace: 'pre-wrap' } },
                asset.description ?? '暂无简介'),
              h('span', { style: css.assetMeta }, `${variantNoun} ${variants.length} 个 · ${asset.versionCount ?? 0} 个文件版本`)),
          ),
          h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              'data-dsh-character-expand': asset.assetId,
              'data-dsh-variant-expand': asset.assetId,
              style: { ...css.miniButton, fontSize: '10px' },
              onClick: () => setExpanded((previous) => ({ ...previous, [asset.assetId]: !open })),
            }, open ? `收起${variantNoun}` : `展开${variantNoun}（${variants.length}）`),
            uploadControl(asset, identity?.name ?? 'default', role, uploadLabel),
            isCharacter && identity !== null
              ? quadviewControl(asset, identity, identityFront)
              : null,
            h('button', { type: 'button', style: { ...css.miniButton, fontSize: '10px' }, onClick: () => onOpen(asset) }, '版本与详情'),
            h('button', {
              type: 'button',
              'data-dsh-delete-asset': asset.assetId,
              disabled: importBusy === asset.assetId || typeof onDeleteAsset !== 'function',
              style: {
                ...css.miniButton,
                fontSize: '10px',
                ...(deleteArmedAssetId === asset.assetId ? { color: 'var(--sdd-danger, #d14343)' } : {}),
              },
              title: deleteArmedAssetId === asset.assetId ? '确认删除整个资产' : '删除这个资产',
              onClick: (event) => {
                event?.stopPropagation?.();
                void deleteAssetAction(asset);
              },
            }, h(SddIcon, { name: 'trash-2', size: 12 }), deleteArmedAssetId === asset.assetId ? '确认删除' : '删除资产')),
          open && h('div', {
            ...(isCharacter ? { 'data-dsh-character-variants': asset.assetId } : {}),
            'data-dsh-visual-variants': asset.assetId,
            style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--dsw-border-default, #555)', paddingTop: '7px' },
          },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '6px' } },
              variants.map((variant) => {
                const handle = variantHandle(asset, variant.variantId);
                if (isCharacter) {
                  const front = variantRole(asset, variant.variantId, 'front');
                  const quadview = variantRole(asset, variant.variantId, 'quadview');
                  const rolePreview = (entry, label, ratio) => h('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 72px', minWidth: 0 },
                  },
                    entry !== null && typeof previewUrl === 'function'
                      ? h(PreviewImage, {
                        src: previewUrl(entry.thumbnailHandle ?? entry.handle),
                        style: { width: '100%', aspectRatio: ratio, objectFit: 'contain', borderRadius: '3px', background: 'rgba(127,127,127,0.12)' },
                        alt: `${variant.name} ${label}`,
                        loading: 'lazy',
                      })
                      : h('div', {
                        style: { width: '100%', aspectRatio: ratio, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '3px', background: 'rgba(127,127,127,0.10)', fontSize: '9px', opacity: 0.6, textAlign: 'center', padding: '3px', boxSizing: 'border-box' },
                      }, `无${label}`),
                    h('span', { style: { fontSize: '9px', opacity: 0.62, textAlign: 'center' } }, label));
                  return h('div', {
                    key: variant.variantId,
                    'data-dsh-character-variant': `${asset.assetId}:${variant.name}`,
                    'data-dsh-visual-variant': `${asset.assetId}:${variant.name}`,
                    style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '6px', border: '1px solid var(--dsw-border-default, #555)', borderRadius: '4px', minWidth: 0 },
                  },
                    h('strong', { style: { fontSize: '10px' } },
                      variant.name === asset.identityVariant
                        ? `${identityLabel}${variant.name === 'default' ? '' : ` · ${variant.name}`}`
                        : variant.name),
                    h('div', { style: { display: 'flex', gap: '5px', minWidth: 0 } },
                      rolePreview(front, '定妆照 9:16', '9 / 16'),
                      rolePreview(quadview, '四视图 16:9', '16 / 9')),
                    h('span', { title: variant.description ?? '', style: { fontSize: '9px', lineHeight: 1.35, opacity: 0.72, maxHeight: '3.8em', overflow: 'hidden' } }, variant.description ?? '暂无变体说明'),
                    h('span', { style: { fontSize: '9px', opacity: 0.55 } }, `${variant.versions ?? 0} 个版本`),
                    h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
                      uploadControl(asset, variant.name, 'front', '上传定妆照'),
                      uploadControl(asset, variant.name, 'quadview', '上传四视图'),
                      quadviewControl(asset, variant, front)),
                  );
                }
                return h('div', {
                  key: variant.variantId,
                  'data-dsh-character-variant': `${asset.assetId}:${variant.name}`,
                  'data-dsh-visual-variant': `${asset.assetId}:${variant.name}`,
                  style: { display: 'flex', gap: '6px', alignItems: 'flex-start', padding: '6px', border: '1px solid var(--dsw-border-default, #555)', borderRadius: '4px', minWidth: 0 },
                },
                  handle !== null && typeof previewUrl === 'function'
                    ? h(PreviewImage, { src: previewUrl(handle), style: { width: '72px', aspectRatio, objectFit: 'contain', borderRadius: '3px', background: 'rgba(127,127,127,0.12)', flex: '0 0 auto' }, alt: variant.name, loading: 'lazy' })
                    : h('div', { style: { width: '72px', aspectRatio, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '3px', background: 'rgba(127,127,127,0.10)', fontSize: '9px', opacity: 0.6, flex: '0 0 auto' } }, '无图'),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 80px', minWidth: 0 } },
                    h('strong', { style: { fontSize: '10px' } },
                      variant.name === asset.identityVariant
                        ? `${identityLabel}${variant.name === 'default' ? '' : ` · ${variant.name}`}`
                        : variant.name),
                    h('span', { title: variant.description ?? '', style: { fontSize: '9px', lineHeight: 1.35, opacity: 0.72, maxHeight: '3.8em', overflow: 'hidden' } }, variant.description ?? '暂无变体说明'),
                    h('span', { style: { fontSize: '9px', opacity: 0.55 } }, `${variant.versions ?? 0} 个版本`),
                    uploadControl(asset, variant.name, 'primary', '上传图片')),
                );
              })),
            h('div', { 'data-dsh-variant-form': asset.assetId, style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '6px', border: '1px dashed var(--dsw-border-default, #555)', borderRadius: '4px' } },
              h('div', { style: { fontSize: '10px', fontWeight: 600 } },
                isCharacter ? '新增服装 / 状态变体' : isScene ? '新增场景图（如 夜 / 反打）' : '新增道具状态'),
              h('input', {
                style: { ...css.select, width: '100%', boxSizing: 'border-box' },
                placeholder: isCharacter ? '变体名，例如 军装造型' : isScene ? '场景变体名，例如 夜 / 反打' : '状态名，例如 打开',
                value: form.name ?? '',
                'data-dsh-variant-name': asset.assetId,
                onChange: (event) => setVariantForms((previous) => ({ ...previous, [asset.assetId]: { ...form, name: event.target.value } })),
              }),
              h('input', {
                style: { ...css.select, width: '100%', boxSizing: 'border-box' },
                placeholder: '变体说明（可选）',
                value: form.description ?? '',
                onChange: (event) => setVariantForms((previous) => ({ ...previous, [asset.assetId]: { ...form, description: event.target.value } })),
              }),
              h('button', {
                type: 'button',
                style: { ...css.miniButton, fontSize: '10px', alignSelf: 'flex-start' },
                disabled: variantBusy === asset.assetId || typeof onAddVariant !== 'function',
                onClick: () => { void submitVariant(asset); },
              }, variantBusy === asset.assetId ? '添加中…' : '新增变体'))),
        );
      };

      const simpleCard = (asset) => {
        const handle = previewHandleFor(asset);
        const isAudio = asset.kind === 'reference-audio';
        const audioUrl = isAudio && handle !== null && typeof mediaUrl === 'function' ? mediaUrl(handle) : null;
        return h('div', {
          key: asset.assetId,
          'data-dsh-asset': asset.assetId,
          'data-dsh-asset-kind': asset.kind,
          className: 'sdd-asset-card sdd-asset-card-simple',
          style: { ...css.assetCard, cursor: 'pointer', padding: '7px', gap: '5px', minWidth: 0 },
          onClick: () => onOpen(asset),
          onKeyDown: (event) => { if (event.key === 'Enter') onOpen(asset); },
          role: 'button',
          tabIndex: 0,
        },
          isAudio
            ? h(MediaPlaceholder, {
              kind: 'audio',
              label: asset.name,
              style: { minHeight: '70px', borderRadius: '4px' },
            })
            : handle !== null && typeof previewUrl === 'function'
              ? h(PreviewImage, { src: previewUrl(handle), style: { width: '100%', aspectRatio: asset.kind === 'prop' ? '1 / 1' : '16 / 9', objectFit: 'contain', borderRadius: '4px', background: 'rgba(127,127,127,0.12)' }, alt: asset.name, loading: 'lazy' })
              : h('div', { style: { width: '100%', aspectRatio: asset.kind === 'prop' ? '1 / 1' : '16 / 9', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', background: 'rgba(127,127,127,0.10)', fontSize: '10px', opacity: 0.65 } }, '暂无图片'),
          h('strong', { style: css.assetName, title: asset.name }, asset.name),
          h('div', { title: asset.description ?? '', style: { fontSize: '10px', lineHeight: 1.4, opacity: 0.75, maxHeight: '4.2em', overflow: 'hidden' } }, asset.description ?? '暂无简介'),
          isAudio && audioUrl !== null
            ? h(PreviewAudio, {
              src: audioUrl,
              'aria-label': `${asset.name} 音频`,
              style: { width: '100%', height: '30px' },
              onClick: (event) => event.stopPropagation(),
            })
            : null,
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, onClick: (event) => event.stopPropagation() },
            uploadControl(asset, 'default', isAudio ? 'voice' : 'primary', isAudio ? '上传/替换音频' : '上传/替换图片'),
            h('button', { type: 'button', style: { ...css.miniButton, fontSize: '10px' }, onClick: (event) => { event.stopPropagation(); onOpen(asset); } }, '版本与详情'),
            h('button', {
              type: 'button',
              'data-dsh-delete-asset': asset.assetId,
              disabled: importBusy === asset.assetId || typeof onDeleteAsset !== 'function',
              style: {
                ...css.miniButton,
                fontSize: '10px',
                ...(deleteArmedAssetId === asset.assetId ? { color: 'var(--sdd-danger, #d14343)' } : {}),
              },
              onClick: (event) => {
                event?.stopPropagation?.();
                void deleteAssetAction(asset);
              },
            }, h(SddIcon, { name: 'trash-2', size: 12 }), deleteArmedAssetId === asset.assetId ? '确认删除' : '删除资产')),
          asset.versionCount === 0 ? h('span', { style: css.stateTag('review') }, '待上传') : null,
        );
      };

      const renderableAssets = (assets ?? []).filter(isAssetCategory);
      const emptyAssetCount = renderableAssets.filter((asset) => (asset.versionCount ?? 0) === 0).length;
      const filtered = renderableAssets.filter((asset) => {
        if (!visible(asset)) return false;
        if (onlyEpisode && episodeAssets !== null && !episodeAssets.includes(asset.assetId)) return false;
        if (kind !== 'all' && asset.kind !== kind) return false;
        if (search.trim().length === 0) return true;
        const haystack = `${asset.name} ${asset.description ?? ''} ${(asset.aliases ?? []).join(' ')}`.toLowerCase();
        return haystack.includes(search.trim().toLowerCase());
      });
      const visibleAssets = renderableAssets.filter(visible);
      const visibleVariants = visibleAssets.reduce((count, asset) => count + (asset.variants?.length ?? 0), 0);
      const visibleFiles = visibleAssets.reduce((count, asset) => count + (asset.versionCount ?? 0), 0);
      const categoryCount = (id) => renderableAssets.filter((asset) => visible(asset) && (id === 'all' || asset.kind === id)).length;

      const openOriginal = (file, title) => {
        if (file === null || file === undefined || typeof file.mediaHandle !== 'string' || file.missing === true) return;
        setViewer({ handle: file.mediaHandle, title, fileName: file.fileName, kind: mediaKindOf(file.fileName) });
        setViewerZoom(false);
      };

      const viewerActionStyle = {
        flexShrink: 0,
        minHeight: '32px',
        padding: '0 12px',
        borderRadius: '7px',
        border: '1px solid rgba(255,255,255,.34)',
        background: 'rgba(255,255,255,.14)',
        color: '#fff',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
      };
      const imageViewer = viewer !== null && viewer.kind === 'image' && typeof previewUrl === 'function'
        ? h('div', {
          'data-dsh-image-viewer': 'true',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            background: 'rgba(10,14,20,.88)',
            display: 'flex',
            flexDirection: 'column',
            padding: '14px',
            boxSizing: 'border-box',
          },
          onClick: () => setViewer(null),
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', color: '#fff', flex: '0 0 auto' },
            onClick: (event) => event.stopPropagation(),
          },
            h('strong', { style: { fontSize: '14px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, viewer.title),
            h('span', { style: { fontSize: '11px', opacity: 0.68, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, viewer.fileName),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', {
              type: 'button',
              'data-dsh-viewer-zoom': 'true',
              'aria-label': viewerZoom ? '适应屏幕' : '查看 1:1 原图',
              title: viewerZoom ? '适应屏幕' : '查看 1:1 原图',
              style: viewerActionStyle,
              onClick: () => setViewerZoom((value) => !value),
            }, viewerZoom ? '适应屏幕' : '1:1 原图'),
            h('button', {
              type: 'button',
              'data-dsh-viewer-close': 'true',
              'aria-label': '关闭图片预览',
              title: '关闭图片预览',
              style: viewerActionStyle,
              onClick: () => setViewer(null),
            }, '关闭')),
          h('div', {
            style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', display: 'flex', alignItems: viewerZoom ? 'flex-start' : 'center', justifyContent: viewerZoom ? 'flex-start' : 'center', paddingTop: '12px' },
            onClick: (event) => event.stopPropagation(),
          },
            h(PreviewImage, {
              src: previewUrl(viewer.handle),
              alt: viewer.title,
              style: viewerZoom
                ? { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none', flex: '0 0 auto', borderRadius: '2px' }
                : { maxWidth: '100%', maxHeight: 'calc(100vh - 100px)', objectFit: 'contain', borderRadius: '2px' },
            })))
        : null;

      if (detail !== null && detail !== undefined) {
        const variants = detail.variants ?? [];
        const selectedVariant = variants.find((variant) => variant.variantId === selectedVariantId)
          ?? variants.find((variant) => variant.name === detail.identityVariant)
          ?? variants.find((variant) => variant.name === 'default')
          ?? variants[0]
          ?? null;
        const files = selectedVariant?.files ?? [];
        const representativeFile = representativeFileForVariant(detail, selectedVariant);
        const persistedSelection = files.find((file) => file.assetVersionId === selectedVariant?.selectedVersionId && file.missing !== true);
        const selectedFile = files.find((file) => file.assetVersionId === selectedFileId)
          // Reopening an asset must show the version already persisted as current. The
          // representative image is only the fallback when no explicit selection exists.
          ?? persistedSelection
          ?? representativeFile
          ?? files.find((file) => file.current === true)
          ?? files.find((file) => file.missing !== true && typeof file.mediaHandle === 'string')
          ?? files[0]
          ?? null;
        const identityLabel = variantLabel(detail, detail.identityVariant ?? 'default');
        const role = detail.kind === 'character' ? 'front' : detail.kind === 'reference-audio' ? 'voice' : 'primary';
        const portraitRoles = new Set(['front', 'primary']);
        const selectedPortrait = selectedFile !== null && portraitRoles.has(selectedFile.role) ? selectedFile : null;
        const currentPortrait = files.find((file) => file.current === true && portraitRoles.has(file.role)) ?? null;
        // The version the user is viewing is the input. The current version is the persisted
        // fallback, and newest-role only covers legacy data with no selection.
        const front = selectedPortrait
          ?? currentPortrait
          ?? newestRoleFile(files, 'front')
          ?? newestRoleFile(files, 'primary');
        const quadviewSource = (selectedVariant?.files ?? []).find((file) =>
          file.assetVersionId === selectedVariant?.selectedVersionId && file.role === 'quadview' && file.missing !== true)
          ?? newestQuadview(selectedVariant);
        const presentRoles = new Set(files.filter((file) => file.missing !== true).map((file) => file.role));
        const candidateFiles = files.filter((file) => file.missing !== true && file.role !== 'voice');
        const hasQuadview = presentRoles.has('quadview');
        const hasFront = presentRoles.has('front');
        const hasPrimary = presentRoles.has('primary');
        const form = variantForms[detail.assetId] ?? {};
        const isAudio = detail.kind === 'reference-audio';
        const selectedHandle = selectedFile?.mediaHandle;
        const voiceFiles = detail.kind === 'character'
          ? variants
            .flatMap((variant) => variant.files ?? [])
            .filter((file) => file.role === 'voice' && file.missing !== true && typeof file.mediaHandle === 'string')
          : [];
        const currentVoiceFiles = voiceFiles.filter((file) => file.historical !== true);
        const voiceFile = (currentVoiceFiles.length > 0 ? currentVoiceFiles : voiceFiles)
          .reduce((best, file) => (best === null || (file.version ?? 0) > (best.version ?? 0) ? file : best), null);
        const selectedVoice = selectedFile?.role === 'voice' ? selectedFile : null;
        const audioPreviewFile = selectedVoice ?? voiceFile;
        const selectedIsVoice = selectedVoice !== null;
        const showAudioPreview = isAudio || selectedIsVoice;
        const audioPreviewHandle = showAudioPreview
          ? (selectedIsVoice ? selectedHandle : audioPreviewFile?.mediaHandle)
          : null;

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('button', { type: 'button', style: css.button(false), onClick: onBack }, `← ${t('assets.back')}`),
            h('strong', { style: { fontSize: '16px', minWidth: 0 } }, detail.name),
            h('span', { style: css.stateTag('resolved') }, labelOf(detail.kind)),
            detail.inventory === true ? h('span', { style: css.stateTag('resolved') }, '盘点稿') : null,
            detail.manual === true ? h('span', { style: css.stateTag('review') }, '手动新增') : null),

          importNote.length > 0
            ? h('div', { style: { ...css.note, color: importError ? 'var(--sdd-danger)' : 'var(--sdd-success)' }, role: 'alert' }, importNote)
            : null,

          h('div', { className: 'sdd-asset-detail-grid' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 } },
              h('div', {
                'data-dsh-open-original': selectedFile?.assetVersionId ?? '',
                style: {
                  minHeight: '220px',
                  maxHeight: '430px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  border: '1px solid var(--dsw-border-default, #e1e5ea)',
                  borderRadius: '6px',
                  background: 'rgba(127,127,127,.08)',
                  cursor: showAudioPreview || selectedHandle === undefined || selectedHandle === null ? 'default' : 'zoom-in',
                },
                onClick: () => {
                  if (!showAudioPreview) openOriginal(selectedFile, `${detail.name} · ${selectedVariant?.name ?? ''}`);
                },
              },
                selectedFile?.missing === true
                  ? h('span', { style: css.note }, '这个文件已不在磁盘上')
                  : showAudioPreview && (audioPreviewHandle === undefined || audioPreviewHandle === null)
                    ? h('span', { style: css.note }, '还没有上传音色')
                    : selectedHandle === undefined || selectedHandle === null
                    ? h('span', { style: css.note }, '暂无图片')
                    : showAudioPreview
                      ? h(PreviewAudio, {
                        src: typeof mediaUrl === 'function' ? mediaUrl(audioPreviewHandle) : undefined,
                        'data-dsh-character-voice-player': detail.kind === 'character' ? detail.assetId : undefined,
                        'aria-label': `${detail.name} 的人物音色`,
                        style: { width: '90%' },
                      })
                      : h(PreviewImage, {
                        'data-dsh-detail-original': selectedFile?.assetVersionId ?? '',
                        src: previewUrl(selectedHandle),
                        alt: selectedFile?.fileName ?? detail.name,
                        style: {
                          display: 'block',
                          maxWidth: '100%',
                          maxHeight: '430px',
                          width: 'auto',
                          height: 'auto',
                          objectFit: 'contain',
                        },
                      })),
              candidateFiles.length > 0
                ? h('div', {
                  'data-dsh-asset-candidates': selectedVariant?.variantId ?? '',
                  style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', gap: '5px' },
                }, candidateFiles.map((file) => h('div', {
                  key: file.assetVersionId,
                  style: { position: 'relative', minWidth: 0 },
                },
                h('button', {
                  type: 'button',
                  'data-dsh-version-row': file.assetVersionId,
                  ...(file.current === true ? { 'data-dsh-current-input': file.assetVersionId } : {}),
                  disabled: versionSelecting !== null,
                  title: file.current === true ? `当前输入：${file.fileName}` : `设为当前输入：${file.fileName}`,
                  onClick: () => { void selectAssetVersion(detail, selectedVariant, file); },
                  style: {
                    width: '100%',
                    aspectRatio: '1',
                    minWidth: 0,
                    padding: '3px',
                    overflow: 'hidden',
                    border: selectedFile?.assetVersionId === file.assetVersionId
                      ? '2px solid var(--dsw-accent, #2f6fed)'
                      : '1px solid var(--dsw-border-strong, #8793a3)',
                    borderRadius: '5px',
                    background: selectedFile?.assetVersionId === file.assetVersionId
                      ? 'rgba(47,111,237,.08)'
                      : 'rgba(127,127,127,.045)',
                    cursor: versionSelecting === file.assetVersionId ? 'wait' : 'pointer',
                  },
                },
                h('div', { style: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: '3px', background: 'rgba(127,127,127,.08)' } },
                  file.thumbnailHandle !== undefined && file.thumbnailHandle !== null && typeof previewUrl === 'function'
                    ? h(PreviewImage, { src: previewUrl(file.thumbnailHandle), alt: file.fileName, style: { width: '100%', height: '100%', objectFit: 'contain' } })
                    : h('span', { style: { fontSize: '9px', opacity: 0.6 } }, '无图')),
                file.current === true
                  ? h('span', {
                    style: {
                      position: 'absolute',
                      right: '3px',
                      bottom: '3px',
                      padding: '1px 3px',
                      borderRadius: '3px',
                      background: 'var(--dsw-accent, #2f6fed)',
                      color: '#fff',
                      fontSize: '8px',
                      lineHeight: 1.35,
                    },
                  }, '当前')
                  : null),
                file.historical !== true && typeof onDeleteVersion === 'function'
                  ? h('button', {
                    type: 'button',
                    'data-dsh-delete-asset-version': file.assetVersionId,
                    'aria-label': `删除图片 ${file.fileName}`,
                    title: deleteConfirmId === file.assetVersionId
                      ? `再次点击删除 ${file.fileName}`
                      : `删除图片 ${file.fileName}`,
                    disabled: deleteBusy === file.assetVersionId,
                    onClick: (event) => {
                      event?.stopPropagation?.();
                      void deleteAssetVersion(detail, selectedVariant, file);
                    },
                    style: {
                      position: 'absolute',
                      top: '3px',
                      right: '3px',
                      zIndex: 2,
                      width: '18px',
                      height: '18px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: deleteConfirmId === file.assetVersionId
                        ? '1px solid var(--sdd-danger)'
                        : '1px solid rgba(255,255,255,.55)',
                      borderRadius: '50%',
                      background: deleteConfirmId === file.assetVersionId
                        ? 'var(--sdd-danger)'
                        : 'rgba(30,35,45,.72)',
                      color: '#fff',
                      cursor: deleteBusy === file.assetVersionId ? 'wait' : 'pointer',
                    },
                  }, h(SddIcon, { name: 'x', size: 10 }))
                  : null))) : null),

            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
              h('div', { style: { fontSize: '11px', lineHeight: 1.55, opacity: 0.8, whiteSpace: 'pre-wrap', maxHeight: '9em', overflowY: 'auto' } }, detail.description ?? '暂无简介'),
              detail.kind === 'character'
                ? h('div', {
                  'data-dsh-character-voice-detail': detail.assetId,
                  'data-dsh-character-voice-state': voiceFile === null ? 'missing' : 'ready',
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    padding: '8px',
                    border: '1px solid var(--dsw-border-default, #e1e5ea)',
                    borderRadius: '6px',
                    background: 'rgba(127,127,127,.045)',
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                    h('strong', { style: { fontSize: '11px' } }, '人物音色'),
                    h('span', { style: css.stateTag(voiceFile === null ? 'review' : 'resolved') },
                      voiceFile === null ? '未上传（可选）' : `已上传 · v${voiceFile.version}`),
                    h('span', { title: voiceFile?.fileName ?? '', style: { fontSize: '9px', opacity: 0.58, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      voiceFile?.fileName ?? '')),
                  voiceFile !== null && typeof mediaUrl === 'function'
                    ? h(PreviewAudio, {
                      src: mediaUrl(voiceFile.mediaHandle),
                      'data-dsh-character-voice-file': voiceFile.assetVersionId,
                      'aria-label': `${detail.name} 的人物音色`,
                      style: { width: '100%', height: '32px' },
                    })
                    : null,
                  h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' } },
                    uploadControl(detail, detail.identityVariant ?? selectedVariant?.name ?? 'default', 'voice', voiceFile === null ? '上传音色' : '替换音色')))
                : null,
              h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
                uploadControl(detail, selectedVariant?.name ?? 'default', detail.kind === 'character' ? 'auto' : role, isAudio ? '上传音频' : '上传图片'),
                detail.kind === 'character' && selectedVariant !== null ? quadviewControl(detail, selectedVariant, front, 'generate') : null,
                detail.kind === 'character' && selectedVariant !== null ? quadviewControl(detail, selectedVariant, quadviewSource, 'upscale') : null),
              h('div', { style: { borderTop: '1px solid var(--dsw-border-default, #e1e5ea)', paddingTop: '8px' } },
                h('div', { style: { fontSize: '11px', fontWeight: 600, marginBottom: '6px' } }, `${t('assets.variants')} ${variants.length}`),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: '6px' } },
                  variants.map((variant) => {
                    const label = variant.name === detail.identityVariant ? identityLabel : variant.name;
                    return h('button', {
                      key: variant.variantId,
                      type: 'button',
                      'data-dsh-asset-variant': `${detail.assetId}:${variant.name}`,
                      'aria-pressed': selectedVariant?.variantId === variant.variantId,
                      title: label,
                      style: {
                        minWidth: 0,
                        minHeight: '38px',
                        padding: '7px 9px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-start',
                        border: selectedVariant?.variantId === variant.variantId
                          ? '2px solid var(--dsw-accent, #2f6fed)'
                          : '1px solid var(--dsw-border-strong, #8793a3)',
                        borderRadius: '6px',
                        background: selectedVariant?.variantId === variant.variantId
                          ? 'rgba(47,111,237,.08)'
                          : 'rgba(127,127,127,.045)',
                        boxShadow: selectedVariant?.variantId === variant.variantId
                          ? 'inset 0 0 0 1px rgba(47,111,237,.12)'
                          : '0 1px 2px rgba(15,23,42,.08)',
                        color: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                      },
                      onClick: () => { setSelectedVariantId(variant.variantId); setSelectedFileId(null); },
                    }, h('span', {
                      style: {
                        minWidth: 0,
                        fontSize: '11px',
                        lineHeight: 1.35,
                        overflowWrap: 'anywhere',
                      },
                    }, label));
                  })),
              selectedVariant?.description
                ? h('div', {
                  style: {
                    padding: '7px 8px',
                    borderRadius: '5px',
                    background: 'rgba(127,127,127,.055)',
                    fontSize: '10px',
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                  },
                }, selectedVariant.description)
                : null,
              h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: css.miniButton,
                  onClick: () => setVariantForms((previous) => ({ ...previous, [detail.assetId]: { ...form, open: form.open !== true } })),
                }, form.open === true ? '取消新增变体' : '＋ 新增变体')),
              form.open === true ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '7px', borderRadius: '5px', background: 'rgba(127,127,127,.06)' } },
                h('input', {
                  style: { ...css.select, width: '100%', boxSizing: 'border-box' },
                  placeholder: '变体名，例如 夜 / 反打 / 礼服',
                  value: form.name ?? '',
                  'data-dsh-variant-name': detail.assetId,
                  onChange: (event) => setVariantForms((previous) => ({ ...previous, [detail.assetId]: { ...form, name: event.target.value } })),
                }),
                h('input', {
                  style: { ...css.select, width: '100%', boxSizing: 'border-box' },
                  placeholder: '变体说明（可选）',
                  value: form.description ?? '',
                  onChange: (event) => setVariantForms((previous) => ({ ...previous, [detail.assetId]: { ...form, description: event.target.value } })),
                }),
                h('button', { type: 'button', style: css.button(true), disabled: variantBusy === detail.assetId, onClick: () => { void submitVariant(detail); } }, variantBusy === detail.assetId ? '添加中…' : '新增变体')) : null))),

          imageViewer);
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: css.button(false), disabled: busy, onClick: onRefresh }, busy ? t('assets.scanning') : t('assets.refresh')),
          h('strong', { style: { fontSize: '15px' } }, '资产库'),
          h('span', { style: css.assetMeta },
            `${visibleAssets.length} 个资产 · ${visibleVariants} 个变体 · ${visibleFiles} 个文件${summary?.historicalFiles > 0 ? ` · 集内旧版 ${summary.historicalFiles}` : ''}`)),
        importNote.length > 0 ? h('div', { style: { ...css.note, color: importError ? 'var(--sdd-danger)' : 'var(--sdd-success)' }, role: 'alert' }, importNote) : null,
        h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' } },
          [['character', '新增人物'], ['scene', '新增场景'], ['prop', '新增道具']].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            'data-dsh-create-kind': id,
            style: css.miniButton,
            disabled: typeof onCreate !== 'function',
            onClick: () => { setCreateKind(id); setCreateName(''); setCreateDescription(''); setImportNote(''); },
          }, label))),
        createKind !== null && h('div', {
          'data-dsh-create-asset': createKind,
          style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '8px', border: '1px solid var(--dsw-border-default, #555)', borderRadius: '6px', background: 'rgba(127,127,127,.04)' },
        },
          h('strong', { style: { fontSize: '11px' } }, `新增${labelOf(createKind)}`),
          h('input', {
            style: { ...css.select, width: '100%', boxSizing: 'border-box' },
            placeholder: '名称',
            value: createName,
            'data-dsh-create-name': 'true',
            onChange: (event) => setCreateName(event.target.value),
          }),
          h('textarea', {
            style: { ...css.select, width: '100%', boxSizing: 'border-box', minHeight: '50px', resize: 'vertical' },
            placeholder: '简介（可选）',
            value: createDescription,
            onChange: (event) => setCreateDescription(event.target.value),
          }),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { type: 'button', style: css.button(true), disabled: createBusy, onClick: () => { void submitCreate(); } }, createBusy ? '创建中…' : '创建'),
            h('button', { type: 'button', style: css.button(false), disabled: createBusy, onClick: () => setCreateKind(null) }, '取消'))),
        h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' } },
          [['all', t('assets.all')], ...ASSET_KINDS].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            'data-dsh-asset-kind': id,
            style: css.chip(kind === id),
            onClick: () => setKind(id),
          }, `${label} ${categoryCount(id)}`))),
        h('input', {
          type: 'search',
          style: { ...css.select, width: '100%', height: '32px', minHeight: '32px', flex: 'none' },
          value: search,
          placeholder: t('assets.search'),
          onChange: (event) => setSearch(event.target.value),
        }),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          episodeAssets !== null ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10.5px' } },
            h('input', { type: 'checkbox', checked: onlyEpisode, onChange: (event) => setOnlyEpisode(event.target.checked) }), '只看本集') : null,
          emptyAssetCount > 0 ? h('button', {
            type: 'button',
            'data-dsh-show-empty': 'true',
            style: css.chip(showEmpty),
            onClick: () => setShowEmpty((value) => !value),
          }, `待补齐 ${emptyAssetCount}`) : null),
        renderableAssets.length === 0
          ? h('div', { style: css.note }, '还没有识别到资产。可以新增人物、场景或道具，或重新扫描项目。')
          : visibleAssets.length === 0 && emptyAssetCount > 0
            ? h('div', { style: { ...css.note, display: 'flex', gap: '7px', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', null, `当前没有带图片的资产；另有 ${emptyAssetCount} 条待补齐记录。`),
              h('button', { type: 'button', style: css.miniButton, onClick: () => setShowEmpty(true) }, '查看待补齐'))
            : filtered.length === 0
              ? h('div', { style: css.note }, t('assets.none'))
              : ASSET_KINDS.filter(([id]) => kind === 'all' || kind === id).map(([id, label]) => {
                const rows = filtered.filter((asset) => asset.kind === id);
                if (rows.length === 0 && id !== 'reference-audio') return null;
                return h('div', { key: id, 'data-dsh-asset-category': id, style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                  h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', padding: '2px' } },
                    h('strong', { style: { fontSize: '12px' } }, label),
                    h('span', { style: { fontSize: '10px', opacity: 0.55 } }, rows.length)),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(188px, 1fr))', gap: '14px' } },
                    rows.map((asset) => {
                      const identity = (asset.variants ?? []).find((variant) => variant.name === asset.identityVariant)
                        ?? (asset.variants ?? []).find((variant) => variant.name === 'default')
                        ?? (asset.variants ?? [])[0];
                      const cover = previewHandleFor(asset, identity?.variantId ?? null);
                      const selectedCover = asset.selectedHandles?.[identity?.variantId] ?? null;
                      const isAudio = asset.kind === 'reference-audio';
                      const voice = asset.kind === 'character' ? asset.voice ?? null : null;
                      const voiceUrl = typeof voice?.handle === 'string' && typeof mediaUrl === 'function'
                        ? mediaUrl(voice.handle)
                        : null;
                      return h('div', {
                        key: asset.assetId,
                        'data-dsh-asset': asset.assetId,
                        'data-dsh-asset-row': 'true',
                        'data-dsh-asset-kind': asset.kind,
                        ...(asset.kind === 'character' ? { 'data-dsh-character': asset.assetId } : {}),
                        ...(asset.kind === 'character'
                          ? { 'data-dsh-character-voice-state': voice === null ? 'missing' : 'ready' }
                          : {}),
                        className: 'sdd-asset-tile',
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => onOpen(asset),
                        onKeyDown: (event) => { if (event.key === 'Enter') onOpen(asset); },
                        style: {
                          width: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                          alignItems: 'stretch',
                          padding: '10px',
                          border: '2px solid var(--dsw-border-strong, #c5cec9)',
                          borderRadius: '8px',
                          background: 'var(--dsw-surface-raised, #fff)',
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: 'pointer',
                          minWidth: 0,
                          position: 'relative',
                          boxShadow: '0 3px 10px rgba(20,34,29,.10)',
                          transition: 'border-color .15s ease, box-shadow .15s ease, transform .15s ease',
                        },
                      },
                        h('div', { className: 'sdd-asset-tile-cover', style: { width: '100%', aspectRatio: asset.kind === 'character' ? '4 / 5' : asset.kind === 'prop' ? '1 / 1' : '16 / 9', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', border: '1px solid var(--dsw-border-default, #dbe2de)', borderRadius: '6px', background: 'rgba(127,127,127,.08)' } },
                          isAudio
                            ? h(MediaPlaceholder, { kind: 'audio', label: asset.name })
                            : cover !== null && typeof previewUrl === 'function'
                            ? h(PreviewImage, {
                              src: previewUrl(cover),
                              'data-dsh-asset-cover': selectedCover?.assetVersionId ?? undefined,
                              alt: selectedCover?.fileName ? `${asset.name} 当前输入 ${selectedCover.fileName}` : asset.name,
                              loading: 'lazy',
                              style: { width: '100%', height: '100%', objectFit: 'contain' },
                            })
                            : h('span', { style: { fontSize: '10px', opacity: 0.6 } }, '暂无图片')),
                        h('button', {
                          type: 'button',
                          'data-dsh-delete-asset': asset.assetId,
                          'aria-label': `删除资产 ${asset.name}`,
                          title: deleteArmedAssetId === asset.assetId ? '再次点击确认删除整个资产' : '删除资产',
                          disabled: importBusy === asset.assetId || typeof onDeleteAsset !== 'function',
                          style: {
                            position: 'absolute',
                            top: '6px',
                            right: '6px',
                            zIndex: 1,
                            width: '26px',
                            height: '26px',
                            minWidth: '26px',
                            padding: 0,
                            border: '1px solid var(--dsw-border-default, #d0d5dd)',
                            borderRadius: '6px',
                            background: 'color-mix(in srgb, var(--dsw-surface-raised, #fff) 86%, transparent)',
                            color: deleteArmedAssetId === asset.assetId ? 'var(--sdd-danger, #d14343)' : 'var(--dsw-text-secondary, #58677b)',
                            cursor: 'pointer',
                          },
                          onClick: (event) => {
                            event?.stopPropagation?.();
                            void deleteAssetAction(asset);
                          },
                        }, h(SddIcon, { name: 'trash-2', size: 13 })),
                        h('div', { className: 'sdd-asset-tile-copy', style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0, paddingTop: '7px', borderTop: '1px solid var(--dsw-border-default, #dbe2de)' } },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } },
                            h('strong', { title: asset.name, style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' } }, asset.name),
                            selectedCover !== null
                              ? h('span', { title: selectedCover.fileName, style: css.stateTag('resolved') }, '当前输入')
                              : null,
                            asset.usedInEpisode === true ? h('span', { style: css.stateTag('resolved') }, '本集') : null,
                            (asset.missingCount ?? 0) > 0 ? h('span', { style: css.stateTag('review') }, `缺 ${asset.missingCount}`) : null),
                          h('span', { title: asset.description ?? '', style: { fontSize: '9.5px', lineHeight: 1.35, opacity: 0.68, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, asset.description ?? '暂无简介'),
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
                            h('span', { style: { fontSize: '9px', opacity: 0.55 } }, `${(asset.variants ?? []).length} 变体 · ${asset.versionCount ?? 0} 文件`),
                            asset.kind === 'character'
                              ? h('span', { style: css.stateTag(voice === null ? 'review' : 'resolved') }, voice === null ? '音色未上传' : '音色已上传')
                              : null),
                          asset.kind === 'character'
                            ? h('div', {
                              'data-dsh-character-voice-control': asset.assetId,
                              style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
                              onClick: (event) => event.stopPropagation(),
                              onKeyDown: (event) => event.stopPropagation(),
                            },
                              voiceUrl !== null
                                ? h(PreviewAudio, {
                                  src: voiceUrl,
                                  'data-dsh-character-voice-player': asset.assetId,
                                  'aria-label': `${asset.name} 的人物音色`,
                                  style: { width: '100%', height: '30px' },
                                })
                                : null,
                              h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' } },
                                uploadControl(asset, identity?.name ?? 'default', 'voice', voice === null ? '上传音色' : '替换音色'),
                                voice === null ? null : h('span', { title: voice.fileName, style: { fontSize: '9px', opacity: 0.56, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                  voice.fileName)))
                            : null));
                    })),
                  id === 'reference-audio'
                    ? h('label', {
                      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '8px', border: '1px dashed var(--dsw-border-default, #aaa)', borderRadius: '5px', cursor: 'pointer', fontSize: '10.5px' },
                      'data-dsh-add-asset': 'reference-audio',
                    },
                      h('span', null, importBusy === 'reference-audio' ? '正在添加…' : '＋ 上传参考音频'),
                      h('input', {
                        type: 'file',
                        multiple: true,
                        style: { display: 'none' },
                        'data-dsh-asset-file': 'reference-audio',
                        accept: '.mp3,.wav,.flac,.ogg,.m4a,.aac,audio/*',
                        disabled: importBusy !== null || typeof onImport !== 'function',
                        onChange: (event) => importFiles('reference-audio', event),
                      }))
                    : null);
              }),
        imageViewer);
    }

    /**
     * The generation ledger.
     *
     * A state name alone does not tell the user what to do, so the two states that need an
     * action carry their instruction with them: an unconfirmed submission must be checked
     * before anything is sent again, and a failed download must not be answered by re-running
     * the model. Both are the difference between a wasted GPU hour and a click.
     */
    function JobsView({ t, jobs, onRefresh, busy }) {
      const compactTrail = (events) => {
        const seen = new Set();
        const trail = [];
        for (const event of Array.isArray(events) ? events : []) {
          const state = String(event?.state ?? '');
          if (state.length === 0) continue;
          const key = `${state}|${String(event?.note ?? '')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          trail.push(event);
        }
        return trail;
      };
      /**
       * Character four-view is a two-step operation: image edit, then upscale. The ledger keeps
       * both jobs on purpose, but showing two near-identical cards makes one click look like two
       * generations. Group those two steps, and also fold repeated attempts from the same source
       * portrait and variant into one row.
       */
      const displayJobs = (() => {
        const groups = new Map();
        const inputKeyOf = (job) => (job.inputs ?? [])
          .map((input) => String(input.sha256 ?? input.fileName ?? ''))
          .filter(Boolean)
          .join(',');
        const sourceInputByRequest = new Map((jobs ?? [])
          .filter((job) => typeof job.requestId === 'string' && !job.requestId.endsWith('-upscale'))
          .map((job) => [job.requestId, inputKeyOf(job)]));
        for (const job of jobs ?? []) {
          const name = String(job.name ?? '');
          const isQuadview = /四视图/u.test(name);
          const baseName = name.replace(/·3x$/u, '');
          // The upscale step's direct input is the generated still, so its own hash cannot
          // identify the source portrait. Look up the generation step by the shared request id.
          const baseRequest = typeof job.requestId === 'string' ? job.requestId.replace(/-upscale$/u, '') : '';
          const inputKey = isQuadview
            ? (sourceInputByRequest.get(baseRequest) ?? inputKeyOf(job))
            : inputKeyOf(job);
          const key = isQuadview
            ? `quad:${String(job.projectId ?? '')}:${baseName}:${inputKey}`
            : `job:${String(job.jobId ?? '')}`;
          const previous = groups.get(key);
          if (previous === undefined) {
            groups.set(key, { ...job, displayKey: key, stepCount: 1, historyCount: 1, displayName: baseName });
            continue;
          }
          previous.stepCount += 1;
          previous.historyCount += 1;
          previous.saved = [...(previous.saved ?? []), ...(job.saved ?? [])];
          previous.files = [...(previous.files ?? []), ...(job.files ?? [])];
          previous.events = [...(previous.events ?? []), ...(job.events ?? [])];
          if (previous.state !== 'saved' && job.state === 'saved') previous.state = 'saved';
        }
        return [...groups.values()];
      })();
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: css.row },
          h('button', {
            type: 'button',
            'data-dsh-jobs-refresh': 'true',
            style: css.button(false),
            disabled: busy,
            onClick: onRefresh,
            title: '重新查询 ComfyUI、下载已完成结果并刷新候选',
          },
            busy ? t('loading') : t('jobs.refresh')),
        ),
        (jobs ?? []).length === 0 && h('div', { style: css.note }, t('jobs.empty')),
        displayJobs.map((job) => h('div', {
          key: job.displayKey,
          className: 'sdd-job-card',
          'data-dsh-job-id': job.jobId ?? null,
          style: css.jobCard,
        },
          h('div', { style: css.jobHead },
            h('span', { style: css.stateTag(job.state === 'saved' ? 'resolved' : 'review') }, t(`jobs.state.${job.state}`)),
            job.displayName !== '' ? h('span', null, job.displayName) : null,
            job.stepCount > 1 ? h('span', { style: { fontSize: '10px', opacity: 0.65 } }, `· 合并 ${String(job.stepCount)} 条任务`) : null,
            h('span', { style: css.jobId }, job.jobId ?? '—'),
          ),
          job.corrupt === true ? h('div', { style: css.jobWarn }, t('jobs.corrupt')) : null,
          job.refreshError !== null && job.refreshError !== undefined
            ? h('div', { 'data-dsh-job-refresh-error': job.jobId ?? 'unknown', style: css.jobWarn },
              `云端刷新失败：${String(job.refreshError)}`)
            : null,
          job.shotId !== null && job.shotId !== undefined ? h('div', { style: css.assetMeta }, `${t('jobs.shot')}：${job.shotId}`) : null,
          (job.inputs ?? []).length > 0
            ? h('div', { style: css.assetMeta }, `${t('jobs.inputs')}：${job.inputs.map((input) => input.fileName).join('、')}`)
            : null,
          (job.saved ?? []).length > 0
            ? h('div', { style: css.assetMeta }, `${t('jobs.saved')}：${job.saved.length}`)
            : null,
          compactTrail(job.events).length > 0
            ? h('div', { style: css.jobTrail }, compactTrail(job.events).map((event, index) => h('span', {
              key: `${event.state}-${index}`,
              'data-dsh-job-event': event.state,
              style: css.jobStep,
              title: [event.at, event.note].filter(Boolean).join(' · '),
            }, t(`jobs.state.${event.state}`) ?? event.state)))
            : null,
          job.state === 'submission_unknown' ? h('div', { style: css.jobWarn }, `⛔ ${t('jobs.unknownHint')}`) : null,
          job.state === 'download_failed' ? h('div', { style: css.jobWarn }, `⚠ ${t('jobs.downloadFailedHint')}`) : null,
        )),
      );
    }

  function reconcileDraft(stored, fileText) {
    if (stored === null) return { draft: fileText, restored: false, conflict: null, base: fileText };
    const conflicted = stored.base !== null && stored.base !== fileText && stored.text !== fileText;
    if (conflicted) return { draft: stored.text, restored: true, conflict: { diskText: fileText, draftText: stored.text }, base: stored.base };
    if (stored.text !== fileText) return { draft: stored.text, restored: true, conflict: null, base: stored.base ?? fileText };
    return { draft: fileText, restored: false, conflict: null, base: fileText };
  }

    /**
     * Somewhere to keep a draft that survives a reload.
     *
     * `localStorage` and not a file: a draft is not project data, it is the unsaved state of one
     * open editor, and writing it into the project would put half-finished text next to the
     * prompts the model reads. Every access is guarded because storage throws when it is full or
     * when the browser has it disabled, and losing the draft feature must never take the panel
     * with it.
     */
    const draftStore = {
      key: (project, file, shotId) => `dsh-sdd-draft:${project}|${file}|${shotId}`,
      /**
       * `{ text, base }`, where `base` is what the file said when the draft was started.
       *
       * The base is the whole point of keeping it: without it a draft cannot tell "the user is
       * still editing" from "somebody changed the file while this was open", and the only safe
       * behaviour left is to silently pick one - which loses the other. Kept as JSON, and a plain
       * string from an older version is still read so an existing draft is not thrown away.
       */
      read(project, file, shotId) {
        try {
          const raw = globalThis.localStorage?.getItem(draftStore.key(project, file, shotId));
          if (typeof raw !== 'string' || raw.length === 0) return null;
          if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.text === 'string') return { text: parsed.text, base: typeof parsed.base === 'string' ? parsed.base : null };
            return null;
          }
          return { text: raw, base: null };
        } catch {
          return null;
        }
      },
      write(project, file, shotId, text, base) {
        try {
          if (typeof text !== 'string' || text.length === 0) globalThis.localStorage?.removeItem(draftStore.key(project, file, shotId));
          else globalThis.localStorage?.setItem(draftStore.key(project, file, shotId), JSON.stringify({ text, base: base ?? null }));
        } catch {
          // A full or disabled storage means the draft feature is unavailable, not that the panel
          // is broken.
        }
      },
      clear(project, file, shotId) {
        try {
          globalThis.localStorage?.removeItem(draftStore.key(project, file, shotId));
        } catch {
          // See above.
        }
      },
    };

    /**
     * The handle to SHOW for one asset row or variant: the thumbnail when there is one, the original
     * otherwise.
     *
     * Two fields arrive for the same variant and they are not interchangeable. `thumbnails` is a
     * handle to the full-resolution file - a character sheet is about 1.9 MB - and `thumbnailHandles`
     * is the scaled-down preview the Host produced alongside it. The grid was reading the first one,
     * so a wall of assets meant downloading a wall of full-size stills, which is exactly the weight
     * the thumbnail cache exists to remove. Caught when the user reported "资产部分也没有图片": the
     * images WERE requested, but a browser decoding six 1.9 MB PNGs inside a sidebar panel does not
     * visibly finish, which looks identical to nothing loading at all.
     *
     * Falls back to the original rather than showing nothing, because a project where no scaler is
     * available still has assets worth seeing.
     */
    function previewHandleFor(entry, variantId = null) {
      const selected = variantId === null
        ? Object.values(entry?.selectedHandles ?? {})[0] ?? null
        : entry?.selectedHandles?.[variantId] ?? null;
      if (selected !== null && selected !== undefined) {
        const selectedHandle = selected.thumbnailHandle ?? selected.handle ?? null;
        if (typeof selectedHandle === 'string' && selectedHandle.length > 0) return selectedHandle;
      }
      const handles = entry?.thumbnailHandles ?? {};
      const thumbs = entry?.thumbnails ?? {};
      if (variantId !== null && typeof handles[variantId] === 'string' && handles[variantId].length > 0) return handles[variantId];
      const firstHandle = Object.values(handles)[0];
      if (typeof firstHandle === 'string' && firstHandle.length > 0) return firstHandle;
      const firstThumb = Object.values(thumbs)[0];
      return typeof firstThumb === 'string' && firstThumb.length > 0 ? firstThumb : null;
    }

    /** Which kind of media a candidate is, from its name. The store already refused anything else. */
    function mediaKindOf(fileName) {
      const name = String(fileName ?? '');
      if (/\.(mp4|webm|mov|mkv)$/iu.test(name)) return 'video';
      if (/\.(mp3|wav|flac|ogg|m4a|aac)$/iu.test(name)) return 'audio';
      return 'image';
    }

    /**
     * One candidate's media, as a picture, a player or a waveform.
     *
     * A video is NEVER autoplayed and never preloads its bytes: a grid of twenty attempts that all
     * start playing is both a performance problem and a usability one. `metadata` is enough to
     * show a first frame and a duration, which is what a chooser needs.
     */
    function MediaPane({ t, row, mediaUrl, previewUrl, style, controls = true, prefer = 'original' }) {
      const src = row.mediaHandle === null || row.mediaHandle === undefined || mediaUrl === undefined
        ? undefined
        : mediaUrl(row.mediaHandle);
      if (src === undefined) return h('div', { style: css.assetThumbEmpty }, t('assets.noThumb'));
      const kind = mediaKindOf(row.fileName);
      // A STILL can be shown from its scaled copy; a video cannot, because the thumbnail cache makes
      // no video previews and a media element needs the real file to seek in. So the grid asks for
      // `prefer: 'thumbnail'` and the comparison does not: scanning twenty candidates should cost
      // twenty thumbnails, while looking closely at two should show the actual pixels.
      //
      // `previewUrl` on BOTH branches, and never the bare route URL: `<PreviewImage>` reads the
      // loader map that `mediaUrl` fills in, and a source it cannot resolve is handed to the browser
      // as-is. Which HANDLE is chosen is the `prefer` decision above and is unchanged by this.
      const shown = prefer === 'thumbnail' && kind === 'image'
        && row.thumbnailHandle !== null && row.thumbnailHandle !== undefined && previewUrl !== undefined
        ? previewUrl(row.thumbnailHandle)
        : previewUrl === undefined ? src : previewUrl(row.mediaHandle);
      if (kind === 'video') return h(PreviewVideo, { src, style, controls, fallbackLabel: '视频' });
      if (kind === 'audio') return h(PreviewAudio, { src: shown, controls, style: { width: '100%' } });
      return h(PreviewImage, { src: shown, style, alt: row.fileName, loading: 'lazy' });
    }

    /**
     * Two candidates, side by side.
     *
     * This is the question a review actually asks - "which of these two" - and it is the one a
     * grid cannot answer: judged one at a time, the first is forgotten by the time the second is
     * on screen, and the choice becomes "which do I remember liking".
     *
     * Exactly two panes, never more: a third makes each one too small to judge, which defeats the
     * purpose. Mixing a still with a clip is refused for the same reason - there is no comparison
     * to make between them.
     */
    function CompareView({ t, rows, mediaUrl, previewUrl, onExit, onSelect, onPromote, onRedo, destination, busyId }) {
      const pane = (row, label) => h('div', { style: css.comparePane(false), 'data-dsh-compare': row.candidateId },
        h('span', { style: css.stateTag(row.status === 'selected' ? 'resolved' : 'review') },
          row.status === 'selected' ? t('results.selected') : t('results.unreviewed')),
        h('span', { style: css.resultMeta, title: row.fileName }, `${label} · ${row.fileName}`),
        h(MediaPane, { t, row, mediaUrl, previewUrl, style: css.compareMedia }),
        h('span', { style: css.resultMeta }, String(row.generatedAt ?? '').slice(0, 19).replace('T', ' ')),
        h('div', { style: css.resultActions },
          row.status === 'selected'
            ? h('span', { style: css.assetMeta }, t('results.selected'))
            : h('button', {
              type: 'button',
              style: css.miniButton,
              disabled: busyId === row.candidateId,
              onClick: () => onSelect(row.candidateId),
            }, busyId === row.candidateId ? t('results.selecting') : t('results.select')),
          h('button', {
            type: 'button',
            style: css.miniButton,
            disabled: row.status !== 'selected' || busyId === row.candidateId,
            title: row.status === 'selected' ? t('results.promote') : t('results.needSelect'),
            onClick: () => onPromote(row, destination),
          }, t('results.promote')),
          h('button', {
            type: 'button',
            style: css.miniButton,
            disabled: busyId === row.candidateId,
            onClick: () => onRedo(row),
          }, busyId === row.candidateId ? t('results.redoing') : t('results.redo')),
        ),
      );

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: css.row },
          h('button', { type: 'button', style: css.button(false), onClick: onExit }, t('results.compareBackToGrid')),
          h('span', { style: css.assetMeta }, t('results.compareTitle')),
        ),
        h('div', { style: css.compareGrid(rows.length) },
          rows.map((row, index) => pane(row, `${index + 1}`)),
        ),
      );
    }

    /**
     * Result workspace.
     *
     * This view is intentionally just refresh + playable videos. Selection, comparison, promotion
     * and cleanup belong to the shot workflow; repeating them here made the tab another editor and
     * put a 「存到本集」 action directly under a clip that was already attached to its block.
     */
    function ResultsView({ t, candidates, mediaUrl, previewUrl, busy, onRefresh }) {
      const videos = candidates
        .filter((row) => mediaKindOf(row.fileName) === 'video')
        .map((row) => {
          const src = row.mediaHandle === null || row.mediaHandle === undefined || mediaUrl === undefined
            ? undefined
            : (previewUrl === undefined ? mediaUrl(row.mediaHandle) : previewUrl(row.mediaHandle));
          return { row, src };
        })
        .filter((entry) => typeof entry.src === 'string' && entry.src.length > 0);

      return h('div', {
        'data-dsh-results-root': 'true',
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      },
        h('div', { style: css.row },
          h('button', {
            type: 'button',
            'data-dsh-results-refresh': 'true',
            style: css.button(false),
            disabled: busy,
            onClick: onRefresh,
          }, busy ? t('results.loading') : t('results.refresh'))),
        videos.length === 0 ? null : h('div', { 'data-dsh-result-grid': 'true', style: css.resultGrid }, videos.map(({ row, src }) => h('div', {
          key: row.candidateId,
          className: 'sdd-result-card',
          style: css.resultCard(row.status),
          'data-dsh-result-video': row.candidateId,
        }, h(PreviewVideo, {
          src,
          controls: true,
          style: {
            ...css.resultMedia,
            width: '100%',
            aspectRatio: '9 / 16',
            height: '100%',
            objectFit: 'cover',
            background: '#000',
            border: '1px solid rgba(127,127,127,0.45)',
          },
          fallbackLabel: '视频',
        })))));
    }

    /**
     * Global, cross-project generation configuration.
     *
     * The local/cloud split is deliberately visible rather than hidden behind one combined
     * "instance" field: users often run only one of them, and some do not configure cloud at
     * all. Video generation is the exception: its workflow is the detected H3 graph, so only
     * the instance status is shown there, plus the fields that graph safely allows us to edit.
     */
    function GlobalConfigView({
      t,
      data,
      draft,
      setDraft,
      task,
      setTask,
      videoMode,
      setVideoMode,
      busy,
      saving,
      error,
      note,
      promptBusy,
      onRefresh,
      onSave,
      onUploadPrompt,
      onDeletePrompt,
      onInspectVideoWorkflow,
    }) {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const [videoInspections, setVideoInspections] = React.useState({});
      const [videoInspectionBusy, setVideoInspectionBusy] = React.useState({});
      const [videoInspectionErrors, setVideoInspectionErrors] = React.useState({});
      const videoInspectionSequence = React.useRef({});
      if (busy && data === null) return h('div', { style: css.note }, '正在识别工作流和 ComfyUI 配置…');
      if (data === null) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px' } },
          h('div', { style: css.error }, error || '还没有读到全局配置'),
          h('button', { type: 'button', style: css.button(true), onClick: onRefresh }, '重新识别'));
      }
      const tasks = data.tasks ?? [];
      const taskIcons = {
        'text-to-image': 'image',
        'image-edit': 'sparkles',
        'upscale-image': 'maximize-2',
        'upscale-video': 'video',
        'video-generation': 'monitor-play',
      };
      const currentTask = tasks.find((entry) => entry.id === task) ?? tasks[0];
      const isVideo = currentTask?.id === 'video-generation';
      const environments = [data.environments?.local, data.environments?.cloud].filter(Boolean);
      const workflowDirectories = Array.isArray(data.workflowDirectories) ? data.workflowDirectories : [];
      const workflowOptionLabel = (entry) => {
        const relativePath = entry.relativePath ?? entry.name;
        if (workflowDirectories.length <= 1) return relativePath;
        const index = workflowDirectories.findIndex((directory) => directory.dir === entry.workflowRoot);
        return index < 0 ? relativePath : `${String(index + 1)} · ${relativePath}`;
      };
      const promptSources = data.promptSources ?? null;
      const promptOptions = promptSources?.options ?? [];
      const promptSelectedId = draft?.promptSource?.selected ?? promptSources?.selected ?? '';
      const selectedPrompt = promptOptions.find((entry) => entry.id === promptSelectedId)
        ?? promptSources?.selectedSource
        ?? null;
      const setPromptSource = (selected) => {
        setDraft((previous) => {
          if (previous === null) return previous;
          const next = clone(previous);
          next.promptSource = { ...(next.promptSource ?? {}), selected };
          return next;
        });
      };
      const uploadPromptDocument = (event) => {
        const file = event?.target?.files?.[0];
        if (file === undefined || file === null || typeof onUploadPrompt !== 'function') return;
        const encodeBase64 = (bytes) => {
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          const output = [];
          for (let index = 0; index < bytes.length; index += 3) {
            const first = bytes[index];
            const second = bytes[index + 1];
            const third = bytes[index + 2];
            const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
            output.push(
              alphabet[(triple >> 18) & 63],
              alphabet[(triple >> 12) & 63],
              second === undefined ? '=' : alphabet[(triple >> 6) & 63],
              third === undefined ? '=' : alphabet[triple & 63],
            );
          }
          return output.join('');
        };
        const send = (encoded) => Promise.resolve(onUploadPrompt({ fileName: file.name, fileDataBase64: encoded }))
          .catch(() => { /* the parent reports the failure */ });
        // Modern browsers expose File.arrayBuffer; use it first so the upload does not depend
        // on the FileReader global being present (it is also how the Node panel tests drive it).
        if (typeof file.arrayBuffer === 'function') {
          file.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer);
            send(encodeBase64(bytes));
          }).catch(() => { /* the parent reports the failure */ });
          event.target.value = '';
          return;
        }
        const reader = new globalThis.FileReader();
        reader.onload = () => {
          const encoded = String(reader.result ?? '').replace(/^data:[^,]*,/u, '');
          send(encoded);
        };
        reader.readAsDataURL(file);
        event.target.value = '';
      };
      const updateTaskWorkflow = (kind, taskId, file) => {
        setDraft((previous) => {
          const next = clone(previous);
          next.tasks[kind][taskId] = file;
          return next;
        });
      };
      const selectedEndpoint = draft?.endpoints?.[currentTask?.id] === 'cloud' ? 'cloud' : 'local';
      const lowLocalVideoVram = isVideo
        && selectedEndpoint === 'local'
        && data.video?.recommendation?.belowRecommended === true;
      const setTaskEndpoint = (kind) => {
        setDraft((previous) => {
          const next = clone(previous);
          next.endpoints = { ...(next.endpoints ?? {}), [currentTask.id]: kind };
          return next;
        });
      };
      const updateVideoEnv = (kind, mutate) => {
        setDraft((previous) => {
          const next = clone(previous);
          mutate(next.video[kind]);
          return next;
        });
      };
      const inspectVideoWorkflowSelection = async (kind, file) => {
        if (typeof onInspectVideoWorkflow !== 'function' || file.length === 0) return;
        const sequence = (videoInspectionSequence.current[kind] ?? 0) + 1;
        videoInspectionSequence.current[kind] = sequence;
        setVideoInspectionBusy((previous) => ({ ...previous, [kind]: true }));
        setVideoInspectionErrors((previous) => ({ ...previous, [kind]: '' }));
        try {
          const inspected = await onInspectVideoWorkflow({ environmentKind: kind, workflow: file });
          if (inspected === null || inspected === undefined || videoInspectionSequence.current[kind] !== sequence) return;
          setVideoInspections((previous) => ({ ...previous, [kind]: inspected }));
          updateVideoEnv(kind, (video) => {
            const models = Array.isArray(inspected.modelOptions) ? inspected.modelOptions : [];
            if (models.length > 0 && !models.includes(video.model)) video.model = inspected.model ?? models[0];
            const schedulers = Array.isArray(inspected.schedulerOptions) ? inspected.schedulerOptions : [];
            if (schedulers.length > 0) {
              for (const modeName of ['drama', 'action']) {
                if (!schedulers.includes(video.modes[modeName].scheduler)) {
                  video.modes[modeName].scheduler = inspected.controls?.scheduler?.scheduler ?? schedulers[0];
                }
              }
            }
          });
        } catch (failure) {
          if (videoInspectionSequence.current[kind] !== sequence) return;
          setVideoInspectionErrors((previous) => ({ ...previous, [kind]: String(failure?.message ?? failure) }));
        } finally {
          if (videoInspectionSequence.current[kind] === sequence) {
            setVideoInspectionBusy((previous) => ({ ...previous, [kind]: false }));
          }
        }
      };
      const environmentCard = (environment) => {
        const local = environment.kind === 'local';
        const selected = environment.kind === selectedEndpoint;
        const accent = local ? '#1769aa' : '#b45309';
        const tint = selected
          ? `color-mix(in srgb, ${accent} 10%, var(--sdd-surface))`
          : 'var(--sdd-surface)';
        const workflowEntries = [...(currentTask?.environmentWorkflows?.[environment.kind] ?? currentTask?.workflows ?? [])];
        const selectedWorkflowFile = isVideo
          ? (draft?.video?.[environment.kind]?.workflow ?? data.video?.environments?.[environment.kind]?.workflow?.file ?? '')
          : (draft?.tasks?.[environment.kind]?.[currentTask?.id] ?? '');
        if (isVideo && selectedWorkflowFile.length > 0 && !workflowEntries.some((entry) => entry.file === selectedWorkflowFile)) {
          workflowEntries.unshift({
            file: selectedWorkflowFile,
            name: selectedWorkflowFile.replace(/\\/gu, '/').split('/').pop(),
            relativePath: selectedWorkflowFile.replace(/\\/gu, '/').split('/').pop(),
          });
        }
        const workflow = workflowEntries.find((entry) => entry.file === selectedWorkflowFile) ?? null;
        const vosr2Default = ['upscale-image', 'upscale-video'].includes(currentTask?.id)
          && workflowEntries.some((entry) => /VOSR2/iu.test(String(entry.name ?? '')));
        const reachable = environment.reachable === true;
        const liveInstance = (environment.instances ?? []).find((row) => row.reachable) ?? null;
        const statusLine = environment.configured !== true
          ? (environment.note || '未配置')
          : reachable
            ? `${environment.baseUrl}${liveInstance?.comfyuiVersion === null || liveInstance?.comfyuiVersion === undefined ? '' : ` · ComfyUI ${liveInstance.comfyuiVersion}`}`
            : (environment.note || '未响应');
        return h('section', {
          key: environment.kind,
          'data-dsh-config-env': environment.kind,
          'data-active': selected ? 'true' : 'false',
          className: 'sdd-config-env',
          style: {
            minWidth: 0,
            border: selected ? `2px solid ${accent}` : '1px solid var(--sdd-border)',
            borderLeft: `4px solid ${accent}`,
            borderRadius: '6px',
            background: tint,
            boxShadow: selected ? `0 0 0 2px ${accent}22` : 'none',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            h('span', {
              style: {
                padding: '2px 6px',
                borderRadius: '4px',
                background: accent,
                color: '#fff',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.04em',
              },
            }, local ? 'LOCAL / 本地' : 'CLOUD / 云端'),
            h('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: reachable ? 'var(--sdd-success)' : (environment.configured ? 'var(--sdd-danger)' : 'var(--sdd-muted)'),
              },
            }),
            h('strong', { style: { fontSize: '12px' } }, local ? '本地 ComfyUI' : '云端 ComfyUI') ),
          selected
            ? h('span', { style: { alignSelf: 'flex-start', padding: '1px 6px', borderRadius: '999px', background: accent, color: '#fff', fontSize: '9px', fontWeight: 700 } }, '当前使用')
            : null,
          h('div', { style: { fontSize: '11px', lineHeight: 1.45, wordBreak: 'break-word' } },
            statusLine),
          ...(environment.configured === true
            ? (environment.instances ?? []).filter((row) => row.reachable).slice(0, 2).map((row, index) => h('div', {
              key: `${environment.kind}-${index}`,
              style: { fontSize: '10px', opacity: 0.75, wordBreak: 'break-word' },
            }, `${row.baseUrl}${row.queue === null ? '' : ` · 队列 ${row.queue.running}/${row.queue.pending}`}${(row.devices ?? []).length === 0 ? '' : ` · ${row.devices[0].name}`}`))
            : []),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('label', { style: { fontSize: '10px', fontWeight: 600 } }, isVideo ? '视频生成工作流' : `${currentTask?.label ?? '任务'}工作流`),
            h('select', {
              ...(isVideo ? { 'data-dsh-video-workflow': environment.kind } : { 'data-dsh-workflow-select': `${environment.kind}:${currentTask?.id ?? ''}` }),
              value: selectedWorkflowFile,
              disabled: environment.configured !== true || workflowEntries.length === 0,
              onChange: (event) => {
                const file = event.target.value;
                if (isVideo) {
                  updateVideoEnv(environment.kind, (video) => { video.workflow = file; });
                  void inspectVideoWorkflowSelection(environment.kind, file);
                } else {
                  updateTaskWorkflow(environment.kind, currentTask.id, file);
                }
              },
              style: { ...css.select, width: '100%', maxWidth: '100%', minWidth: 0 },
            },
              selectedWorkflowFile === ''
                ? h('option', { value: '' }, environment.configured === true ? '选择工作流' : (environment.note || '未配置'))
                : null,
              workflowEntries.map((entry) => h('option', {
                key: entry.file,
                value: entry.file,
              }, workflowOptionLabel(entry))),
              workflowEntries.length === 0
                ? h('option', { value: '' }, environment.kind === 'cloud' ? '云端没有返回可用工作流' : '没有识别到适用的工作流')
                : null),
            h('span', { style: { fontSize: '10px', opacity: 0.62 } },
              environment.kind === 'cloud'
                ? `云端实例工作流 ${String(workflowEntries.length)} 个${reachable ? '' : '（上次同步缓存）'}`
                : `本地工作流 ${String(workflowEntries.length)} 个`),
            isVideo && videoInspectionBusy[environment.kind] === true
              ? h('span', { style: { fontSize: '10px', opacity: 0.68 } }, '正在重新识别模型和调度器…')
              : isVideo && videoInspectionErrors[environment.kind]
                ? h('span', { style: { fontSize: '10px', color: 'var(--sdd-danger)' } }, videoInspectionErrors[environment.kind])
                : null,
            !isVideo && vosr2Default
              ? h('span', { style: { fontSize: '10px', opacity: 0.68 } }, '未选择时默认使用 VOSR2；明确选择后以你的选择为准。')
              : null,
            !isVideo && workflow?.matchesTask === false
              ? h('span', { style: { fontSize: '10px', color: 'var(--sdd-warning)' } }, '这个工作流未被自动识别为当前任务；保存时会按你的手动选择使用。')
              : null,
            workflow === null
              ? null
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '10px', opacity: 0.78 } },
                h('span', null, `能力：${(workflow.capabilities ?? []).join('、') || '未识别'}`),
                h('span', null, `模型：${workflow.modelCount ?? '未识别'} 个`),
                workflow.outputInactive ? h('span', { style: { color: 'var(--sdd-danger)', fontWeight: 600 } }, '输出节点当前被旁路，运行不会产出文件') : null)),
          );
      };
      const videoEnvironmentPanel = (kind) => {
        const local = kind === 'local';
        const selected = kind === selectedEndpoint;
        const accent = local ? '#1769aa' : '#b45309';
        const tint = selected
          ? `color-mix(in srgb, ${accent} 10%, var(--sdd-surface))`
          : 'var(--sdd-surface)';
        const meta = videoInspections[kind] ?? data.video?.environments?.[kind] ?? null;
        const configured = draft?.video?.[kind] ?? null;
        const mode = configured?.modes?.[videoMode] ?? null;
        if (configured === null || mode === null) {
          return h('section', {
            key: kind,
            className: 'sdd-config-video-env',
            style: {
              border: '1px solid var(--sdd-border)',
              borderRadius: '8px',
              padding: '10px',
              background: 'var(--sdd-surface)',
              fontSize: '11px',
            },
          },
            `${local ? '本地' : '云端'}视频配置不可用`);
        }
        const modelOptions = [...(meta?.modelOptions ?? [])];
        if (typeof configured.model === 'string' && !modelOptions.includes(configured.model)) modelOptions.unshift(configured.model);
        const schedulerOptions = [...(meta?.schedulerOptions ?? [])];
        if (typeof mode.scheduler === 'string' && !schedulerOptions.includes(mode.scheduler)) schedulerOptions.unshift(mode.scheduler);
        const setModeValue = (key, value) => updateVideoEnv(kind, (video) => {
          const next = video.modes[videoMode];
          next[key] = value;
          next.totalSteps = Number(next.firstPassSteps) + Number(next.secondPassSteps);
        });
        const workflow = meta?.workflow ?? null;
        const fieldStyle = {
          ...css.select,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
        };
        const fieldLabelStyle = { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', fontWeight: 600, minWidth: 0 };
        return h('section', {
          key: kind,
          'data-dsh-video-env': kind,
          'data-active': selected ? 'true' : 'false',
          className: 'sdd-config-video-env',
          style: {
            minWidth: 0,
            border: selected ? `2px solid ${accent}` : '1px solid var(--sdd-border)',
            borderLeft: `4px solid ${accent}`,
            borderRadius: '6px',
            background: tint,
            boxShadow: selected ? `0 0 0 2px ${accent}22` : 'none',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
          },
        },
          h('div', { style: { display: 'flex', gap: '7px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { padding: '2px 6px', borderRadius: '4px', background: accent, color: '#fff', fontSize: '10px', fontWeight: 700 } },
              local ? 'LOCAL / 本地' : 'CLOUD / 云端'),
            h('strong', { style: { fontSize: '11px' } }, '视频参数'),
            local && data.video?.recommendation?.belowRecommended === true
              ? h('span', { style: { padding: '1px 6px', borderRadius: '999px', background: 'var(--sdd-warning)', color: '#111', fontSize: '9px', fontWeight: 700 } }, '低于推荐显存')
              : null,
            selected
              ? h('span', { style: { padding: '1px 6px', borderRadius: '999px', background: accent, color: '#fff', fontSize: '9px', fontWeight: 700 } }, '当前使用')
              : null),
          workflow?.willCreate === true
            ? h('div', { style: { fontSize: '10px', color: 'var(--sdd-warning)' } }, '保存时创建这个环境的独立工作流副本')
            : null,
          h('label', { style: fieldLabelStyle },
            '视频模型',
            h('select', {
              'data-dsh-video-model': kind,
              value: configured.model ?? '',
              onChange: (event) => updateVideoEnv(kind, (video) => { video.model = event.target.value; }),
              style: fieldStyle,
            },
              modelOptions.length === 0 ? h('option', { value: '' }, '未识别到模型选项') : null,
              modelOptions.map((value) => h('option', { key: value, value }, value)))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' } },
            h('label', { style: fieldLabelStyle },
              '一采步数',
              h('input', {
                type: 'number',
                min: 1,
                max: 199,
                'data-dsh-video-first': kind,
                value: mode.firstPassSteps ?? '',
                onChange: (event) => setModeValue('firstPassSteps', Number(event.target.value)),
                style: fieldStyle,
              })),
            h('label', { style: fieldLabelStyle },
              '二采步数',
              h('input', {
                type: 'number',
                min: 1,
                max: 199,
                'data-dsh-video-second': kind,
                value: mode.secondPassSteps ?? '',
                onChange: (event) => setModeValue('secondPassSteps', Number(event.target.value)),
                style: fieldStyle,
              }))),
          h('label', { style: fieldLabelStyle },
              '基础调度器',
              h('select', {
                'data-dsh-video-scheduler': kind,
                value: mode.scheduler ?? '',
                onChange: (event) => setModeValue('scheduler', event.target.value),
                style: fieldStyle,
              }, schedulerOptions.map((value) => h('option', { key: value, value }, value)))),
          h('div', { style: { fontSize: '10px', opacity: 0.6 } },
            `工作流节点当前：总步数 ${String(meta?.controls?.scheduler?.steps ?? '未识别')}，一采 ${String(meta?.controls?.transition?.value ?? '未识别')}，调度器 ${String(meta?.controls?.scheduler?.scheduler ?? '未识别')}`),
        );
      };
      return h('div', {
        'data-dsh-global-config': 'true',
        className: 'sdd-config-page',
        style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', overflowY: 'auto', minHeight: 0 },
      },
        h('div', { className: 'sdd-config-header' },
          h(SddIcon, { name: 'settings-2', size: 18 }),
          h('h2', { style: { margin: 0, fontSize: '15px' } }, '全局配置'),
          h('span', { style: { fontSize: '10px', opacity: 0.65 } }, '跨项目生效，保存时同时更新视频工作流'),
          workflowDirectories.length > 1
            ? h('span', { title: workflowDirectories.map((entry) => entry.dir).join('\n'), style: { fontSize: '10px', opacity: 0.5, marginLeft: 'auto', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `已合并 ${String(workflowDirectories.length)} 个工作流目录`)
            : typeof data.workflowDirectory === 'string' && data.workflowDirectory.length > 0
              ? h('span', { title: data.workflowDirectory, style: { fontSize: '10px', opacity: 0.5, marginLeft: 'auto', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, data.workflowDirectory)
            : null),
        h('section', {
          'data-dsh-prompt-source-config': 'true',
          className: 'sdd-config-section sdd-config-prompt-source',
          style: {
            border: '1px solid var(--dsw-border-default, #d0d5dd)',
            borderRadius: '8px',
            padding: '11px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            background: 'var(--sdd-surface)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
            h('strong', { style: { fontSize: '12px' } }, '剧本转视频提示词')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            h('select', {
              'data-dsh-prompt-source': 'true',
              value: promptSelectedId,
              disabled: promptOptions.length === 0 || promptBusy === true,
              onChange: (event) => setPromptSource(event.target.value),
              style: { ...css.select, flex: '1 1 220px', minWidth: 0, width: '100%', boxSizing: 'border-box' },
            },
              promptOptions.length === 0
                ? h('option', { value: '' }, '未读取到提示词版本')
                : null,
              promptOptions.map((entry) => h('option', {
                key: entry.id,
                value: entry.id,
              }, entry.kind === 'custom' ? `自定义 · ${entry.label}` : entry.label))),
            h('label', {
              style: {
                ...css.button(false),
                display: 'inline-flex',
                alignItems: 'center',
                cursor: promptBusy === true || typeof onUploadPrompt !== 'function' ? 'not-allowed' : 'pointer',
                opacity: promptBusy === true ? 0.6 : 1,
              },
            },
              promptBusy === true ? '上传中…' : '上传提示词文档',
              h('input', {
                type: 'file',
                'data-dsh-prompt-source-upload': 'true',
                accept: '.txt,.md,.markdown,.text,.docx,.docm,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                disabled: promptBusy === true || typeof onUploadPrompt !== 'function',
                style: { display: 'none' },
                onChange: uploadPromptDocument,
              })),
            selectedPrompt?.kind === 'custom'
              ? h('button', {
                type: 'button',
                'data-dsh-prompt-source-delete': selectedPrompt.id,
                style: css.button(false),
                disabled: promptBusy === true || typeof onDeletePrompt !== 'function',
                onClick: () => Promise.resolve(onDeletePrompt(selectedPrompt.id)).catch(() => { /* the parent reports it */ }),
              }, '删除当前自定义提示词')
              : null),
          h('div', { style: { fontSize: '10px', lineHeight: 1.5, opacity: 0.72, wordBreak: 'break-word' } },
            selectedPrompt === null
              ? '请选择一个提示词版本'
              : `当前文件：${selectedPrompt.label}${selectedPrompt.kind === 'custom' ? '（自定义）' : '（内置）'}${selectedPrompt.characters === null || selectedPrompt.characters === undefined ? '' : ` · ${selectedPrompt.characters} 字`}`),
          promptSources?.error ? h('div', { style: css.error }, promptSources.error) : null,
          h('div', { style: { fontSize: '10px', opacity: 0.58 } },
            '支持 .txt / .md / .docx；上传后会自动选用并立即保存。下拉切换在点击“保存全局配置”后生效。')),
        h('div', { className: 'sdd-config-task-tabs', 'data-dsh-config-task-tabs': 'true' },
          tasks.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            'data-dsh-config-task': entry.id,
            className: entry.id === currentTask?.id ? 'sdd-config-task-tab active' : 'sdd-config-task-tab',
            onClick: () => setTask(entry.id),
            style: {
              ...css.tab(entry.id === currentTask?.id),
              border: entry.id === currentTask?.id ? '1px solid var(--sdd-accent)' : '1px solid var(--sdd-border)',
              borderRadius: '6px',
              padding: '5px 10px',
            },
          },
          h(SddIcon, { name: taskIcons[entry.id] ?? 'circle', size: 13 }),
          h('span', { className: 'sdd-config-task-label' }, entry.label)))),
        h('div', { className: 'sdd-config-runtime' },
          h('strong', { style: { fontSize: '11px' } }, `${currentTask?.label ?? '任务'}运行端`),
          h('div', { className: 'sdd-config-endpoint-switch' },
            [['local', '本地 ComfyUI'], ['cloud', '云端 ComfyUI']].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              'data-dsh-config-endpoint': id,
              'data-active': selectedEndpoint === id ? 'true' : 'false',
              onClick: () => setTaskEndpoint(id),
              style: {
                ...css.tab(selectedEndpoint === id),
                border: `1px solid ${selectedEndpoint === id ? (id === 'local' ? '#1769aa' : '#b45309') : 'var(--sdd-border)'}`,
                borderRadius: '5px',
                padding: '4px 10px',
              },
            }, label))),
          h('span', { className: 'sdd-config-runtime-note', style: { fontSize: '10px', opacity: 0.62 } },
            lowLocalVideoVram
              ? `本机显存 ${data.video.recommendation.localVramGb}GB，低于本地视频推荐的 16GB。仍可使用本地；建议先降低分辨率、Chunks 和步数，也可以切换到云端。`
              : `当前${selectedEndpoint === 'local' ? '本地' : '云端'}配置会用于${currentTask?.label ?? '该任务'}的实际执行。`)),
        h('div', { className: 'sdd-config-environments' }, environments.map(environmentCard)),
        isVideo && h('section', {
          className: 'sdd-config-section sdd-config-video-section',
          style: { border: '1px solid var(--sdd-border)', borderRadius: '8px', padding: '11px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--sdd-surface)' },
        },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('strong', { style: { fontSize: '12px' } }, '视频生成 / H3'),
            h('span', { style: { fontSize: '10px', opacity: 0.68 } }, '本地和云端各自保存一套模型与采样参数')),
          data.video?.error === null || data.video?.error === undefined
            ? null
            : h('div', { style: css.error }, data.video.error),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10px', fontWeight: 600 } },
            '采样模式',
            h('div', { style: { display: 'flex', gap: '4px' } },
              [['drama', '文戏'], ['action', '武打']].map(([id, label]) => h('button', {
                key: id,
                type: 'button',
                'data-dsh-video-mode': id,
                onClick: () => setVideoMode(id),
                style: { ...css.tab(videoMode === id), border: '1px solid var(--dsw-border-default, #d0d5dd)', borderRadius: '4px', padding: '4px 10px' },
              }, label)))),
          h('div', { className: 'sdd-config-video-grid' },
            videoEnvironmentPanel('local'),
            videoEnvironmentPanel('cloud')),
          h('div', { style: { fontSize: '10px', opacity: 0.68, lineHeight: 1.5 } },
            '总步数由一采加二采自动换算后写入基础调度器；保存会分别写回本地和云端工作流，并按执行实例和文戏/武打模式应用。')),
        error.length > 0 ? h('div', { style: css.error }, displayShotText(error)) : null,
        note.length > 0 ? h('div', { style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, displayShotText(note)) : null,
        h('div', { className: 'sdd-config-footer' },
          h('button', {
            type: 'button',
            'data-dsh-global-save': 'true',
            className: 'sdd-config-save',
            style: css.button(true),
            disabled: saving || busy || (data.video?.error !== null && data.video?.error !== undefined),
            onClick: onSave,
          },
          h(SddIcon, { name: saving ? 'loader-circle' : 'save' }),
          saving ? '保存中…' : '保存全局配置'),
          h('button', { type: 'button', style: css.button(false), disabled: saving || busy, onClick: onRefresh },
            h(SddIcon, { name: busy ? 'loader-circle' : 'refresh-cw' }),
            '重新识别'),
          h('span', { style: { fontSize: '10px', opacity: 0.6 } }, data.savedAt === null || data.savedAt === undefined ? '尚未保存过全局配置' : `上次保存：${data.savedAt}`)),
      );
    }

    /**
     * Turn project assets into slot choices.
     *
     * H3 wants a character quadview when one exists; image editing usually wants the
     * variant's main/portrait image. Both keep the variant identity so the same library
     * can be used without creating a second upload.
     */
    function generalAssetChoices(assets, task, mediaKind = 'image') {
      const targetKind = mediaKind === 'audio' ? 'reference-audio'
        : mediaKind === 'video' ? 'reference-video'
          : null;
      const imageKinds = new Set(['character', 'scene', 'prop', 'reference-image']);
      const roleOrder = task === 'video-generation'
        ? ['quadview', 'front', 'primary']
        : ['primary', 'front', 'quadview'];
      const rows = [];
      for (const asset of Array.isArray(assets) ? assets : []) {
        if (targetKind === null ? !imageKinds.has(asset?.kind) : asset?.kind !== targetKind) continue;
        const variants = Array.isArray(asset.variants) && asset.variants.length > 0
          ? asset.variants
          : [{ variantId: asset.identityVariant ?? 'default', name: asset.identityVariant ?? 'default' }];
        for (const variant of variants) {
          const variantId = String(variant?.variantId ?? asset.identityVariant ?? 'default');
          const roleHandles = asset.roleHandles?.[variantId] ?? {};
          const selected = asset.selectedHandles?.[variantId] ?? null;
          let picked = selected === null ? null : { ...selected, role: selected.role ?? 'primary' };
          if (picked === null) {
            for (const role of roleOrder) {
              if (roleHandles[role]?.handle) {
                picked = { ...roleHandles[role], role };
                break;
              }
            }
          }
          const handle = picked?.handle ?? asset.thumbnails?.[variantId] ?? asset.handle ?? null;
          if (typeof handle !== 'string' || handle.length === 0) continue;
          const variantName = String(variant?.name ?? 'default');
          const suffix = variantName === 'default' || variantName === asset.identityVariant
            ? ''
            : `（${variantName}）`;
          rows.push({
            key: `${asset.assetId}:${variantId}`,
            assetId: asset.assetId,
            variantName,
            assetName: asset.name,
            kind: asset.kind,
            label: `${String(asset.name ?? '未命名资产')}${suffix}`,
            fileName: picked?.fileName ?? `${String(asset.name ?? '资产')}${suffix}${targetKind === 'reference-audio' ? '.wav' : targetKind === 'reference-video' ? '.mp4' : '.png'}`,
            handle,
            thumbnailHandle: picked?.thumbnailHandle ?? asset.thumbnailHandles?.[variantId] ?? null,
            role: picked?.role ?? (targetKind === null ? 'primary' : 'media'),
            mediaKind,
          });
        }
      }
      const order = { character: 0, scene: 1, prop: 2, 'reference-image': 3, 'reference-audio': 4, 'reference-video': 5 };
      return rows.sort((left, right) => (order[left.kind] ?? 9) - (order[right.kind] ?? 9)
        || left.label.localeCompare(right.label, 'zh-CN'));
    }

    function GeneralAssetPicker({ open, title, assets, task, mediaKind = 'image', allowedKinds = null, previewUrl, onChoose, onClose }) {
      const [query, setQuery] = React.useState('');
      const [kindFilter, setKindFilter] = React.useState('all');
      if (!open) return null;
      const allowed = Array.isArray(allowedKinds) && allowedKinds.length > 0 ? new Set(allowedKinds) : null;
      const choices = generalAssetChoices(assets, task, mediaKind)
        .filter((choice) => allowed === null || allowed.has(choice.kind));
      const needle = query.trim().toLowerCase();
      const kindOptions = [...new Set(choices.map((choice) => choice.kind))]
        .sort((left, right) => (['character', 'scene', 'prop', 'reference-image', 'reference-audio', 'reference-video'].indexOf(left)
          - ['character', 'scene', 'prop', 'reference-image', 'reference-audio', 'reference-video'].indexOf(right)));
      const visible = needle.length === 0
        ? choices.filter((choice) => kindFilter === 'all' || choice.kind === kindFilter)
        : choices.filter((choice) => (kindFilter === 'all' || choice.kind === kindFilter)
          && `${choice.label} ${choice.fileName} ${KIND_LABEL[choice.kind] ?? ''}`
          .toLowerCase().includes(needle));
      return h('div', {
        'data-dsh-general-asset-picker': 'true',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title ?? '选择项目资产',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 120,
          display: 'grid',
          placeItems: 'center',
          padding: '16px',
          background: 'rgba(15,23,42,.38)',
        },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      }, h('div', {
        style: {
          width: 'min(1040px, 100%)',
          maxHeight: 'min(86vh, 780px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          padding: '18px',
          border: '1px solid var(--dsw-border-default, #d0d5dd)',
          borderRadius: '10px',
          background: 'var(--dsw-bg-base, #fff)',
          boxShadow: '0 18px 48px rgba(15,23,42,.24)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('strong', { style: { fontSize: '15px', flex: '1 1 auto' } }, title ?? '选择项目资产'),
        h('button', { type: 'button', style: css.miniButton, onClick: onClose }, '关闭')),
      h('input', {
        type: 'search',
        value: query,
        'data-dsh-general-asset-search': 'true',
        placeholder: '搜索人物、场景、道具或变体',
        onChange: (event) => setQuery(event.target.value),
        style: { ...css.select, width: '100%', boxSizing: 'border-box' },
      }),
      kindOptions.length > 1
        ? h('div', {
          'data-dsh-general-asset-kind-filters': 'true',
          style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
        },
          [['all', '全部'], ...kindOptions.map((kind) => [kind, KIND_LABEL[kind] ?? kind])]
            .map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              'data-dsh-general-asset-kind-filter': id,
              'aria-pressed': kindFilter === id,
              onClick: () => setKindFilter(id),
              style: {
                ...css.miniButton,
                minHeight: '28px',
                padding: '0 10px',
                fontSize: '10px',
                borderColor: kindFilter === id ? 'var(--dsw-accent-default, #087b67)' : 'var(--dsw-border-default, #d0d5dd)',
                background: kindFilter === id ? 'var(--dsw-accent-subtle, rgba(8,123,103,.10))' : 'var(--dsw-bg-base, #fff)',
              },
            }, label)))
        : null,
      h('div', {
        'data-dsh-general-asset-grid': 'true',
        style: {
          minHeight: 0,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
          gap: '14px',
          padding: '2px 2px 10px',
        },
      },
      visible.length === 0
        ? h('div', { style: { ...css.note, gridColumn: '1 / -1', padding: '28px 8px', textAlign: 'center' } },
          choices.length === 0
            ? (allowed !== null
              ? `当前项目资产库里还没有可用的${allowed.has('character') ? '人物' : allowed.has('scene') ? '场景' : allowed.has('prop') ? '道具' : mediaKind === 'audio' ? '音频' : mediaKind === 'video' ? '视频' : '图片'}；请先到资产页添加，这个入口不能本地上传。`
              : `当前项目资产库里还没有可用${mediaKind === 'audio' ? '音频' : mediaKind === 'video' ? '视频' : '图片'}；可以直接上传。`)
            : '没有匹配的资产。')
        : visible.map((choice) => h('button', {
          key: choice.key,
          type: 'button',
          'data-dsh-general-asset-choice': choice.key,
          title: `${choice.label} · ${choice.fileName}`,
          onClick: () => onChoose(choice),
          style: {
            minWidth: 0,
            padding: 0,
            border: '1px solid var(--dsw-border-default, #d0d5dd)',
            borderRadius: '8px',
            overflow: 'hidden',
            background: 'var(--dsw-surface-subtle, #f7f8fa)',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            boxShadow: '0 1px 2px rgba(15,23,42,.04)',
          },
        },
        h('div', { style: { aspectRatio: '16 / 10', display: 'grid', placeItems: 'center', overflow: 'hidden', background: '#111' } },
          mediaKind === 'audio' || mediaKind === 'video'
            ? h(MediaPlaceholder, {
              kind: mediaKind,
              compact: true,
              label: choice.label,
            })
              : typeof previewUrl === 'function'
            ? h(PreviewImage, {
              src: previewUrl(choice.thumbnailHandle ?? choice.handle),
              alt: choice.label,
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'contain' },
            })
            : h('span', { style: { color: '#fff', fontSize: '11px', opacity: 0.72 } }, KIND_LABEL[choice.kind] ?? '图片')),
        h('div', { style: { padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
          h('span', { style: { fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, choice.label),
          h('span', { style: { fontSize: '10px', lineHeight: 1.45, opacity: 0.68 } },
            `${KIND_LABEL[choice.kind] ?? '资产'} · ${choice.role === 'quadview' ? '四视图' : choice.role === 'front' ? '定妆照' : choice.role === 'media' ? (mediaKind === 'audio' ? '音频' : mediaKind === 'video' ? '视频' : '媒体') : '图片'}`)),
        ))),
      ));
    }

    const VIDEO_PANE_STORAGE_KEY = 'dsh-sdd-video-pane-widths-v1';
    const DEFAULT_VIDEO_PANE_WIDTHS = Object.freeze({ assets: 290, prompt: 390 });
    const VIDEO_PANE_MIN_WIDTHS = Object.freeze({ assets: 210, prompt: 280, preview: 240 });
    const VIDEO_PANE_MAX_WIDTH = 4096;
    const VIDEO_SPLITTER_TOTAL = 20;

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
    }

    function fitVideoPaneWidths(widths, containerWidth) {
      let assets = clamp(Math.round(widths.assets), VIDEO_PANE_MIN_WIDTHS.assets, VIDEO_PANE_MAX_WIDTH);
      let prompt = clamp(Math.round(widths.prompt), VIDEO_PANE_MIN_WIDTHS.prompt, VIDEO_PANE_MAX_WIDTH);
      const budget = Math.max(
        VIDEO_PANE_MIN_WIDTHS.assets + VIDEO_PANE_MIN_WIDTHS.prompt,
        Number(containerWidth) - VIDEO_SPLITTER_TOTAL - VIDEO_PANE_MIN_WIDTHS.preview,
      );
      const total = assets + prompt;
      if (total > budget) {
        const overflow = total - budget;
        const shrinkable = (assets - VIDEO_PANE_MIN_WIDTHS.assets)
          + (prompt - VIDEO_PANE_MIN_WIDTHS.prompt);
        if (overflow >= shrinkable) {
          assets = VIDEO_PANE_MIN_WIDTHS.assets;
          prompt = VIDEO_PANE_MIN_WIDTHS.prompt;
        } else {
          assets -= Math.round(overflow * ((assets - VIDEO_PANE_MIN_WIDTHS.assets) / shrinkable));
          prompt = budget - assets;
        }
      }
      return { assets, prompt };
    }

    function readVideoPaneWidths() {
      try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(VIDEO_PANE_STORAGE_KEY) ?? 'null');
        if (Number.isFinite(raw?.assets) && Number.isFinite(raw?.prompt)) {
          return {
            assets: clamp(Math.round(raw.assets), VIDEO_PANE_MIN_WIDTHS.assets, VIDEO_PANE_MAX_WIDTH),
            prompt: clamp(Math.round(raw.prompt), VIDEO_PANE_MIN_WIDTHS.prompt, VIDEO_PANE_MAX_WIDTH),
          };
        }
      } catch {
        // A mockup without storage still gets the default split.
      }
      return { ...DEFAULT_VIDEO_PANE_WIDTHS };
    }

    function saveVideoPaneWidths(widths) {
      try {
        globalThis.localStorage?.setItem(VIDEO_PANE_STORAGE_KEY, JSON.stringify(widths));
      } catch {
        // Resizing remains usable when storage is unavailable.
      }
    }

    const GENERAL_RESULT_CACHE_PREFIX = 'dsh-sdd-general-results-v1:';
    const GENERAL_RESULT_CACHE_GLOBAL = `${GENERAL_RESULT_CACHE_PREFIX}global`;
    const GENERAL_RESULT_LIMIT = 24;
    const GENERAL_RESULT_TERMINAL_STATES = new Set([
      'saved',
      'failed',
      'cancelled',
      'download_failed',
      'submission_unknown',
    ]);

    function generalResultStorageKey(scope) {
      return `${GENERAL_RESULT_CACHE_PREFIX}${String(scope ?? 'default')}`;
    }

    function mergeGeneralResultEntries(previous, restored) {
      const incoming = new Map((Array.isArray(restored) ? restored : [])
        .filter((entry) => typeof entry?.cacheId === 'string')
        .map((entry) => [entry.cacheId, entry]));
      const merged = [];
      const seen = new Set();
      for (const entry of Array.isArray(previous) ? previous : []) {
        if (typeof entry?.cacheId !== 'string' || seen.has(entry.cacheId)) continue;
        seen.add(entry.cacheId);
        merged.push(incoming.get(entry.cacheId) ?? entry);
      }
      for (const [cacheId, entry] of incoming) {
        if (seen.has(cacheId)) continue;
        seen.add(cacheId);
        merged.push(entry);
      }
      merged.sort((left, right) => String(right.cachedAt ?? '').localeCompare(String(left.cachedAt ?? '')));
      return merged.slice(0, GENERAL_RESULT_LIMIT);
    }

    function readGeneralResultCache(scope) {
      try {
        const exact = globalThis.localStorage?.getItem(generalResultStorageKey(scope));
        const fallback = globalThis.localStorage?.getItem(GENERAL_RESULT_CACHE_GLOBAL);
        const parsed = JSON.parse(exact ?? fallback ?? '[]');
        if (!Array.isArray(parsed)) return [];
        const newest = new Map();
        for (const entry of parsed) {
          if (typeof entry?.cacheId !== 'string') continue;
          const state = String(entry.state ?? '');
          const files = Array.isArray(entry.generatedFiles) ? entry.generatedFiles : [];
          const pending = state.length > 0
            && !GENERAL_RESULT_TERMINAL_STATES.has(state)
            && state !== 'completed';
          const recoverableRequest = pending
            && typeof entry.requestId === 'string'
            && entry.requestId.length >= 8;
          // Pending entries from versions that did not record a jobId can never make progress.
          // A requestId is also a durable lookup key: the Host can resolve the ledger row after
          // the panel closed before the submission response returned.
          if ((pending || (state === 'completed' && files.length === 0))
            && typeof entry.jobId !== 'string' && !recoverableRequest) continue;
          const normalized = {
            ...entry,
            // Handles only live inside this Host process. Persisting them made a restart render
            // the previous process's handles, which always fail even though the files are fine.
            generatedFiles: files.length > 0
              ? files.map((file) => ({
                ...file,
                mediaHandle: null,
                thumbnailHandle: null,
              }))
              : [],
          };
          const previous = newest.get(normalized.cacheId);
          if (previous === undefined
            || String(normalized.cachedAt ?? '').localeCompare(String(previous.cachedAt ?? '')) > 0) {
            newest.set(normalized.cacheId, normalized);
          }
        }
        return [...newest.values()]
          .sort((left, right) => String(right.cachedAt ?? '').localeCompare(String(left.cachedAt ?? '')))
          .slice(0, GENERAL_RESULT_LIMIT);
      } catch {
        return [];
      }
    }

    function writeGeneralResultCache(scope, entries) {
      try {
        const safe = entries.slice(0, GENERAL_RESULT_LIMIT).map((entry) => ({
          cacheId: entry.cacheId,
          generationTask: entry.generationTask ?? null,
          requestId: entry.requestId ?? null,
          endpoint: entry.endpoint ?? null,
          workflow: entry.workflow ?? null,
          state: entry.state ?? null,
          message: entry.message ?? null,
          // Names and types survive a refresh; process-local handles never do. The disk history
          // merge below mints fresh handles for the files that still exist.
          generatedFiles: Array.isArray(entry.generatedFiles)
            ? entry.generatedFiles.map((file) => ({
              ...file,
              mediaHandle: null,
              thumbnailHandle: null,
            }))
            : [],
          cachedAt: entry.cachedAt ?? null,
          startedAt: entry.startedAt ?? entry.cachedAt ?? null,
          finishedAt: entry.finishedAt ?? null,
          updatedAt: entry.updatedAt ?? null,
          jobId: entry.jobId ?? null,
          promptId: entry.promptId ?? null,
          referenceCount: entry.referenceCount ?? null,
          restored: entry.restored === true,
        }));
        globalThis.localStorage?.setItem(generalResultStorageKey(scope), JSON.stringify(safe));
        globalThis.localStorage?.setItem(GENERAL_RESULT_CACHE_GLOBAL, JSON.stringify(safe));
      } catch {
        // In-memory cache still works when storage is unavailable.
      }
    }

    /**
     * Persist one result row synchronously.
     *
     * The previous flow wrote localStorage from a React effect after `onGenerate` returned. If the
     * user left while the Host was still uploading or submitting, the component unmounted before
     * that effect ran, so the only record of the task died with it. A requestId can be resolved
     * through the Host ledger, which makes this pre-submit row recoverable.
     */
    function upsertGeneralResultCache(scope, entry, current = []) {
      // Merge with the LIVE in-memory list. Reading storage here used to replace every existing
      // media handle with the deliberately handle-free persisted copy, so submitting one new task
      // made every older video unplayable.
      const next = mergeGeneralResultEntries([entry, ...(Array.isArray(current) ? current : [])], []);
      writeGeneralResultCache(scope, next);
      return next;
    }

    function formatGenerationElapsed(startedAt, finishedAt = null) {
      const started = Date.parse(String(startedAt ?? ''));
      if (!Number.isFinite(started)) return '';
      const finished = finishedAt === null || finishedAt === undefined || finishedAt === ''
        ? Date.now()
        : Date.parse(String(finishedAt));
      const total = Math.max(0, Math.floor(((Number.isFinite(finished) ? finished : Date.now()) - started) / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    /** The panel body. */
    /**
     * General mode's task surface.
     *
     * This is deliberately one component with local form state rather than five separate
     * panels: switching tasks must not lose the media the user just selected, and the saved
     * workflow/endpoint shown above the form is the same configuration the Host resolves at
     * submit time. The form never names a node id; binding happens in the Host from the graph.
     */
    function GeneralGenerateView({
      t,
      hidden,
      data,
      storageKey,
      busy,
      error,
      note,
      projectDefaults,
      assets = [],
      onRefresh,
      onOpenConfig,
      onGenerate,
      onLoadHistory,
      onPollJob,
      candidates = [],
      onOpenResults,
      previewUrl,
    }) {
      const tasks = [
        ['text-to-image', '文生图'],
        ['image-edit', '图片编辑 / 图生图'],
        ['upscale-image', '图像超分'],
        ['upscale-video', '视频超分'],
        ['video-generation', '视频生成'],
      ];
      const [task, setTask] = React.useState('text-to-image');
      const [prompt, setPrompt] = React.useState('');
      const [editPromptMode, setEditPromptMode] = React.useState('qwen-official');
      const [editConversion, setEditConversion] = React.useState(null);
      const [media, setMedia] = React.useState([]);
      const [aspectRatio, setAspectRatio] = React.useState(projectDefaults?.aspectRatio ?? '9:16');
      const [megapixels, setMegapixels] = React.useState(1.2);
      const [scale, setScale] = React.useState(3);
      const [videoUpscaleTarget, setVideoUpscaleTarget] = React.useState('1080p');
      const [seconds, setSeconds] = React.useState(6);
      const [videoMode, setVideoMode] = React.useState('drama');
      const [resolution, setResolution] = React.useState(projectDefaults?.resolution ?? '720p');
      const [localBusy, setLocalBusy] = React.useState(false);
      const [converting, setConverting] = React.useState(false);
      const [localError, setLocalError] = React.useState('');
      const [localNote, setLocalNote] = React.useState('');
      const [clockNow, setClockNow] = React.useState(() => Date.now());
      const [resultCache, setResultCache] = React.useState([]);
      const resultCacheRef = React.useRef([]);
      const [activeResultId, setActiveResultId] = React.useState(null);
      const result = resultCache.find((entry) => entry.cacheId === activeResultId)
        ?? resultCache.find((entry) => entry.generationTask === task && entry.generatedFiles?.length > 0)
        ?? resultCache.find((entry) => entry.generationTask === task)
        ?? null;
      const [mediaPreviews, setMediaPreviews] = React.useState({});
      const [assetPickerTarget, setAssetPickerTarget] = React.useState(null);
      const [assetPickerKind, setAssetPickerKind] = React.useState('image');
      const [videoPaneWidths, setVideoPaneWidths] = React.useState(readVideoPaneWidths);
      const [videoWorkspaceWidth, setVideoWorkspaceWidth] = React.useState(940);
      const videoWorkspaceRef = React.useRef(null);
      const pendingRequest = React.useRef(null);
      const historyLoadRef = React.useRef(null);
      const hydratedResultStorageKey = React.useRef(null);
      const active = !hidden;
      const displayedVideoPaneWidths = fitVideoPaneWidths(videoPaneWidths, videoWorkspaceWidth);

      React.useEffect(() => {
        if (hydratedResultStorageKey.current !== storageKey) {
          hydratedResultStorageKey.current = storageKey;
          const restored = readGeneralResultCache(storageKey);
          resultCacheRef.current = restored;
          setResultCache(restored);
          setActiveResultId(restored.find((entry) => entry.generationTask === task)?.cacheId ?? null);
          historyLoadRef.current = null;
          return;
        }
        resultCacheRef.current = resultCache;
        writeGeneralResultCache(storageKey, resultCache);
      }, [resultCache, storageKey, task]);

      React.useEffect(() => {
        if (!active || typeof onLoadHistory !== 'function') return undefined;
        if (historyLoadRef.current === onLoadHistory) return undefined;
        historyLoadRef.current = onLoadHistory;
        let cancelled = false;
        Promise.resolve(onLoadHistory()).then((answer) => {
          if (cancelled) return;
          const restored = Array.isArray(answer?.cache) ? answer.cache : [];
          if (restored.length === 0) return;
          // Disk entries own the fresh media handles. Replacing by cacheId is essential: keeping
          // the browser copy because the ids match preserved handles from a previous Host process.
          setResultCache((previous) => mergeGeneralResultEntries(previous, restored));
          setActiveResultId((current) => current ?? restored.find((entry) => entry.generationTask === task)?.cacheId ?? null);
        }).catch(() => {
          historyLoadRef.current = null;
        });
        return () => { cancelled = true; };
      }, [active, onLoadHistory]);

      React.useEffect(() => {
        if (!active || task !== 'video-generation') return undefined;
        const container = videoWorkspaceRef.current;
        if (container === null || container === undefined
          || typeof container.getBoundingClientRect !== 'function') return undefined;
        const fitToContainer = () => {
          const width = container.getBoundingClientRect().width;
          if (!Number.isFinite(width) || width <= 0) return;
          setVideoWorkspaceWidth((previous) => Math.abs(previous - width) < 1 ? previous : width);
        };
        fitToContainer();
        const observer = typeof globalThis.ResizeObserver === 'function'
          ? new globalThis.ResizeObserver(fitToContainer)
          : null;
        observer?.observe(container);
        if (observer === null) globalThis.window?.addEventListener?.('resize', fitToContainer);
        return () => {
          observer?.disconnect();
          if (observer === null) globalThis.window?.removeEventListener?.('resize', fitToContainer);
        };
      }, [active, task]);

      const fileRule = task === 'upscale-video'
        ? { kind: 'video', max: 1, accept: 'video/*', label: '选择视频' }
        : task === 'upscale-image'
          ? { kind: 'image', max: 1, accept: 'image/*', label: '选择图像' }
          : task === 'image-edit'
            ? { kind: 'image', max: 8, accept: 'image/*', label: '添加参考图' }
            : task === 'video-generation'
              ? { kind: 'image', max: 15, accept: 'image/*,audio/*,video/*', label: '添加 H3 参考素材' }
              : null;
      const needsPrompt = task !== 'upscale-image' && task !== 'upscale-video';
      const endpoint = data?.settings?.endpoints?.[task] ?? 'cloud';
      const workflowFile = task === 'video-generation'
        ? data?.video?.environments?.[endpoint]?.workflow?.file
        : data?.settings?.tasks?.[endpoint]?.[task];
      const workflowName = typeof workflowFile === 'string' && workflowFile.length > 0
        ? workflowFile.replace(/\\/gu, '/').split('/').pop()
        : null;
      const environment = data?.environments?.[endpoint] ?? null;

      React.useEffect(() => {
        if (typeof projectDefaults?.aspectRatio === 'string' && projectDefaults.aspectRatio.length > 0) {
          setAspectRatio(task === 'image-edit' ? '' : projectDefaults.aspectRatio);
        }
        if (typeof projectDefaults?.resolution === 'string' && projectDefaults.resolution.length > 0) {
          setResolution(projectDefaults.resolution);
        }
      }, [projectDefaults?.aspectRatio, projectDefaults?.resolution, task]);

      React.useEffect(() => {
        const urls = {};
        for (const entry of media) {
          if (entry.kind !== 'image' || entry.file === undefined || entry.file === null
            || typeof globalThis.URL?.createObjectURL !== 'function') continue;
          urls[entry.id] = globalThis.URL.createObjectURL(entry.file);
        }
        setMediaPreviews(urls);
        return () => {
          if (typeof globalThis.URL?.revokeObjectURL !== 'function') return;
          for (const url of Object.values(urls)) globalThis.URL.revokeObjectURL(url);
        };
      }, [media]);

      React.useEffect(() => {
        if (!active) return;
        if (task === 'upscale-image') setScale(3);
      }, [active, task]);

      const chooseTask = (next) => {
        if (localBusy) return;
        setTask(next);
        setMedia([]);
        setActiveResultId(resultCache.find((entry) => entry.generationTask === next)?.cacheId ?? null);
        setLocalError('');
        setLocalNote('');
        setPrompt('');
        setEditConversion(null);
        setAssetPickerTarget(null);
        setAssetPickerKind('image');
        pendingRequest.current = null;
        setConverting(false);
        if (next === 'image-edit') setAspectRatio('');
        else setAspectRatio(projectDefaults?.aspectRatio ?? '9:16');
        if (next === 'upscale-image') setScale(3);
      };

      const nextVideoSlot = (previous, mediaKind = 'image', startAfter = 0) => {
        const cap = mediaKind === 'image' ? 9 : 3;
        const used = new Set(previous
          .filter((entry) => entry.kind === mediaKind)
          .map((entry) => Number(entry.slotNumber))
          .filter((value) => Number.isInteger(value) && value > 0));
        for (let slot = Math.max(1, startAfter + 1); slot <= cap; slot += 1) {
          if (!used.has(slot)) return slot;
        }
        return null;
      };

      const addFiles = (event, requestedSlot = null, mediaKind = fileRule?.kind ?? 'image') => {
        const selected = Array.from(event?.target?.files ?? []);
        event.target.value = '';
        if (fileRule === null || selected.length === 0) return;
        const replacingSlot = task === 'video-generation' && Number.isInteger(requestedSlot)
          && media.some((entry) => entry.slotNumber === requestedSlot && entry.kind === mediaKind);
        const room = replacingSlot ? 1 : Math.max(0, fileRule.max - media.length);
        const files = selected.slice(0, requestedSlot === null ? room : Math.min(1, room));
        if (files.length === 0) {
          setLocalNote(`这个任务最多放 ${String(fileRule.max)} 个文件`);
          return;
        }
        setMedia((previous) => {
          const next = [...previous];
          for (const file of files) {
            const entry = {
              id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
              source: 'file',
              file,
              fileName: file.name,
              kind: mediaKind,
            };
            if (task === 'video-generation') {
              const slotNumber = requestedSlot ?? nextVideoSlot(next, mediaKind);
              if (slotNumber === null) break;
              const existing = next.findIndex((item) => item.slotNumber === slotNumber);
              if (existing >= 0) next.splice(existing, 1, { ...entry, slotNumber });
              else next.push({ ...entry, slotNumber });
            } else {
              next.push(entry);
            }
          }
          return next.slice(0, fileRule.max);
        });
        if (selected.length > room) setLocalNote(`这个任务最多放 ${String(fileRule.max)} 个文件`);
        else setLocalNote('');
        setLocalError('');
      };

      const encodeFile = async (file) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const bytes = typeof file.arrayBuffer === 'function'
          ? new Uint8Array(await file.arrayBuffer())
          : await new Promise((resolve, reject) => {
            const reader = new globalThis.FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(new Error('读取上传文件失败'));
            reader.onabort = () => reject(new Error('读取上传文件已取消'));
            reader.readAsArrayBuffer(file);
          });
        const output = [];
        for (let index = 0; index < bytes.length; index += 3) {
          const first = bytes[index];
          const second = bytes[index + 1];
          const third = bytes[index + 2];
          const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
          output.push(
            alphabet[(triple >> 18) & 63],
            alphabet[(triple >> 12) & 63],
            second === undefined ? '=' : alphabet[(triple >> 6) & 63],
            third === undefined ? '=' : alphabet[triple & 63],
          );
        }
        return output.join('');
      };

      const removeMedia = (id) => {
        setMedia((previous) => previous.filter((entry) => entry.id !== id));
      };

      const moveMedia = (id, delta) => {
        setMedia((previous) => {
          const index = previous.findIndex((entry) => entry.id === id);
          const target = index + delta;
          if (index < 0 || target < 0 || target >= previous.length) return previous;
          const next = [...previous];
          [next[index], next[target]] = [next[target], next[index]];
          return next;
        });
      };

      const chooseAsset = (choice) => {
        if (choice === null || choice === undefined || typeof choice.handle !== 'string') return;
        setMedia((previous) => {
          const mediaKind = choice.mediaKind === 'audio' || choice.mediaKind === 'video' ? choice.mediaKind : 'image';
          const entry = {
            id: `asset:${choice.key}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            source: 'asset',
            kind: mediaKind,
            fileName: choice.fileName,
            mediaHandle: choice.handle,
            thumbnailHandle: choice.thumbnailHandle,
            label: choice.label,
            assetId: choice.assetId,
            variantName: choice.variantName,
            role: choice.role,
          };
          if (task === 'video-generation') {
            const slotNumber = typeof assetPickerTarget === 'number' && assetPickerTarget > 0
              ? assetPickerTarget
              : nextVideoSlot(previous, mediaKind);
            if (slotNumber === null) return previous;
            const existing = previous.findIndex((item) => item.slotNumber === slotNumber && item.kind === mediaKind);
            if (existing >= 0) {
              const next = [...previous];
              next.splice(existing, 1, { ...entry, slotNumber });
              return next;
            }
            const cap = mediaKind === 'image' ? 9 : 3;
            if (previous.filter((item) => item.kind === mediaKind).length >= cap) return previous;
            return [...previous, { ...entry, slotNumber }];
          }
          return [...previous, entry].slice(0, 8);
        });
        setAssetPickerTarget(null);
        setAssetPickerKind('image');
        setLocalError('');
        setLocalNote('');
      };

      const updateVideoPaneWidths = (next) => {
        setVideoPaneWidths(next);
        saveVideoPaneWidths(next);
      };

      const beginVideoPaneResize = (divider, event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const container = videoWorkspaceRef.current;
        if (container === null || container === undefined || typeof event.clientX !== 'number') return;
        const width = container.getBoundingClientRect().width;
        if (width < 750) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const start = { ...displayedVideoPaneWidths };
        const body = globalThis.document?.body;
        const previousCursor = body?.style?.cursor ?? '';
        const previousUserSelect = body?.style?.userSelect ?? '';
        if (body?.style) {
          body.style.cursor = 'col-resize';
          body.style.userSelect = 'none';
        }
        let last = start;
        const move = (moveEvent) => {
          moveEvent.preventDefault?.();
          const delta = moveEvent.clientX - startX;
          if (divider === 'assets-prompt') {
            const maximumAssets = start.assets + start.prompt - VIDEO_PANE_MIN_WIDTHS.prompt;
            const assets = clamp(start.assets + delta, VIDEO_PANE_MIN_WIDTHS.assets, maximumAssets);
            last = {
              assets,
              prompt: start.prompt - (assets - start.assets),
            };
          } else {
            const maximumPrompt = width - VIDEO_SPLITTER_TOTAL - start.assets - VIDEO_PANE_MIN_WIDTHS.preview;
            last = {
              assets: start.assets,
              prompt: clamp(start.prompt + delta, VIDEO_PANE_MIN_WIDTHS.prompt, maximumPrompt),
            };
          }
          setVideoPaneWidths(last);
        };
        const finish = () => {
          globalThis.window?.removeEventListener?.('pointermove', move);
          globalThis.window?.removeEventListener?.('pointerup', finish);
          globalThis.window?.removeEventListener?.('pointercancel', finish);
          if (body?.style) {
            body.style.cursor = previousCursor;
            body.style.userSelect = previousUserSelect;
          }
          saveVideoPaneWidths(last);
        };
        globalThis.window?.addEventListener?.('pointermove', move);
        globalThis.window?.addEventListener?.('pointerup', finish);
        globalThis.window?.addEventListener?.('pointercancel', finish);
      };

      const nudgeVideoPane = (divider, event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -24 : 24;
        const width = videoWorkspaceRef.current?.getBoundingClientRect?.().width ?? 0;
        const displayed = displayedVideoPaneWidths;
        if (divider === 'assets-prompt') {
          const maximumAssets = displayed.assets + displayed.prompt - VIDEO_PANE_MIN_WIDTHS.prompt;
          const assets = clamp(displayed.assets + delta, VIDEO_PANE_MIN_WIDTHS.assets, maximumAssets);
          updateVideoPaneWidths({
            assets,
            prompt: displayed.prompt - (assets - displayed.assets),
          });
        } else {
          updateVideoPaneWidths({
            assets: displayed.assets,
            prompt: clamp(
              displayed.prompt + delta,
              VIDEO_PANE_MIN_WIDTHS.prompt,
              width - VIDEO_SPLITTER_TOTAL - displayed.assets - VIDEO_PANE_MIN_WIDTHS.preview,
            ),
          });
        }
      };

      const fileMediaType = (file) => {
        if (typeof file?.mediaType === 'string' && file.mediaType.length > 0) return file.mediaType;
        const name = String(file?.name ?? file?.fileName ?? file?.path ?? '');
        if (/\.(?:mp4|webm|mov|mkv)$/iu.test(name)) return 'video/mp4';
        if (/\.(?:png|jpe?g|webp|gif|bmp)$/iu.test(name)) return 'image/png';
        if (/\.(?:mp3|wav|flac|ogg|m4a|aac)$/iu.test(name)) return 'audio/mpeg';
        return '';
      };
      const filesFromJob = (job) => (Array.isArray(job?.files) ? job.files : [])
        .map((file) => ({
          ...file,
          name: file.name ?? String(file.path ?? '').split(/[\\/]/u).pop() ?? '生成结果',
          mediaType: fileMediaType(file),
        }))
        .filter((file) => typeof file.mediaHandle === 'string' && file.mediaHandle.length > 0);
      const rememberResult = (answer, requestedTask, requestId) => {
        const resultTask = answer?.generationTask ?? requestedTask;
        const resultRequestId = answer?.requestId ?? requestId;
        const cacheId = `general-result-${resultTask}-${resultRequestId}`;
        const existing = resultCacheRef.current.find((entry) => entry.cacheId === cacheId);
        const now = new Date().toISOString();
        const entry = {
          ...(answer ?? {}),
          cacheId,
          generationTask: resultTask,
          requestId: resultRequestId,
          generatedFiles: Array.isArray(answer?.generatedFiles) ? answer.generatedFiles : [],
          startedAt: answer?.startedAt ?? existing?.startedAt ?? existing?.cachedAt ?? now,
          finishedAt: GENERAL_RESULT_TERMINAL_STATES.has(String(answer?.state ?? ''))
            ? (answer?.finishedAt ?? answer?.updatedAt ?? now)
            : null,
          cachedAt: now,
        };
        setResultCache((previous) => {
          const next = upsertGeneralResultCache(storageKey, entry, previous);
          resultCacheRef.current = next;
          return next;
        });
        setActiveResultId(cacheId);
        return entry;
      };
      const rememberPending = (requestedTask, requestId, startedAt) => {
        const cacheId = `general-result-${requestedTask}-${requestId}`;
        const entry = {
          cacheId,
          generationTask: requestedTask,
          requestId,
          state: 'submitting',
          message: '任务提交中…',
          generatedFiles: [],
          startedAt,
          finishedAt: null,
          cachedAt: startedAt,
        };
        setResultCache((previous) => {
          const next = upsertGeneralResultCache(storageKey, entry, previous);
          resultCacheRef.current = next;
          return next;
        });
        setActiveResultId(cacheId);
        return entry;
      };
      const pendingEntries = resultCache.filter((entry) => (entry.jobId || entry.requestId)
        && !GENERAL_RESULT_TERMINAL_STATES.has(String(entry.state ?? 'pending'))
        && !(Array.isArray(entry.generatedFiles) && entry.generatedFiles.length > 0));
      const pendingResultKey = pendingEntries.map((entry) => `${entry.cacheId}:${entry.jobId}`).join('|');
      const hasPendingEntries = pendingEntries.length > 0;
      const resultHasFiles = Array.isArray(result?.generatedFiles) && result.generatedFiles.length > 0;
      const resultTerminal = result !== null
        && (GENERAL_RESULT_TERMINAL_STATES.has(String(result.state ?? ''))
          || (result.state === 'completed' && resultHasFiles));
      const resultRunning = result !== null && !resultTerminal
        && !resultHasFiles;
      const resultStateLabel = result === null
        ? ''
        : ({
          intent: '待提交',
          submitting: '提交中',
          queued: '排队中',
          running: '生成中',
          completed: resultHasFiles ? '已完成' : '正在保存',
          downloading: '正在保存',
          submission_unknown: '提交状态待核对',
          download_failed: '下载失败',
          saved: '已完成',
          failed: '失败',
          cancelled: '已取消',
        }[String(result.state ?? '')] ?? String(result.state ?? ''));
      const resultElapsed = result === null
        ? ''
        : formatGenerationElapsed(
          result.startedAt ?? result.cachedAt,
          resultTerminal ? (result.finishedAt ?? result.updatedAt ?? result.cachedAt) : null,
        );
      void clockNow;

      React.useEffect(() => {
        if (!active || !hasPendingEntries) return undefined;
        setClockNow(Date.now());
        const timer = globalThis.setInterval?.(() => setClockNow(Date.now()), 1000);
        timer?.unref?.();
        return () => {
          if (timer !== undefined) globalThis.clearInterval?.(timer);
        };
      }, [active, hasPendingEntries, pendingResultKey]);

      React.useEffect(() => {
        if (pendingResultKey.length === 0 || typeof onPollJob !== 'function') return undefined;
        let cancelled = false;
        let timer = null;
        const poll = async () => {
          const updates = new Map();
          let waiting = 0;
          let refreshHistory = false;
          for (const entry of pendingEntries) {
            try {
              const job = await onPollJob(entry.jobId ?? null, entry.requestId);
              if (job === null || job === undefined) {
                waiting += 1;
                continue;
              }
              const files = filesFromJob(job);
              const terminal = GENERAL_RESULT_TERMINAL_STATES.has(String(job.state ?? ''))
                || (job.state === 'completed' && files.length > 0);
              if (!terminal) waiting += 1;
              const hasRecordedOutputs = (Array.isArray(job.files) && job.files.length > 0)
                || (Array.isArray(job.saved) && job.saved.length > 0);
              if (['saved', 'completed'].includes(String(job.state ?? ''))
                && files.length === 0
                && (job.state === 'saved' || hasRecordedOutputs)) {
                // The ledger can finish before its media handles are refreshed (older completed
                // rows did exactly that). Read the durable output folders and mint handles instead
                // of leaving a video rendered as the generic placeholder.
                refreshHistory = true;
              }
              updates.set(entry.cacheId, { job, files });
            } catch {
              waiting += 1;
            }
          }
          if (!cancelled && updates.size > 0) {
            setResultCache((previous) => previous.map((entry) => {
              const update = updates.get(entry.cacheId);
              if (update === undefined) return entry;
              const updateTerminal = GENERAL_RESULT_TERMINAL_STATES.has(String(update.job.state ?? ''))
                || (update.job.state === 'completed' && update.files.length > 0);
              const startedAt = [entry.startedAt, entry.cachedAt, update.job.createdAt]
                .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
                .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? entry.startedAt;
              return {
                ...entry,
                jobId: update.job.jobId ?? entry.jobId ?? null,
                state: update.job.state ?? entry.state,
                generatedFiles: update.files.length > 0 ? update.files : entry.generatedFiles,
                message: update.job.state === 'saved'
                  ? '生成完成'
                  : update.job.state === 'completed' || update.job.state === 'downloading'
                    ? '正在写入生成结果'
                    : (update.job.note ?? entry.message),
                updatedAt: update.job.updatedAt ?? entry.updatedAt,
                startedAt,
                finishedAt: updateTerminal
                  ? (update.job.updatedAt ?? entry.finishedAt ?? new Date().toISOString())
                  : null,
              };
            }));
          }
          if (!cancelled && refreshHistory && typeof onLoadHistory === 'function') {
            await Promise.resolve(onLoadHistory()).then((answer) => {
              if (cancelled) return;
              const restored = Array.isArray(answer?.cache) ? answer.cache : [];
              if (restored.length > 0) {
                setResultCache((previous) => mergeGeneralResultEntries(previous, restored));
              }
            }).catch(() => undefined);
          }
          if (!cancelled && waiting > 0) {
            timer = globalThis.setTimeout?.(poll, 3000);
            timer?.unref?.();
          }
        };
        timer = globalThis.setTimeout?.(poll, 1200);
        timer?.unref?.();
        return () => {
          cancelled = true;
          if (timer !== null && timer !== undefined) globalThis.clearTimeout?.(timer);
        };
      }, [pendingResultKey, onPollJob, onLoadHistory]);

      const generalMentionAssets = task === 'video-generation'
        ? mentionAssetsForGeneralMedia(media, mediaPreviews)
        : [];

      const editMediaSignature = media.map((entry) => entry.file === undefined || entry.file === null
        ? `asset:${entry.kind}:${entry.mediaHandle ?? ''}:${entry.variantName ?? ''}:${entry.fileName ?? ''}`
        : `file:${entry.kind}:${entry.file.name}:${entry.file.size}:${entry.file.lastModified ?? ''}`).join('|');
      const editConversionReady = task === 'image-edit'
        && editPromptMode === 'qwen-official'
        && editConversion !== null
        && editConversion.mediaSignature === editMediaSignature
        && prompt.trim().length > 0;
      const editPromptHandEdited = editConversionReady && editConversion.convertedPrompt !== prompt;

      const buildGenerationMedia = async () => {
        const generationMedia = [];
        const generationAssets = [];
        const totalBytes = media.reduce((sum, entry) => sum + (entry.file?.size ?? 0), 0);
        if (totalBytes > 88 * 1024 * 1024) throw new Error('本次上传文件合计超过 88MB，请减少文件或压缩后再试');
        for (const [index, entry] of media.entries()) {
          const slotNumber = task === 'video-generation' ? Number(entry.slotNumber) : null;
          const order = task === 'image-edit' ? index + 1 : null;
          if (entry.file !== undefined && entry.file !== null) {
            if (entry.file.size > 90 * 1024 * 1024) throw new Error(`${entry.file.name} 超过 90MB，请压缩后再上传`);
            generationMedia.push({
              fileName: entry.file.name,
              kind: entry.kind,
              fileDataBase64: await encodeFile(entry.file),
              ...(slotNumber === null ? {} : { slotNumber }),
              ...(order === null ? {} : { order }),
              ...(entry.label ? { label: entry.label } : {}),
            });
          } else if (typeof entry.mediaHandle === 'string' && entry.mediaHandle.length > 0) {
            generationAssets.push({
              mediaHandle: entry.mediaHandle,
              fileName: entry.fileName,
              kind: entry.kind,
              ...(slotNumber === null ? {} : { slotNumber }),
              ...(order === null ? {} : { order }),
              ...(entry.label ? { label: entry.label } : {}),
              ...(entry.assetId ? { assetId: entry.assetId } : {}),
              ...(entry.variantName ? { variantName: entry.variantName } : {}),
              ...(entry.role ? { role: entry.role } : {}),
            });
          }
        }
        return { generationMedia, generationAssets };
      };

      const changeEditPromptMode = (next) => {
        if (localBusy || converting) return;
        if (next === 'raw' && editConversion !== null && prompt === editConversion.convertedPrompt) {
          setPrompt(editConversion.sourcePrompt);
        } else if (next === 'qwen-official' && editConversion !== null && prompt === editConversion.sourcePrompt) {
          setPrompt(editConversion.convertedPrompt);
        }
        setEditPromptMode(next);
        setLocalError('');
      };

      const convertEditPrompt = async () => {
        if (task !== 'image-edit' || localBusy || converting) return;
        if (prompt.trim().length === 0) {
          setLocalError('先填写图片编辑内容');
          return;
        }
        if (media.length === 0) {
          setLocalError('先选择至少一张参考图');
          return;
        }
        setConverting(true);
        setLocalError('');
        setLocalNote('');
        try {
          const { generationMedia, generationAssets } = await buildGenerationMedia();
          const requestId = `convert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
          const answer = await onGenerate({
            generationTask: 'image-edit',
            generationAction: 'convert-edit-prompt',
            generationPrompt: prompt,
            generationMedia,
            generationAssets,
            generationSettings: { aspectRatio, megapixels },
            requestId,
          });
          const rewrite = answer?.promptRewrite;
          if (typeof rewrite?.rewritten_prompt !== 'string' || rewrite.rewritten_prompt.trim().length === 0) {
            throw new Error('转换没有返回可用的千问官方提示词；原提示词已保留，未提交工作流');
          }
          const convertedPrompt = rewrite.rewritten_prompt.trim();
          const convertedAspectRatio = typeof rewrite.wh_ratio === 'string' ? rewrite.wh_ratio : '';
          setEditConversion({
            sourcePrompt: prompt,
            convertedPrompt,
            mediaSignature: editMediaSignature,
            aspectRatio: convertedAspectRatio,
            rewrite,
          });
          setPrompt(convertedPrompt);
          setAspectRatio(convertedAspectRatio);
          setLocalNote(answer?.message ?? '已转换为千问 2.1 官方提示词；请检查后再生成');
        } catch (failure) {
          setLocalError(String(failure?.message ?? failure));
        } finally {
          setConverting(false);
        }
      };

      const submit = async () => {
        if (localBusy || converting) return;
        if (needsPrompt && prompt.trim().length === 0) {
          setLocalError('先填写提示词');
          return;
        }
        if (fileRule !== null && media.length === 0 && task !== 'video-generation') {
          setLocalError(fileRule.kind === 'video' ? '先选择一段视频' : '先选择图片');
          return;
        }
        if (task === 'video-generation' && media.length > 0) {
          for (const kind of ['image', 'video', 'audio']) {
            const slots = media.filter((entry) => entry.kind === kind)
              .map((entry) => Number(entry.slotNumber))
              .filter((value) => Number.isInteger(value) && value > 0)
              .sort((left, right) => left - right);
            if (slots.some((slot, index) => slot !== index + 1)) {
              setLocalError(`H3 ${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}槽位必须从 1 开始连续填写，请补齐空槽`);
              return;
            }
          }
        }
        if (task === 'image-edit' && editPromptMode === 'qwen-official' && !editConversionReady) {
          setLocalError('先点击「转换」把当前参考图和提示词转换成千问 2.1 官方格式；转换后检查内容再生成');
          return;
        }
        setLocalBusy(true);
        setLocalError('');
        setLocalNote('');
        let requestId = null;
        let startedAt = null;
        try {
          requestId = pendingRequest.current ?? `general-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          pendingRequest.current = requestId;
          startedAt = new Date().toISOString();
          rememberPending(task, requestId, startedAt);
          const { generationMedia, generationAssets } = await buildGenerationMedia();
          const preparedEdit = task === 'image-edit' && editPromptMode === 'qwen-official';
          const settings = task === 'upscale-image'
            ? { scale }
            : task === 'upscale-video'
              ? { targetResolution: videoUpscaleTarget }
            : task === 'video-generation'
              ? { seconds, mode: videoMode, resolution, aspectRatio }
              : {
                aspectRatio,
                megapixels,
              };
          const answer = await onGenerate({
            generationTask: task,
            generationPrompt: task === 'video-generation'
              ? promptWithH3Mentions(prompt, generalMentionAssets)
              : prompt,
            generationMedia,
            generationAssets,
            generationSettings: settings,
            ...(task === 'image-edit' ? { generationPromptMode: preparedEdit ? 'qwen-converted' : editPromptMode } : {}),
            requestId,
          });
          pendingRequest.current = null;
          const cached = rememberResult(answer, task, requestId);
          setLocalNote(cached.message ?? '任务已提交');
        } catch (failure) {
          const message = String(failure?.message ?? failure);
          const submissionUnknown = /submission_unknown|SUBMISSION_UNKNOWN|提交状态未知/u.test(message);
          if (!submissionUnknown) pendingRequest.current = null;
          if (requestId !== null && startedAt !== null) {
            const now = new Date().toISOString();
            const cacheId = `general-result-${task}-${requestId}`;
            const failedEntry = {
              cacheId,
              generationTask: task,
              requestId,
              state: submissionUnknown ? 'submission_unknown' : 'failed',
              message,
              generatedFiles: [],
              startedAt,
              finishedAt: submissionUnknown ? null : now,
              cachedAt: now,
            };
            setResultCache((previous) => {
              const next = upsertGeneralResultCache(storageKey, failedEntry, previous);
              resultCacheRef.current = next;
              return next;
            });
            setActiveResultId(cacheId);
          }
          setLocalError(message);
        } finally {
          setLocalBusy(false);
        }
      };

      const fieldStyle = {
        ...css.select,
        width: '100%',
        minWidth: 0,
        flex: '0 0 32px',
        height: '32px',
        boxSizing: 'border-box',
      };
      const fieldLabel = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', minWidth: 0 };
      const sectionStyle = {
        minWidth: 0,
        border: '1px solid var(--dsw-border-default, #d0d5dd)',
        borderRadius: '7px',
        background: 'var(--dsw-bg-base, #fff)',
        padding: '11px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      };
      const generatedFiles = Array.isArray(result?.generatedFiles) ? result.generatedFiles : [];
      const referencePreview = (entry) => {
        if (entry?.file !== undefined && entry?.file !== null) return mediaPreviews[entry.id] ?? null;
        const handle = entry?.thumbnailHandle ?? entry?.mediaHandle;
        return typeof handle === 'string' && handle.length > 0 && typeof previewUrl === 'function'
          ? previewUrl(handle)
          : null;
      };
      const cacheEntriesForTask = resultCache.filter((entry) => entry.generationTask === task);
      const preferredCacheFile = (entry) => {
        const files = Array.isArray(entry?.generatedFiles) ? entry.generatedFiles : [];
        return files.find((file) => fileMediaType(file).startsWith('video/'))
          ?? files.find((file) => fileMediaType(file).startsWith('image/'))
          ?? files[0]
          ?? null;
      };
      const generalResultCache = cacheEntriesForTask.length > 0
        ? h('section', {
          className: 'sdd-general-result-cache',
          'data-dsh-general-result-cache': task,
        },
        h('div', { className: 'sdd-general-result-cache-head' },
          h(SddIcon, { name: 'gallery-horizontal-end', size: 13 }),
          h('strong', null, '生成缓存'),
          h('span', null, `${cacheEntriesForTask.length} 条`)),
        h('div', {
          className: 'sdd-general-result-cache-strip',
          'aria-label': '生成结果缓存',
        },
        cacheEntriesForTask.map((entry, index) => {
          const file = preferredCacheFile(entry);
          const type = fileMediaType(file);
          const source = file?.mediaHandle && typeof previewUrl === 'function'
            ? previewUrl(file.mediaHandle)
            : null;
          const pending = entry.state !== 'completed' && entry.state !== 'saved' && entry.state !== 'failed'
            && entry.state !== 'download_failed' && entry.state !== 'cancelled';
          return h('button', {
            key: entry.cacheId,
            type: 'button',
            className: 'sdd-general-result-thumb',
            'data-dsh-general-result-thumb': entry.cacheId,
            'data-active': entry.cacheId === activeResultId ? 'true' : 'false',
            'aria-pressed': entry.cacheId === activeResultId ? 'true' : 'false',
            title: file?.name ?? entry.message ?? `生成结果 ${String(index + 1)}`,
            onClick: () => setActiveResultId(entry.cacheId),
          },
          h('div', { className: 'sdd-general-result-thumb-media' },
            pending
              ? h(SddIcon, { name: 'loader-circle', size: 18, className: 'sdd-icon-spin' })
              : source && type.startsWith('image/')
                ? h(PreviewImage, {
                  src: source,
                  alt: file.name ?? '生成图片',
                  loading: 'lazy',
                })
                : source && type.startsWith('video/')
                  ? h(PreviewVideo, {
                    src: source,
                    fallbackLabel: '视频',
                    controls: false,
                    muted: true,
                    preload: 'metadata',
                  })
                  : h(MediaPlaceholder, {
                    kind: type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : 'image',
                    compact: true,
                    label: file?.name ?? '生成结果',
                  })),
          h('div', { className: 'sdd-general-result-thumb-copy' },
            h('strong', null, file?.name ?? (pending ? '生成中' : '生成结果')),
            h('span', null, pending ? String(entry.state ?? '生成中') : (entry.generationTask ?? task))));
        })))
        : null;
      const mediaTile = (entry, label, actions, options = {}) => {
        const preview = referencePreview(entry);
        return h('div', {
          key: entry.id,
          ...(options.attributes ?? {}),
          style: {
            position: 'relative',
            minWidth: 0,
            minHeight: '112px',
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--dsw-border-default, #d0d5dd)',
            borderRadius: '6px',
            overflow: 'hidden',
            background: 'var(--dsw-surface-subtle, #f7f8fa)',
          },
        },
        h('div', { style: { height: '62px', display: 'grid', placeItems: 'center', overflow: 'hidden', background: '#111' } },
          entry.kind === 'audio' || entry.kind === 'video'
            ? h(MediaPlaceholder, {
              kind: entry.kind,
              compact: true,
              label: entry.fileName ?? label,
            })
              : preview !== null
            ? h(PreviewImage, { src: preview, alt: entry.fileName ?? '', loading: 'lazy', style: { width: '100%', height: '100%', objectFit: 'contain' } })
            : h('span', { style: { color: '#fff', fontSize: '10px', opacity: 0.7 } }, '无预览')),
        h('div', { style: { minWidth: 0, padding: '4px 5px 2px', display: 'flex', flexDirection: 'column', gap: '1px' } },
          h('span', { title: [entry.label, entry.fileName].filter(Boolean).join(' · '), style: { fontSize: '10px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            entry.fileName ?? entry.label ?? '图片'),
          h('span', { style: { fontSize: '9px', opacity: 0.62, display: 'flex', justifyContent: 'space-between', gap: '4px' } },
            h('span', null, label),
            h('span', null, entry.source === 'asset' ? '项目资产' : '本地上传'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 4px 4px' } }, actions));
      };
      const imageEditBar = task === 'image-edit'
        ? h('section', {
          'data-dsh-image-edit-bar': 'true',
          style: { display: 'flex', flexDirection: 'column', gap: '7px', padding: '8px', border: '1px solid var(--dsw-border-default, #d0d5dd)', borderRadius: '7px', background: 'var(--dsw-surface-subtle, #f7f8fa)' },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '11px' } }, '参考图'),
          h('span', { style: { marginLeft: 'auto', fontSize: '10px', fontVariantNumeric: 'tabular-nums' } }, `${media.length}/8`)),
        media.length > 0
          ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '6px' } },
            media.map((entry, index) => mediaTile(entry, `<image${index + 1}>`, [
              h('button', {
                key: 'left',
                type: 'button',
                title: '向前移动',
                'data-dsh-image-edit-move': 'left',
                disabled: index === 0,
                style: { ...css.miniButton, minHeight: '22px', padding: '0 5px' },
                onClick: () => moveMedia(entry.id, -1),
              }, '←'),
              h('button', {
                key: 'right',
                type: 'button',
                title: '向后移动',
                'data-dsh-image-edit-move': 'right',
                disabled: index === media.length - 1,
                style: { ...css.miniButton, minHeight: '22px', padding: '0 5px' },
                onClick: () => moveMedia(entry.id, 1),
              }, '→'),
              h('button', {
                key: 'remove',
                type: 'button',
                title: '移除这张参考图',
                'data-dsh-image-edit-remove': entry.id,
                style: { ...css.miniButton, minHeight: '22px', padding: '0 5px', marginLeft: 'auto' },
                onClick: () => removeMedia(entry.id),
              }, '×'),
            ], { attributes: { 'data-dsh-image-edit-ref': String(index + 1) } })))
          : h('div', { style: { ...css.note, padding: '10px 4px', textAlign: 'center' } }, '先选择项目资产，或上传 1–8 张参考图'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-dsh-image-edit-pick': 'true',
            style: css.miniButton,
            disabled: media.length >= 8,
            onClick: () => {
              setAssetPickerKind('image');
              setAssetPickerTarget(-1);
            },
          }, '从项目资产选择'),
          h('label', {
            'data-dsh-image-edit-upload': 'true',
            style: { ...css.miniButton, display: 'inline-flex', alignItems: 'center', opacity: media.length >= 8 ? 0.48 : 1, cursor: media.length >= 8 ? 'not-allowed' : 'pointer' },
          },
          '上传图片',
          h('input', {
            type: 'file',
            accept: 'image/*',
            multiple: true,
            'data-dsh-image-edit-file': 'true',
            disabled: media.length >= 8,
            style: { display: 'none' },
            onChange: (event) => addFiles(event),
          }))))
        : null;
      const videoSlots = new Map(media
        .filter((entry) => Number.isInteger(entry.slotNumber) && entry.slotNumber > 0)
        .map((entry) => [`${entry.kind}:${entry.slotNumber}`, entry]));
      const h3Groups = [
        { kind: 'image', prefix: 'Picture', label: '参考图片', cap: 9, accept: 'image/*', icon: 'images', accent: '#2f6fed' },
        { kind: 'audio', prefix: 'Audio', label: '参考音频', cap: 3, accept: 'audio/*', icon: 'audio-lines', accent: '#9a6700' },
        { kind: 'video', prefix: 'Video', label: '参考视频', cap: 3, accept: 'video/*', icon: 'video', accent: '#0f766e' },
      ];
      const h3AssetBar = task === 'video-generation'
        ? h('section', {
          'data-dsh-h3-asset-bar': 'true',
          style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '9px', border: '1px solid var(--dsw-border-default, #d0d5dd)', borderRadius: '7px', background: 'var(--dsw-surface-subtle, #f7f8fa)' },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '11px' } }, 'H3 资产栏'),
          h('span', { style: { marginLeft: 'auto', fontSize: '10px', fontVariantNumeric: 'tabular-nums' } }, `${media.length}/15`)),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          h3Groups.map((group) => {
            const entries = media.filter((entry) => entry.kind === group.kind
              && Number.isInteger(entry.slotNumber) && entry.slotNumber > 0);
            return h('details', {
              key: group.kind,
              open: true,
              'data-dsh-h3-asset-group': group.kind,
              style: {
                border: '1px solid var(--dsw-border-default, #d0d5dd)',
                borderLeft: `3px solid ${group.accent}`,
                borderRadius: '6px',
                padding: '7px 8px 8px',
                background: 'var(--dsw-bg-base, #fff)',
              },
            },
            h('summary', { style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', { className: 'sdd-media-group-icon', style: { color: group.accent } },
                h(SddIcon, { name: group.icon, size: 13 })),
              h('strong', { style: { fontSize: '11px' } }, group.label),
              h('span', { style: { marginLeft: 'auto', fontSize: '10px', fontVariantNumeric: 'tabular-nums' } }, `${entries.length}/${group.cap}`)),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '6px', marginTop: '7px' } },
              Array.from({ length: group.cap }, (unused, index) => {
                const slotNumber = index + 1;
                const entry = videoSlots.get(`${group.kind}:${slotNumber}`);
                const slotKey = `${group.kind}:${slotNumber}`;
                const label = `<${group.prefix} ${slotNumber}>`;
                if (entry !== undefined) {
                  return mediaTile(entry, label, [
                    h('button', {
                      key: 'replace',
                      type: 'button',
                      title: `替换 ${label}`,
                      style: { ...css.miniButton, minHeight: '22px', padding: '0 5px' },
                      onClick: () => {
                        setAssetPickerKind(group.kind);
                        setAssetPickerTarget(slotNumber);
                      },
                    }, '换'),
                    h('button', {
                      key: 'remove',
                      type: 'button',
                      title: `删除本次生成中的 ${label}`,
                      'data-dsh-h3-asset-delete': label,
                      ...(group.kind === 'image' ? { 'data-dsh-h3-delete-image': label } : {}),
                      style: { ...css.miniButton, minHeight: '22px', padding: '0 5px', marginLeft: 'auto' },
                      onClick: () => removeMedia(entry.id),
                    }, h(SddIcon, { name: 'trash-2', size: 11 })),
                  ], { attributes: { 'data-dsh-h3-asset-slot': slotKey, 'data-dsh-h3-asset-kind': group.kind } });
                }
                return h('div', {
                  key: `empty-${slotKey}`,
                  'data-dsh-h3-asset-slot': slotKey,
                  'data-dsh-h3-asset-kind': group.kind,
                  'data-empty': 'true',
                  style: { minWidth: 0, minHeight: '108px', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: '5px', padding: '7px', border: '1px dashed var(--dsw-border-default, #cbd3dc)', borderRadius: '6px', background: 'var(--dsw-surface-subtle, #f8fafc)' },
                },
                h('div', { style: { textAlign: 'center', fontSize: '15px', opacity: 0.5 } }, '＋'),
                h('div', { style: { textAlign: 'center', fontSize: '10px', fontWeight: 600 } }, label),
                h('button', {
                  type: 'button',
                  'data-dsh-h3-asset-pick': slotKey,
                  style: { ...css.miniButton, minHeight: '24px', padding: '0 5px', fontSize: '10px' },
                  onClick: () => {
                    setAssetPickerKind(group.kind);
                    setAssetPickerTarget(slotNumber);
                  },
                }, '项目资产'),
                h('label', {
                  'data-dsh-h3-asset-upload': slotKey,
                  style: { ...css.miniButton, minHeight: '24px', padding: '0 5px', fontSize: '10px', display: 'grid', placeItems: 'center', cursor: 'pointer' },
                },
                '上传',
                h('input', {
                  type: 'file',
                  accept: group.accept,
                  style: { display: 'none' },
                  onChange: (event) => addFiles(event, slotNumber, group.kind),
                })));
              }),
            ),
          );
        }),
      ),
    ) : null;
      const editPromptModeControl = task === 'image-edit'
        ? h('div', {
          'data-dsh-edit-prompt-mode': editPromptMode,
          style: {
            display: 'inline-flex',
            alignItems: 'stretch',
            minWidth: 0,
            border: '1px solid var(--dsw-border-default, #d0d5dd)',
            borderRadius: '6px',
            overflow: 'hidden',
            background: 'var(--dsw-bg-base, #fff)',
          },
        },
        [
          ['qwen-official', '千问官方版', 'sparkles', '用当前会话模型转换为千问 2.1 官方图片编辑提示词'],
          ['raw', '原样上传', 'upload', '不调用模型，原文直接上传到所选工作流'],
        ].map(([id, label, icon, title]) => h('button', {
          key: id,
          type: 'button',
          'data-dsh-edit-prompt-mode-option': id,
          'aria-pressed': editPromptMode === id ? 'true' : 'false',
          title,
          style: {
            ...css.miniButton,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            minHeight: '27px',
            padding: '0 8px',
            border: 'none',
            borderRadius: 0,
            whiteSpace: 'nowrap',
            background: editPromptMode === id ? 'var(--dsw-accent-default, #2f6fed)' : 'transparent',
            color: editPromptMode === id ? '#fff' : 'inherit',
          },
          disabled: localBusy,
          onClick: () => changeEditPromptMode(id),
        }, h(SddIcon, { name: icon, size: 12 }), label)))
        : null;
      const editPromptConvertButton = task === 'image-edit'
        ? h('button', {
          type: 'button',
          'data-dsh-edit-prompt-convert': 'true',
          title: editPromptMode === 'raw'
            ? '切到千问官方版后可读取参考图并转换'
            : '读取当前参考图，把提示词转换成千问 2.1 官方格式；只转换，不生成',
          style: {
            ...css.miniButton,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            minHeight: '27px',
            whiteSpace: 'nowrap',
            borderColor: 'var(--dsw-accent-default, #2f6fed)',
            color: 'var(--dsw-accent-default, #2f6fed)',
          },
          disabled: localBusy || converting || editPromptMode !== 'qwen-official' || media.length === 0 || prompt.trim().length === 0,
          onClick: () => { void convertEditPrompt(); },
        }, h(SddIcon, { name: converting ? 'loader-circle' : 'sparkles', size: 12 }),
        converting ? '转换中…' : editConversionReady ? '重新转换' : '转换')
        : null;
      const editPromptStatus = task === 'image-edit' && editConversion !== null
        ? h('span', {
          'data-dsh-edit-prompt-status': editConversionReady ? 'ready' : 'stale',
          style: { fontSize: '10px', color: editConversionReady ? 'var(--sdd-success, #1f7a45)' : 'var(--sdd-warning, #9a6700)', whiteSpace: 'nowrap' },
        }, editConversionReady ? (editPromptHandEdited ? '已转换 · 已手改' : '已转换') : '需重新转换')
        : null;
      const promptEditor = needsPrompt
        ? task === 'video-generation'
          ? h('div', {
            style: { ...fieldLabel, minHeight: 0 },
            'data-dsh-video-prompt': 'true',
          },
            h('span', null, 'H3 提示词'),
            h(PromptEditor, {
              t,
              value: prompt,
              assets: generalMentionAssets,
              previewUrl,
              onChange: setPrompt,
              allowMentions: true,
            }))
          : h('div', { style: fieldLabel },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', minWidth: 0 } },
              h('span', null, '提示词'),
              editPromptModeControl !== null
                ? h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                  editPromptModeControl,
                  editPromptConvertButton,
                  editPromptStatus)
                : null),
            h('textarea', {
              value: prompt,
              onChange: (event) => setPrompt(event.target.value),
              placeholder: task === 'image-edit' ? '描述要改什么，以及图片之间如何组合' : '描述想要的画面',
              style: {
                ...fieldStyle,
                height: 'auto',
                flex: '1 1 auto',
                minHeight: '180px',
                padding: '9px',
                resize: 'vertical',
                lineHeight: 1.6,
                fontFamily: 'inherit',
              },
            }))
        : null;
      const upscaleUpload = (task === 'upscale-image' || task === 'upscale-video')
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { className: 'sdd-general-upload-row', 'data-dsh-general-upload-row': task },
            h('label', {
              className: 'sdd-general-upload-button',
              'data-dsh-general-upload-label': task,
              title: fileRule.label,
              style: { ...css.button(false), cursor: 'pointer' },
            },
              h(SddIcon, { name: task === 'upscale-video' ? 'video' : 'image', size: 14 }),
              fileRule.label,
              h('input', {
                type: 'file',
                accept: fileRule.accept,
                'data-dsh-general-upload': task,
                onChange: (event) => addFiles(event),
                style: { display: 'none' },
              })),
            h('span', {
              className: 'sdd-general-upload-count',
              'data-dsh-general-upload-count': task,
            }, `${media.length}/${fileRule.max}`)),
          media.length > 0 ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            media.map((entry) => h('div', {
              key: entry.id,
              style: { display: 'flex', alignItems: 'center', gap: '5px', maxWidth: '100%', padding: '4px 5px', border: '1px solid var(--dsw-border-default, #d0d5dd)', borderRadius: '5px', background: 'var(--dsw-surface-subtle, #f7f8fa)' },
            },
            referencePreview(entry) !== null
              ? h(PreviewImage, { src: referencePreview(entry), alt: entry.fileName, style: { width: '34px', height: '34px', objectFit: 'cover', borderRadius: '3px', flex: 'none' } })
              : entry.kind === 'audio' || entry.kind === 'video'
                ? h(MediaPlaceholder, { kind: entry.kind, compact: true, label: entry.fileName, style: { width: '34px', height: '34px', flex: 'none' } })
                : h(SddIcon, { name: 'images', size: 14 }),
            h('span', { title: entry.fileName, style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10px' } }, entry.fileName),
            h('button', { type: 'button', style: { ...css.miniButton, padding: '2px 5px' }, onClick: () => removeMedia(entry.id) }, '×')))) : null)
        : null;
      const parameterBlocks = [
        task === 'upscale-image' ? h('label', { key: 'scale', style: fieldLabel },
          h('span', null, '放大倍率'),
          h('select', { value: scale, onChange: (event) => setScale(Number(event.target.value)), style: fieldStyle },
            [2, 3, 4].map((value) => h('option', { key: value, value }, `${value}x`)))) : null,
        task === 'upscale-video' ? h('label', { key: 'video-target', style: fieldLabel },
          h('span', null, '输出清晰度'),
          h('select', {
            value: videoUpscaleTarget,
            'data-dsh-video-upscale-target': 'true',
            onChange: (event) => setVideoUpscaleTarget(event.target.value),
            style: fieldStyle,
          },
          ['480p', '720p', '1080p', '2K', '4K'].map((value) => h('option', { key: value, value }, value)))) : null,
        task === 'text-to-image' || task === 'image-edit' ? h('div', { key: 'image-settings', style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' } },
          h('label', { style: fieldLabel },
            h('span', null, '画幅'),
            h('select', { value: aspectRatio, onChange: (event) => setAspectRatio(event.target.value), style: fieldStyle },
              task === 'image-edit' ? h('option', { value: '' }, '跟随参考图') : null,
              ['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'].map((value) => h('option', { key: value, value }, value)))),
          h('label', { style: fieldLabel },
            h('span', null, '清晰度'),
            h('input', { type: 'number', min: 0.4, max: 4, step: 0.1, value: megapixels, onChange: (event) => setMegapixels(Number(event.target.value)), style: fieldStyle }))) : null,
        task === 'video-generation' ? h('div', {
          key: 'video-settings',
          'data-dsh-video-settings': 'true',
          style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' },
        },
        h('label', { style: fieldLabel },
          h('span', null, '时长（秒）'),
          h('input', { type: 'number', min: 4, max: 15, step: 1, value: seconds, onChange: (event) => setSeconds(Number(event.target.value)), style: fieldStyle })),
        h('label', { style: fieldLabel },
          h('span', null, '模式'),
          h('select', { value: videoMode, onChange: (event) => setVideoMode(event.target.value), style: fieldStyle },
            h('option', { value: 'drama' }, '文戏'), h('option', { value: 'action' }, '武打'))),
        h('label', { style: fieldLabel },
          h('span', null, '清晰度'),
          h('select', { value: resolution, onChange: (event) => setResolution(event.target.value), style: fieldStyle },
            ['480p', '720p', '1080p'].map((value) => h('option', { key: value, value }, value)))),
        h('label', { style: fieldLabel },
          h('span', null, '画幅'),
          h('select', { value: aspectRatio, onChange: (event) => setAspectRatio(event.target.value), style: fieldStyle },
            ['9:16', '16:9', '1:1', '3:4', '4:3'].map((value) => h('option', { key: value, value }, value))))) : null,
      ].filter(Boolean);
      const generateButton = h('button', {
        type: 'button',
        'data-dsh-generate-submit': task,
        style: { ...css.button(true), alignSelf: 'flex-start', minWidth: '112px' },
        disabled: localBusy || converting || busy || data === null || environment?.reachable !== true
          || (typeof workflowFile !== 'string' || workflowFile.length === 0)
          || (task === 'image-edit' && editPromptMode === 'qwen-official' && !editConversionReady),
        onClick: () => { void submit(); },
      },
      h(SddIcon, { name: localBusy || converting ? 'loader-circle' : 'sparkles' }),
      converting ? '转换中…' : task === 'image-edit' && editPromptMode === 'qwen-official' && !editConversionReady
        ? '先转换'
        : localBusy ? '生成中…' : '生成');
      const resultVideoFile = generatedFiles.find((file) => file?.mediaHandle
        && String(file?.mediaType ?? '').startsWith('video/'));
      // The preview belongs to the active general-generation request. Falling back to the
      // project's newest candidate showed an unrelated clip (for example qaxfhg…) while this
      // request was still queued, which reads as if that old clip were the current result.
      const videoPreview = resultVideoFile ?? null;
      const videoPreviewSource = videoPreview?.mediaHandle && typeof previewUrl === 'function'
        ? previewUrl(videoPreview.mediaHandle)
        : null;
      const videoPreviewTitle = videoPreview?.name ?? videoPreview?.displayName ?? videoPreview?.fileName ?? null;
      const videoPreviewPanel = task === 'video-generation'
        ? h('section', {
          className: 'sdd-video-preview-pane',
          'data-dsh-video-pane': 'preview',
          'data-dsh-video-preview-pane': 'true',
        },
        h('div', { className: 'sdd-video-preview-head' },
          h('div', null,
            h('strong', null, '视频预览'),
            h('span', null, videoPreviewTitle ?? '最新候选与生成结果')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', marginLeft: 'auto' } },
            result?.state ? h('span', { style: css.stateTag(result.state === 'completed' ? 'resolved' : 'review') }, String(result.state)) : null,
            typeof onOpenResults === 'function'
              ? h('button', { type: 'button', style: css.miniButton, onClick: onOpenResults }, '查看结果')
              : null)),
        h('div', { className: 'sdd-video-preview-stage', 'data-dsh-video-preview-stage': videoPreviewSource ? 'video' : 'empty' },
          videoPreviewSource
            ? h(PreviewVideo, {
              src: videoPreviewSource,
              fallbackLabel: '视频',
              style: { width: '100%', height: '100%', objectFit: 'contain', background: '#050707' },
            })
            : h('div', { className: 'sdd-video-preview-empty' },
              h('div', { className: 'sdd-video-preview-empty-mark' }, h(SddIcon, { name: 'clapperboard', size: 20 })),
              h('strong', null, result === null ? '生成后在这里预览' : '等待视频返回'))),
        generalResultCache,
        h('div', { className: 'sdd-video-preview-meta' },
          h('span', null, videoPreviewTitle ?? (result === null ? '暂无视频' : '处理中')),
          h('span', { className: 'mono' },
            `${seconds}s · ${resolution} · ${aspectRatio}${resultStateLabel.length > 0 ? ` · ${resultStateLabel}` : ''}${resultElapsed.length > 0 ? ` ${resultElapsed}` : ''}`)),
        h('div', { className: 'sdd-video-preview-timeline' }, h('span')),
        h('div', { className: 'sdd-video-preview-actions' },
          videoPreviewSource
            ? typeof onOpenResults === 'function'
              ? h('button', { type: 'button', style: css.miniButton, onClick: onOpenResults }, '打开结果')
              : null
            : null))
        : null;

      const resultPanel = h('section', {
        'data-dsh-general-result': 'true',
        style: {
          ...sectionStyle,
          flex: task === 'video-generation' ? '0 0 auto' : '1 1 300px',
          ...(task === 'video-generation' ? { width: '100%' } : {}),
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '13px' } }, '生成结果'),
          result?.state ? h('span', { style: css.stateTag(result.state === 'completed' ? 'resolved' : 'review') }, String(result.state)) : null,
          resultStateLabel.length > 0
            ? h('span', { 'data-dsh-generation-status': result.state ?? '', style: { fontSize: '10px', opacity: 0.78 } },
              `${resultStateLabel}${resultElapsed.length > 0 ? ` · 已用时 ${resultElapsed}` : ''}`)
            : null,
          result?.workflow ? h('span', { style: { fontSize: '10px', opacity: 0.68, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, result.workflow) : null),
        generalResultCache,
        result === null
          ? h('div', { style: { ...css.note, padding: '24px 8px', textAlign: 'center' } }, '生成结果会在这里出现')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
            generatedFiles.length === 0
              ? null
              : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px' } },
                generatedFiles.map((file, index) => {
                  const source = file.mediaHandle && typeof previewUrl === 'function' ? previewUrl(file.mediaHandle) : undefined;
                  const type = String(file.mediaType ?? '');
                  return h('figure', {
                    key: `${file.mediaHandle ?? file.name}-${String(index)}`,
                    style: { margin: 0, minWidth: 0, border: '1px solid var(--dsw-border-default, #d0d5dd)', borderRadius: '6px', overflow: 'hidden', background: 'var(--dsw-surface-subtle, #f7f8fa)' },
                  },
                    source && type.startsWith('image/')
                      ? h(PreviewImage, { src: source, alt: file.name, style: { display: 'block', width: '100%', maxHeight: '360px', objectFit: 'contain', background: '#111' } })
                      : source && type.startsWith('video/')
                        ? h(PreviewVideo, { src: source, fallbackLabel: '视频', style: { display: 'block', width: '100%', maxHeight: '360px', background: '#111' } })
                        : source && type.startsWith('audio/')
                          ? h(PreviewAudio, { src: source, fallbackLabel: '音频', style: { display: 'block', width: '100%', minHeight: '74px', padding: '12px 8px' } })
                          : h('div', { style: { minHeight: '100px', display: 'grid', placeItems: 'center', fontSize: '11px', opacity: 0.7 } }, '文件已保存'),
                    h('figcaption', { style: { padding: '6px 7px', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: file.name }, file.name));
                })),
            result.promptRewrite?.rewritten_prompt
              ? h('details', { style: { fontSize: '10px', lineHeight: 1.55 } },
                h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '千问官方提示词（模型改写）'),
                h('div', { style: { marginTop: '5px', padding: '7px', background: 'var(--dsw-surface-subtle, #f7f8fa)', borderRadius: '5px', userSelect: 'text' } },
                  result.promptRewrite.rewritten_prompt))
              : null,
            result.requestId ? h('div', { style: { fontSize: '9px', opacity: 0.55, wordBreak: 'break-all' } }, `request ${result.requestId}`) : null));

      return h('div', {
        'data-dsh-general-generate': 'true',
        style: {
          display: hidden ? 'none' : 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '10px',
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
        },
      },
        h('div', { className: 'sdd-generation-toolbar' },
          h('div', {
            className: 'sdd-generation-task-tabs',
            'data-dsh-generation-task-tabs': 'true',
          },
            tasks.map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              'data-dsh-generation-task': id,
              className: 'sdd-generation-task-tab',
              style: {
                ...css.tab(task === id),
                border: `1px solid ${task === id ? 'var(--dsw-accent-default, #2f6fed)' : 'var(--dsw-border-default, #d0d5dd)'}`,
                borderRadius: '5px',
              },
              disabled: localBusy,
              onClick: () => chooseTask(id),
            }, label))),
          h('div', { className: 'sdd-generation-toolbar-actions' },
            h('button', { type: 'button', style: css.miniButton, onClick: onRefresh, disabled: busy }, busy ? '读取配置…' : '刷新配置'),
            h('button', { type: 'button', style: css.miniButton, onClick: onOpenConfig }, '全局配置'))),
        h('div', {
          'data-dsh-generation-config-summary': task,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            flexWrap: 'wrap',
            padding: '7px 9px',
            borderLeft: `3px solid ${environment?.reachable === true ? '#2f855a' : '#b7791f'}`,
            background: 'var(--dsw-surface-subtle, #f7f8fa)',
            fontSize: '10px',
            lineHeight: 1.45,
          },
        },
          h('strong', null, endpoint === 'cloud' ? '云端 ComfyUI' : '本地 ComfyUI'),
          h('span', { style: { opacity: 0.72 } }, environment?.reachable === true ? '在线' : (environment?.configured === false ? '未配置' : '未响应')),
          h('span', { title: workflowFile ?? '', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 220px' } },
            workflowName === null ? '全局配置里还没有这个任务的工作流' : `工作流：${workflowName}`),
          data !== null && environment?.reachable !== true
            ? h('span', { style: { flex: '1 1 100%', color: 'var(--sdd-warning, #9a6700)' } },
              '先启动这个运行端；或在「全局配置」里切换本地/云端。')
            : null),
        error.length > 0 ? h('div', { style: css.error }, displayShotText(error)) : null,
        note.length > 0 ? h('div', { style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, displayShotText(note)) : null,
        localError.length > 0 ? h('div', { style: css.error }, displayShotText(localError)) : null,
        localNote.length > 0 ? h('div', { style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, displayShotText(localNote)) : null,
        h('div', {
          'data-dsh-video-compose-layout': task === 'video-generation' ? 'split' : 'default',
          style: {
            display: 'flex',
            flexDirection: task === 'video-generation' ? 'column' : 'row',
            flexWrap: task === 'video-generation' ? 'nowrap' : 'wrap',
            gap: '10px',
            alignItems: 'flex-start',
            width: '100%',
            minWidth: 0,
          },
        },
          h('section', {
            'data-dsh-general-form': task,
            style: {
              ...sectionStyle,
              flex: task === 'video-generation' ? '0 0 auto' : '1 1 310px',
              ...(task === 'video-generation'
                ? { width: '100%', padding: 0, border: 'none', background: 'transparent' }
                : {}),
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px' } },
              h('strong', { style: { fontSize: '14px' } }, tasks.find(([id]) => id === task)?.[1] ?? task)),
            task === 'video-generation'
              ? h('div', {
                ref: videoWorkspaceRef,
                'data-dsh-video-compose-body': 'true',
                className: 'sdd-video-workbench sdd-video-compose',
                'data-dsh-video-workbench': 'true',
                'data-dsh-video-pane-layout': `${displayedVideoPaneWidths.assets}:${displayedVideoPaneWidths.prompt}`,
                style: {
                  gridTemplateColumns: `${displayedVideoPaneWidths.assets}px 10px ${displayedVideoPaneWidths.prompt}px 10px minmax(240px, 1fr)`,
                },
              },
              h('section', {
                className: 'sdd-video-assets-pane',
                'data-dsh-video-pane': 'assets',
              }, h3AssetBar),
              h('div', {
                className: 'sdd-video-splitter',
                role: 'separator',
                tabIndex: 0,
                'aria-label': '调节资产栏与提示词宽度',
                'aria-orientation': 'vertical',
                'aria-valuemin': VIDEO_PANE_MIN_WIDTHS.assets,
                'aria-valuemax': displayedVideoPaneWidths.assets + displayedVideoPaneWidths.prompt - VIDEO_PANE_MIN_WIDTHS.prompt,
                'aria-valuenow': displayedVideoPaneWidths.assets,
                'data-dsh-video-splitter': 'assets-prompt',
                onPointerDown: (event) => beginVideoPaneResize('assets-prompt', event),
                onKeyDown: (event) => nudgeVideoPane('assets-prompt', event),
              }),
              h('section', {
                className: 'sdd-video-prompt-pane',
                'data-dsh-video-pane': 'prompt',
              },
                promptEditor,
                ...parameterBlocks,
                generateButton),
              h('div', {
                className: 'sdd-video-splitter',
                role: 'separator',
                tabIndex: 0,
                'aria-label': '调节提示词与视频预览宽度',
                'aria-orientation': 'vertical',
                'aria-valuemin': VIDEO_PANE_MIN_WIDTHS.prompt,
                'aria-valuemax': Math.max(
                  VIDEO_PANE_MIN_WIDTHS.prompt,
                  videoWorkspaceWidth - VIDEO_SPLITTER_TOTAL
                    - displayedVideoPaneWidths.assets - VIDEO_PANE_MIN_WIDTHS.preview,
                ),
                'aria-valuenow': displayedVideoPaneWidths.prompt,
                'data-dsh-video-splitter': 'prompt-preview',
                onPointerDown: (event) => beginVideoPaneResize('prompt-preview', event),
                onKeyDown: (event) => nudgeVideoPane('prompt-preview', event),
              }),
              videoPreviewPanel)
              : [
                promptEditor,
                task === 'image-edit' ? imageEditBar : null,
                upscaleUpload,
                ...parameterBlocks,
                generateButton,
              ]),
          task === 'video-generation' ? null : resultPanel),
        h(GeneralAssetPicker, {
          open: assetPickerTarget !== null,
          title: task === 'video-generation' && assetPickerTarget !== null
            ? `选择 <${assetPickerKind === 'audio' ? 'Audio' : assetPickerKind === 'video' ? 'Video' : 'Picture'} ${String(assetPickerTarget)}>`
            : '选择图片编辑参考资产',
          assets,
          task,
          mediaKind: assetPickerKind,
          previewUrl,
          onChoose: chooseAsset,
          onClose: () => {
            setAssetPickerTarget(null);
            setAssetPickerKind('image');
          },
        }));
    }

    function ProjectCreateDialog({ root, onClose, onCreate }) {
      const [name, setName] = React.useState('');
      const [episodeCount, setEpisodeCount] = React.useState('1');
      const [aspectRatio, setAspectRatio] = React.useState('9:16');
      const [artStyle, setArtStyle] = React.useState('真人');
      const [artStyleNote, setArtStyleNote] = React.useState('');
      const [scriptFile, setScriptFile] = React.useState(null);
      const [scriptReading, setScriptReading] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const submit = async () => {
        if (busy || scriptReading) return;
        if (name.trim().length === 0) {
          setError('填写项目名称');
          return;
        }
        if (artStyle === '其他' && artStyleNote.trim().length === 0) {
          setError('填写自定义风格');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await onCreate({
            projectName: name.trim(),
            projectEpisodeCount: Number(episodeCount),
            projectAspectRatio: aspectRatio,
            projectArtStyle: artStyle,
            projectArtStyleNote: artStyle === '其他' ? artStyleNote.trim() : null,
            scriptText: scriptFile?.text ?? null,
            scriptFileName: scriptFile?.name ?? null,
          });
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setBusy(false);
        }
      };

      return h('div', { className: 'sdd-dialog-scrim' },
        h('form', {
          className: 'sdd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'sdd-create-project-title',
          onSubmit: (event) => {
            event.preventDefault();
            void submit();
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          },
        },
          h('div', { className: 'sdd-dialog-head' },
            h('div', null,
              h('strong', { id: 'sdd-create-project-title' }, '新建短剧项目'),
              h('span', null, root)),
            h('button', { type: 'button', className: 'sdd-dialog-close', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'sdd-dialog-grid' },
            h('label', { className: 'sdd-dialog-field wide' },
              h('span', null, '项目名称'),
              h('input', {
                value: name,
                'data-dsh-project-name': 'true',
                autoFocus: true,
                placeholder: '例如：雨夜来客',
                onChange: (event) => setName(event.target.value),
              })),
            h('label', { className: 'sdd-dialog-field' },
              h('span', null, '集数'),
              h('input', {
                type: 'number',
                min: 1,
                max: 999,
                value: episodeCount,
                'data-dsh-project-episode-count': 'true',
                onChange: (event) => setEpisodeCount(event.target.value),
              })),
            h('label', { className: 'sdd-dialog-field' },
              h('span', null, '画幅'),
              h('select', {
                value: aspectRatio,
                'data-dsh-project-aspect': 'true',
                onChange: (event) => setAspectRatio(event.target.value),
              }, ['9:16', '16:9', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'].map((value) =>
                h('option', { key: value, value }, value)))),
            h('label', { className: 'sdd-dialog-field' },
              h('span', null, '风格'),
              h('select', {
                value: artStyle,
                'data-dsh-project-style': 'true',
                onChange: (event) => setArtStyle(event.target.value),
              }, ['真人', '3D动漫', '动画', '其他'].map((value) =>
                h('option', { key: value, value }, value)))),
            artStyle === '其他'
              ? h('label', { className: 'sdd-dialog-field wide' },
                h('span', null, '自定义风格'),
                h('input', {
                  value: artStyleNote,
                  'data-dsh-project-style-note': 'true',
                  placeholder: '例如：复古胶片、低饱和赛博朋克',
                  onChange: (event) => setArtStyleNote(event.target.value),
                }))
              : null,
            h('div', { className: 'sdd-dialog-field wide' },
              h('span', null, '剧本（可选）'),
              h('label', { className: 'sdd-dialog-upload' },
                h(SddIcon, { name: 'file', size: 15 }),
                h('span', null, scriptReading ? '正在读取剧本…' : scriptFile === null ? '上传 .txt / .md 剧本' : scriptFile.name),
                h('input', {
                  type: 'file',
                  accept: '.txt,.md,text/plain,text/markdown',
                  'data-dsh-project-script': 'true',
                  onChange: (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file === undefined || file === null) return;
                    if (!/\.(?:txt|md)$/iu.test(file.name)) {
                      setError('剧本只支持 .txt 或 .md');
                      return;
                    }
                    setScriptReading(true);
                    Promise.resolve(typeof file.text === 'function'
                      ? file.text()
                      : new Promise((resolve, reject) => {
                        const reader = new globalThis.FileReader();
                        reader.onload = () => resolve(String(reader.result ?? ''));
                        reader.onerror = () => reject(new Error('剧本读取失败'));
                        reader.readAsText(file);
                      }))
                      .then((text) => {
                        setError('');
                        setScriptFile({ name: file.name, text: String(text) });
                      })
                      .catch((failure) => setError(String(failure?.message ?? failure)))
                      .finally(() => setScriptReading(false));
                  },
                })),
              scriptFile === null ? null : h('button', {
                type: 'button',
                className: 'sdd-dialog-text-button',
                onClick: () => setScriptFile(null),
              }, '移除剧本')),
            error.length > 0 ? h('div', { className: 'sdd-dialog-error', role: 'alert' }, error) : null,
          ),
          h('div', { className: 'sdd-dialog-actions' },
            h('button', { type: 'button', className: 'sdd-dialog-secondary', disabled: busy, onClick: onClose }, '取消'),
            h('button', {
              type: 'submit',
              className: 'sdd-dialog-primary',
              'data-dsh-project-create-submit': 'true',
              disabled: busy || scriptReading,
            }, busy ? '创建中…' : scriptReading ? '读取剧本中…' : '创建项目')))
      );
    }

    function ProjectDeleteDialog({ project, onClose, onDelete }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await onDelete();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setBusy(false);
        }
      };
      return h('div', { className: 'sdd-dialog-scrim' },
        h('form', {
          className: 'sdd-dialog compact',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'sdd-delete-project-title',
          onSubmit: (event) => {
            event.preventDefault();
            void submit();
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          },
        },
          h('div', { className: 'sdd-dialog-head' },
            h('strong', { id: 'sdd-delete-project-title' }, '删除项目'),
            h('button', { type: 'button', className: 'sdd-dialog-close', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'sdd-dialog-field wide' },
            h('span', null, project),
            h('div', { style: { ...css.note, lineHeight: 1.6 } },
              '项目会移到同级 `.trash` 文件夹，并从项目下拉和当前状态中移除。原文件不会永久删除，需要时可以从 `.trash` 手动恢复。')),
          error.length > 0 ? h('div', { className: 'sdd-dialog-error', role: 'alert' }, error) : null,
          h('div', { className: 'sdd-dialog-actions' },
            h('button', { type: 'button', className: 'sdd-dialog-secondary', disabled: busy, onClick: onClose }, '取消'),
            h('button', {
              type: 'submit',
              className: 'sdd-dialog-primary',
              'data-dsh-project-delete-confirm': 'true',
              disabled: busy,
            }, busy ? '正在移除…' : '确认删除项目')))
      );
    }

    function EpisodeCreateDialog({ defaultNumber, onClose, onCreate }) {
      const [number, setNumber] = React.useState(String(defaultNumber));
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const submit = async () => {
        if (busy) return;
        const value = Number(number);
        if (!Number.isInteger(value) || value < 1) {
          setError('填写有效的集数');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await onCreate(value);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setBusy(false);
        }
      };
      return h('div', { className: 'sdd-dialog-scrim' },
        h('form', {
          className: 'sdd-dialog compact',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'sdd-create-episode-title',
          onSubmit: (event) => {
            event.preventDefault();
            void submit();
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          },
        },
          h('div', { className: 'sdd-dialog-head' },
            h('strong', { id: 'sdd-create-episode-title' }, '新增集数'),
            h('button', { type: 'button', className: 'sdd-dialog-close', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('label', { className: 'sdd-dialog-field' },
            h('span', null, '集数'),
            h('input', {
              type: 'number',
              min: 1,
              max: 999,
              value: number,
              autoFocus: true,
              'data-dsh-episode-number': 'true',
              onChange: (event) => setNumber(event.target.value),
            })),
          error.length > 0 ? h('div', { className: 'sdd-dialog-error', role: 'alert' }, error) : null,
          h('div', { className: 'sdd-dialog-actions' },
            h('button', { type: 'button', className: 'sdd-dialog-secondary', disabled: busy, onClick: onClose }, '取消'),
            h('button', {
              type: 'submit',
              className: 'sdd-dialog-primary',
              'data-dsh-episode-create-submit': 'true',
              disabled: busy,
            }, busy ? '创建中…' : '新增集数'))),
      );
    }

    function StoryboardPanel(props) {
      const { sessionId: rawSessionId, t } = props;
      const ctx = props.ctx;
      /**
       * The workbench runs OUTSIDE a session view, so the slot does not hand it a session id.
       *
       * Every Host call this panel makes is addressed to a session, so without one the panel would
       * open and be unable to read anything - a surface that looks alive and does nothing. Rather
       * than fail per-call, take the workspace's main session when the slot gave none, and show one
       * clear line when there is still nothing to address.
       */
      const sessionId = rawSessionId ?? readMainSessionId(ctx);
      // `wide` is the three-column workbench layout. The docked left entry is always wide because
      // it has its own shell layer beside the conversation.
      const [fullscreen, setFullscreen] = React.useState(false);
      const dockedLeft = props.dockedLeft === true;
      const wide = props.wide === true || dockedLeft || fullscreen;
      const overlayFullscreen = fullscreen && !dockedLeft;
      // Remembered so the workbench still has something to address when the sessions snapshot is not
      // readable from this scope - the sidebar tab sees a real id, the main view may not.
      if (typeof rawSessionId === 'string' && rawSessionId.length > 0) writeMemoSession(rawSessionId);
      if (wide && (typeof sessionId !== 'string' || sessionId.length === 0)) {
        return h('div', { style: { padding: '16px', fontSize: '13px', opacity: 0.75 } },
          '分镜管理需要在一个会话里打开。先在左侧新建或选择一个会话，再回到这里。');
      }
      const [projects, setProjects] = React.useState(null);
      const [project, setProject] = React.useState('');
      const [directorMode, setDirectorMode] = React.useState(null);
      const [activeProject, setActiveProject] = React.useState('');
       const [directorContext, setDirectorContext] = React.useState(null);
       const directorContextRef = React.useRef(null);
      const [directorModeBusy, setDirectorModeBusy] = React.useState(false);
      const [directorModeError, setDirectorModeError] = React.useState('');
      /**
       * Whether THIS session's sandbox may save into the open project.
       *
       * The Host answers it with the same policy the write is judged by, so the panel can say
       * "read only" while the user is still reading, instead of accepting 40 KB of edits and
       * failing at save time. `null` (the whole object, or its `writable` field) means UNKNOWN and
       * renders nothing: a warning nobody could verify is worse than silence.
       */
      const [writeAccess, setWriteAccess] = React.useState(null);
      const [writeAccessNote, setWriteAccessNote] = React.useState('');
      // Keep the selected project root separate from the picker's current listing.
      // Browsing another directory must not change where relative project paths resolve.
      const [folder, setFolder] = React.useState('');
      const [listing, setListing] = React.useState(null);
      const [picking, setPicking] = React.useState(false);
      const [projectCreateOpen, setProjectCreateOpen] = React.useState(false);
      const [projectDeleteOpen, setProjectDeleteOpen] = React.useState(false);
      const [episodeCreateOpen, setEpisodeCreateOpen] = React.useState(false);
      const [contextNote, setContextNote] = React.useState('');

      const [episodes, setEpisodes] = React.useState([]);
      const [episode, setEpisode] = React.useState('');
      // The selected source's PATH. A source id is not unique any more (see sourceOptions), so the
      // path is what identifies the file the panel is showing.
      const [sourceId, setSourceId] = React.useState('video');
       const [production, setProduction] = React.useState(null);
       const [productionBusy, setProductionBusy] = React.useState(false);
       const [productionError, setProductionError] = React.useState('');
       const [shotFilter, setShotFilter] = React.useState('all');
       const [focusedShotKey, setFocusedShotKey] = React.useState(null);
       const [sourceSwitchPending, setSourceSwitchPending] = React.useState(null);
       const sourceBlockCacheRef = React.useRef({});
       const shotSourceChoicesRef = React.useRef(readShotSourceChoices());
      const pendingFocusedBlockRef = React.useRef(null);
      const focusLockUntilRef = React.useRef(0);
       const dramaShotScrollRef = React.useRef(null);
       const dramaEditorFeedRef = React.useRef(null);
       const dramaScrollFrame = React.useRef(null);
      const [sourceGenerateBusy, setSourceGenerateBusy] = React.useState(false);
      const [sourceGenerateNote, setSourceGenerateNote] = React.useState('');
      const [sourceGenerateError, setSourceGenerateError] = React.useState('');
      const [h3CompileConfirm, setH3CompileConfirm] = React.useState(false);
      const [shots, setShots] = React.useState([]);
      // The document revision the current `shots` were read at. Every write states it, so a
      // panel that fell behind - the file changed in an editor, or in another window - is
      // refused instead of overwriting the other edit. Null until a migrated project has
      // been read; a project without metadata has no revision and writes stay positional.
      const [revision, setRevision] = React.useState(null);
      // Every 大分镜 of the current source, each carrying the FILE it belongs to, so a card can be saved
      // back into the right one and show which file that is.
      const [shotFiles, setShotFiles] = React.useState([]);
      // What the auto-organise step produced, so the panel can say it created the per-大分镜 files
      // instead of appearing to have conjured them.
      const [organised, setOrganised] = React.useState([]);
      // Which file a NEW block belongs in, decided by the Host (the highest-numbered 大分镜 file).
      const [insertTarget, setInsertTarget] = React.useState(null);
      // Bumped to force a reload after an edit, because a source spans several files and the list on
      // screen is not the file that was edited.
      const [reloadKey, setReloadKey] = React.useState(0);
      const [drift, setDrift] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      // ── which of the three views is showing ──
      // The script view is what the panel has always been, so it stays the default; assets and
      // jobs are things you go and look at rather than things you sit in.
      const [view, setView] = React.useState('script');
      const [globalConfigData, setGlobalConfigData] = React.useState(null);
      const [globalConfigDraft, setGlobalConfigDraft] = React.useState(null);
      const [globalConfigBusy, setGlobalConfigBusy] = React.useState(false);
      const [globalConfigSaving, setGlobalConfigSaving] = React.useState(false);
      const [globalPromptBusy, setGlobalPromptBusy] = React.useState(false);
      const [globalConfigError, setGlobalConfigError] = React.useState('');
      const [globalConfigNote, setGlobalConfigNote] = React.useState('');
      const [globalConfigTask, setGlobalConfigTask] = React.useState('text-to-image');
      const [globalVideoMode, setGlobalVideoMode] = React.useState('drama');
      // The script view needs the prompt-source list too. This is deliberately separate from
      // `globalConfigData`: loading only the sources must not make the config tab believe its
      // workflows and video controls have already been read.
      const [scriptPromptSources, setScriptPromptSources] = React.useState(null);
      const [scriptPromptBusy, setScriptPromptBusy] = React.useState(false);
      const [scriptPromptError, setScriptPromptError] = React.useState('');
      const [scriptHostReady, setScriptHostReady] = React.useState(false);
      const [scriptPromptChoice, setScriptPromptChoice] = React.useState('');
      const [resplitConfirm, setResplitConfirm] = React.useState(false);
      const [resplitBusy, setResplitBusy] = React.useState(false);
      const [resplitNote, setResplitNote] = React.useState('');

      // ── the asset library ──
      const [assets, setAssets] = React.useState([]);
      const [assetDetail, setAssetDetail] = React.useState(null);
      const assetDetailRef = React.useRef(null);
      const [assetBusy, setAssetBusy] = React.useState(false);
      const [assetSummary, setAssetSummary] = React.useState(null);
      const assetContext = JSON.stringify([folder, project, episode]);
      const assetContextRef = React.useRef(assetContext);
      React.useEffect(() => {
        assetDetailRef.current = assetDetail;
      }, [assetDetail]);
      assetContextRef.current = assetContext;
       directorContextRef.current = directorContext;
      const assetLoadSeq = React.useRef(0);
       const productionLoadSeq = React.useRef(0);

      // ── the job ledger ──
      const [jobs, setJobs] = React.useState([]);
      const [jobsBusy, setJobsBusy] = React.useState(false);

      // ── the candidate area ──
      const [candidates, setCandidates] = React.useState([]);
      const [resultStats, setResultStats] = React.useState(null);
      const [resultsBusy, setResultsBusy] = React.useState(false);
      // Which card is mid-action, so one button spins instead of the whole grid.
      const [busyCandidate, setBusyCandidate] = React.useState(null);
      // The recovered inputs for a redo, shown so the user can see what will be run again.
      const [redoPlan, setRedoPlan] = React.useState(null);

      // ── references for the open block, keyed by shotId ──
      const [refsByShot, setRefsByShot] = React.useState({});

      const currentEpisode = episodes.find((entry) => String(entry.number) === episode);
      const sources = currentEpisode?.sources ?? [];
      // One button per SOURCE, not per file.
      //
      // A source is a kind of prompt document - 视频提示词 or H3 中文 - and the panel lists every
      // 大分镜 of the selected KIND. Splitting the buttons per file made the sidebar show four near
      // identical entries for one episode, and the user asked for the opposite: the source, with its
      // 大分镜 inside it.
      //
      // The three versions stay visible even before they exist. Hiding a missing H3 tab looked like
      // the version had been lost; an absent tab now says 待生成 and offers the one action that can
      // create it. Only the tabs the project declares are shown for unusual custom sources.
      const sourceCatalog = [
        { id: 'video', label: '视频提示词' },
        { id: 'h3-zh', label: 'H3' },
      ];
      const sourceOptions = sourceCatalog.map((catalog) => {
        const found = sources.find((entry) => entry.id === catalog.id);
        return found === undefined
          ? { ...catalog, available: false, file: null, path: null, files: [] }
          : { ...found, label: catalog.label, available: true, files: found.files ?? [], path: found.path ?? found.file ?? null };
      });
      const currentSource = sourceOptions.find((entry) => entry.id === sourceId)
        ?? sourceOptions.find((entry) => entry.id === 'video' && entry.available)
        ?? sourceOptions.find((entry) => entry.available)
        ?? sourceOptions[0];
      const videoSourceOption = sourceOptions.find((entry) => entry.id === 'video');
      const h3SourceOption = sourceOptions.find((entry) => entry.id === 'h3-zh');
      // A missing H3 has no files of its own. The video storyboard supplies the shot sequence and
      // duration, but every H3 card starts empty and targets its own standard H3 filename. The
      // target is created only when the user types, uploads a slot, or synchronizes.
      const missingH3Preview = sourceId === 'h3-zh'
        && h3SourceOption?.available === false
        && videoSourceOption?.available === true;
      const readableSource = missingH3Preview ? videoSourceOption : currentSource;
      const missingH3TargetFor = (blockNumber, sourceFile = null) => {
        const episodeFolder = typeof currentEpisode?.folder === 'string' && currentEpisode.folder.length > 0
          ? currentEpisode.folder
          : String(sourceFile ?? '').replace(/\\/gu, '/').split('/').slice(0, -1).join('/');
        if (typeof episodeFolder !== 'string' || episodeFolder.length === 0
          || !Number.isInteger(Number(blockNumber)) || Number(blockNumber) < 1) return null;
        return `${episodeFolder.replace(/\\/gu, '/').replace(/\/+$/u, '')}/第${String(episode)}集H3提示词-大分镜${String(blockNumber)}（中文）.txt`;
      };
      const sourceChoiceKey = (blockNumber) => `${String(project)}\u0000${String(episode)}:${String(blockNumber)}`;
      const selectedSourceIdFor = (shot) => shot?.selectedSourceId
        ?? (shot?.h3 === true ? 'h3-zh' : 'video');
      const shotIdentityIds = (shot) => new Set([
        typeof shot?.shotId === 'string' ? shot.shotId : null,
        ...Object.values(shot?.shotIdsBySource ?? {}).filter((value) => typeof value === 'string'),
      ].filter(Boolean));
      const sequenceKeyFor = (shot) => `block:${String(episode)}:${String(
        shot?.sourceNumber
        ?? shot?.blockNumber
        ?? (Number.isInteger(shot?.index) ? shot.index + 1 : ''),
      )}`;
      /**
       * Turn one block from a SOURCE into the shape a card needs.
       *
       * The source is kept on the block. A card may therefore show Chinese H3 while the next
       * card still shows the video prompt; no part of this shape depends on a global "active
       * source" once the source has been read.
       */
      const sourceShotFromBlock = (block, source, position = 0) => {
        const blockNumber = Number(block.blockNumber ?? block.sourceNumber ?? position + 1);
        const file = block.file ?? source?.path ?? null;
        const missingH3File = block.missingH3File === true;
        const target = missingH3File ? missingH3TargetFor(blockNumber, file) : file;
        return {
          ...block,
          index: Number.isInteger(block.index) ? block.index : 0,
          title: `分镜 ${String(blockNumber)}`,
          sourceNumber: blockNumber,
          fileName: String(target ?? file ?? '').replace(/\\/gu, '/').split('/').pop(),
          file: target ?? file,
          revision: block.revision ?? null,
          h3: source?.id !== 'video',
          sourceId: source?.id ?? 'video',
          selectedSourceId: source?.id ?? 'video',
          missingH3File,
          seconds: block.seconds,
          shotCount: 0,
          shotId: block.shotId ?? null,
          text: String(block.text ?? ''),
          references: block.references ?? [],
          referenceSlots: block.referenceSlots ?? [],
          unresolved: block.unresolved ?? [],
          ambiguous: block.ambiguous ?? [],
          orderedInputs: block.orderedInputs ?? [],
        };
      };
      const missingH3VariantFor = (shot) => {
        const base = shot?.variants?.video ?? shot;
        const blockNumber = Number(
          base?.sourceNumber
          ?? base?.blockNumber
          ?? shot?.sourceNumber
          ?? (Number.isInteger(base?.index) ? base.index + 1 : NaN),
        );
        const target = missingH3TargetFor(blockNumber, base?.file ?? shot?.file ?? currentSource?.path ?? null);
        if (target === null) return null;
        return {
          ...base,
          index: 0,
          blockNumber,
          sourceNumber: blockNumber,
          file: target,
          fileName: target.replace(/\\/gu, '/').split('/').pop(),
          cardKey: `missing-h3:${target}`,
          shotId: null,
          revision: null,
          h3: true,
          sourceId: 'h3-zh',
          selectedSourceId: 'h3-zh',
          missingH3File: true,
          sourceVideoFile: base?.file ?? null,
          text: '',
          references: [],
          referenceSlots: [],
          unresolved: [],
          ambiguous: [],
          orderedInputs: [],
        };
      };
      const applyShotSource = (shot, sourceId) => {
        const variants = shot?.variants ?? {};
        const variant = variants[sourceId];
        if (variant === undefined || variant === null) return shot;
        const shotIdsBySource = {
          ...(shot?.shotIdsBySource ?? {}),
          ...(typeof shot?.sourceId === 'string' && typeof shot?.shotId === 'string'
            ? { [shot.sourceId]: shot.shotId }
            : {}),
          ...(typeof variant.shotId === 'string' ? { [sourceId]: variant.shotId } : {}),
        };
        return {
          ...shot,
          ...variant,
          // The wrapper identity belongs to the shot, not to either prompt file. Switching the
          // source must not remount the editor or discard its open/draft state.
          cardKey: shot.cardKey,
          sequenceKey: shot.sequenceKey,
          variants: { ...variants, [sourceId]: variant },
          shotIdsBySource,
          sourceId,
          selectedSourceId: sourceId,
        };
      };
      const composeStoredShot = (primaryShot) => {
        const blockNumber = Number(primaryShot.sourceNumber);
        const sequenceKey = `block:${String(episode)}:${String(blockNumber)}`;
        const variants = {};
        for (const [sourceId, cachedBlocks] of Object.entries(sourceBlockCacheRef.current)) {
          const variant = (cachedBlocks ?? []).find((entry) => Number(entry.sourceNumber) === blockNumber);
          if (variant !== undefined) variants[sourceId] = variant;
        }
        variants[primaryShot.sourceId] = primaryShot;
        const shotIdsBySource = Object.fromEntries(Object.entries(variants)
          .filter(([, variant]) => typeof variant?.shotId === 'string')
          .map(([sourceId, variant]) => [sourceId, variant.shotId]));
        let next = {
          ...primaryShot,
          cardKey: primaryShot.cardKey ?? sequenceKey,
          sequenceKey,
          variants,
          shotIdsBySource,
          selectedSourceId: primaryShot.sourceId,
        };
        const chosen = shotSourceChoicesRef.current[sourceChoiceKey(blockNumber)] ?? primaryShot.sourceId;
        if (chosen === 'h3-zh' && variants['h3-zh'] === undefined && h3SourceOption?.available === false) {
          const missing = missingH3VariantFor(next);
          if (missing !== null) next = { ...next, variants: { ...next.variants, 'h3-zh': missing } };
        }
        return applyShotSource(next, chosen);
      };
      const videoBlockNumbers = (videoSourceOption?.files ?? [])
        .map((file) => Number(file.blockNumber))
        .filter((value) => Number.isInteger(value) && value > 0);
      const h3BlockNumbers = new Set((h3SourceOption?.files ?? [])
        .map((file) => Number(file.blockNumber))
        .filter((value) => Number.isInteger(value) && value > 0));
      const h3MissingBlockNumbers = videoBlockNumbers.filter((number) => !h3BlockNumbers.has(number));
      const canCompileH3FromVideo = videoSourceOption?.available === true
        && typeof sessionId === 'string' && sessionId.length > 0;

      React.useEffect(() => {
        setResplitConfirm(false);
        setResplitNote('');
        setScriptPromptChoice('');
        setSourceGenerateNote('');
        setSourceGenerateError('');
        setH3CompileConfirm(false);
      }, [project, episode, sourceId]);

      React.useEffect(() => {
        // Source variants belong to one episode. Reusing a block-number cache across projects or
        // episodes would show one creator's H3 under another creator's shot.
        sourceBlockCacheRef.current = {};
        setSourceSwitchPending(null);
      }, [project, episode]);

      /**
       * Turn a media handle into a URL the browser can load.
       *
       * The handle is opaque and was minted by the Host for one file, so this function cannot
       * construct a request for anything the Host did not offer. Nothing here knows a path.
       */
      // A new panel session gets a new media URL even when the handle predates a replaced file
      // at the same path. The route revalidates as well; this releases URLs cached by older
      // plugin versions that still carried a five-minute max-age.
      const mediaCacheRevision = React.useRef(Date.now().toString(36)).current;
      const mediaUrl = React.useCallback((handle) => {
        if (typeof handle !== 'string' || handle.length === 0) return undefined;
        const url = `${MEDIA_PREFIX}${handle}?v=${mediaCacheRevision}`;
        previewLoaders.set(url, () => callHost(ctx, sessionId, 'media-preview', { handle }, folder));
        if (previewLoaders.size > 4000) previewLoaders.delete(previewLoaders.keys().next().value);
        return url;
      }, [ctx, sessionId, folder, mediaCacheRevision]);

      /**
       * The same handle, ready to hand to `<PreviewImage>`.
       *
       * `mediaUrl` also registers a loader, and a registered loader means "this picture arrives
       * as base64 through the panel's own channel". `PreviewImage` reads that map, so the two
       * functions must stay in step: a handle registered here but drawn with a bare `<img>` would
       * request the route URL directly, and one NOT registered must be drawn as a URL.
       *
       * That fallback is also why `media-preview` travels the panel route and not the command
       * channel: it answers with base64 image data, so on the command channel every preview wrote
       * an entire encoded picture into the conversation transcript as command text.
       */
      const previewUrl = React.useCallback((handle) => {
        if (typeof handle !== 'string' || handle.length === 0) return undefined;
        return mediaUrl(handle) ?? handle;
      }, [mediaUrl]);
      const [generationSettings, setGenerationSettings] = React.useState({});
      // H3 画幅 is a production-wide decision for the current project/episode. Keeping it only
      // inside each shot meant selecting 9:16 on one card and generating from another silently
      // fell back to the project's 16:9 default.
      const [generationAspectRatio, setGenerationAspectRatio] = React.useState({});
      const writeQueues = React.useRef(new Map());
      const savedRevisions = React.useRef(new Map());
      const generationRequests = React.useRef(new Map());
       const modeSyncQueue = React.useRef(Promise.resolve());

       const callModeHost = React.useCallback((payload) => {
         const task = modeSyncQueue.current
           .catch(() => undefined)
           .then(() => callHost(ctx, sessionId, 'mode', payload, folder, { retry: false }));
         modeSyncQueue.current = task;
         return task;
       }, [ctx, sessionId, folder]);

      const loadAssets = React.useCallback(async (refresh) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || project.length === 0) return;
        const seq = assetLoadSeq.current + 1;
        assetLoadSeq.current = seq;
        setAssetBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'assets', {
            project,
            assetAction: refresh === true ? 'refresh' : 'list',
            ...(episode ? { episodeNumber: Number(episode) } : {}),
          }, folder);
          if (seq !== assetLoadSeq.current) return;
          const list = data.assets ?? [];
          setAssets(list);
          if (refresh === true) setAssetSummary(data.stats ?? null);
          else if (list.length === 0) {
            // Never scanned: the first look should show something rather than an instruction to
            // press a button whose effect the user cannot yet picture. The scan is read-only.
            const filled = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'refresh', ...(episode ? { episodeNumber: Number(episode) } : {}) }, folder);
            if (seq !== assetLoadSeq.current) return;
            setAssets(filled.assets ?? []);
            setAssetSummary(filled.stats ?? null);
          }
        } catch (failure) {
          if (seq !== assetLoadSeq.current) return;
          setError(String(failure?.message ?? failure));
          // A refused metadata refresh must not erase a list that was already read.
          // Read-only sessions can list assets but cannot write .director/assets.json.
        } finally {
          if (seq === assetLoadSeq.current) setAssetBusy(false);
        }
      }, [ctx, sessionId, project, folder, episode]);

      const loadProductionProgress = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || project.length === 0) return;
        const number = Number(episode);
        if (!Number.isInteger(number) || number < 1) {
          setProduction(null);
          return;
        }
        const seq = productionLoadSeq.current + 1;
        productionLoadSeq.current = seq;
        setProductionBusy(true);
        setProductionError('');
        try {
          const data = await callHost(ctx, sessionId, 'progress', {
            project,
            episodeNumber: number,
          }, folder);
          if (productionLoadSeq.current !== seq) return;
          setProduction(data);
        } catch (failure) {
          if (productionLoadSeq.current !== seq) return;
          setProductionError(String(failure?.message ?? failure));
        } finally {
          if (productionLoadSeq.current === seq) setProductionBusy(false);
        }
      }, [ctx, sessionId, project, episode, folder]);

      const openAsset = React.useCallback(async (row) => {
        setAssetBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'detail', asset: row.assetId }, folder);
          setAssetDetail(data.asset ?? null);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setAssetBusy(false);
        }
      }, [ctx, sessionId, project, folder]);

      const createAsset = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'create',
          kindFilter: payload.kind,
          assetName: payload.name,
          description: payload.description,
          ...(episode ? { episodeNumber: Number(episode) } : {}),
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        setAssetSummary(null);
        return data.created ?? null;
      }, [ctx, sessionId, project, folder, episode, assetContext]);

      const addAssetVariant = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'add-variant',
          assetId: payload.assetId,
          variantName: payload.variantName,
          description: payload.description,
          ...(episode ? { episodeNumber: Number(episode) } : {}),
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        setAssetSummary(null);
        if (assetDetailRef.current?.assetId === payload.assetId) {
          const refreshed = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'detail', asset: payload.assetId }, folder);
          setAssetDetail(refreshed.asset ?? null);
        }
        return data.created ?? null;
      }, [ctx, sessionId, project, folder, episode, assetContext, assetDetail]);

      const replaceAsset = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'replace',
          assetId: payload.assetId,
          variantName: payload.variantName,
          role: payload.role,
          fileName: payload.fileName,
          fileDataBase64: payload.fileDataBase64,
          ...(episode ? { episodeNumber: Number(episode) } : {}),
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        setAssetSummary(null);
        if (assetDetailRef.current?.assetId === payload.assetId) {
          const refreshed = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'detail', asset: payload.assetId }, folder);
          setAssetDetail(refreshed.asset ?? null);
        }
        return data.imported ?? null;
      }, [ctx, sessionId, project, folder, episode, assetContext, assetDetail]);

      const persistAssetVersionSelection = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'select',
          assetId: payload.assetId,
          variantName: payload.variantName,
          assetVersionId: payload.assetVersionId,
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        if (assetDetailRef.current?.assetId === payload.assetId && data.asset !== undefined) {
          setAssetDetail(data.asset);
        }
        return data.selection ?? null;
      }, [ctx, sessionId, project, folder, assetContext, assetDetail]);

      const deleteAssetVersionFile = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'delete-version',
          assetId: payload.assetId,
          variantName: payload.variantName,
          assetVersionId: payload.assetVersionId,
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        if (assetDetailRef.current?.assetId === payload.assetId && data.asset !== undefined) {
          setAssetDetail(data.asset);
        }
        return data.removedVersion ?? null;
      }, [ctx, sessionId, project, folder, assetContext, assetDetail]);

      const deleteAsset = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'delete',
          assetId: payload.assetId,
          confirmed: true,
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        setAssetSummary(null);
        if (assetDetailRef.current?.assetId === payload.assetId) setAssetDetail(null);
        return data.removedAsset ?? null;
      }, [ctx, sessionId, project, folder, assetContext, assetDetail]);

      const generateAssetQuadview = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'generate-quadview',
          assetId: payload.assetId,
          variantName: payload.variantName,
          quadviewAction: payload.quadviewAction,
          sourceVersionId: payload.sourceVersionId,
          requestId: payload.requestId,
          ...(episode ? { episodeNumber: Number(episode) } : {}),
        }, folder, { retry: false });
        assetLoadSeq.current += 1;
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        setAssetSummary(null);
        if (assetDetailRef.current?.assetId === payload.assetId) {
          const refreshed = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'detail', asset: payload.assetId }, folder);
          setAssetDetail(refreshed.asset ?? null);
        }
        return data.generated ?? null;
      }, [ctx, sessionId, project, folder, episode, assetContext, assetDetail]);

      const loadJobs = React.useCallback(async (options = {}) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        setJobsBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'jobs', {
            ...(options.refresh === true ? { refresh: true } : {}),
          }, folder);
          setJobs(data.jobs ?? []);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setJobs([]);
        } finally {
          setJobsBusy(false);
        }
      }, [ctx, sessionId, folder]);

      const loadResults = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || project.length === 0) return;
        setResultsBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'results', { project }, folder);
          setCandidates(data.candidates ?? []);
          setResultStats(data.stats ?? null);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setCandidates([]);
        } finally {
          setResultsBusy(false);
        }
      }, [ctx, sessionId, project, folder]);

      const refreshJobsAndResults = React.useCallback(async () => {
        // The task panel's refresh is a RECOVERY action, not just a local ledger re-read:
        // query ComfyUI, download finished outputs, then reload progress and candidates.
        await loadJobs({ refresh: true });
        await loadProductionProgress();
        if (project.length > 0) await loadResults();
      }, [loadJobs, loadProductionProgress, loadResults, project]);

      const productionHasRunning = (production?.shots ?? []).some((row) => row?.state === 'running');
      React.useEffect(() => {
        if (!productionHasRunning) return undefined;
        let cancelled = false;
        const refresh = async () => {
          await loadJobs({ refresh: true });
          if (cancelled) return;
          await loadProductionProgress();
          if (!cancelled && project.length > 0) await loadResults();
        };
        void refresh();
        const timer = globalThis.setInterval?.(() => {
          void refresh();
        }, 5000);
        return () => {
          cancelled = true;
          if (timer !== undefined) globalThis.clearInterval?.(timer);
        };
      }, [productionHasRunning, loadJobs, loadProductionProgress, loadResults, project]);

      /**
       * General-mode forms use one private Host action. The browser sends only the task-facing
       * fields; the Host resolves the saved workflow and endpoint at submit time.
       */
      const generateGeneral = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'panel-generate', {
          ...payload,
          ...(project.length > 0 ? { project } : {}),
        }, folder, { retry: false });
        if (payload.generationAction !== 'convert-edit-prompt') {
          void loadJobs();
          if (project.length > 0) void loadResults();
        }
        return data;
      }, [ctx, sessionId, folder, project, loadJobs, loadResults]);

      const loadGeneralHistory = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return { cache: [] };
        return await callHost(ctx, sessionId, 'panel-generate', {
          generationAction: 'history',
          ...(project.length > 0 ? { project } : {}),
        }, folder, { retry: false });
      }, [ctx, sessionId, folder, project]);

      const pollGeneralJob = React.useCallback(async (jobId, requestId) => {
        const byJob = typeof jobId === 'string' && jobId.length > 0;
        const byRequest = typeof requestId === 'string' && requestId.length > 0;
        if (!byJob && !byRequest) return null;
        const data = await callHost(ctx, sessionId, 'jobs', {
          ...(byJob ? { jobId } : { requestId }),
          refresh: true,
        }, folder, { retry: false });
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        return jobs.find((job) => (byJob && job.jobId === jobId) || (byRequest && job.requestId === requestId)) ?? null;
      }, [ctx, sessionId, folder]);

      /**
       * Choose one candidate as the version for its shot.
       *
       * The reload afterwards is not a nicety: the Host marks the previous selection as
       * superseded in the same call, and a panel that showed two selected cards would be lying
       * about which version is in use.
       */
      const selectCandidate = React.useCallback(async (candidateId) => {
        setBusyCandidate(candidateId);
        setError('');
        try {
          await callHost(ctx, sessionId, 'results', { project, resultAction: 'select', candidateId }, folder, { retry: false });
          await loadResults();
          await loadProductionProgress();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusyCandidate(null);
        }
      }, [ctx, sessionId, project, folder, loadResults, loadProductionProgress]);

      /**
       * Copy a selected candidate into the asset tree.
       *
       * The destination must come from the caller. This function does NOT derive one: whether a
       * result is a character, a scene or a prop is not recorded on a candidate, and guessing
       * `资产/生成结果/` would scatter files through the user's own organisation - which is the
       * one thing the asset tree is theirs to decide. The panel therefore asks the Host for a
       * destination and passes it through; with none, the button explains rather than guesses.
       */
      const promoteCandidate = React.useCallback(async (row, destination) => {
        // U4: 「存到本集」 needs no destination. The Host derives 剧集/第N集/成片/<代号>_<集>_<块>(<k>)
        // from the candidate's own episode and block, so asking the user to type a path first made
        // the button refuse - with the message 「先选用，才能存入资产目录」, which was the old rule.
        // A destination is still honoured when one is passed (older callers, and the case where a
        // candidate has no recorded position).
        setBusyCandidate(row.candidateId);
        setError('');
        try {
          // Filesystem write, not a GPU submission, but still not safe to repeat blindly.
          await callHost(ctx, sessionId, 'results', {
            project,
            resultAction: 'promote',
            candidateId: row.candidateId,
            ...(typeof destination === 'string' && destination.length > 0 ? { destination } : {}),
          }, folder, { retry: false });
          await loadResults();
          // NOTE: the asset view is deliberately NOT reloaded. 存到本集 writes into the episode
          // folder, not the asset tree, so nothing in the asset view changed - refreshing it was
          // both a wasted scan and a misleading hint that the file had been filed as an asset.
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusyCandidate(null);
        }
      }, [ctx, sessionId, project, folder, loadResults]);

      const pruneResults = React.useCallback(async () => {
        setResultsBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'results', { project, resultAction: 'prune' }, folder, { retry: false });
          await loadResults();
          return data;
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return null;
        } finally {
          setResultsBusy(false);
        }
      }, [ctx, sessionId, project, folder, loadResults]);

      const undoPruneResults = React.useCallback(async (batchId) => {
        setResultsBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'results', {
            project,
            resultAction: 'undo-prune',
            ...(typeof batchId === 'string' && batchId.length > 0 ? { batchId } : {}),
          }, folder, { retry: false });
          await loadResults();
          return data;
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return null;
        } finally {
          setResultsBusy(false);
        }
      }, [ctx, sessionId, project, folder, loadResults]);

      /**
       * Recover the inputs a candidate was generated from.
       *
       * Deliberately NOT a submit button. Starting a GPU job is a decision the conversation makes
       * with the user watching, and a panel button that starts one behind their back would be the
       * opposite - it would also make the panel a second submission path, which the hard
       * constraints forbid. So this fetches the exact inputs and says what to do with them.
       *
       * The inputs come from the ledger snapshot, not from re-resolving the mentions: "the same
       * inputs" means the files that produced THIS image, and the asset library has moved on since.
       */
      const redoCandidate = React.useCallback(async (row) => {
        setBusyCandidate(row.candidateId);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'results', { project, resultAction: 'redo', candidateId: row.candidateId }, folder);
          const lines = (data.inputs ?? []).map((input, index) => `${index + 1}. ${input.fileName ?? input.localPath ?? '(unknown)'}`);
          setRedoPlan({
            candidateId: row.candidateId,
            workflow: data.workflow ?? null,
            instructions: data.instructions ?? '',
            inputs: lines,
          });
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusyCandidate(null);
        }
      }, [ctx, sessionId, project, folder]);


      /**
       * Resolve one block's references.
       *
       * The text is sent to the Host rather than resolved here, so the panel and the
       * conversation resolve a mention with the same code against the same asset library. A
       * client-side resolver would be a second implementation, and the two would disagree the
       * first time either changed.
       *
       * The previously recorded references come from a ref rather than from the dependency
       * list: they are an argument to this call, not a reason to rebuild it, and depending on
       * them would recreate the callback on every resolution - which, used in an effect keyed on
       * the draft, resolves in a loop.
       */
      const refsRef = React.useRef({});
      React.useEffect(() => { refsRef.current = refsByShot; }, [refsByShot]);
      // Several paths can ask for the same block's references: the source read, the card's
      // debounced resolve, and the two explicit buttons. Without an order, a slow older answer
      // can land after a newer one and put the stale red "unresolved" state back on screen.
      const referenceRequestSeq = React.useRef(new Map());

      const loadReferences = React.useCallback(async (shot, text, choiceOverride = null, slotOverride = null, removeOverride = null, options = {}) => {
        const key = shot.shotId ?? `${shot.file}#${shot.index}`;
        // An empty H3 card has no shotId yet. Its first reference resolve is keyed by file#index;
        // after the first write mints a shotId, that key no longer matches. Carrying the pre-create
        // decision forward is what keeps an explicit upload / chosen version from being reduced to
        // whichever default the prompt text happens to resolve to on the next read.
        const preCreateKey = shot.h3 === true && shot.missingH3File !== true
          ? `${shot.file}#${shot.index}`
          : null;
        const prior = refsRef.current[key]
          ?? (preCreateKey === null ? undefined : refsRef.current[preCreateKey]);
        const seq = (referenceRequestSeq.current.get(key) ?? 0) + 1;
        referenceRequestSeq.current.set(key, seq);
        // A one-click sync is a source-authoritative replacement. Recovering references from
        // the old H3 card here would put slots back that the latest video prompt just removed.
        const authoritativeSlots = options?.authoritativeSlots === true;
        // Automatic, debounced refreshes are not a visible navigation. Replacing the last good
        // table with a loading object made the whole asset column blink after every mention edit.
        // Keep the current table on screen and swap it once when the Host answers.
        const backgroundRefresh = options?.background === true;
        const previous = authoritativeSlots ? [] : (prior?.references ?? shot.references ?? []);
        const choices = {
          ...(prior?.choices ?? {}),
          ...(choiceOverride !== null && typeof choiceOverride === 'object' ? choiceOverride : {}),
        };
        const storedSlots = Array.isArray(slotOverride)
          ? slotOverride
          : (prior?.referenceSlots ?? shot.referenceSlots ?? []);
        const slotLabels = new Set(storedSlots.map((slot) => slot?.label).filter((label) => typeof label === 'string'));
        const recoveredSlots = (authoritativeSlots ? [] : (shot.references ?? [])).flatMap((reference) => {
            if (typeof reference?.display !== 'string'
              || typeof reference?.assetVersionId !== 'string'
              || slotLabels.has(reference.display)) return [];
            slotLabels.add(reference.display);
            const {
              thumbnailHandle,
              display,
              definition,
              occurrences,
              ...binding
            } = reference;
            void thumbnailHandle;
            void display;
            void occurrences;
            return [{
              label: reference.display,
              definition: typeof definition === 'string' ? definition : '',
              mode: 'bound',
              binding,
            }];
          });
        const referenceSlots = [...storedSlots, ...recoveredSlots];
        if (!backgroundRefresh) {
          setRefsByShot((current) => ({ ...current, [key]: { ...(current[key] ?? {}), referenceSlots, loading: true } }));
        }
        try {
          const data = await callHost(ctx, sessionId, 'references', {
            project,
            file: shot.file,
            index: shot.index,
            shotId: shot.shotId ?? null,
            h3: shot.h3 === true,
            text,
            known: previous,
            choices,
            referenceSlots,
            removeReferenceIds: Array.isArray(removeOverride)
              ? removeOverride.filter((value) => typeof value === 'string' && value.length > 0)
              : [],
          }, folder);
          if (referenceRequestSeq.current.get(key) !== seq) return;
          setRefsByShot((current) => ({
            ...current,
            [key]: {
              loading: false,
              choices,
              referenceSlots: data.referenceSlots ?? referenceSlots,
              references: data.references ?? [],
              unresolved: data.unresolved ?? [],
              ambiguous: data.ambiguous ?? [],
              orderedInputs: data.orderedInputs ?? [],
              changes: data.changes ?? [],
            },
          }));
          return data;
        } catch (failure) {
          if (referenceRequestSeq.current.get(key) !== seq) return;
          setRefsByShot((current) => {
            const previous = current[key] ?? {};
            // A failed refresh is not evidence that every previously resolved asset disappeared.
            // Keep the last good table and attach the error; blanking it made the whole asset
            // column vanish on a transient Host/project-lock failure.
            return {
              ...current,
              [key]: {
                ...previous,
                loading: false,
                error: String(failure?.message ?? failure),
              },
            };
          });
          return undefined;
        }
      }, [ctx, sessionId, project, folder]);

      const adoptGlobalConfig = React.useCallback((value) => {
        setGlobalConfigData(value);
        setGlobalConfigDraft(value?.settings === undefined || value?.settings === null
          ? null
          : JSON.parse(JSON.stringify(value.settings)));
        if (value?.video?.local?.writeMode === 'action') setGlobalVideoMode('action');
        if (value?.promptSources !== undefined && value?.promptSources !== null) {
          setScriptPromptSources(value.promptSources);
        }
      }, []);

      /**
       * Uploading or deleting one prompt document changes only the prompt-source part
       * of the config. Do NOT adopt the whole response: the user may have unsaved
       * video-step edits in the same panel, and replacing the draft would discard them.
       */
      const applyPromptSources = React.useCallback((promptSources) => {
        if (promptSources === null || promptSources === undefined) return;
        setGlobalConfigData((previous) => previous === null
          ? previous
          : { ...previous, promptSources });
        setGlobalConfigDraft((previous) => previous === null
          ? previous
          : { ...previous, promptSource: { ...(previous.promptSource ?? {}), selected: promptSources.selected } });
        setScriptPromptSources(promptSources);
      }, []);

      const loadScriptPromptSources = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        setScriptPromptBusy(true);
        setScriptPromptError('');
        try {
          const data = await callHost(ctx, sessionId, 'global-config', { configAction: 'read-prompt-sources' }, folder);
          setScriptPromptSources(data.promptSources ?? null);
          if (data.configAction === 'read-prompt-sources') {
            setScriptHostReady(true);
          } else {
            setScriptHostReady(false);
            setScriptPromptError('当前 Host 还没加载“重新拆分镜”，请从系统托盘完整退出 DSH Desktop 再重新打开。');
          }
        } catch (failure) {
          const message = String(failure?.message ?? failure);
          setScriptHostReady(false);
          setScriptPromptError(/unknown.*action/iu.test(message)
            ? '当前 Host 还没加载“重新拆分镜”，请从系统托盘完整退出 DSH Desktop 再重新打开。'
            : message);
        } finally {
          setScriptPromptBusy(false);
        }
      }, [ctx, sessionId, folder]);

      React.useEffect(() => {
        if (typeof sessionId === 'string' && sessionId.length > 0) loadScriptPromptSources();
      }, [sessionId, loadScriptPromptSources]);

      const loadGlobalConfig = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        setGlobalConfigBusy(true);
        setGlobalConfigError('');
        setGlobalConfigNote('');
        try {
          const data = await callHost(ctx, sessionId, 'global-config', { configAction: 'read' }, folder);
          adoptGlobalConfig(data.globalConfig ?? null);
        } catch (failure) {
          setGlobalConfigError(String(failure?.message ?? failure));
        } finally {
          setGlobalConfigBusy(false);
        }
      }, [ctx, sessionId, folder, adoptGlobalConfig]);

      const inspectVideoWorkflow = React.useCallback(async ({ environmentKind, workflow }) => {
        const data = await callHost(ctx, sessionId, 'global-config', {
          configAction: 'inspect-video-workflow',
          videoEnvironmentKind: environmentKind,
          videoWorkflow: workflow,
        }, folder, { retry: false });
        return data.videoInspection ?? null;
      }, [ctx, sessionId, folder]);

      const saveGlobalConfig = React.useCallback(async () => {
        if (globalConfigDraft === null) return;
        setGlobalConfigSaving(true);
        setGlobalConfigError('');
        setGlobalConfigNote('');
        try {
          const payload = JSON.parse(JSON.stringify(globalConfigDraft));
          for (const kind of ['local', 'cloud']) {
            if (payload.video?.[kind] !== undefined && payload.video[kind] !== null) {
              payload.video[kind].writeMode = globalVideoMode;
            }
          }
          const data = await callHost(ctx, sessionId, 'global-config', {
            configAction: 'save',
            generationConfig: payload,
          }, folder, { retry: false });
          adoptGlobalConfig(data.globalConfig ?? null);
          const names = ['local', 'cloud']
            .map((kind) => data.workflows?.[kind])
            .filter((value) => typeof value === 'string')
            .map((value) => value.replace(/\\/gu, '/').split('/').pop());
          setGlobalConfigNote(`已保存，并写回视频工作流${names.length === 0 ? '' : `：${names.join('、')}`}`);
        } catch (failure) {
          setGlobalConfigError(String(failure?.message ?? failure));
        } finally {
          setGlobalConfigSaving(false);
        }
      }, [ctx, sessionId, folder, globalConfigDraft, globalVideoMode, adoptGlobalConfig]);

      const uploadGlobalPrompt = React.useCallback(async ({ fileName, fileDataBase64 }) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false };
        setGlobalPromptBusy(true);
        setGlobalConfigError('');
        setGlobalConfigNote('');
        try {
          const data = await callHost(ctx, sessionId, 'global-config', {
            configAction: 'upload-prompt',
            fileName,
            fileDataBase64,
          }, folder, { retry: false });
          applyPromptSources(data.promptSources);
          setGlobalConfigNote(`已上传并选用：${data.promptSource?.label ?? fileName}`);
          return { ok: true };
        } catch (failure) {
          setGlobalConfigError(String(failure?.message ?? failure));
          return { ok: false, error: String(failure?.message ?? failure) };
        } finally {
          setGlobalPromptBusy(false);
        }
      }, [ctx, sessionId, folder, applyPromptSources]);

      const deleteGlobalPrompt = React.useCallback(async (promptSourceId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false };
        setGlobalPromptBusy(true);
        setGlobalConfigError('');
        setGlobalConfigNote('');
        try {
          const data = await callHost(ctx, sessionId, 'global-config', {
            configAction: 'delete-prompt',
            promptSourceId,
          }, folder, { retry: false });
          applyPromptSources(data.promptSources);
          setGlobalConfigNote(data.deleted === true ? '已删除该自定义提示词' : '该自定义提示词已经不存在');
          return { ok: true, deleted: data.deleted === true };
        } catch (failure) {
          setGlobalConfigError(String(failure?.message ?? failure));
          return { ok: false, error: String(failure?.message ?? failure) };
        } finally {
          setGlobalPromptBusy(false);
        }
      }, [ctx, sessionId, folder, applyPromptSources]);

      /**
       * The second decision behind 重新拆分镜.
       *
       * The first click only opens the confirmation. This function is called by the explicit
       * confirm button, and it is the only path that changes the selected prompt source and
       * asks the director to overwrite the episode's video prompt.
       */
      const resplitEpisode = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || project.length === 0 || episode.length === 0) return;
        if (directorMode !== 'drama') {
          setScriptPromptError(t('mode.required'));
          setResplitConfirm(false);
          return;
        }
        if (typeof currentEpisode?.script !== 'string' || currentEpisode.script.length === 0) {
          setScriptPromptError('本集没有剧本文件，无法重新拆分镜');
          return;
        }
        const promptSourceId = scriptPromptChoice || scriptPromptSources?.selected || '';
        if (promptSourceId.length === 0) {
          setScriptPromptError('还没有读到可用的提示词版本，请先刷新');
          return;
        }
        const selectedLabel = (scriptPromptSources?.options ?? []).find((entry) => entry.id === promptSourceId)?.label
          ?? scriptPromptSources?.selectedLabel
          ?? promptSourceId;
        setResplitBusy(true);
        setScriptPromptError('');
        setResplitNote('');
        try {
          // In-flight card saves must land before the director rewrites the same document.
          await Promise.all([...writeQueues.current.values()]);
          const data = await callHost(ctx, sessionId, 'resplit-episode', {
            project,
            episodeNumber: Number(episode),
            promptSourceId,
          }, folder, { retry: false });
          if (data.promptSources !== undefined && data.promptSources !== null) applyPromptSources(data.promptSources);
          setScriptPromptChoice('');
          setResplitConfirm(false);
          setResplitNote(`已交给导演：将按「${data.promptSource?.label ?? selectedLabel}」重新拆分第${episode}集。完成后点「刷新分镜」。`);
        } catch (failure) {
          setScriptPromptError(String(failure?.message ?? failure));
        } finally {
          setResplitBusy(false);
        }
      }, [ctx, sessionId, project, episode, folder, currentEpisode, scriptPromptChoice, scriptPromptSources, applyPromptSources, directorMode, t]);

      const adoptDirectorContext = React.useCallback((value) => {
        const next = value !== null && typeof value === 'object' && !Array.isArray(value)
          ? {
            episodeNumber: Number.isInteger(value.episodeNumber) && value.episodeNumber > 0 ? value.episodeNumber : null,
            sourceId: typeof value.sourceId === 'string' && value.sourceId.length > 0 ? value.sourceId : null,
            shotId: typeof value.shotId === 'string' && value.shotId.length > 0 ? value.shotId : null,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
          }
          : null;
        directorContextRef.current = next;
        setDirectorContext(next);
        return next;
      }, []);

      /**
       * Keep the director looking at the same place as the panel.
       *
       * Writes are deduplicated locally because opening several cards in one reading session must
       * not rewrite state.json each time. The Host remains the authority and returns the stored
       * context, which is adopted after the write.
       */
      const recordDirectorContext = React.useCallback(async (patch) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || project.length === 0) return null;
        const current = directorContextRef.current ?? {
          episodeNumber: null,
          sourceId: null,
          shotId: null,
          updatedAt: null,
        };
        const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
        const episodeNumber = has('episodeNumber') ? patch.episodeNumber : current.episodeNumber;
        const sourceId = has('sourceId') ? patch.sourceId : current.sourceId;
        const shotId = has('shotId') ? patch.shotId : current.shotId;
        if (episodeNumber === current.episodeNumber
          && sourceId === current.sourceId
          && shotId === current.shotId) return current;
        try {
          const data = await callModeHost({
            modeAction: 'select-context',
            project,
            episodeNumber,
            sourceId,
            shotId,
          });
          setDirectorModeError('');
          return adoptDirectorContext(data.activeContext ?? {
            episodeNumber,
            sourceId,
            shotId,
            updatedAt: new Date().toISOString(),
          });
        } catch (failure) {
          setDirectorModeError(String(failure?.message ?? failure));
          return null;
        }
      }, [sessionId, project, callModeHost, adoptDirectorContext]);

      /** List one directory: its subdirectories, and which of them are projects. */
      const browseTo = React.useCallback(async (path) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        setBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'browse', { path: path ?? '' }, folder);
          const found = data.browse ?? null;
          setListing(found);
          if (found !== null && found.readable === false) setError(t('error.unreadable'));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setListing(null);
        } finally {
          setBusy(false);
        }
      }, [ctx, sessionId, t, folder]);

      const loadProjects = React.useCallback(async (target) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          setProjects([]);
          setError(t('error.noSession'));
          return;
        }
        setBusy(true);
        setError('');
        try {
          const data = await callHost(ctx, sessionId, 'projects', {}, target);
          const list = data.projects ?? [];
          if (typeof data.root === 'string') setFolder(data.root);
          setProjects(list);
          const loadedMode = typeof data.mode === 'string' ? data.mode : null;
          setDirectorMode(loadedMode);
          if (loadedMode === 'general') setView((previous) => (previous === 'script' ? 'generate' : previous));
          if (loadedMode === 'drama') setView((previous) => (previous === 'generate' ? 'script' : previous));
          setWriteAccess(data.writeAccess ?? null);
          setActiveProject(typeof data.activeProject === 'string' ? data.activeProject : '');
          const marked = list.find((entry) => entry.active === true);
          const nextProject = list.some((entry) => entry.path === project) ? project : (marked?.path ?? list[0]?.path ?? '');
          setProject(nextProject);
          if (marked?.path === nextProject) adoptDirectorContext(data.activeContext ?? null);
          else adoptDirectorContext(null);
          if (data.truncated === true) setError(t('warn.truncated'));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setProjects([]);
        } finally {
          setBusy(false);
        }
      }, [ctx, sessionId, t, project, adoptDirectorContext]);

      const switchDirectorMode = React.useCallback(async (next) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        setDirectorModeBusy(true);
        setDirectorModeError('');
        try {
          const data = await callModeHost({
            modeAction: next,
            ...(project.length > 0 ? { project } : {}),
          });
          setDirectorMode(data.mode === 'drama' ? 'drama' : 'general');
          if (data.mode === 'drama') setView((previous) => (previous === 'generate' ? 'script' : previous));
          else setView((previous) => (previous === 'script' ? 'generate' : previous));
          setWriteAccess(data.writeAccess ?? null);
          setActiveProject(typeof data.activeProject === 'string' ? data.activeProject : '');
          adoptDirectorContext(data.activeContext ?? null);
          setReloadKey((value) => value + 1);
        } catch (failure) {
          setDirectorModeError(String(failure?.message ?? failure));
        } finally {
          setDirectorModeBusy(false);
        }
      }, [sessionId, project, callModeHost, adoptDirectorContext]);

      const chooseProject = React.useCallback((path) => {
        setProject(path);
        setDirectorModeError('');
        if (typeof sessionId !== 'string' || sessionId.length === 0 || path.length === 0) return;
        callModeHost({
          modeAction: 'select-project',
          project: path,
        }).then((data) => {
          setActiveProject(typeof data.activeProject === 'string' ? data.activeProject : path);
          // The boundary is judged against the PROJECT's directory, so switching project can turn
          // a read-only panel writable (or the other way) without anything else changing.
          setWriteAccess(data.writeAccess ?? null);
          adoptDirectorContext(data.activeContext ?? null);
        }).catch((failure) => {
          setDirectorModeError(String(failure?.message ?? failure));
        });
      }, [sessionId, callModeHost, adoptDirectorContext]);

      const chooseEpisode = React.useCallback((value) => {
        setEpisode(value);
        setShotFilter('all');
        setProduction(null);
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) return;
        void recordDirectorContext({
          episodeNumber: number,
          sourceId,
          shotId: null,
        });
      }, [recordDirectorContext, sourceId]);

      const createProject = React.useCallback(async (payload) => {
        const data = await callHost(ctx, sessionId, 'project-create', payload, folder);
        const nextRoot = typeof data.root === 'string' && data.root.length > 0 ? data.root : folder;
        setProjectCreateOpen(false);
        setFolder(nextRoot);
        setProject(data.projectRoot);
        setEpisode('1');
        setView('script');
        const createdNote = data.scriptQueued === true
          ? '项目已创建，剧本正在交给导演解析资产盘点'
          : data.scriptWritten === true
            ? (data.scriptQueueError ?? '项目已创建，剧本待交给导演解析')
            : '项目已创建';
        setContextNote(data.spaceWarning ? `${createdNote}。${data.spaceWarning}` : createdNote);
        await loadProjects(nextRoot);
        setProject(data.projectRoot);
        setActiveProject(data.projectRoot);
        setReloadKey((value) => value + 1);
      }, [ctx, sessionId, folder, callHost, loadProjects]);

      const deleteProject = React.useCallback(async () => {
        const data = await callHost(ctx, sessionId, 'project-delete', {
          project,
          confirmed: true,
        }, folder, { retry: false });
        setProjectDeleteOpen(false);
        setProject('');
        setActiveProject('');
        setEpisode('');
        setShots([]);
        setShotFiles([]);
        setProduction(null);
        setSourceId('video');
        adoptDirectorContext(null);
        setContextNote(`项目已移到 .trash：${data.movedTo ?? project}`);
        await loadProjects(typeof data.root === 'string' && data.root.length > 0 ? data.root : folder);
        setReloadKey((value) => value + 1);
      }, [ctx, sessionId, project, folder, callHost, loadProjects, adoptDirectorContext]);

      const createEpisode = React.useCallback(async (episodeNumber) => {
        const data = await callHost(ctx, sessionId, 'episode-create', {
          project,
          episodeNumber,
        }, folder);
        setEpisodeCreateOpen(false);
        setEpisode(String(data.episodeNumber ?? episodeNumber));
        setContextNote(`已新增第${String(data.episodeNumber ?? episodeNumber)}集`);
        setReloadKey((value) => value + 1);
      }, [ctx, sessionId, project, folder, callHost]);

      const chooseSource = React.useCallback((nextSourceId) => {
        setSourceId(nextSourceId);
        setShotFilter('all');
        const number = Number(episode);
        if (!Number.isInteger(number) || number < 1) return;
        void recordDirectorContext({
          episodeNumber: number,
          sourceId: nextSourceId,
          shotId: null,
        });
      }, [recordDirectorContext, episode]);

      const rememberShotSource = React.useCallback((shot, sourceId) => {
        const blockNumber = Number(
          shot?.sourceNumber
          ?? shot?.blockNumber
          ?? (Number.isInteger(shot?.index) ? shot.index + 1 : NaN),
        );
        if (!Number.isInteger(blockNumber) || blockNumber < 1) return;
        const next = { ...shotSourceChoicesRef.current, [sourceChoiceKey(blockNumber)]: sourceId };
        shotSourceChoicesRef.current = next;
        writeShotSourceChoices(next);
      }, [episode, project]);

      const shiftShotSourceChoicesAfterInsert = React.useCallback((insertedBlockNumber, sourceIdForNewShot) => {
        if (!Number.isInteger(insertedBlockNumber) || insertedBlockNumber < 1) return;
        const prefix = `${String(project)}\u0000${String(episode)}:`;
        const entries = Object.entries(shotSourceChoicesRef.current ?? {});
        const next = {};
        for (const [key, value] of entries.filter(([key]) => !key.startsWith(prefix))) next[key] = value;
        const scoped = entries
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value, blockNumber: Number(key.slice(prefix.length)) }))
          .filter((entry) => Number.isInteger(entry.blockNumber))
          .sort((left, right) => right.blockNumber - left.blockNumber);
        for (const entry of scoped) {
          const nextNumber = entry.blockNumber >= insertedBlockNumber ? entry.blockNumber + 1 : entry.blockNumber;
          next[`${prefix}${String(nextNumber)}`] = entry.value;
        }
        next[`${prefix}${String(insertedBlockNumber)}`] = sourceIdForNewShot;
        shotSourceChoicesRef.current = next;
        writeShotSourceChoices(next);
      }, [episode, project]);

      const shiftShotSourceChoicesAfterDelete = React.useCallback((deletedBlockNumber) => {
        if (!Number.isInteger(deletedBlockNumber) || deletedBlockNumber < 1) return;
        const prefix = `${String(project)}\u0000${String(episode)}:`;
        const entries = Object.entries(shotSourceChoicesRef.current ?? {});
        const next = {};
        for (const [key, value] of entries.filter(([key]) => !key.startsWith(prefix))) next[key] = value;
        const scoped = entries
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ value, blockNumber: Number(key.slice(prefix.length)) }))
          .filter((entry) => Number.isInteger(entry.blockNumber) && entry.blockNumber !== deletedBlockNumber)
          .sort((left, right) => left.blockNumber - right.blockNumber);
        for (const entry of scoped) {
          const nextNumber = entry.blockNumber > deletedBlockNumber ? entry.blockNumber - 1 : entry.blockNumber;
          next[`${prefix}${String(nextNumber)}`] = entry.value;
        }
        shotSourceChoicesRef.current = next;
        writeShotSourceChoices(next);
      }, [episode, project]);

      const ingestSourceBlocks = React.useCallback((source, blocks) => {
        const normalized = (blocks ?? []).map((block, position) => sourceShotFromBlock(block, source, position));
        sourceBlockCacheRef.current[source.id] = normalized;
        setRefsByShot((current) => {
          const next = { ...current };
          for (const block of normalized) {
            const key = block.shotId ?? `${block.file}#${block.index}`;
            next[key] = {
              ...(current[key] ?? {}),
              references: block.references ?? [],
              unresolved: block.unresolved ?? [],
              ambiguous: block.ambiguous ?? [],
              orderedInputs: block.orderedInputs ?? [],
              referenceSlots: block.referenceSlots ?? [],
              choices: current[key]?.choices ?? {},
              loading: false,
            };
          }
          return next;
        });
        return normalized;
      }, [episode, currentEpisode?.folder]);

      const loadSourceBlocks = React.useCallback(async (source) => {
        const cached = sourceBlockCacheRef.current[source.id];
        if (Array.isArray(cached)) return cached;
        if (typeof source?.path !== 'string' || source.path.length === 0) return [];
        const data = await callHost(ctx, sessionId, 'episode-blocks', {
          project,
          file: source.path,
          organise: directorMode === 'drama',
          language: 'zh',
        }, folder);
        return ingestSourceBlocks(source, data.blocks ?? []);
      }, [ctx, sessionId, project, folder, directorMode, ingestSourceBlocks]);

      const switchShotSource = React.useCallback(async (shot, nextSourceId) => {
        const current = selectedSourceIdFor(shot);
        if (current === nextSourceId) return;
        const blockNumber = Number(
          shot?.sourceNumber
          ?? shot?.blockNumber
          ?? (Number.isInteger(shot?.index) ? shot.index + 1 : NaN),
        );
        if (!Number.isInteger(blockNumber) || blockNumber < 1) return;
        const pendingKey = sourceChoiceKey(blockNumber);
        if (sourceSwitchPending === pendingKey) return;
        setSourceSwitchPending(pendingKey);
        setError('');
        try {
          const source = sourceOptions.find((entry) => entry.id === nextSourceId);
          let variant = shot?.variants?.[nextSourceId] ?? null;
          if (variant === null && source?.available === true) {
            const blocks = await loadSourceBlocks(source);
            variant = blocks.find((entry) => Number(entry.sourceNumber) === blockNumber) ?? null;
          }
          if (variant === null && nextSourceId === 'h3-zh') {
            variant = missingH3VariantFor(shot);
          }
          if (variant === null) {
            throw new Error(`还没有可打开的第 ${String(blockNumber)} 分镜${nextSourceId === 'h3-zh' ? ' H3' : '视频提示词'}`);
          }
          rememberShotSource(shot, nextSourceId);
          const sequenceKey = sequenceKeyFor(shot);
          setShots((previous) => previous.map((entry) => (
            sequenceKeyFor(entry) === sequenceKey
              ? applyShotSource({
                ...entry,
                variants: { ...(entry.variants ?? {}), [nextSourceId]: variant },
              }, nextSourceId)
              : entry
          )));
          const number = Number(episode);
          if (Number.isInteger(number) && number > 0) {
            void recordDirectorContext({
              episodeNumber: number,
              sourceId: currentSource?.id ?? 'video',
              shotId: variant.shotId ?? null,
            });
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setSourceSwitchPending((currentKey) => currentKey === pendingKey ? null : currentKey);
        }
      }, [sourceOptions, sourceSwitchPending, episode, currentSource?.id, loadSourceBlocks, rememberShotSource, recordDirectorContext]);

      // The Host chooses the initial project root; retain it for every later operation.
      React.useEffect(() => {
        if (folder.length > 0) return;
        loadProjects(undefined);
      }, [loadProjects, folder]);

      /**
       * Each project's 画幅 / 画风 / 分辨率, keyed by project path.
       *
       * `projects` already carries them, so no extra round trip is needed. This is the panel
       * reading the SAME record the agent writes, which is the whole point of storing them on
       * the project: before this the panel seeded every generation control with a hardcoded
       * 9:16 / 720p, so a 16:9 production opened with the wrong shape preselected and the
       * panel's default quietly disagreed with what the agent would generate.
       */
      const projectDefaults = React.useMemo(() => {
        const map = new Map();
        for (const entry of projects ?? []) {
          if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
            map.set(entry.path, entry.settings ?? null);
          }
        }
        return map;
      }, [projects]);

      /** The generation settings a shot should start from, given its project. */
      const defaultGenerationSettings = React.useCallback((projectPath) => {
        const stored = projectDefaults.get(projectPath) ?? null;
        return {
          mode: 'drama',
          // A project that has not answered yet keeps the old behaviour rather than showing an
          // empty control; the agent refuses to generate until it is answered either way.
          resolution: stored?.resolution ?? '720p',
          aspectRatio: stored?.aspectRatio ?? '9:16',
        };
      }, [projectDefaults]);

      React.useEffect(() => {
        if (project.length === 0) return undefined;
        let live = true;
        setBusy(true);
        setError('');
        callHost(ctx, sessionId, 'episodes', { project }, folder)
          .then((data) => {
            if (!live) return;
            const list = data.episodes ?? [];
            setEpisodes(list);
            const remembered = directorContextRef.current;
            const rememberedEpisode = remembered?.episodeNumber;
            setEpisode((previous) => {
              if (list.some((entry) => String(entry.number) === previous)) return previous;
              if (Number.isInteger(rememberedEpisode) && list.some((entry) => entry.number === rememberedEpisode)) return String(rememberedEpisode);
              return String(list[0]?.number ?? '');
            });
            if (remembered?.sourceId === 'h3-en') {
              setSourceId('h3-zh');
            } else if (remembered?.sourceId === 'video' || remembered?.sourceId === 'h3-zh') {
              setSourceId(remembered.sourceId);
            }
          })
          .catch((failure) => {
            if (!live) return;
            setError(String(failure?.message ?? failure));
            setEpisodes([]);
          })
          .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
        // `reloadKey` stays in the deps because compiling the Chinese H3 adds files to an
        // existing source; the episode list is what this effect fetches.
      }, [ctx, sessionId, project, folder, reloadKey]);

      React.useEffect(() => {
        const file = readableSource?.path;
        if (typeof file !== 'string' || file.length === 0) {
          setShots([]);
          setRevision(null);
          setDrift(false);
          return undefined;
        }
        let live = true;
        setBusy(true);
        setError('');
        // Load EVERY 大分镜 of this source, not just the selected file's.
        //
        // A source is a list of files now - one 视频提示词 per 大分镜 and one H3 per 大分镜 - and reading
        // only the selected one is what made the panel show "一整块全文": the user had picked the
        // episode-level document and could not see that the per-大分镜 files existed.
        //
        // The same action produces the split files when they are missing, so opening the panel puts an
        // episode-wide document into the per-大分镜 shape without a separate command.
        callHost(ctx, sessionId, 'episode-blocks', {
          project,
          file,
          organise: directorMode === 'drama',
          // No style is passed: 画风 is asked once in the conversation (真人/3D动漫/动画/其他) and is
          // carried by the generated prompts, not by panel state.
          language: 'zh',
        }, folder)
          .then((data) => {
            if (!live) return;
            const sourceBlocks = data.blocks ?? [];
            const displayBlocks = missingH3Preview
              ? sourceBlocks.flatMap((block, position) => {
                const blockNumber = Number(block.blockNumber ?? block.sourceNumber ?? position + 1);
                const target = missingH3TargetFor(blockNumber, block.file);
                if (target === null) return [];
                return [{
                  ...block,
                  // A dedicated H3 file is one block. The video source may put many blocks in one
                  // document, but each missing-H3 card targets its own standard file.
                  index: 0,
                  blockNumber,
                  sourceNumber: blockNumber,
                  file: target,
                  fileName: target.replace(/\\/gu, '/').split('/').pop(),
                  cardKey: `missing-h3:${target}`,
                  shotId: null,
                  revision: null,
                  h3: true,
                  missingH3File: true,
                  sourceVideoFile: block.file ?? null,
                  text: '',
                  references: [],
                  referenceSlots: [],
                  unresolved: [],
                  ambiguous: [],
                  orderedInputs: [],
                }];
              })
              : sourceBlocks;
            setShotFiles(displayBlocks);
            for (const block of displayBlocks) if (block.revision !== null && block.revision !== undefined) savedRevisions.current.set(`${folder}#${block.file}`, block.revision);
            const primaryShots = displayBlocks.map((block) => ({
              ...block,
              index: block.index,
              // The label the card shows: which 大分镜, and which FILE it is being saved back into.
              title: `分镜 ${String(block.blockNumber)}`,
              sourceNumber: block.blockNumber,
              fileName: block.fileName,
              file: block.file,
              cardKey: block.shotId ?? `${block.file}#${block.index}`,
              revision: block.revision ?? null,
              h3: block.h3 === true,
              missingH3File: block.missingH3File === true,
              seconds: block.seconds,
              shotCount: 0,
              shotId: block.shotId,
              text: block.text,
              references: block.references ?? [],
              referenceSlots: block.referenceSlots ?? [],
              sourceId: currentSource.id,
              selectedSourceId: currentSource.id,
            }));
            sourceBlockCacheRef.current[currentSource.id] = primaryShots;
            setShots(primaryShots.map(composeStoredShot));
            setRefsByShot((current) => {
              const next = { ...current };
              for (const block of displayBlocks) {
                const key = block.shotId ?? `${block.file}#${block.index}`;
                const previous = current[key] ?? {};
                if (block.missingH3File === true) {
                  next[key] = {
                    references: [],
                    unresolved: [],
                    ambiguous: [],
                    orderedInputs: [],
                    referenceSlots: [],
                    choices: {},
                    loading: false,
                  };
                  continue;
                }
                const incoming = {
                  references: block.references ?? [],
                  unresolved: block.unresolved ?? [],
                  ambiguous: block.ambiguous ?? [],
                  orderedInputs: block.orderedInputs ?? [],
                  referenceSlots: block.referenceSlots ?? previous.referenceSlots ?? [],
                };
                const hasIncoming = incoming.references.length > 0
                  || incoming.unresolved.length > 0
                  || incoming.ambiguous.length > 0;
                const expectsReferences = block.h3 === true
                  ? /<(?:Picture|Audio|Video)\s+\d+>/u.test(String(block.text ?? ''))
                  : /@[\p{L}\p{N}]/u.test(String(block.text ?? ''));
                const hasPrevious = (previous.references?.length ?? 0) > 0
                  || (previous.unresolved?.length ?? 0) > 0
                  || (previous.ambiguous?.length ?? 0) > 0;
                // A source reload is not proof that the references vanished. If the Host's
                // block read came back empty while the prompt still names references, keep the
                // last resolved table on screen. The card's resolver and the explicit button
                // can replace it; a transient empty answer must not blank the asset column.
                next[key] = !hasIncoming && expectsReferences && hasPrevious
                  ? { ...previous, loading: false }
                  : { ...previous, ...incoming, choices: previous.choices ?? {}, loading: false };
              }
              return next;
            });
            setOrganised(data.written ?? []);
            setInsertTarget(data.insertTarget ?? null);
            setRevision(null);
            setDrift(false);
            // `episode-blocks` is also the read that reconciles document metadata. Until it
            // finishes, a project opened for the first time has no document rows for `progress`
            // to walk, so the strip would truthfully say 0 until the user pressed refresh.
            void loadProductionProgress();
          })
          .catch(async (failure) => {
            if (!live) return;
            // Fall back to reading the one selected file.
            //
            // `episode-blocks` is the richer read - every 大分镜 of the source, each with its own file -
            // but it is also newer, and a panel that goes BLANK when it fails is worse than a panel
            // showing one document. So a failure degrades to the per-file read and says so, which keeps
            // the sidebar usable while the richer path is being trusted.
            try {
              // `folder` is the CURRENT root, and passing it is the whole point: the fallback runs after
              // the user may have switched directories, so reading without it would answer about the
              // previous project - which is exactly what a "must follow the newly selected root" test
              // catches.
              const data = await callHost(ctx, sessionId, 'read', { file }, folder);
              if (!live) return;
              const primaryShots = (data.shots ?? []).map((shot, position) => missingH3Preview
                ? (() => {
                  const blockNumber = Number(shot.sourceNumber ?? position + 1);
                  const target = missingH3TargetFor(blockNumber, file);
                  return {
                    ...shot,
                    index: 0,
                    blockNumber,
                    sourceNumber: blockNumber,
                    file: target ?? file,
                    fileName: (target ?? file).replace(/\\/gu, '/').split('/').pop(),
                    cardKey: `missing-h3:${target ?? file}`,
                    shotId: null,
                    revision: null,
                    h3: true,
                    missingH3File: target !== null,
                    sourceVideoFile: file,
                    text: '',
                    references: [],
                    referenceSlots: [],
                  };
                })()
                : {
                  ...shot,
                  sourceNumber: Number(shot.sourceNumber ?? position + 1),
                  file,
                  cardKey: shot.shotId ?? `${file}#${shot.index}`,
                  h3: currentSource?.id !== 'video',
                });
              sourceBlockCacheRef.current[currentSource.id] = primaryShots;
              setShots(primaryShots.map((shot) => composeStoredShot({
                ...shot,
                sourceId: currentSource.id,
                selectedSourceId: currentSource.id,
                cardKey: shot.cardKey ?? shot.shotId ?? `${shot.file}#${shot.index}`,
                references: shot.references ?? [],
                referenceSlots: shot.referenceSlots ?? [],
              })));
              setShotFiles([]);
              setRevision(Number.isInteger(data.revision) ? data.revision : null);
              setDrift(data.changedOnDisk === true);
              setOrganised([]);
              setError(`${String(failure?.message ?? failure)}（已退回单文件显示）`);
            } catch (second) {
              if (!live) return;
              setError(String(second?.message ?? second));
              setShots([]);
              setShotFiles([]);
              setRevision(null);
              setDrift(false);
            }
          })
          .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
      }, [ctx, sessionId, readableSource?.path, missingH3Preview, currentEpisode?.folder, project, folder, reloadKey, directorMode, loadProductionProgress]);

      React.useEffect(() => {
        if (h3SourceOption?.available !== true || typeof h3SourceOption.path !== 'string') return undefined;
        const prefix = `${String(project)}\u0000${String(episode)}:`;
        const hasStoredChoice = Object.entries(shotSourceChoicesRef.current)
          .some(([key, value]) => value === 'h3-zh' && key.startsWith(prefix));
        if (!hasStoredChoice) return undefined;
        let live = true;
        loadSourceBlocks(h3SourceOption)
          .then((blocks) => {
            if (!live) return;
            setShots((previous) => previous.map((shot) => {
              const key = sourceChoiceKey(shot.sourceNumber ?? shot.blockNumber);
              if (shotSourceChoicesRef.current[key] !== 'h3-zh') return shot;
              const variant = blocks.find((entry) => Number(entry.sourceNumber) === Number(shot.sourceNumber));
              if (variant === undefined) return shot;
              return applyShotSource({
                ...shot,
                variants: { ...(shot.variants ?? {}), 'h3-zh': variant },
              }, 'h3-zh');
            }));
          })
          .catch((failure) => {
            if (live) setError(String(failure?.message ?? failure));
          });
        return () => { live = false; };
      }, [project, episode, h3SourceOption?.available, h3SourceOption?.path, reloadKey, loadSourceBlocks]);

      /**
       * Save one block.
       *
       * The block is addressed by its `shotId` whenever the project has identities, and by
       * its position otherwise. The id is what makes the save land on the shot the user was
       * looking at even if a block was inserted above it since the file was read; the
       * revision is what makes a save from a stale panel fail loudly instead of silently
       * discarding somebody else's edit.
       */
      const saveShot = React.useCallback((locator, text) => {
        const file = locator?.file ?? currentSource?.path;
        if (file === undefined) return Promise.reject(new Error('no file is selected'));
        const queueKey = `${folder}#${file}`;
        const write = async () => {
        // `revision` is the only signal that this project has identities: a Host that
        // returned one also returned resolvable shotIds. Without it a shotId would be a
        // claim the Host cannot honour for a project nobody migrated, and the save would be
        // refused for a reason the user cannot act on.
        const targetRevision = savedRevisions.current.get(queueKey) ?? locator?.revision ?? revision;
        const byId = targetRevision !== null && typeof locator?.shotId === 'string' && locator.shotId.length > 0;
        const payload = {
          project,
          file,
          text,
          ...(byId ? { shotId: locator.shotId } : { index: locator.index }),
          ...(targetRevision === null ? {} : { expectedRevision: targetRevision }),
          ...(typeof locator?.baseText === 'string' ? { expectedText: locator.baseText } : {}),
          ...(locator?.createIfMissing === true
            ? { createIfMissing: true, episodeNumber: Number(episode), blockNumber: locator.blockNumber }
            : {}),
        };
        // A write must never be repeated. A second call would carry the `expectedText` / `expectedRevision`
        // of a file the first call already changed, so the Host would correctly answer "nothing changed" -
        // and a save that in fact succeeded would look like it did not.
        const data = await callHost(ctx, sessionId, 'write', payload, folder, { retry: false }).catch((error) => {
          // A sandbox refusal is a BOUNDARY, not a hiccup: every other block would hit the same
          // wall, so the panel says it once at the top instead of once per card.
          if (isSandboxDenial(error)) {
            setWriteAccess((previous) => ({
              ...(previous ?? {}),
              writable: false,
              reason: previous?.reason === 'read-only' ? 'read-only' : 'outside-workspace',
            }));
          }
          throw error;
        });
        // A write that LANDED is the strongest evidence there is, and it outranks any earlier
        // verdict: the user may have switched permission, or opened the session somewhere else.
        // Leaving a stale 「只读」 banner over a file that just saved is its own kind of lie.
        setWriteAccess((previous) => (previous === null || previous.writable === true
          ? previous
          : { ...previous, writable: true, reason: 'proven-by-write' }));
        if (data.revision !== null && data.revision !== undefined) savedRevisions.current.set(queueKey, data.revision);
        setShots((previous) => previous.map((shot) => {
          if ((shot.file ?? currentSource?.path) !== file) return shot;
          const updated = (data.shots ?? []).find((entry) => byId ? entry.shotId === shot.shotId : entry.index === shot.index);
          if (updated === undefined) return shot;
          const selectedSourceId = selectedSourceIdFor(shot);
          const nextShot = {
            ...shot,
            ...updated,
            file,
            revision: data.revision ?? null,
            title: shot.title,
            missingH3File: false,
            shotIdsBySource: {
              ...(shot.shotIdsBySource ?? {}),
              [selectedSourceId]: updated.shotId ?? shot.shotId ?? null,
            },
            sourceId: selectedSourceId,
            selectedSourceId,
          };
          const variants = { ...(shot.variants ?? {}), [selectedSourceId]: nextShot };
          const cached = sourceBlockCacheRef.current[selectedSourceId];
          if (Array.isArray(cached)) {
            const blockNumber = Number(nextShot.sourceNumber);
            const nextCache = cached.map((entry) => Number(entry.sourceNumber) === blockNumber
              ? { ...entry, ...updated, file, revision: data.revision ?? null, missingH3File: false }
              : entry);
            if (!nextCache.some((entry) => Number(entry.sourceNumber) === blockNumber)) {
              nextCache.push(nextShot);
            }
            sourceBlockCacheRef.current[selectedSourceId] = nextCache;
          }
          return { ...nextShot, variants };
        }));
        setDrift(false);
        if (data.created === true) {
          // The write response is already authoritative that this source now exists. Reflect it
          // immediately instead of leaving the tab marked 待生成 until the directory rescan lands.
          const fileName = String(file).replace(/\\/gu, '/').split('/').pop() ?? '';
          const createdFile = {
            file: fileName,
            path: file,
            blockNumber: Number.isInteger(locator?.blockNumber) ? locator.blockNumber : null,
          };
          setEpisodes((previous) => previous.map((entry) => {
            if (String(entry?.number ?? '') !== String(episode)) return entry;
            const entrySources = Array.isArray(entry.sources) ? entry.sources : [];
            const existing = entrySources.find((source) => source?.id === 'h3-zh');
            if (existing !== undefined) {
              const files = Array.isArray(existing.files) ? existing.files : [];
              const normalizedFile = String(file).replace(/\\/gu, '/');
              if (files.some((item) => String(item?.path ?? item?.file ?? '').replace(/\\/gu, '/') === normalizedFile)) return entry;
              return {
                ...entry,
                sources: entrySources.map((source) => source?.id === 'h3-zh'
                  ? { ...source, files: [...files, createdFile] }
                  : source),
              };
            }
            return {
              ...entry,
              sources: [...entrySources, {
                id: 'h3-zh',
                label: 'H3',
                file: fileName,
                path: file,
                files: [createdFile],
              }],
            };
          }));
          setReloadKey((value) => value + 1);
        }
        const saved = (data.shots ?? []).find((entry) => byId ? entry.shotId === locator.shotId : entry.index === locator.index);
        return { changed: data.changed === true, created: data.created === true, revision: data.revision ?? null, shotId: saved?.shotId ?? data.shotId ?? null, text: saved?.text ?? text };
        };
        const task = (writeQueues.current.get(queueKey) ?? Promise.resolve()).catch(() => {}).then(write);
        writeQueues.current.set(queueKey, task);
        return task;
      }, [ctx, sessionId, currentSource?.path, episode, folder, revision]);

      const syncH3 = React.useCallback(async (shot) => {
        const directory = String(shot.file).replace(/\\/gu, '/').split('/').slice(0, -1).join('/');
        // Switching prompt tabs flushes the video card. Synchronization must wait for that write.
        await Promise.all([...writeQueues.current.entries()].filter(([key]) => key.replace(/\\/gu, '/').includes(`#${directory}/`)).map(([, task]) => task));
        // Synchronising writes the H3 document, so a repeated call is a second write to the same block.
        const referenceKey = shot.shotId ?? `${shot.file}#${shot.index}`;
        const result = await callHost(ctx, sessionId, 'sync-h3', {
          project, file: shot.file, blockNumber: shot.sourceNumber, episodeNumber: Number(episode),
          language: 'zh',
          // The latest video block is the sole source of truth. Old H3 slots must not be sent
          // back as a second authority, even for a "discarded slots" report.
          referenceSlots: [],
        }, folder, { retry: false });
        const saved = await saveShot({
          file: shot.file,
          index: shot.index,
          shotId: shot.shotId,
          revision: shot.revision,
          baseText: shot.text,
          blockNumber: shot.sourceNumber,
          createIfMissing: shot.missingH3File === true,
        }, result.text);
        const syncedText = saved?.text ?? result.text;
        const syncedSlots = Array.isArray(result.referenceSlots) ? result.referenceSlots : [];
        // Paint the Host's source projection before the follow-up resolve can fail. The asset bar is
        // part of the one-click result, not a second best-effort request made afterwards.
        const derivedReferences = syncedSlots.flatMap((slot) => {
          if (slot?.mode !== 'bound' || slot?.binding === null || typeof slot?.binding !== 'object') return [];
          const shown = /^<(\w+)\s+(\d+)>$/u.exec(String(slot.label ?? '').trim());
          const mediaType = shown?.[1] ?? 'Picture';
          const number = Number(shown?.[2]);
          return [{
            ...slot.binding,
            display: slot.label,
            definition: typeof slot.definition === 'string' ? slot.definition : '',
            mediaType,
            referenceIndex: Number.isInteger(number) ? number : null,
            ...(mediaType === 'Picture' && Number.isInteger(number) ? { picture: number } : {}),
            bindingState: 'resolved',
          }];
        });
        const projectedReferences = Array.isArray(result.displayReferences) ? result.displayReferences : derivedReferences;
        setRefsByShot((current) => ({
          ...current,
          [referenceKey]: {
            ...(current[referenceKey] ?? {}),
            loading: false,
            error: null,
            referenceSlots: syncedSlots,
            references: projectedReferences,
            unresolved: [],
            ambiguous: [],
            orderedInputs: [],
            changes: [],
            sourceAuthority: 'latest-video-prompt',
          },
        }));
        // Sync rebuilds source Picture slots but returns every explicitly bound picture with its
        // (possibly renumbered) label. Resolve immediately so the retained file and the new numbering
        // are visible without reopening the panel.
        await loadReferences(
          { ...shot, text: syncedText },
          syncedText,
          null,
          syncedSlots,
          null,
          { authoritativeSlots: true },
        );
        // Hand back what happened, so the card can say it. 一键同步 used to be silent when the result
        // matched the file - which is exactly what a user sees as "点了没反应".
        return {
          ...result,
          text: syncedText,
          revision: saved?.revision ?? shot.revision ?? null,
          shotId: saved?.shotId ?? shot.shotId ?? null,
          changed: saved?.changed !== false,
        };
      }, [ctx, sessionId, project, episode, currentSource?.id, folder, saveShot, loadReferences]);
      const generateH3 = React.useCallback(async (shot, text, settings, referenceSlots = []) => {
        const key = `${folder}#${shot.file}#${shot.index}`;
        const signature = JSON.stringify({ text, settings, referenceSlots });
        let intent = generationRequests.current.get(key);
        if (intent && intent.signature !== signature) throw new Error('上次生成请求尚未确认，请先在任务中核对后再修改参数重新提交');
        if (!intent) {
          intent = { signature, requestId: `sidebar-${Date.now()}-${Math.random().toString(36).slice(2)}` };
          generationRequests.current.set(key, intent);
        }
        let result;
        try {
          // GPU work: a retry would be a second submission of the same shot. The `requestId` makes a
          // duplicate idempotent on the Host, but the panel must not rely on that to paper over a
          // retry it chose to make.
          result = await callHost(ctx, sessionId, 'generate-h3', {
            project,
            file: shot.file,
            index: shot.index,
            expectedText: text,
            settings,
            referenceSlots,
            requestId: intent.requestId,
          }, folder, { retry: false });
        } catch (error) {
          if (error.hostRejected && !/submission_unknown|SUBMISSION_UNKNOWN|提交状态未知/u.test(error.message)) generationRequests.current.delete(key);
          throw error;
        }
        generationRequests.current.delete(key);
        void loadProductionProgress();
        void loadResults();
        return result;
      }, [ctx, sessionId, project, folder, loadProductionProgress, loadResults]);
      /**
       * Ask the director for a focused, read-only review. The card saves the draft first, so the
       * review sees exactly the text on screen; the Host then queues a conversation turn and
       * changes no files.
       */
      const reviewShot = React.useCallback(async (shot) => {
        if (directorMode !== 'drama') throw new Error(t('mode.required'));
        const number = Number(episode);
        if (!Number.isInteger(number) || number < 1) throw new Error('先选择一集再让导演检查');
        return await callHost(ctx, sessionId, 'review-shot', {
          project,
          file: shot.file,
          index: shot.index,
          shotId: shot.shotId ?? null,
          episodeNumber: number,
          sourceId: selectedSourceIdFor(shot),
        }, folder, { retry: false });
      }, [ctx, sessionId, project, episode, folder, directorMode, t]);
      /**
       * Create a missing prompt version from the panel.
       *
       * A missing H3 tab used to be omitted entirely, which made a normal intermediate state
       * ("video prompts exist, H3 has not been compiled yet") look like a lost version. This
     * action is explicit because it writes files. Chinese H3 is compiled from the selected
     * video prompt and is the only H3 document this workflow creates.
       */
      const generateMissingSource = React.useCallback(async () => {
        if (directorMode !== 'drama') {
          setSourceGenerateError(t('mode.required'));
          return;
        }
        setSourceGenerateBusy(true);
        setSourceGenerateNote('');
        setSourceGenerateError('');
        try {
          const video = sources.find((source) => source.id === 'video');
          if (video === undefined) throw new Error('还没有视频提示词，先生成视频提示词再编译中文 H3');
          const dedicated = (video.files ?? []).filter((file) => Number.isInteger(file.blockNumber) && file.blockNumber > 0);
          const missingTargets = dedicated.filter((file) => h3MissingBlockNumbers.includes(Number(file.blockNumber)));
          const targets = missingTargets.length > 0
            ? missingTargets
            : dedicated.length > 0 ? dedicated : [{ path: video.path, file: video.file }];
          for (const target of targets) {
            await callHost(ctx, sessionId, 'compile-h3', {
              project,
              file: target.path,
              write: true,
              language: 'zh',
              includeText: false,
            }, folder, { retry: false });
          }
          setH3CompileConfirm(false);
          setSourceGenerateNote('中文 H3 已同步到全部分镜。');
          setReloadKey((value) => value + 1);
        } catch (error) {
          setSourceGenerateError(String(error?.message ?? error));
        } finally {
          setSourceGenerateBusy(false);
        }
      }, [ctx, sessionId, project, folder, currentSource, sources, directorMode, t, h3MissingBlockNumbers]);

      /**
       * Add a block after the addressed one, then reload from the Host.
       *
       * The Host renumbers every heading and returns the whole file, so the panel replaces
       * its list with what the Host reports rather than patching it locally. Deriving the
       * numbering in two places is what lets a panel and a file disagree.
       */
      const insertShot = React.useCallback(async (locator, kind) => {
        const file = locator?.file ?? currentSource?.path;
        if (file === undefined) throw new Error('no file is selected');
        const queueKey = `${folder}#${file}`;
        await writeQueues.current.get(queueKey);
        const targetRevision = savedRevisions.current.get(queueKey) ?? locator?.revision ?? revision;
        const byId = targetRevision !== null && typeof locator?.shotId === 'string' && locator.shotId.length > 0;
        const payload = {
          project,
          file,
          kind,
          episodeNumber: Number(episode),
          pairWithCompanion: true,
          ...(Number.isInteger(locator.blockNumber) ? { blockNumber: locator.blockNumber } : {}),
          ...(byId ? { shotId: locator.shotId } : { index: locator.index }),
          ...(targetRevision === null ? {} : { expectedRevision: targetRevision }),
        };
        // Inserting rewrites the whole file, so a repeated call would insert twice. A revision
        // conflict is the one safe exception: the Host rejected the write before changing anything,
        // so re-read the settled revision and retry the SAME stable shot once.
        let data;
        try {
          data = await callHost(ctx, sessionId, 'insert', payload, folder, { retry: false });
        } catch (error) {
          const staleRevision = error?.hostRejected === true
            && /revision|changed since you read/iu.test(String(error?.message ?? ''));
          if (!staleRevision || !byId) throw error;
          const latest = await callHost(ctx, sessionId, 'read', { file }, folder);
          if (!Number.isInteger(latest.revision) || latest.revision === targetRevision) throw error;
          savedRevisions.current.set(queueKey, latest.revision);
          data = await callHost(ctx, sessionId, 'insert', {
            ...payload,
            expectedRevision: latest.revision,
          }, folder, { retry: false });
        }
        if (data.revision !== null && data.revision !== undefined) savedRevisions.current.set(queueKey, data.revision);
        const insertedBlockNumber = Number(
          data.blockNumber
          ?? data.shots?.[data.insertedAt]?.sourceNumber
          ?? data.companion?.shots?.[data.companion?.insertedAt]?.sourceNumber,
        );
        shiftShotSourceChoicesAfterInsert(insertedBlockNumber, currentSource?.id === 'h3-zh' ? 'h3-zh' : 'video');
        // Every source cache contains block-number lookups. A structural insert invalidates all
        // of them, including the variants that are not currently visible.
        sourceBlockCacheRef.current = {};
        if (Number.isInteger(insertedBlockNumber) && insertedBlockNumber > 0) {
          pendingFocusedBlockRef.current = {
            blockNumber: insertedBlockNumber,
            shotIds: [data.shotId, data.companion?.shotId].filter((value) => typeof value === 'string' && value.length > 0),
            expectedCount: Array.isArray(data.shots) ? data.shots.length : null,
          };
          focusLockUntilRef.current = Date.now() + 5000;
          setFocusedShotKey(`${String(episode)}:${String(insertedBlockNumber)}`);
        }
        setReloadKey((value) => value + 1);
        setDrift(false);
        return {
          insertedAt: data.insertedAt,
          blockNumber: Number.isInteger(insertedBlockNumber) ? insertedBlockNumber : null,
          kind: data.kind,
          shotId: data.shotId ?? null,
          companion: data.companion ?? null,
        };
      }, [ctx, sessionId, currentSource?.path, currentSource?.id, folder, revision, episode, shiftShotSourceChoicesAfterInsert]);

      const deleteShot = React.useCallback(async (locator) => {
        const file = locator?.file ?? currentSource?.path;
        if (file === undefined) throw new Error('no file is selected');
        const queueKey = `${folder}#${file}`;
        await writeQueues.current.get(queueKey);
        const targetRevision = savedRevisions.current.get(queueKey) ?? locator?.revision ?? revision;
        const byId = targetRevision !== null && typeof locator?.shotId === 'string' && locator.shotId.length > 0;
        const payload = {
          project,
          file,
          episodeNumber: Number(episode),
          pairWithCompanion: true,
          ...(Number.isInteger(locator.blockNumber) ? { blockNumber: locator.blockNumber } : {}),
          ...(byId ? { shotId: locator.shotId } : { index: locator.index }),
          ...(targetRevision === null ? {} : { expectedRevision: targetRevision }),
        };
        let data;
        try {
          data = await callHost(ctx, sessionId, 'delete', payload, folder, { retry: false });
        } catch (error) {
          const staleRevision = error?.hostRejected === true
            && /revision|changed since you read/iu.test(String(error?.message ?? ''));
          if (!staleRevision || !byId) throw error;
          const latest = await callHost(ctx, sessionId, 'read', { file }, folder);
          if (!Number.isInteger(latest.revision) || latest.revision === targetRevision) throw error;
          savedRevisions.current.set(queueKey, latest.revision);
          data = await callHost(ctx, sessionId, 'delete', { ...payload, expectedRevision: latest.revision }, folder, { retry: false });
        }
        if (data.revision !== null && data.revision !== undefined) savedRevisions.current.set(queueKey, data.revision);
        const deletedBlockNumber = Number(data.blockNumber ?? locator.blockNumber);
        shiftShotSourceChoicesAfterDelete(deletedBlockNumber);
        sourceBlockCacheRef.current = {};
        const remaining = Array.isArray(data.shots) ? data.shots.length : 0;
        if (Number.isInteger(deletedBlockNumber) && deletedBlockNumber > 0 && remaining > 0) {
          const focusBlockNumber = Math.min(deletedBlockNumber, remaining);
          pendingFocusedBlockRef.current = {
            blockNumber: focusBlockNumber,
            shotIds: [],
            expectedCount: remaining,
          };
          focusLockUntilRef.current = Date.now() + 5000;
          setFocusedShotKey(`${String(episode)}:${String(focusBlockNumber)}`);
        }
        setReloadKey((value) => value + 1);
        setDrift(false);
        return {
          deletedAt: data.deletedAt,
          blockNumber: Number.isInteger(deletedBlockNumber) ? deletedBlockNumber : null,
          companion: data.companion ?? null,
        };
      }, [ctx, sessionId, currentSource?.path, folder, revision, episode, shiftShotSourceChoicesAfterDelete]);

      // A file with no 大分镜 headings still has content worth showing and editing, so it
      // is presented as one block rather than an empty panel.
      const sourceUnavailable = currentSource?.available === false;
      const blocks = sourceUnavailable && !missingH3Preview
        ? []
        : shots.length > 0
        ? shots
        : (currentSource === undefined ? [] : [{ index: 0, title: displayShotText(currentSource.file), seconds: null, shotCount: 0, text: '' }]);
      const productionForShot = (shot) => {
        if (production === null || shot === undefined || shot === null) return null;
        const rows = production.shots ?? [];
        const identityIds = shotIdentityIds(shot);
        const exactRows = rows.filter((row) => identityIds.has(row.shotId));
        const exact = exactRows.find((row) => row.directIdentity === true)
          ?? exactRows.find((row) => ['running', 'awaiting-review', 'decided', 'ready'].includes(row.state))
          ?? exactRows[0];
        if (exact !== undefined) return exact;
        const blockNumber = Number(shot.sourceNumber);
        if (!Number.isInteger(blockNumber)) return null;
        return rows.find((row) => (typeof row.shotId !== 'string' || row.shotId.length === 0)
          && row.blockNumber === blockNumber
          && (row.episodeNumber === null || row.episodeNumber === Number(episode))) ?? null;
      };
      /**
       * A video generated from the H3 companion is recorded against that H3 document's shotId.
       * The preview belongs to the production 大分镜, so fall back to the explicit episode + block
       * number that the generator stores with every candidate.
       */
      const currentVideoShotTotal = currentSource?.id === 'video' || missingH3Preview
        ? blocks.filter((shot) => Number.isInteger(shot.sourceNumber)).length
        : (Number.isInteger(production?.total) ? production.total : 0);
      const candidateMatchesShot = (row, shot) => {
        if (shotIdentityIds(shot).has(row.shotId)) return true;
        // Once a candidate records an identity, positional fallback is unsafe: inserting a shot
        // changes every later number, and an old clip must move with its block, not stay on the
        // number it used to occupy. Fall back only for legacy results that never recorded one.
        if (typeof row.shotId === 'string' && row.shotId.length > 0) {
          const claimedByAnotherShot = blocks.some((entry) => entry !== shot && shotIdentityIds(entry).has(row.shotId));
          // Older two-file fixtures can know the candidate's H3 identity before the H3 variant
          // has been fetched. With only one shot there is no ambiguity; with multiple shots we
          // wait for the variant map instead of guessing by a shifted block number.
          if (claimedByAnotherShot || blocks.length > 1) return false;
        }
        if (!Number.isInteger(row.blockNumber) || !Number.isInteger(shot.sourceNumber)) return false;
        if (Number(row.episodeNumber) !== Number(episode)) return false;
        // Re-splitting may reduce the block count. Older blocks beyond the new end are folded into
        // the final block instead of disappearing; expanding later leaves the original number alone.
        // Folding an out-of-range block onto the final shot is only safe for a recorded H3
        // identity (the resplit companion case). A legacy row with no shotId is just a number:
        // while the list is temporarily short after an insert, folding block 8 onto block 7 made
        // two clips appear under the wrong preview. Legacy rows must keep exact positional match.
        const hasStableIdentity = typeof row.shotId === 'string' && row.shotId.length > 0;
        const mappedBlock = hasStableIdentity && currentVideoShotTotal > 0
          ? Math.min(row.blockNumber, currentVideoShotTotal)
          : row.blockNumber;
        return mappedBlock === shot.sourceNumber;
      };
      const filterMatches = (state) => shotFilter === 'all'
        || (shotFilter === 'todo' && ['missing-assets', 'needs-attention', 'awaiting-review'].includes(state))
        || shotFilter === state;
      const visibleBlocks = shotFilter === 'all'
        ? blocks
        : blocks.filter((shot) => {
          const status = productionForShot(shot);
          return status !== null && filterMatches(status.state);
        });
      const canGenerateMissingSource = sourceUnavailable
        && currentSource.id === 'h3-zh'
        && typeof sessionId === 'string' && sessionId.length > 0;
      const scriptPromptOptions = scriptPromptSources?.options ?? [];
      const savedScriptPromptId = scriptPromptSources?.selected ?? '';
      const effectiveScriptPromptId = scriptPromptChoice || savedScriptPromptId;
      const promptLabel = (id) => {
        const entry = scriptPromptOptions.find((option) => option.id === id);
        return entry === undefined ? null : (entry.kind === 'custom' ? `自定义 · ${entry.label}` : entry.label);
      };
      const savedScriptPromptLabel = promptLabel(savedScriptPromptId) ?? scriptPromptSources?.selectedLabel ?? '未读取';
      const effectiveScriptPromptLabel = promptLabel(effectiveScriptPromptId) ?? savedScriptPromptLabel;
      const showScriptPromptBar = (currentSource?.id === 'video' || currentSource === undefined) && currentEpisode !== undefined;
      // The project changed, so the library and the ledger both describe something else now.
      React.useEffect(() => {
        if (project.length === 0) return;
        setAssetDetail(null);
        setAssetSummary(null);
        loadAssets(false);
      }, [project, loadAssets]);

      // Opening the asset tab is the user explicitly asking for the asset library, so
      // reconcile the inventory and files then. The background list above is for the
      // @ picker and must stay read-only; this is the scan that makes inventory-only
      // people appear in the asset view.
      React.useEffect(() => {
        if (view === 'assets' && project.length > 0) loadAssets(true);
      }, [view, project, episode, loadAssets]);

      React.useEffect(() => {
        if (view === 'jobs') loadJobs();
        if (view === 'results') loadResults();
        if ((view === 'config' || view === 'generate' || directorMode === 'general')
          && globalConfigData === null && globalConfigBusy === false) loadGlobalConfig();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [view, directorMode, loadJobs, loadResults, loadGlobalConfig]);

      // The workbench preview needs candidates even when the user never opens the 结果 tab.
      // Loading only on that tab made a finished clip look absent from the shot card.
      React.useEffect(() => {
        if (project.length > 0) void loadResults();
      }, [project, loadResults]);

      // Entering a wide workbench is the moment the middle preview becomes visible. Refresh here
      // so a clip that finished while the user was writing elsewhere appears without opening 结果.
      React.useEffect(() => {
        if (wide && project.length > 0) void loadResults();
      }, [wide, project, loadResults]);

      React.useEffect(() => {
        if (project.length === 0) {
          setProduction(null);
          return undefined;
        }
        let cancelled = false;
        const resume = async () => {
          // The ledger may still say queued/running after DSH restarts even when ComfyUI has
          // already finished. Reconcile before the first progress read so the opening view is
          // current, not just later updates.
          await loadJobs({ refresh: true });
          if (cancelled) return;
          await loadProductionProgress();
          if (!cancelled) await loadResults();
        };
        void resume();
        return () => { cancelled = true; };
      }, [project, episode, loadJobs, loadProductionProgress, loadResults]);

      // Resolve references ONCE per block identity, not on every draft edit.
      //
      // `[blocks, ...]` re-ran this whenever any card saved, so each keystroke (via autosave -> a new
      // `blocks` array) restarted resolution for block 0: the asset column flipped to loading and back,
      // which is the flash the user sees every time they touch the prompt. Keyed on the block's own id,
      // it runs when the selection changes and stays put while typing.
      const firstBlockId = blocks.length === 0 ? null : String(blocks[0].shotId ?? `${blocks[0].file}#${blocks[0].index}`);
      React.useEffect(() => {
        if (blocks.length === 0 || project.length === 0 || missingH3Preview) return;
        const first = blocks[0];
        if (first !== undefined) loadReferences(first, first.text);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [firstBlockId, project, loadReferences, missingH3Preview]);

      // General mode opens on its task surface; drama mode keeps the storyboard workbench.
      // The transition is explicit because `script` and `generate` are not interchangeable:
      // one edits prompt files, the other spends GPU time through the global workflows.
      React.useEffect(() => {
        if (directorMode === 'general' && view === 'script') setView('generate');
        if (directorMode === 'drama' && view === 'generate') setView('script');
      }, [directorMode, view]);
      React.useEffect(() => {
        if (wide) setShotFilter('all');
      }, [wide]);

      const modeLabel = directorMode === 'drama'
        ? t('mode.drama')
        : directorMode === 'general' ? t('mode.general') : t('mode.unknown');
      const modeHint = directorMode === 'drama'
        ? t('mode.dramaHint')
        : directorMode === 'general' ? t('mode.generalHint') : '';
      const contextShot = typeof directorContext?.shotId === 'string'
        ? shots.find((shot) => shot.shotId === directorContext.shotId)
        : undefined;
      const currentProjectEntry = (projects ?? []).find((entry) => entry.path === project);
      const workspaceSummary = [
        currentProjectEntry?.name ?? String(project).replace(/\\/gu, '/').split('/').pop(),
        Number.isInteger(Number(episode)) && episode.length > 0 ? `第${String(episode)}集` : '',
        currentSource?.label ?? '',
        contextShot?.title ?? '',
      ].filter((part) => typeof part === 'string' && part.length > 0).join(' · ');
      const visibleTabs = directorMode === 'general'
        ? [['generate', t('view.generate')], ['assets', t('view.assets')], ['results', t('view.results')], ['jobs', t('view.jobs')], ['config', t('view.config')]]
        : [['script', t('view.script')], ['assets', t('view.assets')], ['results', t('view.results')], ['jobs', t('view.jobs')], ['config', t('view.config')]];
      const tabIcons = {
        script: 'clapperboard',
        generate: 'sparkles',
        assets: 'images',
        results: 'gallery-horizontal-end',
        jobs: 'list-checks',
        config: 'settings-2',
      };
      const shotRailKey = (shot) => `${String(episode)}:${String(
        shot?.sourceNumber
        ?? shot?.displayNumber
        ?? (Number.isInteger(shot?.index) ? shot.index + 1 : ''),
      )}`;
      React.useEffect(() => {
        const pending = pendingFocusedBlockRef.current;
        if (pending === null || !Number.isInteger(pending?.blockNumber)) return;
        if (Number.isInteger(pending.expectedCount) && shots.length !== pending.expectedCount) return;
        const target = visibleBlocks.find((shot) => Number(shot.sourceNumber) === pending.blockNumber
          && (pending.shotIds.length === 0 || pending.shotIds.some((shotId) => shotIdentityIds(shot).has(shotId))));
        if (target === undefined) return;
        pendingFocusedBlockRef.current = null;
        focusLockUntilRef.current = Date.now() + 5000;
        setFocusedShotKey(shotRailKey(target));
        const schedule = globalThis.requestAnimationFrame ?? ((callback) => callback());
        const identity = shotCardIdentity(target);
        schedule(() => schedule(() => {
          const feed = dramaEditorFeedRef.current;
          if (feed === null || feed === undefined || typeof feed.querySelectorAll !== 'function') return;
          const section = [...feed.querySelectorAll('[data-dsh-drama-shot-section]')]
            .find((element) => element.getAttribute('data-dsh-drama-shot-section') === identity);
          section?.scrollIntoView?.({ block: 'start' });
        }));
      }, [visibleBlocks, shots.length, episode]);
      const shotCardIdentity = (shot) => shot?.shotId ?? `${shot?.file ?? currentSource?.path ?? ''}#${shot?.index ?? ''}`;
      const shotRenderKey = (shot) => shot?.cardKey
        ?? `${shot?.file ?? currentSource?.path ?? ''}#${shot?.shotId ?? `i${shot?.index ?? 0}`}`;
      const workbenchShot = visibleBlocks.find((shot) => shotRailKey(shot) === focusedShotKey)
        ?? visibleBlocks.find((shot) => typeof directorContext?.shotId === 'string' && shot.shotId === directorContext.shotId)
        ?? visibleBlocks[0]
        ?? null;
      const workbenchUsesH3 = workbenchShot !== null && selectedSourceIdFor(workbenchShot) === 'h3-zh';
      const workbenchH3NeedsCompile = canCompileH3FromVideo
        && workbenchUsesH3
        && (h3MissingBlockNumbers.length > 0 || h3SourceOption?.available === false);
      const inlineSourceSwitchFor = (shot) => {
        if (sourceOptions.length <= 1) return null;
        const selected = selectedSourceIdFor(shot);
        const blockNumber = Number(shot?.sourceNumber ?? shot?.blockNumber);
        const pendingKey = sourceSwitchPending === sourceChoiceKey(blockNumber);
        return h('span', {
          className: 'sdd-inline-source-switch',
          'data-dsh-shot-source-switch': sequenceKeyFor(shot),
          onClick: (event) => event.stopPropagation(),
          onKeyDown: (event) => event.stopPropagation(),
        }, sourceOptions.map((entry) => {
          const variant = shot?.variants?.[entry.id];
          const missing = entry.available === false || variant?.missingH3File === true;
          const active = entry.id === selected;
          return h('button', {
            key: entry.id,
            type: 'button',
            className: active ? 'active' : '',
            'data-dsh-source': entry.id,
            'data-dsh-source-missing': missing ? 'true' : 'false',
            'data-dsh-shot-source': sequenceKeyFor(shot),
            'aria-pressed': active,
            disabled: pendingKey,
            title: missing
              ? `${entry.label}尚未生成；点开后输入或同步即可创建这一镜`
              : entry.label,
            onClick: () => { void switchShotSource(shot, entry.id); },
          },
          h(SddIcon, { name: entry.id === 'video' ? 'clapperboard' : 'languages', size: 11 }),
          pendingKey
            ? '…'
            : missing
              ? `${entry.id === 'video' ? '视频' : 'H3'} · 待生成`
              : (entry.id === 'video' ? '视频' : 'H3'));
        }));
      };
      const inlineSourceSwitch = visibleBlocks.length > 0 ? inlineSourceSwitchFor(visibleBlocks[0]) : null;
      React.useEffect(() => {
        if (!wide || workbenchShot === null) return;
        const container = dramaShotScrollRef.current;
        if (container === null || container === undefined
          || typeof container.querySelectorAll !== 'function') return;
        const active = [...container.querySelectorAll('[data-dsh-drama-shot]')]
          .find((element) => element.getAttribute?.('aria-pressed') === 'true');
        active?.scrollIntoView?.({ block: 'nearest' });
      }, [wide, focusedShotKey, workbenchShot?.shotId, workbenchShot?.index]);
      React.useEffect(() => () => {
        if (dramaScrollFrame.current === null) return;
        globalThis.cancelAnimationFrame?.(dramaScrollFrame.current);
        dramaScrollFrame.current = null;
      }, []);

      const focusWorkbenchShot = (shot, scrollEditor = true) => {
        const number = Number(episode);
        if (!Number.isInteger(number) || number < 1 || currentSource === undefined) return;
        setFocusedShotKey(shotRailKey(shot));
        void recordDirectorContext({
          episodeNumber: number,
          sourceId: currentSource?.id ?? 'video',
          shotId: shot.shotId ?? null,
        });
        if (!scrollEditor) return;
        const feed = dramaEditorFeedRef.current;
        if (feed === null || feed === undefined || typeof feed.querySelectorAll !== 'function') return;
        const section = [...feed.querySelectorAll('[data-dsh-drama-shot-section]')]
          .find((element) => element.getAttribute('data-dsh-drama-shot-section') === shotCardIdentity(shot));
        section?.scrollIntoView?.({ block: 'start' });
      };
      const syncWorkbenchShotFromScroll = () => {
        if (Date.now() < focusLockUntilRef.current) return;
        if (dramaScrollFrame.current !== null) return;
        const schedule = globalThis.requestAnimationFrame ?? ((callback) => callback());
        dramaScrollFrame.current = schedule(() => {
          dramaScrollFrame.current = null;
          const feed = dramaEditorFeedRef.current;
          if (feed === null || feed === undefined || typeof feed.querySelectorAll !== 'function') return;
          const feedTop = feed.getBoundingClientRect().top;
          const sections = [...feed.querySelectorAll('[data-dsh-drama-shot-section]')];
          let nearest = null;
          let distance = Number.POSITIVE_INFINITY;
          for (const section of sections) {
            const nextDistance = Math.abs(section.getBoundingClientRect().top - feedTop);
            if (nextDistance >= distance) continue;
            distance = nextDistance;
            nearest = section;
          }
          if (nearest === null) return;
          const identity = nearest.getAttribute('data-dsh-drama-shot-section');
          if (workbenchShot !== null && shotCardIdentity(workbenchShot) === identity) return;
          const shot = visibleBlocks.find((entry) => shotCardIdentity(entry) === identity);
          if (shot !== undefined) focusWorkbenchShot(shot, false);
        });
      };
      const uploadShotAsset = async ({ kindFilter, fileName, fileDataBase64 }) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'import',
          episodeNumber: Number(episode),
          kindFilter,
          fileName,
          fileDataBase64,
        }, folder);
        if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
        return data.imported === undefined || data.imported === null
          ? null
          : { ...data.imported, binding: data.binding ?? null };
      };
      const pickShotAsset = async ({ assetId, variantName, mediaKind }) => {
        const data = await callHost(ctx, sessionId, 'assets', {
          project,
          assetAction: 'binding',
          episodeNumber: Number(episode),
          assetId,
          variantName,
          mediaKind,
        }, folder);
        if (assetContextRef.current === assetContext && Array.isArray(data.assets)) setAssets(data.assets);
        return data.imported === undefined || data.imported === null
          ? null
          : { ...data.imported, binding: data.binding ?? null };
      };
      const shotCardProps = (shot, detail = false) => ({
        t,
        shot,
        assets,
        mediaUrl,
        previewUrl,
        references: refsByShot[shot.shotId ?? `${shot.file}#${shot.index}`] ?? null,
        onSave: saveShot,
        onDelete: deleteShot,
        onSync: syncH3,
        onGenerate: generateH3,
        onReview: reviewShot,
        settings: (() => {
          const settingsKey = `${project}#${episode}#${shot.sourceNumber}`;
          const base = generationSettings[settingsKey] ?? defaultGenerationSettings(project);
          const sharedAspectRatio = generationAspectRatio[`${project}#${episode}`];
          return sharedAspectRatio === undefined ? base : { ...base, aspectRatio: sharedAspectRatio };
        })(),
        onSettings: (value) => {
          const settingsKey = `${project}#${episode}#${shot.sourceNumber}`;
          setGenerationSettings((previous) => ({ ...previous, [settingsKey]: value }));
          if (typeof value?.aspectRatio === 'string' && value.aspectRatio.length > 0) {
            setGenerationAspectRatio((previous) => ({ ...previous, [`${project}#${episode}`]: value.aspectRatio }));
          }
        },
        modeReady: directorMode === 'drama',
        productionState: productionForShot(shot),
        sourceSwitch: inlineSourceSwitchFor(shot),
        shouldOpen: detail || focusedShotKey === shotRailKey(shot),
        onFocus: () => focusWorkbenchShot(shot),
        onInsert: insertShot,
        onRequestReferences: loadReferences,
        wide: detail,
        onUpload: uploadShotAsset,
        onPickAsset: pickShotAsset,
        candidates: (candidates ?? []).filter((row) => candidateMatchesShot(row, shot)),
        draftKey: {
          project,
          file: shot.file ?? currentSource?.path ?? '',
          shotId: shot.shotId ?? `i${shot.index}`,
        },
      });

      return h('div', {
        className: 'dsh-sdd sdd-fullscreen',
        'data-fullscreen': overlayFullscreen ? 'true' : 'false',
        'data-dsh-workbench-dock': dockedLeft ? 'left' : overlayFullscreen ? 'overlay' : 'sidebar',
        style: {
          ...css.root,
          ...(view === 'script' || view === 'generate' ? {} : { overflowY: 'auto' }),
          // Fullscreen remains a workbench-only layout. The normal left-docked workbench is mounted
          // inside a real split, so the conversation stays visible as a sibling.
          ...(overlayFullscreen ? { position: 'fixed', top: 0, right: 0, bottom: 0, left: 'clamp(280px, 26vw, 460px)', zIndex: 60, padding: '12px 22px 0', background: 'var(--dsw-bg-base, #ffffff)', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' } : {}),
        },
      },
        h('style', { key: 'sdd-visual-system' }, UI_CSS),
        h('div', { className: 'sdd-tabs', style: css.tabs },
          visibleTabs.map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            className: 'sdd-tab',
            'data-active': view === id ? 'true' : 'false',
            style: css.tab(view === id),
            onClick: () => setView(id),
          },
            h(SddIcon, { key: 'icon', name: tabIcons[id] ?? 'circle' }),
            label,
            // A badge is the only thing that says "there is something here you have not looked
            // at". Results get the count of unreviewed candidates, because that is the number
            // that asks for a decision; jobs get a mark only when one needs an action.
            id === 'results' && candidates.some((row) => row.status === 'candidate')
              ? h('span', { className: 'sdd-tab-badge', style: css.tabBadge }, String(candidates.filter((row) => row.status === 'candidate').length))
              : null,
            id === 'jobs' && jobs.some((job) => job.state === 'submission_unknown' || job.state === 'download_failed')
              ? h('span', { className: 'sdd-tab-badge', style: css.tabBadge }, '!')
              : null,
          )),
          // The left dock is already beside a live conversation. Expanding there would hide the
          // pane this layout exists to preserve, so it offers only a close control.
          dockedLeft ? h('button', {
            key: 'close-workbench',
            type: 'button',
            className: 'sdd-tab sdd-workbench-close',
            title: '收起分镜管理',
            'data-dsh-workbench-close': 'true',
            style: { ...css.tab(false), marginLeft: 'auto' },
            onClick: () => {
              if (typeof props.onClose === 'function') props.onClose();
            },
          }, '× 收起') : h('button', {
            key: 'fullscreen',
            type: 'button',
            className: 'sdd-tab sdd-fullscreen-toggle',
            title: fullscreen ? '退出展开' : '展开工作台并保留左侧会话',
            'data-dsh-fullscreen': 'true',
            style: { ...css.tab(false), marginLeft: 'auto' },
            onClick: () => setFullscreen((value) => !value),
          }, fullscreen ? '⤢ 退出展开' : '⤢ 展开工作台'),
        ),
        h('div', {
          'data-dsh-director-mode': directorMode ?? 'unknown',
          'data-mode': directorMode ?? 'unknown',
          className: 'sdd-modebar',
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '7px',
            padding: '7px 9px',
            border: '1px solid var(--dsw-border-default, #e1e5ea)',
            background: 'var(--dsw-surface-subtle, #f7f8fa)',
            fontSize: '11px',
            lineHeight: 1.45,
          },
        },
          h(SddIcon, { name: directorMode === 'drama' ? 'clapperboard' : 'sparkles' }),
          h('strong', { style: { fontSize: '11px' } }, modeLabel),
          h('span', {
            'data-dsh-director-context': workspaceSummary || modeHint,
            className: 'sdd-workspace-summary',
            title: [workspaceSummary, modeHint].filter(Boolean).join(' · '),
            style: { flex: '1 1 180px', fontSize: '10px', color: 'var(--dsw-text-secondary, #687385)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, workspaceSummary || modeHint),
          directorMode === 'drama' || directorMode === 'general'
            ? h('button', {
              type: 'button',
              'data-dsh-mode-switch': directorMode === 'drama' ? 'exit' : 'enter',
              className: 'sdd-mode-switch',
              style: css.button(directorMode !== 'drama'),
              disabled: directorModeBusy,
              onClick: () => { void switchDirectorMode(directorMode === 'drama' ? 'exit' : 'enter'); },
            },
            h(SddIcon, { name: 'repeat-2' }),
            directorModeBusy ? t('mode.switching') : (directorMode === 'drama' ? t('mode.exit') : t('mode.enter')))
            : null,
        ),
        /**
         * Read/write state, stated where it is read.
         *
         * The observed failure was a save refused with `file access denied under workspace-write
         * mode` AFTER 40 KB of edits, reported as 「自动保存失败」: the boundary was real, the
         * moment was wrong, and the words were the filesystem's rather than the user's. Both exits
         * are named here, and the project path is one click away, because the usual fix is "open
         * the session in THIS folder". `writable: null` renders nothing at all - an unverifiable
         * warning is worse than silence.
         */
        writeAccess !== null && writeAccess.writable === false ? h('div', {
          'data-dsh-write-access': String(writeAccess.reason ?? 'unknown'),
          role: 'note',
          className: 'sdd-write-access',
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '7px',
            padding: '7px 9px',
            borderBottom: '1px solid var(--dsw-border-default, #e1e5ea)',
            background: 'var(--dsw-status-warning-bg, #fff8e6)',
            color: 'var(--dsw-status-warning-fg, #7a5b00)',
            fontSize: '11px',
            lineHeight: 1.5,
          },
        },
          h('strong', { style: { flex: 'none' } }, '不能保存'),
          h('span', { style: { flex: '1 1 240px', minWidth: 0 } },
            writeAccess.reason === 'read-only'
              ? '当前会话是「仅可查看」，改动只会留在草稿里。'
              : `这一集不在本会话的工作区里（工作区 ${String(writeAccess.workspaceRoot ?? '未知')}），改动只会留在草稿里。`),
          h('span', { style: { flex: '1 1 240px', fontSize: '10px', opacity: 0.85 } },
            '① 把输入框那一行的「权限」切成「完全权限」后重存　② 或用项目目录新开会话'),
          typeof writeAccess.projectRoot === 'string' && writeAccess.projectRoot.length > 0
            ? h('button', {
              type: 'button',
              className: 'sdd-tab',
              style: css.miniButton,
              'data-dsh-copy-project': 'true',
              onClick: () => {
                void copyText(String(writeAccess.projectRoot)).then((ok) => setWriteAccessNote(ok ? '项目路径已复制' : '复制失败'));
              },
            }, '复制项目路径')
            : null,
          writeAccessNote.length > 0
            ? h('span', { 'data-dsh-write-access-note': 'true', style: { fontSize: '10px', opacity: 0.85 } }, writeAccessNote)
            : null,
        ) : null,
        directorModeError.length > 0 ? h('div', { style: { ...css.error, margin: '6px 9px 0' } }, displayShotText(directorModeError)) : null,
        directorMode === 'general' ? h(GeneralGenerateView, {
          key: 'general-generate',
          t,
          hidden: view !== 'generate',
          data: globalConfigData,
          storageKey: `${folder}|${project}`,
          busy: globalConfigBusy,
          error: globalConfigError,
          note: globalConfigNote,
          projectDefaults: currentProjectEntry?.settings ?? null,
          assets,
          onRefresh: loadGlobalConfig,
          onOpenConfig: () => setView('config'),
          onGenerate: generateGeneral,
          onLoadHistory: loadGeneralHistory,
          onPollJob: pollGeneralJob,
          candidates,
          onOpenResults: () => setView('results'),
          previewUrl,
        }) : null,
        view === 'config' && h(GlobalConfigView, {
          t,
          data: globalConfigData,
          draft: globalConfigDraft,
          setDraft: setGlobalConfigDraft,
          task: globalConfigTask,
          setTask: setGlobalConfigTask,
          videoMode: globalVideoMode,
          setVideoMode: setGlobalVideoMode,
          busy: globalConfigBusy,
          saving: globalConfigSaving,
          error: globalConfigError,
          note: globalConfigNote,
          promptBusy: globalPromptBusy,
          onRefresh: loadGlobalConfig,
          onSave: saveGlobalConfig,
          onUploadPrompt: uploadGlobalPrompt,
          onDeletePrompt: deleteGlobalPrompt,
          onInspectVideoWorkflow: inspectVideoWorkflow,
        }),
        // The project is the context every view shares, so its picker stays visible. Only the
        // body below the tabs swaps.
        view === 'assets' && h(AssetsView, {
          key: assetContext,
          t,
          assets,
          mediaUrl,
          previewUrl,
          busy: assetBusy,
          summary: assetSummary,
          detail: assetDetail,
          episodeAssets: assets.some((asset) => typeof asset.usedInEpisode === 'boolean') ? assets.filter((asset) => asset.usedInEpisode).map((asset) => asset.assetId) : null,
          onOpen: openAsset,
          onBack: () => setAssetDetail(null),
          onRefresh: () => loadAssets(true),
          onCreate: createAsset,
          onAddVariant: addAssetVariant,
          onReplace: replaceAsset,
          onSelectVersion: persistAssetVersionSelection,
          onDeleteAsset: deleteAsset,
          onDeleteVersion: deleteAssetVersionFile,
          onGenerateQuadview: generateAssetQuadview,
          modeReady: directorMode === 'drama',
          onImport: async (payload) => {
            const data = await callHost(ctx, sessionId, 'assets', { project, assetAction: 'import', episodeNumber: Number(episode), ...payload }, folder);
            if (assetContextRef.current === assetContext) setAssets(data.assets ?? []);
            /**
             * Show what the upload created, and close whatever was open before it.
             *
             * An import used to leave the currently open asset detail exactly where it was. Uploading
             * 顾星野's four-view while 灵契锁's card was open therefore left 灵契锁 on screen: the file had
             * landed one category away in 其他参考图片, so the honest reading of the screen was "nothing
             * happened", and the next guess was "it overwrote the wrong asset". Opening the imported
             * asset makes the answer visible; the Host also refuses a same name in another category now.
             */
            const imported = data.imported ?? null;
            setAssetDetail(null);
            if (imported !== null && typeof imported.name === 'string') {
              const row = (data.assets ?? []).find((entry) => entry.name === imported.name && entry.kind === imported.kind);
              if (row !== undefined) await openAsset(row);
            }
            return imported;
          },
        }),

        view === 'jobs' && h(JobsView, { t, jobs, busy: jobsBusy, onRefresh: refreshJobsAndResults }),

        view === 'results' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          // The error row lives here too. A refusal written to a state nobody renders is a button
          // that does nothing, which is exactly how "promote without a destination" first
          // behaved: the message was set, and never shown.
          error.length > 0 ? h('div', { style: css.error }, displayShotText(error)) : null,
          redoPlan !== null ? h('div', { style: css.resultNote },
            h('div', null, t('results.redoReady')),
            redoPlan.workflow === null ? null : h('div', { style: css.resultMeta }, redoPlan.workflow),
            ...redoPlan.inputs.map((line, index) => h('div', { key: index, style: css.resultMeta }, line)),
          ) : null,
          h(ResultsView, {
            t,
            candidates,
            stats: resultStats,
            mediaUrl,
            previewUrl,
            busy: resultsBusy,
            busyId: busyCandidate,
            onRefresh: loadResults,
            onSelect: selectCandidate,
            onPromote: promoteCandidate,
            onPrune: pruneResults,
            onUndoPrune: undoPruneResults,
            onRedo: redoCandidate,
          }),
        ),

        view === 'script' && h('div', { className: 'sdd-script-view', style: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflow: 'hidden', gap: '7px' } },
        picking && h('div', { className: 'sdd-picker', style: css.picker },
          h('div', { style: css.pickerBar },
            h('button', {
              type: 'button',
              style: css.button(listing?.parent ? true : false),
              disabled: !listing?.parent,
              onClick: () => listing?.parent && browseTo(listing.parent),
            }, t('pick.up')),
            h('span', { style: css.pickerPath, title: listing?.path ?? folder }, listing?.path ?? folder),
          ),
          (listing?.directories ?? []).length === 0 && h('div', { style: css.note }, t('pick.none')),
          h('div', { style: css.pickerList }, (listing?.directories ?? []).map((row) => h('div', {
            key: row.path,
            style: css.pickerRow(row.isProject),
          },
            h('button', {
              type: 'button',
              style: css.pickerName,
              title: row.path,
              onClick: () => {
                // Choosing a folder that holds 剧集/ IS the choice; anything else is a
                // step down into it.
                if (row.isProject) {
                  setPicking(false);
                  loadProjects(row.path);
                } else {
                  browseTo(row.path);
                }
              },
            }, `${row.isProject ? '▣ ' : '▸ '}${row.name}`),
            row.isProject && h('span', { style: css.pickerTag }, t('pick.isProject')),
          ))),
          h('div', { style: css.cardFoot },
            h('button', {
              type: 'button',
              style: css.button(true),
              onClick: () => {
                setPicking(false);
                loadProjects(listing?.path ?? folder);
              },
            }, t('pick.useThis')),
          ),
        ),
        h('section', { className: 'sdd-context-grid' },
        h('div', { className: 'sdd-control-row sdd-folder-control', style: css.row },
          h('span', { style: css.label }, t('pick.folder')),
          h('button', {
            type: 'button',
            style: css.button(false),
            title: folder.length > 0 ? folder : undefined,
            'aria-label': folder.length > 0 ? `${t('pick.folder')}: ${folder}` : t('pick.folder'),
            onClick: () => {
              const next = !picking;
              setPicking(next);
              if (next) browseTo(folder);
            },
          }, picking ? t('pick.close') : t('pick.choose')),
        ),
        h('div', { className: 'sdd-control-row', style: css.row },
          h('span', { style: css.label }, t('pick.project')),
          h('select', {
            style: css.select,
            value: project,
            title: activeProject.length > 0 ? `${t('mode.projectSynced')}: ${activeProject}` : undefined,
            onChange: (event) => chooseProject(event.target.value),
          }, (projects ?? []).length === 0
            ? h('option', { value: '' }, t('empty.projects'))
            // The label, not the name, whenever they differ: two projects can share a title, and an
            // option list showing `送错的外卖` twice gives the user no way to pick the right one.
            : (projects ?? []).map((entry) => h('option', { key: entry.path, value: entry.path },
              entry.label !== undefined && entry.label !== entry.name ? `${entry.name}  (${entry.label})` : entry.name))),
          h('button', {
            type: 'button',
            className: 'sdd-create-inline-button',
            'data-dsh-project-create-open': 'true',
            onClick: () => {
              setContextNote('');
              setProjectCreateOpen(true);
            },
          }, h(SddIcon, { name: 'plus', size: 13 }), '新建项目'),
          h('button', {
            type: 'button',
            className: 'sdd-create-inline-button',
            'data-dsh-project-delete-open': 'true',
            disabled: project.length === 0,
            title: project.length === 0 ? '先选择一个项目' : `删除项目：${project}`,
            onClick: () => {
              setContextNote('');
              setProjectDeleteOpen(true);
            },
          }, h(SddIcon, { name: 'trash-2', size: 13 }), '删除项目'),
        ),
        h('div', { className: 'sdd-control-row', style: css.row },
          h('span', { style: css.label }, t('pick.episode')),
          h('select', {
            style: css.select,
            value: episode,
            'data-dsh-episode-select': 'true',
            onChange: (event) => {
              if (event.target.value === '__new_episode__') {
                setContextNote('');
                setEpisodeCreateOpen(true);
                return;
              }
              chooseEpisode(event.target.value);
            },
          },
          episodes.length === 0 ? h('option', { value: '' }, '暂无集数') : null,
          episodes.map((entry) => h('option', { key: entry.number, value: String(entry.number) }, `第${entry.number}集`)),
          h('option', {
            value: '__new_episode__',
            'data-dsh-episode-add-option': 'true',
            disabled: project.length === 0,
          }, '＋ 新增集数')),
        ),
        contextNote.length > 0 ? h('div', { className: 'sdd-context-note', role: 'status' }, contextNote) : null,
        ),
        currentEpisode === undefined || wide ? null : h(EpisodeProductionBar, {
          data: production,
          busy: productionBusy,
          error: productionError,
          filter: shotFilter,
          onFilter: (id) => {
            setShotFilter(id);
            setFocusedShotKey(null);
          },
          onFocusShot: (row) => {
            setShotFilter(row.state);
            setFocusedShotKey(`${String(row.episodeNumber ?? episode)}:${String(row.blockNumber ?? row.displayNumber ?? '')}`);
            if (currentSource?.id !== 'video') setSourceId('video');
            const number = Number(row.episodeNumber ?? episode);
            if (Number.isInteger(number) && number > 0) {
              void recordDirectorContext({
                episodeNumber: number,
                sourceId: 'video',
                shotId: row.shotId ?? null,
              });
            }
          },
          onRefresh: () => { void loadProductionProgress(); },
        }),
        showScriptPromptBar && h('section', {
          'data-dsh-script-prompt-bar': 'true',
          className: 'sdd-promptbar',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            padding: '8px',
            border: '1px solid var(--dsw-border-default, #d0d5dd)',
            borderRadius: '6px',
            background: 'var(--dsw-bg-base, #fff)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
            h('strong', { style: { fontSize: '11px' } }, '剧本转提示词'),
            h('span', { 'data-dsh-script-prompt-current': 'true', style: { fontSize: '10px', opacity: 0.72 } },
              `当前使用：${savedScriptPromptLabel}`),
            h('select', {
              'data-dsh-script-prompt-select': 'true',
              'aria-label': '重新拆分镜使用的提示词版本',
              value: effectiveScriptPromptId,
              disabled: scriptPromptBusy || scriptPromptOptions.length === 0 || resplitBusy,
              onChange: (event) => {
                setScriptPromptChoice(event.target.value);
                setResplitConfirm(false);
                setResplitNote('');
                setScriptPromptError('');
              },
              style: { ...css.select, flex: '1 1 190px', minWidth: 0, width: '100%', boxSizing: 'border-box' },
            },
              scriptPromptOptions.length === 0
                ? h('option', { value: '' }, scriptPromptBusy ? '读取中…' : '没有识别到提示词版本')
                : null,
              scriptPromptOptions.map((entry) => h('option', {
                key: entry.id,
                value: entry.id,
              }, entry.kind === 'custom' ? `自定义 · ${entry.label}` : entry.label))),
            h('button', {
              type: 'button',
              'data-dsh-resplit': 'true',
              style: css.button(false),
              disabled: resplitBusy || scriptHostReady !== true || scriptPromptOptions.length === 0 || typeof currentEpisode?.script !== 'string' || directorMode !== 'drama',
              onClick: () => {
                setScriptPromptError('');
                setResplitNote('');
                setResplitConfirm(true);
              },
            }, '重新拆分镜'),
            h('button', {
              type: 'button',
              'data-dsh-script-refresh': 'true',
              style: css.button(false),
              disabled: busy || resplitBusy,
              onClick: () => setReloadKey((value) => value + 1),
            }, '刷新分镜')),
          effectiveScriptPromptId !== savedScriptPromptId
            ? h('div', { style: { fontSize: '10px', color: 'var(--sdd-warning)' } },
              `重新拆分将改用：${effectiveScriptPromptLabel}`)
            : null,
          scriptPromptError.length > 0 ? h('div', { style: css.error }, displayShotText(scriptPromptError)) : null,
          resplitConfirm && h('div', {
            'data-dsh-resplit-confirm': 'true',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '8px',
              border: '1px solid color-mix(in srgb, var(--sdd-warning) 58%, var(--sdd-border))',
              borderRadius: '5px',
              background: 'color-mix(in srgb, var(--sdd-warning) 10%, var(--sdd-surface))',
              fontSize: '11px',
              lineHeight: 1.55,
            },
          },
            h('strong', null, `确认按「${effectiveScriptPromptLabel}」重新拆分第${episode}集？`),
            h('span', null, `会重新生成并覆盖 剧集/第${episode}集/第${episode}集视频提示词.txt，再重建分大镜文件。未保存的编辑可能丢失。`),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', {
                type: 'button',
                'data-dsh-resplit-confirm-button': 'true',
                style: css.button(true),
                disabled: resplitBusy || scriptHostReady !== true || directorMode !== 'drama',
                onClick: () => { void resplitEpisode(); },
              }, resplitBusy ? '提交中…' : '确认重新拆分'),
              h('button', {
                type: 'button',
                style: css.button(false),
                disabled: resplitBusy,
                onClick: () => setResplitConfirm(false),
              }, '取消'))),
          resplitNote.length > 0 ? h('div', { 'data-dsh-resplit-note': 'true', style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, resplitNote) : null),
        sourceUnavailable && h('section', {
          'data-dsh-missing-source': currentSource.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: '6px',
            minHeight: '28px',
          },
        },
          !missingH3Preview || visibleBlocks.length === 0 ? inlineSourceSwitch : null,
          canGenerateMissingSource && h('button', {
            type: 'button',
            'data-dsh-generate-source': currentSource.id,
            style: css.miniButton,
            disabled: sourceGenerateBusy || busy || directorMode !== 'drama',
            onClick: () => { void generateMissingSource(); },
          }, h(SddIcon, { name: sourceGenerateBusy ? 'loader-circle' : 'languages', size: 12 }), sourceGenerateBusy ? '生成中…' : '生成中文 H3'),
          sourceGenerateError.length > 0 ? h('div', { style: css.error }, displayShotText(sourceGenerateError)) : null,
          sourceGenerateNote.length > 0 ? h('div', { style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, displayShotText(sourceGenerateNote)) : null),
        workbenchH3NeedsCompile && h('section', {
          'data-dsh-h3-missing-blocks': h3MissingBlockNumbers.join(','),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            padding: '9px',
            border: '1px solid color-mix(in srgb, var(--sdd-warning) 58%, var(--sdd-border))',
            borderRadius: '6px',
            background: 'color-mix(in srgb, var(--sdd-warning) 8%, var(--sdd-surface))',
          },
        },
          h('strong', { style: { fontSize: '11px' } },
            h3MissingBlockNumbers.length > 0
              ? `H3 缺少 ${String(h3MissingBlockNumbers.length)} 个分镜`
              : '中文 H3 尚未生成'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
            h('button', {
              type: 'button',
              'data-dsh-generate-source': 'h3-zh',
              style: css.miniButton,
              disabled: sourceGenerateBusy || directorMode !== 'drama',
              onClick: () => { void generateMissingSource(); },
            }, sourceGenerateBusy ? '编译中…' : '生成中文 H3'),
            h('button', {
              type: 'button',
              'data-dsh-recompile-h3': 'true',
              style: { ...css.button(true), alignSelf: 'flex-start' },
              disabled: sourceGenerateBusy || directorMode !== 'drama',
              onClick: () => {
                setSourceGenerateError('');
                setSourceGenerateNote('');
                setH3CompileConfirm(true);
              },
            }, sourceGenerateBusy ? '编译中…' : '补齐中文 H3')),
          h3CompileConfirm ? h('div', {
            'data-dsh-recompile-h3-confirm': 'true',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '8px',
              border: '1px solid color-mix(in srgb, var(--sdd-warning) 58%, var(--sdd-border))',
              borderRadius: '5px',
              background: 'var(--sdd-surface)',
              fontSize: '11px',
            },
          },
            h('span', null, h3MissingBlockNumbers.length > 0
              ? `将只为缺少的第 ${h3MissingBlockNumbers.join('、')} 分镜生成 H3，不会覆盖已有 H3。`
              : '将从当前视频提示词生成中文 H3。已有 H3 不会被覆盖。'),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', {
                type: 'button',
                'data-dsh-recompile-h3-confirm-button': 'true',
                style: css.button(true),
                disabled: sourceGenerateBusy,
                onClick: () => { void generateMissingSource(); },
              }, sourceGenerateBusy ? '编译中…' : '确认补齐'),
              h('button', {
                type: 'button',
                style: css.button(false),
                disabled: sourceGenerateBusy,
                onClick: () => setH3CompileConfirm(false),
              }, '取消'))) : null,
          sourceGenerateError.length > 0 ? h('div', { style: css.error }, displayShotText(sourceGenerateError)) : null,
          sourceGenerateNote.length > 0 ? h('div', { style: { ...css.note, color: 'var(--sdd-success, #1f7a45)' } }, displayShotText(sourceGenerateNote)) : null),
        error.length > 0 && h('div', { style: css.error }, displayShotText(error)),
        busy && h('div', { style: css.note }, t('loading')),
        projects !== null && projects.length === 0 && error.length === 0 && h('div', { className: 'sdd-empty', style: { ...css.note, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '9px' } },
          h('span', null, t('empty.projects')),
          h('button', {
            type: 'button',
            className: 'sdd-create-inline-button',
            'data-dsh-project-create-open': 'true',
            onClick: () => setProjectCreateOpen(true),
          }, h(SddIcon, { name: 'plus', size: 13 }), '新建项目')),
        projects !== null && projects.length > 0 && episodes.length === 0 && !busy && h('div', { className: 'sdd-empty', style: css.note }, t('empty.episodes')),
        blocks.length > 0 && (wide
          ? h('div', {
            className: 'sdd-drama-stage',
            'data-dsh-drama-workbench': 'true',
            style: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '7px' },
          },
            drift && h('div', { style: css.drift }, t('drift')),
            h('div', { className: 'sdd-drama-workbench' },
              h('aside', { className: 'sdd-drama-rail', 'data-dsh-drama-rail': 'true' },
                h('section', {
                  className: 'sdd-drama-rail-section sdd-drama-shots',
                  'data-dsh-drama-shot-rail': 'true',
                },
                  h('div', { className: 'sdd-drama-section-head' },
                    h('div', null,
                      h(SddIcon, { name: 'clapperboard' }),
                      h('strong', null, '分镜')),
                    h('button', {
                      type: 'button',
                      className: 'sdd-icon-button',
                      title: '刷新制作进度',
                      'aria-label': '刷新制作进度',
                      disabled: productionBusy,
                      onClick: () => { void loadProductionProgress(); },
                    }, h(SddIcon, { name: productionBusy ? 'loader-circle' : 'refresh-cw' }))),
                  h('label', { className: 'sdd-drama-shot-select' },
                    h(SddIcon, { name: 'list-checks' }),
                    h('select', {
                      value: workbenchShot === null ? '' : shotCardIdentity(workbenchShot),
                      'data-dsh-drama-shot-select': 'true',
                      'aria-label': '切换分镜',
                      disabled: visibleBlocks.length === 0,
                      onChange: (event) => {
                        const next = visibleBlocks.find((shot) => shotCardIdentity(shot) === event.target.value);
                        if (next !== undefined) focusWorkbenchShot(next);
                      },
                    },
                    visibleBlocks.length === 0 ? h('option', { value: '' }, '没有分镜') : null,
                    visibleBlocks.map((shot) => h('option', {
                      key: shotCardIdentity(shot),
                      value: shotCardIdentity(shot),
                    }, `分镜 ${String(shot.sourceNumber ?? shot.displayNumber ?? shot.index + 1)} · ${
                      SHOT_STATE_LABELS[productionForShot(shot)?.state] ?? '未检查'
                    }`)))),
                  h('div', {
                    ref: dramaShotScrollRef,
                    className: 'sdd-drama-shot-scroll',
                    'data-dsh-drama-shot-scroll': 'true',
                    tabIndex: 0,
                  },
                    shots.length === 0 && h('div', { className: 'sdd-empty', style: css.note }, t('empty.shots')),
                    blocks.length > 0 && visibleBlocks.length === 0
                      ? h('div', { 'data-dsh-production-empty': shotFilter, className: 'sdd-empty', style: css.note }, '这个筛选下没有镜头')
                      : null,
                    visibleBlocks.map((shot) => {
                      const state = productionForShot(shot);
                      const selected = workbenchShot !== null && shotCardIdentity(workbenchShot) === shotCardIdentity(shot);
                      const number = shot.sourceNumber ?? shot.displayNumber ?? shot.index + 1;
                      return h('button', {
                        key: shotCardIdentity(shot),
                        type: 'button',
                        className: selected ? 'sdd-drama-shot active' : 'sdd-drama-shot',
                        'data-dsh-drama-shot': shotCardIdentity(shot),
                        'data-dsh-shot-status': state?.state ?? 'unknown',
                        'aria-pressed': selected,
                        title: `分镜 ${String(number)} · ${SHOT_STATE_LABELS[state?.state] ?? '未检查'}`,
                        onClick: () => focusWorkbenchShot(shot),
                      },
                        h('span', { className: 'sdd-drama-shot-number' }, String(number)),
                        h('span', { className: 'sdd-drama-shot-label' }, '分镜'),
                        h('span', {
                          className: 'sdd-drama-shot-dot',
                          style: { background: SHOT_STATE_COLORS[state?.state] ?? 'var(--sdd-muted)' },
                        }));
                    }))),
              ),
              h('section', {
                className: 'sdd-drama-editor',
                'data-dsh-drama-editor': 'true',
              },
                h('div', { className: 'sdd-drama-editor-bar' },
                  h('div', null,
                    h(SddIcon, { name: 'monitor-play' }),
                    h('span', null, '编辑台'),
                    h('strong', null, workbenchShot?.title ?? '未选择镜头')),
                  workbenchShot === null ? null : (() => {
                    const state = productionForShot(workbenchShot);
                    if (state === null) return null;
                    return h('span', {
                      className: 'sdd-status',
                      role: 'status',
                      'data-dsh-drama-editor-status': state.state,
                      'data-dsh-shot-status': state.state,
                      title: state.reason ?? '',
                    }, SHOT_STATE_LABELS[state.state] ?? state.state);
                  })()),
                h('div', {
                  ref: dramaEditorFeedRef,
                  className: 'sdd-drama-editor-feed',
                  'data-dsh-drama-editor-feed': 'true',
                  onScroll: syncWorkbenchShotFromScroll,
                },
                visibleBlocks.length === 0
                  ? h('div', { className: 'sdd-empty', style: css.note }, '这个筛选下没有镜头')
                  : visibleBlocks.map((shot) => h('section', {
                    key: `section:${shotRenderKey(shot)}`,
                    className: 'sdd-drama-shot-section',
                    'data-dsh-drama-shot-section': shotCardIdentity(shot),
                  }, h(ShotCard, {
                    key: shotRenderKey(shot),
                    ...shotCardProps(shot, true),
                  })))))))
          : h('div', {
            style: { ...css.list, flexBasis: 0 },
            'data-dsh-shot-list': 'true',
            className: 'sdd-shot-list',
          },
            drift && h('div', { style: css.drift }, t('drift')),
            shots.length === 0 && h('div', { className: 'sdd-empty', style: css.note }, t('empty.shots')),
            blocks.length > 0 && visibleBlocks.length === 0
              ? h('div', { 'data-dsh-production-empty': shotFilter, className: 'sdd-empty', style: css.note }, '这个筛选下没有镜头')
              : null,
            visibleBlocks.map((shot) => h(ShotCard, {
              key: shotRenderKey(shot),
              ...shotCardProps(shot, false),
            })),
          )),
        ),
        projectCreateOpen && h(ProjectCreateDialog, {
          root: folder,
          onClose: () => setProjectCreateOpen(false),
          onCreate: createProject,
        }),
        projectDeleteOpen && h(ProjectDeleteDialog, {
          project,
          onClose: () => setProjectDeleteOpen(false),
          onDelete: deleteProject,
        }),
        episodeCreateOpen && h(EpisodeCreateDialog, {
          defaultNumber: Math.max(0, ...episodes.map((entry) => Number(entry.number) || 0)) + 1,
          onClose: () => setEpisodeCreateOpen(false),
          onCreate: createEpisode,
        }),
      );
    }

    /**
     * Shared open state for two sibling slots: the left panel list and the shell overlay.
     *
     * Keeping the default `main` entry selected would cover the conversation. Replacing it would
     * unmount the conversation. The only layout that satisfies both is to leave conversation in
     * `main`, dock the workbench through the shell overlay, and reserve its width on the main column.
     */
    const workbenchOverlay = (() => {
      let open = false;
      const listeners = new Set();
      const setOpen = (next) => {
        const value = next === true;
        if (value === open) return;
        open = value;
        for (const listener of [...listeners]) listener();
      };
      return {
        get open() { return open; },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        setOpen,
        toggle() { setOpen(!open); },
      };
    })();
    const useWorkbenchLayoutEffect = typeof React.useLayoutEffect === 'function'
      ? React.useLayoutEffect
      : React.useEffect;

    function useWorkbenchOverlayOpen() {
      const [open, setOpen] = React.useState(workbenchOverlay.open);
      React.useEffect(() => {
        const sync = () => setOpen(workbenchOverlay.open);
        sync();
        return workbenchOverlay.subscribe(sync);
      }, []);
      return open;
    }

    const WORKBENCH_SPLIT_KEY = 'dsh-short-drama-workbench-split-v1';
    function readWorkbenchSplitRatio() {
      try {
        const value = Number(globalThis.localStorage?.getItem(WORKBENCH_SPLIT_KEY));
        return Number.isFinite(value) && value >= 0.25 && value <= 0.82 ? value : null;
      } catch {
        return null;
      }
    }
    function saveWorkbenchSplitRatio(value) {
      try {
        if (value === null) globalThis.localStorage?.removeItem(WORKBENCH_SPLIT_KEY);
        else globalThis.localStorage?.setItem(WORKBENCH_SPLIT_KEY, String(value));
      } catch { /* storage can be unavailable without breaking resizing */ }
    }

    /** Split the available center column while keeping both sides above their practical minima. */
    function workbenchSplitGeometry(width, preferredRatio = null) {
      const available = Math.max(0, Number(width) || 0);
      const idealConversation = Math.min(640, Math.max(320, Math.round(available * 0.38)));
      const minimumWorkbench = Math.min(420, Math.max(280, Math.round(available * 0.55)));
      const minimumPanelWidth = Math.min(420, Math.max(280, Math.round(available * 0.42)));
      const minimumConversationWidth = Math.min(420, Math.max(280, Math.round(available * 0.28)));
      const maximumPanelWidth = Math.max(minimumPanelWidth, available - minimumConversationWidth);
      const defaultPanelWidth = Math.max(0, Math.min(available, available - idealConversation));
      const panelWidth = Number.isFinite(preferredRatio)
        ? Math.max(minimumPanelWidth, Math.min(maximumPanelWidth, Math.round(available * preferredRatio)))
        : Math.max(minimumPanelWidth, Math.min(maximumPanelWidth, defaultPanelWidth));
      return {
        available,
        minimumPanelWidth,
        maximumPanelWidth,
        panelWidth: Math.min(available, panelWidth),
        conversationWidth: Math.max(0, available - Math.min(available, panelWidth)),
      };
    }

    /**
     * A transient `main` entry exists only so the left panel id is a valid global panel selection.
     * It immediately returns to the conversation and opens the dock in the shell overlay instead.
     */
    function WorkbenchRoute({ ctx }) {
      useWorkbenchLayoutEffect(() => {
        if (typeof ctx?.layout?.selectPanel === 'function') ctx.layout.selectPanel(null);
        workbenchOverlay.setOpen(true);
      }, [ctx]);
      return h('div', {
        'data-dsh-workbench-opening': 'true',
        style: { padding: '18px', fontSize: '12px', color: 'var(--dsw-text-secondary, #687385)' },
      }, '正在打开分镜管理…');
    }

    /**
     * Left-docked workbench. The overlay itself is narrow, and the conversation's center column is
     * padded by the same width while open, so the chat is resized rather than covered.
     */
    function WorkbenchOverlay(props) {
      const open = useWorkbenchOverlayOpen();
      const activePanelId = typeof props.usePanelInfo === 'function'
        ? props.usePanelInfo((info) => info?.activePanelId ?? null)
        : null;
      const [frame, setFrame] = React.useState(null);
      const [resizing, setResizing] = React.useState(false);
      const resizeRef = React.useRef(false);
      const ratioRef = React.useRef(readWorkbenchSplitRatio());
      const applyRef = React.useRef(() => {});
      const bodyStyleRef = React.useRef(null);

      React.useEffect(() => {
        if (activePanelId !== null && activePanelId !== PANEL_ID) workbenchOverlay.setOpen(false);
      }, [activePanelId]);

      useWorkbenchLayoutEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const anchor = document.querySelector('[data-slot="main"]');
        const column = anchor?.parentElement;
        if (column === null || column === undefined) return undefined;
        const previous = {
          paddingLeft: column.style.paddingLeft,
          boxSizing: column.style.boxSizing,
          transition: column.style.transition,
        };
        let timer = null;
        let observer = null;
        let moveFrame = null;
        let pendingX = null;
        let disposed = false;
        const write = (ratio) => {
          if (disposed) return;
          const rect = column.getBoundingClientRect();
          const geometry = workbenchSplitGeometry(rect.width, ratio);
          column.style.boxSizing = 'border-box';
          column.style.transition = resizeRef.current
            ? 'none'
            : (previous.transition || 'padding-left 160ms cubic-bezier(.2,.8,.2,1)');
          column.style.paddingLeft = `${geometry.panelWidth}px`;
          column.setAttribute('data-sdd-workbench-host', 'true');
          document.documentElement.setAttribute('data-sdd-workbench-open', 'true');
          setFrame({
            left: rect.left,
            top: rect.top,
            width: geometry.panelWidth,
            height: rect.height,
            panelRatio: geometry.available > 0 ? geometry.panelWidth / geometry.available : null,
          });
        };
        applyRef.current = write;
        const apply = () => {
          timer = null;
          write(ratioRef.current);
        };
        const schedule = () => {
          if (timer !== null || disposed) return;
          timer = globalThis.setTimeout(apply, 0);
        };
        const flushMove = () => {
          moveFrame = null;
          if (!resizeRef.current || disposed || pendingX === null) return;
          const clientX = pendingX;
          pendingX = null;
          const rect = column.getBoundingClientRect();
          const geometry = workbenchSplitGeometry(rect.width);
          const panelWidth = Math.max(
            geometry.minimumPanelWidth,
            Math.min(geometry.maximumPanelWidth, Math.round(clientX - rect.left)),
          );
          const ratio = rect.width > 0 ? panelWidth / rect.width : null;
          ratioRef.current = ratio;
          write(ratio);
        };
        const move = (event) => {
          if (!resizeRef.current || disposed) return;
          event.preventDefault();
          pendingX = event.clientX;
          if (moveFrame !== null) return;
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            moveFrame = window.requestAnimationFrame(flushMove);
          } else {
            flushMove();
          }
        };
        const restoreBodyStyle = () => {
          const previousBody = bodyStyleRef.current;
          if (previousBody === null || typeof document === 'undefined') return;
          document.body.style.cursor = previousBody.cursor;
          document.body.style.userSelect = previousBody.userSelect;
          bodyStyleRef.current = null;
        };
        const finish = () => {
          if (!resizeRef.current) return;
          if (moveFrame !== null && typeof window !== 'undefined'
            && typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(moveFrame);
          }
          moveFrame = null;
          if (pendingX !== null) flushMove();
          resizeRef.current = false;
          setResizing(false);
          restoreBodyStyle();
          column.style.transition = previous.transition;
          saveWorkbenchSplitRatio(ratioRef.current);
        };
        apply();
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule);
          observer.observe(column);
          schedule();
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('resize', schedule);
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', finish);
          window.addEventListener('pointercancel', finish);
        }
        return () => {
          disposed = true;
          applyRef.current = () => {};
          resizeRef.current = false;
          if (observer !== null) observer.disconnect();
          if (typeof window !== 'undefined') {
            window.removeEventListener('resize', schedule);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', finish);
          }
          if (moveFrame !== null && typeof window !== 'undefined'
            && typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(moveFrame);
          }
          if (timer !== null) globalThis.clearTimeout(timer);
          restoreBodyStyle();
          column.style.paddingLeft = previous.paddingLeft;
          column.style.boxSizing = previous.boxSizing;
          column.style.transition = previous.transition;
          column.removeAttribute('data-sdd-workbench-host');
          document.documentElement.removeAttribute('data-sdd-workbench-open');
        };
      }, [open]);

      const beginResize = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        resizeRef.current = true;
        setResizing(true);
        if (typeof document !== 'undefined') {
          bodyStyleRef.current = {
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }
        try {
          event.currentTarget?.setPointerCapture?.(event.pointerId);
        } catch { /* pointer capture is an enhancement */ }
      };

      const resizeFromKeyboard = (event) => {
        if (typeof document === 'undefined') return;
        const column = document.querySelector('[data-slot="main"]')?.parentElement;
        if (column === null || column === undefined) return;
        const rect = column.getBoundingClientRect();
        const geometry = workbenchSplitGeometry(rect.width, ratioRef.current);
        let panelWidth = frame?.width ?? geometry.panelWidth;
        if (event.key === 'ArrowLeft') panelWidth -= 24;
        else if (event.key === 'ArrowRight') panelWidth += 24;
        else if (event.key === 'Home') panelWidth = geometry.minimumPanelWidth;
        else if (event.key === 'End') panelWidth = geometry.maximumPanelWidth;
        else return;
        event.preventDefault();
        panelWidth = Math.max(geometry.minimumPanelWidth, Math.min(geometry.maximumPanelWidth, panelWidth));
        const ratio = rect.width > 0 ? panelWidth / rect.width : null;
        ratioRef.current = ratio;
        applyRef.current(ratio);
        saveWorkbenchSplitRatio(ratio);
      };

      const resetSplit = (event) => {
        event.preventDefault();
        ratioRef.current = null;
        applyRef.current(null);
        saveWorkbenchSplitRatio(null);
      };

      if (!open) return null;
      return h('div', {
        className: 'sdd-workbench-overlay',
        'data-dsh-workbench-overlay': 'true',
        'data-resizing': resizing ? 'true' : 'false',
        role: 'region',
        'aria-label': '分镜管理',
        style: frame === null
          ? { position: 'fixed', top: 0, bottom: 0, left: 'clamp(264px, 22vw, 420px)', right: '38%', zIndex: 55, pointerEvents: 'auto' }
          : { position: 'fixed', top: frame.top, left: frame.left, width: frame.width, height: frame.height, zIndex: 55, pointerEvents: 'auto' },
      }, h(StoryboardPanel, {
        ...props,
        ctx: props.ctx,
        t: props.t,
        wide: true,
        dockedLeft: true,
        onClose: () => workbenchOverlay.setOpen(false),
      }), h('div', {
        key: 'resizer',
        className: 'sdd-workbench-resizer',
        'data-dsh-workbench-resizer': 'true',
        role: 'separator',
        tabIndex: 0,
        title: '拖动调节分镜管理与会话宽度；双击恢复默认',
        'aria-label': '调节分镜管理与会话宽度',
        'aria-orientation': 'vertical',
        'aria-valuemin': 25,
        'aria-valuemax': 82,
        'aria-valuenow': frame?.panelRatio === null || frame?.panelRatio === undefined
          ? undefined
          : Math.round(frame.panelRatio * 100),
        onPointerDown: beginResize,
        onDoubleClick: resetSplit,
        onKeyDown: resizeFromKeyboard,
      }));
    }

    function WorkbenchPanelEntry(props) {
      const open = useWorkbenchOverlayOpen();
      return h('span', {
        'data-dsh-workbench-entry': PANEL_ID,
        'data-open': open ? 'true' : 'false',
        role: 'presentation',
        title: props.t('entry.label'),
        style: { fontSize: '16px', lineHeight: 1 },
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof props.ctx?.layout?.selectPanel === 'function') props.ctx.layout.selectPanel(null);
          workbenchOverlay.toggle();
        },
      }, '▤');
    }

    return {
      // `sessions` is here for the WORKBENCH. A `main`-slot panel is not session-scoped, so it has no
      // session id of its own and asks the sessions service for one. Without this entry the service is
      // absent from `ctx`, every probe returned undefined, and the workbench could only say
      // 「需要在一个会话里打开」 - which is exactly what happened for three rounds of guessing at
      // `uiWorkspace.mainSessionId` and friends: the API was never the problem, the injection was.
      inject: ['slots', 'layout', 'locale', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, COPY), 'storyboard: copy');

        /**
         * The LEFT-hand entry keeps the conversation in `main` and docks the workbench through
         * `shell.overlay`. The transient `main` registration exists only to make the panel id valid
         * for the sidebar's selection contract; it immediately returns to the conversation and opens
         * the overlay. The right-sidebar tab is intentionally not registered.
         */
        try {
          ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: PANEL_ID,
            order: 60,
          }, (props) => h(WorkbenchOverlay, { ...props, ctx, t }))), 'storyboard: dock overlay');
          ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, (props) => h(WorkbenchRoute, { ...props, ctx }))), 'storyboard: workbench route');
          ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            locale: NS,
            label: () => t('entry.label'),
          }, (props) => h(WorkbenchPanelEntry, { ...props, ctx, t }))), 'storyboard: panel entry');
        } catch (error) {
          console.warn('short-drama: the left workbench slots are not available in this build; the panel has no UI entry', error);
        }
      },
    };
  },
});
