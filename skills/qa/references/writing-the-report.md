# Writing the Proof Report

**Read this when:** setting a scenario's bar and writing it up (Steps 2 to 4), completing the videos (Step 5), or
writing the report (Step 6). The driving and capture craft is in `driving-the-browser.md` and
`driving-the-device.md`.

**Contents:**

- The reader — Product and QA
- A scenario — one behaviour, written once
- Given, steps and checks
- Proofs — what a check cites
- Recordings — every video of the scenario
- The design check
- Grading — two tracks
- The report format
- Completion checklist — the report is done when all of these hold

## The reader — Product and QA

**The report is read by Product and QA people who have never seen the code.** They open it to learn what the
feature does for its user and whether that held. Every sentence the report shows them — a title, a `given` line,
a step, a check, a `reason`, a proof's `claim` and `found`, a bug's title and body — is written in **plain
language**:

- **Tell it from the user's side**: who does what, what they get, what stays saved.
- **Use the product's own words** for its screens, controls and messages, the way the user sees them, and everyday
  words for everything behind the screen.
- **Name each thing by its kind**: the kind of record, the kind of user, the kind of value. The ids, names and
  amounts this run happened to use belong to the proofs and to the run details. Quote the product's own wording
  where that wording is the behaviour under test. A proof's `claim` states the one value the proof turns on.
- **Describe the application only.** How the run was driven or filmed belongs to the recording it concerns, as
  that recording's `note`, or to the run details.
- **Send the technical original to a proof's `raw`**: a request, a response, a status code, a field name, an
  identifier, a command, a computed style, a measurement. The code behind a bug or a gap goes in that entry's own
  fields.
- **Keep each line short**: one sentence, two where the second carries a fact the first cannot.

Read each sentence back as that reader: it makes sense on its own, with no developer beside them.

## A scenario — one behaviour, written once

**A scenario is one behaviour the docs describe.** Everything that proves that behaviour belongs to it: the take,
every replay of it on another device, the automated test that covers it, and every proof. A second device or a
second way of driving adds a recording to the scenario; a behaviour with its own steps is a scenario of its own.

**`title` is the question the scenario answers**, worded so the checks under it answer yes or no.

**`group` is the heading the report lists the scenario under** — `journey` for a primary journey, else the
broad heading for the kind of check it is — set when it is planned, as Step 2 says.

## Given, steps and checks

A scenario reads top to bottom: where it starts, then each thing the user does with what should be true once
they have. Its parts are written at two moments, in this order:

1. **Before driving, from the docs: `title`, `given`, and the text of every check.** The checks are the bar the
   run is graded against, set while the result is still unknown, listed in the order they will be proven.
2. **After the run that is the evidence: `steps`, and each check's `result`.** Place every check under the step
   that brings it about, in the order the run reached them.

**`given` is the setup, one fact a line**: who the user is, what data exists and what makes it matter, the
settings and permissions in force. Each line states something true before the user acts.

**A step is one thing the user does, and it exists because something is checked once it is done.** Write `when`
as one short sentence in the present tense, naming the control by its label on screen. Actions that lead up to the
checked moment fold into that step's sentence, so the steps summarise the journey the recording shows. A check
made on another surface or on a file the product produced — the same screen on another device, a downloaded
document, a stored record — gets a step of its own, saying what was opened or read.

**A check is one plain sentence saying what should be true**, with:

- **`result`** — `pass` where the run showed exactly that, `fail` where it showed something else. A check that
  held on one recording and broke on another is a `fail`.
- **`saw`** — on a `fail`, what was seen instead, in one sentence, naming the recording where it differs between
  them.
- **`note`** — one line the reader needs beside the check, where there is one.
- **`proofs`** — the ids of the proofs that show this check, as *Proofs* below says.

**A walk that stopped short** gives a result to every check it reached and leaves the rest without one. **A
scenario nothing could drive** carries its `given` and its steps with their checks, none with a result.

**`reason` belongs to a scenario graded `FAILURE`, `NOT VERIFIED` or `INVALID`**, kept to what the verdict turns
on: which check failed and what that means for the user, with the two facts *Bugs* asks of a `FAILURE`; what
blocked the walk and what would close it; or why the scenario does not apply.

Anything else the walk observed goes to the field that owns it: a divergence from the design to the design
check, a mechanism or a whole exchange to a proof, a remark that fits neither to `extra[]`.

## Proofs — what a check cites

A proof is a **second witness**: somewhere other than the recording confirming what a check says — the datastore,
the product's own API, a third-party service, a log, the page's own measurements, the sink an effect lands in. A
check earns one for each thing worth a second witness: an effect with no screen, a value that was stored, the way
an outcome was reached, a measurement the eye cannot take.

**One proof confirms one thing, read from one witness.** Two things confirmed, or two witnesses, are two proofs.
Every entry has the same parts:

- **`id`** — a short id unique within the scenario, which checks cite.
- **`label`** — two or three words naming where the proof comes from. It is the pill the reader clicks.
- **`claim`** — what the witness showed, as one short plain sentence. A proof that failed reads as the failure.
- **`found`** — why this proof counts, in one or two plain sentences: what it adds to the reader's confidence in
  the check. A witness that stands in for the real thing is named as a stand-in here.
- **`holds`** — `true` where the witness shows what the citing check's text says, `false` where it shows
  otherwise. A proof behind a `warn` that states the finding holds.
- **`raw`** — the few values that let the reader trust this one proof, **laid out to be read from top to
  bottom** in at most fifteen lines:
  1. a `#` line saying in plain words what was measured or asked;
  2. where the question is short enough to read at a glance — a request line, a rule as its source writes it —
     that line, under a one-word label where that helps;
  3. each value the citing checks rest on, one a line, under a plain name, its text kept exactly as it arrived;
  4. a `→` line with the outcome.

  Keep a value only where one of the citing checks rests on it. Redact secrets as `<redacted>`.
- **`image`** — where the witness is something seen and a picture adds to the proof, that picture, saved as
  `screenshots/NN_SLUG.NAME.png`.

**Cite each proof from the checks it shows, and from those only.** A check lists in `proofs` the ids of the
proofs that are about that check. A check the recording alone shows cites none. Every proof is cited by at least
one check; a proof nothing cites is dropped, or the check it shows is added.

`artifacts[]` is for files **the product produced** — a webhook body it posted, a file it delivered, a document it
generated — each as `{label, href, note}`.

## Recordings — every video of the scenario

`recordings[]` lists every video of the scenario in the order they were made. Each entry:

- **`label`** — the name on its card: the device or the way it was driven.
- **`kind`** — how it was driven: a walkthrough by this skill, or an automated test.
- **`device`** and **`browser`** — what it ran on, as the session reported them. An emulated device says it is
  emulated.
- **`video`** — the file. The report reads its size, shape and length from the file itself.
- **`frames[]`** — `{src, label}` for each promoted frame of that recording, in order.
- **`note`** — one line about how this recording was made, where a reader needs it.

**Files carry the recording's prefix.** The scenario's first recording uses `NN_SLUG`; each later one adds a
hyphen and one word naming it, `NN_SLUG-NAME`, on its video and on every frame.

Every video comes from one of three places:

- **Recorded.** A browser recording is its take, filmed by the round that drove it as `driving-the-browser.md`
  says. Step 5 checks that it plays, compresses it in place, and cuts any stretch where the picture stays still
  for over three seconds down to two. A take that followed the user across tabs was recorded in numbered parts,
  which Step 5 joins into the one video.
- **Recorded by the e2e runner.** An automated test's video is the one Step 2 saved beside the report. Step 5
  checks and compresses it like a take.
- **Assembled.** A device recording, and a browser recording whose recorder failed, gets its video built by
  ffmpeg from its promoted frames in `screenshots/`, grouped by the prefix before the `__`.

`SKILL.md`'s Step 5 carries the command, which reports one line per recording. **A `FAILED` line fails the
step**: a recording that does not play, a build ffmpeg could not finish, or a **stretched** frame, which the
script catches itself by comparing each source frame's aspect ratio with the crop window cropdetect found in the
video it built. The settings and the reasons for them live in the script.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs.
A recording whose video cannot be had keeps its frames and leaves `video` unset.

### An automated test's recording

An e2e video joins the scenario whose behaviour its tests cover, as one more recording with no `frames[]`:

- **Mark each check the test asserts** by citing a proof whose `raw` is the runner's own result line for the
  tests behind that check.
- **A failed test fails the checks it asserts**, with what the runner reported in `saw`.

Where no driven scenario covers the plan rows a video films, the video is the one recording of the scenario
Step 2 planned for it: `title` from the rows' `Scenario` cells, `given` from their `Given`, the steps from the
test's code in the order the video shows them, the checks from their `Expected`, and each `result` from the
runner's report.

## The design check

Every UI scenario you drove carries a `visualMatch`, which the report shows as its design check: what the screen
was compared with, the design beside the screen as built, and a list of checks. `visual-verification.md` is the
pass that produces it.

- **`baseline`** — the reference image's report-relative path, or `null` for a screen nobody drew.
- **`build`** — the screen as built, shown beside the baseline: the re-shoot at the design's width, else the
  frame of the take that shows the drawn screen. Every scenario with a baseline names one.
- **`width`** — the width of a re-shoot.
- **`checks[]`** — what the pass found, each a check in the shape *Given, steps and checks* gives, written for
  the same reader:
  - **`pass`** — the screen does what the design or the question asks. Say in one sentence what lined up, so a
    reader sees what was looked at.
  - **`fail`** — the build breaks what the design says. **A failed design check makes the scenario a
    `FAILURE`**, with a `bugs[]` entry behind it, filmed from its own repro like any other.
  - **`warn`** — worth a reader's look, and the scenario still passes. Its `note` says why it does not decide
    the verdict.

  A design check says what the user meets on the screen; the numbers behind it sit in the proof it cites.

**Grade a divergence by what it changes for the user**, as `visual-verification.md` says; a spacing or pixel
delta against the baseline is no check at all.

**Each `design/spec.md` rule a plan step cites for this screen is covered by a check.** Rules that tell the
reader one thing share one check, worded as that one thing. The check cites a proof whose `raw` holds, for each
rule, the rule as the spec writes it and the values read from the page, laid out as *Proofs* says.

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: does the run show the behaviour the docs describe?
It is answered one check at a time, each `result` resting on concrete evidence — a measured rect, a quoted
string, a computed style, a network response. **The scenario's `verdict` follows from its checks**: `SUCCESS`
where every check passed, `FAILURE` where any failed.

The **open visual review** asks what's wrong regardless of what was asked for: alignment, contrast, clipping,
overlap, a broken empty state, copy issues. Run it on every scenario, including the ones that passed cleanly.
Treat `truncate` and `line-clamp` on a primary headline as a bug to justify. Anything real you find here is a
bug, and Step 4 owns it. `visual-verification.md` is the one pass that runs it — against the design where the
plan supplies one, and against the screen's own coherence always.

## The report format

**The scenarios come from `verification/run-log.jsonl`, last line per scenario, as the ledger holds them, listed
with the journeys first and then set by set, each set in number order.** On a
feature that has been through a fix round, most scenarios were driven by an earlier round's agent, and that line
is all there is of them. The line's `scenario` object is the `scenarios[]` element itself, so a carried-over
scenario is transcribed into the report, and the `requirements` beside it are what `coverage[]` maps to that
scenario. A carried-over `NOT VERIFIED` scenario's `gaps[]` entry comes from the line's `gap` object the same
way.

**The surface row comes from this attempt.** `fields[]` carries one row naming where the run drove, written
once for the whole report:

- **A browser walk** writes a `Base URL` row with the host this attempt drove, as Step 1 held it.
- **A device walk** writes an `App` row with the app id, the platform, and each device's name and OS version,
  as Step 1 read them.

Every scenario's `url` is a path, so the reader joins it to this row to reopen the screen. When an earlier
round drove a different host or device, add that to the row's value in a few words.

Copy `references/proof-report-template.html` to `verification/proof-report.html` and **fill its JSON island —
the `<script type="application/json" id="report-data">` block. Change nothing else in the file.** You write
data; the template renders it. Its header comment is the field-by-field guide, and it stays in the file you
ship.

```json
{
  "title": "FEATURE",
  "drivenOn": "WHERE, AS WHAT USER, AGAINST WHICH DATA",
  "fields": [{ "label": "Base URL", "value": "HOST" }],
  "scenarios": [
    {
      "n": "NN",
      "slug": "NN_SLUG",
      "short": "RAIL LABEL",
      "group": "journey",
      "title": "THE QUESTION THIS SCENARIO ANSWERS",
      "verdict": "SUCCESS",
      "url": "PATH?QUERY",
      "given": ["ONE FACT THE SCENARIO STARTS FROM"],
      "steps": [
        {
          "when": "WHAT THE USER DOES",
          "checks": [{ "text": "WHAT SHOULD BE TRUE", "result": "pass", "proofs": ["PROOF ID"] }]
        }
      ],
      "recordings": [
        {
          "label": "NAME ON THE CARD",
          "kind": "HOW IT WAS DRIVEN",
          "device": "WHAT IT RAN ON",
          "browser": "BROWSER",
          "video": "NN_SLUG.mp4",
          "frames": [{ "src": "screenshots/NN_SLUG__SS_STEP.png", "label": "WHAT THE FRAME SHOWS" }]
        }
      ],
      "visualMatch": {
        "baseline": "../design/FILE",
        "build": "screenshots/NN_SLUG.design.png",
        "checks": [{ "text": "WHAT THE DESIGN ASKS OF THE SCREEN", "result": "pass", "proofs": ["PROOF ID"] }]
      },
      "proofs": [
        {
          "id": "PROOF ID",
          "label": "WHERE IT COMES FROM",
          "claim": "WHAT THE WITNESS SHOWED",
          "found": "WHY IT COUNTS",
          "holds": true,
          "raw": "THE VALUES THE CHECKS REST ON, LAID OUT TO BE READ",
          "image": "screenshots/NN_SLUG.NAME.png"
        }
      ]
    }
  ]
}
```

**`url` is the path the scenario opened on** — the path with its query string, with the host left to the
`Base URL` row, because the host changes with the stack while the path is the thing under test. One path per
scenario. **Redact what the query carries**: keep the parameters that select what was under test, write the
value of any auth or identity parameter as `<redacted>`, and record the path alone for a scenario reached
through a callback or a pre-signed URL. **On a device walk, `url` is the deep link the scenario opened, else the
screen path it reached** — the screen names from the app's root to the one under test, joined with `/` —
redacted the same way. A headless scenario's `url` is the request path it drove. A path a later step moved to
sits in the `raw` of a proof that step's checks cite.

When something fits none of the sections, put it in `extra[]` — `{heading, body, capture}`, all optional.

### Coverage and the derived verdict

`coverage[]` at the top level is the scope ledger: **one entry per requirement id the feature's docs list**,
reached or not, each `{req, scenario, verdict}`. It is what makes an incomplete run visible.

Several ids pointing at one scenario is normal and good. One id proven by more than one scenario stays **one
row** whose `scenario` names them all, carrying `FAILURE` if any failed and `NOT VERIFIED` if any went unproven.
Every id in the docs has a row.

**Every rule in `design/spec.md` is a requirement too.** When the run has a spec, read it top to bottom, whether
or not a plan step points at the part a rule sits in, and give each rule it states its own row, `req` set to
`SPEC:` followed by the rule in a few words. Its verdict comes from the design check that covers it: `SUCCESS`
when that check passed, `FAILURE` when it failed. A rule no scenario reached is `NOT VERIFIED` with a `gaps[]`
entry, and a rule that does not apply to this build is `INVALID` with why. The spec has no fixed format, so read
rules as the spec writes them: a sentence, a bullet or a table row each count.

**`verdict` is derived from that table:** any scenario `FAILURE` → `FAIL`; else any requirement
`NOT VERIFIED` → `PARTIAL`; an all-covered, all-`SUCCESS` run is `PASS`. Compute it once the table is complete
and write what it says.

### Bugs

`bugs[]` at the top level is **bugs in the application** — defects that will bite a user or a developer. Each
entry is `{severity, origin, reachedBy, scenario, title, body}`:

- **`scenario`** is the `n` of the scenario that reproduces it — the Step 4 walk you filmed for this bug. It
  carries the reader to the failed check, what was seen and the recording, so the entry leaves those to it.
- **`reachedBy`** is one sentence: the actor who reached it and the surface they used. An entry with no actor to
  name goes to `extra[]` as a note on what the feature trusts.
- **`origin`** is `introduced here`, `pre-existing` or `pre-existing, worsened here`, as `git blame` or the diff
  settled it; `body` says which commit or hunk settled it.
- **`severity`** is `blocker`, `major` or `minor`, and `body` says why that rung and not the one above.
- **`body`** is a report a maintainer could act on without asking a question: what it is, and the repro.

`bugs[]` carries what is still broken as the report is written, most consequential first; a bug a fix round
closed leaves a passing scenario and no entry. A `FAILURE` scenario states `reachedBy` and `origin` in its
`reason`, one sentence each. With no bugs, `bugs` is empty and the sentence from Step 4 naming your best attack
goes in `bugsNote`.

What this run could not reach goes in `gaps[]` — one entry per `NOT VERIFIED` scenario, every field filled:
`{scenario, req, mechanism, attempted, wouldClose}`. `mechanism` is the cause Step 4 made you read the blocking
path for: the line, condition, credential or absent datum. `attempted` lists the distinct approaches you ran.
`wouldClose` is the concrete thing a human or a later run can supply.

Your infrastructure adventures, the data you could not find, and the workaround that got the stack up go in
what you report back to whoever dispatched you (Step 6).

## Completion checklist — the report is done when all of these hold

- The JSON island parses, and the file opens in a browser showing every scenario — open it and look.
- `coverage[]` has a row for every requirement id the docs list, and `verdict` is what the derivation rule
  computes from it. Grep the docs for their id pattern and diff that set against the table.
- When the run has `design/spec.md`, `coverage[]` has a `SPEC:` row for every rule it states.
- Every scenario has a stable `n`, its `group`, a `title` that is the
  question it answers, a `given` list, and steps that
  each carry a `when` and at least one check.
- Every check of a driven scenario has a `result`, every failed check a `saw`, and each scenario's `verdict`
  is what its checks give: `SUCCESS` with every check passed, `FAILURE` with any failed.
- Every scenario graded other than `SUCCESS` has a `reason`. One you could not verify is `NOT VERIFIED` with
  what would close it; one that turned out not to apply is `INVALID` with why. Each keeps its place in the
  report.
- Every sentence the report shows reads to a Product or QA person with no developer beside them: told from the
  user's side, in the product's own words, naming things by their kind, with each technical original in a
  proof's `raw`.
- `title`, `given`, every `when` and every check describe the application and the user alone.
- Every recording of a scenario is in its `recordings[]` with its `label`, `kind`, `device` and, on a browser,
  `browser`; every replay and every automated test's video sits with the scenario whose behaviour it shows.
- The steps a recording shows read as a summary of it: play the video with those steps beside it.
- Every frame a recording lists is a moment of its video.
- Every proof has an `id`, a `label`, a `claim`, a `holds` and a `raw` laid out to be read, confirms one thing
  from one witness, and is cited by the checks it shows and by those only.
- Every proof's `raw` holds only the values its checks rest on, in fifteen lines or fewer.
- Every side-effect scenario carries the receipt Step 3 names for its sink, or is `NOT VERIFIED` with that sink
  named.
- Every UI scenario you drove carries a `visualMatch` with at least one check; one with a `baseline` names its
  `build`; every spec rule a step cites is covered by a check with its measurements in a proof; every check
  rests on a measurement or a computed style; and every failed design check has made its scenario a `FAILURE`
  with a `bugs[]` entry behind it.
- `fields[]` carries a `Base URL` row on a browser walk, or an `App` row on a device walk, and every scenario
  that drove a page or a request carries its `url` as *The report format* shapes it.
- Every `url` shows `<redacted>` for the value of an auth or identity parameter, and a path reached through a
  callback or a pre-signed URL carries no query.
- Every `NOT VERIFIED` scenario has a `gaps[]` entry whose `mechanism` names a line, condition, credential or
  absent datum, with `attempted` listing distinct approaches and `wouldClose` naming the concrete unblock.
- Every `bugs[]` entry carries a `reachedBy` naming a real actor and the surface they used, an `origin` settled
  by `git blame` or the diff, and the `n` of a scenario that exists and carries the failed check the entry
  leans on.
- Every path is report-relative, and every file named in `artifacts[]` exists beside the report under its
  scenario's prefix.
- The `report-media` script with `--inline` ran after the last edit to the report and printed `ok` for every
  file it names.
- Things this skill genuinely cannot reach are scenarios too, marked `NOT VERIFIED`.
- The plain sequential `n` values are the only identifiers a reader meets, and each thing is said once.
