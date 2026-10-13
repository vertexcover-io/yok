"""Summarise an audit's JUnit reports per layer: failing, flaky and slowest tests and files.

Usage: python3 junit_summary.py AUDIT_DIR [--top N]
AUDIT_DIR holds one folder per layer, each holding one folder per run: AUDIT_DIR/LAYER/runN/*.xml.
A run folder may hold any number of reports. Every copy of a test counts, so a run made with a
repeat flag works too: a test some of whose copies failed and some passed is flaky.
"""

import argparse
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal

Outcome = Literal["pass", "fail", "skip"]
Key = tuple[str, str]
SLOW_FILE_SHARE = 0.05


@dataclass(frozen=True)
class Case:
    file: str
    name: str
    seconds: float
    outcome: Outcome


def outcome_of(case: ET.Element) -> Outcome:
    if case.find("failure") is not None or case.find("error") is not None:
        return "fail"
    if case.find("skipped") is not None:
        return "skip"
    return "pass"


def seconds_of(element: ET.Element) -> float:
    try:
        return float(element.get("time") or 0)
    except ValueError:
        return 0.0


def walk(element: ET.Element, suite_file: str | None) -> Iterator[Case]:
    for child in element:
        if child.tag == "testsuite":
            yield from walk(child, child.get("file") or suite_file or child.get("name"))
        elif child.tag == "testcase":
            file = child.get("file") or suite_file or child.get("classname") or "?"
            yield Case(file, child.get("name") or "?", seconds_of(child), outcome_of(child))


def parse_report(path: Path) -> list[Case]:
    root = ET.parse(path).getroot()
    if root.tag == "testsuite":
        return list(walk(root, root.get("file")))
    return list(walk(root, None))


def parse_run(folder: Path) -> list[Case]:
    reports = sorted(folder.glob("*.xml"))
    if not reports:
        raise OSError(f"no .xml files in {folder}")
    return [case for report in reports for case in parse_report(report)]


def load_tree(root: Path) -> dict[str, list[list[Case]]]:
    layers = sorted(layer for layer in root.iterdir() if layer.is_dir())
    if not layers:
        raise OSError(f"no layer folders in {root}; expected {root}/LAYER/runN/*.xml")
    tree: dict[str, list[list[Case]]] = {}
    for layer in layers:
        runs = sorted(run for run in layer.iterdir() if run.is_dir())
        if not runs:
            raise OSError(f"no run folders in {layer}; expected {layer}/runN/*.xml")
        tree[layer.name] = [parse_run(run) for run in runs]
    return tree


def classify(cases: list[Case]) -> tuple[list[Key], list[Key]]:
    outcomes: dict[Key, set[Outcome]] = defaultdict(set)
    for case in cases:
        outcomes[(case.file, case.name)].add(case.outcome)
    seen = {key: found - {"skip"} for key, found in outcomes.items()}
    always = sorted(key for key, found in seen.items() if found == {"fail"})
    flaky = sorted(key for key, found in seen.items() if found == {"fail", "pass"})
    return always, flaky


def mismatch_warning(runs: list[list[Case]]) -> str | None:
    sets = [{(case.file, case.name) for case in run} for run in runs]
    only_some = set.union(*sets) - set.intersection(*sets)
    if not only_some:
        return None
    return (
        f"warning: {len(only_some)} tests appear in some runs and not others; "
        "check each run folder holds one whole run of this layer only"
    )


def seconds_per_pass(cases: list[Case]) -> dict[Key, float]:
    totals: dict[Key, float] = defaultdict(float)
    copies: dict[Key, int] = defaultdict(int)
    for case in cases:
        key = (case.file, case.name)
        totals[key] += case.seconds
        copies[key] += 1
    return {key: totals[key] / copies[key] for key in totals}


def render_layer(name: str, runs: list[list[Case]], top: int) -> str:
    cases = [case for run in runs for case in run]
    always, flaky = classify(cases)
    tests = seconds_per_pass(cases)
    files: dict[str, float] = defaultdict(float)
    for (file, _), seconds in tests.items():
        files[file] += seconds
    total = sum(files.values()) or 1.0
    slow_files = sorted(files.items(), key=lambda item: -item[1])
    shown_files = [
        item for rank, item in enumerate(slow_files) if rank < top or item[1] / total >= SLOW_FILE_SHARE
    ]
    warning = mismatch_warning(runs)
    lines = [
        f"# Layer {name}: {len(runs)} run(s), {len(tests)} tests, {total:.1f}s of test time per pass",
        "Results per run (compare run 1 with the count the runner printed): "
        + ", ".join(str(len(run)) for run in runs),
        *([warning] if warning else []),
        "",
        f"## Failing every time ({len(always)})",
        *[f"- {file} :: {test}" for file, test in always],
        "",
        f"## Flaky: some copies failed, some passed ({len(flaky)})",
        *[f"- {file} :: {test}" for file, test in flaky],
        "",
        f"## Slowest files (seconds per pass, share of the layer; every file at {SLOW_FILE_SHARE:.0%} or more is listed)",
        *[f"- {seconds:.2f}s  {seconds / total:.0%}  {file}" for file, seconds in shown_files],
        "",
        "## Slowest tests",
        *[
            f"- {seconds:.2f}s  {file} :: {test}"
            for (file, test), seconds in sorted(tests.items(), key=lambda item: -item[1])[:top]
        ],
    ]
    return "\n".join(lines)


NOTES = """File times are the sum of their test times; setup outside a test is not counted.
Two table rows with the same name in the same file count as copies of one test, so if one passes
and the other fails they show as flaky; check the test's rows before calling it flaky."""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("audit_dir", help="AUDIT_DIR/LAYER/runN/*.xml")
    parser.add_argument("--top", type=int, default=10, help="how many files and tests to list")
    args = parser.parse_args(argv)
    try:
        tree = load_tree(Path(args.audit_dir))
    except (OSError, ET.ParseError) as error:
        print(f"junit_summary: cannot read the audit folder: {error}", file=sys.stderr)
        return 1
    print("\n\n".join([*(render_layer(name, runs, args.top) for name, runs in tree.items()), NOTES]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
