# Source

- Official Qwen source: `https://github.com/QwenLM/Qwen-Image-2.1`
- Official edit contract: `https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt`
- Verified upstream revision: `ab96caa944157ca28a4f36b695c3047549f48f98` (2026-10-14)
- Verified file SHA-256: `e378fea686a1431581ba4c654d332ae96adad633f144ae738ec8ce9c4fd66439`
- Upstream repository: `https://github.com/iamyoki/qwen-image-2.1-skill`
- Installed skill name: `qwen-image-2-1-prompter`
- License: Apache-2.0
- Installed for the short-drama plugin and the global Codex skill directory on 2026-10-21.

The third-party skill's `references/edit_rules.md` is derived from the official contract above.
The plugin's conversion path follows the official rules directly: inspect every ordered image,
anchor only on visible content, apply named edits at full strength, preserve everything else,
follow the user's instruction language, use `<imageN>` for multiple images, keep the prose to one
paragraph, and keep `wh_ratio` / `ratio_follow` mutually exclusive. Four-view generation uses the
local normalizer before it submits through the configured image-edit workflow.
