// Layout shared by the CLI screens: color, alignment by terminal cell width, and how numbers and durations are written (in the interface language).

export const INDENT = "  ";

/** @param {boolean} color whether the output is a terminal that supports color */
export function paint(color) {
  const wrap = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { bold: wrap(1), dim: wrap(2), green: wrap(32), red: wrap(31), yellow: wrap(33) };
}

/** A CJK character or full-width punctuation mark takes two cells in a terminal */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += char.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return width;
}

export const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));

/**
 * Rows with names in a left column and values in a right column, names aligned to the widest (name lengths vary by language)
 * @param {Array<[label: string, value: string]>} entries
 */
export function rows(entries) {
  const width = Math.max(10, ...entries.map(([label]) => displayWidth(label) + 2));
  return entries.map(([label, value]) => `${INDENT}${padEnd(label, width)}${value}`);
}

/** @param {Function} t translates into the interface language */
export function duration(seconds, t) {
  const total = Math.round(seconds);
  if (total < 60) return t("units.seconds", { value: total });
  const minutes = Math.floor(total / 60);
  if (total < 3600) {
    return total % 60 === 0
      ? t("units.minutes", { minutes })
      : t("units.minutesSeconds", { minutes, seconds: total % 60 });
  }
  return t("units.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
