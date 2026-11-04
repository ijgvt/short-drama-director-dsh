#!/usr/bin/env python3
"""Validate a MiniMax H3 prompt against the official output format.

Usage:
    python validate_h3_prompt.py PROMPT.txt
    python validate_h3_prompt.py PROMPT.txt --lang en
    python validate_h3_prompt.py PROMPT.txt --lang zh
    python validate_h3_prompt.py -              # read from stdin

--lang controls how the prose language is judged:
    auto (default)  detect Chinese prose and accept it, with a note
    en              prose must be English; non-English prose outside <d> is an error
    zh              Chinese prose accepted; structural tokens must still be English

Chinese is the default body language; English is available on request. The
official guide asks for English, but Chinese prose has been validated end to
end. Field names, markers, labels, and notation stay English in every mode -
those are the parts the format actually depends on.

In en mode, short bare Chinese proper nouns (a Han run of 12 characters or
fewer, such as a character or place name) are accepted with a note, because the
name is source data rather than prose. A longer Han run, or any kana or
full-width punctuation, is still reported as non-English prose.

Exit code is 1 when any ERROR is reported, otherwise 0.

The authoritative rules live in the h3-prompt-writing skill:
    references/base-en.txt  -> T2VA / I2VA / FL2VA / L2VA
    references/ref-en.txt   -> Ref2VA
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REF2VA_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)
BASE_SECTIONS = (
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
)
START_MARKERS = ("subject_definitions", "integrated_multimodal_description")
KNOWN_FIELDS = set(REF2VA_SECTIONS) | set(BASE_SECTIONS)
RETENTION_MARKERS = (
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
)

CJK_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]"
)
D_RE = re.compile(r"<d>.*?</d>", re.S)
HAN_CHAR = r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
HAN_RUN_RE = re.compile(HAN_CHAR + r"+")
LONG_HAN_RUN_RE = re.compile(HAN_CHAR + r"{13,}")
NON_HAN_CJK_RE = re.compile(r"[\u3040-\u30ff\u3000-\u303f\uff00-\uffef]")
PAREN_RE = re.compile(r"[（(][^)）]*[)）]")
ASSET_LABEL_RE = re.compile(r"asset\s*[:：]", re.I)
TIMECODE_RE = re.compile(r"(?<![\w:])(\d{1,3}):(\d{1,3})(?:\.(\d+))?(?![\w.])")
AT_EN_RE = re.compile(r"\bAt\s+(\d{2}):(\d{2})\.(\d{3})")
AT_ZH_RE = re.compile(r"(?:At|在)\s*(\d{2}):(\d{2})\.(\d{3})")
SHOT_RE = re.compile(r"\[Shot (\d+)\]")
LABEL_RE = re.compile(r"<(Subject|Picture|Video|Audio)\s+(\d+)>")
HEADER_RE = re.compile(r"^([a-z_]+)\s*:\s*(.*)$")
VO_RE = re.compile(r"off-screen voiceover", re.I)
# LOCAL ADDITION (not upstream): a horizontal rule between prompts, and one prompt's own
# `【大分镜N】` / `## 大分镜 N` heading. Both belong to the FILE's layout, so `split_blocks` strips
# them from the end of each block - otherwise they land in the LAST section of the block and get
# reported as "non-English prose outside <d>" against `non_diegetic_music`.
RULE_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
BLOCK_HEADING_RE = re.compile(r"^\s*(?:【\s*大分镜\s*\d+\s*】|#{1,6}\s*大分镜\s*\d+.*)$")
LIPS_RE = re.compile(
    r"lips?[^.]{0,60}?(?:remain|remains|are|is|stay|stays|keep|keeps)[^.]{0,30}?closed",
    re.I,
)
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
AIM_RE = re.compile(r"(?:镜头对准|对准)")
DIRECTION_RE = re.compile(r"正面|侧面|背面|\bfront\b|\bback\b|\bside\b|\brear\b", re.I)
AIM_LOOKBEHIND = 12
AIM_LOOKAHEAD = 45
SENTENCE_BREAK_RE = re.compile(r"[。！？!?\n]")


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.infos: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def info(self, msg: str) -> None:
        self.infos.append(msg)


def mask_allowed(text: str) -> str:
    """Blank out spans where non-English text is legal, preserving length.

    Legal zones: <d>...</d> blocks, and parenthetical annotations such as
    proper nouns or a legacy asset-registry label.
    """
    out = D_RE.sub(lambda m: " " * len(m.group(0)), text)
    out = PAREN_RE.sub(lambda m: " " * len(m.group(0)), out)
    return out


def check_annotations(rep: Report, name: str, body: str) -> None:
    """Surface parenthetical annotations so non-English text stays visible."""
    for m in PAREN_RE.finditer(body):
        span = m.group(0).strip()
        if ASSET_LABEL_RE.search(span):
            rep.warn(
                f"{name} still carries an asset-registry label; this convention drops it - "
                f"the <Picture N> / <Video N> citation is the provenance: {span[:70]!r}"
            )
            continue
        if not CJK_RE.search(span):
            continue
        if len(span) > 40:
            rep.warn(
                f"{name} long parenthetical holds non-English text ({len(span)} chars); "
                f"keep annotations to short proper nouns: {span[:60]!r}"
            )
        else:
            rep.info(f"{name} parenthetical annotation: {span}")


def detect_language(sections: dict[str, str]) -> str:
    """Return 'zh' when the prose is predominantly Chinese, else 'en'."""
    text = "\n".join(mask_allowed(b) for b in sections.values())
    letters = len(re.findall(r"[A-Za-z]", text))
    cjk = len(CJK_RE.findall(text))
    if letters + cjk == 0:
        return "en"
    return "zh" if cjk / (letters + cjk) > 0.15 else "en"


def parse_sections(text: str):
    sections: dict[str, list[str]] = {}
    order: list[str] = []
    dupes: list[str] = []
    current: str | None = None
    for line in text.splitlines():
        m = HEADER_RE.match(line)
        if m and m.group(1) in KNOWN_FIELDS:
            name = m.group(1)
            if name in sections:
                dupes.append(name)
            else:
                sections[name] = []
                order.append(name)
            current = name
            rest = m.group(2)
            if rest.strip():
                sections[name].append(rest)
            continue
        if current is not None:
            sections[current].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}, order, dupes


def check_labels(rep: Report, sections: dict[str, str]) -> None:
    defined = {(k, int(n)) for k, n in LABEL_RE.findall(sections.get("subject_definitions", ""))}
    if not defined:
        rep.error("subject_definitions defines no <Subject N> / <Picture N> labels")
    used: set[tuple[str, int]] = set()
    for name, body in sections.items():
        if name == "subject_definitions":
            continue
        for k, n in LABEL_RE.findall(body):
            if name == "retention_analysis" and k != "Subject":
                rep.warn(f"retention_analysis references <{k} {n}>; this section lists <Subject N> lines only")
            used.add((k, int(n)))
    for label in sorted(used - defined):
        rep.error(f"<{label[0]} {label[1]}> is used but never defined in subject_definitions")
    for label in sorted(defined):
        if label[0] == "Subject" and label not in used:
            rep.warn(f"<Subject {label[1]}> is defined but never used in a later section")
    subjects_in_retention = {(k, int(n)) for k, n in LABEL_RE.findall(sections.get("retention_analysis", ""))}
    for label in sorted(defined - subjects_in_retention):
        if label[0] == "Subject":
            rep.error(f"<Subject {label[1]}> has no line in retention_analysis")
    standalone = [
        line.strip()
        for line in sections.get("subject_definitions", "").splitlines()
        if re.match(r"^<(Picture|Video|Audio)\s+\d+>", line.strip())
    ]
    if standalone:
        rep.info("standalone asset entries (allowed only as frame / composition anchors):")
        for line in standalone:
            rep.info("    " + line[:120])
    for line in standalone:
        m = re.match(r"^<(Picture|Video|Audio)\s+(\d+)>", line)
        key = (m.group(1), int(m.group(2)))
        if key not in used:
            rep.warn(
                f"standalone <{key[0]} {key[1]}> is defined but never referenced after "
                "subject_definitions; a frame / staging anchor must also be restated in "
                "summary, retention_analysis, or the description"
            )


def check_shots(rep: Report, desc: str, label: str, lang: str) -> None:
    numbers = [int(n) for n in SHOT_RE.findall(desc)]
    if not numbers:
        rep.error(f"{label} contains no [Shot N] marker")
        return
    expected = list(range(1, len(numbers) + 1))
    if numbers != expected:
        rep.error(f"{label} shot numbering is {numbers}, expected {expected}")
    masked = mask_allowed(desc)
    for m in TIMECODE_RE.finditer(masked):
        mm, ss, ms = m.group(1), m.group(2), m.group(3)
        problems = []
        if len(mm) != 2:
            problems.append("minutes must be two digits")
        if len(ss) != 2:
            problems.append("seconds must be two digits")
        if ms is None or len(ms) != 3:
            problems.append("milliseconds must be exactly three digits")
        if not problems and (int(mm) > 59 or int(ss) > 59):
            problems.append("minutes and seconds must be 00-59")
        if problems:
            rep.error(f"{label} malformed timecode '{m.group(0)}': " + "; ".join(problems))
    opener_re = AT_ZH_RE if lang == "zh" else AT_EN_RE
    opener_name = "'At MM:SS.mmm,'" if lang == "en" else "'At MM:SS.mmm,' or '在 MM:SS.mmm'"
    marks = list(SHOT_RE.finditer(desc))
    previous = -1.0
    for idx, mark in enumerate(marks):
        n = int(mark.group(1))
        end = marks[idx + 1].start() if idx + 1 < len(marks) else len(desc)
        chunk = mask_allowed(desc[mark.end():end])
        found = opener_re.search(chunk)
        if n == 1:
            if found:
                rep.warn(f"{label} [Shot 1] carries a timecode; the first shot normally needs none")
            continue
        if not found:
            rep.error(f"{label} [Shot {n}] has no {opener_name} opener")
            continue
        seconds = int(found.group(1)) * 60 + int(found.group(2)) + int(found.group(3)) / 1000
        if seconds <= previous:
            rep.error(f"{label} [Shot {n}] timecode {found.group(0)} does not advance")
        previous = seconds


def check_camera_direction(rep: Report, desc: str, label: str) -> None:
    """Warn on every '对准' clause that states no camera direction."""
    for m in AIM_RE.finditer(desc):
        head = SENTENCE_BREAK_RE.split(desc[max(0, m.start() - AIM_LOOKBEHIND): m.start()])[-1]
        tail = SENTENCE_BREAK_RE.split(desc[m.end(): m.end() + AIM_LOOKAHEAD])[0]
        window = head + tail
        if not DIRECTION_RE.search(window):
            rep.warn(
                f"{label} aim clause states no camera direction "
                f"(正面 / 左侧面 / 右侧面 / 背面): ...{window.strip()!r}"
            )


def check_dialogue(rep: Report, sections: dict[str, str]) -> None:
    for name, body in sections.items():
        for block in D_RE.findall(body):
            inner = block[3:-4].strip()
            if not inner:
                rep.error(f"{name} has an empty <d></d> block")
            elif not re.match(r"^\[[^\]]+\]", inner):
                rep.error(f"{name} <d> block lacks a [Language] tag: {inner[:60]!r}")
            elif re.match(r"^\[[^\]]*\]\s*$", inner):
                rep.error(f"{name} <d> block has a language tag but no line: {inner[:60]!r}")
        if VO_RE.search(body) and not LIPS_RE.search(body):
            rep.error(
                f"{name} uses 'off-screen voiceover' without stating that the on-screen "
                "character's lips remain closed"
            )


def validate_block(text: str, rep: Report, tag: str, lang: str) -> None:
    sections, order, dupes = parse_sections(text)
    if not sections:
        rep.error(f"{tag} no recognizable section header found")
        return
    for name in dupes:
        rep.error(f"{tag} duplicate section '{name}'")
    mode = "ref2va" if "subject_definitions" in sections else "base"
    expected = REF2VA_SECTIONS if mode == "ref2va" else BASE_SECTIONS
    rep.info(f"{tag} detected mode: {'Ref2VA' if mode == 'ref2va' else 'base (T2VA/I2VA/FL2VA/L2VA)'}")
    if lang == "zh":
        rep.info(
            f"{tag} prose language: Chinese accepted. The official guide asks for English; "
            "keep field names, markers, labels, and notation in English."
        )
    else:
        rep.info(f"{tag} prose language: English required")
    missing = [s for s in expected if s not in sections]
    if missing:
        rep.error(f"{tag} missing section(s): " + ", ".join(missing))
    extra = [s for s in order if s not in expected]
    if extra:
        rep.error(f"{tag} unexpected section(s): " + ", ".join(extra))
    present = [s for s in expected if s in sections]
    seq = [s for s in order if s in expected]
    if seq != present:
        rep.error(f"{tag} sections out of order: " + " -> ".join(seq))
    for name, body in sections.items():
        masked = mask_allowed(body)
        if lang == "en":
            offender = LONG_HAN_RUN_RE.search(masked) or NON_HAN_CJK_RE.search(masked)
            if offender:
                start = max(0, offender.start() - 40)
                rep.error(
                    f"{tag} {name} contains non-English prose outside <d> or a parenthetical "
                    f"annotation: ...{body[start:offender.end() + 40].strip()!r}"
                )
            else:
                names = HAN_RUN_RE.findall(masked)
                if names:
                    rep.info(
                        f"{tag} {name} bare Chinese proper noun(s) accepted: "
                        + "、".join(dict.fromkeys(names))
                    )
        check_annotations(rep, f"{tag} {name}", body)
    desc_name = "detailed_description" if mode == "ref2va" else "integrated_multimodal_description"
    desc = sections.get(desc_name, "")
    check_shots(rep, desc, f"{tag} {desc_name}", lang)
    check_camera_direction(rep, desc, f"{tag} {desc_name}")
    check_dialogue(rep, sections)
    if mode == "ref2va":
        check_labels(rep, sections)
        summary = sections.get("summary", "")
        if summary and not summary.lstrip().startswith("["):
            rep.error(f"{tag} summary must open with a square-bracketed task-type prefix")
        elif summary and "]" not in summary.lstrip().split("\n", 1)[0]:
            rep.error(f"{tag} summary task-type prefix is not closed with ']'")
        retention = sections.get("retention_analysis", "")
        for line in retention.splitlines():
            line = line.strip()
            if not line.startswith("<"):
                continue
            m = re.match(r"^<[^>]+>\s*\([^)]*\)\s*:\s*([A-Za-z_]+)", line)
            if not m:
                rep.error(f"{tag} retention_analysis line has no marker: {line[:70]!r}")
                continue
            if m.group(1) not in RETENTION_MARKERS:
                rep.error(
                    f"{tag} retention marker {m.group(1)!r} is not one of "
                    + " / ".join(RETENTION_MARKERS)
                )
        if re.search(r"\(S\d", retention):
            rep.error(f"{tag} retention_analysis must not contain (Sx) speaker IDs")
        if lang == "zh":
            chars = len(CJK_RE.findall(mask_allowed(desc)))
            rep.info(f"{tag} detailed_description holds {chars} Chinese characters")
            if chars < 300:
                rep.warn(
                    f"{tag} detailed_description is only {chars} Chinese characters; "
                    "the guide suggests roughly 350-500 English words worth of detail"
                )
        else:
            words = len(WORD_RE.findall(desc))
            if words < 200:
                rep.error(f"{tag} detailed_description is only {words} words; 350-500 expected")
            elif words < 350:
                rep.warn(f"{tag} detailed_description is {words} words; the guide suggests 350-500")
            elif words > 650:
                rep.warn(f"{tag} detailed_description is {words} words; the guide suggests 350-500")
    ambience = sections.get("overall_soundscape", "")
    if not ambience:
        rep.error(f"{tag} overall_soundscape is empty")
    else:
        if D_RE.search(ambience):
            rep.error(f"{tag} overall_soundscape must not repeat dialogue from <d> blocks")
        if lang == "en":
            sentences = len(re.findall(r"[.!?](?:\s|$)", ambience))
            if sentences > 4:
                rep.warn(f"{tag} overall_soundscape has {sentences} sentences; 1-4 recommended")
    music = sections.get("non_diegetic_music", "")
    if not music:
        rep.error(f"{tag} non_diegetic_music is empty; use N/A when there is no music")


def split_blocks(text: str):
    lines = text.splitlines()
    starts = []
    for i, line in enumerate(lines):
        m = HEADER_RE.match(line)
        if m and m.group(1) in START_MARKERS:
            starts.append(i)
    if not starts:
        return [text]
    blocks = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        chunk = lines[start:end]
        # LOCAL ADDITION: drop the file-layout lines that belong to the NEXT prompt.
        #
        # A multi-prompt file separates its prompts with `---` and may head each one with `【大分镜N】`.
        # Left in, they land at the tail of the LAST section and are reported as "non-English prose
        # outside <d>" against `non_diegetic_music`. No prose language ends a section with `---` or
        # `【大分镜2】`, so trimming them is always right.
        while chunk:
            tail = chunk[-1].strip()
            if tail and not (RULE_RE.match(tail) or BLOCK_HEADING_RE.match(tail)):
                break
            chunk.pop()
        blocks.append("\n".join(chunk))
    return blocks


def main(argv: list[str]) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        prog="validate_h3_prompt.py",
        description="Validate a MiniMax H3 prompt against the official output format.",
    )
    ap.add_argument("path", help="prompt file, or - to read stdin")
    ap.add_argument("--lang", choices=("auto", "en", "zh"), default="auto")
    args = ap.parse_args(argv[1:])

    if args.path == "-":
        text = sys.stdin.read()
        name = "<stdin>"
    else:
        path = Path(args.path)
        if not path.is_file():
            print(f"ERROR: no such file: {path}")
            return 2
        text = path.read_text(encoding="utf-8-sig")
        name = path.name
    text = text.strip()
    if not text:
        print(f"ERROR: {name} is empty")
        return 1

    blocks = split_blocks(text)
    rep = Report()
    for idx, block in enumerate(blocks, 1):
        tag = f"prompt {idx}/{len(blocks)}:" if len(blocks) > 1 else "prompt:"
        if args.lang == "auto":
            sections, _order, _dupes = parse_sections(block)
            lang = detect_language(sections)
        else:
            lang = args.lang
        validate_block(block, rep, tag, lang)

    print("=" * 78)
    print(f"H3 prompt validation - {name}   ({len(blocks)} prompt block(s), --lang {args.lang})")
    print("=" * 78)
    for label, items in (("ERROR", rep.errors), ("WARN", rep.warnings), ("INFO", rep.infos)):
        for item in items:
            print(f"[{label}] {item}")
    if not rep.errors and not rep.warnings:
        print("[OK] no issues found")
    print("-" * 78)
    print(f"RESULT: {'FAIL' if rep.errors else 'PASS'}  "
          f"({len(rep.errors)} error(s), {len(rep.warnings)} warning(s))")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
