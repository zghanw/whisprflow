import { permissionGranted } from "../shared/setup-text.mjs";
import { needsOf, planOf } from "./plan.mjs";

// Onboarding's steps, which one to start at, and whether each counts as done. Pure functions that never touch the page.
// Three segments: choose how to use it and connect models, set up, then try it.
// Any step can go back or jump ahead: unfinished steps can be skipped to configure later (private mode needs no key, and people can look around with nothing set up).

export const STEPS = ["way", "prepare", "permissions", "microphone", "hotkey", "try", "done"];

/** Which of the three top segments each step belongs to */
const GROUP_OF = {
  way: "model",
  prepare: "model",
  permissions: "setup",
  microphone: "setup",
  hotkey: "setup",
  try: "try",
  done: "try",
};
export const GROUPS = ["model", "setup", "try"];

/** Clicking a top segment goes to its first step */
export const firstStepOf = (group) => STEPS.find((step) => GROUP_OF[step] === group);

/**
 * Which step onboarding starts at: if the set in use lacks nothing, start at setup (the model steps can still be revisited);
 * when connected to a separately started server, that server decides the mode, so start at setup too
 */
export function startStep(setup) {
  if (!setup.switchable) return "permissions";
  return needsOf(planOf(setup), setup).length === 0 ? "permissions" : "way";
}

/**
 * Whether this step is done: done shows "Continue" at the bottom, not done shows "Skip" (still allowed).
 * The microphone and shortcut tests rely on their own "Yes, continue", so the bottom button is always "Skip"
 * @param {{ setup: object, said: boolean }} state said: the try-it step has produced text
 */
export function stepDone(step, { setup, said }) {
  switch (step) {
    case "way":
      return true;
    case "prepare":
      return needsOf(planOf(setup), setup).length === 0;
    case "permissions":
      // It works without Accessibility (text goes to the clipboard), so that doesn't count as unfinished
      return (
        permissionGranted("microphone", setup.permissions.microphone) &&
        permissionGranted("listen", setup.permissions.listen) === true
      );
    case "try":
      return said;
    default:
      return false;
  }
}

/** The state of each top segment: done, current, or todo */
export function groupStates(step) {
  const current = GROUPS.indexOf(GROUP_OF[step]);
  return Object.fromEntries(
    GROUPS.map((group, index) => [group, index < current ? "done" : index === current ? "current" : "todo"]),
  );
}
