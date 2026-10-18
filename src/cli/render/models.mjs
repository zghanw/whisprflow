import { parseModelChoice } from "../../server/providers/index.mjs";
import { SETTINGS } from "../../storage/settings.mjs";
import { sourceOf } from "./settings.mjs";
import { displayWidth, INDENT, padEnd, paint } from "./text.mjs";

// Models (whisprflow model): which providers there are, which model each uses, whether keys exist, and which is in use.

/** Where a provider's key is, and how to say it */
const KEY_STATES = {
  stored: (t) => t("cli.models.keyStored"),
  env: (t, provider) => t("cli.models.keyEnv", { variable: provider.keyEnv }),
};

/**
 * @param {object} view
 * @param {ReadonlyArray<{ id: string, name: string, keyEnv: string, defaultModel: string }>} view.providers
 * @param {{ value: string, source: "env" | "file" | "default", env?: string }} view.setting the current model setting
 * @param {Record<string, "stored" | "env" | null>} view.keys where each provider's key is: stored, from an environment variable, or none
 * @param {{ color: boolean, t: Function }} options
 */
export function renderModels({ providers, setting, keys }, { color, t }) {
  const c = paint(color);
  const current = parseModelChoice(setting.value);
  const rows = providers.map((provider) => {
    const inUse = provider.id === current.provider;
    return {
      provider,
      inUse,
      model: inUse ? current.model : t("cli.models.default", { model: provider.defaultModel }),
      key: KEY_STATES[keys[provider.id]]?.(t, provider) ?? t("cli.models.noKey"),
    };
  });
  const idWidth = Math.max(...providers.map(({ id }) => id.length)) + 3;
  const nameWidth = Math.max(...providers.map(({ name }) => displayWidth(name))) + 3;
  const modelWidth = Math.max(...rows.map(({ model }) => displayWidth(model))) + 3;

  const lines = [t("cli.models.title"), ""];
  for (const { provider, inUse, model, key } of rows) {
    const mark = inUse ? c.green("●") : " ";
    const keyText = keys[provider.id] ? key : c.dim(key);
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(provider.id, idWidth))}${padEnd(provider.name, nameWidth)}${padEnd(model, modelWidth)}${keyText}`,
    );
  }
  const name = providers.find(({ id }) => id === current.provider).name;
  const other = providers.find(({ id }) => id !== current.provider) ?? providers[0];
  lines.push(
    "",
    `${INDENT}${t("cli.models.current", { provider: name, model: current.model, source: sourceOf(SETTINGS.model, setting) })}`,
    `${INDENT}${t("cli.models.switch", { id: other.id })}`,
    `${INDENT}${t("cli.models.pick", { id: other.id, model: other.defaultModel })}`,
    `${INDENT}${t("cli.models.check")}`,
    "",
  );
  return lines.join("\n");
}
