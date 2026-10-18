// Recommended setups beside the model page title. A preset is "which recognition mode to switch to, with which of that mode's
// settings", exactly the parameters mode switching takes (switchMode in app/modes.mjs): enabling one switches and saves on the spot,
// and any missing key or download is reported as usual through that same path.
// Ordered by recommendation; chips lists the chips it suits (CHIPS in catalog.mjs), absent means any chip.
// Monthly cost is not written here: it is computed from the price list (usage/estimate.mjs), so it follows price changes.
//
// To add one: add an entry here and presets.items.<id> name and desc in the messages. To remove one: delete both.
// test/models/presets.test.mjs checks that referenced models are listed, settings belong to the mode, cost is computable, and wording exists.
// The page shows them as a dropdown list (renderer/hub/preset-picker.mjs).

export const PRESETS = Object.freeze(
  [
    {
      id: "local-qwen",
      mode: "local",
      settings: { transcriber: "qwen3-asr-0.6b-q8", polish: "ollama/qwen3:4b-instruct" },
      chips: ["apple-silicon", "windows-x64"],
    },
    {
      id: "native-gemini",
      mode: "native",
      settings: { model: "gemini/gemini-3.6-flash" },
    },
    {
      id: "native-openai",
      mode: "native",
      settings: { model: "openai/gpt-audio-mini" },
    },
    {
      id: "private-qwen",
      mode: "private",
      settings: { privateTranscriber: "qwen3-asr-0.6b-q8" },
      chips: ["apple-silicon", "windows-x64"],
    },
    // Intel Macs have no GPU path for transcribe.cpp: the CPU build of the same model
    {
      id: "local-qwen-cpu",
      mode: "local",
      settings: { transcriber: "qwen3-asr-0.6b-int8", polish: "ollama/qwen3:4b-instruct" },
      chips: ["intel-mac"],
    },
    {
      id: "private-qwen-cpu",
      mode: "private",
      settings: { privateTranscriber: "qwen3-asr-0.6b-int8" },
      chips: ["intel-mac"],
    },
  ].map((preset) =>
    Object.freeze({ ...preset, settings: Object.freeze(preset.settings), chips: Object.freeze(preset.chips ?? null) }),
  ),
);

/** Presets that suit this chip, in recommended order */
export const presetsFor = (chip) => PRESETS.filter(({ chips }) => chips === null || chips.includes(chip));
