# Driving the Browser

**Read this when:** driving UI scenarios (Step 2), drawing a CLI test's terminal frames (Step 4), or
re-driving a bug's repro (Step 5). Everything here is done with a browser open; grading, videos, and the report
are in `writing-the-report.md`.

**Contents:**

- Setup
- Signing a person in to a third party's screen
- The rules
- Catching a self-dismissing element
- Scout, then film — one take per flow
- The frame that proves it
- Replaying the scenario on a phone
- Terminal frames — a CLI test's recording

What depends on the app — how login works, which surfaces lie about their own state, whether a dev overlay is in
the way — is knowledge the project owns, held in its own skills and `CLAUDE.md`. Look for it before your first
`open`; a project that has been verified before has usually written its traps down.

## Setup

Use the binary directly (`npx` routes through Node instead of the Rust client and pays that cost on every call).
Export three variables before the first `open`, so every command in the run and Step 8's cleanup agree on them:

```bash
export AGENT_BROWSER_SESSION=RUN               # the desktop session, named, so Step 8 closes the browser it actually drove
export AGENT_BROWSER_DEFAULT_TIMEOUT=2000      # fail a doomed wait fast instead of at the 25s default
export AGENT_BROWSER_ARGS="--no-sandbox"       # on Linux, where Chrome dies on `No usable sandbox!` without it
```

**A launch setting is exported, the same on every command of its session**: a command that arrives with other
launch settings than the running browser's starts a new browser in its place.

**A session keeps the device it opened as for its whole life**, so the run holds one named session per device: the
desktop session for every desktop scenario and for Steps 3 and 5, a session per third party's screen, opened as
the next section says, and a phone session of its own, opened where *Replaying the scenario on a phone* says.
Each is an isolated browser with its own sign-in.

Without `AGENT_BROWSER_SESSION` every command drives the session named `default`, and a cleanup naming anything else
reports success while releasing nothing. Raise the timeout where the stack is across a network, since a budget tuned
for loopback turns latency into phantom failures.

The CLI ships its own guide, version-matched to the binary and authoritative on the basics — session/refs/snapshot,
the `wait` verbs, viewports, tabs, `record`:

```bash
agent-browser skills get core          # ~475 lines. Look things up here.
agent-browser skills get core --full   # ~2400 lines (~19k tokens). A lookup surface, not a read.
```

## Signing a person in to a third party's screen

**Each third party's screen gets a session of its own, on a profile that outlives the run.** Export the
session's launch settings once, in one file sourced before every command that drives it, so each command
reaches the same running browser:

```bash
export AGENT_BROWSER_SESSION=RUN-NAME
export AGENT_BROWSER_PROFILE="$HOME/.yok/sign-ins/NAME"
export AGENT_BROWSER_ARGS="--no-sandbox"
```

**A session takes one command at a time**: send the next once the last has returned.

1. **Look for a saved sign-in, hidden**: `open` the address Step 1 found, then `wait` on a condition only the
   signed-in screen meets. Where it holds, the session is ready.
2. **Otherwise `close` it.** Where the user said yes to signing in at Step 1's access check, show the browser
   once: add `export AGENT_BROWSER_HEADED=1` to the file and `open` the address again. On a host with no
   display, run `agent-browser dashboard start` too and give the user the address it prints, where the session
   is shown and takes their input.
3. **Wait for the signed-in condition in the foreground, as the one command running**: the `wait` from item 1
   with `--timeout` set to `sign-in-wait` in milliseconds. The window is the user's until it returns.
4. **Then hide the browser for the rest of the round**: `close` the session, take `AGENT_BROWSER_HEADED` out of
   the file, `open` the address again and run item 1's `wait`. Where the hidden browser comes back signed out,
   put the export back, `open` once more and drive that one window to Step 8.
5. **When item 3's wait runs out, `close` the session.** Step 2 grades the scenarios that waited on it.

**Each stretch of a take runs in the session of the screen it shows.** A third party's screen is driven in that
service's session, and a step the user takes on the product's own screens runs in the session signed in there;
the take moves between sessions as *The recording follows the user* says. Close each tab a step opened once its
take is filmed. Act only on what this run posted there, and work out
anything about the browser itself in a scratch session under another name and profile.

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

## Scout, then film — one take per flow

**The video is a recording of one flow — a part, or a scenario with no parts — from its first step to the final
state the user sees, and of nothing else.** So each flow is driven twice: a scout that works the flow out with the recorder off, then one take that replays the
whole flow as a single command with the recorder on. The take is the evidence. Its asserts decide each check's
result, its screenshots are the frames, its recording is the video and its actions are the report's steps, so all
four come from one run.

**Film the whole life of the scenario, not a checklist of its steps.** Every step earns at least one frame, many earn
more — a scenario with more *promoted* frames than steps is doing it right.

### 1. Scout the flow, recorder off

Drive the scenario one step at a time until you hold five things for every step:

- **The target**, as a selector that survives a reload: CSS, or `xpath=…` where only its text tells the element
  apart. A snapshot ref belongs to the page that issued it, so refs are for scouting and selectors are for the take.
- **The condition** that shows the step landed — the `wait` that returns the moment the state holds.
- **The assert**, and the value it returns when the behaviour is right.
- **The way to the target**, as a person would get there: the scroll that brings a target outside the viewport
  into view, the field to click before typing into it, the option to click once a list is open, the centre of an
  element the user only points at.
- **The tab the step ends on.** A step that opens another tab or window, or brings the user back from one, is
  where the recording moves with them.

Screenshots taken while scouting go to staging and serve your own reading. Retries, dead ends and missed clicks
all happen here, where nothing is filmed.

### 2. Return to the scenario's opening state

Scouting moves the page and may have written data. Before the take, open the scenario's first path again, restore
every control the scout changed, and re-seed, the Step 1 way, every fixture the scout used up. The take starts
where a user starting this scenario would start: the state its `given` describes. The recording opens on that
state, settled and in view.

### 3. Film the take

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
2. **Wait on the condition** you scouted for that step, one the viewer sees arrive on screen. An effect that never
   reaches the screen is waited for after `record stop` and shown by a proof.
3. **Assert**, returning the value and the path as *The rules* say.
4. **Screenshot to staging.** A frame shot during the take carries the pointer, which shows the reader what was
   just clicked.
5. **Pause about a second**, so a person watching can read the screen before it changes. The pause paces the
   video; the wait in entry 2 is what makes the step reliable.

**The closing hold.** The take ends on the final state — the outcome the flow's last checks describe, shown where
the user reads it — and the last step's pause runs about a second and a half, so the video rests on it long
enough to read.

**The recording follows the user.** The recorder films one tab of one session, so a take that moves is recorded
in numbered files under the recording's own prefix, `PREFIX.file1.mp4` onwards, which Step 6 joins in order into
`PREFIX.mp4`. PREFIX is `NN_SLUG`, or `NN_SLUG-PART` for a part of a scenario told in parts:

- **To another tab**: the entry right after the step that changes the tab is `record restart` with the next
  file's path and `--cursor`. A step that returns to an earlier tab switches to it with `tab ID` first. In the
  phone session a tab the app opens starts as a desktop tab: `set device` on it and `reload` before the
  `record restart`.
- **To another session**: `record stop` in the session the user leaves, then `record start` the next file in
  the session of the screen they move to, and carry on with the next step's batch there.
- **Through a wait for background work**: `record stop` once the start of the work is on screen, `wait` on the
  condition that shows the result has arrived, then `record start` the next file named
  `PREFIX.fileK.wait-SECONDS.mp4`, SECONDS being how long the wait took. Step 6 puts a card saying the
  recording paused in front of it. Film the result where the user meets it first, then on every screen the
  flow's checks read it from.

`--bail` ends the batch at the first step that fails, so nothing after it is filmed on the wrong screen. `record
stop` is a command of its own, run after the batch whatever the batch returned, because it is what closes the file.

### 4. Judge the take

**A take counts when the batch exited 0, every entry reports success, every assert returned the value the scout
recorded, and every action was filmed in its human form.** Any other take is discarded whole: delete its video and its staged frames, correct the step that
failed, return to the opening state, and film again. A clean-looking video of a take that failed a step shows
something other than the scenario.

- **An assert that held in the scout and fails in the take is a finding about the feature.** Drive it once more to
  learn which state the behaviour depends on, then grade the scenario on what you found.
- **A recorder that fails three takes running** — the feature behaving, the recording not — hands the scenario to
  the stitched path: run the same batch with the recorder off, promote its frames as below, and leave the scenario
  without an `.mp4`. Step 6 builds its video from those frames.

### 5. Confirm the frames and promote them

**Open every staged PNG and confirm it shows what you think** — the round-trip you never skip. Once the take
counted and your eyes confirmed a frame, **promote it**: `mv` it into `verification/screenshots/` under its
`NN_<slug>__SS_<step>.png` name, and keep the assert's deciding value for the check it settles.

**Every promoted frame is a moment of the take**, so each frame the report shows is also in the scenario's video.
What was gathered outside the take has its own home: a file the product produced goes in `artifacts[]`, the
design re-shoot keeps its `.design.png` name, a check on another device is that device's replay recording, and
anything else seen is a proof's `image`.

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

### 6. Write the steps and results from the take

**The take that counted is the source of the scenario's account.** Read its batch from top to bottom, with its
`--json` result beside it:

- **Write the steps as a summary of what the user did**, in the order the batch ran, one step for each moment
  something is checked, naming each control by its label on screen. Pointer placement, scrolling into view,
  waits and pauses are the take's own mechanics and stay in the batch.
- **Place each check under the step that brings it about and give it its `result`** from the assert that
  settles it, and its proofs as the `writing-the-report` reference's *Proofs* says: the promoted frame that shows
  it, or a reading of the assert's values where no frame shows it.
- **Add the take to `recordings[]`** with the device and browser the session reported.

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

**The replays run last, in the phone's own session, for every scenario whose `phone.replay` is `required`.** Once
every desktop scenario is filmed, open a second named session and make it the phone before the app loads:

```bash
export AGENT_BROWSER_SESSION=RUN-phone         # on every phone command; the desktop session keeps its own name
agent-browser set device "iPhone 14"
```

A **device**, not a narrow viewport: an app that branches on user-agent or touch rather than width serves its
desktop layout to a resized window, and you photograph a mobile pass that never happened. The session is that
phone from here to its close, so every replay runs in it and every desktop command keeps naming the desktop
session. The phone session starts signed out and empty: run the setup batch in it from the first `open`, the way
the desktop session began.

**Film each flow again on the phone, as a take of its own.** Run the six steps above under the flow's prefix
with `-phone` after it: the same steps and the same asserts as the desktop take,
scouted again wherever the phone presents a control differently or puts a target off screen. A phone breaks on
the way to the final screen rather than on it, so the take runs from the first click. The recording keeps the
phone's own portrait shape.

The replay grades the scenario's own checks, so the walk answers the same question it answered on desktop:

- **The closing assert returns the value it returned on desktop** — the outcome, not a similar-looking screen.
  This is what the scenario's checks already claim, now claimed at phone width.
- **Nothing scrolls sideways** — `(()=>({over: document.documentElement.scrollWidth -
  document.documentElement.clientWidth}))()` returns `0`. It is a check of its own on the scenario: at `0` the
  phone frame is its proof; above zero it fails, and that measurement is its proof.
- **Controls are reached the way the phone presents them** — driven through the menu the layout collapsed them into,
  the way the user gets to them.

**The replay joins the part whose screens it replays as one more recording, labelled `Phone`, whose `size` is
`phone`**, and its checks sit under that part's steps, as the `writing-the-report` reference says. A replay that
crosses the screens of several parts is filmed as one take per part. A check
that fails on the phone fails the scenario, with a `bugs[]` entry like any other whose `reachedBy` writes
itself: the user on that device, and the surface they touched. **A flow the phone reaches by different steps is
a scenario of its own**, with the phone take as its one recording.

## Terminal frames — a CLI test's recording

**A CLI test's recording is drawn from its transcript**, the file Step 4's run wrote for it under
`E2E_TERMINAL_DIR`, one line per command it ran. Draw it in the desktop session, opened as *Setup* says where
no walk opened it:

1. **Write one terminal page in staging** that shows the transcript as a terminal does: a dark background, a
   monospace font, each command on a prompt line with its output beneath it, its text escaped so it shows as
   written. The page shows the commands up to the one its address names, the newest at the bottom.
2. **Shoot one frame per command**, in the order the test ran them: open the page at that command and
   screenshot it to staging, at one viewport for every frame.
3. **Confirm and promote each frame** as *Confirm the frames and promote them* says, its step naming the
   command it shows.

Step 6 builds the recording's video from its promoted frames.
