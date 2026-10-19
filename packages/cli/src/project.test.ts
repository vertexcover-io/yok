import { expect, test } from "bun:test";
import { basename } from "node:path";
import { folderSlug } from "./project.ts";

test.each([
  ["Refrens_Main", "refrens-main"],
  ["refrens-main.git", "refrens-main"],
  [basename("git@github.com:org/refrens-main.git"), "refrens-main"],
  ["___", ""],
])("SC201: the folder %s becomes the project name %p", (folder, name) => {
  expect(folderSlug(folder)).toBe(name);
});
