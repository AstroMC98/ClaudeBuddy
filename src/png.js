'use strict';

/**
 * Minimal PNG header reader.
 *
 * Theme validation needs a sheet's real dimensions and whether it carries
 * transparency. Both live in the first 26 bytes, so there is no need to inflate
 * and unfilter the pixel data — which is the only part that would require a
 * real decoder.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour types that carry an alpha channel intrinsically. */
const COLOR_TYPE_GREY_ALPHA = 4;
const COLOR_TYPE_RGBA = 6;
const COLOR_TYPE_PALETTE = 3;

/** Walk the chunk list looking for a tag, without decoding any of it. */
function hasChunk(buffer, tag) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === tag) return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    // length + type + data + crc
    offset += 12 + length;
  }
  return false;
}

/**
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,hasAlpha:boolean}|null}
 */
function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  // signature (8) + length (4) + 'IHDR' (4) + 13 bytes of header data
  if (buffer.length < 8 + 4 + 4 + 13) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];

  const hasAlpha =
    colorType === COLOR_TYPE_RGBA ||
    colorType === COLOR_TYPE_GREY_ALPHA ||
    (colorType === COLOR_TYPE_PALETTE && hasChunk(buffer, 'tRNS'));

  return { width, height, bitDepth, colorType, hasAlpha };
}

module.exports = { readPngHeader, PNG_SIGNATURE };
