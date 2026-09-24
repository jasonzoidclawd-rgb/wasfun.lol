#!/usr/bin/env python3
"""Rendered-HTML lint (site-wide gate, v3 spec "Never display").

Fails on text a person can see that claims more precision or certainty than
the data holds:

- "±" anywhere;
- "confidence" / "significant" (and their zh-CN, zh-TW, ja, ko equivalents);
- a two-decimal percentage ("56.98%");
- a decimal lift ("+1.3 pp", "−0.4 pp", "lift +2.5");
- a number followed by "games" (and locale equivalents): we never observe counts.

Scans the visible text of every prerendered page in the Next build output
(.next/server/app/**/*.html): scripts, styles and attributes are stripped, so
data payloads are the kill-switch crawl's job, not this lint's.

Quoted game text (Riot and wiki ability, item and augment descriptions such as
"(+ 85.25% AP)") is not a statistics claim: its containers carry
`data-game-text` and their subtrees are skipped. Nothing else is exempt.

Usage:
    python3 scripts/lint_rendered_html.py [--root .next/server/app]
"""

from __future__ import annotations

import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

RULES: list[tuple[str, re.Pattern[str]]] = [
    ("plus-minus", re.compile(r"±")),
    ("confidence", re.compile(r"\bconfidence\b|置信|信賴度|信頼度|신뢰도", re.I)),
    ("significant", re.compile(r"\bsignifican(?:t|ce)\b|显著|顯著|有意差|유의", re.I)),
    ("two-decimal percentage", re.compile(r"(?<![\d.])\d+\.\d{2}\s*%")),
    ("decimal lift", re.compile(r"[+\-−]\s?\d+\.\d+\s*(?:pp\b|points?\b|個百分點|个百分点|ポイント|%p)", re.I)),
    ("count of games", re.compile(r"\d[\d,.]*\s*(?:games?\b|場對局|场对局|場比賽|场比赛|試合|게임)", re.I)),
]


VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class _Visible(HTMLParser):
    """Collects visible text, skipping scripts, styles and data-game-text subtrees."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_stack: list[str] = []  # open tags inside a skipped subtree

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        if self.skip_stack or tag in ("script", "style", "template") or any(k == "data-game-text" for k, _ in attrs):
            self.skip_stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID or not self.skip_stack:
            return
        # pop to the matching tag (tolerates sloppy nesting)
        while self.skip_stack:
            if self.skip_stack.pop() == tag:
                break

    def handle_data(self, data):
        if not self.skip_stack:
            self.parts.append(data)


def visible_text(page: str) -> str:
    parser = _Visible()
    parser.feed(page)
    return re.sub(r"\s+", " ", " ".join(parser.parts))


def lint(root: Path) -> list[tuple[str, str, str]]:
    problems = []
    for path in sorted(root.rglob("*.html")):
        text = visible_text(path.read_text(encoding="utf-8", errors="replace"))
        for name, pattern in RULES:
            for m in pattern.finditer(text):
                context = text[max(0, m.start() - 50) : m.end() + 30].strip()
                problems.append((str(path.relative_to(root)), name, context))
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path(".next/server/app"))
    args = ap.parse_args()
    if not args.root.exists():
        print(f"no build output at {args.root}; run npm run build first")
        return 1
    problems = lint(args.root)
    pages = len(list(args.root.rglob("*.html")))
    for path, name, context in problems[:60]:
        print(f"  ✗ {name}: {path}: …{context}…")
    print(f"rendered-HTML lint: {len(problems)} problem(s) across {pages} page(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
