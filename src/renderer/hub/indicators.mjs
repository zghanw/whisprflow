// Sliders: the underline of category tabs and the thumb of segmented controls (.indicator in window.css), sliding from the previous position to the new one.
// The host has data-indicator="<name>", its first child is .indicator, and the selected item has aria-selected or aria-checked.

/**
 * @param {ParentNode} root where to look for hosts (one per page, each remembering its own previous position)
 * @returns {{ place: () => void, reset: () => void }} place: positions it at the selected item; reset: forgets the previous position
 *   (after a page goes from hidden to shown, or the window changes width, the old position was measured in another layout and can't be slid from)
 */
export function slidingIndicators(root) {
  const lastPlace = new Map();

  function place() {
    for (const host of root.querySelectorAll("[data-indicator]")) {
      const ink = host.querySelector(":scope > .indicator");
      const on = host.querySelector(':scope > [aria-selected="true"], :scope > [aria-checked="true"]');
      if (!ink) continue;
      ink.hidden = !on;
      // Widths can't be measured while the page is hidden: wait until it is shown to place it
      if (!on || on.offsetWidth === 0) continue;
      const next = { x: on.offsetLeft, w: on.offsetWidth };
      const prev = lastPlace.get(host.dataset.indicator) ?? next;
      ink.style.transition = "none";
      ink.style.setProperty("--x", `${prev.x}px`);
      ink.style.setProperty("--w", `${prev.w}px`);
      ink.getBoundingClientRect();
      ink.style.transition = "";
      ink.style.setProperty("--x", `${next.x}px`);
      ink.style.setProperty("--w", `${next.w}px`);
      lastPlace.set(host.dataset.indicator, next);
    }
  }

  const reset = () => lastPlace.clear();
  addEventListener("resize", () => {
    reset();
    place();
  });
  return { place, reset };
}
