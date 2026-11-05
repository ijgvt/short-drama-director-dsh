/**
 * Process-only memories shipped with a fresh installation.
 *
 * These are not user records and contain no project, plot or asset data. They describe
 * verified workflow behavior that still needs an operator guardrail. An existing user
 * memory file is never replaced or merged by an upgrade.
 */
export const BUILTIN_WORKFLOW_MEMORY_ENTRIES = Object.freeze([
  {
    id: 'builtin-wf-cloud-endpoint-empty',
    title: '云端任务被拦时先检查全局配置里的云端工作流是否为空',
    stage: 'comfyui',
    symptom: '实例本身在线、工作流文件也在，但 comfy_run 报云端 text-to-image 或 image-edit 没有配置工作流。',
    rootCause: '全局配置里的云端 endpoint 工作流为空时，Host 的 endpoint 检查会早于显式 workflow 参数生效。',
    prevention: '先用 comfy_inventory 确认实例和 endpoints，再检查全局配置里对应任务的云端工作流；为空时先补齐配置，不要先重装 ComfyUI。',
    applicability: '当前插件与全局配置向导',
    source: 'builtin',
    tags: ['comfyui', 'global-config', 'cloud', 'endpoint'],
    status: 'active',
    confirmationCount: 1,
  },
  {
    id: 'builtin-wf-qwen-edit-ratio-field',
    title: 'qwen-official 图片编辑提示词不要把画幅写进正文',
    stage: 'comfyui',
    symptom: '图片编辑提示 rewritten_prompt 不能包含画幅或分辨率，任务在提交前被拒绝。',
    rootCause: 'qwen-official 的画幅和分辨率由 wh_ratio / ratio_follow 单独传递，正文里的 16:9、9:16、1080p 会违反契约。',
    prevention: '正文只描述图像内容和编辑目标；画幅交给任务的 aspectRatio 或 wh_ratio / ratio_follow 字段。',
    applicability: 'task=image-edit，promptMode=qwen-official',
    source: 'builtin',
    tags: ['image-edit', 'qwen', 'prompt', 'aspect-ratio'],
    status: 'active',
    confirmationCount: 1,
  },
  {
    id: 'builtin-wf-negative-anchor-conflict',
    title: '场景负向词不能和项目正向设定互相冲突',
    stage: 'assets',
    symptom: '中式古风场景的正向提示写青瓦、竹影、八卦纹，负向却写无中式元素，画面发虚或变成西式建筑。',
    rootCause: '通用场景模板继承了欧美样例的负向锚点，套到其他题材时会和正向内容打架。',
    prevention: '逐项核对正负提示；中式项目把禁中式改为非西式、非日式，并在交付记录中写明偏离项。',
    applicability: 'drama-asset-prompts 场景提示词规范',
    source: 'builtin',
    tags: ['场景', '负向词', '锚点', '题材冲突'],
    status: 'active',
    confirmationCount: 1,
  },
  {
    id: 'builtin-wf-assets-no-default-upscale',
    title: '资产图默认不超分，3x 超分会显著拖慢后续生视频',
    stage: 'assets',
    symptom: '资产图生成完成后被自动追加 3x 超分，后续生视频耗时明显放大。',
    rootCause: '旧链路把 3x 超分当成四视图必经步骤，并且资产页还会主动提示继续超分。',
    prevention: '所有资产图出图后默认不超分，也不要主动向用户提及超分。只有用户明确、强烈要求时才运行 upscale-image；超分到原来的 3x 后，生视频耗时约为原来的 5–6 倍，速度降到约 1/5–1/6，资产详情页必须同时注明“超分之后生成视频速度将大大降低”。',
    applicability: '人物定妆照/四视图、场景图、道具图及资产详情页',
    source: 'builtin',
    required: true,
    tags: ['资产', '超分', '3x', '生视频性能', '默认规则'],
    status: 'active',
    confirmationCount: 1,
  },
  {
    id: 'builtin-wf-quadview-collapse',
    title: '四视图必须逐格目视检查中间正面视图',
    stage: 'assets',
    symptom: '输出尺寸和文件大小正常，但四视图第二格塌成一条细缝，正面人物实际缺失。',
    rootCause: '四视图排版存在随机性，尺寸校验无法证明四个视图都完整。',
    prevention: '每次四视图出图后逐格目视复核；发现塌格用相同参数重跑，确认新图可用后再登记资产。',
    applicability: 'Qwen-Image-2.1 四视图模板',
    source: 'builtin',
    tags: ['四视图', '排版', '验收'],
    status: 'active',
    confirmationCount: 1,
  },
  {
    id: 'builtin-wf-primary-duplicate',
    title: '同一变体存在两份 primary 时 H3 无法唯一绑定',
    stage: 'h3',
    symptom: 'generate-h3 报有未绑定的参考资产，但资产库里每个名字都能搜到图片。',
    rootCause: '同一变体下有多张 primary 时，H3 无法确定该上传哪一张。',
    prevention: '提交前检查每个变体的 primary；把废稿移出资产树并 refresh，只保留当前 primary 和四视图。',
    applicability: '资产库自动扫描与 H3 生成流程',
    source: 'builtin',
    tags: ['h3', 'asset-library', 'primary', 'binding'],
    status: 'active',
    confirmationCount: 1,
  },
]);

export function builtinWorkflowMemoryEntries() {
  return BUILTIN_WORKFLOW_MEMORY_ENTRIES.map((entry) => ({
    ...entry,
    tags: [...entry.tags],
  }));
}
