// "How to use it" in onboarding: which recognition mode, which provider within it, which on-device model, what is missing, and which settings come along when switching.
// Pure functions that never touch the page; all data comes from getSetup.
// Clicking a mode or provider in onboarding switches at once (switchMode in app/modes.mjs doesn't verify keys or wait for downloads), so the plan is the current settings;
// what is missing (a key, a model download) is stated honestly, and it works once filled in.
// Onboarding only offers the most common setups: native with one audio provider, transcribe + polish as an on-device model plus one polish provider, private with only an on-device model.
// Freer setups like cloud transcription and custom services live on the main window's model page: onboarding shows them honestly and leaves them alone unless the user clicks something else.

export const WAYS = ["native", "local", "private"];

const vendorOf = (choice) => choice.split("/")[0];

/** The providers to pick from in a mode: audio ones for native, polish ones for transcribe + polish (custom services need an address and model name, left to the model page) */
export function vendorsFor(setup, mode) {
  if (mode === "native") return setup.native.providers;
  if (mode === "local") return setup.local.vendors.filter(({ id }) => id !== "custom");
  return [];
}

/** The current plan: from the current settings. When polish uses a custom service it is custom (onboarding doesn't list it; clicking another provider switches) */
export function planOf(setup) {
  return { mode: setup.mode.value, native: vendorOf(setup.native.model), polish: vendorOf(setup.local.polish) };
}

/**
 * Which on-device model transcribe + polish and private use. For the mode in use: the one in the settings, downloaded or not.
 * When switching: the one in the settings if downloaded; otherwise that mode's model from this machine's presets (models/presets.mjs, already chosen per chip);
 * failing both, the settings
 */
export function localModelOf(setup, mode) {
  const models = setup.local.transcribers;
  const current = mode === "private" ? setup.private.transcriber : setup.local.transcriber;
  const find = (id) => models.find((model) => model.id === id);
  if (mode === setup.mode.value && find(current)) return current;
  if (find(current)?.installed) return current;
  const recommended = setup.plaza.presets
    .filter((preset) => preset.mode === mode)
    .map(({ settings }) => settings.transcriber ?? settings.privateTranscriber)
    .find((id) => find(id));
  if (recommended) return recommended;
  // When the settings use cloud transcription (step one of transcribe + polish can), there is no on-device model to follow: use the first in the catalog
  return find(current) ? current : models[0].id;
}

/** Whether a provider has a usable key. When the service holds its key, go by that key's state: rejected or unreadable counts as none */
export function hasKey(setup, mode, id) {
  if (id === setup.provider?.id) return setup.key.state === "ready" || setup.key.state === "checking";
  return vendorsFor(setup, mode).find((vendor) => vendor.id === id)?.key != null;
}

/**
 * What this set still needs before it works: [{ kind: "download", model, downloading }, { kind: "key", vendor }, { kind: "url" }]; empty when nothing.
 * Based on what the main process computed from the settings (ways in app/model-plaza.mjs: correct for cloud step one and custom services),
 * plus, for the mode in use, a stored key that failed or can't be read (the main process only checks whether one exists)
 */
export function needsOf(plan, setup) {
  const transcriber = (id) => setup.local.transcribers.find((model) => model.id === id);
  const needs = (setup.plaza.ways[plan.mode]?.needs ?? []).map((need) => {
    if (need.kind === "key") return { kind: "key", vendor: need.platform };
    if (need.kind === "download") {
      return { kind: "download", model: need.model, downloading: Boolean(transcriber(need.model)?.download) };
    }
    return need;
  });
  const vendor = setup.key.vendor?.id ?? setup.provider?.id;
  const broken = setup.key.state === "rejected" || setup.key.state === "unreadable";
  if (plan.mode === setup.mode.value && broken && vendor && !needs.some((need) => need.vendor === vendor)) {
    needs.push({ kind: "key", vendor });
  }
  return needs;
}

/**
 * Which of that mode's settings come along when switching (what switchMode in app/modes.mjs takes).
 * None when the choice is the provider already in the settings: a model may already be chosen for it, so don't switch back to the default.
 * Switching provider within this mode: only the changed provider comes along, step one stays (it may be cloud transcription set on the model page)
 */
export function changesOf(plan, setup) {
  if (plan.mode === "native") return plan.native === vendorOf(setup.native.model) ? {} : { model: plan.native };
  if (plan.mode === setup.mode.value) {
    return plan.mode === "local" && plan.polish !== vendorOf(setup.local.polish) ? { polish: plan.polish } : {};
  }
  if (plan.mode === "local") {
    return {
      transcriber: localModelOf(setup, "local"),
      ...(plan.polish === vendorOf(setup.local.polish) ? {} : { polish: plan.polish }),
    };
  }
  return { privateTranscriber: localModelOf(setup, "private") };
}

/** The set in use is already this one */
export function inEffect(plan, setup) {
  if (setup.mode.value !== plan.mode) return false;
  const current = {
    model: setup.native.model,
    transcriber: setup.local.transcriber,
    polish: setup.local.polish,
    privateTranscriber: setup.private.transcriber,
  };
  return Object.entries(changesOf(plan, setup)).every(([name, value]) => current[name] === value);
}

/**
 * Whether pressing the hotkey works now (for the try-it and done steps): null if it does; otherwise { tone, needs, problem? }.
 * A stored key that failed or can't be read is reported first with its reason; then what is missing (needsOf): only a downloading model is progress, anything else is a problem;
 * nothing missing but a key still verifying or the on-device model still loading is progress; an on-device model that failed to load comes with its reason
 */
export function readinessOf(setup) {
  const needs = needsOf(planOf(setup), setup);
  // Stored but failed or unreadable: say the reason (invalid key, wrong model name), which is more precise than "missing key"
  if (setup.key.state === "rejected" || setup.key.state === "unreadable") {
    return { tone: "problem", needs, problem: setup.key.problem };
  }
  if (needs.length > 0) {
    const downloading = needs.every((need) => need.kind === "download" && need.downloading);
    return { tone: downloading ? "progress" : "problem", needs };
  }
  if (setup.key.state === "checking" || setup.localModel?.state === "loading") return { tone: "progress", needs };
  if (setup.localModel?.state === "failed") return { tone: "problem", needs, problem: setup.localModel.problem };
  return null;
}
