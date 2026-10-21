// The floating bar's visuals: told what it should look like now, it draws that, shows and hides the bar, and draws the volume as a wave.
// What it should look like is computed in bar-view.mjs; this only draws. It knows nothing of recording or the network and never talks to the main process directly:
// the two things the host does for it are given by the caller. Moving to another shell later, this file and bar.css stay as they are; only those two functions change.

import { toRgb } from "../../themes/color.mjs";
import { controlsIn, hintFor, LINGER_MS, View } from "./bar-view.mjs";
import { createWave } from "./wave.mjs";

/** How many bars the refining wave has */
const THINK_BARS = 11;
/** How long the bar takes to fade out. Matches the data-shown="false" transition in bar.css */
const FADE_OUT_MS = 200;
/** A button's hit area is a ring larger than the visible circle, exactly filling the bar's height */
const HIT_SLOP = 6;
/** With "reduce motion" on in the system, the wave is drawn only this often */
const REDUCED_MOTION_MS = 200;
/** Line widths in CSS pixels: the main curve, and the echoes behind it */
const MAIN_WIDTH = 2;
const ECHO_WIDTH = 1.1;
/** Room left above and below so the main curve's stroke stays inside the canvas */
const WAVE_PAD = 1.5;
/** The curves fade in over this share of the width at each end, so they rise out of the bar instead of running into the buttons as lines */
const WAVE_FADE = 0.2;

/** How strongly an echo shows: the outer ones (larger scale) nearly as strong as the main curve, the inner ones fainter */
const echoAlpha = (scale) => 0.85 - 0.55 * (1 - Math.abs(scale));

/**
 * @param {object} options
 * @param {Document} options.document the floating bar's page (bar.html)
 * @param {object} options.host what the host does for it
 * @param {(visible: boolean) => void} options.host.setVisible shows / hides the floating bar's window
 * @param {(regions: object[] | null) => void} options.host.capture starts capturing esc and clicks in these regions
 *   ({ id, x, y, width, height }, positions in the window); null stops capturing
 * @param {string} options.keycap the hotkey's short name, written in the hint
 * @param {Function} options.t translates into the interface language (src/i18n); the hint is written with it
 */
export function createBarUi({ document, host, keycap: initialKeycap, t: initialT }) {
  /** Follows hotkey changes made in the settings */
  let keycap = initialKeycap;
  /** Follows language changes made in the settings */
  let t = initialT;
  const { body } = document;
  const hint = document.getElementById("hint");
  const message = document.getElementById("message");
  const buttons = { cancel: document.getElementById("cancel"), confirm: document.getElementById("confirm") };
  const window = document.defaultView;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const makeBars = (id, count) => {
    const bars = Array.from({ length: count }, () => document.createElement("i"));
    document.getElementById(id).replaceChildren(...bars);
    return bars;
  };
  // Each bar starts a little later than the last, so together they make one rolling wave
  for (const [index, bar] of makeBars("think", THINK_BARS).entries()) bar.style.setProperty("--i", index);
  const canvas = document.getElementById("wave");
  const context = canvas.getContext("2d");

  /** The view drawn now. hidden once the bar is put away */
  let view = View.HIDDEN;
  /** Whether the two buttons can be clicked */
  let controls = false;
  /** Whether the hint above the bar is shown (barHint in the settings) */
  let hintShown = true;
  const wave = createWave();
  /** While the microphone opens and while listening the wave is drawn every frame; null otherwise */
  let waveFrame = null;
  /** The wave's color as red, green, blue, read from the theme each time the wave starts */
  let waveRgb = [255, 255, 255];
  /** When the wave was last drawn */
  let drawnAt = -Infinity;
  /** The regions the host is capturing, as one line of text for easy comparison; null when not capturing */
  let captured = null;
  /** The timer that puts the bar away when time is up */
  let hideTimer = null;

  /** Draws the curves at the canvas's size on screen, sharp on high-density displays */
  function drawWave(curves) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const color = (alpha) => `rgb(${waveRgb.join(" ")} / ${alpha})`;
    const stroke = context.createLinearGradient(0, 0, width, 0);
    stroke.addColorStop(0, color(0));
    stroke.addColorStop(WAVE_FADE, color(1));
    stroke.addColorStop(1 - WAVE_FADE, color(1));
    stroke.addColorStop(1, color(0));
    context.strokeStyle = stroke;
    context.lineCap = "round";
    context.lineJoin = "round";
    const middle = height / 2;
    const half = middle - WAVE_PAD;
    for (const { scale, main, points } of curves) {
      context.globalAlpha = main ? 1 : echoAlpha(scale);
      context.lineWidth = main ? MAIN_WIDTH : ECHO_WIDTH;
      context.beginPath();
      for (const [index, [x, y]] of points.entries()) {
        if (index === 0) context.moveTo(x * width, middle - y * half);
        else context.lineTo(x * width, middle - y * half);
      }
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  function animateWave(now) {
    // With reduced motion the wave stops swaying but still follows the voice (it tells people "I hear you"), drawn less often
    const curves = wave.frame(now, { still: reducedMotion.matches });
    if (!reducedMotion.matches || now - drawnAt >= REDUCED_MOTION_MS) {
      drawWave(curves);
      drawnAt = now;
    }
    waveFrame = window.requestAnimationFrame(animateWave);
  }

  /**
   * The wave runs while the microphone opens (breathing, no voice yet) and while listening; it starts over only when it starts, so going from one to the
   * other carries on from where it is. Any other view stops it; the canvas fades out as it was when stopped
   */
  function syncWave() {
    if (view === View.STARTING || view === View.RECORDING) {
      if (waveFrame === null) {
        wave.reset();
        waveRgb = toRgb(window.getComputedStyle(canvas).color);
        waveFrame = window.requestAnimationFrame(animateWave);
      }
      return;
    }
    if (waveFrame !== null) window.cancelAnimationFrame(waveFrame);
    waveFrame = null;
  }

  function drawHint() {
    const parts = hintFor(view, { keycap, cancellable: controls, shown: hintShown }, t);
    hint.replaceChildren(
      ...parts.map((part) =>
        typeof part === "string" ? part : Object.assign(document.createElement("kbd"), { textContent: part.key }),
      ),
    );
  }

  /** A button's position in the window. Computed from layout, ignoring running animations: the bar floats up from below when it appears, so measuring at that moment would be off */
  function regionOf(id) {
    const button = buttons[id];
    let x = -HIT_SLOP;
    let y = -HIT_SLOP;
    for (let node = button; node !== null; node = node.offsetParent) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { id, x, y, width: button.offsetWidth + 2 * HIT_SLOP, height: button.offsetHeight + 2 * HIT_SLOP };
  }

  /** Tells the host to capture whatever this view needs. Says nothing if it is the same as last time */
  function syncCapture() {
    const ids = controls ? controlsIn(view) : [];
    const regions = ids.length > 0 ? ids.map(regionOf) : null;
    const next = regions && JSON.stringify(regions);
    if (next === captured) return;
    captured = next;
    host.capture(regions);
  }

  function hide() {
    view = View.HIDDEN;
    syncCapture();
    syncWave();
    // Keep the current view: fade out as it is, and put the window away once faded
    body.dataset.shown = "false";
    hideTimer = setTimeout(() => {
      host.setVisible(false);
      body.dataset.view = View.HIDDEN;
    }, FADE_OUT_MS);
  }

  return {
    /**
     * Switches to this view.
     * @param {string} next one of the Views in bar-view.mjs
     * @param {string | null} text the hint, or the sentence shown on error
     */
    show(next, text = null) {
      // Same view and same sentence: don't redraw, so the running animation and the "put away in a few seconds" timer don't restart
      if (next === view && (text ?? "") === message.textContent) return;
      clearTimeout(hideTimer);
      if (next === View.HIDDEN) {
        hide();
        return;
      }
      view = next;
      body.dataset.view = next;
      message.textContent = text ?? "";
      drawHint();
      syncWave();
      if (body.dataset.shown !== "true") {
        host.setVisible(true);
        body.dataset.shown = "true";
      }
      // Button positions can only be measured once layout is settled
      syncCapture();
      if (LINGER_MS[next] !== undefined) hideTimer = setTimeout(hide, LINGER_MS[next]);
    },

    /** One instantaneous volume while listening (0 to 1) */
    level(value) {
      if (view !== View.RECORDING) return;
      wave.hear(value);
    },

    /** Whether the two buttons can be clicked and esc can be captured (needs Accessibility permission). When not, no buttons are drawn and the hint doesn't mention esc */
    setControls(enabled) {
      controls = enabled;
      body.dataset.controls = String(enabled);
      if (view !== View.HIDDEN) drawHint();
      syncCapture();
    },

    /** The hint was turned on or off in the settings: the one showing changes at once */
    setHintShown(shown) {
      hintShown = shown;
      if (view !== View.HIDDEN) drawHint();
    },

    /** The hotkey changed: the hint shows the new one */
    setKeycap(next) {
      keycap = next;
      if (view !== View.HIDDEN) drawHint();
    },

    /**
     * The language changed: the hint is written in the new language, and the sentence showing is replaced with text (translated by the caller).
     * Not through show: the view hasn't changed, so the animation and the "put away in a few seconds" timer shouldn't restart
     */
    setTranslator(next, text = null) {
      t = next;
      if (view === View.HIDDEN) return;
      message.textContent = text ?? "";
      drawHint();
    },
  };
}
