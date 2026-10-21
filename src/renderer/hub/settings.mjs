import { LOCALES, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError, keyMissing, permissionDenied, permissionText } from "../shared/setup-text.mjs";

// The settings dialog, with a menu down the left. Four pages: General (hotkey, theme, language, on-device model download source, launch at login),
// Dictionary (preferred spellings), Permissions, and About.
// Recognition mode, models, and keys aren't here: they are on the sidebar's "Models" page (models.mjs).
// All state lives in the main process; this only draws it and relays the user's actions.

const $ = (id) => document.getElementById(id);

const PANES = ["general", "dictionary", "permissions", "about"];

/**
 * Where to fill in what is missing: keys in the key table on the sidebar's "Models" page, everything else on the settings' Permissions page (a stopped helper too; rechecking is there);
 * when both are missing, the key comes first
 * @returns {{ route: "models", tab: "keys" } | { pane: string }}
 */
export function fixTarget(setup) {
  if (keyMissing(setup)) return { route: "models", tab: "keys" };
  return { pane: permissionDenied(setup) || setup.helper === "stopped" ? "permissions" : "general" };
}

/**
 * @param {{ refresh: () => Promise<object> }} options refresh: asks the main process for a fresh status, and the whole window updates
 */
export function createSettings({ refresh }) {
  const dialog = $("settings");

  function showPane(pane) {
    const name = PANES.includes(pane) ? pane : "general";
    // Read it fresh each time: cleanup may have learned terms since, or the file was edited by hand
    if (name === "dictionary") loadDictionary();
    for (const section of dialog.querySelectorAll(".pane")) section.hidden = section.dataset.pane !== name;
    for (const item of dialog.querySelectorAll(".menu-item")) {
      if (item.dataset.pane === name) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
  }

  // ---------- General: hotkey, theme, language, launch at login ----------

  /** A group of options: [value, label], with the current one selected */
  const options = (choices, current) =>
    choices.map(([value, label]) => new Option(label, value, false, value === current));

  function renderGeneral(setup) {
    $("hotkey").replaceChildren(
      ...options(
        setup.hotkey.choices.map((id) => [id, t(`hotkeys.${id}.name`)]),
        setup.hotkey.value,
      ),
    );
    $("theme").replaceChildren(
      ...options(
        setup.theme.choices.map((id) => [id, t(`themes.${id}.name`)]),
        setup.theme.value,
      ),
    );
    // Follow the system, then each language (named in its own language)
    $("language").replaceChildren(
      ...options(
        [[SYSTEM_LOCALE, t("language.system")], ...LOCALES.map(({ id, name }) => [id, name])],
        setup.language.value,
      ),
    );
    $("model-source").replaceChildren(
      ...options(
        setup.local.source.choices.map((id) => [id, t(`modelSources.${id}`)]),
        setup.local.source.value,
      ),
    );
    $("acceleration").replaceChildren(
      ...options(
        setup.local.acceleration.choices.map((id) => [id, t(`accelerations.${id}`)]),
        setup.local.acceleration.value,
      ),
    );
    $("bar-hint").checked = setup.barHint === "on";
    $("open-at-login").checked = setup.openAtLogin.enabled;
    $("open-at-login-row").hidden = !setup.openAtLogin.supported;
  }

  function showNote(id, message, tone = "") {
    $(id).textContent = t.text(message);
    $(id).dataset.tone = tone;
    $(id).hidden = !message;
  }

  $("hotkey").addEventListener("change", async (event) => {
    showNote("hotkey-note", null);
    try {
      const result = await window.whisprflow.setHotkey(event.target.value);
      showNote("hotkey-note", result.note ?? null);
    } catch (error) {
      showNote("hotkey-note", t("preferences.hotkeyFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("theme").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("theme-note", null);
    try {
      const result = await window.whisprflow.setTheme(event.target.value);
      showNote("theme-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.themeFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // Language changed: the main process reloads this window in the new language and returns to this page; when an environment variable overrides it, the language stays and a note says so here
  $("language").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("language-note", null);
    try {
      const result = await window.whisprflow.setLanguage(event.target.value);
      showNote("language-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.languageFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("model-source").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("source-note", null);
    try {
      const result = await window.whisprflow.setModelSource(event.target.value);
      showNote("source-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.sourceFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("acceleration").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("acceleration-note", null);
    try {
      const result = await window.whisprflow.setAcceleration(event.target.value);
      showNote("acceleration-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.accelerationFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("bar-hint").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    showNote("bar-hint-note", null);
    try {
      const result = await window.whisprflow.setBarHint(event.target.checked ? "on" : "off");
      showNote("bar-hint-note", result.note ?? null);
    } catch (error) {
      showNote("general-problem", t("preferences.barHintFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  $("open-at-login").addEventListener("change", async (event) => {
    showNote("general-problem", null);
    try {
      await window.whisprflow.setOpenAtLogin(event.target.checked);
    } catch (error) {
      showNote("general-problem", t("preferences.loginFailed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // ---------- Dictionary ----------

  const terms = $("dictionary-terms");
  const linesOf = (text) => text.split("\n");

  function showDictionary({ terms: list, max }, note = null) {
    terms.value = list.join("\n");
    const count = t("dictionary.count", { count: list.length });
    const status = list.length >= max ? t("dictionary.learningPaused", { count: list.length, max }) : count;
    showNote("dictionary-status", note ? `${note} · ${status}` : status);
  }

  async function loadDictionary() {
    try {
      showDictionary(await window.whisprflow.getDictionary());
    } catch (error) {
      showNote("dictionary-status", t("dictionary.saveFailed", { reason: describeError(error) }), "problem");
    }
  }

  $("dictionary-save").addEventListener("click", async () => {
    try {
      const saved = await window.whisprflow.setDictionary(linesOf(terms.value));
      const { max } = await window.whisprflow.getDictionary();
      showDictionary({ terms: saved, max }, t("dictionary.saved"));
    } catch (error) {
      showNote("dictionary-status", t("dictionary.saveFailed", { reason: describeError(error) }), "problem");
    }
  });

  // ---------- Permissions ----------

  function renderPermissions(setup) {
    for (const row of dialog.querySelectorAll("[data-permission]")) {
      const name = row.dataset.permission;
      const [label, tone, action] = permissionText(name, setup.permissions[name], t);
      const granted = row.querySelector(".granted");
      granted.textContent = label;
      granted.dataset.tone = tone;
      row.querySelector("button").textContent = action;
    }
  }

  for (const row of dialog.querySelectorAll("[data-permission]")) {
    row
      .querySelector("button")
      .addEventListener("click", () => window.whisprflow.openPrivacySettings(row.dataset.permission));
  }
  $("recheck").addEventListener("click", () => window.whisprflow.recheckPermissions());

  // ---------- About ----------

  $("open-homepage").addEventListener("click", () => window.whisprflow.openHomepage());

  // ---------- The dialog itself ----------

  for (const item of dialog.querySelectorAll(".menu-item")) {
    item.addEventListener("click", () => showPane(item.dataset.pane));
  }
  $("settings-close").addEventListener("click", () => dialog.close());
  // Clicking the dim backdrop outside the dialog closes it too
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });

  return {
    /** @param {string} [pane] which page to open */
    open(pane = "general") {
      showPane(pane);
      if (!dialog.open) dialog.showModal();
      // The dialog focuses its first control on opening; the page being shown is the one that should hold focus
      dialog.querySelector('.menu-item[aria-current="true"]')?.focus();
    },

    render(setup) {
      renderGeneral(setup);
      renderPermissions(setup);
      $("about-version").textContent = `v${setup.version}`;
      $("about-home").textContent = setup.home;
      // A red dot on the menu: this page has something to fill in
      const flagged = { permissions: permissionDenied(setup) };
      for (const dot of dialog.querySelectorAll(".menu-dot")) dot.hidden = !flagged[dot.dataset.for];
    },
  };
}
