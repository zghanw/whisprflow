// Folds "does it work, and what's missing" into one summary. The menu bar, the main window, the hotkey hint, and the CLI all use it, so none disagree.
// Its sentences are not yet in a language (msg); whoever displays them translates.

import { msg } from "../i18n/index.mjs";
import { findModel } from "../models/catalog.mjs";

const OPEN_SETTINGS = msg("setup.openSettings");

/**
 * @param {object} setup
 * @param {{ state: "missing" | "unreadable" | "checking" | "rejected" | "ready", problem: object | string | null, cause?: string }} setup.key
 *   see key-manager.mjs
 * @param {{ microphone: string, listen: boolean | null, trusted: boolean | null }} setup.permissions
 *   microphone is the system status (granted / denied / not-determined ...); listen and trusted are null until key listening reports
 * @param {"starting" | "running" | "stopped"} [setup.helper] the key listener helper. stopped: exited or never started
 * @param {string} [setup.providerName] which vendor's model is in use, named when its key is missing
 * @param {{ state: string, model?: string, received?: number, total?: number, problem?: object } | null} [setup.localModel]
 *   the local path's model (localModel in service.mjs); off or null when not on that path. When not downloaded yet (missing)
 *   and the user is downloading it, it carries received and total
 * @returns {{ ready: boolean, missing: object[], blocker: object | null, degraded: object | null }}
 *   ready: whether the hotkey can dictate now; missing: what is definitely missing; blocker: the hint when the hotkey is pressed but can't work;
 *   degraded: a note when it works with limitations
 */
export function summarizeSetup({ key, permissions, helper, providerName = "Gemini", localModel = null }) {
  const missing = [];
  let blocker = null;

  const provider = providerName;
  if (key.state === "missing" || key.state === "unreadable") {
    missing.push(msg("setup.missing.key", { provider }));
    blocker = msg("setup.blocker.noKey", { provider, where: OPEN_SETTINGS });
  } else if (key.state === "rejected" && key.cause === "other") {
    // The vendor rejected the request, usually a wrong model name or thinking level: the key itself may be fine, so don't suggest replacing it
    missing.push(msg("setup.missing.check", { provider }));
    blocker = msg("setup.blocker.checkFailed", { provider, problem: key.problem });
  } else if (key.state === "rejected") {
    missing.push(msg("setup.missing.key", { provider }));
    blocker = msg("setup.blocker.keyRejected", { problem: key.problem });
  } else if (key.state === "checking") {
    blocker = msg("setup.blocker.checking");
  }

  // Not downloaded or failed to load both need the user (downloads are the user's call; a failed load usually means a corrupt file), so they count as missing; loading finishes on its own and doesn't
  if (localModel?.state === "failed") {
    missing.push(msg("setup.missing.localModel"));
    blocker ??= localModel.problem;
  } else if (localModel?.state === "missing") {
    missing.push(
      localModel.total
        ? msg("setup.missing.localModelDownloading", {
            percent: Math.floor((localModel.received / localModel.total) * 100),
          })
        : msg("setup.missing.localModel"),
    );
    blocker ??= localModel.total
      ? msg("local.modelDownloading", { percent: Math.floor((localModel.received / localModel.total) * 100) })
      : msg("local.modelMissing", {
          model: findModel(localModel.model)?.name ?? localModel.model,
          id: localModel.model,
        });
  } else if (localModel?.state === "loading") {
    blocker ??= msg("local.modelLoading");
  }

  if (permissions.microphone !== "granted") {
    missing.push(msg("setup.missing.microphone"));
    blocker ??= msg("setup.blocker.noMicrophone", { where: OPEN_SETTINGS });
  }
  // Without Input Monitoring the hotkey never arrives, so it can never be the "after pressing the hotkey" hint
  if (permissions.listen === false) missing.push(msg("setup.missing.listen"));
  // With the helper gone the two permissions never report; without saying so it would look like "getting ready" forever
  if (helper === "stopped") missing.push(msg("setup.missing.helper"));

  return {
    ready: blocker === null && permissions.listen === true,
    missing,
    blocker,
    degraded: permissions.trusted === false ? msg("setup.degraded") : null,
  };
}

/**
 * The shape for the CLI: every sentence in the summary translated to text in t's language. CLI and status --json readers
 * read these fields as text, and a msg would display as [object Object]
 */
export function summaryAsText({ ready, missing, blocker, degraded }, t) {
  return {
    ready,
    missing: missing.map(t.text),
    blocker: blocker === null ? null : t.text(blocker),
    degraded: degraded === null ? null : t.text(degraded),
  };
}
