import { expect, test } from "bun:test";
import { promptFrom, tokenize } from "./commands.ts";

test.each([
  ["task fix the bug", ["task", "fix", "the", "bug"]],
  ['task "fix the bug" --name a', ["task", "fix the bug", "--name", "a"]],
  ["task 'fix it'", ["task", "fix it"]],
  ["   ", []],
  ["task it's broken", ["task", "it's", "broken"]],
  ["task don't break user's file", ["task", "don't", "break", "user's", "file"]],
  ['task say "hi" --name a"b', ["task", "say", "hi", "--name", 'a"b']],
  ['task fix "the bug". --project p', ["task", "fix", "the bug.", "--project", "p"]],
  ['task --prompt="fix the bug" --project p', ["task", "--prompt=fix the bug", "--project", "p"]],
  ['task fix it --input title="fix login"', ["task", "fix", "it", "--input", "title=fix login"]],
  ["task fix it --input title='fix login'", ["task", "fix", "it", "--input", "title=fix login"]],
])("SC616: tokenize(%j) gives %j", (text, words) => {
  expect(tokenize(text)).toEqual({ ok: true, value: words });
});

test.each([['task "open'], ['task --prompt="open'], ['task --input title="open']])(
  "SC616: tokenize refuses the unclosed quote in %j",
  (text) => {
    expect(tokenize(text).ok).toBe(false);
  },
);

test.each([
  [undefined, ["fix", "it"], "fix it"],
  ["fix", [], "fix"],
])("SC617: promptFrom(%j, %j) gives the prompt %j", (prompt, words, expected) => {
  expect(promptFrom(prompt, words)).toEqual({ ok: true, value: expected });
});

test.each([
  ["fix", ["it"]],
  [undefined, []],
])(
  "SC617: promptFrom(%j, %j) is an error: the prompt given twice or not at all",
  (prompt, words) => {
    expect(promptFrom(prompt, words).ok).toBe(false);
  },
);
