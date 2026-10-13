import tempfile
import unittest
from pathlib import Path

from junit_summary import classify, load_tree, main, parse_run, render_layer

BUN_RUN = """<?xml version="1.0"?>
<testsuites name="bun test">
  <testsuite name="a.test.ts" file="a.test.ts" time="3.0">
    <testsuite name="group" file="a.test.ts">
      <testcase name="stable" time="2.5" file="a.test.ts" />
      <testcase name="sometimes" time="0.5" file="a.test.ts">{flaky}</testcase>
    </testsuite>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" time="0.1">
    <testcase name="broken" time="0.1" file="b.test.ts"><failure message="boom" /></testcase>
    <testcase name="later" time="0" file="b.test.ts"><skipped /></testcase>
  </testsuite>
</testsuites>
"""

PLAYWRIGHT_REPEATED = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="login.spec.ts">
    <testcase classname="login.spec.ts" name="signs in" time="2.0" />
    <testcase classname="login.spec.ts" name="signs in" time="2.0"><failure /></testcase>
    <testcase classname="login.spec.ts" name="signs in" time="2.0" />
  </testsuite>
</testsuites>
"""

GO_RUN = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="example.com/pkg/store" tests="1" time="1.2">
    <testcase classname="example.com/pkg/store" name="TestSave" time="1.2" />
  </testsuite>
</testsuites>
"""

PYTEST_RUN = """<?xml version="1.0"?>
<testsuite name="pytest">
  <testcase classname="tests.test_api" name="test_get" time="0.3" />
</testsuite>
"""


def write(folder: Path, name: str, text: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(text)


class JunitSummaryTest(unittest.TestCase):
    def test_a_test_that_fails_in_one_run_and_passes_in_another_is_flaky(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "unit" / "run1", "r.xml", BUN_RUN.format(flaky=""))
            write(root / "unit" / "run2", "r.xml", BUN_RUN.format(flaky="<failure />"))
            runs = load_tree(root)["unit"]
        always, flaky = classify([case for run in runs for case in run])
        self.assertEqual(always, [("b.test.ts", "broken")])
        self.assertEqual(flaky, [("a.test.ts", "sometimes")])

    def test_copies_inside_one_repeated_run_count_as_flaky_and_time_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "e2e" / "run1", "r.xml", PLAYWRIGHT_REPEATED)
            runs = load_tree(root)["e2e"]
        self.assertEqual(classify(runs[0]), ([], [("login.spec.ts", "signs in")]))
        self.assertIn("1 tests, 2.0s of test time per pass", render_layer("e2e", runs, top=5))

    def test_each_layer_is_reported_on_its_own(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "unit" / "run1", "r.xml", BUN_RUN.format(flaky=""))
            write(root / "e2e" / "run1", "r.xml", PLAYWRIGHT_REPEATED)
            tree = load_tree(root)
        self.assertEqual(sorted(tree), ["e2e", "unit"])
        self.assertNotIn("login.spec.ts", render_layer("unit", tree["unit"], top=5))

    def test_a_run_folder_merges_every_report_in_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory) / "run1"
            write(run, "results-a1.xml", GO_RUN)
            write(run, "results-b2.xml", PYTEST_RUN)
            cases = parse_run(run)
        self.assertEqual(sorted(case.name for case in cases), ["TestSave", "test_get"])
        self.assertEqual(sorted(case.file for case in cases), ["example.com/pkg/store", "tests.test_api"])

    def test_runs_with_different_tests_get_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "mixed" / "run1", "r.xml", GO_RUN)
            write(root / "mixed" / "run2", "r.xml", PYTEST_RUN)
            runs = load_tree(root)["mixed"]
        self.assertIn("warning: 2 tests appear in some runs and not others", render_layer("mixed", runs, 5))

    def test_the_report_lists_the_top_files_and_every_file_over_its_share(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "unit" / "run1", "r.xml", BUN_RUN.format(flaky=""))
            report = render_layer("unit", load_tree(root)["unit"], top=1)
        self.assertIn("- 3.00s  97%  a.test.ts", report)
        self.assertNotIn("3%  b.test.ts", report)
        self.assertNotIn("later", report)

    def test_a_folder_not_laid_out_by_layer_and_run_exits_1(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(main([str(root)]), 1)
            write(root / "unit", "flat.xml", GO_RUN)
            self.assertEqual(main([str(root)]), 1)
            write(root / "unit" / "run1", "bad.xml", "<testsuites>")
            self.assertEqual(main([str(root)]), 1)


if __name__ == "__main__":
    unittest.main()
