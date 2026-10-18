import { $ } from "../shared/dom.mjs";

// A sentence flashing briefly at the bottom of the window (#toast in hub.html): says an action succeeded, then hides itself after a few seconds.

let timer;

/** @param {string} text */
export function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.removeAttribute("data-hidden");
  clearTimeout(timer);
  timer = setTimeout(() => node.setAttribute("data-hidden", ""), 2400);
}
