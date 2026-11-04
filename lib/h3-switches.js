/**
 * Reference-group switches of the YZ H3 workflow.
 *
 * The workflow carries `忽略多组孤海` nodes from Goohaitools-comfyui. Each one is a
 * panel that filters the canvas groups by a keyword and holds a per-group toggle in
 * its own `properties.guhai_ig_active_set`. Toggling a row OFF makes the frontend set
 * `mode = 4` (bypass) on every node of that group - see `bypassGroup` in the pack's
 * `web/js/nodes pass.js`. It does not delete anything.
 *
 * A run therefore has to reproduce that action, not restructure the graph: a group the
 * user switched off in the UI arrives here as `mode = 4` on its nodes, and a group left
 * ON arrives as `mode = 0` with whatever file its loader holds.
 *
 * @module dsh-plugin-short-drama-director/lib/h3-switches
 */

/** The frontend-only node that owns the toggles. */
export const SWITCH_NODE_TYPE = '忽略多组孤海';

/** Node classes that supply an asset, and the slot name that holds the file. */
const LOADER_CLASSES = [
  { test: /^LoadImage$/u, slot: 'image' },
  { test: /^LoadAudio$/u, slot: 'audio' },
  { test: /^VHS_LoadVideo/u, slot: 'video' },
];

/**
 * Read every switch and the groups it manages.
 *
 * @returns one row per switch: its filter keyword, the groups it controls, which of
 *   them it has ON, and whether those groups actually have an asset loaded.
 */
export function readSwitches(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const groups = Array.isArray(graph?.groups) ? graph.groups : [];
  const switches = nodes.filter((node) => node.type === SWITCH_NODE_TYPE);

  /** Which group's box contains this node? */
  const groupOf = (node) => {
    const x = node.pos?.[0] ?? 0;
    const y = node.pos?.[1] ?? 0;
    for (const group of groups) {
      const [gx, gy, gw, gh] = group.bounding ?? [0, 0, 0, 0];
      if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh) return group.title;
    }
    return null;
  };

  /** Nodes belonging to a group, excluding the switch panels themselves. */
  const membersOf = (title) => {
    const group = groups.find((entry) => entry.title === title);
    if (group === undefined) return [];
    const [gx, gy, gw, gh] = group.bounding;
    return nodes.filter((node) => {
      if (node.type === SWITCH_NODE_TYPE) return false;
      const x = node.pos?.[0] ?? 0;
      const y = node.pos?.[1] ?? 0;
      return x >= gx && x <= gx + gw && y >= gy && y <= gy + gh;
    });
  };

  /** Does this group hold a loader with a real file in it? */
  const assetOf = (title) => {
    for (const node of membersOf(title)) {
      const loader = LOADER_CLASSES.find((entry) => entry.test.test(node.type));
      if (loader === undefined) continue;
      const values = node.widgets_values;
      const candidates = Array.isArray(values) ? values : [];
      const file = candidates.find((value) => typeof value === 'string' && value.length > 0 && value !== 'None');
      return { nodeId: node.id, classType: node.type, file: file ?? null, present: file !== undefined };
    }
    return null;
  };

  return switches.map((node) => {
    const properties = node.properties ?? {};
    const filter = String(properties.guhai_ig_filter ?? '').trim();
    const active = Array.isArray(properties.guhai_ig_active_set) ? properties.guhai_ig_active_set : null;
    // The panel lists every group whose title contains the filter keyword.
    const managed = groups
      .map((group) => String(group.title ?? ''))
      .filter((title) => filter.length === 0 || title.includes(filter))
      .map((title) => ({
        title,
        on: active === null ? true : active.includes(title),
        asset: assetOf(title),
        nodeCount: membersOf(title).length,
      }));
    return {
      id: node.id,
      filter,
      mode: properties.guhai_ig_mode ?? 'default',
      disableInsteadOfBypass: properties.guhai_ig_disable === true,
      managed,
    };
  });
}

/**
 * Decide which groups must be switched for this run.
 *
 * The rule is that the switches must match the assets the episode actually uses:
 *
 *  - a group switched ON whose loader has no file must be switched OFF, because an
 *    empty loader fails ComfyUI validation and takes the whole prompt with it;
 *  - a group switched OFF that the caller needs must be switched ON, or the asset
 *    silently does not reach the model;
 *  - a group switched ON that the caller does not need is left alone unless it is
 *    empty - the reference slots are ordered, so switching off a middle slot would
 *    shift every later asset into the wrong place.
 *
 * @param required - group titles this run needs, for example the six image groups.
 * @returns `{ off, on }`; `off` is what must be bypassed and `on` what must be restored.
 */
export function planGroupSwitches(switches, { required = [] } = {}) {
  const off = [];
  const on = [];
  for (const panel of switches) {
    for (const group of panel.managed) {
      const needed = required.includes(group.title);
      const hasAsset = group.asset !== null && group.asset.present;

      if (group.on && !hasAsset && group.asset !== null && !needed) {
        off.push({
          title: group.title,
          switchId: panel.id,
          nodeId: group.asset.nodeId,
          classType: group.asset.classType,
          reason: `the ${group.title} group is ON but its ${group.asset.classType} #${group.asset.nodeId} holds no file, and an empty loader fails validation`,
        });
        continue;
      }
      if (!group.on && needed) {
        on.push({
          title: group.title,
          switchId: panel.id,
          reason: `the ${group.title} group is OFF but this episode needs it, so its asset would never reach the model`,
        });
      }
    }
  }
  return { off, on };
}

/**
 * Apply a switch-on the way the frontend does: set `mode = 0` on every node of the
 * group, and clear the disabled flag.
 *
 * @returns the node ids that were restored.
 */
export function restoreGroups(graph, titles) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const groups = Array.isArray(graph?.groups) ? graph.groups : [];
  const wanted = new Set(titles);
  const touched = [];
  for (const group of groups) {
    if (!wanted.has(group.title)) continue;
    const [gx, gy, gw, gh] = group.bounding;
    for (const node of nodes) {
      if (node.type === SWITCH_NODE_TYPE) continue;
      const x = node.pos?.[0] ?? 0;
      const y = node.pos?.[1] ?? 0;
      if (x < gx || x > gx + gw || y < gy || y > gy + gh) continue;
      node.mode = 0;
      if (node.flags !== undefined && node.flags !== null) node.flags.disabled = false;
      touched.push(node.id);
    }
  }
  return touched;
}

/**
 * Apply a switch-off the way the frontend does: set `mode = 4` on every node the
 * canvas would collect for those groups, so the existing bypass resolution in the
 * converter rewires their consumers instead of leaving dangling references.
 *
 * @returns the node ids that were bypassed, for reporting.
 */
export function bypassGroups(graph, titles, { disableInstead = false } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const groups = Array.isArray(graph?.groups) ? graph.groups : [];
  const wanted = new Set(titles);
  const touched = [];
  for (const group of groups) {
    if (!wanted.has(group.title)) continue;
    const [gx, gy, gw, gh] = group.bounding;
    for (const node of nodes) {
      if (node.type === SWITCH_NODE_TYPE) continue;
      const x = node.pos?.[0] ?? 0;
      const y = node.pos?.[1] ?? 0;
      if (x < gx || x > gx + gw || y < gy || y > gy + gh) continue;
      node.mode = disableInstead ? 2 : 4;
      touched.push(node.id);
    }
  }
  return touched;
}
