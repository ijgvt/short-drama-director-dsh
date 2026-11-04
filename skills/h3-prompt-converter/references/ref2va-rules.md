# Ref2VA specifics

Use when reference images, videos, or audio guide the result but none of them is used as a concrete frame. Six sections, this exact order:

`subject_definitions` -> `summary` -> `retention_analysis` -> `detailed_description` -> `overall_soundscape` -> `non_diegetic_music`

## subject_definitions

One `<Subject N>` per referenced thing (person, scene, prop, interface, style). Number them in the order they are first needed. Name the label, the name, and the aspects that follow the reference - then stop. **Do not enumerate what the reference image shows.** The image is the authority on its own contents, and a mis-transcribed detail fights it.

```text
<Subject 1> 是 <Picture 1> 中的 Natalie，面容、发型与服装严格沿用参考图，包括妆容与发色。
<Subject 2> 是 <Picture 2> 中的三楼阳台环境，空间布局、陈设与材质严格沿用参考图。
<Subject 3> 是 <Picture 3> 中的星网新闻弹窗界面，版式、图标与视觉呈现严格沿用参考图。
```

Match the phrasing to the kind of subject:

- person -> 面容、发型与服装严格沿用参考图，包括妆容与发色
- scene -> 空间布局、陈设与材质严格沿用参考图
- prop -> 结构、样式与视觉呈现严格沿用参考图
- interface / UI -> 版式、图标与视觉呈现严格沿用参考图

Keep the character or place name as the source gives it (`Natalie`, `小美`). A Chinese proper noun is fine whether the sentence around it is English or Chinese: the validator accepts a bare Han name of 12 characters or fewer even under `--lang en`, while a longer Han run counts as Chinese prose and calls for a Chinese body.

Do not add an `(asset: ...)` or any other asset-registry label. The `<Picture N>` / `<Video N>` citation already carries the provenance, and the registry name belongs in the project's asset files, not in the prompt.

Rules:

- A subject may cite several assets: `in <Picture 2>, <Picture 3>, and <Picture 4>`.
- Motion and voice references use the same form: `whose walking motion comes from <Video 1>`, `<Audio 1> is the voice-timbre reference for <Subject 3>`. In Chinese prose: `其行走动作来自 <Video 1>`、`<Audio 1> 是 <Subject 3> 的音色参考`.
- **Standalone `<Picture N>` entries are only for images that serve as a shot's first frame, keyframe, last frame, edited keyframe, or composition anchor.** An image that merely defines a character, scene, costume, or style must be cited inside the relevant `<Subject N>` and must **not** get its own `<Picture N>` entry. Getting this wrong is the most common Ref2VA format error.
- When one audio asset plays multiple roles, describe them in one natural sentence instead of adding subsections.

## summary

One short paragraph (Chinese prose by default), opening with a square-bracketed task-type prefix - the prefix itself stays English. For plain reference-guided generation that is `[reference generation]`. Other prefixes combine roles, e.g. `[video editing + reference generation + audio reuse]`. `ref-en.txt` holds the full prefix table and the definition of each task type.

State the clip length, what happens, and how the references relate - including an explicit statement when no reference becomes a concrete frame:

```text
[reference generation] 这段 5 秒的目标视频中，<Subject 1> 在白天安静的早餐时段闲适地靠在 <Subject 2> 里，手里拿着一个苹果，漫不经心地浏览一块悬浮光屏。第三个镜头里 <Subject 3> 在屏幕上弹出，视频结束于 <Subject 1> 猛地坐直。三张参考图仅作为外观与版式指导，没有任何一张被用作具体画面帧。
```

## retention_analysis

One line per `<Subject N>`, in label order. Keep the statement short and generic - this section records *which* subject is retained and *where*, not an inventory of its features:

```text
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 4]): fully_preserved - 参考外观保留，姿态与表情为全新演绎。
<Subject 2> (appears in [Shot 1] through [Shot 4]): fully_preserved - 参考环境整体保留。
```

- The appearance list must be the `[Shot N]` set where that subject actually appears. A subject spanning every shot may be written `<Subject 2> (appears in [Shot 1] through [Shot 4])`.
- The marker is a **fixed English value**: `fully_preserved`, `partially_preserved`, `attribute_transfer`, or `weak_reference`. Never translate or paraphrase it. Choose it only within the reference role already defined for that label.
- New actions, backgrounds, or plot events in the target video are **not** fidelity loss - do not downgrade a marker because the scene moved on.
- Do not write `(Sx)` speaker IDs here.

## detailed_description

The main body, in the chosen prose language (Chinese by default). Style and axis sentence first, then `[Shot 1]`, then each further shot opening with `At MM:SS.mmm,` - a Chinese body may equivalently write `在 00:01.500，`.

- Normally 350-500 汉字 for a Chinese body, or 350-500 English words for an English one. When dialogue is dense, fit the complete spoken timeline rather than padding to a length target.
- At the first clear appearance of an important subject, describe its referenced characteristics, its position in frame, and its current action; later shots reuse the label without redefining it.
- When a subject speaks, write `<Subject N> (Sx)`. Off-screen speech keeps the same form and is marked `off-screen`.
- Assign `(Sx)` in order of actual vocal events and reuse the ID at every vocal event.

## overall_soundscape and non_diegetic_music

- `overall_soundscape`: 1-4 sentences in the chosen prose language covering ambience and physical sounds across the whole video. Dialogue, singing, and diegetic music stay in `detailed_description` and must not be repeated here. `N/A` only when the user asked for complete silence.
- `non_diegetic_music`: audience-only music. `N/A` when there is none.

## 内心OS - the one mapping with no official equivalent

H3 has no internal-monologue channel. The official guide covers non-lip-synced voice only as **off-screen voiceover**, which it requires to be written with the exact phrase `says in an off-screen voiceover` followed immediately by a statement that the on-screen character's lips remain completely closed.

So: map 内心OS to off-screen voiceover plus the closed-lips statement. The phrase `says in an off-screen voiceover` and the lips-closed clause stay in English even when the rest of the prose is Chinese. This is an approximation - the line and its delivery survive, but H3 renders it as off-screen speech rather than interior thought. Say so in one bullet after the prompt instead of pretending it is a faithful mapping.

Do not invent voiceover for lines the source did not mark as 内心OS or 画外音.

## Fast self-check

- Six section names present, spelled exactly, in order.
- Every `<Subject N>` defined once, used consistently, numbering without gaps.
- Every `<Picture N>` / `<Video N>` / `<Audio N>` cited has a stated role.
- No standalone `<Picture N>` entry for an image that only defines appearance.
- Markers are the fixed English values; no `(Sx)` in `retention_analysis`.
- `[Shot N]` numbering matches, and the timecodes add up to the clip length.
- Structural tokens are English: field names, `<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`, `[Shot N]`, retention markers, `N/A`, and timecodes.
- Prose is Chinese by default (English on request); validate with `--lang auto` (the default) or `--lang zh`.
- `subject_definitions` binds generically - no enumeration of objects, colours, materials, or furnishings.