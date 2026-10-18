import { $, h, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { hopChain, needText } from "./route-view.mjs";
import { toast } from "./toast.mjs";

// Home's recognition mode menu: a button right of the title names the mode in use, and opens a popover to pick one of three.
// Each mode lists the models along its route; what is missing (a key, a download, a custom service address) is written under that option,
// with a button to configure it on the model page. Switching goes to the main process (switchMode in app/modes.mjs): it switches at once without waiting for what is missing,
// and says honestly what is still missing (one line in the notice; the top banner says it too); if it can't switch (a mistake), it says why under that option.
// Which model each mode uses is changed on the model page, not here.
// The data comes with getSetup (ways in app/model-plaza.mjs).

const MODES = ["native", "local", "private"];
const ICONS = { native: "i-sparkles", local: "i-wand-sparkles", private: "i-shield-check" };
/** Which category to show first when configuring a mode on the model page: its step one */
const FIRST_TAB = { native: "native", local: "transcribe", private: "transcribe" };

/**
 * @param {object} options
 * @param {() => Promise<object>} options.refresh rereads the status, and the whole window updates
 * @param {(target: { tab: string, platform?: string }) => void} options.configure
 *   goes to a category on the model page; for the key table it can also open a platform's form
 */
export function createModePicker({ refresh, configure }) {
  /** The latest status */
  let setup = null;
  /** The mode being switched to; null when not switching */
  let busy = null;
  /** The last failed switch: { mode, problem }. Forgotten when the popover closes */
  let failure = null;

  const trigger = $("mode-trigger");
  const panel = $("mode-picker");

  const modeName = (mode) => t(`plaza.modes.${mode}`);
  const current = () => setup.plaza.mode;
  const wayOf = (mode) => setup.plaza.ways[mode];
  const platformOf = (id) => setup.plaza.platforms.find((platform) => platform.id === id) ?? { id, name: id };
  /** How far along an on-device model download is (local.transcribers from getSetup) */
  const downloadOf = (id) => setup.local.transcribers.find((model) => model.id === id)?.download ?? null;
  const isOpen = () => panel.matches(":popover-open");

  /**
   * Where configuring goes first: a missing key opens that provider in the key table, a missing download goes to the transcription row, a custom service without an address to the polish row.
   * When it isn't known what is missing (key rejected, unreachable), go to the key of the last provider on the route; with no provider at all (private), go to its step one
   */
  function fixTarget(mode) {
    const [need] = wayOf(mode).needs;
    if (need?.kind === "key") return { tab: "keys", platform: need.platform };
    if (need?.kind === "download") return { tab: "transcribe" };
    if (need?.kind === "url") return { tab: "polish" };
    const keyed = wayOf(mode).hops.findLast(({ platform }) => platform !== "local");
    return keyed ? { tab: "keys", platform: keyed.platform } : { tab: FIRST_TAB[mode] };
  }

  function go(target) {
    panel.hidePopover();
    configure(target);
  }

  /** The note under an option: why switching failed, or what is still missing before switching; both carry the configure button */
  function note(mode) {
    const way = wayOf(mode);
    const fix = h("button", {
      type: "button",
      class: "button small",
      text: t("home.mode.fix"),
      onclick: () => go(fixTarget(mode)),
    });
    if (failure?.mode === mode) {
      return h(
        "div",
        { class: "picker-note callout", role: "alert" },
        svg("i-circle-alert"),
        h("span", {}, h("b", { text: t("home.mode.failed") }), ` · ${t.text(failure.problem)}`),
        fix,
      );
    }
    const gaps = way.problem
      ? [t.text(way.problem)]
      : way.needs.map((need) => needText(need, { ...way, platformOf, downloadOf }));
    if (gaps.length === 0) return null;
    return h(
      "div",
      { class: "picker-note" },
      svg("i-circle-alert"),
      h("span", { text: gaps.join(" · ") }),
      !way.problem && fix,
    );
  }

  function option(mode) {
    const live = current() === mode;
    const switching = busy === mode;
    return h(
      "div",
      { class: "picker-item" },
      h(
        "button",
        {
          type: "button",
          class: "picker-option",
          role: "radio",
          "aria-checked": String(live),
          "aria-busy": switching ? "true" : null,
          disabled: !setup.switchable || (busy !== null && !switching),
          onclick: () => pick(mode),
        },
        h("span", { class: "picker-glyph" }, svg(ICONS[mode])),
        h(
          "span",
          { class: "picker-option-body" },
          h(
            "span",
            { class: "picker-option-title" },
            h("span", { class: "picker-option-name", text: modeName(mode) }),
            live && h("span", { class: "tag", "data-tone": "accent", text: t("plaza.inUse") }),
            switching &&
              h(
                "span",
                { class: "tag", role: "status" },
                svg("i-loader-circle", "icon spin"),
                t("home.mode.switching"),
              ),
          ),
          h("span", { class: "picker-option-desc", text: t(`home.mode.desc.${mode}`) }),
          hopChain(wayOf(mode).hops, platformOf),
        ),
        h("span", { class: "radio-mark" }, svg("i-check")),
      ),
      note(mode),
    );
  }

  function draw() {
    if (!setup?.plaza?.ways) return;
    const mode = current();
    trigger.replaceChildren(
      h("span", { class: "picker-glyph" }, svg(ICONS[mode])),
      h("span", { class: "picker-trigger-label", text: t("home.mode.label") }),
      h("span", { class: "picker-trigger-value", text: modeName(mode) }),
      svg("i-chevron", "icon chevron"),
    );
    trigger.setAttribute("aria-label", `${t("home.mode.label")} · ${modeName(mode)}`);
    $("mode-options").replaceChildren(...MODES.map(option));
    $("mode-locked").hidden = setup.switchable;
    $("mode-configure").replaceChildren(svg("i-sliders"), t("home.mode.configure", { mode: modeName(mode) }));
  }

  async function pick(mode) {
    if (busy !== null) return;
    if (mode === current()) {
      panel.hidePopover();
      return;
    }
    busy = mode;
    failure = null;
    draw();
    let result;
    try {
      result = await window.whisprflow.setMode(mode);
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    }
    busy = null;
    if (result?.ok === false) {
      failure = { mode, problem: result.problem };
      draw();
      // The popover was dismissed while waiting: the reason still needs saying
      if (!isOpen()) toast(`${t("home.mode.failed")} · ${t.text(result.problem)}`);
      return;
    }
    panel.hidePopover();
    await refresh();
    const way = wayOf(mode);
    const gaps = way.problem ? [] : way.needs.map((need) => needText(need, { ...way, platformOf, downloadOf }));
    toast([t("home.mode.switched", { mode: modeName(mode) }), ...gaps].join(" · "));
    if (result?.note) toast(t.text(result.note));
  }

  panel.addEventListener("toggle", (event) => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "closed" && busy === null && failure !== null) {
      failure = null;
      draw();
    }
  });
  $("mode-configure").addEventListener("click", () => go({ tab: FIRST_TAB[current()] }));

  return {
    /** @param {object} next the whole status from getSetup */
    render(next) {
      setup = next;
      draw();
    },
  };
}
