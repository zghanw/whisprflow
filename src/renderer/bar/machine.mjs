// The dictation state machine, a pure function: given the current state and an event, returns the new state and the actions to run.
// The tap flow:
// press the hotkey once to start and again to finish; holding it over 600 ms cancels (this version has no push-to-talk).
// While speaking it can be cancelled (esc, or the X on the floating bar); clicking the check equals pressing the hotkey again.
// Which key is the hotkey is up to the main process; the state machine doesn't care.

import { msg } from "../../i18n/index.mjs";

export const LONG_PRESS_MS = 600;

export const Phase = Object.freeze({
  IDLE: "idle",
  STARTING: "starting", // pressed, microphone not ready yet
  RECORDING: "recording",
  FINISHING: "finishing", // recording ended, waiting for the result
  ERROR: "error",
});

export const Action = Object.freeze({
  START: "start", // open the microphone and connect to the server
  CANCEL: "cancel", // discard this recording
  STOP: "stop", // end recording and ask for the result
  ARM_HOLD_TIMER: "arm_hold_timer",
  CLEAR_HOLD_TIMER: "clear_hold_timer",
});

/**
 * held: the hotkey hasn't been released since the press that started this recording. Until it is released it isn't certain this is a tap:
 * it may be a long press, or a combination of the hotkey with another key.
 * message: the error cause or a hint for the user, only present on error and on returning to idle with a hint.
 */
export const initialState = Object.freeze({ phase: Phase.IDLE, held: false, message: null });

const idle = (message = null) => ({ phase: Phase.IDLE, held: false, message });
const unchanged = (state) => ({ state, actions: [] });

export function transition(state, event) {
  const { phase, held } = state;
  switch (event.type) {
    case "KEY_DOWN":
      if (phase === Phase.IDLE || phase === Phase.ERROR) {
        return {
          state: { phase: Phase.STARTING, held: true, message: null },
          actions: [Action.START, Action.ARM_HOLD_TIMER],
        };
      }
      // held is ignored: if the last release event was lost, another press must still finish rather than get stuck recording
      if (phase === Phase.RECORDING) {
        return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };
      }
      // Second press before the microphone was ready: nothing was recorded, so just drop it
      if (phase === Phase.STARTING && !held) return { state: idle(), actions: [Action.CANCEL] };
      return unchanged(state);

    case "KEY_UP":
      if (!held) return unchanged(state);
      return { state: { ...state, held: false }, actions: [Action.CLEAR_HOLD_TIMER] };

    case "OTHER_KEY":
      // Another key arrived while the hotkey is held: the user is pressing a combination (like Option+letter), not dictating
      if (!held) return unchanged(state);
      return { state: idle(), actions: [Action.CANCEL, Action.CLEAR_HOLD_TIMER] };

    case "LONG_HOLD":
      if (!held) return unchanged(state);
      return { state: idle(msg("bar.noHold")), actions: [Action.CANCEL] };

    case "USER_CANCEL":
      // The user doesn't want this one. Can't cancel while waiting for the result: the recording was already handed over
      if (phase !== Phase.STARTING && phase !== Phase.RECORDING) return unchanged(state);
      return { state: idle(), actions: [Action.CANCEL, Action.CLEAR_HOLD_TIMER] };

    case "USER_CONFIRM":
      if (phase !== Phase.RECORDING) return unchanged(state);
      return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };

    case "MIC_READY":
      return phase === Phase.STARTING ? unchanged({ ...state, phase: Phase.RECORDING }) : unchanged(state);

    case "MAX_DURATION":
      if (phase !== Phase.RECORDING) return unchanged(state);
      return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };

    case "RESULT":
      // message here is a hint for the user, like "No speech heard" or "Copied, press ⌘V"
      return phase === Phase.FINISHING ? unchanged(idle(event.message ?? null)) : unchanged(state);

    case "FAILED": {
      if (phase === Phase.IDLE || phase === Phase.ERROR) return unchanged(state);
      const next = { phase: Phase.ERROR, held: false, message: event.message };
      // Errors while waiting for the result: recording already stopped; in other phases, release the microphone and timers
      const actions = phase === Phase.FINISHING ? [] : [Action.CANCEL, Action.CLEAR_HOLD_TIMER];
      return { state: next, actions };
    }

    default:
      throw new Error(`Unknown state machine event: ${event.type}`);
  }
}
