---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

**`non_diegetic_music` defaults to `N/A`.** Audience-only music is a post-production decision for short drama, and H3 renders whatever score the prompt asks for with no way to remove it afterwards. Write `N/A` unless the user explicitly asks for music in this shot. The field itself is never omitted - omitting a section is a format error. Sound effects, ambience and dialogue are unaffected: they belong in `overall_soundscape` and the shot descriptions.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections. `non_diegetic_music` is `N/A` by default here too.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- In the short-drama director workflow, **keep the six H3 field names in English and write the section prose in Chinese**. Keep every authored marker and rule from the original H3 format. Do not create an English companion or translate the Chinese H3.
- Preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- When `<Audio N>` provides a character's voice timbre, name the target subject and reuse that speaker's `(Sx)` in the audio definition, at every spoken line, and in the audio's `retention_analysis` relationship. State that the audio contains a spoken vocal layer and that only timbre/delivery are copied, never the original words. A generic file-name reference does not tell H3 whose voice to use.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.

## One instruction lives in several fields

Every section is read on its own, so a change is not done until it is done everywhere. `summary`,
`detailed_description` and `overall_soundscape` routinely restate the same instruction, and a stale
copy is still an instruction: editing "no off-screen voice" out of the shot description while
`summary` still says it produced the off-screen voice anyway (measured).

When the user asks for a change, **search the whole prompt for the keyword** (drawer voice /
dialogue / crowd size / costume / prop name / duration / camera side…) and fix every field that
says it, then say which fields changed.

## Tips for Better Results

- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Treat authored `<Picture N> … 参考` definition lines as immutable source text. Uploading or removing a reference file changes the slot binding, never the wording or asset name in that line.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.

## Where the guides live

In this deployment the two authoritative guides ship with the `h3-prompt-converter` skill, as
`skills/h3-prompt-converter/../h3-prompt-writing/references/base-en.txt` and `ref-en.txt` inside the
`dsh-plugin-short-drama-director` package, and their resolved absolute paths are also recorded in the
`h3-prompt-converter` SKILL.md. Read whichever path resolves.
