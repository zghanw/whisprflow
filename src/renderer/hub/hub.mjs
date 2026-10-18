import { localize, t } from "../shared/i18n.mjs";
import { createHistory } from "./history.mjs";
import { createHome } from "./home.mjs";
import { createModePicker } from "./mode-picker.mjs";
import { createModels } from "./models.mjs";
import { createPresetPicker } from "./preset-picker.mjs";
import { createSettings, fixTarget } from "./settings.mjs";

// The main window. The sidebar switches between Home, Models, and History; Settings is a dialog on top.
// The recognition mode is chosen in the menu beside Home's title (mode-picker.mjs), and each mode's models change on the model page: each can jump to the other.
// Beside the model page's title are the presets (preset-picker.mjs): mode and models change together as a set.
// All data lives in the main process: it tells this window to reread on new entries and new cost records, and when readiness or what is missing changes.

const $ = (id) => document.getElementById(id);
const ROUTES = ["home", "models", "history"];

// Fill in the page's fixed text in the interface language first; the sections below draw themselves
localize();

const home = createHome();
const history = createHistory();
const settings = createSettings({ refresh: refreshSetup });
const models = createModels({
  refresh: refreshSetup,
  pickMode: () => {
    navigate("home");
    $("mode-picker").showPopover();
  },
});
const presetPicker = createPresetPicker({
  refresh: refreshSetup,
  configureKey: (platform) => {
    navigate("models");
    models.show({ tab: "keys", platform });
  },
});
const modePicker = createModePicker({
  refresh: refreshSetup,
  configure: ({ tab, platform }) => {
    navigate("models");
    models.show({ tab, platform });
  },
});

/** The latest status: the banner and settings dialog draw from it */
let setup = null;

function navigate(route) {
  const name = ROUTES.includes(route) ? route : "home";
  for (const page of document.querySelectorAll(".page")) page.hidden = page.dataset.route !== name;
  for (const item of document.querySelectorAll(".nav-item")) {
    if (item.dataset.route === name) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  document.querySelector(".content").scrollTop = 0;
  document.querySelector(".content").removeAttribute("data-scrolled");
  if (name === "models") models.shown();
  if (name === "home") home.shown();
  // Kept in the address: changing language reloads the page and comes back to this page. The pane given at open is removed too, so settings don't pop up again on reload
  window.history.replaceState(null, "", `?route=${name}`);
}

/**
 * The strip along the top: what is still missing before it works, or that it works but degraded. Hidden while preparing and when everything is there.
 * When what is missing belongs to this recognition mode (a key, an on-device model), besides filling it in the mode can be switched: any mode can be chosen at any time
 */
function renderBanner(current) {
  const { summary } = current;
  const banner = $("banner");
  const wayIncomplete =
    ["missing", "unreadable", "rejected"].includes(current.key.state) ||
    ["missing", "failed"].includes(current.localModel?.state);
  $("banner-switch").hidden = !(summary.missing.length > 0 && wayIncomplete && current.switchable);
  if (summary.missing.length > 0) {
    banner.dataset.tone = "problem";
    $("banner-text").textContent = t("hub.missing", { items: t.list(summary.missing) });
  } else if (summary.degraded !== null) {
    banner.dataset.tone = "soft";
    $("banner-text").textContent = t.text(summary.degraded);
  } else {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
}

async function refreshSetup() {
  setup = await window.whisprflow.getSetup();
  renderBanner(setup);
  settings.render(setup);
  models.render(setup);
  modePicker.render(setup);
  presetPicker.render(setup);
  return setup;
}

async function refreshData() {
  try {
    const [rows, usage, insights, app] = await Promise.all([
      window.whisprflow.listHistory(),
      window.whisprflow.usageReport(),
      window.whisprflow.insights(),
      window.whisprflow.appInfo(),
    ]);
    home.render({ insights, usage, app });
    history.render({ rows, app });
  } catch (error) {
    console.error("Failed to read history", error);
    history.showError(error instanceof Error ? error.message : String(error));
  }
}

// ---------- User actions ----------

for (const item of document.querySelectorAll(".nav-item")) {
  item.addEventListener("click", () => navigate(item.dataset.route));
}
$("open-settings").addEventListener("click", () => settings.open("general"));
$("open-about").addEventListener("click", () => settings.open("about"));
/** Fill in what is missing: a missing key goes to the key table on the model page, a missing permission to the permissions page in settings */
function openFix() {
  const target = setup ? fixTarget(setup) : { pane: "general" };
  if (target.route) {
    navigate(target.route);
    models.show({ tab: target.tab });
  } else settings.open(target.pane);
}
$("banner-action").addEventListener("click", openFix);
$("banner-switch").addEventListener("click", () => {
  navigate("home");
  $("mode-picker").showPopover();
});
// Once scrolled, the drag strip at the top turns to glass
const content = document.querySelector(".content");
content.addEventListener("scroll", () => content.toggleAttribute("data-scrolled", content.scrollTop > 4), {
  passive: true,
});

// ---------- From the main process ----------

window.whisprflow.onHistoryChanged(refreshData);
window.whisprflow.onSetupChanged(refreshSetup);
// The menu bar or CLI wants a page opened ("Show history", "Settings...")
window.whisprflow.onNavigate(({ route, pane }) => {
  if (route) navigate(route);
  if (pane === "auto") openFix();
  else if (pane) settings.open(pane);
});

// Which page to open first is written in the address by the main process
const params = new URLSearchParams(location.search);
navigate(params.get("route") ?? "home");
await Promise.all([refreshSetup(), refreshData()]);
if (params.get("pane") === "auto") openFix();
else if (params.get("pane")) settings.open(params.get("pane"));
