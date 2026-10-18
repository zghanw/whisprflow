import { h, progressBadge, svg } from "../shared/dom.mjs";
import { keycapOf, localize, t } from "../shared/i18n.mjs";
import { meterLevels, openMicrophone } from "../shared/level-meter.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";
import { describeError, permissionGranted } from "../shared/setup-text.mjs";
import { createKeyPanel } from "./key-panel.mjs";
import { changesOf, hasKey, inEffect, localModelOf, needsOf, planOf, readinessOf, vendorsFor, WAYS } from "./plan.mjs";
import { firstStepOf, groupStates, STEPS, startStep, stepDone } from "./steps.mjs";

// Onboarding: choose a recognition mode, prepare (download the on-device model, enter keys), grant permissions, test the microphone, test the shortcut, say one real sentence, done.
// Any step can go back or jump ahead, and unfinished steps can be skipped to configure later: private mode needs no key, and people can look around with nothing set up.
// Clicking a mode or provider switches it in at once (switchMode in app/modes.mjs doesn't verify keys or wait for downloads); what is missing is stated honestly, and it works once filled in.
// All state lives in the main process; this tracks the current step and how each step draws. When finished, the main process closes this window and opens the main window.

const $ = (id) => document.getElementById(id);
/** How many bars the microphone test draws, tall in the middle and short at the sides */
const METER_BARS = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];
const ICONS = { native: "i-sparkles", local: "i-wand-sparkles", private: "i-shield-check" };

// Fill in the page's fixed text in the interface language first
localize();

let setup = null;
let step = null;
/** The set in use: { mode, native, polish } (plan.mjs). From the settings; while switching, drawn as the set clicked */
let plan = null;
/** How many switches are in flight (several quick clicks queue up and switch one by one) */
let applying = 0;
/** Which click this is: only the last click reports success or failure */
let attempts = 0;
/** The last click failed to switch: { plan, problem }. "Retry" switches again; switching to something else or saving a new key clears it */
let failure = null;
/** The key panel in the prepare step: { mode, section, panel }, replaced when the mode changes */
let keySlot = null;
/** A download that failed to start (not enough disk and the like): { model, problem }. Failures mid-download are recorded in the model's state by the main process */
let downloadProblem = null;
/** The three mode rows: built once, afterwards only their state changes */
const wayRows = new Map();

async function refresh() {
  setup = await window.whisprflow.getSetup();
  if (applying === 0) plan = planOf(setup);
  render();
  return setup;
}

// ---------- Switching to the clicked set ----------

/**
 * A mode or provider was clicked: switch at once, carrying that mode's settings (changesOf in plan.mjs). Already this set: do nothing;
 * still send it while the previous click is switching: the status in hand hasn't caught up, so it can't tell whether it is already this set
 */
async function changePlan(next) {
  const wanted = { ...plan, ...next };
  const ticket = ++attempts;
  failure = null;
  plan = wanted;
  if (applying === 0 && inEffect(wanted, setup)) {
    render();
    return;
  }
  applying += 1;
  render();
  let result;
  try {
    result = await window.whisprflow.setMode(wanted.mode, changesOf(wanted, setup));
  } catch (error) {
    result = { ok: false, problem: describeError(error) };
  }
  applying -= 1;
  if (ticket === attempts) failure = result.ok ? null : { plan: wanted, problem: result.problem };
  await refresh();
}

// ---------- Which step ----------

/** Cleanup when leaving a step: close the microphone, stop capturing the hotkey */
const leave = {
  microphone: () => stopMeter(),
  hotkey: () => window.whisprflow.captureHotkey(false),
};
/** What to do when entering a step */
const enter = {
  microphone: () => startMeter(),
  // During the shortcut test the hotkey doesn't open the floating bar, it only comes here
  hotkey: () => window.whisprflow.captureHotkey(true),
  try: () => $("try-text").focus(),
};

function go(next) {
  if (next === step) return;
  leave[step]?.();
  step = next;
  for (const section of document.querySelectorAll(".step")) section.hidden = section.dataset.step !== step;
  $("stage").scrollTop = 0;
  enter[step]?.();
  render();
}

const goBy = (offset) => go(STEPS[Math.min(STEPS.length - 1, Math.max(0, STEPS.indexOf(step) + offset))]);

// ---------- Drawing ----------

const modeName = (mode) => t(`plaza.modes.${mode}`);
const transcriber = (id) => setup.local.transcribers.find((model) => model.id === id);

/** Size: GB with one decimal from 1 GB up, whole MB below */
const sizeText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

/** Splits "Qwen3-ASR 0.6B (Q8_0)" into model and quantization */
function nameParts(name) {
  const match = /^(.*?) \((.+)\)$/.exec(name);
  return match ? [match[1], match[2]] : [name, null];
}

/** The brand icon base: known makers use their icon, on-device models a laptop, unknown ones a cloud */
const tile = (id, className = "logo-tile") =>
  h("span", { class: className }, (id && providerIcon(id)) ?? svg(id === "local" ? "i-laptop" : "i-cloud"));

/** What a row needs: short phrases with icons */
const need = (icon, text) => h("span", { class: "need" }, svg(icon), h("span", { text }));

function renderWays() {
  if (wayRows.size === 0) {
    for (const mode of WAYS) {
      const needs = h("span", { class: "needs" });
      const button = h(
        "button",
        { type: "button", class: "choice", role: "radio", onclick: () => changePlan({ mode }) },
        h("span", { class: "choice-icon" }, svg(ICONS[mode])),
        h(
          "span",
          { class: "choice-body" },
          h("span", { class: "choice-name", text: modeName(mode) }),
          h("span", { class: "choice-desc", text: t(`home.mode.desc.${mode}`) }),
          needs,
        ),
        h(
          "span",
          {
            class: "brands",
            title: vendorsFor(setup, mode)
              .map(({ id }) => t(`providers.${id}.name`))
              .join(" · "),
          },
          ...(mode === "private"
            ? [tile("local", "mini-tile")]
            : vendorsFor(setup, mode).map(({ id }) => tile(id, "mini-tile"))),
        ),
        h("span", { class: "radio-mark" }, svg("i-check")),
      );
      wayRows.set(mode, { button, needs });
    }
    $("ways").replaceChildren(...[...wayRows.values()].map(({ button }) => button));
  }
  for (const [mode, { button, needs }] of wayRows) {
    button.setAttribute("aria-checked", String(plan.mode === mode));
    button.disabled = !setup.switchable;
    const local = mode === "native" ? null : transcriber(localModelOf(setup, mode));
    const size = local && (local.installed ? t("onboarding.prepare.model.ready") : sizeText(local.bytes));
    needs.replaceChildren(
      ...(local ? [need("i-laptop", t("onboarding.way.local", { size }))] : []),
      mode === "private" ? need("i-lock", t("onboarding.way.offline")) : need("i-key-round", t("onboarding.way.key")),
    );
  }
  $("way-note").replaceChildren(
    svg("i-circle-alert"),
    t(setup.switchable ? "onboarding.way.note" : "home.mode.locked"),
  );
}

/**
 * When the mode in use sends step one to the cloud (only configurable on the model page): that step's { maker, platform, name } (hops in app/model-plaza.mjs);
 * otherwise null, and step one is an on-device model
 */
function cloudFirstHop() {
  if (plan.mode === "native" || plan.mode !== setup.mode.value) return null;
  const first = setup.plaza.ways[plan.mode]?.hops?.[0];
  return first && first.platform !== "local" ? first : null;
}

/** The route: recording, then each model, then text */
function renderRoute() {
  const arrow = () => h("li", { class: "route-arrow", "aria-hidden": "true" }, svg("i-chevron-right"));
  const end = (icon, text) => h("li", { class: "route-end" }, svg(icon), h("span", { text }));
  const hop = (id, text, local) =>
    h(
      "li",
      { class: "route-hop" },
      tile(id, "mini-tile"),
      h("span", { text }),
      local && h("span", { class: "tag", "data-tone": "accent", text: t("onboarding.prepare.route.local") }),
    );
  const hops = [];
  const cloud = cloudFirstHop();
  if (cloud) hops.push(hop(cloud.maker ?? cloud.platform, cloud.name, false));
  else if (plan.mode !== "native") {
    const model = transcriber(localModelOf(setup, plan.mode));
    hops.push(hop(model.maker ?? "local", nameParts(model.name)[0], true));
  }
  if (plan.mode === "native") hops.push(hop(plan.native, t(`providers.${plan.native}.name`), false));
  if (plan.mode === "local") hops.push(hop(plan.polish, t(`providers.${plan.polish}.name`), false));
  $("route").replaceChildren(
    end("i-mic", t("onboarding.prepare.route.audio")),
    ...hops.flatMap((item) => [arrow(), item]),
    arrow(),
    end("i-letter-text", t("onboarding.prepare.route.text")),
  );
}

/** This set's state: enabling, failed (with retry), enabled; when enabled but something is missing, one line says so, and each panel below lists its own gaps */
function renderStatus() {
  const box = $("plan-status");
  const badge = (tone, icon, text) =>
    h(
      "span",
      { class: "badge", "data-tone": tone },
      svg(icon, icon === "i-loader-circle" ? "icon spin" : "icon"),
      h("span", { text }),
    );
  let content = null;
  if (applying) content = badge("progress", "i-loader-circle", t("onboarding.prepare.status.enabling"));
  else if (failure) {
    content = h(
      "div",
      { class: "callout", role: "alert" },
      svg("i-circle-alert"),
      h("span", {}, h("b", { text: t("onboarding.prepare.status.failed") }), ` · ${t.text(failure.problem)}`),
      h("button", {
        type: "button",
        class: "button small retry",
        text: t("onboarding.prepare.status.retry"),
        onclick: () => changePlan(failure.plan),
      }),
    );
  } else if (needsOf(plan, setup).length === 0)
    content = badge("ok", "i-check", t("onboarding.prepare.status.enabled", { mode: modeName(plan.mode) }));
  else content = badge("", "i-circle-alert", t("onboarding.prepare.status.switched", { mode: modeName(plan.mode) }));
  box.replaceChildren(...(content ? [content] : []));
  box.hidden = content === null;
}

/** The on-device model row: name, quantization, size, where it downloads from; download, progress, or downloaded on the right */
function modelSection() {
  const model = transcriber(localModelOf(setup, plan.mode));
  const [base, variant] = nameParts(model.name);
  let action;
  if (model.installed) {
    action = h(
      "span",
      { class: "state-box", "data-tone": "accent" },
      svg("i-check"),
      t("onboarding.prepare.model.ready"),
    );
  } else if (model.download) {
    action = progressBadge(model.download);
  } else {
    action = h(
      "button",
      {
        type: "button",
        class: "button",
        disabled: !setup.switchable,
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          const result = await window.whisprflow.downloadModel(model.id).catch((error) => ({
            ok: false,
            problem: describeError(error),
          }));
          if (!result.ok) downloadProblem = { model: model.id, problem: result.problem };
          await refresh();
        },
      },
      svg("i-download"),
      t(
        model.problem || downloadProblem?.model === model.id
          ? "onboarding.prepare.model.retry"
          : "onboarding.prepare.model.download",
      ),
    );
  }
  const problem = model.download ? null : downloadProblem?.model === model.id ? downloadProblem.problem : model.problem;
  const source = t(`onboarding.prepare.model.sources.${setup.local.source.value}`);
  return h(
    "section",
    { class: "prepare-section model-section" },
    h("h2", { class: "section-label", text: t("onboarding.prepare.sections.model") }),
    h(
      "div",
      { class: "model-row" },
      tile(model.maker ?? "local"),
      h(
        "span",
        { class: "model-text" },
        h(
          "span",
          { class: "model-name" },
          h("span", { text: base }),
          variant && h("span", { class: "tag", "data-tone": "outline", text: variant }),
        ),
        h("span", { class: "model-meta", text: `${sizeText(model.bytes)} · ${source}` }),
      ),
      h("span", { class: "model-action" }, action),
    ),
    problem &&
      h(
        "p",
        { class: "callout", role: "alert" },
        svg("i-circle-alert"),
        h("span", {}, h("b", { text: t("plaza.actionFailed") }), ` · ${t.text(problem)}`),
      ),
    !model.installed && h("p", { class: "section-hint", text: t("onboarding.prepare.model.background") }),
  );
}

/** The provider and key panel: stays the same node within one mode (moving it would lose input focus), replaced only when the mode changes */
function keySection() {
  const mode = plan.mode;
  if (keySlot?.mode !== mode) {
    const host = h("div", { class: "key-panel" });
    keySlot = {
      mode,
      section: h(
        "section",
        { class: "prepare-section key-section" },
        h("h2", { class: "section-label", text: t(`onboarding.prepare.sections.${mode}`) }),
        host,
        mode === "native" && h("p", { class: "section-hint", text: t("onboarding.prepare.nativeOnly") }),
      ),
      panel: createKeyPanel(host, {
        mode,
        label: t(`onboarding.prepare.sections.${mode}`),
        vendors: (current) => vendorsFor(current, mode),
        hasKey: (current, id) => hasKey(current, mode, id),
        picked: () => (mode === "native" ? plan.native : plan.polish),
        pick: (id) => changePlan(mode === "native" ? { native: id } : { polish: id }),
        // Checks only look at this provider: native switches to its default model, polish only verifies it (step one uses the on-device model, see check in app/modes.mjs)
        checkChanges: (id) => (mode === "native" ? changesOf({ ...plan, native: id }, setup) : { polish: id }),
        refresh,
        onSaved: () => {
          failure = null;
        },
      }),
    };
  }
  keySlot.panel.render(setup);
  return keySlot.section;
}

function renderPrepare() {
  $("prepare-title").replaceChildren(
    h("span", { class: "soft", text: t(`onboarding.prepare.${plan.mode}.soft`) }),
    h("span", { text: t(`onboarding.prepare.${plan.mode}.title`) }),
  );
  renderRoute();
  renderStatus();
  // When step one is in the cloud there's no on-device model to download
  const model = plan.mode === "native" || cloudFirstHop() ? null : modelSection();
  const key = plan.mode === "private" ? null : keySection();
  const host = $("prepare-sections");
  // If the key panel is already on the page, don't move it (moving loses input focus); only replace the on-device model panel
  if (key && key.parentNode === host) {
    const old = host.querySelector(":scope > .model-section");
    if (model && old) old.replaceWith(model);
    else if (model) host.prepend(model);
    else old?.remove();
  } else host.replaceChildren(...[model, key].filter(Boolean));
  // When everything is there, no need to say "skippable"
  $("prepare-note").hidden = needsOf(plan, setup).length === 0;
  $("prepare-note").replaceChildren(
    svg("i-circle-alert"),
    t(plan.mode === "private" ? "onboarding.prepare.laterModel" : "onboarding.prepare.later"),
    plan.mode === "local" ? ` · ${t("onboarding.prepare.more")}` : "",
  );
}

/**
 * The try-it and done steps say whether dictation works now (readinessOf in plan.mjs): null if it does;
 * otherwise { tone, icon, text }: listing what is missing one by one, with download percentages
 */
function readiness() {
  const state = readinessOf(setup);
  if (state === null) return null;
  const needText = (need) => {
    if (need.kind === "url") return t("home.mode.needs.url");
    if (need.kind === "key") return t("onboarding.try.needKey", { vendor: t(`providers.${need.vendor}.name`) });
    const model = transcriber(need.model);
    const name = nameParts(model.name)[0];
    if (!model.download) return t("onboarding.try.needDownload", { model: name, size: sizeText(model.bytes) });
    const percent = Math.round((model.download.received / (model.download.total || 1)) * 100);
    return t("onboarding.try.downloading", { model: name, percent });
  };
  const text = state.problem
    ? t.text(state.problem)
    : state.needs.length > 0
      ? state.needs.map(needText).join(" · ")
      : t("onboarding.try.preparing");
  const icon =
    state.tone === "progress" ? (state.needs.length > 0 ? "i-download" : "i-loader-circle") : "i-circle-alert";
  // Only waiting (download, verification, loading) means nothing to do, so no button
  return { tone: state.tone, icon, text, fixable: state.tone === "problem" };
}

function renderTry() {
  const state = readiness();
  const box = $("try-readiness");
  box.hidden = state === null;
  if (state) {
    box.dataset.tone = state.tone;
    const fix =
      state.fixable && setup.switchable
        ? // Gaps are filled in the prepare step: enter a missing key, download a missing model
          [
            h("button", {
              type: "button",
              class: "button small readiness-fix",
              text: t("onboarding.try.fix"),
              onclick: () => go("prepare"),
            }),
          ]
        : [];
    box.replaceChildren(
      svg(state.icon, state.icon === "i-loader-circle" ? "icon spin" : "icon"),
      h("span", { text: state.text }),
      ...fix,
    );
  }
}

/** Done: the state of each of the three, with icons */
function renderSummary() {
  const item = (icon, label, value, tone) =>
    h(
      "li",
      { class: "summary-item", "data-tone": tone },
      h("span", { class: "logo-tile" }, svg(icon)),
      h("span", { class: "summary-label", text: label }),
      h("span", { class: "summary-value", text: value }),
    );
  const state = readiness();
  const mode = state ? state.text : t("onboarding.prepare.status.enabled", { mode: modeName(plan.mode) });
  const mic = permissionGranted("microphone", setup.permissions.microphone);
  $("summary").replaceChildren(
    item(ICONS[plan.mode], t("onboarding.done.mode"), mode, state ? state.tone : "ok"),
    item("i-keyboard", t("onboarding.done.hotkey"), keycapOf(setup.hotkey.value), "ok"),
    item(
      "i-mic",
      t("permissions.microphone"),
      t(mic ? "permissions.granted" : "permissions.denied"),
      mic ? "ok" : "problem",
    ),
  );
}

function render() {
  if (setup === null || step === null) return;
  const states = groupStates(step);
  for (const button of document.querySelectorAll("[data-group]")) {
    button.dataset.state = states[button.dataset.group];
    button.setAttribute("aria-current", states[button.dataset.group] === "current" ? "step" : "false");
  }

  if (step === "way") renderWays();
  if (step === "prepare") renderPrepare();
  if (step === "try") renderTry();
  if (step === "done") renderSummary();

  for (const row of document.querySelectorAll("[data-permission]")) {
    const granted = permissionGranted(row.dataset.permission, setup.permissions[row.dataset.permission]);
    row.dataset.granted = String(granted === true);
    const button = row.querySelector("button");
    button.replaceChildren(
      ...(granted ? [svg("i-check"), t("onboarding.permissions.on")] : [t("onboarding.permissions.allow")]),
    );
    button.classList.toggle("primary", granted !== true);
    button.disabled = granted === true;
  }

  const keycap = keycapOf(setup.hotkey.value);
  $("big-keycap").textContent = keycap;
  $("hotkey-select").replaceChildren(
    ...setup.hotkey.choices.map((id) => new Option(t(`hotkeys.${id}.name`), id, false, id === setup.hotkey.value)),
  );
  $("try-text").placeholder = t("onboarding.try.placeholder", { keycap });

  // At the bottom: Back (not on the first step), Skip onboarding, Continue. Once the step is done "Continue" is primary; otherwise secondary (still allowed)
  $("back").hidden = step === STEPS[0];
  $("skip-all").hidden = step === "done";
  const next = $("next");
  next.hidden = step === "done";
  const done = stepDone(step, { setup, said: $("try-text").value.trim() !== "" });
  next.classList.toggle("primary", done);
}

// ---------- Microphone test ----------

let meter = null;
let stream = null;
/** Which microphone opening this is. Incremented on every entry and exit of this step; a microphone returning with a stale number is outdated */
let meterRun = 0;

async function startMeter() {
  const run = ++meterRun;
  $("microphone-error").hidden = true;
  const bars = METER_BARS.map(() => document.createElement("span"));
  $("meter").replaceChildren(...bars);
  let opened;
  try {
    opened = await openMicrophone();
  } catch (error) {
    if (run !== meterRun) return;
    $("microphone-error").textContent = t("onboarding.microphone.error", { reason: describeError(error) });
    $("microphone-error").hidden = false;
    return;
  }
  // During this short wait for the microphone people may have left, or even come back: that visit has its own run, so close this one
  if (run !== meterRun) {
    for (const track of opened.getTracks()) track.stop();
    return;
  }
  stream = opened;
  meter = meterLevels(stream, (level) => {
    // Speech usually reaches only 10 to 20 percent of full scale, so amplify a little to show movement
    const loud = Math.min(1, level * 4);
    bars.forEach((bar, index) => {
      bar.style.height = `${0.75 + loud * METER_BARS[index] * 7}rem`;
    });
  });
}

function stopMeter() {
  meterRun += 1;
  meter?.stop();
  meter = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}

// ---------- User actions ----------

for (const button of document.querySelectorAll("[data-group]")) {
  button.addEventListener("click", () => go(firstStepOf(button.dataset.group)));
}
$("back").addEventListener("click", () => goBy(-1));
$("next").addEventListener("click", () => goBy(1));
$("skip-all").addEventListener("click", () => window.whisprflow.finishOnboarding());
$("finish").addEventListener("click", () => window.whisprflow.finishOnboarding());

for (const row of document.querySelectorAll("[data-permission]")) {
  row
    .querySelector("button")
    .addEventListener("click", () => window.whisprflow.openPrivacySettings(row.dataset.permission));
}

$("microphone-yes").addEventListener("click", () => goBy(1));
$("microphone-no").addEventListener("click", () => {
  $("microphone-help").hidden = false;
});
$("microphone-settings").addEventListener("click", () => window.whisprflow.openPrivacySettings("microphone"));

$("hotkey-yes").addEventListener("click", () => goBy(1));
$("hotkey-no").addEventListener("click", () => {
  $("hotkey-choice").hidden = false;
  $("hotkey-select").focus();
});
$("hotkey-select").addEventListener("change", async (event) => {
  $("hotkey-note").hidden = true;
  try {
    const result = await window.whisprflow.setHotkey(event.target.value);
    $("hotkey-note").textContent = result.note ? t.text(result.note) : t("onboarding.hotkey.switched");
  } catch (error) {
    $("hotkey-note").textContent = t("onboarding.hotkey.failed", { reason: describeError(error) });
  }
  $("hotkey-note").hidden = false;
  await refresh();
});

// What was said got pasted into the notes: "Continue" becomes the primary button
$("try-text").addEventListener("input", render);

// ---------- From the main process ----------

window.whisprflow.onSetupChanged(refresh);
window.whisprflow.onOnboardingHotkey(({ down }) => {
  if (down) $("big-keycap").dataset.pressed = "";
  else delete $("big-keycap").dataset.pressed;
});

await refresh();
go(startStep(setup));
