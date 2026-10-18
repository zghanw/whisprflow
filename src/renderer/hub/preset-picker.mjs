import { $, h, progressBadge, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { createChecks } from "./checks.mjs";
import { hopChain, needText } from "./route-view.mjs";
import { toast } from "./toast.mjs";

// The presets right of the model page's title (models/presets.mjs, assembled by the main process and arriving with getSetup): a button that opens a list,
// the popover styled like Home's recognition mode menu (picker.css). Each preset shows its name, description, the models along its route, and monthly cost (100 dictations a day) on top,
// with Check on the left and Enable on the right below: Check runs the whole route once (on-device models transcribe one spoken sentence, cloud ones get a minimal request with these settings)
// without replacing what is in use; Enable has the main process switch (switchMode in app/modes.mjs, switching at once and stating what is still missing).
// Anything missing is written on the line below, with a button to fill it in on the right: a missing key opens that provider in the key table, a missing download happens here (with progress).

const ICONS = { native: "i-sparkles", local: "i-wand-sparkles", private: "i-shield-check" };

/**
 * @param {object} options
 * @param {() => Promise<object>} options.refresh rereads the status, and the whole window updates
 * @param {(platform: string) => void} options.configureKey opens that provider's form in the key table
 */
export function createPresetPicker({ refresh, configureKey }) {
  /** The latest status */
  let setup = null;
  /** The preset being enabled or starting a download (id); null if none */
  let busy = null;
  /** The last failure: { id, problem }. Forgotten when the popover closes */
  let failure = null;

  const trigger = $("preset-trigger");
  const panel = $("preset-picker");
  const checks = createChecks(() => draw());

  const platformOf = (id) => setup.plaza.platforms.find((platform) => platform.id === id) ?? { id, name: id };
  const nameOf = (id) => t(`presets.items.${id}.name`);
  const isOpen = () => panel.matches(":popover-open");
  /** The on-device model row (download state, size) */
  const localItem = (id) =>
    setup.plaza.shelves.transcribe.find(({ kind }) => kind === "local").items.find(({ choice }) => choice === id);

  /** Monthly cost in US dollars, to the cent; free shows $0 */
  const monthlyText = ({ usd }) => (usd === 0 ? "$0" : `$${usd.toFixed(2)}`);

  function cost(preset) {
    const tip = t("presets.costTip", { daily: setup.plaza.typical.daily, seconds: setup.plaza.typical.seconds });
    if (preset.monthly === null) return h("span", { class: "picker-cost", title: tip, text: t("presets.costUnknown") });
    return h(
      "span",
      { class: "picker-cost", title: tip },
      h("span", { class: "picker-cost-value", text: monthlyText(preset.monthly) }),
      h("span", { class: "unit", text: t("presets.perMonth") }),
    );
  }

  /** Checks a preset: on-device models first transcribe a spoken sentence, then cloud ones get a minimal request with these settings; it passes only if all pass */
  function checkCall(preset) {
    const local = preset.settings.transcriber ?? preset.settings.privateTranscriber;
    const usesLocal = preset.hops.some(({ platform }) => platform === "local");
    const usesCloud = preset.hops.some(({ platform }) => platform !== "local");
    return async () => {
      if (usesLocal) {
        const result = await window.whisprflow.checkTranscriber(local);
        if (!result.ok) return result;
      }
      return usesCloud ? window.whisprflow.checkModel(preset.mode, preset.settings) : { ok: true };
    };
  }

  /** Fills in what is missing: configure a missing key, download a missing model (showing progress) */
  function fix(preset) {
    const [need] = preset.needs;
    if (need?.kind === "key") {
      return h("button", {
        type: "button",
        class: "button block",
        disabled: !setup.switchable,
        text: t("plaza.actions.configureKey"),
        onclick: () => {
          panel.hidePopover();
          configureKey(need.platform);
        },
      });
    }
    if (need?.kind === "download") {
      const item = localItem(need.model);
      if (item?.download) return progressBadge(item.download);
      return h("button", {
        type: "button",
        class: "button block",
        disabled: busy !== null,
        text: t("presets.download", { size: `${Math.round((item?.bytes ?? 0) / 1e6)} MB` }),
        onclick: () => run(preset.id, () => window.whisprflow.downloadModel(need.model)),
      });
    }
    return null;
  }

  /** What is missing, as one line of text; empty when nothing is */
  function gapsOf(preset) {
    if (preset.problem) return [t.text(preset.problem)];
    const way = { hops: preset.hops, platformOf };
    const localName = preset.hops.find(({ platform }) => platform === "local")?.name;
    // A download in progress says "Downloading", with progress on the right
    return preset.needs.map((need) =>
      need.kind === "download" && localItem(need.model)?.download
        ? t("presets.downloading", { model: localName ?? need.model })
        : needText(need, way),
    );
  }

  /** The line below: Check on the left (saying what is missing, if anything), Enable on the right (in use, fill in, download progress) */
  function foot(preset) {
    const key = `preset:${preset.id}`;
    const gaps = gapsOf(preset);
    const left =
      gaps.length > 0
        ? h("p", { class: "preset-gap" }, svg("i-circle-alert"), h("span", { text: gaps.join(" · ") }))
        : h("div", { class: "preset-check" }, checks.control(key, t("presets.checkTip"), checkCall(preset)));
    let right;
    if (preset.active) {
      right = h("span", { class: "state-box block", "data-tone": "accent" }, svg("i-check"), t("plaza.inUse"));
    } else if (gaps.length > 0) {
      right = fix(preset);
    } else if (busy === preset.id) {
      right = h(
        "span",
        { class: "badge block", "data-tone": "progress", role: "status" },
        svg("i-loader-circle", "icon spin"),
        h("span", { class: "label", text: t("presets.enabling") }),
      );
    } else {
      right = h("button", {
        type: "button",
        class: "button block",
        disabled: !setup.switchable || busy !== null,
        text: t("presets.enable"),
        onclick: () => pick(preset),
      });
    }
    return h("div", { class: "preset-foot" }, left, h("div", { class: "preset-action" }, right));
  }

  function option(preset) {
    return h(
      "article",
      { class: "preset", "data-active": preset.active, "aria-current": preset.active ? "true" : null },
      h(
        "div",
        { class: "preset-main" },
        h("span", { class: "picker-glyph" }, svg(ICONS[preset.mode])),
        h(
          "div",
          { class: "picker-option-body" },
          h(
            "span",
            { class: "picker-option-title" },
            h("span", { class: "picker-option-name", text: nameOf(preset.id) }),
          ),
          h("span", { class: "picker-option-desc", text: t(`presets.items.${preset.id}.desc`) }),
          hopChain(preset.hops, platformOf),
        ),
        cost(preset),
      ),
      foot(preset),
      failure?.id === preset.id &&
        h(
          "p",
          { class: "callout", role: "alert" },
          svg("i-circle-alert"),
          h("span", {}, h("b", { text: t("plaza.actionFailed") }), ` · ${t.text(failure.problem)}`),
        ),
      checks.note(`preset:${preset.id}`),
    );
  }

  function draw() {
    if (!setup?.plaza?.presets) return;
    const { presets } = setup.plaza;
    trigger.hidden = presets.length === 0;
    trigger.replaceChildren(
      h("span", { class: "picker-glyph" }, svg("i-zap")),
      h("span", { class: "picker-trigger-value", text: t("presets.title") }),
      svg("i-chevron", "icon chevron"),
    );
    $("preset-meta").textContent = t("presets.meta", { daily: setup.plaza.typical.daily });
    $("preset-options").replaceChildren(...presets.map(option));
  }

  /** Sends something that waits for a reply (enable, start a download): one at a time; a failure hangs under that preset */
  async function run(id, call) {
    if (busy !== null) return null;
    busy = id;
    failure = null;
    draw();
    let result;
    try {
      result = await call();
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    }
    busy = null;
    if (result?.ok === false) {
      failure = { id, problem: result.problem };
      draw();
      // The popover was dismissed while waiting: the reason still needs saying
      if (!isOpen()) toast(`${t("plaza.actionFailed")} · ${t.text(result.problem)}`);
      return null;
    }
    await refresh();
    return result ?? {};
  }

  async function pick(preset) {
    const result = await run(preset.id, () => window.whisprflow.setMode(preset.mode, preset.settings));
    if (!result) return;
    panel.hidePopover();
    toast(t("presets.enabled", { name: nameOf(preset.id) }));
    if (result.note) toast(t.text(result.note));
  }

  panel.addEventListener("toggle", (event) => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "closed" && busy === null && failure !== null) {
      failure = null;
      draw();
    }
  });

  return {
    /** @param {object} next the whole status from getSetup */
    render(next) {
      setup = next;
      draw();
    },
  };
}
