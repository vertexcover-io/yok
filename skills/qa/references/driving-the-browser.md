# Driving the Browser

**Read this when:** driving UI scenarios (Step 2), or re-driving a bug's repro (Step 4). Everything here is done
with a browser open; grading, videos, and the report are in `writing-the-report.md`.

**Contents:**

- Setup
- The rules
- Catching a self-dismissing element
- Scout, then film — one take per scenario
- The frame that proves it
- Replaying the scenario on a phone

What depends on the app — how login works, which surfaces lie about their own state, whether a dev overlay is in
the way — is knowledge the project owns, held in its own skills and `CLAUDE.md`. Look for it before your first
`open`; a project that has been verified before has usually written its traps down.

## Setup

Use the binary directly (`npx` routes through Node instead of the Rust client and pays that cost on every call). On
Linux, launch with `agent-browser --args "--no-sandbox" open <url>` — without it Chrome dies on `No usable
sandbox!` and every later command reports a dead session. Export two variables before the first `open`, so every
command in the run and Step 7's cleanup agree on them:

```bash
export AGENT_BROWSER_SESSION=RUN               # the desktop session, named, so Step 7 closes the browser it actually drove
export AGENT_BROWSER_DEFAULT_TIMEOUT=2000      # fail a doomed wait fast instead of at the 25s default
```

**A session keeps the device it opened as for its whole life**, so the run holds one named session per device: the
desktop session for every desktop scenario and for Steps 3 and 4, and a phone session of its own, opened where
*Replaying the scenario on a phone* says. Each is an isolated browser with its own sign-in.

Without `AGENT_BROWSER_SESSION` every command drives the session named `default`, and a cleanup naming anything else
reports success while releasing nothing. Raise the timeout where the stack is across a network, since a budget tuned
for loopback turns latency into phantom failures.

The CLI ships its own guide, version-matched to the binary and authoritative on the basics — session/refs/snapshot,
the `wait` verbs, viewports, tabs, `record`:

```bash
agent-browser skills get core          # ~475 lines. Look things up here.
agent-browser skills get core --full   # ~2400 lines (~19k tokens). A lookup surface, not a read.
```

## The rules

`batch` — many commands per invocation, returning a JSON array of results — is the workhorse.

- **Pipe JSON on stdin** (argument mode lets the shell word-split your JS and eat the quotes), **one action per
  batch entry**.
- **Wrap every `eval` in an IIFE** — `eval` runs in one persistent global scope, so a top-level `const` throws
  `Identifier already declared` on the second call. `eval --stdin` fixes quoting, not scope.
- **Return a value from asserts and read it from `--json`.** Pass `--bail` on the setup batch (`open → auth →
  navigate`) and on the take, where a failed step ends the run. A scouting batch runs without it: an assert that
  *returns false* is a success either way, but one that *throws* is an error, and with `--bail` it takes the
  screenshot after it down with it — losing the picture exactly when you needed it.
- **Return the count beside the verdict and treat `n: 0` as a failed lookup.** `[].every(f)` is `true`, so
  `nodes.every(n => n.checked)` reports success over a selector that matched nothing and reads exactly like the real
  thing. `{n: nodes.length, ok: nodes.every(...)}`.
- **Match `innerText` after `.replace(/\s+/g,' ')`** — it inserts newlines at layout boundaries.
- **Measure in the batch *after* the one that moved things.** Act, `wait` on the condition, then measure.
- **Return `location.pathname + location.search` from that same assert**, never a batch of its own — it is the
  `url` a navigating step carries in the report, and a round trip per step is the one cost this run cannot afford.
  **Add `location.hash` where the app routes on the fragment**: an app whose routes read `#/reports/gstr2b` returns
  `/` from `pathname` on every screen, so every scenario records the same useless path and nothing fails to say so.
- **`wait` on the real condition** — `wait --text`, `--url`, `--load networkidle`, or `wait @eN` return the moment
  the state holds.

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>document.querySelectorAll('[data-testid^=row-]').length)()"],
 ["screenshot","<staging>/01_add_row__03_row_added.png"]]
EOF
```

## Catching a self-dismissing element

A toast, a flash banner, a spinner is gone by the next batch, so click, `wait` for it, then assert and screenshot
together in one batch, in this order:

```bash
cat <<'EOF' | agent-browser batch --json
[["click","[data-testid=save]"],
 ["wait",".toast"],
 ["eval","(()=>{const t=document.querySelector('.toast');return {shown:!!t,text:t?.innerText}})()"],
 ["screenshot","<staging>/03_save__04_toast_confirms.png"]]
EOF
```

The `wait` is load-bearing: the toast appears only after the request the click fires, so without it you shoot the
empty gap before the toast exists.

**When the element lives too briefly for `wait` to catch it** (`wait` reaches down to ~150ms), block the batch on
the element's arrival instead. One `eval` arms a `MutationObserver`, fires the action, and returns a Promise that
resolves the moment the element lands; `eval` awaits that Promise, so the screenshot in the next batch entry lands
while the element is still on screen:

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>new Promise(res=>{const sel='[data-testid=flash]';const t0=Date.now();const done=v=>{obs.disconnect();clearTimeout(timer);res(v)};const obs=new MutationObserver(()=>{const el=document.querySelector(sel);if(el)done({appeared:true,ms:Date.now()-t0,text:el.innerText})});obs.observe(document.body,{childList:true,subtree:true});const timer=setTimeout(()=>done({appeared:false,ms:Date.now()-t0}),2000);document.querySelector('[data-testid=save]').click()}))()"],
 ["screenshot","<staging>/05_save__03_flash_confirms.png"]]
EOF
```

The order inside the eval is load-bearing: **observe → arm the timeout → click**, then resolve on arrival. Arming
after the click is the race you came here to close. When it resolves `{appeared: false}`, record the element
`NOT VERIFIED` with the `ms` lifetime you measured.

## Scout, then film — one take per scenario

**The video is a recording of the scenario from its first step to its last, and of nothing else.** So each
scenario is driven twice: a scout that works the flow out with the recorder off, then one take that replays the
whole flow as a single command with the recorder on. The take is the evidence. Its asserts decide the verdict, its
screenshots are the frames, its recording is the video and its actions are the report's `when`, so all four come
from one run.

**Film the whole life of the scenario, not a checklist of its steps.** Every step earns at least one frame, many earn
more — a scenario with more *promoted* frames than steps is doing it right.

### 1. Scout the flow, recorder off

Drive the scenario one step at a time until you hold four things for every step:

- **The target**, as a selector that survives a reload: CSS, or `xpath=…` where only its text tells the element
  apart. A snapshot ref belongs to the page that issued it, so refs are for scouting and selectors are for the take.
- **The condition** that shows the step landed — the `wait` that returns the moment the state holds.
- **The assert**, and the value it returns when the behaviour is right.
- **The way to the target**, as a person would get there: the scroll that brings a target outside the viewport
  into view, the field to click before typing into it, the option to click once a list is open, the centre of an
  element the user only points at.

Screenshots taken while scouting go to staging and serve your own reading. Retries, dead ends and missed clicks
all happen here, where nothing is filmed.

### 2. Clear the evidence of an earlier round

A scenario an earlier round filmed keeps its frames, its video and its produced files until you delete them:

```bash
rm .yok/RUN/artifacts/verification/screenshots/NN_* .yok/RUN/artifacts/verification/NN_*
```

That covers the frames, the `NN_<slug>.mp4`, and the `NN_<slug>.<ext>` download or webhook body its `artifacts[]`
named. Each one left behind is cited as this round's evidence: a frame from a step the walk no longer has, a video
of a version of the feature that no longer exists, a download this round never produced. Nothing downstream can
tell a stale file from a fresh one, and the report cites whatever it is handed.

Staging needs no clearing — nothing leaves it unverified.

### 3. Return to the scenario's opening state

Scouting moves the page and may have written data. Before the take, open the scenario's first path again, restore
every control the scout changed, and re-seed, the Step 1 way, every fixture the scout used up. The take starts
where a user starting this scenario would start: the state its `given` describes. The recording opens on that
state, settled and in view.

### 4. Film the take

Three commands, in this order: start the recorder, run the whole flow as one batch, stop the recorder.

```bash
agent-browser record start /abs/path/to/.yok/RUN/artifacts/verification/NN_SLUG.mp4 --cursor
cat <<'EOF' | agent-browser batch --json --bail
[["mouse","move","X","Y"],
 ["wait","1500"],
 ["click","SELECTOR","--human"],
 ["wait","CONDITION"],
 ["eval","(()=>({ASSERT}))()"],
 ["screenshot","/abs/path/to/.yok/RUN/verify-staging/NN_SLUG__SS_STEP.png"],
 ["wait","1500"]]
EOF
agent-browser record stop
```

**Write every path absolute** — the heredoc is quoted and your shell's cwd resets between calls.

The take is one continuous recording with three parts: an opening hold, the steps, a closing hold.

**The opening hold.** The batch opens by moving the pointer to the middle of the page, so its first journey starts
in view, then holds the opening state for about a second and a half, so a person watching reads where the scenario
starts before anything moves.

**The steps.** Every step of the flow is the same five entries, in this order:

1. **Act the way a person would: the pointer travels to the target, lands on it, then the action happens.**
   `--cursor` draws the pointer into the recording and `--human` makes it travel on a smooth path from where it
   last was, so the viewer follows one pointer from the first frame to the last and sees every action coming. Each
   kind of action has its filmed form:

   | The user | Filmed as |
   | --- | --- |
   | clicks | `click SELECTOR --human` |
   | types | `click SELECTOR --human` on the field, then `keyboard type` a few words at a time with a `wait` of about 300 between, so the text is seen arriving; a field that already holds text gets `press Control+a` after the click |
   | picks from a list | `click SELECTOR --human` on the list, then `click SELECTOR --human` on the option; a list the browser draws itself takes `select` after the click |
   | points at an element | `mouse move X Y --human` to the element's centre |
   | reaches a target off screen | an `eval` that calls `scrollIntoView({behavior:'smooth',block:'center'})` on it, a `wait` of about a second while the page glides, then the action |
   | presses a key | `press KEY`, once the pointer has clicked the place the key acts on |

   The instant forms — `fill`, `hover`, `scrollintoview`, a bare `mouse move` — belong to the scout and the setup
   batch, where speed is what counts.
2. **Wait on the condition** you scouted for that step.
3. **Assert**, returning the value and the path as *The rules* say.
4. **Screenshot to staging.** A frame shot during the take carries the pointer, which shows the reader what was
   just clicked.
5. **Pause about a second**, so a person watching can read the screen before it changes. The pause paces the
   video; the wait in entry 2 is what makes the step reliable.

**The closing hold.** The last step's pause runs about a second and a half, so the video rests on the final state
— the outcome the scenario's `then` promises — long enough to read.

`--bail` ends the batch at the first step that fails, so nothing after it is filmed on the wrong screen. `record
stop` is a command of its own, run after the batch whatever the batch returned, because it is what closes the file.

### 5. Judge the take

**A take counts when the batch exited 0, every entry reports success, every assert returned the value the scout
recorded, and every action was filmed in its human form.** Any other take is discarded whole: delete its video and its staged frames, correct the step that
failed, return to the opening state, and film again. A clean-looking video of a take that failed a step shows
something other than the scenario.

- **An assert that held in the scout and fails in the take is a finding about the feature.** Drive it once more to
  learn which state the behaviour depends on, then grade the scenario on what you found.
- **A recorder that fails three takes running** — the feature behaving, the recording not — hands the scenario to
  the stitched path: run the same batch with the recorder off, promote its frames as below, and leave the scenario
  without an `.mp4`. Step 5 builds its video from those frames.

### 6. Confirm the frames and promote them

**Open every staged PNG and confirm it shows what you think** — the round-trip you never skip. Once the take
counted and your eyes confirmed a frame, **promote it**: `mv` it into `verification/screenshots/` under its
`NN_<slug>__SS_<step>.png` name, and keep the assert's deciding value (the returned `{n: …}`, the measured rect,
the quoted string) for the scenario's `output`.

You need both checks. **The assert answers whether the state took hold** — a click that silently no-ops looks
identical to one that worked until you ask the DOM. **The look answers whether the frame shows it.** When they
disagree, the frame usually lags the render: film the take again with the wait on that step's real condition. Check
the assert against *The rules* above too, where its ways of lying are listed, and settle it by asking the page a
second way.

**A file the scenario downloads is evidence — keep it** beside the report as `verification/NN_<slug>.<ext>`, the
same prefix as its video, and list it in the scenario's `artifacts[]`.

Frame a non-feature element at the top and bottom edge of each shot, so the frame carries the feature's neighbours:
a sticky bar landing mid-page, orphaned actions, and a header misaligned once the feature mounts are all bugs only a
wider shot catches. Read the page's expected top-level section ordering from the project's skills or layout — that
ordering is a layout invariant your frames must uphold. Prefer a cropped or clipped shot over full-page: it keeps
the frame readable at video size.

### 7. Write When and Output from the take

**The take that counted is the source of the scenario's account.** Read its batch from top to bottom, with its
`--json` result beside it, and write two short paragraphs:

- **`when` narrates the user's actions** in the order the batch ran them, naming each control by its label on
  screen and each value entered.
  Pointer placement, scrolling into view, waits and pauses are the take's own mechanics and stay in the batch.
- **`output` tells what the page gave back in that take** for each outcome `then` promises, stating the deciding
  values the way the page shows them. What an assert returned goes in a proof's `raw` where a reviewer gains from
  seeing it.

Written this way, the video and the report describe one run. A scenario the stitched path filmed is written from
the batch that produced its promoted frames.

## The frame that proves it

Every scenario turns on a few facts held together — *these two numbers differ by this much, and the verdict says
this*. **Get them into one frame.** Work in this order, and stop as soon as the shot holds:

1. **Use the app's own controls** — a column chooser, a density toggle, a collapse. Cheapest and most honest.
   **Restore what you changed** — these settings persist for the account you're driving.
2. **Set the viewport to fit** — `agent-browser set viewport 1600 900`.
3. **Only if neither works, overlap.** Keep an identifying column in every frame so the shots stitch, and say in the
   report that the evidence spans frames.

Then check the shot actually shows what you think — **a rect inside the viewport is not a visible cell.**
`getBoundingClientRect()` is blind to occlusion: a sticky overlay over the value column measures `visible: true` and
photographs as covered. Ask the page what is on top of each cell:

```js
(()=>{const r=el.getBoundingClientRect();
      const top=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return {covered: !(el===top || el.contains(top))};})()
```

**Every cell the frame is offered as evidence for must be un-occluded at its own centre, and the row must be
identifiable in that same frame.**

## Replaying the scenario on a phone

**The replays run last, in the phone's own session.** Once every desktop scenario is filmed, open a second named
session and make it the phone before the app loads:

```bash
export AGENT_BROWSER_SESSION=RUN-phone         # on every phone command; the desktop session keeps its own name
agent-browser set device "iPhone 14"
```

A **device**, not a narrow viewport: an app that branches on user-agent or touch rather than width serves its
desktop layout to a resized window, and you photograph a mobile pass that never happened. The session is that
phone from here to its close, so every replay runs in it and every desktop command keeps naming the desktop
session. The phone session starts signed out and empty: run the setup batch in it from the first `open`, the way
the desktop session began.

**Film the whole scenario again on the phone, as a take of its own.** Run the seven steps above under the replay's
own `NN_<slug>`: the same steps and the same asserts as the desktop take, scouted again wherever the phone presents
a control differently or puts a target off screen. A phone breaks on the way to the final screen rather than on
it, so the take runs from the first click. The recording keeps the phone's own portrait shape.

The replay carries a verdict, so the walk answers the same question it answered on desktop:

- **The closing assert returns the value it returned on desktop** — the outcome, not a similar-looking screen. This
  is what the scenario's `then` already claims, now claimed at phone width.
- **Nothing scrolls sideways** — `(()=>({over: document.documentElement.scrollWidth -
  document.documentElement.clientWidth}))()` returns `0`. Anything above zero is a bug with its measurement already
  attached.
- **Controls are reached the way the phone presents them** — driven through the menu the layout collapsed them into,
  the way the user gets to them.

A replay that fails is a `FAILURE` scenario and a `bugs[]` entry like any other, and its `reachedBy` writes itself:
the user on that device, and the surface they touched.
