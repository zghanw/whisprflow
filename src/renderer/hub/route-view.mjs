import { brand, h, platformName } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";

// How a route is drawn (shared by Home's recognition mode menu and the model page's presets): the models along it, and what is missing before switching.
// The data is assembled by the main process (wayOf in app/model-plaza.mjs): hops in order, needs are missing keys, on-device models not downloaded, and addresses not entered.

/**
 * The models along a route: icon plus name, each wrapping together with the arrow before it (an arrow is never left alone at a line end); hovering says which platform
 * @param {Array<{ platform: string, maker: string | null, name: string }>} hops
 * @param {(id: string) => { id: string, name: string }} platformOf platform id to platform (its row in the key table)
 */
export function hopChain(hops, platformOf) {
  if (hops.length === 0) return null;
  return h(
    "span",
    { class: "hops" },
    hops.map(({ platform, maker, name }, index) => {
      const where = platform === "local" ? t("plaza.via.local") : platformName(platformOf(platform));
      const text = platform === "custom" ? `${t("plaza.custom.name")} · ${name}` : name;
      return h(
        "span",
        { class: "hop", title: `${text} · ${where}` },
        index > 0 && h("span", { class: "hop-arrow", "aria-hidden": "true", text: "→" }),
        brand(maker ?? platform),
        h("span", { class: "hop-name", text }),
      );
    }),
  );
}

/**
 * One missing thing, as a short phrase: "OpenAI key not set", "Qwen3-ASR 0.6B (Q8_0) not downloaded", "...downloading 40%"
 * @param {{ kind: "key" | "download" | "url", platform?: string, model?: string }} need
 * @param {{ hops: Array<object>, platformOf: (id: string) => object, downloadOf?: (id: string) => object | null }} way
 *   that route (the on-device model's name when downloading); with downloadOf given, a download in progress shows its percentage
 */
export function needText(need, { hops, platformOf, downloadOf = () => null }) {
  if (need.kind === "key") return t("home.mode.needs.key", { platform: platformName(platformOf(need.platform)) });
  if (need.kind === "download") {
    const model = hops.find(({ platform }) => platform === "local")?.name ?? need.model;
    const download = downloadOf(need.model);
    if (!download) return t("home.mode.needs.download", { model });
    const percent = Math.floor((download.received / (download.total || 1)) * 100);
    return t("home.mode.needs.downloading", { model, percent });
  }
  return t("home.mode.needs.url");
}
