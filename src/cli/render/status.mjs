import { findLocale, msg, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { backendText } from "../../models/describe.mjs";
import { parseChatChoice } from "../../server/chat/vendors.mjs";
import { findProvider, parseModelChoice } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";
import { HOTKEY_IDS, SETTINGS } from "../../storage/settings.mjs";
import { formatUsd } from "../../usage/format.mjs";
import { routeTitle } from "./modes.mjs";
import { themeTitle } from "./settings.mjs";
import { duration, INDENT, paint, rows } from "./text.mjs";

// The status panel (whisprflow, whisprflow status). Like the other screens it is "data in, text out", never touching the terminal or reading files.

/**
 * The model the background app is using. Very old background apps report a bare Gemini model name and no provider; that is still recognized.
 * Connected to a separately started server it reports null, and this returns null
 */
function modelInUse(status, settings) {
  if (status.model === null) return null;
  // Even older versions don't report model at all
  return parseModelChoice(status.model ?? settings.model.value);
}

function keyLine(key, provider, t) {
  // Private mode needs no key
  if (key.source === "none") return t("cli.status.keyNone");
  // Unreachable at start, so it is used anyway, saying honestly it isn't verified yet
  const unverified = key.verified === false;
  const named = { variable: provider.keyEnv, provider: provider.name, problem: key.problem };
  switch (key.state) {
    case "ready":
      if (key.source === "env") return t(unverified ? "cli.status.keyEnvUnverified" : "cli.status.keyEnv", named);
      if (key.source === "external") return t("cli.status.keyExternal");
      return t(unverified ? "cli.status.keySavedUnverified" : "cli.status.keySaved", named);
    case "checking":
      return t("cli.status.keyChecking");
    case "rejected":
      // The three cases need different actions, so they can't all be "use another key"
      if (key.cause === "other") {
        const what = msg(provider.thinkingLevels ? "cli.status.modelAndLevel" : "cli.status.modelOnly");
        return t("cli.status.keyCheckFailed", { ...named, what });
      }
      if (key.source === "env") return t("cli.status.keyEnvRejected", named);
      return t("cli.status.keyRejected", named);
    case "unreadable":
      return t("cli.status.keyUnreadable", named);
    default:
      // The missing one is the route's other provider (step one in the cloud): name it and give its command
      return key.vendor
        ? t("cli.status.keyMissingFor", { provider: t(`providers.${key.vendor.id}.name`), id: key.vendor.id })
        : t("cli.status.keyMissing");
  }
}

/** Download progress: one the user started (missing with progress), or one an older background app started itself (downloading) */
const downloadingLine = (localModel, t) =>
  t("cli.status.localDownloading", {
    percent: Math.floor((localModel.received / localModel.total) * 100),
    received: Math.round(localModel.received / 1_000_000),
    total: Math.round(localModel.total / 1_000_000),
  });

/** The state of the on-device model (local mode's step one) */
function localModelLine(localModel, t) {
  switch (localModel?.state) {
    case "ready":
      return t("cli.status.localReady", { backend: backendText(localModel.backend) });
    case "missing":
      return localModel.total ? downloadingLine(localModel, t) : t("cli.status.localMissing", { id: localModel.model });
    case "downloading":
      return downloadingLine(localModel, t);
    case "loading":
      return t("cli.status.localLoading");
    case "failed":
      return t.text(localModel.problem);
    default:
      return null;
  }
}

/** What the hotkey is called. Hotkeys only in newer versions than this command can't be named, so the background's own hotkeyLabel is used */
const hotkeyTitle = (status, t) =>
  HOTKEY_IDS.includes(status.hotkey) ? t(`hotkeys.${status.hotkey}.name`) : (status.hotkeyLabel ?? status.hotkey);

/** Interface language: when following the system, includes the one actually used ("System · English") */
function languageTitle({ language, locale }, t) {
  const name = (id) => findLocale(id)?.name ?? id;
  return language === SYSTEM_LOCALE ? `${t("language.system")} · ${name(locale)}` : name(language);
}

/** The settings now written that differ from what the background app started with */
function pendingSettings(status, settings) {
  // Fields the background app doesn't report (the model when connected to a separately started server, the level for models without one) aren't compared;
  // both sides are normalized by the same rules first, so the old form very old background apps report (a bare model name) doesn't count as different
  const same = (name, reported) => {
    try {
      return SETTINGS[name].parse(String(reported)) === settings[name].value;
    } catch {
      return false;
    }
  };
  return Object.keys(SETTINGS).filter((name) => status[name] != null && !same(name, status[name]));
}

/** native mode: key, model */
function nativeEntries(status, settings, t) {
  const inUse = modelInUse(status, settings);
  const provider = findProvider(inUse?.provider ?? parseModelChoice(settings.model.value).provider);
  // Older background apps don't report the thinking level; models without levels (reported as null) aren't shown
  const thinking = provider.thinkingLevels ? (status.thinking ?? settings.thinking.value) : null;
  const model =
    inUse === null
      ? t("cli.status.modelExternal")
      : t(thinking ? "cli.status.modelWithThinking" : "cli.status.modelInUse", {
          provider: provider.name,
          model: inUse.model,
          thinking,
        });
  const entries = [
    [t("cli.status.key"), keyLine(status.key, provider, t)],
    [t("cli.status.model"), model],
  ];
  // Only versions that report the mode get this line
  if (status.mode) entries.splice(1, 0, [t("cli.status.mode"), t("modes.native")]);
  return entries;
}

/** local mode: key (the polish provider's), what each step uses, whether the on-device model is downloaded */
function localEntries(status, settings, t) {
  const provider = findVendor(status.provider);
  // Fields the background doesn't report come from the settings
  const route = {
    mode: "local",
    transcriber: status.transcriber ?? settings.transcriber.value,
    polish: parseChatChoice(status.polish ?? settings.polish.value),
    customUrl: settings.customUrl.value || null,
  };
  const entries = [
    [t("cli.status.key"), keyLine(status.key, provider, t)],
    [t("cli.status.mode"), t("modes.local")],
    [t("cli.status.model"), t.text(routeTitle(route))],
  ];
  const localModel = localModelLine(status.localModel, t);
  if (localModel) entries.push([t("cli.status.localModel"), localModel]);
  return entries;
}

/** private mode: no key, just one on-device model and whether it is downloaded */
function privateEntries(status, settings, t) {
  const route = { mode: "private", transcriber: status.transcriber ?? settings.privateTranscriber.value };
  const entries = [
    [t("cli.status.key"), keyLine(status.key, null, t)],
    [t("cli.status.mode"), t("modes.private")],
    [t("cli.status.model"), t.text(routeTitle(route))],
  ];
  const localModel = localModelLine(status.localModel, t);
  if (localModel) entries.push([t("cli.status.localModel"), localModel]);
  return entries;
}

function statsLine({ dictations, characters, seconds, costUsd, unpricedCalls }, { withPace, t }) {
  const parts = [
    t("cli.status.dictations", { count: dictations }),
    t("cli.status.characters", { count: characters }),
    duration(seconds, t),
  ];
  // Characters per minute only appear in the all-time stats: on a light day the number jumps around too much to mean anything
  if (withPace && seconds >= 60) parts.push(t("cli.status.pace", { count: Math.round(characters / (seconds / 60)) }));
  // If some calls have no known price, the cost only covers part, so say "at least"; versions before cost tracking have no records, so don't show $0 and imply nothing was spent
  if (unpricedCalls > 0) {
    parts.push(costUsd > 0 ? t("cli.status.atLeast", { cost: formatUsd(costUsd) }) : t("cli.status.costUnknown"));
  } else if (costUsd > 0) parts.push(formatUsd(costUsd));
  return parts.join(" · ");
}

/**
 * @param {object} view
 * @param {object | null} view.status the status the background app reports (describeStatus in src/app/main.mjs); null when not running
 * @param {string} view.version this command's own version, used when not running
 * @param {Record<string, { value: string }>} view.settings the current settings. The panel shows what the background app is using;
 *   these are only for checking whether the two differ
 * @param {{ today: object | null, total: object | null }} view.stats both null when there is no history database
 * @param {{ color: boolean, t: Function }} options t translates into the interface language. Messages (msg) reported by the background are translated with it too
 */
export function renderStatus({ status, version, settings, stats }, { color, t, platform }) {
  const c = paint(color);
  if (status === null) {
    return [
      `${c.bold(`WhisprFlow ${version}`)} · ${t("cli.status.notRunning")}`,
      "",
      `${INDENT}${t("cli.status.runToStart", { command: c.bold("whisprflow") })}`,
      "",
    ].join("\n");
  }

  const { summary, permissions } = status;
  const state = status.starting
    ? t("cli.status.starting")
    : summary.ready
      ? c.green(t("cli.status.running"))
      : summary.missing.length > 0
        ? c.yellow(t("cli.status.missingCount", { count: summary.missing.length }))
        : t("cli.status.preparing");
  const lines = [`${c.bold(`WhisprFlow ${status.version}`)} · ${state}`, ""];

  if (summary.ready) {
    lines.push(`${INDENT}${t("cli.status.ready", { hotkey: hotkeyTitle(status, t) })}`, "");
  } else if (!status.starting && summary.missing.length > 0) {
    lines.push(`${INDENT}${t("cli.status.missing", { items: t.list(summary.missing) })}`, "");
  }

  const mark = (granted) => (granted === null ? c.dim("…") : granted ? c.green("✓") : c.red("✗"));
  // On Windows only the microphone needs permission: listening for keys and simulating keystrokes don't (the helper always reports those two as true)
  const cells = [
    `${t("permissions.microphone")} ${mark(permissions.microphone === "granted")}`,
    ...(platform === "win32"
      ? []
      : [
          `${t("permissions.listen")} ${mark(permissions.listen)}`,
          `${t("permissions.trusted")} ${mark(permissions.trusted)}`,
        ]),
  ];
  // Show what the background app is using, not what the settings say now: they differ when settings changed without a restart, or the command that started it carried environment variables.
  // Very old versions don't report the mode; only native existed then
  const entries =
    status.mode === "local"
      ? localEntries(status, settings, t)
      : status.mode === "private"
        ? privateEntries(status, settings, t)
        : nativeEntries(status, settings, t);
  entries.splice(
    1,
    0,
    [t("cli.status.permissions"), cells.join("   ")],
    [t("cli.status.hotkey"), hotkeyTitle(status, t)],
  );
  // Older background apps don't report these two
  if (status.theme != null) entries.push([t("cli.status.theme"), themeTitle(t, status.theme)]);
  if (status.language != null) entries.push([t("cli.status.language"), languageTitle(status, t)]);
  if (stats.total && stats.total.dictations > 0) {
    entries.push(
      [t("cli.status.today"), statsLine(stats.today, { withPace: false, t })],
      [t("cli.status.total"), statsLine(stats.total, { withPace: true, t })],
    );
  }
  lines.push(...rows(entries));

  const relaunch = msg(status.packaged ? "cli.packagedRelaunch" : "cli.runRestart");
  const notes = [];
  const pending = pendingSettings(status, settings);
  // Setting names are English identifiers separated by slashes, not listed per language
  if (pending.length > 0) notes.push(t("cli.status.pending", { names: pending.join(" / "), relaunch }));
  if (status.helper === "stopped") notes.push(t("cli.status.helperStopped", { relaunch }));
  if (notes.length > 0) lines.push("", ...notes.map((note) => `${INDENT}${note}`));

  const permissionMissing =
    permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;
  if (permissionMissing) {
    lines.push("");
    if (summary.degraded) lines.push(`${INDENT}${t("common.sentence", { text: summary.degraded })}`);
    lines.push(`${INDENT}${t("cli.status.openSettings", { command: c.bold("whisprflow settings") })}`);
    // Whose name a permission is recorded under is a macOS matter: the Windows microphone switch is one for the whole system
    if (platform !== "win32") {
      lines.push(c.dim(`${INDENT}${t(status.packaged ? "cli.status.ownerApp" : "cli.status.ownerTerminal")}`));
    }
  }

  lines.push(
    "",
    ...t("cli.status.footer")
      .split("\n")
      .map((line) => c.dim(`${INDENT}${line}`)),
    "",
  );
  return lines.join("\n");
}
