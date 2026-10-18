import { createTranslator } from "../../i18n/index.mjs";

// Text on the page: translated into the interface language from the main process (window.whisprflow.locale, fetched synchronously by the preload script).
// Fixed text in HTML isn't written out, only named: data-i18n fills the text, data-i18n-<attribute> fills that attribute (title, aria-label, placeholder).

/**
 * The translation this page uses now. The floating bar replaces it when the language changes (setLocale), so always fetch it from here.
 * Outside a page (unit tests loading these modules in Node) there is no window, so the default language is used
 */
const platform = globalThis.window?.whisprflow?.platform;
export let t = createTranslator(globalThis.window?.whisprflow?.locale, platform);

// Where the page places things by system (like the three system buttons in a Windows window's top right) follows data-platform on html
if (globalThis.document && platform) document.documentElement.dataset.platform = platform;

/** Switches language (for the floating bar, which doesn't reload) */
export function setLocale(locale) {
  t = createTranslator(locale, platform);
  document.documentElement.lang = t.locale;
}

/** Fills the places marked data-i18n in root with the current language. Those inside <template> too, so clones of it (each history row) come with text */
export function localize(root = document) {
  document.documentElement.lang = t.locale;
  for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll("*")) {
    for (const { name, value } of node.attributes) {
      if (name.startsWith("data-i18n-")) node.setAttribute(name.slice("data-i18n-".length), t(value));
    }
  }
  for (const template of root.querySelectorAll("template")) localize(template.content);
}

/** How a hotkey is written in hints and keycaps */
export const keycapOf = (hotkey) => t(`hotkeys.${hotkey}.keycap`);
