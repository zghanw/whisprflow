#!/usr/bin/env node
// Packs a few PNGs into a Windows .ico: node scripts/build/make-ico.mjs <out.ico> <16.png> <32.png> ...
// An .ico is a header, a directory, then the images at each size; since Vista each image can be a PNG as is, no bitmap conversion needed.
// Called by make-icon.sh; a few lines cover it, so no dependency is added for it.
import { readFileSync, writeFileSync } from "node:fs";

/** A PNG's width and height are in IHDR: after the 8-byte signature and the 4-byte chunk length and type */
function pngSize(png) {
  if (png.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG (no IHDR found)");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  console.error("Usage: node scripts/build/make-ico.mjs <out.ico> <png...>");
  process.exit(2);
}
const images = inputs.map((file) => ({ file, png: readFileSync(file) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // 1 means icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ file, png }) => {
  const { width, height } = pngSize(png);
  if (width > 256 || height > 256) throw new Error(`${file} is ${width}x${height}; an .ico image is at most 256`);
  const entry = Buffer.alloc(16);
  // A width or height of 0 means 256
  entry.writeUInt8(width % 256, 0);
  entry.writeUInt8(height % 256, 1);
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // 32 bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  return entry;
});
writeFileSync(output, Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]));
