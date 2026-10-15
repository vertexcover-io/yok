// Each scenario: the task the simulated user brings, what they know that the agent doesn't, how
// they react, whether the agent made the tempting mistake (checked by code), and what /learn
// should produce depending on that.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INVOICE_TASK =
  "Subscriptions activated by a reseller (RESELLER) or by manual payment (PAYMENT_MANUAL) must have an invoice id. " +
  "Make the admin API reject those activations without one, and make the admin panel show and require an invoice id field for them.";

const HARDCODED_LIST =
  /\[[^\]]*["']RESELLER["'][^\]]*["']PAYMENT_MANUAL["'][^\]]*\]|\[[^\]]*["']PAYMENT_MANUAL["'][^\]]*["']RESELLER["'][^\]]*\]|===?\s*["']RESELLER["'][\s\S]{0,80}===?\s*["']PAYMENT_MANUAL["']/s;

// The reviewed-session mistake this repo is built around: at any point in the session, the agent wrote the list of activation
// types that need an invoice into an app file instead of using a shared-config flag. Read from the
// agent's Edit/Write calls, because a correction later removes it from the final code.
// A path written from inside apps/ (cd apps && …) starts at the app's folder, so both forms count.
export const APP_FILE = /(^|\/)(apps\/)?(admin-api|admin-panel)\//;
const listInApps = (writes) =>
  [...new Set(writes.filter((write) => APP_FILE.test(write.file) && HARDCODED_LIST.test(write.text)).map((write) => write.file.replace(/^.*?(?:apps\/)?(admin-api|admin-panel)\//, "apps/$1/")))];

const ranNpm = (commands) => commands.some((command) => /(^|[;&|\s])npm\s+(i|install|add|ci)\b/.test(command));

// One label per kind of mistake made: the shared-config list, and npm.
const listOrNpm = (writes, commands) => [
  ...(listInApps(writes).length > 0 ? ["list in apps"] : []),
  ...(ranNpm(commands) ? ["npm install"] : []),
];

const PNPM_KNOWLEDGE =
  " Separately: the repo moved from npm to pnpm last week (pnpm-lock.yaml is in the root); the README still says npm and is out of date. Installing with npm breaks CI.";

const PNPM_FILES = {
  "README.md": "# shop\n\nAdmin tools for business subscriptions.\n\n## Setup\n\nInstall dependencies with `npm install`.\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
};

const SHARED_CONFIG_KNOWLEDGE =
  "In this repo, anything both apps need to agree on lives in @shop/shared-config (installed in node_modules; its source repo is shared-config). Activation types already have " +
  "per-type flags there (ACTIVATION_TYPES with requiresApproval) and a helper, activationTypesWhere(flag), that both apps " +
  "should read. The right fix is a requiresInvoice flag on ACTIVATION_TYPES, read with activationTypesWhere('requiresInvoice') " +
  "in the API and the panel. Writing the list of types out inside an app is how the two apps drift apart; that already bit the team once.";

const SHARED_CONFIG_LESSON =
  "Lists or settings that several apps must agree on (here: which activation types need an invoice id) go in " +
  "@shop/shared-config (installed in node_modules; its source repo is shared-config) as a flag read through its helper, not written out in each app.";

const EXISTING_LEARNING = `---
signal: Use when two apps need the same list of activation types or other shared setting
paths: ["apps/**"]
tags: [shared-config, activation-types]
strength: default
---
# Put lists both apps need in shared-config, not in each app

When the admin API and the admin panel need the same list (for example which activation types need approval), add a
flag to \`ACTIVATION_TYPES\` in \`@shop/shared-config\` and read it with \`activationTypesWhere\`. A list written out in
each app drifts apart.

**Occurrences:**
- 2026-10-01 · approval types were hard-coded in the panel; moved to a requiresApproval flag
**Stale when:** \`@shop/shared-config\`'s \`ACTIVATION_TYPES\` or \`activationTypesWhere\` is removed
`;

const NEVER_LEARN = "Never type /learn or ask the agent to save a learning yourself.";

export const SCENARIOS = {
  "auto-shared-list": {
    source: "cross-app list written into each app, learn stage at the end",
    auto: true,
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app (an array, a set, or RESELLER/PAYMENT_MANUAL comparisons), correct it once: tell it shared-config already has a place for this. Don't spell out the whole solution unless it asks.",
      "Answer any question the agent asks, briefly and in character.",
      NEVER_LEARN,
      "If the agent offers to save a learning or asks how one should read, go along: pick the option closest to keeping cross-app lists in shared-config.",
      "When the task is done, say thanks in one short line. After that, if the agent has nothing more to ask you, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: ["accepted", "edited"], lesson: SHARED_CONFIG_LESSON }
        : { none: true, why: "the agent used shared-config on its own, so there was nothing to correct" },
  },

  "auto-one-off": {
    source: "one-off steering, learn stage at the end",
    auto: true,
    task: INVOICE_TASK,
    knowledge:
      "You only care about wording in the UI. You want the new field labelled exactly 'Invoice number' for this screen, because that's what the reseller contract calls it. You do not care where the list of types lives.",
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "Whatever label the agent picks for the field, if it is not 'Invoice number', ask once to rename it to 'Invoice number' for this screen. Do not correct anything else.",
      "Answer any question the agent asks, briefly and in character.",
      NEVER_LEARN,
      "If the agent offers to save a learning anyway, reject it: it was a one-off for this screen.",
      "When the task is done, say thanks in one short line. After that, if the agent has nothing more to ask you, reply DONE.",
    ],
    mistake: () => [],
    expect: () => ({ none: true, why: "a one-off label for one screen is not a learning" }),
  },

  "manual-with-text": {
    source: "user types /learn with the learning",
    ruleInLearn: true,
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "Do not correct the agent about where the list lives, whatever it does.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type /learn followed by the rule in your own words, on one line, for example: /learn when the API and the panel need the same list of activation types, add a flag in shared-config and read it with activationTypesWhere, don't write the list in each app",
      "If it asks you to pick how the learning should read, pick the option closest to what you typed.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: listInApps,
    expect: () => ({
      outcome: "new",
      status: ["accepted", "edited"],
      lesson: SHARED_CONFIG_LESSON,
      options: { label: "only the user's rule (1 option)", test: (count) => count === 1 },
    }),
  },

  "several-real-fixes": {
    source: "list endpoint that returns every row (several real fixes exist)",
    task: "Add a GET /invoices endpoint to the admin API (apps/admin-api/src/routes.ts) that lists a business's invoices, filtered by ?businessId=. Keep it small.",
    knowledge:
      "The invoices table has a few million rows, and some businesses have hundreds of thousands of invoices, so a list endpoint that returns every matching row times out and can take the database down. You have not decided how list endpoints should limit results; cursor pagination, page/limit, or a hard cap with a 'narrow your filter' error would all be acceptable. You only know returning everything is not.",
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the endpoint returns every matching invoice (no limit, page, cursor or cap), say once that some businesses have hundreds of thousands of invoices so returning all of them will time out. Don't tell it which fix to use; if it asks, say you're open and to go with its recommendation.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "When it asks how the learning should read, pick the option about cursor pagination if there is one, otherwise the first option.",
      "After it reports what it wrote, reply DONE.",
    ],
    // The first version of the route returns every row: no limit, page, cursor or cap anywhere in it.
    mistake: (writes) => {
      const first = writes.find((write) => /routes\.ts$/.test(write.file) && /invoices/.test(write.text));
      return first && !/\b(limit|cursor|page|offset|take|max|cap)\b/i.test(first.text) ? [first.file.replace(/^.*?apps\//, "apps/")] : [];
    },
    expect: (mistakeMade) =>
      mistakeMade
        ? {
            outcome: "new",
            status: ["accepted", "edited"],
            lesson: "List endpoints must never return every matching row; they bound the result (cursor pagination, page/limit, or a hard cap).",
            options: { label: "two or three different fixes", test: (count) => count >= 2 },
          }
        : { none: true, why: "the agent bounded the list on its own" },
  },

  "reject-with-reason": {
    source: "user rejects the proposal",
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct it once: tell it shared-config already has a place for this.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "When it asks how the learning should read, reject it. If it asks why, say in one line: it's already in our CONTRIBUTING guide, we don't want it in two places.",
      "After it confirms, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade ? { outcome: "rejected", status: "rejected" } : { none: true, why: "nothing to correct" },
  },

  "own-option": {
    source: "user writes their own option (Other)",
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct it once: tell it shared-config already has a place for this.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "When it asks how the learning should read, don't pick any of its options: choose Other / write your own, with this text: Before adding any per-activation-type rule in an app, add a flag to ACTIVATION_TYPES in @shop/shared-config and read it with activationTypesWhere.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: "edited", picked: "other", lesson: "Before adding a per-activation-type rule in an app, add a flag to ACTIVATION_TYPES in @shop/shared-config and read it with activationTypesWhere." }
        : { none: true, why: "nothing to correct" },
  },

  "contradiction-replaces": {
    source: "new learning contradicts an old one (npm → pnpm)",
    task: "Add the dayjs library to apps/admin-api and use it in src/subscriptions/activate.ts so activatedAt is stored as a UTC ISO string. Install it properly.",
    knowledge:
      "The repo moved from npm to pnpm last week; pnpm-lock.yaml is in the root and package-lock.json was deleted. The README and an old learning still say npm; they are out of date. Installing with npm creates a package-lock.json and breaks CI.",
    files: {
      "README.md": "# shop\n\nAdmin tools for business subscriptions.\n\n## Setup\n\nInstall dependencies with `npm install`.\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "docs/learnings/use-npm-for-installs.md": `---
signal: Use when installing or adding a dependency
paths: ["package.json"]
tags: [dependencies, npm]
strength: default
---
# Install dependencies with npm

Use \`npm install\` to add or install dependencies; the repo's lockfile is package-lock.json.

**Occurrences:**
- 2026-09-02 · yarn was used and created a second lockfile
**Stale when:** the repo stops using package-lock.json
`,
      "docs/learnings/index.md": "# Learnings\n\n- [Install dependencies with npm](use-npm-for-installs.md) — Use when installing or adding a dependency\n",
    },
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent runs npm (npm install, npm i, npm add), correct it once: we moved to pnpm last week, pnpm-lock.yaml is in the root, never npm. Ask it to undo the npm changes and redo with pnpm.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "When it asks how the learning should read, pick the option about always using pnpm, and agree that the old npm learning should be removed.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: (writes, commands) => (ranNpm(commands) ? ["npm install"] : []),
    // Without the npm mistake there is no contradiction to test; whatever else the user corrected
    // is out of this scenario's scope, so the run is reported as not exercised.
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: ["accepted", "edited"], replaces: "docs/learnings/use-npm-for-installs.md", lesson: "Use pnpm (pnpm-lock.yaml) for installing and adding dependencies, never npm." }
        : { notExercised: "the agent used pnpm on its own, so there was no contradiction to test" },
  },

  "lint-path": {
    source: "mechanical rule a lint check can catch (lodash → lodash-es)",
    task: "Add a SearchBox component in apps/admin-panel/src/SearchBox.tsx with an input whose onChange is debounced by 300ms. Use lodash's debounce, it's already a dependency.",
    knowledge:
      "The team only imports from lodash-es, never from plain lodash: plain lodash breaks tree-shaking and doubles the bundle. Both are in package.json for historical reasons. A lint check in scripts/lint.mjs that fails on imports from 'lodash' would catch it every time, and you would like that.",
    behaviour: [
      "Your first message asks the agent to do the task, in your own words, mentioning lodash's debounce.",
      "If the agent imports from 'lodash' (not 'lodash-es'), correct it once: we only import from lodash-es, plain lodash breaks tree-shaking.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "If it offers a lint check, say yes. If it offers a written learning instead, pick it.",
      "After it reports what it did, reply DONE.",
    ],
    mistake: (writes) =>
      [...new Set(writes.filter((write) => /from\s+["']lodash["']|require\(["']lodash["']\)|from\s+["']lodash\/[\w.]+["']/.test(write.text)).map((write) => write.file.replace(/^.*?apps\//, "apps/")))],
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "lint", status: "accepted", learningFile: "scripts/lint.mjs" }
        : { none: true, why: "the agent used lodash-es on its own" },
  },

  "two-corrections": {
    source: "two different corrections in one session",
    task: INVOICE_TASK + " Also store activatedAt as a UTC ISO string using the dayjs library (install it).",
    knowledge:
      SHARED_CONFIG_KNOWLEDGE + PNPM_KNOWLEDGE,
    files: PNPM_FILES,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct that once: shared-config already has a place for this.",
      "If the agent runs npm (npm install, npm i, npm add), correct that once, in a separate message from the other correction: we moved to pnpm, never npm; undo the npm changes and use pnpm.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "For each learning it asks about, pick the first option.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: listOrNpm,
    expect: (anyMade) =>
      anyMade
        ? { outcome: "new", status: ["accepted", "edited"], count: (mistakes) => mistakes.length }
        : { none: true, why: "the agent made neither mistake" },
  },

  "run-two-passes": {
    source: "inside a yok run: the learn stage, then /learn after a follow-up (the after-PR pass)",
    yokRun: true,
    passes: 2,
    task:
      INVOICE_TASK +
      " Once that is done and the learn stage has run, you also want activatedAt stored as a UTC ISO string using the dayjs library (install it).",
    knowledge:
      SHARED_CONFIG_KNOWLEDGE + PNPM_KNOWLEDGE,
    files: PNPM_FILES,
    behaviour: [
      "Your first message asks the agent to do the invoice task only, in your own words. Don't mention dayjs yet.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct it once: shared-config already has a place for this.",
      "Answer any question the agent asks, briefly and in character.",
      "When the invoice task is done, say thanks in one short line. After that, if the agent has nothing more to ask you, reply DONE. Never type /learn before step 7.",
      "When the learn stage (started by PIPELINE) asks how a learning should read, pick the option closest to keeping cross-app lists in shared-config. After it reports, ask for the dayjs change in your own words.",
      "If the agent runs npm (npm install, npm i, npm add), correct that once: we moved to pnpm, never npm; undo the npm changes and use pnpm.",
      "When the dayjs change is done, type exactly: /learn",
      "For each learning it asks about, pick the first option. If it asks about shared-config again, say that one was already handled.",
      "After it reports what it wrote, reply DONE.",
    ],
    // The stage's pass may catch the shared-config list; the /learn pass, npm.
    mistake: listOrNpm,
    expect: (anyMade) =>
      anyMade
        ? { outcome: "new", status: ["accepted", "edited"], count: (mistakes) => mistakes.length }
        : { none: true, why: "the agent made neither mistake" },
  },

  "viewer-comment": {
    source: "inside a yok run: the correction is a plan-viewer comment, then the learn stage",
    yokRun: true,
    task:
      INVOICE_TASK +
      " First write a short implementation plan to .yok/sim/artifacts/plan.md and wait for the user's review before writing any code.",
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent for the task, in your own words, and asks it to write the plan to .yok/sim/artifacts/plan.md first and wait for your review before coding.",
      'You review the plan in a viewer, not in chat. If the plan writes the list of activation types that need an invoice inside the apps, leave one review comment on it. Write it exactly as: COMMENT: "<a short phrase copied exactly from the plan, under 60 characters>" => <your comment>. In the comment, say shared-config already has a place for this.',
      "Once the plan reads the types from shared-config (or never listed them in the apps), reply: approved, go ahead and implement.",
      "Answer any question the agent asks, briefly and in character.",
      "When the code is done, say thanks in one short line. After that, if the agent has nothing more to ask you, reply DONE.",
      NEVER_LEARN,
      "When the learn stage (started by PIPELINE) asks how a learning should read, pick the option closest to keeping cross-app lists in shared-config. After it reports, reply DONE.",
    ],
    // The mistake is in the plan, so it is whatever the user had to comment on in the viewer.
    mistake: (writes, commands, conversation) =>
      conversation.some((turn) => turn.role === "user" && turn.text.startsWith("[review]")) ? ["plan comment"] : [],
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: ["accepted", "edited"], lesson: SHARED_CONFIG_LESSON, fromViewer: true }
        : { none: true, why: "the plan used shared-config on its own, so there was nothing to comment on" },
  },

  "after-push-offer": {
    source: "after the run: a push of review changes makes yok offer a learning session, and the user says yes",
    yokRun: true,
    afterRun: true,
    task:
      INVOICE_TASK +
      " The yok run for it has already finished in this session; you are now reviewing the code it wrote. Have every change committed and pushed (git push).",
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, then commit and push it, in your own words.",
      "Once it has pushed, review it. If the agent wrote the list of activation types that need an invoice inside an app, correct it once: shared-config already has a place for this; fix it, commit and push. Otherwise ask it to label the new field 'Invoice number', commit and push.",
      "If the agent says it can't add the flag from this repo, say you'll add and publish it yourself, and ask it to leave a TODO pointing at shared-config next to each hardcoded list, then commit and push that now.",
      "Answer any question the agent asks, briefly and in character.",
      NEVER_LEARN,
      "If the agent asks whether to start a learning session, say yes.",
      "If it asks how a learning should read, pick the option closest to keeping cross-app lists in shared-config. If it says there is nothing worth keeping, accept that.",
      "After it reports a learning file it wrote, ask it to commit and push that file, nothing else. After that push, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: ["accepted", "edited"], lesson: SHARED_CONFIG_LESSON }
        : { none: true, why: "the agent used shared-config on its own; the label rename is a one-off" },
  },

  "compact-mid-session": {
    source: "/compact between the correction and /learn",
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct it once: tell it shared-config already has a place for this.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /compact",
      "After the compact, type exactly: /learn",
      "When it asks how the learning should read, pick the first option.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade ? { outcome: "new", status: ["accepted", "edited"], lesson: SHARED_CONFIG_LESSON } : { none: true, why: "nothing to correct" },
  },

  "shared-list-edited": {
    source: "cross-app list written into each app",
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app (an array, a set, or RESELLER/PAYMENT_MANUAL comparisons), correct it once: tell it shared-config already has a place for this. Don't spell out the whole solution unless it asks.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done (and any correction is handled), type exactly: /learn",
      "If /learn says it found nothing, reply DONE. Never bring up shared-config yourself unless you corrected the agent about it earlier.",
      "When it asks you to pick how the learning should read, pick the option closest to keeping cross-app lists in shared-config, and ask for one edit: it should also say the admin panel must read the flag through the helper rather than its own list. Accept the revised text.",
      "After it reports what it wrote, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "new", status: "edited", lesson: SHARED_CONFIG_LESSON }
        : { none: true, why: "the agent used shared-config on its own, so there was nothing to correct" },
  },

  "one-off-no-learning": {
    source: "one-off steering (not a repo convention)",
    task: INVOICE_TASK,
    knowledge:
      "You only care about wording in the UI. You want the new field labelled exactly 'Invoice number' for this screen, because that's what the reseller contract calls it. You do not care where the list of types lives.",
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "Whatever label the agent picks for the field, if it is not 'Invoice number', ask once to rename it to 'Invoice number' for this screen. Do not correct anything else.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "If it says there is nothing worth keeping, reply DONE. If it offers options anyway, reject them and say it was a one-off for this screen, then reply DONE after it confirms.",
    ],
    mistake: () => [],
    expect: () => ({ none: true, why: "a one-off label for one screen is not a learning" }),
  },

  "shared-list-occurrence": {
    source: "cross-app list written into each app, second time",
    task: INVOICE_TASK,
    knowledge: SHARED_CONFIG_KNOWLEDGE,
    files: {
      "docs/learnings/put-cross-app-lists-in-shared-config.md": EXISTING_LEARNING,
      "docs/learnings/index.md": `# Learnings

- [Put lists both apps need in shared-config, not in each app](put-cross-app-lists-in-shared-config.md) — Use when two apps need the same list of activation types or other shared setting
`,
    },
    behaviour: [
      "Your first message asks the agent to do the task, in your own words.",
      "If the agent writes the list of activation types that need an invoice inside an app, correct it once, a little annoyed: this already happened before and there is a learning about it.",
      "Answer any question the agent asks, briefly and in character.",
      "When the task is done, type exactly: /learn",
      "If /learn says it found nothing, reply DONE. Never bring up shared-config yourself unless you corrected the agent about it earlier.",
      "Go along with whatever it proposes. If it asks you to pick, pick the first option.",
      "After it reports what it did, reply DONE.",
    ],
    mistake: listInApps,
    expect: (mistakeMade) =>
      mistakeMade
        ? { outcome: "occurrence", status: "existing", learningFile: "docs/learnings/put-cross-app-lists-in-shared-config.md" }
        : { none: true, why: "the agent followed the existing learning, so there was nothing to correct" },
  },
};
