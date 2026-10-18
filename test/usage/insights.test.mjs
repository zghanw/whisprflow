import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGrid, activityLevel, countWords, dayKey, insights, TYPING_WPM } from "../../src/usage/insights.mjs";

// Dates are built in local time: a day starts in the local time zone, so the tests give the same result in any zone
const at = (month, date, hour = 10) => new Date(2026, month - 1, date, hour).toISOString();
const said = (month, date, text = "hello world", duration = 3) => ({ createdAt: at(month, date), text, duration });

test("word count: Han, kana, and Hangul count one per character, other languages one per word; punctuation does not count", () => {
  assert.equal(countWords("\u4f60\u597d\uff0c\u4e16\u754c\u3002"), 4);
  assert.equal(countWords("Hello, world!"), 2);
  // A version number like 3.6 is one word
  assert.equal(countWords("\u7528 Gemini 3.6 Flash \u6574\u7406"), 1 + 1 + 1 + 1 + 2);
  assert.equal(countWords("don't stop"), 2);
  assert.equal(countWords("こんにちは"), 5);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("……"), 0);
});

test("which day follows the local calendar", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 9, 14, 0, 0)), "2026-10-14");
});

test("total words, total time, average speed, and time saved at typing speed", () => {
  const result = insights(
    [
      said(10, 13, "one two three four five six seven eight nine ten", 6),
      said(10, 14, "one two three four five six", 6),
    ],
    {
      now: new Date(2026, 9, 14, 12),
    },
  );
  assert.equal(result.words, 16);
  assert.equal(result.seconds, 12);
  // 16 words in 12 seconds: 80 a minute
  assert.equal(result.wordsPerMinute, 80);
  // Typing these 16 words takes 16 / 40 minutes = 24 seconds; saying them took 12
  assert.equal(TYPING_WPM, 40);
  assert.equal(result.savedSeconds, 12);
});

test("speaking slower than typing never counts as negative time saved", () => {
  const result = insights([said(10, 14, "OK", 30)], { now: new Date(2026, 9, 14, 12) });
  assert.equal(result.savedSeconds, 0);
});

test("nothing said yet: all zeros and no first day", () => {
  const result = insights([], { now: new Date(2026, 9, 14, 12) });
  assert.deepEqual(
    { ...result, perDay: Object.keys(result.perDay).length },
    {
      words: 0,
      seconds: 0,
      wordsPerMinute: 0,
      savedSeconds: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      firstDay: null,
      perDay: 0,
    },
  );
});

test("active days, longest streak, current streak: counts through today when today has dictations", () => {
  const result = insights(
    [said(10, 1), said(10, 2), said(10, 3), said(10, 3), said(10, 10), said(10, 13), said(10, 14)],
    { now: new Date(2026, 9, 14, 12) },
  );
  assert.equal(result.activeDays, 6);
  assert.equal(result.longestStreak, 3);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.firstDay, "2026-10-01");
  assert.equal(result.perDay["2026-10-03"], 2);
});

test("nothing yet today: the current streak counts through yesterday unbroken; it breaks only if yesterday has none either", () => {
  const now = new Date(2026, 9, 14, 8);
  assert.equal(insights([said(10, 12), said(10, 13)], { now }).currentStreak, 2);
  assert.equal(insights([said(10, 11), said(10, 12)], { now }).currentStreak, 0);
});

test("streaks continue across months", () => {
  const result = insights([said(9, 30), said(10, 1)], { now: new Date(2026, 9, 1, 12) });
  assert.equal(result.longestStreak, 2);
  assert.equal(result.currentStreak, 2);
});

test("activity has five levels: none, light, medium, high, intense", () => {
  assert.equal(activityLevel(0), 0);
  assert.equal(activityLevel(1), 1);
  assert.equal(activityLevel(4), 1);
  assert.equal(activityLevel(5), 2);
  assert.equal(activityLevel(15), 3);
  assert.equal(activityLevel(30), 4);
  assert.equal(activityLevel(500), 4);
});

test("heatmap: a week per column with Sunday on top, the last column is this week; days before the first day and after today are marked", () => {
  // 2026-10-14 is a Wednesday
  const today = new Date(2026, 9, 14, 12);
  const perDay = { "2026-10-05": 3, "2026-10-14": 20 };
  const grid = activityGrid({ perDay, firstDay: "2026-10-05", end: today, today, weeks: 3 });

  assert.equal(grid.columns.length, 3);
  for (const column of grid.columns) assert.equal(column.length, 7);
  // The first column starts on 2026-09-27 (a Sunday)
  assert.equal(grid.columns[0][0].day, "2026-09-27");
  assert.equal(grid.columns[2][6].day, "2026-10-17");

  const cell = (day) => grid.columns.flat().find((c) => c.day === day);
  assert.equal(cell("2026-10-04").state, "before");
  assert.deepEqual(cell("2026-10-05"), { day: "2026-10-05", count: 3, level: 1, state: "past" });
  assert.deepEqual(cell("2026-10-06"), { day: "2026-10-06", count: 0, level: 0, state: "past" });
  assert.deepEqual(cell("2026-10-14"), { day: "2026-10-14", count: 20, level: 3, state: "past" });
  assert.equal(cell("2026-10-15").state, "future");
});

test("heatmap months are labeled under the column holding the 1st", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: null, end: today, today, weeks: 3 });
  // Three columns start the weeks of 9-27, 10-4, and 10-11: October 1 is in the first column (month counts from 0, 9 is October)
  assert.deepEqual(grid.months, [{ column: 0, month: 9 }]);
});

test("paging back: an earlier end makes the last column that week", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: "2026-01-01", end: new Date(2026, 8, 1), today, weeks: 1 });
  assert.equal(grid.columns[0][0].day, "2026-08-30");
  assert.ok(grid.columns[0].every((cell) => cell.state === "past"));
});

test("never dictated: cells before the first day are the blank kind, not hatched", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: null, end: today, today, weeks: 1 });
  assert.equal(grid.columns[0][0].state, "past");
});
