import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";

// A sentence for checking an on-device transcription model: the system's text-to-speech says it on the spot, the model transcribes it, and we see if it recognizes it.
// macOS uses say; Windows uses the built-in speech synthesizer (System.Speech, through PowerShell).
// Silence won't do: a fully silent recording is never handed to the model (segment.mjs), so nothing would be checked.
// Speaking it live means no recording ships in the repository or installer, and the expected text is known, so one comparison shows whether the model works.

/**
 * Which sentence and voice to use per UI language. voice is a built-in macOS voice; Windows picks an installed voice for culture
 * (English Windows ships Zira). If this computer lacks the voice, the system default voice is used
 */
export const PROBE_SPEECH = Object.freeze({
  en: Object.freeze({ voice: "Samantha", culture: "en-US", text: "The meeting starts at three this afternoon." }),
});

/**
 * Speaking on Windows: the sentence, the output file, and the language all go through environment variables, so the script splices in no outside text and needs no escaping.
 * The output format is fixed at 16 kHz, 16-bit, mono, the same as on macOS
 */
const WINDOWS_SPEAK = [
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $env:WHISPRFLOW_PROBE_CULTURE } | Select-Object -First 1",
  "if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }",
  `$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo ${SPEECH_SAMPLE_RATE}, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)`,
  "$synth.SetOutputToWaveFile($env:WHISPRFLOW_PROBE_FILE, $format)",
  "$synth.Speak($env:WHISPRFLOW_PROBE_TEXT)",
  "$synth.Dispose()",
].join("; ");

const runFile = promisify(execFile);

/**
 * Speaks the check sentence.
 * @param {string} locale the UI language; languages without a sentence use English
 * @param {{ run?: (file: string, args: string[], options?: object) => Promise<unknown>, platform?: NodeJS.Platform }} [options]
 *   replaces the real say / PowerShell in tests
 * @returns {Promise<{ samples: Float32Array, said: string }>} 16 kHz mono samples, and which sentence was spoken
 */
export async function speechSample(locale, { run = runFile, platform = process.platform } = {}) {
  const { voice, culture, text } = PROBE_SPEECH[locale] ?? PROBE_SPEECH.en;
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-probe-"));
  try {
    const file = join(dir, "probe.wav");
    if (platform === "win32") {
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEAK], {
        env: {
          ...process.env,
          WHISPRFLOW_PROBE_FILE: file,
          WHISPRFLOW_PROBE_TEXT: text,
          WHISPRFLOW_PROBE_CULTURE: culture,
        },
        windowsHide: true,
      });
    } else {
      const args = ["-o", file, "--file-format=WAVE", `--data-format=LEI16@${SPEECH_SAMPLE_RATE}`, text];
      try {
        await run("say", ["-v", voice, ...args]);
      } catch {
        // Most likely this computer lacks that voice: use the default one. If that fails too, let the error through
        await run("say", args);
      }
    }
    return { samples: wavSamples(readFileSync(file)), said: text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The WAV say writes, to samples. It writes an extra chunk (FLLR) between fmt and data, so chunks are walked instead of reading a fixed 44-byte header
 * (decodeWav in pcm.mjs only reads the simple layout). It must be 16 kHz, mono, 16-bit, or it is an error
 */
function wavSamples(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The text-to-speech output is not a WAV file");
  }
  let format = null;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        tag: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) throw new Error("The text-to-speech WAV has no format chunk");
      if (format.tag !== 1 || format.bits !== 16) throw new Error("The text-to-speech output is not 16-bit PCM");
      if (format.channels !== 1)
        throw new Error(`The text-to-speech output has ${format.channels} channels, mono is required`);
      if (format.rate !== SPEECH_SAMPLE_RATE) {
        throw new Error(`The text-to-speech output is ${format.rate} Hz, ${SPEECH_SAMPLE_RATE} Hz is required`);
      }
      const end = Math.min(body + size, wav.length);
      const samples = new Float32Array(Math.floor((end - body) / 2));
      for (let i = 0; i < samples.length; i++) {
        const value = wav.readInt16LE(body + i * 2);
        samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
      }
      return samples;
    }
    // Odd-length chunks are followed by one padding byte
    offset = body + size + (size % 2);
  }
  throw new Error("The text-to-speech WAV contains no audio");
}
