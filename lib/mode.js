/**
 * What each mode is allowed to expose.
 *
 * The plugin registers one set of tools and one skill provider globally. A mode is not a
 * separate preset - it is a switch inside this one - so the switch has to decide what the
 * model can see. Registering only the current mode's tools makes the tool list itself
 * change, which is stronger than a guard that merely rejects a call: a tool the model
 * cannot see is a tool it will not try, and it costs prompt space to keep one around.
 *
 * The split is by *pipeline stage*, not by "is this ComfyUI":
 *
 *  - General mode is a ComfyUI assistant. Everything that runs, inspects and deploys
 *    ComfyUI belongs here, because that is the whole job.
 *  - Drama mode adds the tools that only make sense once a script is being produced:
 *    building the project workspace, editing storyboard files, and retaining reusable
 *    production-workflow lessons outside individual projects.
 *  - `drama_mode` is present in BOTH modes. It is the switch, so hiding it in either
 *    direction would strand the user.
 *
 * @module dsh-plugin-short-drama-director/lib/mode
 */

/** The two modes. `general` is the default: no project, no pipeline, just ComfyUI. */
export const MODES = ['general', 'drama'];

/** Tools only a short-drama production needs. */
export const DRAMA_TOOLS = ['drama_workspace', 'storyboard', 'workflow_memory'];

/** Tools every mode keeps: ComfyUI operation, plus the mode switch itself. */
export const ALWAYS_TOOLS = [
  'comfy_graph',
  'comfy_install',
  'comfy_inventory',
  'comfy_job',
  'comfy_launch',
  'comfy_run',
  'comfy_workflows',
  'drama_mode',
];

/** Skills that belong to running ComfyUI, which is what general mode is for. */
export const GENERAL_SKILLS = new Set([
  'comfy-general',
  'comfyui-deploy',
  'costume-and-quadview',
  'qwen-image-2-1-prompter',
]);

/**
 * Which tools a mode registers.
 *
 * @param mode - `general` or `drama`; anything else is treated as general, because a
 *   corrupted preference must not grant the pipeline's tools by accident.
 */
export function toolsForMode(mode) {
  return mode === 'drama' ? [...ALWAYS_TOOLS, ...DRAMA_TOOLS] : [...ALWAYS_TOOLS];
}

/**
 * Whether one discovered skill should be offered in a mode.
 *
 * Nothing is filtered in drama mode: the pipeline is the point. In general mode only the
 * ComfyUI skills remain, so the catalog does not advertise a nine-step drama pipeline to
 * someone who asked for a picture.
 *
 * @param name - the skill's kebab-case name.
 */
export function skillVisibleIn(mode, name) {
  if (mode === 'drama') return true;
  return GENERAL_SKILLS.has(String(name));
}

/** A short human label, for command output and log lines. */
export function describeMode(mode) {
  return mode === 'drama' ? '短剧模式' : '通用模式';
}
