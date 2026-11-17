import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const TEMPLATE = readFileSync(
  join(REPO, "skills/qa/references/proof-report-template.html"),
  "utf8",
);

// The template is one page with no module to import, so its own expressions are evaluated
// here: a test then holds the rule the page applies, and not the text it is written in.
const evaluate = (pattern, what) => {
  const source = TEMPLATE.match(pattern)?.[1];
  assert.ok(source, `the template carries ${what}`);
  return new Function(`return (${source});`)();
};

const visualMatchGuard = evaluate(
  /\['visualMatch',\s*(s => [\s\S]*?),\s*renderVisualMatch\]/,
  "a visualMatch section guard",
);
const proofMarks = evaluate(/const PROOF_MARKS = (\{[\s\S]*?\});/, "its proof marks");
const checkMarks = evaluate(/const CHECK_MARKS = (\{[\s\S]*?\});/, "its check marks");
const ratioOf = new Function(
  `${TEMPLATE.match(/const RATIOS = [\s\S]*?;\n/)?.[0]} return (${TEMPLATE.match(/const ratioOf = ([\s\S]*?\n  \});/)?.[1]});`,
)();

const island = () => {
  const m = TEMPLATE.match(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
  );
  assert.ok(m, "the template carries a report-data island");
  return JSON.parse(m[1]);
};

// A report whose island does not parse renders as a blank page, and the skill
// only finds out by opening it. This is the cheapest place to catch that.
test("the scaffold island parses", () => {
  assert.ok(island().scenarios.length > 0);
});

test("every scaffold url is a bare path, never a host", () => {
  const d = island();
  const urls = [
    ...d.scenarios.map((s) => s.url),
    ...d.scenarios.flatMap((s) => (s.steps ?? []).map((x) => x.url)),
  ].filter(Boolean);

  assert.ok(urls.length > 0, "the scaffold demonstrates the url field");
  for (const u of urls) {
    assert.equal(typeof u, "string", `url is a string, got ${typeof u}`);
    assert.doesNotMatch(u, /^[a-z]+:\/\//i, `${u} carries a host`);
  }
});

test("the base URL has a home in fields[]", () => {
  assert.ok(island().fields.some((f) => /base url/i.test(f.label)));
});

// The section is opt-in per scenario and hangs off one key. A guard reading a
// different key than the scaffold writes renders nothing, silently.
test("the renderer and the scaffold agree on the visualMatch key", () => {
  assert.ok(visualMatchGuard, "the section registry carries a visualMatch entry");
  assert.ok(island().scenarios.some((s) => visualMatchGuard(s)));
});

// A design check is worth a section where it has something to say.
test("the visualMatch section shows with checks, and not otherwise", () => {
  const shows = (visualMatch) => Boolean(visualMatchGuard({ visualMatch }));
  assert.equal(shows({ baseline: "../design/a.png", checks: [{ text: "t", result: "pass" }] }), true);
  assert.equal(shows({ baseline: null, checks: [{ text: "t", result: "warn" }] }), true);
  assert.equal(shows({ baseline: null, checks: [] }), false);
  assert.equal(shows(undefined), false);
});

// Only a proof that says it holds is shown as one that does.
test("a proof gets the pass mark only when holds is true", () => {
  assert.equal(proofMarks.true.text, "✓");
  assert.equal(proofMarks.false.text, "✕");
  assert.notEqual(proofMarks.unset.text, "✓");
  assert.match(TEMPLATE, /PROOF_MARKS\[String\(pr\.holds\)\] \|\| PROOF_MARKS\.unset/);
});

// A check the run never reached must not read as one that passed.
test("a check gets the pass mark only when its result is pass", () => {
  assert.equal(checkMarks.pass.text, "✔");
  assert.equal(checkMarks.fail.text, "✘");
  assert.equal(checkMarks.warn.text, "!");
  assert.notEqual(checkMarks.unset.text, "✔");
  assert.match(TEMPLATE, /CHECK_MARKS\[c\.result\] \|\| CHECK_MARKS\.unset/);
});

// The renderers read the same keys the scaffold writes; a drift between them
// renders an empty section.
test("the scaffold demonstrates every documented field of a step, a check, a recording and a proof", () => {
  const s = island().scenarios[0];
  assert.deepEqual(Object.keys(s.steps[0]), ["when", "checks"]);
  assert.deepEqual(Object.keys(s.steps[0].checks[0]), ["text", "result", "proofs"]);
  assert.deepEqual(Object.keys(s.recordings[0]), [
    "label",
    "kind",
    "device",
    "browser",
    "video",
    "frames",
  ]);
  assert.deepEqual(Object.keys(s.visualMatch), ["baseline", "build", "width", "checks"]);
  assert.deepEqual(Object.keys(s.proofs[0]), [
    "id",
    "label",
    "claim",
    "found",
    "holds",
    "raw",
    "image",
  ]);
  assert.match(TEMPLATE, /s\.steps\.forEach/);
  assert.match(TEMPLATE, /s\.recordings\.forEach/);
  assert.match(TEMPLATE, /src: vm\.build/);
});

// The rail lists the primary journeys first, then each group the scenarios name.
test("the scaffold shows a primary journey and a named group, and the rail reads both", () => {
  const groups = island().scenarios.map((s) => s.group);
  assert.equal(groups[0], "journey");
  assert.ok(groups.slice(1).every((g) => typeof g === "string" && g !== "" && g !== "journey"));
  assert.match(TEMPLATE, /s\.group === 'journey' \? JOURNEYS : s\.group/);
});

// A check that cites an id no proof carries shows no pill, silently.
test("every proof the scaffold's checks cite is one of that scenario's proofs", () => {
  for (const s of island().scenarios) {
    const ids = (s.proofs ?? []).map((p) => p.id);
    const checks = [...(s.steps ?? []).flatMap((x) => x.checks), ...(s.visualMatch?.checks ?? [])];
    for (const id of checks.flatMap((c) => c.proofs ?? [])) assert.ok(ids.includes(id), id);
  }
});

// A recording's shape is read off its video, and named the way a person would name it.
test("a video's shape reads as the nearest familiar ratio, else as a number", () => {
  assert.equal(ratioOf(1440, 900), "16:10");
  assert.equal(ratioOf(1280, 720), "16:9");
  assert.equal(ratioOf(1170, 2532), "9:19.5");
  assert.equal(ratioOf(640, 900), "0.71:1");
});
