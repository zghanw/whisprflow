// The microphone and its instantaneous volume: the floating bar's recording and onboarding's microphone test use this same one, so the test measures the same audio path that records.
// The rule: in the 8-bit waveform, any deviation of one step from the midpoint counts as signal.
// It doesn't judge whether someone is speaking, only whether any sound is coming in from the microphone.

/**
 * Opens the microphone. Settings: mono, with echo cancellation, noise suppression, and auto gain all off,
 * so the model gets the raw sound
 */
export const openMicrophone = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

/** How often the volume is reported */
const LEVEL_INTERVAL_MS = 50;

/**
 * @param {MediaStream} stream the microphone
 * @param {(level: number) => void} onLevel instantaneous volume from 0 to 1, every 50 ms
 * @returns {{ hadSignal: () => boolean, stop: () => void }} hadSignal: whether there has been any signal so far
 */
export function meterLevels(stream, onLevel) {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const waveform = new Uint8Array(analyser.fftSize);
  let peak = 0;
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(waveform);
    let deviation = 0;
    for (const sample of waveform) deviation = Math.max(deviation, Math.abs(sample - 128));
    peak = Math.max(peak, deviation);
    onLevel(deviation / 128);
  }, LEVEL_INTERVAL_MS);

  return {
    hadSignal: () => peak >= 1,
    stop() {
      clearInterval(timer);
      audioContext.close().catch((error) => console.warn("Failed to close AudioContext", error));
    },
  };
}
