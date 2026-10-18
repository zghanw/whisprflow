import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { formatCount, formatSeconds, formatSpan, formatTokens, formatUsd } from "../../src/usage/format.mjs";

const en = createTranslator("en");

test("token counts abbreviate thousands, millions, billions as K, M, B with three significant digits", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1394), "1.39K");
  assert.equal(formatTokens(21_300), "21.3K");
  assert.equal(formatTokens(350_400), "350K");
  // Rounding up into the next unit never shows 1000K
  assert.equal(formatTokens(999_600), "1M");
  assert.equal(formatTokens(6_020_000), "6.02M");
  assert.equal(formatTokens(1_250_000_000), "1.25B");
  assert.equal(formatTokens(3_000_000_000_000), "3000B");
});

test("money: fractions of a cent keep two significant digits, a dollar or more goes to the cent; tiny amounts say below a hundredth of a cent", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.0000015), "<$0.0001");
  assert.equal(formatUsd(0.0010575), "$0.0011");
  assert.equal(formatUsd(0.013), "$0.013");
  assert.equal(formatUsd(0.5), "$0.50");
  // Close to a dollar never shows $1.0
  assert.equal(formatUsd(0.998), "$1.00");
  assert.equal(formatUsd(12.346), "$12.35");
});

test("wait time is seconds with one decimal, in the UI language", () => {
  assert.equal(formatSeconds(1700, en), "1.7s");
  assert.equal(formatSeconds(640, en), "0.6s");
  assert.equal(formatSeconds(12_000, en), "12.0s");
});

test("counts abbreviate like tokens: the home page word count reads 194K", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(856), "856");
  assert.equal(formatCount(194_321), "194K");
  assert.equal(formatCount(1_250_000), "1.25M");
});

test("a duration is minutes under an hour, hours above, one decimal under ten hours; units are message names (units.min / units.hr)", () => {
  assert.deepEqual(formatSpan(0), { value: "0", unit: "min" });
  assert.deepEqual(formatSpan(20), { value: "<1", unit: "min" });
  assert.deepEqual(formatSpan(90), { value: "2", unit: "min" });
  assert.deepEqual(formatSpan(59 * 60), { value: "59", unit: "min" });
  // 59 min 50 s rounds to 60 minutes: shown as 1 hour
  assert.deepEqual(formatSpan(59 * 60 + 50), { value: "1", unit: "hr" });
  assert.deepEqual(formatSpan(5400), { value: "1.5", unit: "hr" });
  assert.deepEqual(formatSpan(7200), { value: "2", unit: "hr" });
  assert.deepEqual(formatSpan(90 * 3600 + 1000), { value: "90", unit: "hr" });
  assert.deepEqual([en("units.min"), en("units.hr")], ["min", "hr"]);
});
