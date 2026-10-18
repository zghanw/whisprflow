// Theme colors are always written as oklch(lightness chroma hue). This converts them to on-screen sRGB, used in three places:
// computing contrast (checking every theme is legible), drawing colors in the terminal, and giving a window its background before the page paints.
// Opaque colors only: what a translucent color sits on varies, so its contrast can't be computed.

const OKLCH = /^oklch\(\s*(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s*\)$/;

function parse(value) {
  const match = typeof value === "string" ? OKLCH.exec(value) : null;
  const [lightness, chroma, hue] = match ? match.slice(1).map(Number) : [];
  if (!match || lightness > 1) {
    throw new Error(
      `Colors must be oklch(lightness chroma hue) with lightness from 0 to 1, got ${JSON.stringify(value)}`,
    );
  }
  return { lightness, chroma, hue };
}

/** The three linear sRGB components, clipped when outside what the screen can show */
function linearSrgb(value) {
  const { lightness, chroma, hue } = parse(value);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  // Oklab as defined by Bjorn Ottosson: first to the three cone responses, then to linear sRGB
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

/** @returns {[number, number, number]} red, green, blue, each 0 to 255 */
export function toRgb(value) {
  return linearSrgb(value).map((channel) =>
    Math.round(255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055)),
  );
}

/** @returns {string} like #1a2b3c */
export function toHex(value) {
  return `#${toRgb(value)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Contrast between two colors, from 1 (the same) to 21 (black and white). The WCAG 2 algorithm */
export function contrast(one, other) {
  const luminance = (value) => {
    const [red, green, blue] = linearSrgb(value);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [darker, lighter] = [luminance(one), luminance(other)].sort((x, y) => x - y);
  return (lighter + 0.05) / (darker + 0.05);
}
