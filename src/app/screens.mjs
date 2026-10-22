import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Loaded by the main process only when WHISPRFLOW_SCREENS_OUT is set (scripts/dev/screens.mjs). It opens the windows with the app's real state,
// steps through a few views the way a person would click, saves each as a PNG in that directory, and quits.
// For checking how the pages look without clicking through them by hand.

const OUT_DIR = process.env.WHISPRFLOW_SCREENS_OUT;
/** Media features to emulate, as name=value pairs separated by commas (prefers-color-scheme=dark,prefers-contrast=more), so dark mode and the
 * accessibility preferences can be checked without changing the system's settings */
/** A window size to use instead of the default, like 1000x700: how the pages behave in a window that isn't maximized */
const SIZE =
  /^(\d+)x(\d+)$/
    .exec(process.env.WHISPRFLOW_SCREENS_SIZE ?? "")
    ?.slice(1)
    .map(Number) ?? null;
const MEDIA = (process.env.WHISPRFLOW_SCREENS_MEDIA ?? "")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [name, value] = pair.split("=");
    return { name: name.trim(), value: value.trim() };
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a window's page to load, then a moment for it to draw from the state it fetched */
async function settled(window, ms = 1_000) {
  if (window.webContents.isLoading())
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  if (MEDIA.length > 0) {
    window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: MEDIA });
  }
  await sleep(ms);
}

async function capture(window, name) {
  const image = await window.webContents.capturePage();
  writeFileSync(join(OUT_DIR, `${name}.png`), image.toPNG());
  console.log(`Saved ${name}.png`);
}

const run = (window, code) => window.webContents.executeJavaScript(code);

/**
 * @param {object} app the main process's windows
 * @param {() => void} app.showOnboarding
 * @param {() => object | null} app.onboardingWindow
 * @param {(target?: object) => void} app.showHub
 * @param {() => object | null} app.hubWindow
 * @param {(code: number) => void} app.quit
 */
export async function runScreens({ showOnboarding, onboardingWindow, showHub, hubWindow, quit }) {
  mkdirSync(OUT_DIR, { recursive: true });
  try {
    showOnboarding();
    const onboarding = onboardingWindow();
    if (SIZE) onboarding.setSize(...SIZE);
    await settled(onboarding);
    // Onboarding resumes past finished steps: go back to the first one
    for (let i = 0; i < 10; i++) {
      const rewound = await run(
        onboarding,
        `(() => { const back = document.getElementById("back"); if (!back || back.disabled || back.hidden) return false; back.click(); return true; })()`,
      );
      if (!rewound) break;
      await sleep(400);
    }
    // Each step as it comes, pressing Next until a step waits for something only a person can do (pressing the hotkey, dictating)
    const shown = new Set();
    for (let i = 0; i < 10; i++) {
      const step = await run(onboarding, `document.querySelector(".step:not([hidden])")?.dataset.step ?? null`);
      if (step === null || shown.has(step)) break;
      shown.add(step);
      // Entering prepare checks Ollama, and the microphone step starts its meter: give them time to show
      await sleep(step === "prepare" || step === "microphone" ? 1_500 : 400);
      await capture(onboarding, `onboarding-${step}`);
      const moved = await run(
        onboarding,
        `(() => { const next = document.getElementById("next"); if (!next || next.disabled || next.hidden) return false; next.click(); return true; })()`,
      );
      if (!moved) break;
      await sleep(700);
    }
    onboarding.close();

    showHub({ route: "home" });
    const hub = hubWindow();
    if (SIZE) hub.setSize(...SIZE);
    await settled(hub, 1_500);
    await capture(hub, "hub-home");
    await run(hub, `document.getElementById("mode-trigger").click()`);
    await sleep(600);
    await capture(hub, "hub-mode-picker");
    await run(hub, `document.getElementById("mode-picker").hidePopover()`);
    await run(hub, `document.querySelector('.nav-item[data-route="models"]').click()`);
    await sleep(800);
    await capture(hub, "hub-models");
    // The Transcribe, Polish, and Keys tabs: the second to fourth tab
    for (const [index, name] of [
      [1, "hub-models-transcribe"],
      [2, "hub-models-polish"],
      [3, "hub-models-keys"],
    ]) {
      await run(hub, `document.querySelectorAll('#plaza-tabs [role="tab"]')[${index}].click()`);
      await sleep(800);
      await capture(hub, name);
    }
    // Recommended setups opened over the Transcribe tab (the Keys tab shows where keys are stored on this computer)
    await run(hub, `document.querySelectorAll('#plaza-tabs [role="tab"]')[1].click()`);
    await sleep(500);
    await run(hub, `document.getElementById("preset-trigger").click()`);
    await sleep(800);
    await capture(hub, "hub-presets");
    // A window too short for every setup scrolls the list: the end of it
    await run(hub, `document.getElementById("preset-options").scrollTop = 1e6`);
    await sleep(400);
    await capture(hub, "hub-presets-end");
    await run(hub, `document.getElementById("preset-picker").hidePopover()`);
    await run(hub, `document.querySelector('.nav-item[data-route="history"]').click()`);
    await sleep(800);
    await capture(hub, "hub-history");
    for (const pane of ["general", "dictionary"]) {
      showHub({ pane });
      await sleep(900);
      await capture(hub, `settings-${pane}`);
    }
    quit(0);
  } catch (error) {
    console.error(error);
    quit(1);
  }
}
