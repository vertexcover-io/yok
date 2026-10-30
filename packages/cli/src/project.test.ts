import { expect, test } from "bun:test";
import { basename } from "node:path";
import { folderSlug, renderProjects } from "@yok/server";

test.each([
  ["Refrens_Main", "refrens-main"],
  ["refrens-main.git", "refrens-main"],
  [basename("git@github.com:org/refrens-main.git"), "refrens-main"],
  ["___", ""],
])("SC201: the folder %s becomes the project name %p", (folder, name) => {
  expect(folderSlug(folder)).toBe(name);
});

test("SC42 (regression): two projects print under NAME  STATUS  PATH  ADDED BY, padded to the widest cell, with the adder's name else its channel", () => {
  const project = { addedAt: "2026-01-01T00:00:00.000Z" };
  const text = renderProjects([
    { ...project, name: "web", status: "ready", path: "/srv/web", addedBy: { channel: "cli" } },
    {
      ...project,
      name: "api-server",
      status: "missing",
      path: "/srv/api",
      addedBy: { channel: "slack", name: "ritesh" },
    },
  ]);
  expect(text).toBe(
    [
      "NAME        STATUS   PATH      ADDED BY",
      "web         ready    /srv/web  cli",
      "api-server  missing  /srv/api  ritesh",
    ].join("\n"),
  );
});
