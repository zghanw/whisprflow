// The floating bar: feeds keys and clicks to the state machine and records, uploads, and delivers as the state machine directs.
// The visuals aren't here: what it should look like is computed in bar-view.mjs and drawn by bar-ui.mjs.

import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keycapOf, localize, setLocale, t } from "../shared/i18n.mjs";
import { createBarUi } from "./bar-ui.mjs";
import { viewOf } from "./bar-view.mjs";
import { Action, initialState, LONG_PRESS_MS, Phase, transition } from "./machine.mjs";
import { startRecording } from "./recorder.mjs";
import { VoiceSocket } from "./voice-socket.mjs";

/** The longest single recording: 9 minutes */
const MAX_DURATION_MS = 540_000;

// The page's lang follows the interface language: the hint is aria-live, and screen readers pick the voice language from it
localize();
const { serverUrl, hotkey: initialHotkey, barControls, barHint } = await window.whisprflow.config();
/** The current hotkey (id). The hint shows its short name in the interface language */
let hotkey = initialHotkey;
const voice = new VoiceSocket(serverUrl);
const ui = createBarUi({
  document,
  host: { setVisible: window.whisprflow.setBarVisible, capture: window.whisprflow.captureBarInput },
  keycap: keycapOf(hotkey),
  t,
});
ui.setControls(barControls);
ui.setHintShown(barHint === "on");
window.whisprflow.onBarHint((value) => ui.setHintShown(value === "on"));
window.whisprflow.onHotkeyChanged((next) => {
  hotkey = next;
  ui.setKeycap(keycapOf(hotkey));
});
// The language changed in the settings: the bar doesn't reload (it may be mid-dictation); swap the translations so the next sentence is in the new language
window.whisprflow.onLocaleChanged((locale) => {
  setLocale(locale);
  ui.setTranslator(t, t.text(state.message));
  ui.setKeycap(keycapOf(hotkey));
});

let state = initialState;
/** The dictation in progress: { audioId, recording, cancelled } */
let session = null;
let holdTimer = null;
let maxDurationTimer = null;

function dispatch(event) {
  const previous = state;
  const result = transition(state, event);
  state = result.state;
  // The state didn't change (say, releasing the hotkey while idle): no redraw
  if (state !== previous) ui.show(viewOf(state, previous.phase), t.text(state.message));
  for (const action of result.actions) ACTIONS[action]();
}

const ACTIONS = {
  [Action.START]: start,
  [Action.CANCEL]: cancel,
  [Action.STOP]: stop,
  [Action.ARM_HOLD_TIMER]: () => {
    holdTimer = setTimeout(() => dispatch({ type: "LONG_HOLD" }), LONG_PRESS_MS);
  },
  [Action.CLEAR_HOLD_TIMER]: () => clearTimeout(holdTimer),
};

/** The sentence people see for an error: a msg (translated into the interface language when drawn), or plain text */
const describe = problemOf;

function start() {
  const current = { audioId: crypto.randomUUID(), recording: null, cancelled: false };
  session = current;
  (async () => {
    await voice.begin(current.audioId);
    const recording = await startRecording({
      onChunk: (chunk) => voice.sendChunk(chunk),
      onLevel: ui.level,
      onError: (error) => dispatch({ type: "FAILED", message: describe(error) }),
    });
    // The user may have cancelled during this short wait for the microphone
    if (current.cancelled) {
      recording.cancel();
      return;
    }
    current.recording = recording;
    maxDurationTimer = setTimeout(() => dispatch({ type: "MAX_DURATION" }), MAX_DURATION_MS);
    dispatch({ type: "MIC_READY" });
  })().catch((error) => {
    console.error("Failed to start recording", error);
    if (!current.cancelled) dispatch({ type: "FAILED", message: describeStartError(error) });
  });
}

function describeStartError(error) {
  if (error?.name === "NotAllowedError") return msg("bar.noMicPermission");
  if (error?.name === "NotFoundError") return msg("bar.noMicrophone");
  return describe(error);
}

function cancel() {
  clearTimeout(maxDurationTimer);
  if (!session) return;
  session.cancelled = true;
  session.recording?.cancel();
  session = null;
  voice.abandon();
}

async function stop() {
  clearTimeout(maxDurationTimer);
  const current = session;
  session = null;
  let recorded = null;
  try {
    recorded = await current.recording.stop();
    if (!recorded.hadSignal) {
      voice.abandon();
      throw new LocalizedError(msg("bar.noSignal"));
    }
    const text = await voice.finish({ durationSeconds: recorded.durationSeconds });
    const { notice } = await window.whisprflow.deliver({
      audioId: current.audioId,
      text,
      durationSeconds: recorded.durationSeconds,
      audio: await recorded.blob.arrayBuffer(),
    });
    dispatch({ type: "RESULT", message: notice });
  } catch (error) {
    console.error("This dictation failed", error);
    const message = describe(error);
    // If the recording still exists, hand it to the main process to save, so nothing said is lost on failure. History records the sentence on screen at this moment
    if (recorded) {
      await window.whisprflow
        .reportFailure({
          audioId: current.audioId,
          error: t.text(message),
          durationSeconds: recorded.durationSeconds,
          audio: await recorded.blob.arrayBuffer(),
        })
        .catch((saveError) => console.error("The failure record wasn't saved", saveError));
    }
    dispatch({ type: "FAILED", message });
  }
}

// ---------- Events from the main process ----------

/** What the helper reports, as state machine events. A click's id is the button on the bar that was clicked */
const INPUT_EVENTS = {
  hotkey: (event) => (event.down ? "KEY_DOWN" : "KEY_UP"),
  other_key: () => "OTHER_KEY",
  escape: () => "USER_CANCEL",
  click: (event) => ({ cancel: "USER_CANCEL", confirm: "USER_CONFIRM" })[event.id],
};

window.whisprflow.onInput((event) => {
  const type = Object.hasOwn(INPUT_EVENTS, event.event) ? INPUT_EVENTS[event.event](event) : undefined;
  if (type === undefined) {
    console.warn("Unknown input event", event);
    return;
  }
  dispatch({ type });
});

window.whisprflow.onBarControls(ui.setControls);

window.whisprflow.onNotice((message) => {
  // Reminders like permissions only show while idle, never interrupting a dictation in progress
  if (state.phase !== Phase.IDLE && state.phase !== Phase.ERROR) return;
  state = { ...state, message };
  ui.show(viewOf(state, state.phase), t.text(message));
});
