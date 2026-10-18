import { msg } from "../../i18n/index.mjs";
import { SETTINGS } from "../../storage/settings.mjs";
import { toRgb } from "../../themes/color.mjs";
import { findTheme } from "../../themes/index.mjs";
import { displayWidth, INDENT, padEnd, paint, rows } from "./text.mjs";

// Settings and themes (whisprflow config, whisprflow theme).

/** "Cinnabar (cinnabar)". A theme it can't name (one only in a newer version than this command) is written as is */
export function themeTitle(t, id) {
  const theme = findTheme(id);
  return theme ? t("cli.themeTitle", { name: t(`themes.${theme.id}.name`), id: theme.id }) : id;
}

/** Where a setting comes from: one msg. When it comes from an environment variable with an old name (GEMINI_MODEL), entry.env says which */
export const sourceOf = (setting, entry) =>
  entry.source === "env"
    ? msg("cli.source.env", { variable: entry.env ?? setting.env })
    : msg(`cli.source.${entry.source}`);

/**
 * @param {object} view
 * @param {Record<string, { value: string, source: "env" | "file" | "default" }>} view.settings
 * @param {{ home: string, settingsFile: string, logFile: string }} view.paths
 * @param {{ color: boolean, t: Function }} options
 */
export function renderConfig({ settings, paths }, { color, t }) {
  const c = paint(color);
  const valueWidth = Math.max(...Object.values(settings).map(({ value }) => displayWidth(value))) + 2;
  const entries = [];
  for (const [name, setting] of Object.entries(SETTINGS)) {
    const { value } = settings[name];
    const meaning = setting.label ? `${t.text(setting.label(value))} · ` : "";
    const describe = t(`settings.describe.${name}`);
    entries.push(
      [
        name,
        `${c.bold(value)}${" ".repeat(valueWidth - displayWidth(value))}${meaning}${t.text(sourceOf(setting, settings[name]))}`,
      ],
      [
        "",
        c.dim(setting.choices ? t("cli.config.choices", { describe, choices: setting.choices.join(" / ") }) : describe),
      ],
    );
  }
  return [
    t("cli.config.title"),
    "",
    ...rows(entries),
    "",
    `${INDENT}${t("cli.config.hintSet")}`,
    `${INDENT}${t("cli.config.hintUnset")}`,
    `${INDENT}${t("cli.config.hintKey")}`,
    `${INDENT}${t("cli.config.hintTheme")}`,
    "",
    ...rows([
      [t("cli.config.folder"), paths.home],
      [t("cli.config.settingsFile"), paths.settingsFile],
      [t("cli.config.log"), paths.logFile],
    ]),
    "",
    c.dim(`${INDENT}${t("cli.config.oneFolder")}`),
    c.dim(`${INDENT}${t("cli.config.uninstallHint")}`),
    "",
  ].join("\n");
}

/** Draws a short floating bar in the terminal in a theme's colors: cancel, wave, done. Needs a terminal with 24-bit color */
function barPreview({ bar }) {
  const ink = (value) => `\x1b[38;2;${toRgb(value).join(";")}m`;
  const on = (value) => `\x1b[48;2;${toRgb(value).join(";")}m`;
  const gap = `${on(bar.surface)} `;
  return [
    gap,
    `${on(bar.ghost)}${ink(bar.ink)} ✕ `,
    gap,
    `${ink(bar.live)}▂▄▆█▅▃▂▄▆▃`,
    gap,
    `${on(bar.go)}${ink(bar.onGo)} ✓ `,
    gap,
    "\x1b[0m",
  ].join("");
}

/**
 * @param {object} view
 * @param {Array<{ id: string, bar: object }>} view.themes names and descriptions are in the copy (themes.<id>.*)
 * @param {{ value: string, source: "env" | "file" | "default" }} view.setting the current theme setting
 * @param {{ color: boolean, truecolor?: boolean, t: Function }} options truecolor: the terminal supports 24-bit color, so colors can be drawn
 */
export function renderThemes({ themes, setting }, { color, truecolor = false, t }) {
  const c = paint(color);
  const name = (theme) => t(`themes.${theme.id}.name`);
  const idWidth = Math.max(...themes.map((theme) => theme.id.length)) + 3;
  const nameWidth = Math.max(...themes.map((theme) => displayWidth(name(theme)))) + 3;
  const lines = [t("cli.themes.title"), ""];
  for (const theme of themes) {
    const mark = theme.id === setting.value ? c.green("●") : " ";
    const preview = truecolor ? `${barPreview(theme)}   ` : "";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(theme.id, idWidth))}${padEnd(name(theme), nameWidth)}${preview}${c.dim(t(`themes.${theme.id}.describe`))}`,
    );
  }
  const other = themes.find((theme) => theme.id !== setting.value) ?? themes[0];
  lines.push(
    "",
    `${INDENT}${t("cli.themes.current", { theme: themeTitle(t, setting.value), source: sourceOf(SETTINGS.theme, setting) })}`,
    `${INDENT}${t("cli.themes.switch", { id: other.id })}`,
    "",
  );
  return lines.join("\n");
}
