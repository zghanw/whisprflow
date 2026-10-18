// The home page "insights": how many words and how long in total, how fast, how much time saved, which days were active, the streaks, and the activity heatmap.
// Computed from this computer's history;
// each function states its basis.
// Pure functions with no Node or DOM: the main process computes them for the window, and the CLI can use the same later.

/**
 * Typing speed (words per minute) for estimating "time saved": how long the same words take to type, minus how long saying them took.
 * An estimate of our own: typical typing runs around forty words a minute
 */
export const TYPING_WPM = 40;

/** Scripts counted one character per word: Han, Japanese kana, Hangul. Other languages count words */
const CHARACTER_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** A word: a run of letters and digits, optionally joined by an apostrophe or a decimal point (don't, 3.6) */
const WORD = /[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu;

/** How many words a text has: Han, kana, and Hangul count one per character, others one per word; punctuation doesn't count */
export function countWords(text) {
  const characters = text.match(CHARACTER_SCRIPTS)?.length ?? 0;
  const words = text.replace(CHARACTER_SCRIPTS, " ").match(WORD)?.length ?? 0;
  return characters + words;
}

const pad = (number) => String(number).padStart(2, "0");

/** Which day this moment is on the local calendar: YYYY-MM-DD */
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** n days later on the local calendar (n may be negative). Adds dates, not 24-hour blocks, so daylight saving days line up */
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

/** How many consecutive days with records end on day (0 if day itself has none) */
function streakEndingOn(day, perDay) {
  let streak = 0;
  for (let cursor = day; perDay[dayKey(cursor)] > 0; cursor = addDays(cursor, -1)) streak++;
  return streak;
}

/**
 * @param {{ createdAt: string, text: string, duration: number }[]} dictations completed dictations (failed ones excluded)
 * @param {{ now: Date }} options today uses the local time zone
 * @returns {{ words: number, seconds: number, wordsPerMinute: number, savedSeconds: number, activeDays: number,
 *   currentStreak: number, longestStreak: number, firstDay: string | null, perDay: Record<string, number> }}
 *   perDay: dictations per day. The current streak counts through today if today has any; otherwise through yesterday, broken only if yesterday has none too
 */
export function insights(dictations, { now }) {
  let words = 0;
  let seconds = 0;
  /** @type {Record<string, number>} */
  const perDay = {};
  for (const { createdAt, text, duration } of dictations) {
    words += countWords(text);
    seconds += duration;
    const day = dayKey(new Date(createdAt));
    perDay[day] = (perDay[day] ?? 0) + 1;
  }

  const days = Object.keys(perDay).sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous !== null && dayKey(addDays(parseDay(previous), 1)) === day ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  const today = streakEndingOn(now, perDay);

  return {
    words,
    seconds,
    wordsPerMinute: seconds === 0 ? 0 : Math.round(words / (seconds / 60)),
    savedSeconds: Math.max(0, Math.round((words / TYPING_WPM) * 60 - seconds)),
    activeDays: days.length,
    currentStreak: today > 0 ? today : streakEndingOn(addDays(now, -1), perDay),
    longestStreak,
    firstDay: days[0] ?? null,
    perDay,
  };
}

/** YYYY-MM-DD to midnight of that local day */
function parseDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/**
 * Dictations in a day to a heatmap shade: 0 none, 1 light, 2 medium, 3 high, 4 intense (five levels,
 * by count: 1 to 4, 5 to 14, 15 to 29, 30 and over)
 */
export function activityLevel(count) {
  if (count >= 30) return 4;
  if (count >= 15) return 3;
  if (count >= 5) return 2;
  if (count >= 1) return 1;
  return 0;
}

/**
 * The activity heatmap: one column per week (Sunday on top), the last column being the week of end, weeks columns in all.
 * Each cell: day, count, level (see activityLevel), and state: past (today and before), before (before first use, drawn hatched),
 * future (after today, left blank). months: the column holding the 1st of each month gets the month (0 is January)
 * @param {{ perDay: Record<string, number>, firstDay: string | null, end: Date, today: Date, weeks: number }} options
 */
export function activityGrid({ perDay, firstDay, end, today, weeks }) {
  const todayKey = dayKey(today);
  const start = addDays(end, -end.getDay() - (weeks - 1) * 7);
  const columns = [];
  const months = [];
  for (let column = 0; column < weeks; column++) {
    const cells = [];
    for (let row = 0; row < 7; row++) {
      const date = addDays(start, column * 7 + row);
      const day = dayKey(date);
      const count = perDay[day] ?? 0;
      const state = day > todayKey ? "future" : firstDay !== null && day < firstDay ? "before" : "past";
      cells.push({ day, count, level: activityLevel(count), state });
      if (date.getDate() === 1) months.push({ column, month: date.getMonth() });
    }
    columns.push(cells);
  }
  return { columns, months };
}
