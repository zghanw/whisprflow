import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { helperPaths } from "../cli/native-helper.mjs";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer } from "../control.mjs";
import { createTranslator, LocalizedError, msg, problemOf, resolveLocale } from "../i18n/index.mjs";
import { alsoLogTo, log } from "../log.mjs";
import { chipOf, downloadSize, MODELS, makerOf, measuredOn, SOURCES, tagsOn } from "../models/catalog.mjs";
import { createLocalModels, freeBytesAt } from "../models/library.mjs";
import { presetsFor } from "../models/presets.mjs";
import { CHAT_VENDORS, findChatVendor, formatChatChoice, parseChatChoice } from "../server/chat/vendors.mjs";
import { describeRoute, keyVendorOf, MODES } from "../server/modes.mjs";
import { formatModelChoice, PROVIDERS } from "../server/providers/index.mjs";
import { findVendor, VENDORS } from "../server/vendors.mjs";
import { MAX_LEARNED_TERMS, openDictionary } from "../storage/dictionary.mjs";
import { openHistory } from "../storage/history.mjs";
import { ensureHome, installedHomeOf, keyFile, resolvePaths } from "../storage/paths.mjs";
import {
  ACCELERATIONS,
  HOTKEY_IDS,
  hotkeyName,
  overridingEnv,
  patchSettings,
  resolveSettings,
  routeOf,
  saveSetting,
} from "../storage/settings.mjs";
import { toHex } from "../themes/color.mjs";
import { themeCss } from "../themes/contract.mjs";
import { findTheme, THEMES } from "../themes/index.mjs";
import { estimateTime } from "../usage/estimate.mjs";
import { insights } from "../usage/insights.mjs";
import { usageReport } from "../usage/report.mjs";
import { createDelivery } from "./delivery.mjs";
import { startHelper } from "./helper.mjs";
import { createKeyManager } from "./keys/key-manager.mjs";
import { createKeyStore } from "./keys/key-store.mjs";
import { describePlaza, loadPriceBook } from "./model-plaza.mjs";
import { createModeSwitch } from "./modes.mjs";
import { ollamaStatus, pullModel } from "./ollama.mjs";
import { startService } from "./service.mjs";
import { summarizeSetup, summaryAsText } from "./setup-state.mjs";

// The background app's main process: two windows (the bar and the main window), the menu bar icon, the native helper, the built-in dictation service,
// and the errands the pages and the CLI ask of it. Window colors come from the theme (src/themes); this hands it to every window.
// Usually started by the whisprflow command (src/cli), or double-clicked as a packaged app.
// Structure: main process + bar window + main window (hub) + keyboard helper process.

/** For debugging: when set, connect to a separately started server at this address instead of starting the built-in one */
const EXTERNAL_SERVER_URL = process.env.WHISPRFLOW_SERVER_URL ?? null;
/** Started by the whisprflow command: it routes logs to a file and reports anything missing in the terminal, so no main window pops up here */
const LAUNCHED_BY_CLI = process.env.WHISPRFLOW_CLI === "1";

let PATHS;
let SETTINGS;
/** The route at startup (server/modes.mjs). Later mode and model changes switch at once (keys.switchRoute); service.route is the one in use */
let ROUTE;
/** Whether on-device models use the GPU (the acceleration setting). Changing it in settings applies at once (service.setAcceleration) */
let acceleration;
// Launches from the Start menu or at login on Windows have no WHISPRFLOW_HOME: the home is found from where the program is installed (the same in the default location)
if (process.platform === "win32" && !process.env.WHISPRFLOW_HOME) {
  const home = installedHomeOf(process.execPath, existsSync);
  if (home) process.env.WHISPRFLOW_HOME = home;
}

try {
  PATHS = resolvePaths(process.env);
  SETTINGS = resolveSettings({ file: PATHS.settingsFile, env: process.env });
  ROUTE = routeOf(SETTINGS);
  acceleration = SETTINGS.acceleration.value;
} catch (error) {
  // A wrong path or setting is a usage problem: say one plain sentence and exit, rather than leave a process that ignores the hotkey
  console.error(error.message);
  process.exit(2);
}
/** The key in use. Settings can change it at once (setup:set-hotkey), restarting the helper */
let hotkey = SETTINGS.hotkey.value;
/**
 * Whose key is used at startup: the audio vendor on the native path, the cleanup vendor on the local path; null when no key is needed (private mode, Ollama).
 * keys.provider is the one in use
 */
const PROVIDER = keyVendorOf(ROUTE) ?? null;
/** Only Gemini has thinking levels; null for others, and not reported in status */
const thinkingFor = (provider) => (provider?.thinkingLevels ? SETTINGS.thinking.value : null);
const WINDOWS = process.platform === "win32";
/**
 * The menu bar icon. On macOS the file name contains Template so the system inverts it to match the menu bar, and picks the @2x one itself;
 * the Windows notification area doesn't invert, so it uses the colored app icon with every size in the .ico (scripts/build/make-icon.sh)
 */
const TRAY_ICON = join(import.meta.dirname, "../../assets", WINDOWS ? "icon.ico" : "trayTemplate.png");
/** The window and taskbar icon on Windows (macOS uses the app bundle's own icon) */
const WINDOW_ICON = join(import.meta.dirname, "../../assets/icon.ico");
/**
 * With the title bar hidden on Windows, the system minimize, maximize, and close buttons overlay a strip this tall at the top right of the page.
 * The same height as the drag strip at the top of the main window content (.content::before in hub.css, 2.75rem)
 */
const CAPTION_HEIGHT = 44;
/** Where "View on GitHub" in About opens */
const HOMEPAGE = "https://github.com/zghanw/whisprflow";
/** This machine's chip: on-device model measurements are picked by it (CHIPS in models/catalog.mjs) */
const CHIP = chipOf();
/** Main window size: 1080 x 750, minimum 988 x 685 */
const HUB_SIZE = { width: 1080, height: 750, minWidth: 988, minHeight: 685 };
/** The bar's window. Larger than the bar itself: a hint line goes above, shadows need room around it, and the bar grows on errors */
const BAR_SIZE = { width: 380, height: 124 };
/**
 * System Settings pages for each permission. Windows has only the microphone: there's no "Input Monitoring" or "Accessibility",
 * and the helper can listen to keys and simulate them as soon as its hook is installed (listen and trusted always report true)
 */
const PRIVACY_PANES = WINDOWS
  ? { microphone: "ms-settings:privacy-microphone" }
  : {
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      listen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
      trusted: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    };

/**
 * Asks for microphone permission. On macOS a system prompt appears if never asked; Windows has no such prompt (it's a switch in System Settings), so the current state is reported
 * @returns {Promise<boolean>} whether it can be used
 */
async function askMicrophone() {
  if (WINDOWS) return systemPreferences.getMediaAccessStatus("microphone") === "granted";
  return systemPreferences.askForMediaAccess("microphone");
}

// Windows identifies the app by this id: the taskbar groups windows by it and notifications name it. The same as the macOS bundle identifier
const APP_ID = "com.zghanw.whisprflow";
if (WINDOWS) app.setAppUserModelId(APP_ID);

/**
 * How the taskbar names this window's button and how a pinned button starts the app again. Without these Windows takes both from the runtime
 * (electron.exe), and a pinned button would start Electron on its own. Relaunching runs the runtime with this app's directory, as the Start menu shortcut does.
 * ponytail: Windows silently drops a relaunch command of roughly 200 characters or more (measured); a default install's is about 100, and only a very
 * deep WHISPRFLOW_HOME reaches the limit, where pinning falls back to the runtime alone
 */
function setTaskbarDetails(window) {
  if (!WINDOWS) return;
  window.setAppDetails({
    appId: APP_ID,
    appIconPath: WINDOW_ICON,
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: "WhisprFlow",
  });
}

// Everything lives in the one directory paths.mjs defines, shared with the CLI. Electron by default makes another directory named after the app
// under ~/Library/Application Support for Chromium's cache and state; that goes in here too, kept apart from our data
app.setPath("userData", PATHS.cacheDir);

/**
 * An installed copy on Windows: the program sits in the home's runtime. There's no separate "app": the CLI-started and Start menu-started ones are the same,
 * sharing one set of keys and settings (unlike WhisprFlow.app on macOS, which has its own permissions)
 */
const INSTALLED_ON_WINDOWS =
  WINDOWS && process.execPath.toLowerCase().startsWith(`${PATHS.runtimeDir.toLowerCase()}\\`);
/** Launch at login registers this executable plus the program directory (Windows has no app bundle, so the arguments must be recorded too) */
const LOGIN_ITEM = WINDOWS ? { path: process.execPath, args: [app.getAppPath()], name: "WhisprFlow" } : {};

/**
 * Whether launch at login is on. On Windows openAtLogin only knows the entry named after the AppUserModelId, and ours is named WhisprFlow,
 * so reading it back is always false (tried on real hardware): check executableWillLaunchAtLogin, that Run has an entry pointing at this program with these arguments,
 * not disabled in Task Manager
 */
function loginItemEnabled() {
  const settings = app.getLoginItemSettings(LOGIN_ITEM);
  return WINDOWS ? settings.executableWillLaunchAtLogin : settings.openAtLogin;
}

// A packaged app has no terminal, so it writes its own log file. When started by the command, stdout already goes to the same file.
// Launches from the Windows Start menu (not the CLI) have no terminal either
if (app.isPackaged || (INSTALLED_ON_WINDOWS && !LAUNCHED_BY_CLI)) alsoLogTo(PATHS.logFile);

// One instance per home directory. The data given here reaches the running one with the second-instance event
const isOnlyInstance = app.requestSingleInstanceLock({ byCli: LAUNCHED_BY_CLI });
if (!isOnlyInstance) {
  console.error("Another instance is already running");
  // The agreed exit code: the whisprflow command that started it learns "it didn't fail to start, another one got there first" and waits for that one
  app.exit(ALREADY_RUNNING_EXIT_CODE);
}

const sourceDir = join(app.getAppPath(), "src");
const webPreferences = { preload: join(sourceDir, "preload", "preload.cjs"), sandbox: true, contextIsolation: true };
// Windows hold only our own pages. The windows share one preload script: if a file dragged in or a link in a page took a window elsewhere,
// that page could reach the save-key, read-history, and read-clipboard APIs. New windows likewise
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    log.warn("navigation_blocked", { url: url.slice(0, 200) });
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn("window_open_blocked", { url: url.slice(0, 200) });
    return { action: "deny" };
  });
});

// Not a top-level await app.whenReady(): Electron only becomes ready once the main module finishes loading,
// and a top-level await keeps the module loading forever, each waiting on the other (as measured on Electron 44.7).
// The instance that lost the lock is quitting and goes no further: what's in the home (process id, control channel) belongs to the first one
if (isOnlyInstance) {
  app
    .whenReady()
    .then(main)
    .catch((error) => {
      // A failed start has no window to report in: log it and exit non-zero, rather than leave a process doing nothing
      log.error("startup_failed", { error: String(error?.stack ?? error) });
      app.exit(1);
    });
}

async function main() {
  app.dock?.hide();

  ensureHome(PATHS);
  // Record the process id: if it hangs, whisprflow stop finds it by this. Written before the control channel starts listening,
  // so whenever the channel answers, the file names the process behind it
  writeFileSync(PATHS.pidFile, `${process.pid}\n`);

  const startedAt = new Date().toISOString();
  const history = openHistory(PATHS.historyDb);
  const dictionary = openDictionary(PATHS.dictionaryFile);
  // Prices on the model page and preset monthly costs: each vendor's price module loads once at startup
  const prices = await loadPriceBook();
  // One key per vendor, one file each. Vendors besides the one in use are needed too: whisprflow key openai and model check use them
  const keyStores = Object.fromEntries(
    VENDORS.map(({ id }) => [id, createKeyStore({ file: keyFile(PATHS, id), safeStorage })]),
  );
  /** When the local model state changes, the menu bar and main window update. Changes before the menu bar exists don't matter: it reads the latest when built */
  let localModelChanged = () => {};
  // The on-device model library: downloads, cancels, and deletes are user actions. Once downloaded or deleted, the service loads or unloads per the route
  const localModels = createLocalModels({
    dir: PATHS.modelsDir,
    source: SETTINGS.modelSource.value,
    log,
    // Only arrives after the user downloads, cancels, or deletes, long after the service exists
    onChange: () => {
      service?.modelsChanged();
      localModelChanged();
    },
  });
  // Every model call is billed, and an open history window updates its spend (billing errors are logged by the refining flow without affecting dictation)
  const service = EXTERNAL_SERVER_URL
    ? null
    : await startService({
        log,
        route: ROUTE,
        modelsDir: PATHS.modelsDir,
        models: localModels,
        onModelCall: (call) => {
          history.addCall(call);
          historyChanged();
        },
        onLocalModel: () => localModelChanged(),
        acceleration,
        dictionary,
      });
  const serverUrl = EXTERNAL_SERVER_URL ?? service.url;
  const e2e = process.env.WHISPRFLOW_E2E_OUT ? await import("./e2e.mjs") : null;
  // Screenshots of the windows for checking the pages (scripts/dev/screens.mjs); never loaded otherwise
  const screens = process.env.WHISPRFLOW_SCREENS_OUT ? await import("./screens.mjs") : null;

  const keys = createKeyManager({
    service,
    provider: PROVIDER,
    keyStores,
    env: process.env,
    log,
    onChange: () => setupChanged(),
    // Which route verifies a key being saved for a vendor not in use is the mode layer's call
    routeFor: (id) => modes.routeForVendor(id),
  });
  /** Mode changes and model changes within modes (app/modes.mjs). null when connected to a separately started server, which owns these */
  const modes = service
    ? createModeSwitch({ service, keys, models: localModels, settingsFile: PATHS.settingsFile, env: process.env, log })
    : null;
  /** The key listener helper: starting (hasn't reported) / running / stopped (exited, or never started) */
  let helperState = "starting";
  /** The two permissions the helper reports; null when it isn't running */
  let helperPermissions = null;
  /** The control channel, opened late in startup; always null during end-to-end tests */
  let control = null;
  /** Whether the startup checks of the microphone and key are done */
  let startupChecked = false;
  let hubWindow = null;
  let onboardingWindow = null;
  /** Onboarding is testing the hotkey: the hotkey goes to the onboarding window instead of opening the bar */
  let hotkeyToOnboarding = false;

  // ---------- UI language ----------

  /** The language setting (system follows the system) and the one actually in use this run. A settings change applies at once, without a restart */
  let languageSetting = SETTINGS.language.value;
  let locale = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
  /** The menu bar uses it; window pages translate by their locale (the preload script fetches it synchronously at once) */
  let t = createTranslator(locale);
  ipcMain.on("locale:get", (event) => {
    event.returnValue = locale;
  });

  log.info("started", {
    version: app.getVersion(),
    hotkey,
    route: describeRoute(ROUTE),
    thinking: ROUTE.mode === "native" ? thinkingFor(PROVIDER) : null,
    theme: SETTINGS.theme.value,
    acceleration,
    language: languageSetting,
    locale,
    system_languages: app.getPreferredSystemLanguages(),
    home: PATHS.home,
    server_url: serverUrl,
    packaged: app.isPackaged,
    by_cli: LAUNCHED_BY_CLI,
    e2e: Boolean(e2e),
  });

  // ---------- Does it work, and what's missing ----------

  /** A vendor's name in the UI language (providers.<id>.name in the messages); null when there is no vendor (private mode) */
  const vendorTitle = (vendor) => (vendor ? msg(`providers.${vendor.id}.name`) : null);

  /** The vendor in use: when connected to a separately started server, the one in settings (that server decides; this is only a name) */
  const provider = () => (service ? keys.provider : PROVIDER);

  const currentSetup = () => ({
    // When the missing key belongs to the route's other vendor (a cloud step one), name that vendor, in the UI language rather than the log name
    providerName: vendorTitle(keys.current.vendor ?? provider()),
    key: keys.current,
    localModel: service?.localModel ?? null,
    helper: helperState,
    permissions: {
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
      listen: helperPermissions?.listen ?? null,
      trusted: helperPermissions?.trusted ?? null,
    },
  });

  let offeredSettings = LAUNCHED_BY_CLI;
  /**
   * Opens onboarding while something is missing, so a first-time user doesn't have to guess the next step. It pops up only once.
   * Not when started by the command: that person is watching the terminal, and a window popping up would steal the focus they need to paste a key.
   * The checks arrive one after another (the key needs verifying, the helper needs starting), so it decides only once all have a verdict, avoiding false alarms right at startup.
   */
  function offerSettingsIfIncomplete() {
    const setup = currentSetup();
    if (offeredSettings || !startupChecked || setup.key.state === "checking" || setup.permissions.listen === null)
      return;
    const summary = summarizeSetup(setup);
    // Cleanup being off (Ollama not started) isn't worth a window at every launch: the menu bar and main window banner say it
    const cleanupOff = setup.key.source === "none" && setup.key.verified === false;
    if (summary.missing.length === 0 && (summary.degraded === null || cleanupOff)) return;
    offeredSettings = true;
    log.info("settings_offered", { missing: summary.missing, degraded: summary.degraded !== null });
    // The missing key belongs to the route's other vendor (the cloud step one): onboarding only knows the vendor in use, so entering it there would be wrong. Go to the key table on the model page
    if (setup.key.vendor) showHub({ pane: "auto" });
    else showOnboarding();
  }

  /** Called whenever any of the above changes: the menu bar and main window update */
  function setupChanged() {
    refreshTrayMenu();
    hubWindow?.webContents.send("setup:changed");
    onboardingWindow?.webContents.send("setup:changed");
  }

  // ---------- Theme ----------

  let theme = findTheme(SETTINGS.theme.value);
  // Each window's preload script fetches it synchronously at once, before the page paints its first frame
  ipcMain.on("theme:get", (event) => {
    event.returnValue = themeCss(theme);
  });
  /** Rereads the theme from settings and applies it to open windows at once. Other settings need a restart; the theme doesn't */
  function reloadTheme() {
    theme = findTheme(resolveSettings({ file: PATHS.settingsFile, env: process.env }).theme.value);
    const css = themeCss(theme);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("theme:changed", css);
    recolorCaptionButtons();
    log.info("theme_changed", { theme: theme.id });
    return { theme: theme.id };
  }
  const windowColors = () => theme.window[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  /** The window background before the page paints: the same as the page's, so dark mode doesn't flash white first */
  const windowBackground = () => toHex(windowColors().bg);
  /** The three system buttons at the top right on Windows: transparent background (showing the page), symbols in the body text color, following theme and appearance */
  const captionButtons = () => ({ color: "#00000000", symbolColor: toHex(windowColors().ink), height: CAPTION_HEIGHT });
  /**
   * The title bar of the main window and onboarding: hidden, with the page drawn to the very top. On macOS the traffic lights go where trafficLight says;
   * on Windows the three system buttons overlay the top right, and the window gets an icon (otherwise the taskbar shows Electron's)
   */
  const frame = (trafficLight) =>
    WINDOWS
      ? { titleBarStyle: "hidden", titleBarOverlay: captionButtons(), icon: WINDOW_ICON }
      : { titleBarStyle: "hidden", trafficLightPosition: trafficLight };
  /** The theme changed or the system appearance changed: the three buttons on Windows change color with it */
  function recolorCaptionButtons() {
    if (!WINDOWS) return;
    for (const window of [hubWindow, onboardingWindow]) {
      if (window && !window.isDestroyed()) window.setTitleBarOverlay(captionButtons());
    }
  }
  nativeTheme.on("updated", recolorCaptionButtons);

  // ---------- The bar ----------

  function createBar() {
    const { workArea } = screen.getPrimaryDisplay();
    const bar = new BrowserWindow({
      ...BAR_SIZE,
      x: Math.round(workArea.x + (workArea.width - BAR_SIZE.width) / 2),
      // Sits on the bottom edge of the screen's work area. How far the bar is from the edge is set by bar.css
      y: workArea.y + workArea.height - BAR_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Must never take focus: once focus leaves the field the user is typing in, text can't be pasted there
      focusable: false,
      webPreferences,
    });
    // The whole window ignores the mouse, so events fall through to the app beneath. The bar's two buttons don't take clicks through this window:
    // a click landing on our window brings us to the front (panel-type windows too, measured), and the input loses focus anyway.
    // So clicks are captured by the native helper before reaching any window; see bar:capture below
    bar.setIgnoreMouseEvents(true);
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    bar.loadFile(join(sourceDir, "renderer", "bar", "bar.html"));
    return bar;
  }

  const bar = createBar();
  /** Sends a message to the bar page. While quitting the window is already destroyed and sending would throw */
  const tellBar = (channel, payload) => {
    if (!bar.isDestroyed()) bar.webContents.send(channel, payload);
  };
  const notify = (message) => tellBar("notice", message);
  /** Whether the hint above the bar shows (the barHint setting, on / off). Read fresh each time: when overridden by the environment, the environment's */
  const currentBarHint = () => resolveSettings({ file: PATHS.settingsFile, env: process.env }).barHint.value;
  ipcMain.on("bar:set-visible", (_event, visible) => {
    if (visible) {
      bar.showInactive();
      return;
    }
    bar.hide();
    // Nothing should be captured while the bar isn't on screen. The page says "stop capturing" itself; saying it again here is a safety net:
    // if it ever forgot, esc would stay swallowed and couldn't be pressed in any app
    helper.release();
  });
  // A crashed page will certainly never say "stop capturing"
  bar.webContents.on("render-process-gone", (_event, details) => {
    log.error("bar_gone", { reason: details.reason });
    helper.release();
  });
  // While dictating, the page asks the helper to capture esc and clicks on the bar's two buttons (null stops capturing).
  // The page gives the buttons' positions in the window; the helper needs screen positions
  ipcMain.on("bar:capture", (_event, regions) => {
    if (regions === null) {
      helper.release();
      return;
    }
    if (!Array.isArray(regions)) {
      log.error("bar_capture_invalid", { type: typeof regions });
      return;
    }
    const origin = bar.getBounds();
    const onScreen = regions.map(({ id, x, y, width, height }) => {
      const rect = { x: origin.x + x, y: origin.y + y, width, height };
      // The Windows mouse hook reports physical pixels while window positions are scaled: convert to that screen's physical pixels before handing them over
      return { id, ...(WINDOWS ? screen.dipToScreenRect(bar, rect) : rect) };
    });
    // When "clicking a button does nothing", check this first: do the positions match the two circles drawn on screen
    log.info("bar_capture", { regions: onScreen });
    helper.capture(onScreen);
  });

  // ---------- Keys and pasting ----------

  let helper = null;
  /** Incremented for every helper started; events from an old one exiting are recognized by it and dropped */
  let helperGeneration = 0;
  /** Whether the helper can capture esc and clicks (needs Accessibility). When it can't, the bar doesn't draw those two buttons */
  let barControls = false;
  function setBarControls(enabled) {
    barControls = enabled;
    tellBar("bar:controls", enabled);
  }

  /**
   * @param {{ prompt: boolean }} options prompt: whether the system may prompt when the two permissions are missing. Prompts only once at app start;
   *   later permission rechecks restart the helper, and prompting then would prompt on every check
   */
  function launchHelper({ prompt }) {
    const generation = ++helperGeneration;
    helperPermissions = null;
    helperState = "starting";
    setBarControls(false);
    helper = startHelper(helperPaths(app.getAppPath()).binary, {
      args: ["--key", hotkey, ...(prompt ? [] : ["--no-prompt"])],
      onEvent: (event) => {
        if (generation === helperGeneration) onHelperEvent(event);
      },
      log,
    });
  }

  function onHelperEvent(event) {
    switch (event.event) {
      case "ready":
        helperState = "running";
        helperPermissions = { listen: event.listen, trusted: event.trusted };
        log.info("helper_ready", { ...helperPermissions, capture: event.capture });
        setBarControls(event.capture === true);
        setupChanged();
        offerSettingsIfIncomplete();
        break;
      case "hotkey":
      case "other_key": {
        // Onboarding is testing the hotkey and the person is watching it: the hotkey goes only to the onboarding window.
        // After switching to another app, dictation works as usual, or the hotkey would do nothing anywhere with no hint;
        // and while the bar is on screen (dictation started elsewhere, then switched back) it goes to the bar, or that dictation couldn't stop
        if (event.event === "hotkey" && hotkeyToOnboarding && onboardingWindow?.isFocused() && !bar.isVisible()) {
          log.info("key_event", { event: event.event, down: event.down, to: "onboarding" });
          onboardingWindow.webContents.send("onboarding:hotkey", { down: event.down });
          break;
        }
        // When the hotkey does nothing, check whether this log line appears: if not, the helper never got the key (permissions, or the wrong key chosen)
        log.info("key_event", { event: event.event, down: event.down });
        const { blocker } = summarizeSetup(currentSetup());
        if (blocker === null) tellBar("input", event);
        else if (event.event === "hotkey" && event.down) notify(blocker);
        break;
      }
      case "escape":
      case "click":
        // Only while dictating: then the page has the helper capturing them
        // The field can't be called event: this log line's name is stored in event and would be overwritten
        log.info("bar_input", { input: event.event, id: event.id });
        tellBar("input", event);
        break;
      case "exit":
        helperState = "stopped";
        helperPermissions = null;
        setBarControls(false);
        log.error("helper_exited", { code: event.code, signal: event.signal });
        setupChanged();
        notify(msg("bar.helperStopped", { hotkey: hotkeyName(hotkey) }));
        break;
      default:
        log.warn("helper_unknown_event", { event: event.event });
    }
  }

  // No helper during end-to-end tests: no real keyboard listening, and never pasting into the user's current window
  if (e2e) helper = e2e.fakeHelper;
  else launchHelper({ prompt: true });

  // ---------- Errands the pages ask of the main process ----------

  const delivery = createDelivery({
    recordingsDir: PATHS.recordingsDir,
    history,
    paste: (text) => helper.paste(text),
    writeClipboard: (text) => clipboard.writeText(text),
    log,
  });
  function historyChanged() {
    hubWindow?.webContents.send("history:changed");
  }

  /**
   * Pages call the main process. On errors Electron only passes message to the page and problem is lost, while a LocalizedError's message is English:
   * such errors are translated into the UI language here before throwing (changing the hotkey with a broken settings file, say)
   */
  function handle(channel, listener) {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await listener(...args);
      } catch (error) {
        if (error instanceof LocalizedError) throw new Error(t.text(error.problem), { cause: error });
        throw error;
      }
    });
  }

  handle("config:get", () => ({ serverUrl, hotkey, barControls, barHint: currentBarHint() }));
  handle("dictation:deliver", async (_event, payload) => {
    const result = await delivery.completed(payload);
    // Log only the length: the result is what the user said and stays out of logs
    log.info("delivered", { audio_id: payload.audioId, text_length: payload.text.length, notice: result.notice });
    historyChanged();
    // If cleanup was off (Ollama not running), check again now, so the note clears once it works. Does nothing otherwise
    reverifyKeyInBackground();
    e2e?.onFinished({ delivered: payload.text, notice: result.notice });
    return result;
  });
  handle("dictation:failed", (_event, payload) => {
    delivery.failed(payload);
    log.warn("dictation_failed", { audio_id: payload.audioId, error: payload.error });
    historyChanged();
    e2e?.onFinished({ failed: payload.error });
  });
  handle("history:list", () => history.list());
  handle("dictionary:get", () => ({ terms: dictionary.terms(), max: MAX_LEARNED_TERMS }));
  handle("dictionary:set", (_event, terms) => {
    if (!Array.isArray(terms)) throw new Error("dictionary:set takes a list of terms");
    return dictionary.replace(terms);
  });
  handle("usage:report", () => usageReport(history, { now: new Date() }));
  handle("insights:get", () => insights(history.dictations(), { now: new Date() }));
  handle("app:info", () => ({ version: app.getVersion(), hotkey }));
  handle("app:open-homepage", () => shell.openExternal(HOMEPAGE));
  handle("clipboard:write", (_event, text) => {
    if (typeof text !== "string") throw new TypeError("What to copy is not text");
    clipboard.writeText(text);
  });

  // ---------- Errands the main window's settings ask of the main process ----------

  handle("setup:get", () => {
    const setup = currentSetup();
    return {
      ...setup,
      summary: summarizeSetup(setup),
      // The page names it in the UI language; only the id is given here
      hotkey: { value: hotkey, choices: HOTKEY_IDS },
      theme: { value: theme.id, choices: THEMES.map(({ id }) => id) },
      barHint: currentBarHint(),
      language: { value: languageSetting, locale },
      // Launch at login registers "this app"; started from a terminal it would register Electron itself, so it's offered only once packaged
      openAtLogin: {
        supported: app.isPackaged || INSTALLED_ON_WINDOWS,
        enabled: loginItemEnabled(),
      },
      home: PATHS.home,
      version: app.getVersion(),
      // The vendor whose key is in use; null when no key is needed
      provider: provider() ? describeVendor(provider()) : null,
      ...describeModes(),
      // The "Models" page in the sidebar: three shelves and the key table (model-plaza.mjs)
      plaza: describePlazaNow(),
      // When connected to a separately started server, that server decides the mode and vendor; they can't change here
      switchable: Boolean(service),
    };
  });

  /** The model page, built from the current settings, keys, and on-device model state */
  function describePlazaNow() {
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    let freeBytes = null;
    try {
      freeBytes = freeBytesAt(PATHS.modelsDir);
    } catch (error) {
      log.warn("disk_space_unknown", { error: String(error) });
    }
    return describePlaza({
      mode: service?.route.mode ?? ROUTE.mode,
      chosen: {
        native: settings.model.value,
        transcriber: settings.transcriber.value,
        privateTranscriber: settings.privateTranscriber.value,
        polish: settings.polish.value,
        customUrl: settings.customUrl.value,
      },
      keys: service ? keys.sources() : {},
      status: Object.fromEntries(MODELS.map(({ id }) => [id, localModels.status(id)])),
      chip: CHIP,
      freeBytes,
      prices,
      routes: Object.fromEntries(MODES.map(({ id }) => [id, routeOrProblem(settings, id)])),
      presets: presetsFor(CHIP).map((preset) => ({
        preset,
        route: routeOrProblem(settings, preset.mode, preset.settings),
      })),
      at: estimateTime(new Date()),
    });
  }

  /**
   * The route a mode takes with the settings (plus the changes); when it can't be built (a custom service without a model name, say) the reason is given,
   * and the home page picker and model page presets say so honestly
   */
  function routeOrProblem(settings, mode, changes = {}) {
    try {
      return routeOf(patchSettings(settings, changes), mode);
    } catch (error) {
      return { problem: problemOf(error) };
    }
  }

  /** A vendor's description for settings, with where its key is (env / stored / null, without decrypting) */
  function describeVendor(found) {
    const sources = service ? keys.sources() : {};
    return {
      id: found.id,
      name: found.name,
      keyEnv: found.keyEnv,
      key: sources[found.id] ?? null,
      hasKeyPage: Boolean(found.keyPage),
      defaultModel: found.defaultModel ?? null,
      // Models to choose from: { id, name, maker }
      models: found.models ?? [],
    };
  }

  /**
   * Each mode's own settings: which is in use, which model native chose, what local's two steps chose, which on-device model private chose.
   * Modes not in use are listed too: their settings can be changed first and apply once switched to
   */
  function describeModes() {
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    let freeBytes = null;
    try {
      freeBytes = freeBytesAt(PATHS.modelsDir);
    } catch (error) {
      log.warn("disk_space_unknown", { error: String(error) });
    }
    return {
      mode: { value: service?.route.mode ?? ROUTE.mode, choices: MODES.map(({ id }) => id) },
      native: { model: settings.model.value, providers: PROVIDERS.map(describeVendor) },
      private: { transcriber: settings.privateTranscriber.value },
      local: {
        transcriber: settings.transcriber.value,
        transcribers: MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          // Who made it; the UI picks the icon by it
          maker: makerOf(model),
          license: model.license.name,
          bytes: downloadSize(model),
          // Downloaded or not, how far a download is, how much a half download has, why the last one failed
          ...localModels.status(model.id),
          tags: tagsOn(model, CHIP),
          // Measurements on this kind of chip, fastest first; empty when never measured
          measured: measuredOn(model, CHIP),
        })),
        chip: CHIP,
        // Free space on the model directory's disk; null when it can't be checked
        freeBytes,
        // Where on-device models download from: changeable in any mode
        source: { value: settings.modelSource.value, choices: SOURCES.map(({ id }) => id) },
        // Whether on-device models use the GPU: the value in effect (the environment's when overridden)
        acceleration: { value: acceleration, choices: ACCELERATIONS },
        polish: settings.polish.value,
        customUrl: settings.customUrl.value,
        vendors: CHAT_VENDORS.map(describeVendor),
        // Ollama's state for the cleanup model, when local cleanup is Ollama (refreshOllama)
        ollama,
      },
    };
  }

  // ---------- Ollama: cleanup on this computer ----------

  /**
   * Ollama as the setup screens see it, for the model local cleanup uses: unknown (not checked yet, or local cleanup isn't Ollama) / stopped (not running) /
   * missing (the model isn't pulled) / pulling (download carries progress) / ready. problem is why the last pull failed.
   * Checked on demand (setup screens ask, after a pull), never polled
   */
  let ollama = { state: "unknown", model: null, download: null, problem: null };
  const OLLAMA = findChatVendor("ollama");
  /** The Ollama model the settings' local cleanup uses; null when local cleanup is another service */
  function ollamaModel() {
    const choice = parseChatChoice(resolveSettings({ file: PATHS.settingsFile, env: process.env }).polish.value);
    return choice.vendor === OLLAMA.id ? choice.model : null;
  }
  async function refreshOllama() {
    const model = ollamaModel();
    if (model === null) ollama = { state: "unknown", model: null, download: null, problem: null };
    else if (!(ollama.state === "pulling" && ollama.model === model)) {
      const { running, pulled } = await ollamaStatus({ baseUrl: OLLAMA.baseUrl, model });
      const problem = ollama.model === model && !pulled ? ollama.problem : null;
      ollama = { state: !running ? "stopped" : pulled ? "ready" : "missing", model, download: null, problem };
      // Ollama works now: if cleanup was off because of it, check again so the note clears
      if (ollama.state === "ready") reverifyKeyInBackground();
    }
    setupChanged();
    return ollama;
  }
  /** Pulls the model local cleanup uses into Ollama, in the background; progress shows in the setup state. Once pulled, cleanup is checked again */
  function pullOllama() {
    const model = ollamaModel();
    if (model === null) return { ok: false, problem: msg("ollama.notInUse") };
    if (ollama.state === "pulling") return { ok: true };
    ollama = { state: "pulling", model, download: { received: 0, total: 0 }, problem: null };
    setupChanged();
    let toldAt = 0;
    pullModel({
      baseUrl: OLLAMA.baseUrl,
      model,
      onProgress: (download) => {
        ollama = { ...ollama, download };
        // A pull reports many times a second: tell the windows at most twice a second
        if (Date.now() - toldAt < 500) return;
        toldAt = Date.now();
        setupChanged();
      },
    }).then(
      () => {
        log.info("ollama_pulled", { model });
        ollama = { state: "ready", model, download: null, problem: null };
        setupChanged();
        reverifyKeyInBackground();
      },
      async (error) => {
        log.warn("ollama_pull_failed", { model, error: String(error?.message ?? error) });
        ollama = { state: "missing", model, download: null, problem: problemOf(error) };
        await refreshOllama();
      },
    );
    return { ok: true };
  }
  handle("ollama:check", () => refreshOllama());
  handle("ollama:pull", () => pullOllama());
  handle("ollama:get-it", () => shell.openExternal("https://ollama.com/download"));

  /** These belong to the mode layer; unavailable when connected to a separately started server */
  const viaModes = (action) => (modes ? action(modes) : { ok: false, problem: msg("key.externalModel") });

  // Saving and deleting keys in settings and with whisprflow key go through the same place.
  // Saving another vendor's key can carry settings to switch to with it (changes), used for verification: the custom service has no default model, so the model name must come along
  handle("setup:save-key", (_event, value, id, changes) =>
    keys.save(value, {
      provider: id ?? keys.provider?.id,
      ...(id && changes && modes ? { route: modes.routeForVendor(id, changes) } : {}),
    }),
  );
  handle("setup:forget-key", (_event, id) => keys.forget({ provider: id ?? keys.provider?.id }));
  // The "Check" in settings: works in any mode, checking the settings chosen on the page (not yet switched to)
  handle("setup:check-model", (_event, mode, changes) => viaModes((m) => m.check(mode, changes ?? {})));
  // The mode layer, and the models within each mode: separate tasks
  // Switching modes can carry that mode's own settings (changes), such as going straight to a custom service on first entering local.
  // A choice switches at once; anything missing (key, download) is recorded in the state, never blocking (app/modes.mjs)
  handle("setup:set-mode", (_event, mode, changes) => viaModes((m) => m.switchMode(mode, changes ?? {})));
  handle("setup:set-model", (_event, model) => viaModes((m) => m.setModel(model)));
  handle("setup:set-transcriber", (_event, id) => viaModes((m) => m.setTranscriber(id)));
  handle("setup:set-polish", (_event, polish, customUrl) =>
    viaModes((m) => m.setPolish(polish, customUrl === undefined ? {} : { customUrl })),
  );
  // On-device models: downloads, cancels, and deletes are user actions; the one in use can't be deleted (the mode layer decides)
  handle("setup:download-model", (_event, id) => localModels.download(id));
  handle("setup:cancel-download", (_event, id) => {
    localModels.cancel(id);
    return { ok: true };
  });
  handle("setup:delete-model", (_event, id) => viaModes((m) => m.removeModel(id)));
  // Checking an on-device model: a sentence in the UI language is spoken for it to transcribe
  handle("setup:check-transcriber", (_event, id) => viaModes((m) => m.checkTranscriber(id, { locale })));
  handle("setup:read-clipboard", () => clipboard.readText());
  handle("setup:open-key-page", (_event, id) => {
    // The custom service has no page for getting a key
    const { keyPage } = findVendor(id) ?? provider() ?? {};
    if (!keyPage) throw new TypeError(`${id} has no page for getting a key`);
    return shell.openExternal(keyPage);
  });

  handle("setup:open-privacy", async (_event, permission) => {
    if (!Object.hasOwn(PRIVACY_PANES, permission)) throw new TypeError(`Unknown permission: ${permission}`);
    // If the microphone was never asked for, the app isn't in the System Settings list yet: the system must prompt once first (only macOS has this prompt)
    if (
      !WINDOWS &&
      permission === "microphone" &&
      systemPreferences.getMediaAccessStatus("microphone") === "not-determined"
    ) {
      await systemPreferences.askForMediaAccess("microphone");
      setupChanged();
      return;
    }
    await shell.openExternal(PRIVACY_PANES[permission]);
  });
  /** The helper checks the two system permissions when it starts, so it must restart to see a grant. If it stopped, this also brings it back */
  function recheckPermissions() {
    if (!e2e) {
      helper.stop();
      launchHelper({ prompt: false });
    }
    setupChanged();
  }
  /** Verifies again in the background a key enabled while offline at startup. Not awaited: offline, the wait can take tens of seconds */
  function reverifyKeyInBackground() {
    keys.reverify().catch((error) => log.error("key_reverify_failed", { error: String(error?.stack ?? error) }));
  }
  handle("setup:recheck", () => {
    recheckPermissions();
    reverifyKeyInBackground();
  });
  handle("setup:set-open-at-login", (_event, enabled) => {
    if (!app.isPackaged && !INSTALLED_ON_WINDOWS)
      throw new Error("Launch at login can't be set when started from a terminal");
    app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: Boolean(enabled) });
    log.info("open_at_login", { enabled: Boolean(enabled) });
    setupChanged();
  });
  handle("setup:set-hotkey", (_event, wanted) => setHotkey(wanted));
  handle("setup:set-theme", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "theme", wanted);
    reloadTheme();
    setupChanged();
    // Like the hotkey: when overridden by the environment it is saved but nothing changes now, which deserves a note
    const variable = overridingEnv("theme", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-model-source", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "modelSource", wanted);
    reloadModelSource();
    const variable = overridingEnv("modelSource", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-acceleration", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "acceleration", wanted);
    acceleration = resolveSettings({ file: PATHS.settingsFile, env: process.env }).acceleration.value;
    log.info("acceleration_changed", { acceleration });
    // A loaded on-device model is reloaded with the new setting
    service?.setAcceleration(acceleration);
    setupChanged();
    const variable = overridingEnv("acceleration", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  // Whether the hint above the bar shows: saved, and an open bar follows at once
  handle("setup:set-bar-hint", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "barHint", wanted);
    const barHint = currentBarHint();
    log.info("bar_hint_changed", { barHint });
    tellBar("bar:hint", barHint);
    setupChanged();
    const variable = overridingEnv("barHint", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-language", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "language", wanted);
    // Changed on the "General" page in settings: the main window returns to that page after switching languages
    reloadLanguage({ hubTarget: { pane: "general" } });
    const variable = overridingEnv("language", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });

  /**
   * Rereads the download source from settings and hands it to the model library: current downloads continue from the new source, and later ones use it too. No restart
   * @returns {{ modelSource: string }} the one actually in use (the environment's when overridden)
   */
  function reloadModelSource() {
    const { value } = resolveSettings({ file: PATHS.settingsFile, env: process.env }).modelSource;
    localModels.setSource(value);
    setupChanged();
    return { modelSource: value };
  }

  /**
   * Rereads the language from settings and switches at once if it changed: the menu bar redraws, the main window and onboarding reload (every word on the page in the new language),
   * and the bar swaps its translator so the next hint is in the new language. No restart
   * @param {{ hubTarget?: object }} [options] where the main window goes after reloading; stays put when not given
   */
  function reloadLanguage({ hubTarget } = {}) {
    languageSetting = resolveSettings({ file: PATHS.settingsFile, env: process.env }).language.value;
    const next = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
    if (next !== locale) {
      locale = next;
      t = createTranslator(locale);
      refreshTrayMenu();
      tellBar("locale:changed", locale);
      if (hubWindow !== null) {
        if (hubTarget) hubWindow.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query: hubTarget });
        else hubWindow.webContents.reload();
      }
      if (onboardingWindow) {
        // After reloading it starts over: if it was on the hotkey test step, stop handing it the hotkey; it asks again when it gets there
        hotkeyToOnboarding = false;
        onboardingWindow.webContents.reload();
      }
      log.info("language_changed", { language: languageSetting, locale });
    }
    return { language: languageSetting, locale };
  }

  /**
   * Changes the hotkey at once: saved to settings, the helper restarted to listen for the new key, and the bar hint and menu bar follow. No app restart
   * @returns {{ note?: object }} a note (msg) when there is something to say (overridden by the environment)
   */
  function setHotkey(wanted) {
    if (!HOTKEY_IDS.includes(wanted)) throw new TypeError(`Unknown hotkey: ${wanted}`);
    saveSetting(PATHS.settingsFile, "hotkey", wanted);
    if (wanted !== hotkey) {
      hotkey = wanted;
      log.info("hotkey_changed", { hotkey });
      // Like rechecking permissions: stop the old one before starting the new, and the old one's exit events are voided by generation
      if (!e2e) {
        helper.stop();
        launchHelper({ prompt: false });
      }
      tellBar("bar:hotkey", hotkey);
      historyChanged();
      setupChanged();
    }
    const variable = overridingEnv("hotkey", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  // ---------- Menu bar, main window, and onboarding ----------

  /**
   * Opens the main window (or brings it forward if open), optionally at a given page.
   * @param {{ route?: "home" | "history", pane?: string }} [target] pane: which settings page; "auto" is the page where something is missing
   */
  function showHub(target = {}) {
    if (hubWindow === null) {
      hubWindow = createHub(target);
    } else if (target.route || target.pane) {
      hubWindow.webContents.send("hub:navigate", target);
    }
    hubWindow.show();
    // This app has no Dock icon; without asking for focus the window opens behind other apps
    app.focus({ steal: true });
  }

  function createHub(target) {
    const window = new BrowserWindow({
      ...HUB_SIZE,
      title: "WhisprFlow",
      backgroundColor: windowBackground(),
      // The title bar is hidden, with the traffic lights at the top left of the sidebar
      ...frame({ x: 26, y: 24 }),
      webPreferences,
    });
    setTaskbarDetails(window);
    // Where the first open goes is in the address: messages sent before the page loads are lost
    const query = Object.fromEntries(Object.entries(target).filter(([, value]) => value));
    window.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query });
    window.on("focus", () => {
      // Reread when it comes back: a window left open overnight needs "today" to be the new day, and after changing permissions in System Settings the state refreshes
      window.webContents.send("history:changed");
      window.webContents.send("setup:changed");
    });
    window.on("closed", () => {
      hubWindow = null;
    });
    return window;
  }

  /** Onboarding: the same size as the main window, with the traffic lights in the same place */
  function showOnboarding() {
    if (onboardingWindow === null) {
      onboardingWindow = new BrowserWindow({
        ...HUB_SIZE,
        title: "WhisprFlow",
        backgroundColor: windowBackground(),
        ...frame({ x: 20, y: 16 }),
        webPreferences,
      });
      setTaskbarDetails(onboardingWindow);
      onboardingWindow.loadFile(join(sourceDir, "renderer", "onboarding", "onboarding.html"));
      onboardingWindow.on("focus", () => {
        // The user most likely turned on a switch in System Settings and came back: the two permissions need a helper restart to show.
        // When both are granted it doesn't restart, so testing the hotkey and speaking aren't interrupted for nothing
        const { listen, trusted } = helperPermissions ?? {};
        if (listen !== true || trusted !== true) recheckPermissions();
        else setupChanged();
      });
      onboardingWindow.on("closed", () => {
        onboardingWindow = null;
        hotkeyToOnboarding = false;
      });
      // A crashed page will never say "done testing"
      onboardingWindow.webContents.on("render-process-gone", (_event, details) => {
        log.error("onboarding_gone", { reason: details.reason });
        hotkeyToOnboarding = false;
      });
    }
    onboardingWindow.show();
    app.focus({ steal: true });
  }

  ipcMain.on("onboarding:capture-hotkey", (_event, capturing) => {
    hotkeyToOnboarding = capturing === true;
  });
  handle("onboarding:finish", () => {
    log.info("onboarding_finished");
    onboardingWindow?.close();
    showHub({ route: "home" });
  });

  /** When the menu bar or a double-click should open WhisprFlow: back to onboarding if it isn't finished, otherwise the main window */
  const showMain = () => (onboardingWindow ? showOnboarding() : showHub());

  const trayIcon = nativeImage.createFromPath(TRAY_ICON);
  const tray = new Tray(trayIcon);
  tray.setToolTip("WhisprFlow");
  // If the icon can't be read the menu bar shows an empty slot and there's no way in. Fall back to two letters, and log it
  if (trayIcon.isEmpty()) {
    log.error("tray_icon_missing", { path: TRAY_ICON });
  }

  function refreshTrayMenu() {
    if (trayIcon.isEmpty()) tray.setTitle(t("tray.fallbackTitle"));
    const summary = summarizeSetup(currentSetup());
    const headline = summary.ready
      ? t("tray.ready", { keycap: t(`hotkeys.${hotkey}.keycap`) })
      : summary.missing.length > 0
        ? t("tray.missing", { items: t.list(summary.missing) })
        : t("tray.preparing");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: headline, enabled: false },
        ...(summary.degraded ? [{ label: t.text(summary.degraded), enabled: false }] : []),
        { type: "separator" },
        // The menu items below
        { label: t("tray.open"), click: () => showHub({ route: "home" }) },
        { label: t("tray.history"), click: () => showHub({ route: "history" }) },
        { type: "separator" },
        { label: t("tray.settings"), accelerator: "CmdOrCtrl+,", click: () => showHub({ pane: "general" }) },
        { type: "separator" },
        { label: t("tray.version", { version: app.getVersion() }), enabled: false },
        { label: t("tray.quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  }
  // On Windows clicking the notification area icon opens the main window (right-click is the menu); on macOS clicking it is the menu
  if (WINDOWS) tray.on("click", () => showMain());
  refreshTrayMenu();
  localModelChanged = () => setupChanged();

  // With no windows it stays in the menu bar
  app.on("window-all-closed", () => {});
  // Started again while already running. From a double-click: bring the main window forward so people see where it is.
  // From the whisprflow command (two commands at once, this one second): that person is watching the terminal, so no window
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    if (!additionalData?.byCli) showMain();
  });
  app.on("before-quit", () => {
    rmSync(PATHS.pidFile, { force: true });
    // Void the helper's events first: its coming exit is ours, and shouldn't report "key listening stopped"
    helperGeneration++;
    helper.stop();
    history.close();
    localModels.close();
    // The app is quitting, so these two closing uncleanly doesn't stop it; log it for troubleshooting
    service?.close().catch((error) => log.warn("service_close_failed", { error: String(error) }));
    control?.close().catch((error) => log.warn("control_close_failed", { error: String(error) }));
  });

  // ---------- Errands the CLI asks of the main process ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Waits until the helper reports the two permissions, or it is clear it can't start; at most 3 seconds */
  async function helperReported() {
    for (let waited = 0; helperState === "starting" && waited < 3_000; waited += 50) await sleep(50);
  }

  /** Translate in the language the CLI states; when it states none, use the UI language */
  const translatorFor = (wanted) => (wanted ? createTranslator(wanted) : t);
  /** Translates the problem sentence in results for the CLI to text: the CLI and --json readers only take text */
  const withProblemText = (result, say) => {
    if (!result) return result;
    const translated = { ...result };
    if (result.problem) translated.problem = say.text(result.problem);
    if (result.note) translated.note = say.text(result.note);
    return translated;
  };

  /** The status for the CLI. Every sentence for people is translated to text in say's language; see summaryAsText for why */
  function describeStatus(say) {
    const setup = currentSetup();
    const route = service?.route ?? null;
    const native = route?.mode === "native";
    return {
      pid: process.pid,
      version: app.getVersion(),
      startedAt,
      // At startup it is ready only once the key is verified and the microphone prompt has an answer
      starting: !startupChecked,
      hotkey,
      // The CLI uses this to name the hotkey
      hotkeyLabel: say(`hotkeys.${hotkey}.name`),
      // When connected to a separately started server, that server decides the model
      provider: service ? (keys.provider?.id ?? null) : null,
      // Where each vendor's key is; the CLI needs this to know
      keys: service ? keys.sources() : null,
      // The mode and what each uses. model and thinking describe native only, as CLI readers expect
      mode: route?.mode ?? null,
      model: native ? formatModelChoice(route.model) : null,
      thinking: native ? thinkingFor(keys.provider) : null,
      // local's step one and private's on-device model
      transcriber: route?.mode === "local" || route?.mode === "private" ? route.transcriber : null,
      polish: route?.mode === "local" ? formatChatChoice(route.polish) : null,
      theme: theme.id,
      acceleration,
      // The language setting (system follows the system) and the one in use
      language: languageSetting,
      locale,
      // The packaged app and the command-started one have separate permissions and keys: the CLI uses this to decide whether to restart it on its behalf
      packaged: app.isPackaged,
      ...setup,
      key: withProblemText(setup.key, say),
      localModel: setup.localModel && withProblemText(setup.localModel, say),
      // Whether each on-device model is downloaded and how far (the CLI shows download progress with it)
      localModels: localModels.list().map((model) => withProblemText(model, say)),
      summary: summaryAsText(summarizeSetup(setup), say),
    };
  }

  // No control channel during end-to-end tests: they drive the whole flow themselves, with no CLI involved
  control = e2e
    ? null
    : await startControlServer({
        socketPath: PATHS.controlSocket,
        log,
        handlers: {
          /** recheck: look again at the things that change on their own before answering (right after System Settings changes or the network returns) */
          async status({ recheck = false, locale: wanted }) {
            if (recheck) {
              const denied = Object.values(helperPermissions ?? {}).includes(false);
              if (denied || helperState === "stopped") recheckPermissions();
              reverifyKeyInBackground();
            }
            await helperReported();
            return describeStatus(translatorFor(wanted));
          },
          // Without provider it means the vendor in use. changes: settings to switch to along with it (given when saving a key before switching modes
          // or models), used for verification; the custom service has no default model, so it can't be verified without them
          "set-key": async ({ key, provider, changes, locale: wanted }) => {
            const say = translatorFor(wanted);
            let route;
            try {
              route = provider && changes && modes ? modes.routeForVendor(provider, changes) : undefined;
            } catch (error) {
              return { ok: false, problem: say.text(problemOf(error)) };
            }
            return withProblemText(await keys.save(key, { provider, route }), say);
          },
          // The mode layer, and the models within each mode. All switch at once, no restart
          "set-mode": async ({ mode, changes, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.switchMode(mode, changes ?? {})), translatorFor(wanted)),
          "set-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setModel(model)), translatorFor(wanted)),
          "set-transcriber": async ({ transcriber, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setTranscriber(transcriber)), translatorFor(wanted)),
          "set-polish": async ({ polish, customUrl, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.setPolish(polish, customUrl === undefined ? {} : { customUrl })),
              translatorFor(wanted),
            ),
          "forget-key": ({ provider } = {}) => keys.forget({ provider }),
          // native's model and local's cleanup each check on their own
          "check-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.check("native", { model })), translatorFor(wanted)),
          // Whether a mode works with changed settings (a cloud step one, private mode)
          "check-mode": async ({ mode, changes, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.check(mode, changes ?? {})), translatorFor(wanted)),
          "check-polish": async ({ polish, customUrl, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.check("local", customUrl === undefined ? { polish } : { polish, customUrl })),
              translatorFor(wanted),
            ),
          "reload-theme": reloadTheme,
          "reload-language": () => reloadLanguage(),
          "reload-model-source": () => reloadModelSource(),
          // On-device models: downloads run in the background; progress is in status localModels
          "download-model": async ({ id, locale: wanted }) =>
            withProblemText(await localModels.download(id), translatorFor(wanted)),
          "cancel-download": ({ id }) => {
            localModels.cancel(id);
            return { ok: true };
          },
          "delete-model": async ({ id, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.removeModel(id)), translatorFor(wanted)),
          // The spoken sentence follows the CLI's language
          "check-transcriber": async ({ id, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.checkTranscriber(id, { locale: wanted ?? locale })),
              translatorFor(wanted),
            ),
          // CLI command names keep the older window names: show-settings opens the settings page where something is missing,
          // and on first launch the CLI adds onboarding to open the onboarding window
          "show-settings": ({ onboarding = false }) => (onboarding ? showOnboarding() : showHub({ pane: "auto" })),
          "show-history": () => showHub({ route: "history" }),
          // Send this answer before quitting
          quit: () => void setImmediate(() => app.quit()),
        },
      });

  // ---------- Startup checks ----------

  const keyLoaded = keys.loadAtStartup();
  // Whether Ollama runs and has the cleanup model: the setup screens show it, and onboarding offers to pull the model
  refreshOllama().catch((error) => log.warn("ollama_check_failed", { error: String(error?.message ?? error) }));
  if (e2e) {
    const loaded = await keyLoaded;
    if (loaded.state !== "ready")
      throw new Error(`End-to-end tests need a working key: ${t.text(loaded.problem) || loaded.state}`);
    await e2e.run({
      bar,
      history,
      localModel: () => service?.localModel,
      downloadModel: (id) => localModels.download(id),
      quit: (code) => app.exit(code),
    });
    return;
  }

  const granted = await askMicrophone();
  log.info("microphone_access", { granted });
  await keyLoaded;
  startupChecked = true;
  setupChanged();
  offerSettingsIfIncomplete();
  if (screens) {
    await screens.runScreens({
      showOnboarding,
      onboardingWindow: () => onboardingWindow,
      showHub,
      hubWindow: () => hubWindow,
      quit: (code) => app.exit(code),
    });
    return;
  }
  // Double-clicking the app icon while it's running doesn't start another; the system "reopens" this one: bring the main window forward the same way.
  // Attached only after the startup checks, so startup itself doesn't count as a reopen
  app.on("activate", showMain);
}
