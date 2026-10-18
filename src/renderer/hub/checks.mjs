import { drawnCheck, h, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";

// The set of check states: unchecked is an outlined button (Check), checking spins, and the result is a badge that can be clicked again
// (Passed / Failed, turning into "Check again" on hover); the failure reason hangs below that row in a note.
// Shared by every row of the model library, the key table, and the presets. Results are kept by key and redrawn from there.

const label = (text) => h("span", { class: "label", text });

/**
 * @param {() => void} redraw the result changed; redraws the part that uses it
 */
export function createChecks(redraw) {
  /** key to { state: running | ok | fail, problem, title, fresh }. Never-checked keys have no entry */
  const results = {};

  async function run(key, call) {
    results[key] = { state: "running" };
    redraw();
    let result;
    try {
      result = await call();
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    }
    results[key] = result.ok ? { state: "ok", fresh: true } : { state: "fail", problem: result.problem };
    redraw();
    // The check mark only animates right after passing; later redraws show it still
    if (results[key]) results[key].fresh = false;
  }

  /**
   * The control in the status cell
   * @param {string} key
   * @param {string} tip hovering says what is being checked
   * @param {() => Promise<{ ok: boolean, problem?: object }>} call
   */
  function control(key, tip, call) {
    const result = results[key];
    const again = () => run(key, call);
    if (!result) {
      return h(
        "button",
        { type: "button", class: "check block", title: tip, onclick: again },
        svg("i-activity"),
        label(t("plaza.check.run")),
      );
    }
    if (result.state === "running") {
      return h(
        "span",
        { class: "badge block", "data-tone": "progress", role: "status", title: tip },
        svg("i-loader-circle", "icon spin"),
        label(t("plaza.check.running")),
      );
    }
    const ok = result.state === "ok";
    return h(
      "button",
      {
        type: "button",
        class: "badge block",
        "data-tone": ok ? "ok" : "problem",
        "data-fresh": Boolean(result.fresh),
        "aria-label": t(ok ? "plaza.check.okAgain" : "plaza.check.failAgain"),
        onclick: again,
      },
      h(
        "span",
        { class: "badge-face" },
        ok ? (result.fresh ? drawnCheck() : svg("i-check")) : svg("i-circle-alert"),
        label(t(ok ? "plaza.check.ok" : "plaza.check.fail")),
      ),
      h("span", { class: "badge-hover" }, svg("i-rotate-cw"), label(t("plaza.check.again"))),
    );
  }

  /** The failure note: below the row with the problem; null when nothing failed */
  function note(key) {
    const result = results[key];
    if (result?.state !== "fail") return null;
    return h(
      "p",
      { class: "callout", role: "alert" },
      svg("i-circle-alert"),
      h("span", {}, h("b", { text: t(result.title ?? "plaza.check.fail") }), ` · ${t.text(result.problem)}`),
    );
  }

  return { results, run, control, note };
}
