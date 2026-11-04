---
name: h3-prompt-converter
description: Convert Chinese short-drama storyboards, step_3 video-generation prompts, or rough scene descriptions into MiniMax H3 official prompt format (T2VA / I2VA / FL2VA / L2VA / Ref2VA). Use when a 分镜稿, 大分镜 shot list, or @资产 reference set must become one paste-ready H3 prompt per shot group with correct field names, reference labels, speaker IDs, and shot timing.
---

# H3 Prompt Converter

Turn production-side Chinese material into **one MiniMax H3 prompt per 大分镜**. H3 generates 4-15 s per call, so one 大分镜 = one prompt, and its 分镜 become `[Shot N]` inside that prompt.

## Read the authoritative spec first

Field names, markers, and notation are defined upstream and are the source of truth. They ship with this plugin, in the `h3-prompt-writing` skill that sits beside this one:

- `<h3-prompt-writing skill>/references/base-en.txt` — T2VA / I2VA / FL2VA / L2VA, three-field format
- `<h3-prompt-writing skill>/references/ref-en.txt` — Ref2VA, six-section format

Both files are inside the same plugin bundle as this skill, so read them from there — **not** from `~/.codex/`, which exists only on a machine where that tool happened to be installed. If the platform's skill loader reports the sibling skill's directory before you read, use that; otherwise read the two files from the plugin's `skills/h3-prompt-writing/references/` folder.

<!-- BEGIN local addition: 用户 2026-02 明确要求的默认值，非上游内容 -->
**`non_diegetic_music` is `N/A` unless the user asks for music.** It is audience-only score, and short drama adds its music in post - a music bed baked into the prompt cannot be removed afterwards. 音效与环境音写进 `overall_soundscape`，只有"观众才能听到的配乐"这一项留空。
<!-- END local addition -->

Read the guide for the mode you are about to write. `references/example-zh-ref2va.txt` is a validated Chinese Ref2VA sample. This skill adds the Chinese-to-official **conversion mapping** and a **validator**; it deliberately does not restate the spec, so an upstream update to those two files is picked up automatically.

## Step 1 - Choose the mode

| Source material | Mode | UNET |
| --- | --- | --- |
| Text only, no images | T2VA | fl2va |
| One image as the opening frame | I2VA | fl2va |
| First + last frame, describe the path between them | FL2VA | fl2va |
| Last frame only, opening must be inferred | L2VA | fl2va |
| Images/videos/audio lock identity, scene, prop, style, camera, or rhythm - not used as an actual frame | Ref2VA | ref2va |
| A source video must be edited or continued | Ref2VA with a `[video editing ...]` / `[video continuation ...]` task-type prefix | ref2va |

The 导演台 node's `v2v` / `rv2v` task types produce the same Ref2VA prompt with a different square-bracketed prefix. The prefix set and their meanings are listed in `references/ref-en.txt`.

**Do not guess the mode from filenames.** If the source both supplies reference assets and pins a first frame, the reference role decides: assets that merely guide appearance stay in `subject_definitions`, and a genuinely pinned frame becomes a standalone `<Picture N>`. See `references/ref2va-rules.md`.

## Step 2 - Lay out the prompt

- **Base modes (T2VA / I2VA / FL2VA / L2VA)** - three fields, in this order: `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`.
- **Ref2VA** - six sections, in this order: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`.

Keep every field name exactly as written, in English, at the start of its line. Section order is part of the format.

## Step 3 - Convert, watching these failure points

These are the mappings that are easy to get wrong. `references/source-format.md` holds the full element-by-element table.

- **Language is two tiers.** Field names, markers, labels, and notation are hard requirements - always English. The prose is **Chinese only** in the short-drama director workflow. Do not translate the H3 body into English or create an English companion. `references/example-zh-ref2va.txt` is a validated Chinese sample. Bare character and place names stay exactly as the source gives them.
- **Timing.** 分镜 1 needs no timecode; from 分镜 2 onward open the shot with `At MM:SS.mmm,` using the running total, three-decimal milliseconds (`00:01.500`). Duration must add up to the requested clip length, 4-15 s.
- **All 分镜 of one 大分镜 go into a single prompt.** Never deliver one prompt per 分镜.
- **Shot count must match the source.** Do not invent or drop shots.
- **Dialogue** becomes `<d>[Language] ...</d>` with a stable `(S1)` / `(S2)` speaker ID - the tag follows the spoken line (e.g. `[English]` when the line is English) and the line itself is never translated; the same speaker keeps the ID across shots, joint speech uses `(S1,S2)`, and characters who never vocalize get no ID.
- **内心OS has no dedicated official channel.** Map it to `says in an off-screen voiceover` and immediately state that the character's lips remain closed; **both statements stay verbatim English even for a Chinese body**, because the validator matches the English wording. Tell the user this is an approximation - the voice is preserved but H3 treats it as off-screen speech, not internal thought.
- **画外音 (O.S.)** uses the same exact phrase `says in an off-screen voiceover` plus the closed-lips statement.
- **A line crossing a cut** needs `<scenetrans>` at the connecting points in both parts plus an explicit statement that the audio continues; a line truncated by the video ending uses `<cutoff>`.
- **Assets.** `@人物/场景/道具` become `<Subject N>` definitions that cite the source image as `in <Picture M>`. Bind them **generically**: give the label, the name, and which aspects follow the reference. Never enumerate the objects, colours, or materials visible in the reference - the image carries those, and a wrong enumeration fights it.
- **Camera direction.** Every `镜头对准 X` carries the camera direction right after the subject: `正面` / `左侧面` / `右侧面` / `背面`；an over-shoulder shot reads `镜头越过 A 的肩膀，对准 B 的正面`. A 背面 view hides the face, so write back and shoulder action instead of facial expression.
- **Initial blocking is mandatory.** Every factual line under 【初始站位】 must be carried into `detailed_description` before `[Shot 1]`: each subject's screen side, front/back orientation, facing target, relative position, entrances/exits, and any explicitly stated axis rule. Replace asset names with their `<Subject N>` labels, but do not merely summarise the section as one axis sentence and do not drop position lines because they seem repetitive.
- **Staging pictures.** When 【初始站位】 ships its own 站位 / 走位 / 轴线 示意图, the image anchors composition rather than appearance: give it a standalone `<Picture N>` entry stating its planning role and which shots it covers, and restate that role in one sentence inside `detailed_description`. An image that only defines a character, scene, or prop still belongs inside the matching `<Subject N>` and must not get its own entry.
- **Audio-to-speaker binding.** When reference audio supplies a character's voice timbre, bind it to that visible subject and the same speaker ID used by the dialogue: `<Audio 1> 是 <Subject 1> (S1) 的音色参考，其中包含人声层；仅复刻声音音色与表达，不复制原句内容。` In `【参考音频映射】`, `谢妄（声音参考: @文件）` means the owner is 谢妄 and the mention is only the file; never replace the owner with the file stem. Restate the voice reference at the speaking line, e.g. `沿用 <Audio 1> 的音色说：<d>[Chinese] …</d>`, and add `<Audio 1>: reference - its vocal timbre guides …` to `retention_analysis`. Do not leave a generic `某文件名的参考`, and do not assign a second speaker ID to the audio label.
- **Retention needs a parenthetical on every Subject line.** If a mapped subject has no visible shot, write `<Subject N> (not visible in any shot): weak_reference - 仅作为站位或上下文参考，不得画入任何镜头。` Omitting the parenthetical is an upstream validator error.
- **Style boilerplate.** Drop resolution and anti-artifact filler (`8K超高清`, `禁止过度锐化`, ...). Keep only concrete cinematography facts - lens, lighting, depth of field, film look - as one or two sentences at the start of the description, before `[Shot 1]`.
- **Axis and framing notes** from 【初始站位】 become one sentence inside the description, not a separate field - and only when the source actually states an axis rule (`本段轴线:` / `不越轴`). If the source never mentions the axis, write nothing about it.

## Step 4 - Validate before handing back

```bash
python scripts/validate_h3_prompt.py <prompt-file.txt>
python scripts/validate_h3_prompt.py <prompt-file.txt> --lang zh
```

`--lang zh` is the normal run for this workflow. The structural checks still run: field presence and order, `<Shot N>` numbering, timecode format, reference-label consistency, retention markers, speaker IDs, voiceover handling, and leftover asset-registry labels. It also warns when a `镜头对准` clause carries no 正面 / 左侧面 / 右侧面 / 背面 direction and when a standalone `<Picture N>` anchor is never referenced again; both are judgement calls, so confirm them by eye even on a clean pass. Fix every error; treat warnings as items to either fix or consciously accept.

## Output

Give the prompt as a single fenced `text` block, ready to paste into the workflow. Write the prose in Chinese; keep field names, markers, labels, and notation in English. Do not offer an English version. After the block, list any assumption you had to make - missing reference assets, inferred durations, or an 内心OS downgrade - in one short bullet each.

## Boundaries

- Never invent a reference asset, a line of dialogue, or a shot that is not in the source; ask instead.
- Do not silently change the requested clip duration to fit a shot count.
- One 大分镜 in, one prompt out; for a multi-大分镜 source, deliver prompts in order, each labelled with its 大分镜 number.
