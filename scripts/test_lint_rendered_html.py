#!/usr/bin/env python3
"""The rendered-HTML lint catches over-precise or over-certain statistics text and nothing else."""

import tempfile
import unittest
from pathlib import Path

from lint_rendered_html import lint, visible_text


def run(html: str) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "page.html").write_text(html, encoding="utf-8")
        return [name for _, name, _ in lint(Path(tmp))]


class RenderedLintTests(unittest.TestCase):
    def test_each_rule(self):
        self.assertEqual(run("<p>win 56.98%</p>"), ["two-decimal percentage"])
        self.assertEqual(run("<p>lift +1.3 pp</p>"), ["decimal lift"])
        self.assertEqual(run("<p>based on 12,000 games</p>"), ["count of games"])
        self.assertEqual(run("<p>±0.4</p>"), ["plus-minus"])
        self.assertEqual(run("<p>95% confidence</p>"), ["confidence"])
        self.assertEqual(run("<p>a significant lead</p>"), ["significant"])
        self.assertEqual(run("<p>信頼度が高い</p>"), ["confidence"])

    def test_allowed_forms(self):
        self.assertEqual(run("<p>win 57.0% · pick 12.4% · lift +3</p>"), [])

    def test_quoted_game_text_scripts_and_styles_are_skipped(self):
        html = '<div data-game-text><p>deals 85.25% AP, a significant amount</p><br><b>x</b></div><p>ok</p><script>9.99%</script>'
        self.assertEqual(visible_text(html).strip(), "ok")
        self.assertEqual(run(html), [])


if __name__ == "__main__":
    unittest.main()
