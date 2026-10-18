import { t } from "./i18n.mjs";
import { providerIcon } from "./provider-icons.mjs";

// Small helpers shared by the parts drawn in code (the main window's model page and mode menu, onboarding's mode and prepare steps): building nodes, getting icons, naming providers in the interface language.

const NS = "http://www.w3.org/2000/svg";

export const $ = (id) => document.getElementById(id);

/** One icon from the icon sheet at the top of the page (.sprite in each page's html) */
export function svg(id, className = "icon") {
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#${id}`);
  node.append(use);
  return node;
}

/** The check mark that animates right after passing a check: its path must be in the document (path styles inside <use> are out of reach) */
export function drawnCheck() {
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("class", "icon");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M20 6L9 17l-5-5");
  node.append(path);
  return node;
}

/** Brand icons: known makers use their icon, unknown ones a cloud */
export const brand = (id) => providerIcon(id) ?? svg("i-cloud");

/** Builds a node: attributes and children that are false, null, or undefined are skipped */
export function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

/** Use the copy if it has the name, otherwise the given name (for platforms and makers not yet in the copy) */
export function named(key, fallback) {
  const text = t(key);
  return text === key ? fallback : text;
}

/** What a platform (the one selling models and taking keys) is called in the interface language */
export const platformName = (platform) => named(`providers.${platform.id}.name`, platform.name);

/** Download progress: the background fills to how much has downloaded, with a percentage (used in model library rows and presets) */
export function progressBadge(download) {
  const p = download.total ? download.received / download.total : 0;
  return h(
    "span",
    {
      class: "badge block",
      "data-tone": "progress",
      style: `--p: ${p}`,
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(p * 100)),
    },
    svg("i-download"),
    h("span", { class: "label", text: `${Math.round(p * 100)}%` }),
  );
}
