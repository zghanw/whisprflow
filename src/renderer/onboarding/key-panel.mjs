import { h, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";
import { describeError } from "../shared/setup-text.mjs";

// The part of onboarding's "Prepare" step that picks a provider and takes its key. Each panel covers one mode's providers (native audio ones, or the polish ones in transcribe + polish).
// One provider per row (rows line up however many there are, no wrapping into columns); the selected row expands in place, with key entry and checks inside it, styled like the main window's key table.
// Which provider is onboarding's plan (plan.mjs); this only draws it and relays which provider was clicked. Whether to switch is decided by onboarding from what is missing, not here.
// All state lives in the main process; keys only travel once from here to the main process and never come back to the page.
// While a model downloads the status changes several times a second: rows and inputs are built once and afterwards only text and attributes change, so typing and focus are never lost.

/**
 * The service doesn't hold its key: only a key from an environment variable needs a note (the main process reports only the source, never decrypts).
 * Whether it is set up is already in the row header, so the expanded row doesn't repeat it: null
 */
function otherKeyText(vendor) {
  return vendor.key === "env" ? [t("keyPanel.other.env", { variable: vendor.keyEnv }), "ok"] : null;
}

/** The service holds its key: describe that key's state. Rows not set up already say so in the header: null */
function keyText(key, vendor) {
  // Unreachable at start, so it is used anyway, saying honestly it isn't verified yet
  const unverified = key.verified === false;
  const named = { variable: vendor.keyEnv, provider: vendor.name, problem: key.problem };
  switch (key.state) {
    case "ready":
      if (key.source === "env")
        return [t(unverified ? "keyPanel.state.envUnverified" : "keyPanel.state.env", named), "ok"];
      if (key.source === "external") return [t("keyPanel.state.external"), "ok"];
      return unverified ? [t("keyPanel.state.savedUnverified", named), "pending"] : [t("keyPanel.state.saved"), "ok"];
    case "checking":
      return [t("keyPanel.state.checking"), "pending"];
    case "rejected":
      // The three cases need different actions: only the last is fixed by entering another key below
      if (key.cause === "other") return [t("keyPanel.state.checkFailed", named), "problem"];
      if (key.source === "env") return [t("keyPanel.state.envRejected", named), "problem"];
      return [t("keyPanel.state.rejected", named), "problem"];
    case "unreadable":
      return [t.text(key.problem), "problem"];
    default:
      return null;
  }
}

/**
 * Puts this panel into container.
 * @param {HTMLElement} container
 * @param {object} options
 * @param {"native" | "local"} options.mode which mode's providers; checks use this mode
 * @param {string} options.label what screen readers call this group
 * @param {(setup: object) => object[]} options.vendors which providers to list (vendorsFor in plan.mjs)
 * @param {(setup: object, id: string) => boolean} options.hasKey whether this provider has a usable key (hasKey in plan.mjs)
 * @param {() => string} options.picked which provider onboarding plans to use
 * @param {(id: string) => void} options.pick a provider was clicked
 * @param {(id: string) => object} options.checkChanges the settings that come along when checking this provider (not switched to yet)
 * @param {() => Promise<unknown>} options.refresh after saving or deleting, makes the whole window ask for the status again
 * @param {() => void} options.onSaved a key was saved (onboarding checks whether everything is there and switches if so)
 * @returns {{ render: (setup: object) => void }}
 */
export function createKeyPanel(
  container,
  { mode, label, vendors, hasKey, picked, pick, checkChanges, refresh, onSaved },
) {
  /** While saving, no double submits, and refreshes elsewhere can't re-enable the button */
  let saving = false;
  /** The latest status */
  let latest = null;
  /** "Replace" was clicked on a provider with a key: show the input. Hidden again on viewing another provider or once replaced */
  let replacing = false;
  /** Each provider's latest check: { tone, text, ticket }. ticket identifies the run, so an older result arriving after a newer check started is dropped */
  const checks = new Map();
  /** One row per provider: { row, head, state }, by id; rebuilt only when the providers change */
  const rows = new Map();

  // ---------- The expanded part: built once, moved under the selected row ----------

  const input = h("input", {
    type: "password",
    class: "key-input",
    autocomplete: "off",
    spellcheck: "false",
  });
  const pasteButton = h(
    "button",
    {
      type: "button",
      class: "icon-button paste-key",
      title: t("keyPanel.paste"),
      "aria-label": t("keyPanel.paste"),
      onclick: paste,
    },
    svg("i-clipboard-paste"),
  );
  const saveButton = h("button", { type: "submit", class: "button primary save-key", text: t("plaza.keys.save") });
  const form = h(
    "form",
    { class: "key-form", novalidate: true, onsubmit: save },
    h("label", { class: "key-field" }, svg("i-key-round"), input, pasteButton),
    saveButton,
  );
  const state = h("p", { class: "state" });
  const checkButton = h("button", {
    type: "button",
    class: "button small",
    text: t("keyPanel.check.button"),
    onclick: () => check(),
  });
  const checkResult = h("p", { class: "check-result", role: "status" });
  const keyProblem = h("p", { class: "callout key-problem", role: "alert" });
  const keyNote = h("p", { class: "hint key-note" });
  const keyPage = h(
    "button",
    { type: "button", class: "key-link", onclick: () => window.whisprflow.openKeyPage(picked()) },
    h("span", { text: t("plaza.keys.get") }),
    svg("i-external-link"),
  );
  const replaceButton = h("button", { type: "button", class: "key-link", onclick: toggleReplace });
  const forgetButton = h("button", {
    type: "button",
    class: "key-link",
    text: t("plaza.keys.remove"),
    onclick: forget,
  });
  const stateRow = h("div", { class: "key-state-row" }, state, checkButton);
  const body = h(
    "div",
    { class: "vendor-body" },
    stateRow,
    checkResult,
    form,
    keyProblem,
    keyNote,
    h("p", { class: "links" }, keyPage, replaceButton, forgetButton),
  );
  const list = h("div", { class: "vendor-list", role: "radiogroup", "aria-label": label });
  container.replaceChildren(list);

  /** Shows a sentence: a msg is translated into the interface language, plain text written as is; hidden when empty */
  const show = (node, message) => {
    node.textContent = t.text(message);
    node.hidden = !message;
  };
  show(keyProblem, null);
  show(keyNote, null);

  const nameOf = (id) => t(`providers.${id}.name`);

  /** Rebuilds the rows only when the providers change (a different mode) */
  function buildRows(ids) {
    if (ids.join() === [...rows.keys()].join()) return;
    rows.clear();
    list.replaceChildren(
      ...ids.map((id) => {
        const keyState = h("span", { class: "vendor-key" });
        const head = h(
          "button",
          {
            type: "button",
            class: "vendor-head",
            role: "radio",
            onclick: () => choose(id),
          },
          h("span", { class: "logo-tile" }, providerIcon(id) ?? svg("i-cloud")),
          h("span", { class: "vendor-name", text: nameOf(id) }),
          keyState,
          h("span", { class: "radio-mark" }, svg("i-check")),
        );
        const row = h("div", { class: "vendor" }, head);
        rows.set(id, { row, head, keyState });
        return row;
      }),
    );
  }

  function choose(id) {
    if (id === picked()) return;
    replacing = false;
    input.value = "";
    show(keyProblem, null);
    show(keyNote, null);
    pick(id);
    // A provider was picked: if it has a key, check right away whether it works now
    if (hasKey(latest, id)) check();
  }

  /** Checks the selected provider once: a minimal request with its key, without replacing what is in use */
  async function check() {
    const id = picked();
    const ticket = {};
    checks.set(id, { tone: "pending", text: t("keyPanel.check.running"), ticket });
    render(latest);
    let result;
    try {
      result = await window.whisprflow.checkModel(mode, checkChanges(id));
    } catch (error) {
      result = { ok: false, problem: t("keyPanel.failed", { reason: describeError(error) }) };
    }
    if (checks.get(id)?.ticket !== ticket) return;
    checks.set(
      id,
      result.ok
        ? { tone: "ok", text: t("keyPanel.check.ok"), ticket }
        : { tone: "problem", text: t("keyPanel.check.failed", { problem: t.text(result.problem) }), ticket },
    );
    render(latest);
  }

  function render(setup) {
    latest = setup;
    const all = vendors(setup);
    buildRows(all.map(({ id }) => id));
    const vendor = all.find(({ id }) => id === picked()) ?? all[0];
    const name = nameOf(vendor.id);
    // The service holds this provider's key (the mode in use needs it): describe that key's state; for others only say whether there is one
    const holding = vendor.id === setup.provider?.id;
    for (const [id, { row, head, keyState }] of rows) {
      const selected = id === vendor.id;
      head.setAttribute("aria-checked", String(selected));
      row.toggleAttribute("data-open", selected);
      const keyed = hasKey(setup, id);
      keyState.textContent = t(keyed ? "plaza.keys.stored" : "plaza.keys.none");
      keyState.dataset.tone = keyed ? "ok" : "";
    }
    // Only move on a provider change: moving makes the input lose focus
    const { row } = rows.get(vendor.id);
    if (body.parentNode !== row) row.append(body);

    input.setAttribute("aria-label", t("plaza.keys.label", { platform: name }));
    input.placeholder = t("plaza.keys.placeholder", { platform: name });
    keyPage.hidden = !vendor.hasKeyPage;
    // The row header already says whether it is set up: the expanded row only appears when there is more to say (rejected, verifying, from an environment variable)
    const said = holding ? keyText(setup.key, { ...vendor, name }) : otherKeyText(vendor);
    state.hidden = said === null;
    state.textContent = said?.[0] ?? "";
    state.dataset.tone = said?.[1] ?? "";
    // Keys from environment variables and external servers aren't managed here, so no "Delete"
    forgetButton.hidden = (holding ? setup.key.source : vendor.key) !== "stored";
    const editable = setup.key.source !== "external";
    // With a key, no input until "Replace" is clicked; without one, or with an unusable one, show it directly
    const keyed = hasKey(setup, vendor.id);
    form.hidden = !editable || (keyed && !replacing);
    replaceButton.hidden = !editable || !keyed;
    replaceButton.textContent = t(replacing ? "plaza.keys.cancel" : "plaza.keys.replace");
    input.disabled = !editable || saving;
    pasteButton.disabled = !editable || saving;
    saveButton.disabled = saving || !editable;
    // Checking needs a key; a key being verified at service start waits for that to finish
    const checked = checks.get(vendor.id);
    checkButton.hidden = !editable || !keyed;
    checkButton.disabled = saving || checked?.tone === "pending" || (holding && setup.key.state === "checking");
    checkResult.hidden = checkButton.hidden || !checked;
    stateRow.hidden = state.hidden && checkButton.hidden;
    checkResult.textContent = checked?.text ?? "";
    checkResult.dataset.tone = checked?.tone ?? "";
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const id = picked();
    const value = input.value;
    // The service holds this provider's key: switch it in at once; for others just save it (verified with its own default model)
    const holding = id === latest.provider?.id;
    saving = true;
    saveButton.replaceChildren(svg("i-loader-circle", "icon spin"), t("keyPanel.verifying"));
    show(keyProblem, null);
    show(keyNote, null);
    render(latest);
    try {
      const result = await (holding ? window.whisprflow.saveKey(value) : window.whisprflow.saveKey(value, id, {}));
      if (result.ok) {
        input.value = "";
        replacing = false;
        // The key changed: the earlier check was about the old one
        checks.delete(id);
        show(keyNote, result.note ?? null);
        onSaved();
      } else show(keyProblem, result.problem);
    } catch (error) {
      show(keyProblem, t("keyPanel.failed", { reason: describeError(error) }));
    } finally {
      saving = false;
      saveButton.replaceChildren(t("plaza.keys.save"));
      await refresh();
    }
  }

  async function paste() {
    const text = (await window.whisprflow.readClipboard()).trim();
    if (text === "") {
      show(keyProblem, t("keyPanel.clipboardEmpty"));
      return;
    }
    show(keyProblem, null);
    input.value = text;
    input.focus();
  }

  async function forget() {
    const id = picked();
    const inUse = id === latest.provider?.id;
    const question = t(inUse ? "keyPanel.confirmForgetInUse" : "keyPanel.confirmForget", { provider: nameOf(id) });
    if (!window.confirm(question)) return;
    await window.whisprflow.forgetKey(id);
    checks.delete(id);
    replacing = false;
    await refresh();
  }

  function toggleReplace() {
    replacing = !replacing;
    input.value = "";
    show(keyProblem, null);
    render(latest);
    if (replacing) input.focus();
  }

  return { render };
}
