// The transcribe.cpp (MIT, built on ggml) adapter: reads GGUF, uses Metal on Apple silicon and Vulkan on Windows automatically,
// falling back to the CPU elsewhere; prebuilt npm packages for both Mac chips (Intel is CPU only), Windows, and Linux. Interface: see index.mjs.

/** Every family is one GGUF file, called gguf in the catalog; the output is clean text with no markers to remove */
const singleGguf = Object.freeze({ config: (file) => file("gguf") });

export const FAMILIES = Object.freeze({
  "qwen3-asr": singleGguf,
});

/**
 * Warm-up sound: 1.5 s of two tones plus a little noise (pure silence makes the runtime compute nothing, so nothing warms up).
 * On a GPU the first transcription must compile the GPU programs first: Vulkan on Windows takes seven or eight seconds the first time (6.8 s measured
 * on an RTX 4060 Ti), after which the driver caches the compiled programs on disk per executable. Transcribing this once at load moves that time into startup,
 * off the first dictation. It yields no text, so it only warms most of the way (decoding still takes two or three extra seconds once); with a cache it takes tens of ms
 */
const WARMUP_SECONDS = 1.5;
const warmupSamples = () => {
  const rate = 16_000;
  return Float32Array.from(
    { length: rate * WARMUP_SECONDS },
    (_, i) =>
      0.1 * Math.sin((2 * Math.PI * 220 * i) / rate) +
      0.05 * Math.sin((2 * Math.PI * 523 * i) / rate) +
      0.02 * (((i * 7919) % 101) / 101 - 0.5),
  );
};

/** No warm-up on the CPU: there is nothing to compile */
const onGpu = (backend) => !/^cpu$/i.test(String(backend ?? ""));

export async function version() {
  const { version } = await import("transcribe-cpp");
  return version().version;
}

/**
 * @param {{ model: object, file: (role: string) => string, options?: { backend?: string, threads?: number } }} request
 *   backend: auto (default, the GPU when there is one), cpu, metal, vulkan, ...; threads: CPU threads, the library default when not given
 * @param {{ runtime?: () => Promise<{ TranscribeModel: object }> }} [deps] replaces the runtime in tests
 * @returns {Promise<{ backend: string, warmupMs: number | null, transcribe: Function, dispose: Function }>}
 *   warmupMs: how long the GPU warm-up took; null on the CPU
 */
export async function load({ model, file, options = {} }, { runtime = () => import("transcribe-cpp") } = {}) {
  const { TranscribeModel } = await runtime();
  const loaded = await TranscribeModel.load(FAMILIES[model.family].config(file), {
    backend: options.backend ?? "auto",
  });
  const session = loaded.createSession({ nThreads: options.threads ?? 0 });
  let warmupMs = null;
  if (onGpu(loaded.backend)) {
    const startedAt = performance.now();
    await session.run(warmupSamples(), { timestamps: "none" });
    warmupMs = Math.round(performance.now() - startedAt);
  }
  return {
    backend: loaded.backend,
    warmupMs,
    async transcribe(samples) {
      // Text only, no timestamps: timestamps need an extra alignment pass
      const result = await session.run(samples, { timestamps: "none" });
      return { text: String(result.text ?? "").trim() };
    },
    dispose() {
      session.dispose();
      loaded.dispose();
    },
  };
}
