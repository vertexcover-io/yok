# Writing the Proof Report

**Read this when:** writing a scenario up and grading it (Steps 2 to 4), completing the videos (Step 5), or writing
the report (Step 6). The driving and capture craft is in `driving-the-browser.md` and `driving-the-device.md`.

**Contents:**

- The reader — Product and QA
- A scenario's four blocks — Given, When, Then, Output
- Grading — two tracks
- The videos (Step 5)
- The report format
- Completion checklist — the report is done when all of these hold

## The reader — Product and QA

**The report is read by Product and QA people who have never seen the code.** They open it to learn what the
feature does for its user and whether that held. Every sentence the report shows them — a title, the four blocks,
a `reason`, a proof's `claim` and `found`, a finding, a bug's title and body — is written in **plain language**:

- **Tell it from the user's side**: who did what, what they got, what stayed saved.
- **Use the product's own words** for its screens, controls and messages, the way the user sees them, and everyday
  words for everything behind the screen.
- **State a value where the outcome turns on it**, the way the product shows it to the user.
- **Send the technical original to its own place**: a request, a response, a status code, a field name, an
  identifier, a command or an assert's return goes in a proof's `raw`, and the code behind a bug or a gap goes in
  that entry's own fields.

Read each sentence back as that reader: it makes sense on its own, with no developer beside them.

## A scenario's four blocks — Given, When, Then, Output

A scenario is written the way the `write-scenarios` skill writes a test scenario — its title says what is tested,
then **Given**, **When** and **Then** — with **Output** added as the fourth block: what the system returned.

**Each block is one short paragraph of plain sentences, two or three at most**, the length a reader takes in at a
glance. A block tells the reader what matters and leaves the full detail to the video and to `proofs[]`.

Two blocks are written before the scenario is driven and two after it, in this order:

1. **`given`, from the docs, before driving.** Who the user is, the situation they start in, and the permissions,
   settings and data that matter. It is the opening state the run starts from.
2. **`then`, from the docs, before driving.** Whether the action succeeds, what the user gets, and what stays
   saved, with the values the outcome turns on. It is the bar the run is graded against, set while the result is
   still unknown.
3. **`when`, from the run that is the evidence, after it.** What the user did, told in the order the run did it,
   naming each control by its label on screen and each value entered. The source is the run itself — the take
   that counted on a browser walk, the capture loop on a device walk, the requests as sent on a headless walk — so
   the paragraph reads as a narration of the video. On a headless walk it tells what was asked of the system and
   on whose behalf. An action the recording does not show is named as happening before or after it.
4. **`output`, from the same run.** What the system gave back, answering `then` in the order `then` promises it:
   what appeared, what was accepted or refused, what stayed saved, stating each deciding value the way the product
   shows it. The original behind a value — the assert's return, the response, the stored record — goes in a proof.

A walk that stopped short tells in `when` how far it got and in `output` what came back that far; a scenario
nothing could drive carries `given` and `then` alone.

**`reason` belongs to a scenario graded `FAILURE`, `NOT VERIFIED` or `INVALID`**, kept to what the verdict turns
on: where `output` departs from `then` and how, with the two facts *Bugs* asks of a `FAILURE`; what blocked the
walk and what would close it; or why the scenario does not apply. On a `SUCCESS` the two blocks agree and say it
themselves.

Anything else the walk observed goes to the field that owns it: a divergence from the design to
`visualMatch.findings`, a mechanism or a whole exchange to a proof, a remark that fits neither to `extra[]`.

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: do these frames show the behaviour the docs describe?
The verdict is `SUCCESS` or `FAILURE`, and it cites concrete evidence — a measured rect, a quoted string, a computed
style, a network response. Layout claims cite a measurement. This becomes the scenario's `verdict`, and the
evidence it cites is the scenario's `output`.

The **open visual review** asks what's wrong regardless of what was asked for: alignment, contrast, clipping,
overlap, a broken empty state, copy issues. Run it on every scenario, including the ones that passed cleanly. Treat
`truncate` and `line-clamp` on a primary headline as a bug to justify, not a default to accept. Anything real you
find here is a bug, and Step 4 owns it. `visual-verification.md` is the one pass that runs it — against the
design where the plan supplies one, and against the screen's own coherence always. This file renders its result.

## The videos (Step 5)

Every scenario has one video, `NN_<slug>.mp4`, beside the report. It comes from one of two places:

- **Recorded.** A browser scenario's video is its take, filmed by the round that drove it as
  `driving-the-browser.md` says. Step 5 checks that it plays and compresses it in place, since the report carries
  every video inline.
- **Assembled.** A device scenario, and a browser scenario whose recorder failed, gets its video built by ffmpeg
  from its promoted frames in `screenshots/`, grouped by the `NN_<slug>` prefix before the `__`.

`SKILL.md`'s Step 5 carries the command, which reports one line per scenario. **A `FAILED` line fails the step**: a
recording that does not play, a build ffmpeg could not finish, or a **stretched** frame, which the script catches
itself by comparing each source frame's aspect ratio with the crop window cropdetect found in the video it built.
The settings and the reasons for them live in the script.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs. If
a video cannot be had, name the scenario and move on; its frames still prove it.

## The report format

**The scenarios come from `verification/run-log.jsonl`, last line per scenario, not from what you remember driving.**
On a feature that has been through a fix round, most scenarios were driven by an earlier round's agent, and that line
is all there is of them. It carries the finished write-up rather than a summary of it: the line's `scenario` object is
the `scenarios[]` element itself, so a carried-over scenario is transcribed into the report rather than reconstructed.
Its `url`, `given`, `when`, `then`, `output`, `reason`, `proofs`, frames and labels are the ones the round that drove it wrote, and
the `requirements` beside it are what `coverage[]` maps to that scenario. The one field the terminal round fills in is
`video`, and only for a scenario whose video Step 5 built: a recorded take's `video` is already on its line. A carried-over `NOT VERIFIED` scenario's `gaps[]` entry comes from the line's
`gap` object the same way. So a carried-over scenario reads no differently from one you drove yourself.

**The surface row comes from this attempt, not from the ledger.** `fields[]` carries one row naming where the
run drove, written once for the whole report:

- **A browser walk** writes a `Base URL` row with the host this attempt drove, as Step 1 held it:
  `{ "label": "Base URL", "value": "http://localhost:3000" }`.
- **A device walk** writes an `App` row with the app id, the platform, and each device's name and OS version, as
  Step 1 read them: `{ "label": "App", "value": "com.example.app on ios; iPhone 17 Pro simulator, iOS 26.3;
  iPad Pro 13-inch (M4) simulator, iOS 26.3" }`. A replay scenario names its device in its title, so a reader
  knows which of them a frame came from.

Every scenario's `url` is a path, so the reader joins it to this row to reopen the screen. When an earlier
round drove a different host or device, add that to the row's value in a few words, so a carried-over scenario's
path is read against the surface it was driven on.

Copy `references/proof-report-template.html` to `verification/proof-report.html` and **fill its JSON island — the
`<script type="application/json" id="report-data">` block. Change nothing else in the file.** You write data, not
markup; the template renders it. Its header comment is the field-by-field guide, and it stays in the file you ship.

The report opens on the first scenario; there is no prose preamble. The run's context lives in `drivenOn` and
`fields[]`, behind the bar's run details, and the derived `verdict` is the badge in the bar.

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
      "title": "WHAT IS TESTED",
      "verdict": "SUCCESS",
      "url": "PATH?QUERY",
      "given": "USER, STARTING SITUATION, DATA AND SETTINGS",
      "when": "WHAT THE USER DID, IN THE ORDER THE VIDEO SHOWS IT",
      "then": "WHAT THE DOCS PROMISE",
      "output": "WHAT THE SYSTEM RETURNED, WITH THE DECIDING VALUES QUOTED",
      "video": "NN_SLUG.mp4",
      "frames": [{ "src": "screenshots/NN_SLUG__SS_STEP.png", "label": "WHAT THE FRAME SHOWS" }]
    }
  ]
}
```

**`url` is the path the scenario opened on** — the path with its query string, never the host:
`/app/6a59f2c1/reports/gstr2breconciliation?period=062026`. The host is one `fields[]` row, `Base URL`, written once
for the whole run, because it changes with the stack while the path is the thing under test. One path per scenario:
a later path the walk moved to is named in `when`, at the action that moved there. **Redact what the query carries** — this
report is read and shared beyond this run, and a driven URL routinely carries a live credential: an SSO `?code=`, a
`?token=`, a pre-signed `X-Amz-Signature`, an `?email=`. Keep the parameters that select what was under test
(`?period=062026`), write the value of any auth or identity parameter as `<redacted>`, and record the path alone for a
scenario reached through a callback or pre-signed URL. A session token is not what makes a screen reproducible.
**On a device walk, `url` is the deep link the scenario opened, else the screen path it reached** — the screen
names from the app's root to the one under test, joined with `/` — redacted the same way.

Five shapes are fixed, because they are what makes two reports comparable: **`given`, `when`, `then` and
`output` render in that order**, each a short paragraph under its heading, and **`video` + `frames[]` render as
Visual proof** under them, the video leading with the screenshots folded behind a toggle. Everything else is prose you shape
yourself. When something fits none of the sections, put it in `extra[]` — `{heading, body, capture}`, all optional,
no imposed shape.

### Supporting proofs

A proof is a **second witness**: somewhere other than the screen confirming what the scenario's `output` says —
the datastore, the product's own API, a third-party service, a log, the sink an effect lands in. A scenario earns
one for each thing worth a second witness: an effect with no screen, a value that was stored, the way an outcome
was reached.

**One proof confirms one thing, read from one witness.** Two things confirmed, or two witnesses, are two proofs. A
reviewer takes each in at a glance, so every entry has the same four parts:

- **`claim`** — what the witness showed, as one short plain sentence. It states what was found, so a proof that
  failed reads as the failure.
- **`found`** — what this proof is for, in one or two short plain sentences: what it confirms about the scenario,
  then what that means for the user or the product. A reviewer reads it to learn why this proof is here and what
  it adds to their confidence in the scenario. A witness that stands in for the real thing is named as a stand-in
  here.

  Both are written for *The reader*, and everything technical stays in `raw`.
- **`holds`** — `true` where what was found is what the scenario's `then` promises, `false` where it goes against
  it.
- **`raw`** — the original behind this one proof, untouched: the request as sent, the status, the response as it
  came back, the rows as returned, the log lines. Several calls behind one claim go in the order they ran. Redact
  secrets as `<redacted>`.

A proof renders as one folded row showing its mark, `claim` and `found`; opening it shows `raw`.

```json
"proofs": [
  {
    "claim": "WHAT THE WITNESS SHOWED",
    "found": "WHAT THIS PROOF IS FOR: WHAT IT CONFIRMS, AND WHY THAT MATTERS HERE",
    "holds": true,
    "raw": "THE ORIGINAL BEHIND THIS PROOF"
  }
]
```

`artifacts[]` is for files **the product produced** — a webhook body it posted, a file it delivered, a document it
generated — each as `{label, href, note}`.

**Read the scenario's video, then its proofs, and keep each proof that adds to a reviewer's confidence in the
scenario's `output`.**

### The visual match

Every UI scenario carries a `visualMatch`. It is how a reader sees, without opening a single image, whether the
screen was drawn before it was built and whether the build kept to the drawing.

```json
"visualMatch": {
  "baseline": "../design/reconciliation-detailed.png",
  "build": "screenshots/NN_SLUG.design.png",
  "width": 1440,
  "fidelity": 75,
  "matched": "Region order, the filter row's controls, the Complete Match chip and its copy all read as drawn.",
  "specRules": [
    { "rule": "<the spec rule as written>", "held": true, "evidence": "<the computed style that shows it>" }
  ],
  "findings": [
    { "severity": "BLOCKER",
      "what": "The period selector is drawn as the screen's primary control and renders as a tertiary one",
      "baselineShows": "filled accent button, 16px label",
      "buildShows": "ghost button, 13px label",
      "evidence": "getComputedStyle → background-color: rgba(0,0,0,0); font-size: 13px" }
  ]
}
```

- **`baseline`** is the reference image's report-relative path, or `null` for a screen nobody drew. The report
  shows a Design match section where there is a baseline to compare against, and where a screen nobody drew still
  has findings to show; a scenario with neither shows no such section.
- **`build`** and **`width`** are the re-shoot at the width the plan gives the frame. Leave both out when the
  scenario was already shot at that width. The report renders the baseline beside `build`, or beside the
  scenario's first frame when there was no re-shoot, so a reader compares them without leaving the page.
- **`fidelity`** is derived, per `visual-verification.md`: 100, less 25 a BLOCKER and 8 a HIGH, floored at 0.
  It is `null` wherever `baseline` is. **A scenario whose findings carry a BLOCKER is a `FAILURE`** — the
  divergence is a bug, filmed from its own repro like any other, and its fidelity is not a second opinion the
  reader gets to weigh against the verdict.
- **`matched`** is one sentence on what lined up. A findings list with nothing beside it reads as a broken screen
  even when nine tenths of it was right.
- **`specRules[]`** lists every `design/spec.md` rule a plan step cites for this screen, each with `held` set to
  whether the build kept it and `evidence` holding the computed style or measurement that shows it. Write it only
  when the run has a `spec.md`.
- **`findings[]`** carry `severity` of `BLOCKER` or `HIGH` only. **Grade a divergence by what it changes for the
  user, never by a spacing or pixel delta against the baseline**; where a spacing delta broke something in the
  build, record that break as a sanity finding on its own terms, with its own measurement.

### Coverage and the derived verdict

`coverage[]` at the top level is the scope ledger: **one entry per requirement id the feature's docs list**, whether
or not you reached it. It is what makes an incomplete run visible instead of arithmetically green.

```json
"verdict": "PARTIAL",
"coverage": [
  { "req": "R2", "scenario": "01", "verdict": "SUCCESS" },
  { "req": "R5", "scenario": "07", "verdict": "NOT VERIFIED" },
  { "req": "R15", "scenario": "12", "verdict": "INVALID" }
]
```

Several ids pointing at one scenario is normal and good — a single walk that proves five requirements is a better
walk. One id proven by more than one walk — a desktop scenario and its phone replay, or a device scenario and its
replays on the other listed devices — stays **one row** whose `scenario` names them all (`"01, 09"`), carrying
`FAILURE` if any failed and `NOT VERIFIED` if any went unproven. What is not allowed is an id in the docs with no
row here.

**Every rule in `design/spec.md` is a requirement too.** When the run has a spec, read it top to bottom, whether or
not a plan step points at the part a rule sits in, and give each rule it states its own row, `req` set to
`SPEC: <the rule in a few words>`. Its verdict comes from the scenario that checked it, through that scenario's
`visualMatch.specRules`: `SUCCESS` when it held, `FAILURE` when it broke. A rule no scenario reached is
`NOT VERIFIED` with a `gaps[]` entry, and a rule that does not apply to this build is `INVALID` with why. The
spec has no fixed format, so read rules as the spec writes them: a sentence, a bullet or a table row each count.

**`verdict` is derived from that table, never chosen:** any scenario `FAILURE` → `FAIL`; else any requirement
`NOT VERIFIED` → `PARTIAL`; only an all-covered, all-`SUCCESS` run is `PASS`. Compute it after the table is
complete and write what it says, including when the run you just did feels like a pass.

### Bugs

`bugs[]` at the top level is **bugs in the application** — defects that will bite a user or a developer: a misleading
message, lost or corrupted data, stale UI state, a 500 reaching the user, a silent no-op, a permission leak, a broken
recovery path; or, for developers, a documented command that is gone, an artifact contradicting the tree.

`scenario` is the `n` of the scenario that reproduces it — the Step 4 walk you filmed for this bug. It is what
carries the reader from the Bugs pane to the expectation, the observed behaviour and the video, so the entry never
restates them.

**A bug an earlier round fixed gets no entry and no note**: `bugs[]` carries only what is still broken when the report
is written, so a round-1 bug that round 2 fixed leaves a passing scenario and no trace of itself, because every entry
is backed by a scenario that reproduces it now.

`reachedBy` and `origin` are the two Step 4 settled before you got here — the actor and surface that produced it,
and what `git blame` said about where it came from:

```json
{
  "severity": "major",
  "origin": "pre-existing, worsened here",
  "reachedBy": "A returning customer changed plan on a lead whose proforma was raised the previous day — PATCH /demands/:leadId, ordinary account, nothing hand-written.",
  "scenario": "09",
  "title": "…", "body": "…"
}
```

`reachedBy` is one sentence: the actor and the surface they used. An entry you cannot write one for is not a bug —
it goes to `extra[]` as a note on what the feature trusts, or nowhere. Say in `body` which commit or diff hunk settled
`origin`.

The same two facts belong on any scenario carrying a `FAILURE` verdict, for the same reasons. A scenario has no fields
of its own for them, so they go in its `reason` — one sentence naming the actor and surface, one naming what `git
blame` settled.

Each is a bug report a maintainer could act on without asking you a question: what it is, its severity (blocker /
major / minor) and why that rung and not the one above, and the repro. What should have happened and what did are
already the scenario's `then` and `output`, so the entry names that scenario in `scenario` rather than
restating them — and the reader reaches its video from there. Most consequential first. Your infrastructure
adventures, the data you couldn't find, and the workaround that got the stack up go in what you report back to
whoever dispatched you (Step 6). Found no bugs? Leave `bugs` empty; the sentence from Step 4 naming your best
attack and why it didn't land goes in `bugsNote`, which renders either way.

What this run could not reach goes in `gaps[]` — one entry per `NOT VERIFIED` scenario, every field filled:

```json
"gaps": [
  {
    "scenario": "07",
    "req": "R5",
    "mechanism": "`shouldCreateProforma()` at src/hooks/create-proforma-against-lead.js:310 requires the lead to carry both `product` and `pricePlan`; this environment's Premium business has no product with a price plan.",
    "attempted": ["seeded a lead through the service and drove PATCH /demands/:id",
                  "set source=PREMIUMN and retried",
                  "re-ran with DEBUG=* and read the hook's own branch trace"],
    "wouldClose": "A product with at least one price plan on the Premium business, or a fixture that builds one."
  }
]
```

`mechanism` is the cause Step 4 made you read the blocking path for, written to the standard set there — the
sentence above passes it. `attempted` is what you actually ran, distinct approaches rather than retries of one.
`wouldClose` is the concrete thing a human or a later run can supply.

## Completion checklist — the report is done when all of these hold

- The JSON island parses, and the file opens in a browser showing every scenario — open it and look before you call
  this done.
- `coverage[]` has a row for every requirement id the docs list, and `verdict` is what the derivation rule computes
  from it. Grep the docs for their id pattern and diff that set against the table before you call this done.
- When the run has `design/spec.md`, `coverage[]` has a `SPEC:` row for every rule it states. Read the spec once more
  against the table before you call this done.
- Every `NOT VERIFIED` scenario has a `gaps[]` entry whose `mechanism` names a line, condition, credential or
  absent datum, with `attempted` listing distinct approaches and `wouldClose` naming the concrete unblock.
- Every `bugs[]` entry carries a `reachedBy` naming a real actor and the surface they used, and an `origin` of
  `introduced here` / `pre-existing` / `pre-existing, worsened here` settled by `git blame` or the diff. Every
  `FAILURE` scenario carries both in its `reason`.
- Every `bugs[]` entry names in `scenario` the `n` of the scenario that reproduces it, and that scenario exists with
  the `then` and `output` the entry leans on.
- Every scenario carries a `given` and a `then` taken from the docs, a `when` that tells the actions of the run
  behind its evidence in the order they ran, and an `output` that answers `then` with the values the system
  returned.
- Each of the four blocks is one short paragraph, two or three sentences at most.
- Every sentence the report shows reads to a Product or QA person with no developer beside them: told from the
  user's side, in the product's own words, with each technical original in a proof's `raw` or in its bug's or
  gap's own fields.
- Every scenario's `when` reads as a narration of its video: play the video with the paragraph beside it.
- `fields[]` carries a `Base URL` row on a browser walk, or an `App` row on a device walk; every scenario that
  drove a page or a request carries the `url` it opened on, path and query and no host, or on a device the deep
  link it opened, else its screen path; and a `when` that moved the browser to another path names that path.
- No `url` in the report carries a live credential: an auth or identity parameter's value reads `<redacted>`, and a
  path reached through a callback or a pre-signed URL records no query at all.
- Every proof confirms one thing from one witness, in a short `claim` and `found`, and its `found` tells the
  reviewer what the proof is for: what it confirms about this scenario and why that matters.
- Every proof's `raw` shows a request a dev could paste and the complete response it returned, inline — nothing about
  an exchange is left in a file for the reader to go and open.
- Every scenario has a stable `n` and a `verdict`, every scenario graded other than `SUCCESS` has a `reason`, and
  every behaviour the docs describe is covered. One
  you could not verify is a scenario with `NOT VERIFIED` and a reason saying what would close it; one that turned out
  not to apply is `INVALID` with why. Neither is dropped, and neither is quietly backfilled with an adjacent passing
  check.
- Every verdict cites a live observation from this run — a DOM assert, an HTTP status and body, a DB read-back, a
  measured rect, a captured webhook body. Where that observation is mechanism rather than surface, it is a `proofs[]`
  entry, written once.
- Every UI scenario carries a `visualMatch`: a `baseline` path with a derived `fidelity` where a design defines the
  screen, read at the frame's width, or `baseline: null` where none does. Every spec rule a step cites is in
  `specRules[]`. No `findings[]` entry rests on a spacing delta alone, every entry cites a measurement or a computed
  style, and every `BLOCKER` has made its scenario a `FAILURE` with a `bugs[]` entry behind it.
- Every UI scenario names its `video`, every path is report-relative, and every file named in `artifacts[]` exists
  beside the report under the same `NN_<slug>` prefix. No frame or file resolves to a broken link.
- The `report-media` script with `--inline` ran after the last edit to the report and printed `ok` for every file it names.
- Every side-effect scenario carries the receipt Step 3 names for its sink — mail-viewer frames, the queue read, the
  captured artifact — or is `NOT VERIFIED` with that sink named.
- Things this skill genuinely cannot reach (a touch-hold on a browser walk, real-device sensors, visual diffs
  against last week's build) are scenarios too, marked `NOT VERIFIED`.
- No internal ids appear anywhere — the plain sequential `n` values are the only identifiers a reader needs. Nothing
  is said twice.
