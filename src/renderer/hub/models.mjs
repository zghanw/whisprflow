import { $, brand, h, named, platformName, progressBadge, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { createChecks } from "./checks.mjs";
import { slidingIndicators } from "./indicators.mjs";
import { toast } from "./toast.mjs";

// The sidebar's "Models" page: the model library, three shelves by role (native, transcription, polish) plus a key table; the presets right of the title are in preset-picker.mjs. Shelves are grouped by maker,
// and a group may be sold by several platforms, which are that group's channels. The recognition mode isn't chosen here but on Home (mode-picker.mjs):
// this changes the models each mode uses, and enabling a model from another mode switches the mode too (the line above the toolbar explains this first).
// The data is assembled by the main process (app/model-plaza.mjs, arriving with getSetup); this only draws and relays actions. Switching models and saving keys go through the main process:
// keys are verified before saving, models switch at once, and if the key then fails the top banner says so.
// Copy follows the app's word list.

/**
 * The shelves' three roles, mapped to their setting and recognition mode. Transcription exists in two modes: private uses its own setting
 * (privateTranscriber) and accepts on-device models only; see settingOf, modeFor
 */
const ROLES = {
  native: { setting: "native", mode: "native" },
  transcribe: { setting: "transcriber", mode: "local" },
  polish: { setting: "polish", mode: "local" },
};
const TABS = ["native", "transcribe", "polish", "keys"];

/** When a platform is a maker's own developer platform, its channel says "Official" */
const OFFICIAL = {
  gemini: "gemini",
  openai: "openai",
};

// ---------- Helpers ----------

const logoTile = (node) => h("span", { class: "logo-tile" }, node);

const makerName = (maker) => named(`plaza.makers.${maker}`, maker);

/** Prices are kept to cents: at most two decimals */
const amount = (value) => Math.round(value * 100) / 100;

/**
 * @param {object} options
 * @param {() => Promise<object>} options.refresh asks the main process for a fresh status, and the whole window updates
 * @param {() => void} options.pickMode goes back to Home and opens the recognition mode menu
 */
export function createModels({ refresh, pickMode }) {
  /** The latest status */
  let setup = null;
  const state = {
    tab: "native",
    maker: "all",
    onlyUsable: false,
    query: "",
    /** Which channel each group shows: group id to platform id. Groups never chosen are inferred by viaOf */
    via: {},
    /** The platform whose key form is open */
    openKey: null,
    /** The address and model name entered for the custom service this time (verified with the key when saving, handed over when enabling) */
    custom: { url: "", model: "" },
    /** The action waiting for the main process to reply, so buttons aren't clicked twice */
    busy: null,
    /** When "Set up key" on a shelf jumps to the key table, which category it came from: once the key is saved, go back and enable that row's model */
    returnTo: null,
  };

  const platformOf = (id) => setup.plaza.platforms.find((platform) => platform.id === id) ?? null;
  /** Platforms that take a key: those on this computer (Ollama) don't, and never appear in the key table */
  const keyedPlatforms = () => setup.plaza.platforms.filter(({ keyEnv }) => keyEnv !== null);
  const privateNow = () => setup.plaza.mode === "private";
  /** Which setting holds this role's current choice: in private mode transcription has its own */
  const settingOf = (role) => (role === "transcribe" && privateNow() ? "privateTranscriber" : ROLES[role].setting);
  const chosenOf = (role) => setup.plaza.chosen[settingOf(role)];
  /** Which recognition mode enabling this row needs: enabling an on-device model in private mode stays in it, others follow the role */
  const modeFor = (role, group) =>
    role === "transcribe" && privateNow() && group.kind === "local" ? "private" : ROLES[role].mode;
  /** Whether a platform can be used as far as keys go: it has one, or it runs on this computer and takes none (Ollama) */
  const hasKey = (id) => {
    const platform = platformOf(id);
    return platform?.keyEnv === null || Boolean(platform?.key);
  };
  const modeName = (mode) => t(`plaza.modes.${mode}`);

  // ---------- Channels, availability ----------

  /** The channel of the model this group is using */
  function chosenVia(role, group) {
    const chosen = chosenOf(role);
    for (const item of group.items) {
      for (const [via, offer] of Object.entries(item.offers ?? {})) if (offer.choice === chosen) return via;
    }
    return null;
  }

  /** Which channel this group shows: the chosen one, else the one in use, else one with a key, else the first */
  function viaOf(role, group) {
    if (group.kind !== "cloud") return group.channels[0];
    return state.via[group.id] ?? chosenVia(role, group) ?? group.channels.find(hasKey) ?? group.channels[0];
  }

  /** This row's entry on this channel ({ choice, price }); null when the channel doesn't sell it */
  const offerOf = (role, group, item) => (group.kind === "cloud" ? (item.offers[viaOf(role, group)] ?? null) : null);

  /** How this row is written into the settings: on-device models by id, cloud ones as provider/model */
  function choiceOf(role, group, item) {
    if (group.kind === "local") return item.choice;
    if (group.kind === "custom") return customChoice();
    return offerOf(role, group, item)?.choice ?? null;
  }

  function customChoice() {
    const chosen = setup.plaza.chosen.polish;
    if (state.custom.model) return `custom/${state.custom.model}`;
    return chosen.startsWith("custom/") ? chosen : null;
  }

  function usable(role, group, item) {
    if (group.kind === "local") return item.installed;
    if (group.kind === "custom") return hasKey("custom") && customChoice() !== null && customUrl() !== "";
    return hasKey(viaOf(role, group)) && offerOf(role, group, item) !== null;
  }

  const customUrl = () => state.custom.url || setup.plaza.chosen.customUrl;

  const isChosen = (role, group, item) => {
    const choice = choiceOf(role, group, item);
    return choice !== null && chosenOf(role) === choice;
  };
  /** Whether this role is in the current recognition mode: transcription counts in both transcribe + polish and private */
  const isLive = (role) => ROLES[role].mode === setup.plaza.mode || (role === "transcribe" && privateNow());

  // ---------- Checks: the same states (unchecked, checking, passed, failed), shared by models and keys (checks.mjs) ----------

  const checks = createChecks(() => draw());
  const statusControl = checks.control;
  const failNote = checks.note;

  /** An action failed: the failure note hangs under that row, with the reason the main process gave */
  function failed(key, problem, title = "plaza.actionFailed") {
    checks.results[key] = { state: "fail", problem, title };
  }

  // ---------- Actions in the main process ----------

  /** Sends something that waits for a reply: one at a time, rereading the status when it returns */
  async function act(key, call, { done } = {}) {
    if (state.busy) return;
    state.busy = key;
    delete checks.results[key];
    draw();
    let result;
    try {
      result = await call();
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    } finally {
      state.busy = null;
    }
    if (result?.ok === false) failed(key, result.problem);
    else done?.(result ?? {});
    await refresh();
    if (result?.note) toast(t.text(result.note));
  }

  /** Enables a model: within its recognition mode only the model changes; otherwise the mode changes too */
  function use(role, group, item, rowKey) {
    const choice = choiceOf(role, group, item);
    const mode = modeFor(role, group);
    const setting = mode === "private" ? "privateTranscriber" : ROLES[role].setting;
    const switching = setup.plaza.mode !== mode;
    const name = itemName(group, item);
    const customExtra = group.kind === "custom" ? { customUrl: customUrl() } : {};
    act(
      rowKey,
      () => {
        if (switching) {
          const changes = { [setting === "native" ? "model" : setting]: choice, ...customExtra };
          return window.whisprflow.setMode(mode, changes);
        }
        if (role === "native") return window.whisprflow.setModel(choice);
        if (role === "transcribe") return window.whisprflow.setTranscriber(choice);
        return window.whisprflow.setPolish(choice, customExtra.customUrl);
      },
      {
        done: () =>
          toast(
            switching
              ? t("plaza.toast.switchedWith", { mode: modeName(mode), model: name })
              : t("plaza.toast.enabled", { model: name }),
          ),
      },
    );
  }

  /** Checks a row: on-device models transcribe one spoken sentence; cloud ones send a minimal request with that row's settings */
  function checkCall(role, group, item) {
    if (group.kind === "local") return () => window.whisprflow.checkTranscriber(item.choice);
    const choice = choiceOf(role, group, item);
    if (role === "native") return () => window.whisprflow.checkModel("native", { model: choice });
    if (role === "transcribe") return () => window.whisprflow.checkModel("local", { transcriber: choice });
    const extra = group.kind === "custom" ? { customUrl: customUrl() } : {};
    return () => window.whisprflow.checkModel("local", { polish: choice, ...extra });
  }

  /** Checks a key: takes the platform's default model along the route it can take */
  function keyCheckCall(platform) {
    if (platform.id === "custom") {
      const choice = customChoice();
      return () => window.whisprflow.checkModel("local", { polish: choice, customUrl: customUrl() });
    }
    if (platform.coverage.polish > 0) return () => window.whisprflow.checkModel("local", { polish: platform.id });
    if (platform.coverage.native > 0) return () => window.whisprflow.checkModel("native", { model: platform.id });
    return () => window.whisprflow.checkModel("local", { transcriber: platform.id });
  }

  // ---------- Names ----------

  const viaText = (id) => (id === "local" ? t("plaza.via.local") : platformName(platformOf(id) ?? { id, name: id }));

  function itemName(group, item) {
    if (group.kind === "custom") return t("plaza.custom.name");
    return item.variant && group.kind === "local" ? `${item.name} · ${backendLabel(item)}` : item.name;
  }

  // ---------- Categories, filters ----------

  const shelfCount = (role) => setup.plaza.shelves[role].reduce((sum, group) => sum + group.items.length, 0);
  const keyCount = () => keyedPlatforms().filter(({ key }) => key).length;

  function renderTabs() {
    const icons = { native: "i-sparkles", transcribe: "i-audio-lines", polish: "i-wand-sparkles", keys: "i-key-round" };
    const counts = {
      native: String(shelfCount("native")),
      transcribe: String(shelfCount("transcribe")),
      polish: String(shelfCount("polish")),
      keys: `${keyCount()}/${keyedPlatforms().length}`,
    };
    $("plaza-tabs").replaceChildren(
      h("span", { class: "indicator", "aria-hidden": "true" }),
      ...TABS.map((id) =>
        h(
          "button",
          {
            type: "button",
            class: id === "keys" ? "tab end" : "tab",
            role: "tab",
            "aria-selected": String(state.tab === id),
            onclick: () => go(id),
          },
          svg(icons[id]),
          t(`plaza.tabs.${id}`),
          h("span", { class: "count", text: counts[id] }),
        ),
      ),
    );
  }

  function renderToolbar() {
    let lead = h("span");
    if (state.tab === "polish") {
      const groups = setup.plaza.shelves.polish.filter(({ kind }) => kind === "cloud");
      const pill = (id, text, icon, count) =>
        h(
          "button",
          {
            type: "button",
            class: "pill",
            "aria-pressed": String(state.maker === id),
            onclick: () => {
              state.maker = id;
              draw();
            },
          },
          icon,
          text,
          h("span", { class: "pill-count", text: String(count) }),
        );
      lead = h(
        "div",
        { class: "makers", role: "group", "aria-label": t("plaza.toolbar.makers") },
        pill("all", t("plaza.toolbar.all"), null, shelfCount("polish")),
        ...groups.map((group) => pill(group.id, makerName(group.id), brand(group.id), group.items.length)),
      );
    } else if (state.tab === "transcribe") {
      lead = h("p", { class: "toolbar-lead" }, h("i", { class: "best-dot" }), t("plaza.toolbar.best"));
    } else if (state.tab === "keys") {
      lead = h("p", { class: "toolbar-lead" }, svg("i-lock"), t("plaza.toolbar.keysLocal"));
    }
    const end =
      state.tab === "keys"
        ? h("span")
        : h(
            "div",
            { class: "toolbar-end" },
            state.tab !== "transcribe" && h("span", { class: "unit", text: t("plaza.toolbar.perMillion") }),
            h(
              "label",
              { class: "toggle" },
              t("plaza.toolbar.onlyUsable"),
              h("input", {
                type: "checkbox",
                class: "switch",
                checked: state.onlyUsable,
                onchange: (event) => {
                  state.onlyUsable = event.target.checked;
                  draw();
                },
              }),
            ),
          );
    $("plaza-toolbar").replaceChildren(lead, end);
    $("plaza-note").textContent =
      state.tab === "keys"
        ? t("plaza.notes.keys", { home: setup.home })
        : state.tab === "transcribe"
          ? t("plaza.notes.transcribe")
          : t("plaza.notes.prices");
  }

  /** This category isn't in the current recognition mode (cloud transcription in private mode counts too): enabling switches the mode as well, so say so first */
  function renderStandby() {
    const node = $("plaza-standby");
    const role = ROLES[state.tab];
    const cloudInPrivate = state.tab === "transcribe" && privateNow();
    node.hidden = !role || (isLive(state.tab) && !cloudInPrivate);
    if (node.hidden) return;
    const current = modeName(setup.plaza.mode);
    node.replaceChildren(
      svg("i-info"),
      h("span", {
        text: cloudInPrivate
          ? t("plaza.standby.privateCloud", { mode: modeName("local") })
          : t("plaza.standby.elsewhere", { current, mode: modeName(role.mode) }),
      }),
      h("button", { type: "button", class: "button ghost small", text: t("plaza.standby.pick"), onclick: pickMode }),
    );
  }

  /** Switches to a category and scrolls to the category tabs; doesn't scroll when about to scroll elsewhere (an opened key form) */
  function go(tab, { scroll = true } = {}) {
    state.tab = TABS.includes(tab) ? tab : "native";
    state.returnTo = null;
    state.maker = "all";
    draw();
    if (!scroll) return;
    const content = document.querySelector(".content");
    content.scrollTo({ top: $("plaza-tabs").offsetTop - 72, behavior: "smooth" });
  }

  /** A key form just opened: scroll it into view and put the cursor in the first field (the address for custom services, the key for others) */
  function focusKeyForm(id) {
    const first = $(`plaza-key-${id}`)?.closest(".key-form")?.querySelector(".input");
    if (!first) return;
    first.scrollIntoView({ block: "center", behavior: "smooth" });
    first.focus({ preventScroll: true });
  }

  // ---------- Model library ----------

  /** Data columns: one set per group, with the same columns aligned down the page */
  const PRICE_COLS = () => [
    { label: t("plaza.cols.input"), tip: t("plaza.cols.inputTip"), width: "4.5rem", field: "input" },
    { label: t("plaza.cols.output"), tip: t("plaza.cols.outputTip"), width: "4.5rem", field: "output" },
  ];
  const HOUR_COLS = () => [
    { label: t("plaza.cols.hour"), tip: t("plaza.cols.hourTip"), width: "4.5rem", field: "perHour" },
  ];
  // Scores from an internal benchmark: 97 real recordings on Apple silicon
  const SPEC_COLS = () => [
    { label: t("plaza.cols.zh"), tip: t("plaza.cols.zhTip"), width: "3.25rem", spec: "zh", better: "high", digits: 1 },
    {
      label: t("plaza.cols.mix"),
      tip: t("plaza.cols.mixTip"),
      width: "3.25rem",
      spec: "mix",
      better: "high",
      digits: 1,
    },
    {
      label: t("plaza.cols.minute"),
      tip: t("plaza.cols.minuteTip"),
      width: "3.5rem",
      spec: "minuteSeconds",
      better: "low",
      digits: 1,
      unit: t("plaza.units.seconds"),
    },
    {
      label: t("plaza.cols.memory"),
      tip: t("plaza.cols.memoryTip"),
      width: "3.5rem",
      spec: "memoryGB",
      better: "low",
      digits: 1,
      unit: "GB",
    },
    {
      label: t("plaza.cols.size"),
      tip: t("plaza.cols.sizeTip"),
      width: "3.5rem",
      spec: "sizeMB",
      better: "low",
      digits: 0,
      unit: "MB",
    },
  ];

  function colsOf(role, group) {
    if (group.kind === "local") return SPEC_COLS();
    if (group.kind === "custom") return [];
    return role === "transcribe" ? HOUR_COLS() : PRICE_COLS();
  }

  const backendLabel = (item) => t("plaza.build", { backend: t(`localModels.backends.${item.backend ?? "cpu"}`) });

  function tagNode(tag) {
    if (tag.kind === "issue") {
      return h("span", {
        class: "tag",
        "data-tone": "problem",
        title: t(`models.issues.${tag.issue}`),
        text: t("plaza.tags.issue"),
      });
    }
    // Unverified is neutral: gray, just stating the fact, not a problem
    const tone = { default: "accent", tested: "ok", unverified: null }[tag.kind];
    return h("span", {
      class: "tag",
      "data-tone": tone,
      title: t(`plaza.tags.${tag.kind}Tip`),
      text: t(`plaza.tags.${tag.kind}`),
    });
  }

  /** When this entry hasn't been called with a real key on the current channel, add an unverified tag (another channel may not need it) */
  const unverifiedTag = (role, group, item) => (offerOf(role, group, item)?.unverified ? [{ kind: "unverified" }] : []);

  /** The name cell: icon, name, tags; a description on the next line if there is one */
  function nameCell({ icon, tile, name, build, tags = [], desc, extra }) {
    return h(
      "div",
      { class: "cell-name", role: "cell" },
      tile ? logoTile(tile) : icon,
      h(
        "div",
        { class: "name-stack" },
        h(
          "div",
          { class: "name-line" },
          h("span", { class: "name", text: name }),
          (build || tags.length > 0 || extra) && h("span", { class: "name-tags" }, build, tags.map(tagNode), extra),
        ),
        desc && h("p", { class: "desc" }, desc),
      ),
    );
  }

  function metricCell(col, role, group, item) {
    if (col.spec) {
      const values = group.items.map((it) => it.specs?.[col.spec]).filter((value) => typeof value === "number");
      const value = item.specs?.[col.spec];
      if (typeof value !== "number")
        return h("span", { class: "cell-end metric-none", role: "cell", "data-label": col.label, text: "-" });
      const best = col.better === "high" ? Math.max(...values) : Math.min(...values);
      return h(
        "span",
        {
          class: "cell-end metric",
          role: "cell",
          "data-best": value === best,
          "data-label": col.label,
          title: col.tip,
        },
        h(
          "span",
          { class: "metric-line" },
          h("span", { class: "metric-value", text: value.toFixed(col.digits) }),
          col.unit && h("span", { class: "metric-unit", text: col.unit }),
        ),
      );
    }
    const offer = offerOf(role, group, item);
    const price = offer?.price;
    if (offer?.free)
      return h("span", { class: "cell-end metric", role: "cell", "data-label": col.label, text: t("plaza.cols.free") });
    if (!price || typeof price[col.field] !== "number") {
      return h("span", {
        class: "cell-end metric-none",
        role: "cell",
        "data-label": col.label,
        title: t("plaza.cols.noPrice"),
        text: "-",
      });
    }
    return h(
      "span",
      {
        class: "cell-end metric",
        role: "cell",
        "data-label": col.label,
        title: price.approx ? t("plaza.cols.hourApprox") : col.tip,
      },
      h(
        "span",
        { class: "metric-line" },
        h("span", { class: "metric-cur", text: `${price.approx ? "≈" : ""}$` }),
        h("span", { class: "metric-value", text: amount(price[col.field]).toFixed(decimalsOf(col, role, group)) }),
      ),
    );
  }

  /** Decimal places match within a column: the most decimals among this column's prices on the channel shown (at most two), applied to all */
  function decimalsOf(col, role, group) {
    let most = 0;
    for (const it of group.items) {
      const value = offerOf(role, group, it)?.price?.[col.field];
      if (typeof value !== "number") continue;
      const [, fraction = ""] = String(amount(value)).split(".");
      most = Math.max(most, fraction.length);
    }
    return most;
  }

  const rowKey = (role, group, item) => `${role}:${group.id}:${item.choice ?? item.name ?? "custom"}`;

  function statusFor(role, group, item) {
    const key = rowKey(role, group, item);
    if (group.kind === "local" && item.download) return progressBadge(item.download);
    if (!usable(role, group, item)) return h("span", { "aria-hidden": "true" });
    const tip = group.kind === "local" ? t("plaza.check.localTip") : t("plaza.check.modelTip");
    return statusControl(key, tip, checkCall(role, group, item));
  }

  function actionFor(role, group, item) {
    const key = rowKey(role, group, item);
    const busy = state.busy === key;
    if (isChosen(role, group, item)) {
      return isLive(role)
        ? h("span", { class: "state-box block", "data-tone": "accent" }, svg("i-check"), t("plaza.inUse"))
        : h(
            "span",
            {
              class: "state-box block",
              "data-tone": "standby",
              title: t("plaza.chosenTip", { mode: modeName(ROLES[role].mode) }),
            },
            t("plaza.chosen"),
          );
    }
    if (group.kind === "local" && !item.installed) {
      return item.download
        ? h("button", {
            type: "button",
            class: "button ghost block",
            text: t("plaza.actions.cancel"),
            onclick: () =>
              act(key, () => window.whisprflow.cancelDownload(item.choice), {
                done: () => toast(t("plaza.toast.canceled")),
              }),
          })
        : h(
            "button",
            {
              type: "button",
              class: "button block",
              disabled: busy,
              onclick: () => act(key, () => window.whisprflow.downloadModel(item.choice)),
            },
            svg("i-download"),
            t("plaza.actions.download"),
          );
    }
    if (!usable(role, group, item) || !setup.switchable) {
      return h("button", {
        type: "button",
        class: "button block",
        disabled: true,
        title: t("plaza.actions.needKey"),
        text: t("plaza.actions.use"),
      });
    }
    return h("button", {
      type: "button",
      class: "button block",
      disabled: busy,
      text: t("plaza.actions.use"),
      onclick: () => use(role, group, item, key),
    });
  }

  /** Channels: a segmented control when several platforms sell the same model; a check means that platform has a key set up */
  function channelControl(role, group) {
    if (group.kind !== "cloud") return null;
    const via = viaOf(role, group);
    const single = group.channels.length === 1;
    const nameOf = (id) => {
      const official = OFFICIAL[id] === group.id;
      const platform = platformName(platformOf(id) ?? { id, name: id });
      if (!official) return platform;
      return single ? t("plaza.channel.officialOf", { platform }) : t("plaza.channel.official");
    };
    const labelId = `channel-${role}-${group.id}`;
    return h(
      "div",
      { class: "channel" },
      h("span", { class: "channel-label", id: labelId, text: t("plaza.channel.label") }),
      h(
        "div",
        {
          class: "segmented",
          role: "radiogroup",
          "aria-labelledby": labelId,
          "data-indicator": `seg-${role}-${group.id}`,
          "data-single": single,
        },
        h("span", { class: "indicator", "aria-hidden": "true" }),
        ...group.channels.map((id) =>
          h(
            "button",
            {
              type: "button",
              class: "segment",
              role: "radio",
              "aria-checked": String(via === id),
              "aria-disabled": single ? "true" : null,
              title: `${platformName(platformOf(id) ?? { id, name: id })} · ${t(hasKey(id) ? "plaza.channel.keyed" : "plaza.channel.noKey")}`,
              onclick: single
                ? null
                : () => {
                    state.via[group.id] = id;
                    draw();
                  },
            },
            brand(id),
            nameOf(id),
            hasKey(id) && svg("i-check", "icon key-mark"),
          ),
        ),
      ),
    );
  }

  /** No key for the group's channel: a line of explanation under the header, with the button in the action column */
  function keyNotice(role, group) {
    if (group.kind === "local") return null;
    const via = group.kind === "custom" ? "custom" : viaOf(role, group);
    if (hasKey(via) && (group.kind !== "custom" || usable(role, group, group.items[0]))) return null;
    const platform = platformOf(via);
    const custom = via === "custom";
    return h(
      "div",
      { class: "row row-notice", role: "row" },
      h(
        "p",
        { class: "notice-text", role: "cell" },
        svg("i-key-round"),
        h(
          "span",
          {},
          h("b", { text: platformName(platform) }),
          ` · ${t(custom ? "plaza.notice.custom" : "plaza.notice.noKey")}`,
        ),
      ),
      h(
        "div",
        { class: "cell-fill", role: "cell" },
        h("button", {
          type: "button",
          class: "button block",
          text: t(custom ? "plaza.actions.configure" : "plaza.actions.configureKey"),
          onclick: () => {
            state.openKey = via;
            const from = state.tab;
            go("keys", { scroll: false });
            state.returnTo = from;
            focusKeyForm(via);
          },
        }),
      ),
    );
  }

  function table(cols, first, rows, { dense = false } = {}) {
    const head = h(
      "div",
      { class: "row row-head", role: "row" },
      h("span", { role: "columnheader", text: first }),
      h(
        "span",
        { class: "metrics" },
        cols.map((col) =>
          h("span", { class: col.start ? null : "cell-end", role: "columnheader", title: col.tip, text: col.label }),
        ),
      ),
      h("span", { class: "head-status", role: "columnheader", text: t("plaza.cols.status") }),
      h("span", { role: "columnheader" }, h("span", { class: "visually-hidden", text: t("plaza.cols.action") })),
    );
    return h(
      "div",
      {
        class: "table",
        role: "table",
        "data-dense": dense,
        style: cols.length ? `--metric-cols: ${cols.map((c) => c.width).join(" ")}` : null,
      },
      head,
      rows,
    );
  }

  function modelRow(role, group, item) {
    const key = rowKey(role, group, item);
    const local = group.kind === "local";
    const removable = local && item.installed && !isChosen(role, group, item) && !item.download;
    const remove =
      removable &&
      h(
        "button",
        {
          type: "button",
          class: "icon-button remove",
          title: t("plaza.actions.remove"),
          "aria-label": t("plaza.actions.removeModel", { model: itemName(group, item) }),
          onclick: () =>
            act(key, () => window.whisprflow.deleteModel(item.choice), {
              done: () => toast(t("plaza.toast.removed", { model: itemName(group, item) })),
            }),
        },
        svg("i-trash"),
      );
    const fields = local
      ? {
          icon: brand(item.maker),
          name: item.name,
          build:
            item.backend &&
            h("span", {
              class: "tag",
              "data-tone": "outline",
              title: t("plaza.buildTip", { variant: item.variant }),
              text: backendLabel(item),
            }),
          tags: item.tags,
          extra: remove,
        }
      : group.kind === "custom"
        ? { icon: brand("custom"), name: t("plaza.custom.name"), desc: customDesc() }
        : { icon: brand(group.id), name: item.name, tags: [...item.tags, ...unverifiedTag(role, group, item)] };
    return h(
      "div",
      { class: "row", role: "row", "data-current": isChosen(role, group, item) },
      nameCell(fields),
      h(
        "span",
        { class: "metrics" },
        colsOf(role, group).map((col) => metricCell(col, role, group, item)),
      ),
      h("div", { class: "cell-fill cell-status", role: "cell" }, statusFor(role, group, item)),
      h("div", { class: "cell-fill", role: "cell" }, actionFor(role, group, item)),
      failNote(key),
      local &&
        item.problem &&
        h("p", { class: "callout", role: "alert" }, svg("i-circle-alert"), h("span", {}, t.text(item.problem))),
    );
  }

  function customDesc() {
    const choice = customChoice();
    if (choice && customUrl()) return `${choice.slice("custom/".length)} · ${hostOf(customUrl())}`;
    return t("plaza.custom.desc");
  }

  /** The address's host name. The address may be unverified or wrong (missing https://): if it can't be parsed, show it as typed rather than failing to draw the page */
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function groupHead(role, group, count) {
    const local = group.kind === "local";
    const custom = group.kind === "custom";
    let meta = null;
    if (local) {
      const done = group.items.filter(({ installed }) => installed).length;
      const known = Number.isFinite(group.freeBytes);
      meta = t(known ? "plaza.groups.localMetaFree" : "plaza.groups.localMeta", {
        done: String(done),
        total: String(group.items.length),
        free: known ? `${Math.round(group.freeBytes / 1e9)} GB` : "",
      });
    } else if (role === "transcribe" && !custom) {
      meta = t("plaza.facts.upload", { platform: viaText(viaOf(role, group)) });
    } else if (custom) {
      meta = t("plaza.custom.meta");
    }
    const icon = local ? svg("i-laptop") : brand(custom ? "custom" : group.id);
    const name = local ? t("plaza.groups.local") : custom ? t("plaza.groups.custom") : makerName(group.id);
    return h(
      "header",
      { class: "group-head" },
      logoTile(icon),
      h(
        "div",
        { class: "group-titles" },
        h(
          "div",
          { class: "group-title-line" },
          h("h3", { class: "group-name", text: name }),
          h("span", { class: "group-count", text: String(count) }),
        ),
        meta && h("p", { class: "group-meta", text: meta }),
      ),
      channelControl(role, group),
    );
  }

  function matches(group, item, query) {
    if (!query) return true;
    const text = `${item.name ?? t("plaza.custom.name")} ${item.choice ?? ""} ${Object.values(item.offers ?? {})
      .map(({ choice }) => choice)
      .join(" ")} ${makerName(group.id)}`;
    return text.toLowerCase().includes(query);
  }

  function renderGroups() {
    const root = $("plaza-groups");
    if (state.tab === "keys") return renderKeys(root);
    const role = state.tab;
    const query = state.query.trim().toLowerCase();
    const sections = setup.plaza.shelves[role]
      .filter((group) => role !== "polish" || state.maker === "all" || state.maker === group.id)
      .map((group) => {
        const items = group.items.filter(
          (item) => (!state.onlyUsable || usable(role, group, item)) && matches(group, item, query),
        );
        if (items.length === 0) return null;
        return h(
          "section",
          { class: "group", "aria-label": group.kind === "local" ? t("plaza.groups.local") : makerName(group.id) },
          groupHead(role, group, items.length),
          table(
            colsOf(role, group),
            t("plaza.cols.model"),
            [keyNotice(role, group), ...items.map((item) => modelRow(role, group, item))],
            {
              dense: group.kind === "local",
            },
          ),
        );
      })
      .filter(Boolean);
    if (sections.length > 0) {
      root.replaceChildren(...sections);
      return;
    }
    const filters = [
      query && t("plaza.empty.search", { query: state.query.trim() }),
      state.onlyUsable && t("plaza.toolbar.onlyUsable"),
    ]
      .filter(Boolean)
      .join(" · ");
    root.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("p", { class: "empty-title", text: t("plaza.empty.title") }),
        h("p", { class: "empty-meta", text: filters }),
        h("button", { type: "button", class: "button", text: t("plaza.empty.clear"), onclick: clearFilters }),
      ),
    );
  }

  function clearFilters() {
    state.query = "";
    state.onlyUsable = false;
    state.maker = "all";
    $("plaza-search").value = "";
    draw();
  }

  // ---------- Keys ----------

  function coverage(platform) {
    if (platform.id === "custom") return t("plaza.custom.desc");
    const parts = ["native", "transcribe", "polish"]
      .filter((role) => platform.coverage[role] > 0)
      .map((role) => [t(`plaza.tabs.${role}`), platform.coverage[role]]);
    return [
      `${t("plaza.keys.coverage")} `,
      ...parts.flatMap(([text, count], index) => [index > 0 ? " · " : "", `${text} `, h("b", { text: String(count) })]),
    ];
  }

  function keyValue(platform) {
    if (platform.key === "env") return t("plaza.keys.env");
    if (platform.key === "stored") return t("plaza.keys.stored");
    return t("plaza.keys.none");
  }

  /** How many models this key unlocks (sold by this platform on the three shelves) */
  const newlyUsable = (platform) => Object.values(platform.coverage).reduce((sum, count) => sum + count, 0);

  function keyForm(platform) {
    const custom = platform.id === "custom";
    const name = platformName(platform);
    const key = `key:${platform.id}`;
    const field = (id, props) => h("input", { class: "input", id, autocomplete: "off", spellcheck: "false", ...props });
    return h(
      "form",
      {
        class: "key-form",
        // A wrong address is explained by the main process in the interface language (under this row), not the browser's own bubble: that follows the system language and looks different
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          const value = $(`plaza-key-${platform.id}`).value.trim();
          if (custom) {
            state.custom = { url: $("plaza-custom-url").value.trim(), model: $("plaza-custom-model").value.trim() };
          }
          const changes =
            custom && state.custom.model
              ? { polish: `custom/${state.custom.model}`, customUrl: state.custom.url }
              : undefined;
          act(key, () => window.whisprflow.saveKey(value, platform.id, changes), {
            done: () => {
              state.openKey = null;
              delete checks.results[key];
              const count = newlyUsable(platform);
              toast(count > 0 ? t("plaza.toast.keySaved", { count }) : t("plaza.toast.keySavedOnly"));
              if (state.returnTo) go(state.returnTo);
            },
          });
        },
      },
      custom &&
        field("plaza-custom-url", {
          type: "url",
          value: customUrl(),
          placeholder: t("plaza.custom.urlPlaceholder"),
          "aria-label": t("plaza.custom.url"),
        }),
      custom &&
        field("plaza-custom-model", {
          value: customChoice()?.slice("custom/".length) ?? "",
          placeholder: t("plaza.custom.modelPlaceholder"),
          "aria-label": t("plaza.custom.model"),
        }),
      field(`plaza-key-${platform.id}`, {
        type: "password",
        class: "input key-input",
        placeholder: t("plaza.keys.placeholder", { platform: name }),
        "aria-label": t("plaza.keys.label", { platform: name }),
      }),
      h("button", {
        type: "submit",
        class: "button primary",
        disabled: state.busy === key,
        text: t("plaza.keys.save"),
      }),
      h("button", {
        type: "button",
        class: "button ghost",
        text: t("plaza.keys.cancel"),
        onclick: () => {
          state.openKey = null;
          draw();
        },
      }),
      platform.key === "stored" &&
        h("button", {
          type: "button",
          class: "button ghost",
          text: t("plaza.keys.remove"),
          onclick: () =>
            act(key, () => window.whisprflow.forgetKey(platform.id), {
              done: () => {
                state.openKey = null;
                toast(t("plaza.toast.keyRemoved", { platform: name }));
              },
            }),
        }),
      platform.hasKeyPage &&
        h(
          "button",
          { type: "button", class: "key-link", onclick: () => window.whisprflow.openKeyPage(platform.id) },
          t("plaza.keys.get"),
          svg("i-external-link"),
        ),
    );
  }

  function renderKeys(root) {
    const cols = [{ label: t("plaza.cols.key"), width: "8.5rem", start: true }];
    const rows = keyedPlatforms().map((platform) => {
      const filled = Boolean(platform.key);
      const open = state.openKey === platform.id;
      const key = `key:${platform.id}`;
      const checkable = filled && (platform.id !== "custom" || (customChoice() && customUrl()));
      return h(
        "div",
        { class: "row", role: "row", "data-open": open },
        nameCell({
          tile: brand(platform.id),
          name: platformName(platform),
          tags: [],
          desc: coverage(platform),
        }),
        h(
          "span",
          { class: "metrics" },
          h("span", {
            class: "key-value",
            role: "cell",
            "data-empty": !filled,
            title: platform.key === "env" ? t("plaza.keys.envTip", { variable: platform.keyEnv }) : null,
            text: keyValue(platform),
          }),
        ),
        h(
          "div",
          { class: "cell-fill cell-status", role: "cell" },
          checkable
            ? statusControl(key, t("plaza.check.keyTip"), keyCheckCall(platform))
            : h("span", { "aria-hidden": "true" }),
        ),
        h(
          "div",
          { class: "cell-fill", role: "cell" },
          h("button", {
            type: "button",
            class: open ? "button ghost block" : "button block",
            disabled: !setup.switchable,
            text: t(open ? "plaza.keys.collapse" : filled ? "plaza.keys.replace" : "plaza.actions.configure"),
            onclick: () => {
              state.openKey = open ? null : platform.id;
              draw();
              if (!open) focusKeyForm(platform.id);
            },
          }),
        ),
        failNote(key),
        open && keyForm(platform),
      );
    });
    root.replaceChildren(
      h("section", { class: "group", "aria-label": t("plaza.tabs.keys") }, table(cols, t("plaza.cols.platform"), rows)),
    );
  }

  const indicators = slidingIndicators(document.querySelector('.page[data-route="models"]'));

  // ---------- Overall ----------

  /** An input being filled in must survive a redraw: remember its value and cursor, and restore them afterwards */
  function keepingInput(paint) {
    const active = document.activeElement;
    const kept = active?.id?.startsWith("plaza-") && active.tagName === "INPUT" ? active : null;
    const values = [...document.querySelectorAll(".key-form .input")].map((input) => [input.id, input.value]);
    paint();
    for (const [id, value] of values) {
      const input = $(id);
      if (input) input.value = value;
    }
    if (kept && kept.id !== "plaza-search") {
      const input = $(kept.id);
      input?.focus({ preventScroll: true });
      if (input && kept.selectionStart !== null) input.setSelectionRange(kept.selectionStart, kept.selectionEnd);
    }
  }

  function draw() {
    if (!setup?.plaza) return;
    keepingInput(() => {
      renderTabs();
      renderToolbar();
      renderStandby();
      renderGroups();
    });
    indicators.place();
  }

  $("plaza-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderGroups();
    indicators.place();
  });

  return {
    /** @param {object} next the whole status from getSetup */
    render(next) {
      setup = next;
      draw();
    },

    /** Opens a category ("keys" is the key table), optionally opening a platform's key form */
    show({ tab, platform } = {}) {
      if (tab) state.tab = TABS.includes(tab) ? tab : state.tab;
      if (platform) state.openKey = platform;
      draw();
      // Coming from elsewhere (Home's recognition mode, the banner) to fill in a provider's key
      if (platform) focusKeyForm(platform);
    },

    /** When the page comes to the front, the category underline is placed again by real widths */
    shown() {
      indicators.reset();
      indicators.place();
    },
  };
}
