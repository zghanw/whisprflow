// Sentences both the main window's settings and onboarding need: permission status, whether a key is still missing, how main-process errors are shown.
// Pure functions with no DOM. Wording comes from the translator the caller passes (src/i18n).

/** Errors thrown in the main process pick up "Error invoking remote method 'xx': Error: " over IPC; drop it before showing */
export const describeError = (error) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']*': (?:\w*Error: )?/,
    "",
  );

/** The key can't be used yet (missing, unreadable, rejected). One being verified does not count */
export const keyMissing = ({ key }) => key.state !== "ready" && key.state !== "checking";

/** Whether any of the three permissions is missing (ones not yet reported don't count) */
export const permissionDenied = ({ permissions }) =>
  permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;

/** Whether this permission is granted: true granted, false not, null still checking */
export function permissionGranted(name, value) {
  if (name === "microphone") return value === "granted";
  return value;
}

/**
 * How a permission's status reads, its tone, and the button label.
 * @param {Function} t translator for the UI language
 * @returns {[label: string, tone: "ok" | "problem" | "pending", action: string]}
 */
export function permissionText(name, value, t) {
  const granted = [t("permissions.granted"), "ok", t("permissions.openSettings")];
  const denied = [t("permissions.denied"), "problem", t("permissions.openSettings")];
  if (name === "microphone") {
    if (value === "granted") return granted;
    // If it was never asked, the app isn't in the System Settings list yet: the system has to prompt once first
    if (value === "not-determined") return [t("permissions.denied"), "problem", t("permissions.request")];
    return denied;
  }
  if (value === null) return [t("permissions.checking"), "pending", t("permissions.openSettings")];
  return value ? granted : denied;
}
