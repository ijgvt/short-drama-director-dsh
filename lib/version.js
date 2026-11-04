/**
 * What version of the Host half is actually running, and what it can do.
 *
 * This exists because of a specific, repeated failure. The Host half is imported once per
 * process, so a file edited on disk keeps running its old code until the whole application
 * restarts. Every symptom of that is a false negative: a new action is "unknown", a fixed
 * parser "returns nothing", a new field "is missing". The only reliable way to tell the two
 * situations apart was to add a probe action and see whether the Host accepted it - which
 * means every diagnosis cost a round trip and the user could not check anything themselves.
 *
 * So the contract is: the Host publishes what it is, once, and the Client compares. The
 * version below is bumped whenever the Host's behaviour changes in a way the Client can
 * observe, and `capabilities` lists the discrete things a Client may rely on. A Client that
 * needs something absent from this list must say so instead of rendering a control that
 * cannot work.
 *
 * @module short-drama-director/version
 */

/**
 * Host contract version. Bump on ANY observable Host behaviour change.
 *
 * History:
 * - 1: skill provider, mode filtering, ComfyUI tools.
 * - 2: `/storyboard` command and the storyboard panel (`projects`/`browse`/`episodes`/
 *      `read`/`write`), RemoteResult envelope handled on the client.
 * - 3: `【大分镜N】` heading dialect; block text excludes the heading line; `insert`
 *      action with `copy` / `blank` kinds; writes resolved through the caller's sandbox
 *      policy; `read` reports an unrecognised heading dialect instead of an empty list.
 * - 4: `comfy_run` validates every patch and input binding before it contacts the
 *      instance; uploads are named by content hash; `version`/`capabilities` published.
 * - 5: sidecar project metadata (`.director/`): a stable `shotId` per block that survives
 *      insert, reorder and delete; a per-document `revision` with `expectedRevision`
 *      conflict detection; a project-level write lock; `storyboard action=migrate`
 *      (dry-run capable and idempotent); atomic writes that never share a temp file name.
 * - 6: asset library (`.director/assets.json`): Asset / AssetVariant / AssetFileVersion with
 *      sha256 content identity, role-aware version numbering, and
 *      `storyboard action=assets` (list / detail / refresh). Regenerating an asset makes a
 *      new version and never moves an existing binding; identical bytes at two paths are one
 *      version with two paths.
 * - 7: `@资产` references are bindings, not text: `storyboard action=references` resolves a
 *      mention to a concrete `assetVersionId` with UTF-16 occurrence offsets, reports
 *      unresolved and ambiguous mentions by position, and returns the deduplicated ordered
 *      input list. A mention whose text or position can no longer be proven becomes
 *      `needs_review` rather than being silently rewritten.
 * - 8: a durable job ledger: the submission intent is recorded BEFORE the instance is
 *      contacted, so a crash in that window leaves a recoverable trace instead of a prompt id
 *      nobody wrote down; `requestId` makes a repeat return the same job instead of a second
 *      run; `submission_unknown` records a POST whose reply never arrived and is never
 *      retried automatically; `download_failed` is distinct from a failed run. `comfy_job`
 *      reads the ledger, so a job outlives the process that started it.
 * - 9: controlled media reads for the panel: a `prefix` route under `/short-drama/media/`
 *      serves bytes for an opaque handle this process minted for a specific file. No path from
 *      a URL is ever opened; a handle outside the configured roots is refused even when valid;
 *      Range is supported so a clip can be seeked and played in place instead of re-downloaded.
 *      `storyboard action=assets` returns a handle per variant and per file version.
 * - 10: the environment verdict is three answers rather than a VRAM number - `可做` /
 *       `需准备` / `暂不可做`, each carrying the step that changes it, and a cloud route turns
 *       "cannot" into "needs a step" for anything the local card is short of. Same-named
 *       projects stay distinct: the scan keys by path instead of by folder name, and
 *       `drama_workspace` refuses to build on top of a different production.
 * - 11: generated results are candidates before they are anything else. `lib/result-store`
 *       copies each output into `.director/results/<jobId>/` with its own sha256, and
 *       `storyboard action=results` lists, selects, promotes and prunes them. Selecting is a
 *       separate act from generating; a new version never displaces a selected one; promoting
 *       requires a selection; and pruning never touches a selected or promoted candidate.
 * - 12: the panel gains a results view: candidate cards with the selected one outlined, an
 *       unreviewed filter, in-place playback through a media handle (a video is never
 *       autoplayed and preloads metadata only), select and copy-into-the-asset-tree actions, and
 *       a badge on the tab counting the candidates nobody has reviewed. Copying needs a
 *       destination the user supplies: the panel does not invent one.
 * - 13: the results area can put two candidates SIDE BY SIDE. Exactly two panes, in the order
 *       they were picked, and both carry the same select and promote actions as the grid, so
 *       leaving the comparison is never required in order to act on it. A still and a clip are
 *       refused with a reason: there is no comparison to make between them.
 * - 14: the pieces reach each other. Thumbnails are real downscales (a 928x1664 sheet becomes
 *       100x180, about 1/40 the bytes) cached under `.director/thumbnails`, and NO thumbnail is
 *       produced when the scaler is unavailable rather than a copy pretending to be one. Copying a
 *       chosen result into the asset tree also points the ASSET side's selection at it, so the same
 *       file is chosen once. Resolved @ references are written back onto the shot without bumping
 *       the document revision. Projects carry a `label` so two with the same title are told apart.
 *       The panel gains a results compare of up to three panes, an in-place redo that recovers the
 *       original inputs and starts nothing, and drafts that survive a reload and say they are drafts.
 * - 15: the QA matrix's six remaining gaps. Reference capacity is counted from the WIRING (a slot
 *       fed by another node or on a bypassed node cannot take an upload), so an over-capacity run is
 *       refused before submission. `comfy_job` cancels by prompt id - removing just that queue entry
 *       and reporting when a job is already running instead of escalating to the instance interrupt -
 *       and flags `instanceChanged` when asked about a job on a different address. A run that reports
 *       success with no file is NO_EXPECTED_OUTPUT rather than a finished run, so no result is
 *       recorded for a file that does not exist. The panel detects a draft that an outside edit
 *       invalidated and keeps BOTH texts until the user chooses.
 * - 16: three questions the plugin could not answer. `storyboard progress` buckets every shot by
 *       what BLOCKS the user (missing assets / ready / running / awaiting review / decided) with a
 *       reason per shot, so "还差什么" stops being an eyeball exercise. `storyboard health` reports
 *       dangling references, candidates whose file is gone, unfinished jobs and cleanable cache -
 *       as findings with an action each, never as repairs. `storyboard diagnose` builds a bundle
 *       that is safe to send: no drive paths, no tunnel hostname, no script title, no prompt text.
 * - 17: the three prompt sources are compared for drift (D08) - by BLOCK COUNT, which is
 *       unambiguous, and by content, which is reported for review rather than as a verdict, because
 *       中英文提示词 are supposed to differ and a false "up to date" is what ships the wrong prompt.
 *       Duration consistency is checked against the text, which stays the only source of truth
 *       (D09) - and the duration a heading declares is now actually READ, which it never was: every
 *       block reported `seconds: null` while the file said `（总时长：8 秒）` in plain sight.
 * - 18: the 资产映射 preamble counts. A real prompt file declares its cast and props BEFORE the
 *       first 大分镜, and that is where every @ lives - treating it as decoration made every block
 *       resolve to ZERO references while the file named five assets in plain sight, so the storyboard
 *       showed no reference images and a generation would have uploaded nothing. The preamble is now
 *       part of what a block resolves against (while the block's own text stays untouched for
 *       display and saving), and each resolved reference carries an opaque THUMBNAIL HANDLE so the
 *       bar can show the file: a name cannot distinguish 林晚四视图.png from 林晚.png.
 * - 19: the panel shows pictures, not full-size files. FOUR places were reading the wrong handle:
 *       the asset grid, the asset detail's per-version images, the @ picker's candidates, and the
 *       results grid all used the full-resolution handle while the Host was already sending a scaled
 *       one alongside it. A character sheet is about 1.9 MB, so a panel that requested six of them
 *       did not visibly finish - which is indistinguishable from nothing loading, and is exactly how
 *       "资产部分也没有图片" was reported while the images were in fact being requested. The comparison
 *       still asks for the ORIGINAL on purpose: scanning twenty candidates should cost twenty
 *       thumbnails, while looking closely at two should show the actual pixels.
 * - 20: H3's own reference syntax is read. H3 does not use `@` - by design - and declares its
 *       references once as `<Subject 1> 是 <Picture 1> 中的林晚`, then refers to them by number. A
 *       reference bar that only understood `@` therefore showed NOTHING on the file the video model
 *       is actually fed from. `<Picture N>` is now read as the reference slot itself (so it IS the
 *       upload order), in both word orders (Chinese puts the name after the number, English before),
 *       with the sibling H3 file supplying names a translation lost. Containment matching is scoped
 *       to H3 alone and one-directional, because applying it to `@` would let the file name
 *       `林晚-军装` bind the character `林晚` and silently drop the costume.
 * - 21: the 视频提示词 → H3 COMPILE step. The two files have different jobs and were being
 *       conflated: 视频提示词 is what the USER edits (one document per episode, \`@资产名\` in its three
 *       映射 sections so a name is searchable and a picker can complete it), while H3 is what the
 *       MODEL is fed (no \`@\` at all - its mapping is \`<Subject N>\`/\`<Picture N>\`, because the workflow
 *       needs a NUMBER per reference slot). \`compile-h3\` reads the \`@\` table and emits ONE prompt per
 *       大分镜, each with its own contiguous subject table built from what that block actually refers
 *       to - carrying one table across would upload images a prompt never mentions. An asset the prose
 *       names differently can be declared with \`｜别名：\`, and one that is not declared is REPORTED as
 *       unused rather than guessed.
 * - 22: the format is per 大分镜 on BOTH sides. `split-episode` turns an episode's 视频提示词 into
 *       one self-contained file per 大分镜 - each repeating its own 【人物映射】/【场景映射】/【道具映射】
 *       with the \`@\` kept, so one file can be opened, previewed and compiled on its own - and compiles
 *       each of those into its own H3 prompt. "视频提示词几个大分镜，h3 就几个大分镜" then holds BY
 *       CONSTRUCTION rather than by matching two lists afterwards. A source may hold several files
 *       (the panel lists 大分镜1 / 大分镜2 separately), and the trailing 自检 section is cut from the last
 *       block - it belongs to the episode, and its stray \`@\` was reaching the compiled H3 prompt.
 */
// 23: reference image/media imports, per-file writes, text conflict checks and heading preservation.
// 24: authenticated image previews, H3 synchronization and shared video submission settings.
// 25: direct file-picker imports in all asset categories; separate video/audio references.
// 29: the aspect-ratio label is actually READ. /object_info reports a dynamic combo as
//     ["COMBO", {"options": [...]}], and the lookup originally read only [0] - the bare form - so the option
//     list always came back empty and the bare ratio was sent. It failed SILENTLY, because returning the
//     input unchanged looks like "this instance has no opinion", and the instance then rejected the graph
//     with "aspect_ratio: '9:16' not in [...]". Both declaration shapes are read now, and a short ratio in
//     a comfy_run patch is expanded to the node's own label before the patch is applied.
// 28: comfy_run's OUTPUT schema declares what the implementation actually returns - candidates (with
//     resultsProjectRoot), jobId and reused (a repeated requestId answers from the ledger), and a file's
//     kind/remoteName even on the reused path. With additionalProperties:false the missing names made the
//     tool report "returned invalid output" for a reply whose video had really been produced and saved.
// 27: 生成视频 takes a 时长 parameter and applies all four settings to the workflow by NODE NAME rather
//     than by a pixel calculation: ResolutionSelector.megapixels (480p 0.5 / 720p 0.9 / 1080p 1.5) plus
//     aspect_ratio, the 时长 node's seconds, BasicScheduler.steps as the total, transition_step as the
//     first pass, and the 武打 LoRA chain switched on by clearing the bypass of its group's nodes - with
//     文戏 10/6 and 武打 12/8. Both the named and positional widget forms are written, because the
//     converter reads one and the ComfyUI frontend the other.
// 26: `/storyboard` answers with a one-line summary by default instead of the whole payload, because
//     `text` is what the conversation renders and the raw JSON was landing in the transcript. A caller
//     that needs the object passes `debug: true`, and the panel does so on its FIRST call - retrying a
//     write would send it twice, and the second call's expectedText would describe a file the first one
//     had already changed, making a successful save look like a no-op.
// 30: the 分镜管理 panel talks to `POST /short-drama/panel` instead of `/storyboard`, and the command
//     sets `recordInput: false`. Both changes answer the same measured fact: `remote.commands.execute`
//     is not a private channel. dsh-commands appends `command/run` and `command/done` to the session
//     log for EVERY admitted line, and the Web client renders that pair as a conversation card - one
//     session held 180 of them, 108 KB of request text (a write names the whole 大分镜 body) and 125 KB
//     of JSON answers, including base64 image previews. A command result has no field but `text`, so
//     there was no way to answer the panel with an object and keep the payload out of the log.
//     The route is registered on the same web server as the media prefix and behind the same
//     Host/Origin + browser-auth fence. `/storyboard` remains as the fallback channel and still
//     answers a one-line summary by default (`debug: true` for the object).
// 31: `storyboard action=settings` gives a project three upfront decisions - 画幅 (aspectRatio),
//     画风 (artStyle) and 分辨率 (resolution) - stored on `.director/project.json` so the panel
//     and the agent read ONE record. Before this, each generation re-decided the shape and the
//     look, which produced 9:16 character sheets beside 16:9 scenes and a style that drifted
//     mid-episode; nothing reported it because every individual generation was valid.
//     Also in this version: `comfy_launch` starts a 绘世/Aki-style integrated package by running
//     its own interpreter on `main.py` (that layout has no run_*.bat, and its GUI front end
//     waits for a human click, so spawning the .exe and waiting would always time out), and
//     install detection reports `layout: 'integrated' | 'portable'` instead of calling a
//     working package invisible.
// 32: PORTABILITY. No file in this bundle names a machine any more, so it works on a computer it
//     has never seen. `lib/env-discovery.js` finds ComfyUI instead of assuming it: configured
//     path, then COMFYUI_HOME/COMFYUI_PATH, then what a previous session recorded, then siblings,
//     then a bounded scan of existing roots - ranked by how much each copy actually contains, so
//     the copy in use wins over a leftover. Config defaults for workflowsDir / workspaceRoot /
//     comfyuiPortablePath / deployPackPath are now empty rather than `D:\...`, and the media
//     service grants only the project and working folders instead of a whole drive root.
//     The preset is declared in THIS bundle's `cordis.patch.yml`, so installing the plugin puts
//     短剧制作导演 in everyone's new-session list, not only the author's. Install detection
//     reports `layout` (portable / integrated / source), and the deployment skill teaches
//     discovery rather than a fixed path - a skill is instructions to a model on somebody
//     else's machine, and one concrete path there is an instruction to look in a directory that
//     does not exist.
// 33: the H3 step tables changed (文戏 10/6 → 12/8, 武打 12/8 → 14/10) so 一采 spends more of the
//     budget on the first pass while 二采 keeps its 4 refinement steps in both modes; the results
//     grid names a candidate 项目名_第N集_大分镜M（第k次） from the episode/block the run recorded,
//     shows ONE action per card (存入资产目录, with 选用 / 重做 living in the comparison), and gives a
//     clip a tall box with `cover` so it no longer looks like a failed image inside a square.
// 34: the defects an outside 9-persona test run found, fixed. The worst was a SPLIT BRAIN: install
//     detection (`comfy_install action=check`) inspected only the configured paths, while the
//     launcher and the workflow index used `discoverInstallations()`. On a machine with three
//     working installs and nothing configured, `check` answered "Nothing is installed here" and
//     offered a ~100 GB download, while discovery found all three in 48 ms. Detection now uses the
//     same discovery, reports the marker files that proved each layout, and says what it searched
//     before saying "none". Also fixed here: `storyboard action=settings/health/diagnose` returned
//     fields the output schema did not declare, so every call threw `"value.saved" is not a
//     declared property` and a stored 画幅 could be written but never read back; `project` now
//     accepts an absolute path instead of being joined onto the projects root; an empty asset
//     library beside a non-empty asset tree scans itself instead of showing a blank panel; the
//     cloud tunnel script is discovered (connect_*cloud*.bat in the install hints and `_deploy`)
//     so a dropped tunnel no longer needs a hand-run .bat; `comfy_job` resolves its address through
//     the same chooser `comfy_run` uses instead of a default local port; and ledger records older
//     than a day are reported as history rather than as jobs to poll.
// 35: the batch an outside full-flow + panel test produced. Two of these made the panel's generate
//     button unusable on a fresh install, and one lost the data that names every result:
//     - workflow selection is now by CAPABILITY (`describeH3Workflow`), not by filename, so the
//       sample file with no duration node is no longer auto-picked; the predicates accept both
//       saved graph shapes (named map / positional array) and both first-pass encodings
//       (`transition_step` / `SplitSigmas.step`).
//     - `generateH3` read `episodeNumber`/`blockNumber` off the execution context instead of its own
//       parameters, so every candidate recorded null and the grid fell back to
//       `YZ_H3__00004-audio.mp4`.
//     - `compile-h3` had no `write` argument and six undeclared return fields, so it threw on
//       validation AND could never save.
//     Project decisions: an H3 block now carries its 大分镜 duration for the panel's time selector;
//     result names are `<code>_<episode>_<block>(<k>)` from ONE pure module (`lib/result-naming`),
//     with the code asked once as a project setting rather than guessed from pinyin; and the card
//     action is 「存到本集」, writing `剧集/第N集/成片/` and leaving the asset tree alone (archiving is
//     not approval, so it does not require a selection - with a single take there is nothing to
//     compare against). Also: `drama_workspace init` creates `.director/project.json` and registers
//     the project, so `settings` works on a brand-new project and `drama_mode` can see it.
// 36: English H3 exists again. `drama-h3-video` requires `（英文）` per 大分镜 - "最终喂给模型，模型对英文
//    理解更好" - and the compiler always supported it, but the `storyboard` tool had no `language`
//     parameter, so `payload.language` was permanently undefined and every compile came out Chinese.
//     The parameter exists now, and `language: 'en'` TRANSLATES (each block through the host model)
//     instead of merely re-labelling the fields: a compile alone leaves the prose Chinese, which the
//     model rejects for `subject_definitions contains non-English prose outside <d>`. Every block is
//     translated before the first file is written, so a machine with no configured model refuses and
//     writes nothing rather than leaving half an episode in English.
// 37: the two H3 versions are COMPANIONS, and the English one follows the Chinese document.
//     Compiling 中文 now also creates the 英文 sibling for any block that does not have one yet, so a
//     project compiled here has the same two files a hand-made one has - and the panel's
//     提示词版本 picker shows them side by side, with no extra control.
//     The English side's per-block action is 一键更新, and it re-translates the CHINESE H3 of that
//     block. It used to recompile from the 视频提示词, which silently discarded every edit made in the
//     Chinese prompt - the one place the user is supposed to edit. A block with no English sibling yet
//     is created by the next Chinese compile; a block whose Chinese text changed is refreshed by that
//     button, which is why the button exists at all.
//     `subject_definitions` is translated too now: it used to be passed through verbatim because it
//     carries the `<Subject N>` bindings, but those are MARKERS the validator compares exactly, so
//     leaving the field untranslated only left Chinese prose in an otherwise English prompt - the
//     documented `subject_definitions contains non-English prose outside <d>` rejection.
// 38: editing an H3 prompt from the panel can be SAVED. A heading-less document is one block - the
//     reader said so, the writer looked the block up by heading, found none, and refused with
//     「there is no 大分镜 1 in the file」. Every compiled H3 prompt is heading-less (it starts at
//     `subject_definitions:`), so the one file the user is meant to edit could never be saved, in
//     either language; the panel kept the draft, so nothing was lost, but auto-save was dead.
//     The write path now treats that shape as the whole document (both the index and shotId forms),
//     still applies the expectedText guard, and refuses to empty a file. Inserting into such a file
//     is refused with an explanation instead of the same misleading error, because an H3 prompt is
//     already one file per 大分镜.
// 39: `health` reports a 视频提示词 whose 资产映射 sits only at the top of the file. The required output
//     order puts 画面风格 → 人物映射 → 场景映射 → 道具映射 → 初始站位 → 分镜 INSIDE each 大分镜, and a
//     file that deviates used to pass unnoticed: reference resolution merges the file's preamble into
//     every block, so `@引用` still resolved. What breaks is copying one 大分镜 out on its own - it
//     names people and props with no mapping to bind them. Reported per file and only when no block
//     has its own mapping, because a shot with no characters may omit 【人物映射】 legitimately.
// 40: a split 大分镜 file starts at `【大分镜N】` and carries its own mapping. The `# 第N集 - 大分镜 M`
//     title and the `### 大分镜 M（总时长…）` heading are gone: the filename already says which block
//     it is, and they only pushed the prompt down the file. `【大分镜N】` stays, because it is the
//     block's own label in the reference format and it keeps the file a proper one-block document.
//     The skills now state the same thing, and that every 大分镜 must carry its own
//     【人物映射】【场景映射】【道具映射】 - a single episode-level mapping is what produced blocks that
//     could not be copied out on their own.
// 41: `【画面风格和类型】` comes from the PROJECT's 画风 (真人 / 3D动漫 / 动画 / 其他, asked once at intake).
//     Compiling and splitting took a `style` argument nothing ever passed, so a project whose source
//     file had no style line produced blocks with no style line at all - and a block copied out on
//     its own said nothing about what the film looks like. The project sentence is now the default;
//     an explicit `style` still wins, and a project that has not answered yet gets no line rather
//     than a guess.
// 42: the reference bar is honest about what it is, and generation no longer starts when it cannot
//     bind. `生成视频` is disabled while a reference is unresolved or ambiguous - the bar already said
//     「引用没解析完，不能生成」 but the button stayed pressable, so the user pressed it and waited for
//     the Host to refuse. The 「固定/取消固定」 control is gone: `onPin` was never passed by the parent,
//     so it never rendered, and no Host action sets `pinned`, so it was dead code on both ends.
//     Everything else the bar shows stays presentation-only by design: `generate-h3` re-parses the
//     block text with `buildH3References` and uses THAT, so the text is the source of truth and the
//     bar is a view of it - the value is seeing which file goes into which slot, and what would
//     block the run, before a multi-minute GPU job.
// 43: the 引用 bar stops flashing while the user types. Two causes, both fixed: an H3 block keyed its
//     re-resolution on the WHOLE prompt (so any prose edit re-resolved), and a re-resolution replaced
//     the bar's content with 「解析引用中…」. The key is now what a binding actually depends on
//     (`subject_definitions` plus the picture/media numbering), and a re-resolution with data on
//     screen keeps the list and adds 「更新中…」. The debounce timer also stopped being cancelled by
//     irrelevant re-renders: `shot` was in its dependency list and is a fresh object every parent
//     render, so whether a refresh ran at all depended on the parent's render rhythm.
// 44: the H3 compiler now matches the documented source format. Two gaps, both silent:
//     - 【拍摄主体】 was DROPPED. `source-format.md` maps it to 「镜头对准 X」 at the start of the shot,
//       so the compiled prompt never said who the camera is aimed at - which in a two-person scene
//       is the difference between aiming at A and aiming at B. The 过肩 phrasing did survive, because
//       it lives inside 【摄像机景别】.
//     - dialogue was converted only in the `台词：角色名（情绪）“台词”` form. `PROMPT-通用小白版.md` writes
//       it as 「角色名 开口说：“台词”（情绪）», so a prompt written exactly as the document instructs
//       came out with plain text dialogue: no `<d>`, no speaker id. Both forms are accepted now,
//       including 画外音说 / 内心OS, and the speaker is inferred from 【拍摄主体】 when the name is not
//       repeated next to the verb.
//     The camera line also goes through the same name replacement as the prose, so one shot no
//     longer mixes `<Subject 2>` with 林川.
// 45: the H3 spec was updated to a newer upstream revision, and `compile-h3` follows it. The aim
//     clause now carries the camera direction (`镜头对准 X，左侧面`), taken from the third item of
//     【摄像机景别】, because the new validator warns when an aim clause states no direction - and a
//     shot that does not say which side of the subject it is on is the difference between a left and
//     a right profile. The bundled converter skill took the newer `SKILL.md`, `source-format.md` and
//     `validate_h3_prompt.py`; the local additions were re-applied on top (bundled spec paths instead
//     of `~/.codex`, `non_diegetic_music: N/A`, the 画风-is-a-user-choice section, and the `---` /
//     `【大分镜N】` strip in `split_blocks` that keeps a multi-prompt file validating).
// 46: 过肩镜头 is the DEFAULT camera for dialogue, not an occasional choice. The prompt-writing rules
//     now say so (and that a dialogue block built entirely from flat frontal singles is not
//     acceptable), because flat coverage is what makes two-handers feel like a table read. The
//     compiler also stops adding 「镜头对准 B」 after an 过肩 line: that line already says who is aimed
//     at (`镜头越过 A 的肩膀对准 B`), so the copy was noise in a prompt the model has to read - and
//     since 过肩 replaces the direction field, the copy could not carry a direction either.
// 47: a `@` that has no mapping entry no longer reaches the H3 prompt. `初始位置参考：@外卖袋` written in
//     【初始站位】 without adding 外卖袋 to the block's mapping used to be copied through verbatim, so the
//     sync produced a file that LOOKED updated while `generate-h3` refused it outright with
//     「H3 正文不能含 @ 引用」. It is now dropped (the name stays as plain text) and every such mention is
//     reported by both compile-h3 and sync-h3, with the remedy: declare it in the block's mapping.
//     The panel also stops being silent about a no-op: 一键同步 now says whether the file changed, or
//     that it was already current - a fixed 「已同步」 on an unchanged file is indistinguishable from a
//     dead button.
// 48: 功能参考. A block may ask for an extra reference by FUNCTION - 「初始位置参考：@外卖袋」,
//     「音频参考：@林川（音色）」 - where the name only has to resolve to a FILE and the picture/audio is
//     what matters. compile-h3 now scans the BODY (never the mapping sections, which already produce
//     their own labels) for 「XX参考：@名字」, gives each a numbered standalone reference, and says what it
//     is for: <Picture 2> 是 外卖袋 的参考，用于规定本大分镜的初始位置与人物相对关系。 A recognised label
//     (初始位置/走位/轴线/构图/服装/光影/音频) gets a standard sentence; anything else is carried in the
//     writer's own words. parseH3References learned the standalone <Picture N> 是 X 的… form too, so the
//     compiler produces a prompt that generation can actually bind instead of one it rejects as unresolved.
// 50: every reference carries `assetKind`. The panel's asset column groups by category (人物 / 场景 / 道具 /
//     其他参考图片 / 参考音频 / 参考视频); without the library category the reference only ever showed
//     `reference-image`, so every entry landed in 「其他参考图片」 and the character/scene/prop groups stayed
//     empty. Added to BOTH builders - buildReferences (video prompts) and buildH3References (H3) - because
//     each prompt has its own asset column, and fixing only one left the other wrong.
// 51: a functional reference must name an EXISTING asset. `初始位置参考：@楼道灯` on a project without a
//     楼道灯 asset used to emit `<Picture 4> 是 楼道灯 的参考，…`, which binds to nothing - generation then
//     refused the prompt the compiler had just produced, and the message pointed at the reference instead
//     of at the typo. compileEpisodeToH3 now receives the library's names (`knownNames`); an unknown name
//     stays plain prose and is reported in `unmappedMentions`. A caller with no library keeps the old
//     behaviour rather than silently dropping references.
// 52: `@名字` prefers the asset NAMED exactly that. A re-export (`外卖袋_00001_.png`) had produced a second
//     asset whose derived name also answered to 外卖袋, so every `@外卖袋` in a prompt came back ambiguous -
//     five occurrences, five refusals - even though one asset is literally called 外卖袋. An exact name is
//     an identity and a derived match is a coincidence, so the exact one is chosen; asking is kept for a
//     real tie. Ambiguity is NOT cleanable by deleting the mention: that would drop a valid reference.
// 53: a real same-name tie can be answered from the panel. `references` returns `candidateDetails`
//     (asset id, category, variant and representative file), accepts the user's `choices`, and carries
//     that choice forward so reopening the block does not ask again. This is what makes a project whose
//     identical prop was copied into several asset categories usable without silently guessing.
// 54: the storyboard panel gains a GLOBAL CONFIG view. Task workflows are selectable per local/cloud
//     environment; video generation stays on the detected H3 graph but exposes its model, scheduler,
//     total steps and first-pass split (second pass is computed). Saving writes the video workflow file
//     and stores both 文戏/武打 values for later generation.
// 55: 剧本转视频提示词 is a global choice. The two built-in versions remain bundled; users can upload
//     txt/md/docx documents, which are copied into DSH_HOME and become the authoritative file for the
//     `drama-episode-video-prompts` skill. The skill provider appends that exact path, so the model
//     cannot quietly fall back to the old version table.
// 56: the 视频提示词 side of the panel shows the active prompt source and lets the user change it
//     before a confirmed 重新拆分镜. The confirmation is a panel decision, not a direct file write:
//     the Host persists the chosen source and enqueues one director turn that re-runs the writing
//     skill, writes the episode prompt, and splits it. Cancelling changes neither source nor files.
// 57: the asset panel starts from 资产盘点稿, not only from files. Inventory-only people/scenes/props
//     carry a name and introduction before any picture exists; character cards show a four-view by
//     default, expand to costume variants, and let the user replace the file or add a variant. Manual
//     assets survive refresh, and uploads write a new version beside the old files.
// 58: `@` may name a costume variant. The mention text is authoritative, the compiler keeps
//     `人物（服装）` in the H3 subject definition, and H3 resolves that spelling to the costume's
//     own four-view instead of falling back to the character's identity variant.
// 59: assets inside one identity folder are split by the variant written in the FILE name
//     (`周砚（戏服·四视图）` belongs to 戏服, not to the folder role 男主), while `3x/超分/四视图`
//     stay file descriptors. Scene and prop cards expose their own variants for multi-image assets,
//     and the panel keeps 视频/H3中文/H3英文 visible with a direct generation action when absent.
//     Reference resolution derives the real variant from the file path/name, honours the selected
//     or newest version, and the professional split format emits each mapping section only once.
//     A transient empty/failed reference refresh preserves the last good asset column, and a
//     panel read can resolve from a dry-run disk scan when the asset index is absent.
//     Inventory names with parentheses stay whole (`手机（林妙）`), legacy `3x` variants collapse
//     into the base asset, and scene references choose the upscaled file automatically.
// 60: the storyboard panel and the director share one mode/project context. The panel reads and
//     changes the same stored mode, selects the same active project the agent sees, and its
//     private route refuses GPU generation, H3 synchronization and model-based parsing outside
//     drama mode instead of bypassing tool registration. Diagnose reports the real mode.
// 61: a character asset has a first-row 9:16 full-body portrait per variant, separate from its
//     16:9 four-view. Both can be uploaded independently. Generating a four-view from that
//     portrait uses the configured image-edit workflow through the shared ComfyUI submission
//     path, then saves the result back to the same variant and selects the new version.
// 62: the director and storyboard share the current episode/source/shot, not just the project.
//     The panel persists that focus and `drama_mode status` exposes it as activeContext.
//     Production progress is rolled up onto video-prompt shots even when a candidate or job was
//     recorded against an H3 companion, and failed / download-failed / unknown submissions become
//     an actionable `needs-attention` bucket instead of looking merely "ready". A card can queue
//     a read-only director review of the exact saved shot without writing or starting a GPU.
// 63: one 大分镜 may keep several generated videos. The shot generation area exposes a compact
//     video-cache strip, defaults the preview to the newest clip, and lets the user switch clips.
//     Candidate/job block numbers are clamped to the current final block after a re-split, so an
//     old block 8 remains on new block 7 when the episode now has only seven blocks. Reference
//     resolving is presentation-only and no longer advances the document revision mid-edit.
// 64: when neither 图像超分 nor 视频超分 has an explicit workflow selection, both default to the
//     scanned VOSR2 workflow. A saved user choice still wins.
// 65: legacy result candidates without shotId/episode/block are recovered from the exact H3 text
//     stored in their generation request, so existing clips appear in the matching shot preview
//     without being regenerated. Ambiguous request text is left unassigned.
// 66: a re-scan treats the disk as the current truth for asset files. A file moved between
//     variants keeps its version id and loses the stale missing/old-path state; duplicate
//     records left in the former variant are removed. A genuinely replaced file still keeps
//     its old version, marked missing, so existing bindings are reported rather than rewritten.
// 67: per-episode `本集所需资产/` copies are part of the asset library. A copy whose bytes are
//     not in the global asset tree becomes a historical version with its episode numbers, so a
//     local image can no longer exist in the project while being absent from the asset page.
//     Historical copies never replace the global current version unless the user selects one.
// 68: asset detail can request the original image instead of a thumbnail. The image preview cap
//     is raised to hold full-resolution 10-15 MB scene renders, which the old 12 MB limit
//     rejected even though the 56 px grid thumbnail still looked fine.
// 69: a character variant's primary main image is its 定妆照. Generating a four-view accepts
//     primary as the source, then runs the configured image-upscale workflow at 3x on the same
//     ComfyUI instance before registering the final quadview as the variant's current version.
// 70: process-level preflights from the first real production. `generate-h3` names missing
//     index/shotId/expectedText explicitly and can inherit duration from the sibling video
//     prompt; health checks the 4-15 second H3 limit plus body-duration and no-dialogue rules;
//     sync_asset hashes bytes and rejects dataset variants that do not exist; planned inventory
//     records are separable from file-backed assets; an existing project re-runs init idempotently.
// 71: the panel learns whether it may SAVE before the user types, not after. `mode` and `projects`
//     report `writeAccess` ({ mode, workspaceRoot, projectRoot, writable, reason }) computed from
//     the SAME policy the write is judged by, and a sandbox refusal is EXPLAINED instead of passed
//     through raw. The real answer was `cannot write "D:\...": file access denied under
//     workspace-write mode`, surfaced as 「自动保存失败，草稿已保留」, which reads as a save bug and
//     is really a boundary: a short-drama project lives under the design root while the panel
//     writes under the CALLING session's workspace (its cwd), so the two are usually different
//     folders. `writable` is tri-state on purpose - `null` means "could not tell" and must never be
//     rendered as read-only, because a panel that cries wolf is the same bug wearing a hat.
// 72: the rules a real production broke on, encoded where they ship. Every one of these cost a
//     wasted batch, and none of them was a code bug in the narrow sense:
//     - a `（…）` in a SCENE / PROP / group asset's name is read as a variant (`青岚宗弟子（群像）`
//       became asset + variant and the @ bound another group's picture). Skills now say parentheses
//       belong to character costumes only, and `health` reports the ones that do not comply.
//     - the scene anchor sentence was live action (`ARRI Alexa 实拍 … 非三维渲染`) for EVERY art
//       style, so a 3D project produced photographs. The scene spec now ships three complete sets
//       (真人 / 3D动漫 / 动画) and the prompt rules pick one by the project's 画风.
//     - `expectedText` that differed by one space was treated as "somebody edited this block". The
//       guard now compares whitespace-insensitively (`sameBlockText`): an edit that only moves
//       spaces has not changed what the prompt says, and refusing it made the user's own paragraph
//       look unsaveable. The WRITER still writes exactly what it was given.
//     - `generate-h3` addressed by a `shotId` taken from ANOTHER document answered "no such shotId"
//       and stopped there. The message now says shotId is per-document and gives the index range.
//     - a thin submission receipt (no prompt id) read as failure. The receipt now names the ledger
//       id and the prompt id when it has them, and otherwise says to look the run up in `jobs`
//       rather than submit again - the GPU was already spent.
//     - seeds: `Seed (rgthree)` defaults to 0, so "run it again" produced the IDENTICAL image. The
//       skill now requires an explicit random seed on every submission and names the observed nodes
//       as examples to re-discover.
//     - non-humanoid characters (beast / object / spirit / crowd) are excluded from the four-view
//       template, which hard-codes humanoid constraints and grew a human body onto a beast.
//     - one instruction lives in several H3 fields; editing one left the other standing (an
//       off-screen voice came back). Editing now means searching the whole prompt.
// 73: the four things the next real run broke on.
//     - 「生成英文 H3」 was impossible from the panel: it asks for the English version FROM the 中文
//       H3 (that is where the user's edits live), but `compile-h3` refused every H3 input before the
//       translation branch could run, so the answer was a complaint about the input format. The guard
//       now applies only to the COMPILE path (`language: 'zh'`), which is the only path that reads a
//       视频提示词, and the English files' episode number comes from the episode record instead of a
//       `split('/')` on a Windows path (that split once turned episode 1 into episode 48).
//     - a character variant with a picture but no 四视图 is now a health finding
//       (`variant-missing-quadview`). The four-view is the file the video model is fed, so a variant
//       without one silently falls back to the costume of the whole character. Reported, never
//       queued - starting GPU work from a health check is what hard constraint 10 forbids.
//     - rules that only existed in someone's head are now in the skills, where they ship: multi-image
//       generation goes through the Qwen 2.1 edit workflow with its image_2/3 slots OPENED (never a
//       reference downgraded to prose), a costume variant is not finished until it has its own
//       four-view, and shots are generated 1→N one at a time.
// 74: an upload is checked BEFORE it is sent, because the failure it prevents is unreadable. A 1x1 PNG
//     reached `LoadImage`; ComfyUI's video-capable loader tried to decode it as a container and FFmpeg
//     answered `Invalid argument returned 22` (`av.error.ArgumentError`) pointing at a node id - which
//     reads as "the video workflow is broken" and cost a queue slot to learn. `lib/image-guard.js`
//     now parses the header (PNG / JPEG / WebP / GIF / BMP) and refuses: not-an-image, empty, a picture
//     whose payload was cut off (PNG missing IDAT/IEND, JPEG missing EOI), and anything under 64 px on
//     a side - named with its bytes and pixels, before any network call.
// 75: 「这一集还没有中文 H3」 on a project that plainly HAS one. The translation path filtered the Chinese
//     source's files on `blockNumber > 0`, which only the SPLIT shape has
//     (`第1集H3提示词-大分镜K（中文）.txt`). A single document holding every block - written by hand, or
//     filled by 一键同步 before anything was compiled - carries no 大分镜 number in its FILE NAME, so it
//     was filtered out and the answer was "no Chinese H3" while a 53 KB Chinese document sat right
//     there. The shape on disk now decides the output: split in, one English file per block; one
//     document in, ONE `第N集H3提示词（英文）.txt` out - every block translated, each 【大分镜N】 heading
//     kept, and a heading-less prompt left heading-less. `englishSiblingName` owns that name.
// 76: H3 reference files are now separate from the authored prompt text. Uploading to a
//     `<Picture N>` slot binds that exact asset version without rewriting the definition line;
//     removing the material records a detached slot instead of deleting text. Slot decisions are
//     tied to the definition snapshot, so editing the line immediately makes the text authoritative
//     again. Same-name generic duplicates are resolved to the canonical character/scene/prop asset.
// 77: English H3 translation no longer rejects the Chinese proper names it was explicitly told to
//     preserve, uses the calling session's model route and session id, tolerates a JSON object with
//     surrounding model prose, and translates a one-document episode in bounded parallel batches so
//     a 13-大分镜 file no longer overruns the former four-minute tool deadline.
// 78: Re-uploading identical bytes into the same asset variant and role reuses that version instead
//     of writing a duplicate beside it. The import response resolves the binding through content
//     paths as well as canonical path/name, so a deduped upload still returns a thumbnail reference.
//     Re-uploading a slot authored as `<Subject N> 是 <Picture M> ...` no longer inserts a second
//     `<Picture M>` definition into the prompt.
// 79: generate-h3 accepts the panel's current referenceSlots snapshot, resolves ordered uploads from
//     it, and persists it before submission. A just-uploaded picture therefore reaches ComfyUI even
//     when the document metadata has not caught up yet.
// 80: a bound slot's uploaded asset now overrides the stale character name in the MODEL-FACING H3
//     text. The authored prompt file is untouched; dialogue and quoted on-screen text stay verbatim,
//     while Subject lines and descriptive prose use the asset actually uploaded for that slot.
// 81: English H3 translation retries once when the model drifts structurally, and a persistent drift
//     names the exact field plus the first changed shot/reference/time/dialogue token. Auth, quota and
//     transport failures are never retried as if they were bad translations.
// 82: English H3 translation now keeps the Chinese document as the structural source. Fields, lines,
//     markers, shot numbers, timecodes, asset names, dialogue and quoted on-screen text are copied
//     verbatim; the model receives only the remaining prose fragments and they are reinserted by id.
// 83: prose translation is split into bounded batches. A batch that still ends with `max-tokens` is
//     halved and retried instead of failing the whole H3 block; token budgets scale with fragment size.
// 84: H3 English is removed from the short-drama workflow. Chinese H3 is the only generated and
//     uploaded prompt; its six field names remain English and its body remains Chinese. Legacy English
//     files stay on disk untouched but are hidden from the panel and refused by compile/sync/generate.
// 85: general mode has one generation surface for 文生图 / 图片编辑 / 图像超分 / 视频超分 / 视频生成.
//     Every task resolves its saved workflow and local/cloud endpoint from 全局配置; video upscale
//     uploads through a generic media input, Qwen edits are normalized to the official Edit Prompt
//     shape, and four-view generation uses an explicit 16:9 canvas instead of the portrait reference
//     canvas. Asset-production skills no longer pin workflow filenames or override the upscale endpoint.
// 86: the Qwen Edit Prompt normalizer is shared by the general form and direct asset submissions.
//     Direct `comfy_run task=image-edit` calls normalize the patched prompt and choose the matching
//     reference/target canvas from the actual ComfySwitchNode wiring; four-view prompts use the
//     same normalizer. Skill instructions now name tasks instead of fixed workflow files.
// 87: general video generation uses an H3-style nine-slot Picture bar and image editing uses an
//     ordered Qwen <imageN> bar. Both can pull images from the project asset library without
//     base64-encoding the full file; the Host resolves opaque media handles to local inputs and
//     preserves slot/order when it submits the workflow.
// 88: the general H3 asset bar now also exposes three Audio and three Video slots. The Host clones
//     the workflow's LoadAudio/VHS_LoadVideo nodes, binds them to the target ReferenceToVideo node,
//     uploads each medium through mediaInputs, and validates Picture/Audio/Video numbering separately.
// 89: the panel can create a complete blank project and add blank episodes. Each episode starts
//     with one empty 大分镜; new episodes reuse the project-level asset library. An optional uploaded
//     script is handed to the director to produce only the asset inventory. Manual assets no longer
//     require an introduction.
// 90: new projects allocate shot identities immediately; a single uploaded script also populates
//     episode one; image/video upscale use separate workflows and video upscale targets a named
//     resolution; cloud launch is non-interactive-safe; prune is confirmed and undoable; transient
//     compare outputs never become candidates; H3 can fill missing companion blocks from video.
// 91: asynchronous H3 collection preserves episode/block coordinates, and progress recovers them
//     from the immutable job plan so a completed shot becomes 待选用 without a manual refresh.
// 92: video-prompt asset-bar selections are independent from edits to the prompt text. Deleting
//     an `@` mention or rewriting prose keeps the selected file; only the card's explicit remove
//     action (`removeReferenceIds`) detaches it.
// 93: H3 sync preserves every explicitly bound Picture slot as well as Audio/Video. A block-local
//     extra-reference mapping is an explicit user choice even when the prose does not repeat its
//     `@name`; empty Picture tombstones still rebuild from the video prompt.
// 94: one-click H3 sync is a model conversion of the latest video-prompt block. The model writes the
//     H3 prose/sound fields; code owns and locks the Subject/Picture/Audio/Video mapping and every
//     explicit user-bound material slot.
// 95: the latest video prompt is the sole reference authority. An old H3 slot no longer survives
//     merely because it was bound. Functional references such as `初始站位参考@file` parse without a
//     colon and are written by ROLE, never by the uploaded image's file name.
// 96: H3 model conversion is field-batched. A max-tokens response retries with a larger budget, then
//     splits multi-field batches and continues, instead of failing the whole synchronization.
// 97: conversion no longer imposes a small application maxTokens cap. It uses the model adapter's
//     default output budget (256k for the shipped DeepSeek adapter), selects the lowest supported
//     reasoning effort, and keeps field batching only as a recovery path.
// 98: H3 sync reports source/h3 asset counts and a source asset-bar projection while mirroring the
//     latest video prompt exactly. Paired structural edits are transactional, and a no-op save keeps
//     stable shot identity so a following insert/delete cannot silently fall back to a bare index.
// 99: the discarded-slot audit reads the current H3 document through its project-bound metadata,
//     so old duplicate assets and stale media are reported even when the caller sends no old slots.
//     Paired structural edits also allow a safely aligned trailing count mismatch instead of
//     refusing every edit until the two documents have exactly the same number of blocks.
// 100: one-click H3 sync falls back to the structured conversion of the SAME latest video-prompt
//      block when model output exhausts its budget or is malformed, instead of leaving both the
//      H3 text and asset bar untouched. The sync response carries the already-rebuilt display
//      references so the panel paints the latest video asset bar before any refresh can fail.
// 101: an absent Chinese H3 document is represented by ordinary editable H3 cards instead of a
//      read-only preview. The first non-empty edit or sync creates its standard per-block file
//      with createIfAbsent; sync and reference resolution work before that file exists; paired
//      insert/delete on the empty H3 tab edits the shared video block sequence without creating
//      placeholder files.
// 102: reusable production-workflow memories live outside the package, are injected into the
//      relevant loaded drama skills, and survive plugin upgrades. User skill additions and
//      user-created skills use the same external layer; corrupt/future memory files remain
//      inspectable instead of being silently truncated.
// 103: general image-edit prompts have an explicit processing mode in both the panel and direct
//      comfy_run calls. qwen-official asks the current session model for the Qwen-Image-2.1 edit
//      contract without sending image bytes; raw carries the user's text to the workflow unchanged.
//      A failed or contract-invalid model conversion submits no GPU job.
// 104: Qwen edit conversion is a separate preview step. The Host reads every ordered reference as
//      a real image attachment, rejects text-only routes and unreadable images, and the panel edits
//      the validated prose in place. Generation submits qwen-converted without a second model call;
//      raw remains a direct, byte-for-byte path.
// 105: release hardening. Request intents and mutable JSON indexes are serialized across writers;
//      unconfirmed submissions cannot be retried automatically; project metadata uses the caller's
//      sandbox; panel/media routes fail closed and require a real session; media roots compare real
//      paths; portable launch reuses installation discovery; default workspace roots avoid a bare
//      system drive; result indexes and state updates no longer lose concurrent writes.
// 106: 剧本转视频提示词 adds the bundled 竖屏真人专业版·镜头执行版. Its new
//      大分镜→映射→场景光源→起始调度→镜头清单 fields are adapted into H3 without leaking
//      production sections. The director and asset-production skills also make base assets the
//      only text-to-image case: every scene/costume/prop variant must be edited from the original.
//      The previous 竖屏真人专业版 is no longer bundled; users may upload their own saved copy.
// 107: block allocation is no longer a code-only split. Re-splitting hands the generated video
//      prompt to the model for a fresh 1–4-shot / ≤15-second block decision, and split-episode
//      fails closed instead of flattening a document that has no confirmed 【大分镜N】 headings.
// 108: project deletion moves a confirmed project into a sibling .trash directory and clears its
//      state registration; stale manually-deleted projects are pruned on project-list reads.
//      General generation persists a requestId before submission, restores running jobs by that
//      request id after a view remount, and exposes elapsed time from the original submission.
// 109: asset inventory parsing is structure-gated; whole assets can be deleted to trash with
//      tombstones that survive refresh; imports merge into the existing same-kind asset and
//      canonicalise mislabelled image extensions; replace accepts sourcePath; four-view
//      recovery is content-hash only. Image tasks auto-seed active sampler/helper nodes,
//      resolve all %date: output prefixes, and accept labelled aspect ratios. H3 speaker ids
//      follow Subject numbers, retention tracks shot-level appearances, read returns shot.text,
//      and the shipped H3 organization is one file per 大分镜.
// 110: real 万骨天骄 input exposed four remaining H3/read defects. Omitted `开口说` subjects now
//      ignore gaze/directional objects and bind to the actual speaker's Subject; retention counts
//      only visible shot appearances; repeated per-block mapping rows dedupe to the episode asset
//      set; block duration sums the small-shot durations; shot counts anchor `[Shot N]` to line
//      starts; and generate-h3 treats expectedText as an optional stale-editor guard.
// 111: the asset bar dedupes duplicate index records by media type + role + relative path + sha256,
//      so sync-h3 no longer calls two records "ambiguous" when they point at one file. sync-h3
//      accepts either the standard H3 file or the source video prompt, and infers the block from a
//      `大分镜N` filename. Subjects absent from every shot receive a validator-valid parenthetical
//      weak_reference line. Empty/non-string ComfyUI base URL configuration no longer reaches trim().
// 112: minimal registered-H3 generation and the diagnostic error boundary.
// 113: the actual sandbox API mismatch. `runnerIo` passed a path STRING to
//      `SandboxedFileSystem.checkedTarget`, which expects a resolved target object. Under
//      workspace-write the string's `displayPath` was undefined and dsh-fs-local threw on
//      `path.trim()`. The runner now resolves the path first, checks that exact target, then
//      creates/writes only the returned targetKey. The integration test now runs with the real
//      SandboxedFileSystem + workspace-write policy instead of LocalFileSystem/danger-full-access.
// 114: sandbox policy is taken from `exec.agent.session`, the same live session object DSH's own
//      tools use, instead of a second lookup through config.sessions that could miss the session's
//      danger-full-access override and fall back to deployment workspace-write. The resolved policy
//      travels into the shared ComfyUI runner, and all metadata/result/thumbnail/lock helpers now
//      resolve a target before checkedTarget. Sandbox errors no longer claim an agent call has a
//      browser draft.
// 115: general-mode image/video generation carries the caller's already-resolved sandbox policy into
//      the shared runner. The runner also checks its output directory before upload or submission,
//      so an unwritable target can no longer reach a GPU queue and fail only while saving.
// 116: collection job states are monotonic. Concurrent watcher/panel/job reads can no longer turn a
//      saved result back into completed; stale queued attempts no longer outrank a newer candidate
//      on the storyboard; and general video history reports disk-backed files as saved with fresh
//      media handles, so the finished clip remains playable after polling or a page reload. Polling
//      heartbeats no longer append duplicate events, and the jobs view shows the latest 24 tasks
//      with a compact state trail instead of hundreds of repeated lines.
// 117: general result-cache updates merge against the LIVE in-memory list, not the handle-free
//      localStorage copy. Submitting a new task therefore cannot erase the preview handles of
//      older completed videos.
// 118: inventory Markdown tables are parsed by ROLE. Character variant tables attach costume/state
//      variants to the base character instead of minting one asset per row; group tables create
//      group assets; the episode summary skips voices, shadows, group-only stand-ins and arrow
//      transition spellings. Placeholder headers and prose fragments can no longer become cards.
// 119: character four-view edit and 3x upscale use the injected shared workflow runner and carry
//      the caller's already-resolved sandbox policy. A session with danger-full-access no longer
//      falls back to deployment workspace-write when writing .director/character-quadview.
// 120: the asset-card missing badge is actionable, not historical. Only a missing selected/current
//      binding raises `missingCount`; absent replaced versions remain available as
//      `missingVersionCount` for detail, so an asset with a valid current image no longer shows
//      “缺 3” just because old generations were removed.
// 121: missing historical records can be permanently pruned from the asset index. The detail view
//      exposes a confirmed bulk cleanup; selected missing bindings are refused until another
//      available version is selected, so pruning cannot silently break the current input.
// 122: media handles include a file-version signature. Replacing bytes at the same path mints a new
//      handle, so the detail preview cannot keep serving the previous large image from the browser
//      cache while the content-addressed thumbnail already shows the new file.
// 123: compiled H3 documents carry their source 大分镜 number. Generation, duration lookup and
//      result naming share one resolver over the title, filename and explicit parameter; a
//      disagreement is refused instead of silently treating every one-block file as 大分镜 1.
// 124: ComfyUI `/object_info` is cached for at most 30 seconds. If a converted graph names a
//      missing active node class, the runner force-refreshes the capability map and retries once
//      before refusing. Installing a custom node and restarting ComfyUI no longer leaves the
//      panel permanently stuck on the pre-install class list.
// 125: the current session model can adapt an unknown but existing general-mode workflow. The
//      model may only bind task-facing semantic roles to existing scalar node inputs; code rejects
//      invented nodes, links, model-file replacements and wrong types, stores the verified binding
//      profile in the external user layer, and reuses it by workflow hash + instance capability hash.
// 126: asset-inventory identity now uses the same normalization as the disk scanner. Leading row
//      ordinals are shared, episode-summary mentions no longer mint picture-less cards, sound-only
//      blocks are ignored, and legacy parenthesized names merge into their real file-backed asset.
// 127: a Markdown heading that only wraps a structured asset table is a container, not an asset.
//      `### 群像资产（群演合并处理，不做特写与四视图）` no longer creates a seventh empty card
//      beside the six real rows declared by its table.
// 128: the asset detail page shows one representative image per real variant and keeps version
//      history collapsed. Character uploads can infer front vs quadview, while four-view editing
//      and 3x upscaling are independent actions with separate workflow submissions.
// 129: variant identity ignores file-role suffixes. Multiple parenthesised file names such as
//      `谢妄（魔化）（四视图）3x` stay in the 魔化 variant, old split variants merge into one,
//      internal `_rejected` folders are not scanned, and the upscaled quadview is the default input.
// 130: character variant uploads stay under the existing identity folder, a bare folder used only
//      as a variant container cannot become the identity, references dedupe identical file content
//      across old paths, and video-prompt asset removal deletes only the exact @mention token.
// 131: document metadata persists each block's authored 大分镜 number separately from its file
//      order. Progress and candidate matching use that source number, so a block-1 candidate cannot
//      make every single-block file look like block 1.
// 132: saved video-prompt references are merged by their visible slot (`@name` / `<Picture N>`).
//      Legacy duplicate versions with no occurrences collapse into one card, and a matching-version
//      thumbnail is carried forward instead of rendering a blank duplicate.
// 133: the task panel's Refresh now re-queries ComfyUI, downloads completed outputs, records
//      candidates, and reloads progress/results. `submission_unknown` jobs are refreshable so a
//      disconnected cloud result can be recovered after the instance returns.
// 134: generate-h3 derives a stable idempotency request id from the exact project, block, prompt,
//      settings and ordered references when the caller omits one. Asset mention resolution ignores
//      inventory-only shells beside a real file-backed asset, and equal bookkeeping versions use a
//      stable filename identity. H3 binding failures name the asset, variant and competing files.
//      Asset prompt skills emit positive prompts only: no negative-prompt section and no Midjourney
//      flags, matching the zeroed negative channel in the shipped Krea2 workflow.
// 135: a successful cloud workflow listing is authoritative. Workflow JSON files removed from the
//      cloud instance are also deleted from the local mirror, so stale files cannot remain
//      selectable or be submitted after the remote owner has deleted them.
// 136: asset four-view generation derives a fresh request id for every implicit new run. Reusing
//      the same source portrait no longer reuses an id after the workflow seed changes; an explicit
//      request id still keeps strict retry/idempotency semantics.
// 137: professional episode-prompt templates are upload-only. The package no longer ships either
//      national/vertical professional prompt, so upgrades cannot resurrect a retired built-in
//      source or select one behind the user's back.
// 138: workflow memory has a non-empty built-in baseline for fresh installations, while existing
//      user memory files remain untouched. The ComfyUI deployment skill also names the public
//      Quark package route directly in both SKILL.md and DEPLOY.md.
// 139: paired storyboard insert supports H3 stored as one file per 大分镜. Later H3 files,
//      headings and metadata records move together as one rollback boundary; copy and blank
//      insertion create the corresponding H3 file without losing existing shot identities.
// 140: insert returns the new 大分镜 number, copy preserves prompt inputs and reference slots
//      without carrying generated results, blank creates an empty shot, and per-shot H3 metadata
//      records its real source number so jobs and previews follow stable shot identities.
// 141: paired delete supports one H3 file per 大分镜. The target H3 file is removed, later files
//      move back with their headings and metadata identities, and the whole tree rolls back if
//      any part of the deletion fails.
// 142: a video source may contain both per-block files and a grouped episode document. Per-block
//      files win for their numbers, the grouped document supplies only the uncovered tail, and
//      paired insert/delete renumber that tail before creating the adjacent video and H3 files.
//      Sync also dedupes references by semantic asset/version, not raw file bytes, so two distinct
//      pictures with identical pixels remain two H3 slots.
export const HOST_CONTRACT_VERSION = 142;

/**
 * Discrete Host capabilities, newest last.
 *
 * Names describe what the Host GUARANTEES, not what it happens to do. A Client may branch
 * on any name here; it must not branch on a name that is absent, and it must not assume a
 * capability exists because the version number is high enough - versions are for humans,
 * this list is for code.
 */
export const HOST_CAPABILITIES = Object.freeze([
  'panel.authenticated-image-preview',
  'panel.autosave',
  'h3.sync-from-video',
  'h3.sync-model-conversion',
  'h3.sync-field-batched-model',
  'h3.sync-adapter-default-token-budget',
  'h3.sync-source-authoritative',
  'h3.sync-source-authoritative-assets',
  'h3.sync-functional-reference-role',
  'h3.sync-reports-discarded-slots',
  'h3.sync-field-recovery',
  'h3.sync-compiled-fallback',
  'h3.sync-immediate-asset-projection',
  'h3.missing-file-editable',
  'h3.create-on-first-write',
  'h3.sync-missing-target',
  'h3.references-before-create',
  'storyboard.paired-missing-h3-structure',
  'storyboard.paired-structural-edit-transaction',
  'storyboard.paired-edit-safe-prefix-mismatch',
  'storyboard.model-assigned-blocks',
  'storyboard.project-delete-to-trash',
  'generation.job-recovery-by-request',
  'panel.generation-elapsed',
  'assets.inventory-structure-guard',
  'assets.inventory-table-roles', // variant tables attach to a character; group/summary rows do not mint duplicates
  'assets.delete-whole',
  'assets.import-merge-existing',
  'assets.image-extension-normalized',
  'assets.replace-source-path',
  'images.auto-seed',
  'images.filename-prefix-resolved',
  'images.aspect-label-normalized',
  'h3.subject-speaker-id',
  'h3.retention-shot-scoped',
  'h3.dialogue-speaker-follows-subject',
  'h3.retention-excludes-gaze-targets',
  'h3.mapping-deduped',
  'h3.duration-summed-from-shots',
  'h3.expected-text-optional',
  'h3.source-block-identity',
  'h3.asset-bar-file-dedupe',
  'h3.retention-empty-subject-marker',
  'h3.sync-accepts-video-source',
  'h3.sync-infers-block',
  'h3.generate-error-stack',
  'comfy.sandboxed-output-target',
  'generation.general-sandbox-policy', // panel generations carry the live policy and preflight their output directory
  'generation.collection-state-monotonic', // concurrent collection cannot regress saved to completed
  'progress.candidate-supersedes-stale-jobs', // older stranded attempts do not hide a finished shot
  'jobs.heartbeat-no-duplicate-events', // polling updates liveness without growing the event trail
  'panel.job-trail-compacted', // one visible step per distinct task state
  'panel.general-result-handles-preserved', // a new submission never wipes older live video handles
  'session.live-policy-resolution',
  'panel.sandbox-message-agent-safe',
  'storyboard.read-includes-text',
  'storyboard.shot-count-line-anchored',
  'h3.one-file-per-block',
  'comfy.base-url-type-safe',
  'h3.sidebar-generation',
  'h3.resolution-aspect-mode',
  // --- installation answers, after the outside test run found them split ---
  'install.uses-discovery',         // check/detection uses the same discovery as the launcher, so "installed" cannot disagree
  'install.reports-searched',       // a "not installed" answer names the places that were searched
  'launch.status-reports-installs', // status distinguishes "no launcher script" from "not installed"
  'inventory.reports-discovered',   // comfy_inventory lists the installs it found, not the configured hints
  'cloud.script-discovered',        // the tunnel script is found in the usual places when none is configured
  'job.address-via-chooser',        // comfy_job resolves its instance the same way comfy_run does
  'panel.settings-action-valid',    // settings/health/diagnose return exactly what their schema declares
  'project.absolute-path',          // an absolute project path is honoured instead of joined onto the root
  'assets.self-scan-on-empty',      // an empty library beside a populated asset tree scans itself
  'jobs.stale-split-from-live',     // ledger records older than a day are reported as history, not as work in flight
  // --- the full-flow + panel test batch ---
  'h3.workflow-by-capability',      // selection and generation share `describeH3Workflow`, so they cannot disagree
  'h3.old-graph-format',            // positional `widgets_values` graphs are driven too (duration node by class + title)
  'h3.split-sigmas-first-pass',     // `SplitSigmas.step` counts as the first-pass step count
  'h3.block-duration-from-video',   // an H3 block reports the 大分镜's duration for the panel's time selector
  'h3.english-compile',             // `language: 'en'` reaches compile-h3/split-episode (the parameter was missing)
  'h3.english-translated',          // the English file is translated, not re-labelled; a failure writes nothing
  'panel.english-action',           // the panel lists 英文 beside 中文 as a companion source (no extra control)
  'h3.companion-english',           // compiling 中文 creates the missing 英文 siblings
  'h3.english-from-chinese',        // 英文 is translated from the 中文 H3, never recompiled from the video prompt
  'panel.h3-update-action',         // the English tab's action reads 一键更新 and targets the English file
  'storyboard.heading-less-write',  // a document with no 大分镜 heading is saved as a whole block (H3 prompts)
  'health.mapping-per-block',       // health reports a 视频提示词 whose mapping is not inside each 大分镜
  'split.no-heading-lines',         // a split 大分镜 file starts at 【大分镜N】 with its own mapping, no #/### title
  'split.project-style',            // 【画面风格和类型】 defaults to the project's chosen 画风, not to nothing
  'panel.references-no-flicker',
  'h3.dialogue-both-forms',
  'h3.aim-clause-direction',
  'references.exact-name-tiebreak',  // @名字 resolves to the asset named exactly that, not a derived match
  'references.candidate-choice',     // a real same-name tie lists candidates and accepts the user's choice
  'panel.global-config',             // panel-wide task workflow choices and local/cloud status
  'panel.prompt-source-config',      // 剧本转视频提示词: built-in versions plus uploaded txt/md/docx documents
  'panel.prompt-source-execution-cut', // the bundled vertical live-action execution-cut prompt is selectable
  'panel.script-prompt-resplit',      // 视频提示词 shows its source; a confirmed re-split enqueues one director turn
  'assets.inventory-projection',      // 盘点稿 supplies names, introductions and costume variants before files exist
  'assets.inventory-scan-aligned',    // inventory and disk scan share canonical names; summary mentions never mint blank cards
  'assets.manual-records',            // users can add people/scenes/props and costume variants without a picture
  'assets.variant-upload',            // replacing a four-view/picture keeps identity and appends a file version
  'assets.character-portrait',        // each character variant exposes a separate 9:16 full-body portrait
  'assets.character-quadview-generation', // portrait -> saved 16:9 four-view through the shared GPU submission path
  'assets.character-quadview-live-policy', // quadview edit/upscale carry the live session policy and shared runner
  'panel.asset-workbench',            // the asset tab is organised around characters, scenes, props and reference audio
  'assets.filename-variant-qualifiers', // variants in file names win over a role qualifier in the folder name
  'panel.scene-variants',             // scenes and props expose variants, uploads and new-variant controls like characters
  'panel.prompt-version-placeholders', // 视频/H3中文/H3英文 remain visible when absent and offer their creation action
  'assets.inventory-parenthesized-name', // an exact inventory name like 手机（林妙） is one asset, not a variant
  'assets.scale-suffix-collapsed',   // 3x/超分 is file quality and never a variant dropdown entry
  'references.scene-upscaled-default', // scene references upload the upscaled copy unless a version was explicitly pinned
  'video.workflow-sampling-config',  // editable H3 model/scheduler/steps written back to the workflow
  'comfy.workflow-by-task',          // comfy_run can use the configured workflow when workflow is omitted
  'panel.general-generation',        // general mode has one task surface for all five configured workflows
  'comfy.general-task-workflows',    // text/image edit/upscale/video resolve task + local/cloud from 全局配置
  'comfy.generic-media-input',       // video/audio loader inputs can be uploaded, not only LoadImage
  'images.qwen21-edit-prompt',       // image edits are normalized to the Qwen 2.1 Edit Prompt contract
  'images.qwen21-model-edit-prompt', // image edits can be rewritten by the current session model
  'images.qwen21-raw-edit-prompt',   // image edits can bypass both the model and local prompt wrapping
  'images.qwen21-convert-button',    // the panel converts first and shows the editable official prompt
  'images.qwen21-vision-edit-prompt', // ordered reference images are sent to the converting model
  'panel.general-h3-assets',         // general H3 exposes 9 Picture, 3 Audio and 3 Video project-asset slots
  'h3.general-audio-video-references', // general H3 binds cloned LoadAudio/VHS_LoadVideo nodes through mediaInputs
  'images.general-ordered-assets',   // general image edits keep Qwen <imageN> ordering across assets and uploads
  'assets.global-workflow-tasks',    // asset production does not pin a workflow outside 全局配置
  'h3.functional-reference-known-only',  // an unknown @name in a 功能参考 stays prose and is reported
  'panel.asset-kind',            // references carry the asset library category, so the asset column groups
  'panel.workbench',            // the panel also registers as a full-width main view with a left panel-list entry
  'h3.functional-references',  // 初始位置参考：@X becomes a numbered standalone reference with its role
  'h3.no-stray-at',             // an unmapped @ is dropped from the H3 and reported, never copied through      // 镜头对准 X carries the camera direction from 【摄像机景别】       // 开口说 / 画外音说 / 内心OS are converted too, not just 台词：
  'h3.shot-subject-focus',       // 【拍摄主体】 becomes 镜头对准 X at the start of the shot    // a re-resolution keeps the list on screen; prose edits do not re-resolve
  'results.named-by-code',          // `<code>_<episode>_<block>(<k>)` from one module, used for display AND disk
  'results.save-to-episode',        // 存到本集 writes 剧集/第N集/成片/ without the asset tree or a selection
  'project.code-setting',           // the file-name code is a project decision, never a pinyin guess
  'project.code-derived',           // the code defaults to the title's pinyin initials, read off ICU collation
  'project.init-creates-metadata',  // init writes .director/project.json, so settings works immediately
  'project.init-registers',         // init records the project, so drama_mode and the panel agree it exists
  'projects.create-blank',          // create a real project tree with settings and one empty episode per requested count
  'episodes.create-blank',          // add one empty episode while reusing project-level assets
  'projects.script-inventory-parse', // optional uploaded script queues a director turn limited to the asset inventory
  'assets.description-optional',    // manual people/scenes/props can be generated from a name before an introduction exists
  'paths.tolerant-matching',        // a prompt file matches by resolved path, not by identical string
  'results.role-preserved',         // selecting no longer overwrites the candidate's own role label
  'storyboard.action-schema-sweep', // every action is exercised against its own output schema
  // --- modes and tools ---
  'modes.general-drama',            // two modes, switched by /drama, tools filtered per mode
  'tools.mode-filtered',            // only the current mode's tools are registered
  'skills.mode-filtered',           // only the current mode's skills are offered
  'state.persisted-mode',           // the mode survives a restart (%DSH_HOME%/short-drama/state.json)

  // --- portability: this bundle is meant for somebody else's computer ---
  'env.discovers-installs',         // the install is discovered (config/env/state/siblings/scan), never compiled in
  'env.ranks-by-content',           // the copy in use wins over a leftover: workflow count, user db, models
  'env.configurable-search-roots',  // comfyuiSearchPaths / COMFYUI_SEARCH_PATHS pin the lookup without a code change
  'preset.ships-in-bundle',         // the 短剧制作导演 preset is declared by the bundle, not by the author's profile
  'media.no-bare-drive-root',       // media is granted the project and working folders, never a whole drive

  // --- storyboard panel ---
  'storyboard.panel',               // /storyboard command backs the right-hand panel
  'panel.write-access-reported',    // mode/projects say whether THIS session may save into the project, before anything is typed
  'panel.sandbox-denial-explained', // a workspace-write refusal names the two exits instead of echoing the fs message
  'write.whitespace-tolerant-guard', // expectedText that differs only by whitespace is not "somebody edited this block"
  'generate.receipt-names-handles',  // a submission receipt names jobId/promptId, or says to look the run up instead of re-submitting
  'health.asset-name-parenthesis',   // health reports scene/prop/group names carrying a parenthetical, which the library reads as a variant
  'compile-h3.english-from-h3',      // language=en takes the 中文 H3 itself (that IS the translation source), not only a 视频提示词
  'health.variant-missing-quadview', // health reports character variants whose files include no four-view
  'comfy.image-guard',               // an upload that is not a complete picture of >=64px a side is refused before the network
  'compile-h3.english-one-document', // a single Chinese H3 holding every block gets ONE （英文） sibling, not one file per block
  'storyboard.action.insert',       // insert a copy or a blank block after an index
  'storyboard.heading-dialects',    // 【大分镜N】, ## 大分镜 N, and ### 大分镜 N（总时长…）
  'storyboard.body-excludes-heading', // block text is the pasteable body, not the label
  'storyboard.recognises-empty',    // an unparsed file is an error, never a silent empty list
  'storyboard.sandbox-policy',      // writes are judged by the CALLER's sandbox mode
  'storyboard.stable-shot-ids',     // every block carries a shotId that survives insert/reorder/delete
  'storyboard.revision-guard',      // a write states expectedRevision; a stale one is refused
  'storyboard.migrate',             // adopt an existing project's blocks into ids, dry-run capable
  'storyboard.project-settings',    // action=settings reads/writes 画幅/画风/分辨率 on project.json
  'project.settings-defaults',      // those three are project DEFAULTS; the panel and the agent share one record
  'project.settings-block-generation', // a generation with an unanswered 画幅/画风 is refused, not defaulted silently
  'launcher.integrated-package',    // 绘世/Aki packages start via their own python + main.py, not a .bat
  'install.reports-layout',         // detection says integrated vs portable instead of "not found"
  'project.sidecar-metadata',       // project/episode/document/shot ids live in .director/, not in the prompts
  'project.write-lock',             // one writer per project, stale locks reclaimed only after checking the owner
  'project.atomic-writes',          // metadata and state are written via a unique temp file, then renamed

  // --- assets ---
  'assets.library',                 // Asset / AssetVariant / AssetFileVersion, stored in .director/assets.json
  'assets.content-hash',            // identity is sha256, not name or size: same bytes = one version, different bytes = new version
  'assets.role-aware-versions',     // a quadview does not raise the hero image's version; roles number independently
  'assets.preserve-bindings',       // a regeneration adds a version; an existing binding is never moved forward
  'assets.dry-run-refresh',         // refreshing can report what it would record without writing

  // --- references ---
  'references.bindings',            // an @ mention resolves to a concrete assetVersionId, not just a name
  'references.utf16-offsets',       // occurrence offsets are UTF-16 code units, correct across CJK and emoji
  'references.reports-unresolved',  // a mention that matches nothing is located by offset and blocks submission
  'references.reports-ambiguous',   // a mention with two defensible readings is asked about, never guessed
  'references.identity-variant',    // @角色名 resolves to the identity variant, so a costume is not required
  'references.costume-variant',     // @角色（服装） resolves to that variant's own four-view
  'h3.costume-variant-binding',     // H3 keeps the costume spelling and binds the matching variant file
  'references.file-derived-variant', // stale index entries cannot bind a costume file to the identity name
  'references.selected-version-binding', // the upload uses the selected/current version, not the first file
  'references.preserve-last-good',  // a transient empty/failed resolve never blanks a populated asset column
  'references.read-without-index',  // panel reads dry-scan the asset tree when assets.json has not been built
  'split.single-mapping-section',   // professional-format blocks keep one canonical mapping, never two
  'references.ordered-inputs',      // deduplicated upload list whose order matches the reference numbering
  'references.needs-review',        // re-validation marks a reference needs_review instead of rewriting the sentence
  'references.pinned-versions',     // a hand-pinned version survives re-parsing

  // --- jobs ---
  'jobs.durable-ledger',            // jobs are recorded on disk, so a restart does not lose them
  'jobs.intent-before-submit',      // the record is written before the instance is contacted
  'jobs.request-idempotency',       // the same requestId returns the same job, never a second run
  'jobs.submission-unknown',        // a POST with no reply is recorded and never retried automatically
  'jobs.download-failed-distinct',  // a failed download is not a failed generation
  'jobs.event-trail',               // each state change is timestamped, so "stuck" is distinguishable from "slow"
  'jobs.cancel-guard',              // instance-level interrupt is refused without explicit confirmation

  // --- media ---
  'media.opaque-handles',           // the panel receives a handle, never a path
  'media.root-confined',            // a handle outside the configured roots is refused even when valid
  'media.range-requests',           // a clip can be seeked and played in place
  'media.etag-caching',             // an unchanged file is not re-sent
  'media.handle-content-version',   // same path + changed bytes => new opaque handle and preview URL
  'media.type-allowlist',           // only known image/video/audio/text types are served

  // --- environment & projects ---
  'env.three-verdicts',             // 可做 / 需准备 / 暂不可做 per task, never a bare VRAM number
  'env.cloud-changes-verdict',      // a cloud route turns "cannot" into "needs a step"
  'env.no-launch-on-read',          // no read path spawns a process; starting needs explicit consent
  'projects.path-keyed',            // projects are identified by path, so same-named ones stay distinct
  'projects.refuse-foreign',        // creating on top of a different production is refused, not merged

  // --- results ---
  'results.candidate-area',         // a generation lands in .director/results, never in the asset tree
  'results.separate-selection',     // recording a result and choosing one are different calls
  'results.selection-survives',     // a selected version is not displaced by a newer file
  'results.selection-broken-reported', // a selection whose file vanished is reported, not silently moved
  'results.promote-requires-selection', // copying into the asset tree needs an explicit choice first
  'results.prune-keeps-selected',   // housekeeping never deletes the version in use
  'results.content-deduped',        // the same bytes from the same job is one candidate
  'panel.results-view',             // candidates are shown with their status, not as a gallery of finished work
  'panel.no-autoplay',              // a video candidate waits for a click and does not preload its bytes
  'panel.destination-required',     // copying into the asset tree needs a path the user supplies
  'panel.compare-two-up',           // two candidates side by side, in the order they were picked
  'panel.compare-same-media',       // a still and a clip are refused, with the reason
  'panel.compare-three-up',         // up to three panes, opened explicitly so the third stays reachable
  'panel.redo-recovers-inputs',     // redo returns the exact inputs; it never starts a job
  'panel.draft-recovery',           // unsaved text survives a reload and is labelled as a draft

  // --- thumbnails ---
  'thumbs.real-downscale',          // a thumbnail is scaled, not a copy under another name
  'thumbs.content-keyed-cache',     // keyed by sha256, so a changed source cannot serve a stale entry
  'thumbs.absent-not-faked',        // no scaler means no thumbnail, never a copy pretending to be one

  // --- identity ---
  'project.label-disambiguates',    // a picker can tell two same-titled projects apart
  'asset.selection-by-path',        // a promoted result points the asset side at the new file
  'references.persisted-per-shot',  // bindings are written back, and recording them is not a text edit

  // --- the QA matrix's remaining rows ---
  'slots.counted-from-wiring',      // capacity comes from the graph, not the model's spec sheet
  'job.cancel-by-prompt-id',        // removes one queue entry; never an instance-level interrupt
  'job.cancel-reports-running',     // a running entry reports instead of escalating
  'job.instance-changed',           // asking the wrong address is named, not read as "job gone"
  'run.no-output-is-an-error',      // completed with no file is NO_EXPECTED_OUTPUT, not success
  'panel.draft-conflict-keeps-both', // an outside edit under a draft loses neither side

  // --- reports: what needs doing, what is broken, what to send for help ---
  'progress.per-shot-buckets',      // each shot in one actionable bucket, with a reason
  'progress.blockers-first',        // a shot with missing assets is not reported as decided
  'health.findings-with-actions',   // every finding says what to do, and nothing is repaired silently
  'health.dangling-references',     // a reference to a deleted asset version is surfaced, not silent
  'diagnose.safe-to-send',          // no drive path, no tunnel host, no script title, no prompt text

  // --- source drift and duration ---
  'sources.drift-by-count',         // a different block count is drift, with no interpretation needed
  'sources.drift-is-review',        // same count + different content is "look at it", not a verdict
  'durations.checked-against-text', // the prompt text stays the only source of truth
  'durations.read-from-heading',    // （总时长：8 秒） is read, not left as opaque text

  // --- the preamble is shared context, not decoration ---
  'references.preamble-is-context', // 资产映射 before the first block binds every block
  'references.carry-thumbnails',    // each binding carries an opaque handle, so the bar shows the file
  'references.text-untouched',      // the preamble is resolved against but never written into the text

  // --- which handle the panel is allowed to show ---
  'panel.prefers-thumbnails',       // grids and pickers show the scaled handle, never the original
  'panel.detail-has-thumbnails',    // every version carries a scaled handle beside its original
  'panel.compare-uses-original',    // the close look stays full resolution on purpose

  // --- H3's own reference syntax ---
  'h3.picture-slots',               // <Picture N> is the slot number, so it is the upload order
  'h3.both-word-orders',            // 中文 puts the name after the number, English before
  'h3.sibling-supplies-names',      // a translated file takes its names from its sibling by number
  'h3.descriptive-names',           // prose about an asset resolves to it, only when unambiguous
  'h3.loose-match-is-scoped',       // containment never applies to @, where 林晚-军装 must not bind 林晚
  'compile.per-shot-block',         // one H3 prompt per 大分镜, not one per episode
  'compile.contiguous-pictures',    // each block numbers its own pictures from 1
  'compile.only-used-assets',       // a block carries only the assets its own text refers to
  'compile.alias-declaration',      // ｜别名： connects prose wording to a mapped asset
  'compile.reports-unused',         // an unmapped name is reported, never substituted
  'compile.read-until-written',     // compiling does not touch the episode folder unless asked
  'split.per-block-files',          // 视频提示词 is written one file per 大分镜
  'split.repeats-mapping',          // each file carries its own @ mapping for the assets it uses
  'split.counts-match-h3',          // N 大分镜 in, N H3 prompts out, by construction
  'split.source-holds-many',        // one source kind lists several files, ordered by 大分镜
  'split.trailing-section-cut',     // the episode's 自检 section stays out of every block

  // --- the /storyboard command ---
  // A command result carries ONLY `kind`, `text` and `sourceEventSeq`; the runtime rebuilds it field by
  // field, so `text` is simultaneously the machine channel and the text the conversation renders. These
  // three names describe how that tension is resolved.
  'command.summary-by-default',     // `/storyboard {...}` prints one line, not the whole payload
  'command.debug-json',             // `debug: true` answers with the machine-readable object instead
  'command.no-retry-on-write',      // the panel asks for JSON on its first call, never as a retry
  'command.record-input-off',       // the request half of a panel call is not replayed into the session log
  'panel.private-route',            // POST /short-drama/panel serves the panel without a session event
  'panel.route-probe',              // the panel decides route-vs-command once per session, by a GET probe
  'panel.refusal-not-transport',    // a refused action is a result, so a write is never re-sent on the other channel
  'panel.director-mode-context',    // panel projects/mode actions expose the same stored mode as drama_mode
  'panel.active-project-sync',      // choosing a project in the panel updates the director's active project
  'panel.active-shot-sync',         // episode/source/shot focus is persisted and returned to the director
  'panel.director-shot-review',     // a card queues a read-only review of the exact shot
  'panel.shot-video-cache',         // one shot keeps a compact switchable strip of generated videos
  'panel.preview-defaults-latest',  // the middle preview starts on the newest clip unless one is chosen
  'progress.production-shot-rollup',// candidates/jobs from H3 companions attach to the video-prompt shot
  'progress.clamped-block-rollup',  // blocks beyond a shorter re-split fold into the new final block
  'references.resolve-without-revision-bump', // resolving a draft never invalidates an in-flight save
  'references.video-prompt-retention', // video-prompt text edits never delete selected assets from the bar
  'generation.default-upscale-vosr2', // unset image/video upscale tasks resolve to VOSR2
  'results.recover-legacy-location', // old candidates regain episode/block from their request text
  'assets.disk-presence-reconciled', // rescan clears stale missing flags and folds reassigned duplicates
  'assets.episode-copies-registered', // episode-only files are historical versions, not invisible
  'assets.full-resolution-preview', // detail/lightbox can read the original, not only a thumbnail
  'assets.variant-fourview-upscale', // variant main image -> 16:9 four-view -> 3x upscale -> registered asset
  'assets.missing-count-actionable', // card warning counts broken current bindings, not removed history
  'assets.missing-version-prune', // confirmed cleanup removes absent records from assets.json
  'process.h3-parameter-preflight', // missing generate-h3 locator/body/duration is named before submission
  'process.video-prompt-lint',      // health catches >15s, body/heading mismatch, no-dialogue variants
  'process.asset-sync-hash-strict', // sync compares bytes and refuses missing dataset variants
  'process.planned-assets-separated', // inventory-only records do not poison file-backed resolution
  'process.workspace-init-idempotent', // existing project metadata is reused instead of refused
  'project.initial-shot-identities', // a new project can save immediately, without a manual migrate
  'project.episode-script-populated', // a single uploaded script is copied into episode one
  'project.episode-count-refreshed', // adding an episode updates the registry count
  'progress.failed-run-attention',  // failed and unresolved submissions are not reported as ready
  'storyboard.mode-gated-pipeline', // panel route refuses generation/model work outside drama mode
  'h3.duration-parameter',          // 生成视频 takes a 时长 choice, defaulting to the 大分镜 heading
  'h3.resolution-megapixels',       // 清晰度 maps to ResolutionSelector.megapixels 0.5 / 0.9 / 1.5
  'h3.steps-per-mode',              // 文戏 12/8, 武打 14/10 on the total and the first pass
  'h3.action-lora-chain',           // 武打 clears the bypass of its node group, leaving links and strengths alone
  'comfy.run-output-complete',      // comfy_run declares every field it returns
  'comfy.reused-answer-normalised', // a ledger replay describes files the same way a fresh run does
  'comfy.aspect-ratio-label',       // a short ratio is expanded to the node's own labelled choice
  'generation.separate-upscale-workflows', // image and video upscale have independent workflow files
  'generation.video-upscale-target-resolution', // video upscale targets 480p/720p/1080p/2K/4K
  'generation.transient-output-filter', // compare scratch files never become candidates
  'launch.noninteractive-cloud',     // redirected-stdin cloud launch uses the console-safe wait path
  'results.prune-confirmed-undo',    // prune is confirmed in the panel and restores from project trash
  'assets.retry-content-binding',    // retrying identical reference content resolves a binding
  'h3.fill-missing-from-video',      // missing H3 blocks can be compiled from the video source in-panel
  'panel.progress-live-polling',     // running production refreshes progress and results automatically
  'progress.async-candidate-coordinates', // completed async jobs keep/recover the shot's episode and block
  'panel.reference-target-size',     // destructive and compact controls meet the pointer target baseline

  // --- comfy ---
  'comfy.tools',                    // comfy_graph / inventory / install / launch / run / job / workflows
  'comfy.validate-before-submit',   // a failed patch or binding never reaches the instance
  'comfy.content-named-uploads',    // uploaded files are named by content hash, never by bare basename
  'comfy.workflow-precheck',        // scan / match / precheck for saved workflows
  'comfy.object-info-refresh',      // stale missing-node/class data is re-read after ComfyUI changes
  'workflow.model-assisted-adapter', // unknown compatible workflows get a validated, reusable binding profile

  // --- project ---
  'project.workspace',              // drama_workspace init/status/sync_asset
  'project.design-root',            // project root is configurable, never a hardcoded absolute path

  // --- handshake ---
  'host.publishes-version',         // this module: version + capabilities reachable from a tool
  'assets.reference-image-media',
  'assets.user-file-import',
  'assets.all-category-file-import',
  'assets.separate-video-audio',
  'panel.per-file-save',
  'panel.colored-mentions',
  'storyboard.expected-text',
  'host.single-storyboard-registration',
  'host.shared-media-runtime',
  'panel.command-media-handles',
  'storyboard.preserve-heading',
  'h3.reference-slot-overrides',
  'assets.content-dedupe-on-replace',
  'h3.generation-slot-snapshot',
  'h3.slot-identity-override',
  'h3.chinese-only',
  'workflow.memory-external',
  'workflow.memory-auto-recall',
  'customization.skill-overlays',
  'upgrade.user-data-preserved',
  'jobs.atomic-request-id',
  'jobs.unknown-never-auto-retry',
  'project.metadata-sandboxed',
  'media.realpath-confined',
  'panel.trust-fails-closed',
  'panel.session-required',
  'launcher.discovered-portable-start',
  'env.safe-default-workspace',
  'state.update-serialized',
  'results.record-serialized',
  'assets.variant-card-strip',
  'assets.upload-auto-role',
  'assets.quadview-generate-upscale-separate',
  'assets.variant-file-role-merge',
  'assets.character-variant-upload-identity-folder',
  'references.content-dedupe',
  'panel.video-reference-token-removal',
  'progress.source-block-number',
  'references.display-slot-dedupe',
  'jobs.manual-refresh-recovers',
  'jobs.submission-unknown-refreshable',
  'h3.auto-stable-request-id',
  'h3.reference-failure-details',
  'assets.stable-representative-version',
  'prompts.positive-only-assets',
  'workflows.cloud-cache-pruned',
  'assets.quadview-fresh-request-id',
  'prompts.professional-upload-only',
  'workflow.memory-seeded',
  'skills.comfyui-quark-source',
  'storyboard.paired-per-shot-h3-insert',
  'storyboard.insert-reports-block-number',
  'storyboard.copy-preserves-inputs',
  'storyboard.blank-shot-is-empty',
  'storyboard.h3-metadata-source-number',
  'storyboard.paired-per-shot-h3-delete',
  'storyboard.mixed-video-source-blocks',
  'h3.sync-semantic-reference-dedupe',
]);

/**
 * A stable, human-readable identity for the running Host half.
 *
 * `loadedAt` is the moment this module was first evaluated in the Host process. It is the
 * one field that settles "did my edit take effect": if the file was saved after `loadedAt`,
 * the running code is older than the file, and a restart is required. Comparing file
 * mtimes against it is deliberate - it needs no reload support from the runtime.
 */
const LOADED_AT = new Date().toISOString();

/**
 * @param extra - optional fields the caller can add (package version, config summary).
 * @returns the handshake payload the `version` action and every status report carry.
 */
export function hostIdentity(extra = {}) {
  return {
    plugin: 'dsh-plugin-short-drama-director',
    contractVersion: HOST_CONTRACT_VERSION,
    capabilities: [...HOST_CAPABILITIES],
    loadedAt: LOADED_AT,
    ...extra,
  };
}

/**
 * Whether this Host can satisfy everything a Client says it needs.
 *
 * @param required - capability names the Client will use.
 * @returns `{ ok, missing }`; `missing` is empty when `ok` is true.
 */
export function checkCapabilities(required) {
  const have = new Set(HOST_CAPABILITIES);
  const wanted = Array.isArray(required) ? required.map(String) : [];
  const missing = wanted.filter((entry) => !have.has(entry));
  return { ok: missing.length === 0, missing };
}
