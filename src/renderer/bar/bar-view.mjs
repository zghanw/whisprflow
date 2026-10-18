// What the floating bar should look like: computed from the state machine's state, a pure function that never touches the page.
// bar-ui.mjs is what actually draws it.

import { Phase } from "./machine.mjs";

export const View = Object.freeze({
  HIDDEN: "hidden",
  STARTING: "starting", // opening the microphone: the wave lies flat, pulsing
  RECORDING: "recording", // listening: the wave follows the voice
  FINISHING: "finishing", // refining: a wave rolling past at a steady pace
  DONE: "done", // the text was pasted: a check mark
  NOTICE: "notice", // a hint
  ERROR: "error", // an error: icon plus reason
});

/** How long the closing views stay on screen before disappearing. Views shown while speaking aren't here: they stay until the phase changes */
export const LINGER_MS = Object.freeze({
  [View.DONE]: 900,
  [View.NOTICE]: 4_000,
  [View.ERROR]: 4_000,
});

/**
 * @param {{ phase: string, message: object | string | null }} state the state machine's current state (message is a msg or plain text)
 * @param {string} previousPhase the phase before the current one
 */
export function viewOf(state, previousPhase) {
  switch (state.phase) {
    case Phase.STARTING:
      return View.STARTING;
    case Phase.RECORDING:
      return View.RECORDING;
    case Phase.FINISHING:
      return View.FINISHING;
    case Phase.ERROR:
      return View.ERROR;
    default:
      if (state.message !== null) return View.NOTICE;
      // Just got the result and nothing else to say: show a check, then go. Cancelled, or a hint that has finished, just disappears
      return previousPhase === Phase.FINISHING ? View.DONE : View.HIDDEN;
  }
}

/**
 * The hint line above the bar.
 * @param {string} view
 * @param {{ keycap: string, cancellable: boolean, shown?: boolean }} options keycap: the hotkey's short name;
 *   cancellable: whether esc can be captured; shown: the hint is on in the settings (barHint); when off, no view writes one
 * @param {Function} t translates into the interface language (src/i18n). Each language decides where the key goes in the sentence
 * @returns {Array<string | { key: string }>} pieces: text, or a key to be marked as a key name
 */
export function hintFor(view, { keycap, cancellable, shown = true }, t) {
  if (!shown) return [];
  switch (view) {
    case View.STARTING:
      return [t("bar.opening")];
    case View.RECORDING:
      return t.parts(cancellable ? "bar.recording" : "bar.recordingNoEsc", {
        key: { key: keycap },
        esc: { key: "esc" },
      });
    case View.FINISHING:
      return [t("bar.finishing")];
    default:
      return [];
  }
}

/** Which buttons on the bar can be clicked in this view */
export function controlsIn(view) {
  if (view === View.STARTING) return ["cancel"];
  if (view === View.RECORDING) return ["cancel", "confirm"];
  return [];
}
