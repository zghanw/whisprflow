// The registered themes. The UI and the CLI take them from here and never import one directly.
// A theme's name and one-line description live in the messages (themes.<id>.name / describe).

import { LOCALES } from "../i18n/index.mjs";
import cinnabar from "./cinnabar.mjs";
import indigo from "./indigo.mjs";
import ink from "./ink.mjs";
import violet from "./violet.mjs";

/** Listed to the user in this order. To add one: write a file like ink.mjs, add a line here, and give it a name and description in the messages */
export const THEMES = [violet, ink, cinnabar, indigo];

/** Used when the user has not picked one: the app icon's purple */
export const DEFAULT_THEME = violet.id;

/**
 * Finds a theme by id or by its display name ("cinnabar", "Cinnabar").
 * @returns {(typeof THEMES)[number] | null} null when there is no such theme
 */
export function findTheme(idOrName) {
  const named = (theme) => LOCALES.some(({ messages }) => messages.themes[theme.id]?.name === idOrName);
  return THEMES.find((theme) => theme.id === idOrName || named(theme)) ?? null;
}
