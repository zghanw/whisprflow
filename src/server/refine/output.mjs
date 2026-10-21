import { NO_SPEECH_MARK } from "./prompt.mjs";

// The model's raw output to the text that gets pasted. The last step of both paths: whether the text came from hearing
// the recording (native) or from cleaning up a transcript (local), it is finished the same way.
// Small models sometimes echo the transcript tags or wrap the whole answer in quotes even when told not to, so code catches it.

/** Empty string when the model marks no speech or outputs nothing */
export function textFromModelOutput(output) {
  let text = (output ?? "").trim();
  if (text === NO_SPEECH_MARK) return "";
  if (text.startsWith("<transcript>")) text = text.slice("<transcript>".length);
  if (text.endsWith("</transcript>")) text = text.slice(0, -"</transcript>".length);
  text = text.trim();
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  // Models end list lines with two spaces (a Markdown line break): invisible, but they'd be pasted
  return text.replace(/[ \t]+$/gm, "");
}
