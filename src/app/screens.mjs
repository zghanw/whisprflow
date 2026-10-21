import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Loaded by the main process only when WHISPRFLOW_SCREENS_OUT is set (scripts/dev/screens.mjs). It opens the windows with the app's real state,
// steps through a few views the way a person would click, saves each as a PNG in that directory, and quits.
// For checking how the pages look without clicking through them by hand.

const OUT_DIR = process.env.WHISPRFLOW_SCREENS_OUT;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a window's page to load, then a moment for it to draw from the state it fetched */
async function settled(window, ms = 1_000) {
  if (window.webContents.isLoading())
    await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
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
    await settled(onboarding);
    await capture(onboarding, "onboarding-start");
    // Next until the prepare step shows (onboarding may start at the mode step or later)
    for (let i = 0; i < 3; i++) {
      if (await run(onboarding, `!document.querySelector('[data-step="prepare"]').hidden`)) break;
      await run(onboarding, `document.getElementById("next").click()`);
      await sleep(600);
    }
    // Entering prepare checks Ollama; give the answer time to arrive
    await sleep(1_500);
    await capture(onboarding, "onboarding-prepare");
    onboarding.close();

    showHub({ pane: "dictionary" });
    const hub = hubWindow();
    await settled(hub, 1_500);
    await capture(hub, "settings-dictionary");
    await run(hub, `document.getElementById("settings").close()`);
    await sleep(500);
    await capture(hub, "hub-home");
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
    quit(0);
  } catch (error) {
    console.error(error);
    quit(1);
  }
}
