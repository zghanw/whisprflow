// Every main process capability the pages can call is listed here. Pages themselves have no access to Node or Electron APIs.
// Preload scripts in the sandbox can only use CommonJS.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Themes: page styles only reference colors through var(--...), with values supplied by the main process for the current theme (src/themes).
// Fetched synchronously and injected at once, before the page's first frame. When the theme changes later the main process sends a new set: the new one goes on before the old one comes off,
// so no frame is ever drawn without colors.
let themeKey = webFrame.insertCSS(ipcRenderer.sendSync("theme:get"));
ipcRenderer.on("theme:changed", (_event, css) => {
  const previous = themeKey;
  themeKey = webFrame.insertCSS(css);
  webFrame.removeInsertedCSS(previous);
});

// Interface language: also fetched synchronously, so the page writes text in it as soon as it loads (src/renderer/shared/i18n.mjs). When the language changes in settings,
// the main window and onboarding reload entirely; the floating bar doesn't (it may be mid-dictation) and swaps its translations when the new language arrives
const locale = ipcRenderer.sendSync("locale:get");

contextBridge.exposeInMainWorld("whisprflow", {
  locale,
  // Which system: used for copy that differs by system (src/i18n) and window elements placed by system (data-platform on html)
  platform: process.platform,
  onLocaleChanged: (callback) => ipcRenderer.on("locale:changed", (_event, next) => callback(next)),
  config: () => ipcRenderer.invoke("config:get"),

  // Floating bar
  onInput: (callback) => ipcRenderer.on("input", (_event, payload) => callback(payload)),
  onNotice: (callback) => ipcRenderer.on("notice", (_event, message) => callback(message)),
  onBarControls: (callback) => ipcRenderer.on("bar:controls", (_event, enabled) => callback(enabled)),
  setBarVisible: (visible) => ipcRenderer.send("bar:set-visible", visible),
  captureBarInput: (regions) => ipcRenderer.send("bar:capture", regions),
  deliver: (payload) => ipcRenderer.invoke("dictation:deliver", payload),
  reportFailure: (payload) => ipcRenderer.invoke("dictation:failed", payload),

  onHotkeyChanged: (callback) => ipcRenderer.on("bar:hotkey", (_event, hotkey) => callback(hotkey)),
  onBarHint: (callback) => ipcRenderer.on("bar:hint", (_event, value) => callback(value)),

  // Main window: Home, History
  appInfo: () => ipcRenderer.invoke("app:info"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  usageReport: () => ipcRenderer.invoke("usage:report"),
  insights: () => ipcRenderer.invoke("insights:get"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  onHistoryChanged: (callback) => ipcRenderer.on("history:changed", () => callback()),
  onNavigate: (callback) => ipcRenderer.on("hub:navigate", (_event, target) => callback(target)),
  openHomepage: () => ipcRenderer.invoke("app:open-homepage"),

  // Main window: Settings
  getSetup: () => ipcRenderer.invoke("setup:get"),
  // The user's dictionary: preferred spellings, also learned into after on-device cleanup
  getDictionary: () => ipcRenderer.invoke("dictionary:get"),
  setDictionary: (terms) => ipcRenderer.invoke("dictionary:set", terms),
  onSetupChanged: (callback) => ipcRenderer.on("setup:changed", () => callback()),
  // Without provider it is the one in use; when saving for another provider, changes are the settings to switch to along with it, used for the check
  saveKey: (key, provider, changes) => ipcRenderer.invoke("setup:save-key", key, provider, changes),
  forgetKey: (provider) => ipcRenderer.invoke("setup:forget-key", provider),
  // Whether a mode works with the changed settings: a minimal request with that provider's key, without replacing what is in use
  checkModel: (mode, changes) => ipcRenderer.invoke("setup:check-model", mode, changes),
  // The mode layer, and the models within each mode (src/app/modes.mjs)
  setMode: (mode, changes) => ipcRenderer.invoke("setup:set-mode", mode, changes),
  setModel: (model) => ipcRenderer.invoke("setup:set-model", model),
  setTranscriber: (id) => ipcRenderer.invoke("setup:set-transcriber", id),
  setPolish: (polish, customUrl) => ipcRenderer.invoke("setup:set-polish", polish, customUrl),
  setModelSource: (id) => ipcRenderer.invoke("setup:set-model-source", id),
  setAcceleration: (id) => ipcRenderer.invoke("setup:set-acceleration", id),
  // On-device models: downloaded only when the user asks; cancel, delete (the one in use can't be deleted)
  downloadModel: (id) => ipcRenderer.invoke("setup:download-model", id),
  cancelDownload: (id) => ipcRenderer.invoke("setup:cancel-download", id),
  deleteModel: (id) => ipcRenderer.invoke("setup:delete-model", id),
  // Checking an on-device model: transcribe one spoken sentence to see that it produces text
  checkTranscriber: (id) => ipcRenderer.invoke("setup:check-transcriber", id),
  readClipboard: () => ipcRenderer.invoke("setup:read-clipboard"),
  openKeyPage: (provider) => ipcRenderer.invoke("setup:open-key-page", provider),
  openPrivacySettings: (permission) => ipcRenderer.invoke("setup:open-privacy", permission),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("setup:set-open-at-login", enabled),
  setHotkey: (hotkey) => ipcRenderer.invoke("setup:set-hotkey", hotkey),
  setBarHint: (value) => ipcRenderer.invoke("setup:set-bar-hint", value),

  // Onboarding
  captureHotkey: (capturing) => ipcRenderer.send("onboarding:capture-hotkey", capturing),
  onOnboardingHotkey: (callback) => ipcRenderer.on("onboarding:hotkey", (_event, key) => callback(key)),
  finishOnboarding: () => ipcRenderer.invoke("onboarding:finish"),
  setTheme: (theme) => ipcRenderer.invoke("setup:set-theme", theme),
  setLanguage: (language) => ipcRenderer.invoke("setup:set-language", language),
});
