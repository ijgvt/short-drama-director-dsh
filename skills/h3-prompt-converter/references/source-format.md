# Source formats and the element mapping

## Shape A - step_3 视频生成提示词 (primary input)

Produced by `step_3_欧美竖屏视频生成提示词.txt`. One 大分镜 block looks like:

```text
【大分镜1】
【全局统一设定】8K超高清，超写实风格……（样板话，见下方“要丢弃的内容”）
【画面风格和类型】电影级写实画面……
【人物映射】@女主
【场景映射】@豪宅客厅
【道具映射】@醒酒器          （无道具时整段省略）
【初始站位】女主在客厅左侧，男主在右侧……
（时长：4秒）
【摄像机景别】近景，固定机位
【拍摄主体】女主
【画面】豪宅客厅 内，女主 双手垂在身侧……（动作走位），眉峰微皱……（微表情神态），视线落在画面左侧的 男主 身上（视线方向），开口说：“I never wanted this.”（压抑，语速偏慢）（台词）
```

A source may contain several 大分镜 blocks. **Each block converts to exactly one H3 prompt.**

## Shape B - step_2 分镜稿

A shot table plus 人物映射 / 场景映射 / 初始站位 / 台词. Same conversion, except 景别 and 运镜 are read from the table's 摄制手法 column rather than from 【摄像机景别】. Keep the 大分镜 boundaries from the source; if the source is only a flat shot list, group shots so each group totals 4-15 s.

## Shape C - free-form description or an existing H3 prompt

Normalise it: pick the mode from Step 1 of `SKILL.md`, then rewrite into the official field structure. An existing prompt being cleaned up keeps its content - only field names, ordering, notation, and language are corrected.

## Element mapping

| Source element | Official landing place |
| --- | --- |
| 大分镜 | one prompt (one 4-15 s generation) |
| 分镜 N + 时长 | `[Shot N]`; from N=2 open with `At MM:SS.mmm,` using the running total |
| 【摄像机景别】近景 | 景别词：中文正文用 `中景` / `近景` / `中远景` / `大特写`，英文正文用 `a medium shot` / `a close shot` / `a medium-wide shot` / `an extreme close-up` |
| 【摄像机景别】固定机位 | `Static Shot` (or simply no camera-motion clause) |
| 运镜 `缓推+手持微晃` | motion type + amplitude + speed, e.g. `缓慢小幅推近`（英文 `pushes in with small amplitude at slow speed`） |
| 【拍摄主体】 | no official field - name it at the start of that shot as `镜头对准 X`, and always add the camera direction right after the subject: `正面` / `左侧面` / `右侧面` / `背面`（如 `镜头对准 记者若干 的正面`；过肩镜头写 `镜头越过 Selene Vale 的肩膀，对准 记者若干 的正面`）。A 背面 shot carries no facial expression - write back and shoulder action only. When the shot is a facial close-up of a person, append `45° 侧面特写`; non-face close-ups get no such note |
| 【画面】动作/走位 | action clause in `detailed_description` / `integrated_multimodal_description` |
| 【画面】微表情神态 | expression clause in the same sentence |
| 【画面】视线方向 | gaze clause referring to the named subject or 画外左侧/右侧 |
| 台词 `开口说：“...”` | `<d>[English] ...</d>` plus a `(Sx)` speaker ID on the speaker |
| 台词跨切点 | `<scenetrans>` at both connecting points + “continues across the cut” |
| 视频结束时截断的台词 | `<cutoff>` |
| 内心OS | `says in an off-screen voiceover` + state the lips remain closed (approximation - see `ref2va-rules.md`) |
| 画外音 O.S. | `says in an off-screen voiceover` + `while his/her lips remain completely closed` |
| 人物映射 `@女主` | `<Subject N> 是 <Picture M> 中的 女主，面容、发型与服装严格沿用参考图，包括妆容与发色。` |
| 场景映射 `@豪宅客厅` | `<Subject N> 是 <Picture M> 中的 豪宅客厅 环境，空间布局、陈设与材质严格沿用参考图。` |
| 道具/UI 映射 `@醒酒器` | `<Subject N> 是 <Picture M> 中的 醒酒器，结构、样式与视觉呈现严格沿用参考图。` |
| `@资产名` 里的造型/服装后缀 | 绑定时丢掉：`Natalie(日常便服造型)` 只写 `Natalie`；具体是哪套造型由 `<Picture M>` 决定 |
| 只用于定义角色/场景/服装/风格 的图 | **do not** create a standalone `<Picture N>` entry - cite it inside the `<Subject N>` definition |
| 真正当首帧/关键帧/尾帧/构图锚 的图 | standalone `<Picture N>` entry, labelled with its frame role |
| 【初始站位】轴线声明 | one sentence inside the description, e.g. `全片机位保持在 X 的右侧，始终不越轴。` - **only when the source states one**; a source that never mentions the axis gets no axis sentence |
| 【初始站位】另附的站位 / 走位 / 轴线示意图 | standalone `<Picture N>` entry that names its planning role, e.g. `<Picture 4> 是 [Shot 1] 与 [Shot 2] 的站位与走位参考图，规定人物的画面位置、左右关系与走位路径。`, plus one sentence inside `detailed_description` restating that role（如「全片站位与走位按 <Picture 4> 执行，不越轴」）. An image that only defines a character, scene, or prop still belongs inside the matching `<Subject N>` and must **not** get its own entry |
| 【画面风格和类型】电影级写实 | `实拍电影风格` at the start of `[Shot 1]`（英文正文用 `Live-action, cinematic`） |
| 浅景深 / 侧逆光轮廓光 | concrete wording: `浅景深`, `发丝上的轮廓光`（英文 `shallow depth of field`, `rim light on the hair`） |

<!-- BEGIN local addition: 画风是用户在项目开头选的，不是默认值 -->
### The look (画风) comes from the user

`【画面风格和类型】` is a **user choice**, not boilerplate to fill in. The production side asks once, with four options, before writing any prompt: 真人 / 3D动漫 / 动画 / 其他 (free text). Carry the answer into the opening style sentence and keep it identical across every 大分镜 of the project - a look that drifts between blocks makes the shots unjoinable.

| User's choice | 中文正文 | English body |
| --- | --- | --- |
| 真人 | `实拍电影风格，真人写实` | `Live-action, cinematic` |
| 3D动漫 | `三维动画风格` | `3D animation, cinematic` |
| 动画 | `二维动画风格` | `2D animation, cinematic` |
| 其他 | 按用户原话转写一句，保留关键词 | the same wording in English |

This is the one place the source's style line is **kept** rather than dropped - a stated look is not on the discard list below. `compile-h3` reads the project's stored 画风 and writes this sentence itself when the source block has no style line of its own.
<!-- END local addition -->

## Worked example: camera direction and a staging picture

Source: 【拍摄主体】男记者；【初始站位】另附一张站位与走位示意图。

```text
subject_definitions:
<Subject 1> 是 <Picture 1> 中的 Selene Vale，面容、发型与服装严格沿用参考图，包括妆容与发色。
<Subject 2> 是 <Picture 3> 中的 公司门口 环境，空间布局、陈设与材质严格沿用参考图。
<Picture 4> 是 [Shot 1] 与 [Shot 2] 的站位与走位参考图，规定人物的画面位置、左右关系与走位路径。

detailed_description:
实拍电影风格，白天户外自然光，浅景深，全片无字幕。全片机位保持在两人连线的同一侧，始终不越轴；人物站位与走位按 <Picture 4> 执行。
[Shot 1] 中景，镜头对准 男记者 的正面。……
[Shot 2] 在 00:04.000，镜头切至固定机位的过肩近景，镜头越过 Selene Vale 的肩膀，对准 男记者 的正面。……
```

## Asset binding: point, do not describe

Bind a subject by naming the label, the name, and the aspects that follow the reference - nothing more. Do not list the sofa, the lamp, the plants, the colours, or the materials. Three reasons:

- The reference image already carries that information, so an enumeration is redundant tokens.
- Any detail you transcribe wrongly now competes with the image and degrades fidelity.
- The asset registry name (`Natalie(日常便服造型)`) is a filing label. It belongs in the project's asset files; in the prompt it is dead weight.

Drop the `（asset: ...）` / `(asset: ...)` annotation entirely. The `<Picture N>` / `<Video N>` citation is the provenance.

The same restraint applies to `retention_analysis`: record which subject is retained and where, not an inventory of its features.

## Content to drop

【全局统一设定】 is largely tool-agnostic filler aimed at other video generators. Delete it rather than translating, except where it states a concrete look the source does not state elsewhere.

Drop: `8K超高清`, `超写实风格`, `禁止过度锐化`, `动态丝滑无闪烁`, `人物动作表情连贯自然无穿模`, `禁止出现人小景大`, `人物台词与口型完全一致`. H3 has no resolution or negative-prompt channel, and the official guide explicitly prefers concrete visual detail over abstract quality words.

Keep, translated into the opening style sentence: lighting direction, depth of field, film/lens character, skin-texture realism, and an explicit "no on-screen text" instruction when the source forbids burnt-in subtitles.
