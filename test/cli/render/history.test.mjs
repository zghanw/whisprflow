import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHistory } from "../../../src/cli/render/history.mjs";
import { english, plain } from "./fixtures.mjs";

const row = (overrides) => ({
  id: "a",
  status: "completed",
  refinedText: "A sentence",
  error: null,
  duration: 3,
  audioLocalPath: "/data/Recordings/a.webm",
  createdAt: "2026-10-13T06:32:00.000Z",
  ...overrides,
});

test("history groups by day, newest first, today and yesterday named, each entry a time and the text", () => {
  const rows = [
    row({ id: "c", createdAt: "2026-10-13T06:32:00.000Z", refinedText: "said this afternoon" }),
    row({ id: "b", createdAt: "2026-10-12T01:05:00.000Z", refinedText: "said yesterday morning" }),
    row({ id: "a", createdAt: "2026-10-08T12:00:00.000Z", refinedText: "said last week" }),
  ];
  const text = renderHistory({ rows, total: 3 }, plain);
  assert.deepEqual(
    text.split("\n").filter((line) => line.trim() !== ""),
    [
      "Today · October 13",
      "  14:32  said this afternoon",
      "Yesterday · October 12",
      "  09:05  said yesterday morning",
      "Thu, October 8",
      "  20:00  said last week",
    ],
  );
  // Dates and weekdays follow the English style
  assert.deepEqual(
    renderHistory({ rows, total: 3 }, english)
      .split("\n")
      .filter((line) => /^\S/.test(line)),
    ["Today · October 13", "Yesterday · October 12", "Thu, October 8"],
  );
});

test("dates outside this year include the year", () => {
  const rows = [row({ createdAt: "2025-10-08T12:00:00.000Z" })];
  assert.match(renderHistory({ rows, total: 1 }, plain), /^Wed, October 8, 2025$/m);
  assert.match(renderHistory({ rows, total: 1 }, english), /^Wed, October 8, 2025$/m);
});

test("grouping follows the local date: still the previous day in UTC but past midnight locally counts as the local day", () => {
  const rows = [row({ createdAt: "2026-10-12T16:30:00.000Z" })];
  assert.match(renderHistory({ rows, total: 1 }, plain), /Today · October 13\n {2}00:30/);
});

test("multi-paragraph text indents its later lines to align and keeps blank lines between paragraphs", () => {
  const rows = [row({ refinedText: "First paragraph\n\nSecond paragraph\n1. one\n2. two" })];
  const lines = renderHistory({ rows, total: 1 }, plain).split("\n");
  assert.deepEqual(lines.slice(1, 6), [
    "  14:32  First paragraph",
    "",
    "         Second paragraph",
    "         1. one",
    "         2. two",
  ]);
});

test("a failed entry gives the reason and points out the recording was kept", () => {
  const rows = [row({ status: "failed", refinedText: "", error: "Can't reach Gemini", duration: 7.2 })];
  const text = renderHistory({ rows, total: 1 }, plain);
  assert.match(text, /14:32 {2}✗ Failed: Can't reach Gemini/);
  assert.match(text, /Recording 7\.2s, kept at \/data\/Recordings\/a\.webm/);
});

test("when not everything is shown it ends with the total and how to see more", () => {
  const text = renderHistory({ rows: [row()], total: 57 }, plain);
  assert.match(text, /Showing the latest 1 of 57/);
  assert.match(text, /whisprflow history -n 57/);
  assert.doesNotMatch(renderHistory({ rows: [row()], total: 1 }, plain), /of 1\b/);
});

test("with nothing at all it says how to start", () => {
  assert.match(renderHistory({ rows: [], total: 0 }, plain), /No dictations yet/);
});
