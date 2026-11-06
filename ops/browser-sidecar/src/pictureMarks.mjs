// The model's copy of a screenshot, drawn here in the sidecar and never in the page: the page cannot
// see, hide or fake the labels, and the person's picture and the model's share the same pixels.
import { Buffer } from 'node:buffer';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for the 8-bit, non-interlaced colour types Chromium writes: RGB and RGBA. */
const BYTES_PER_PIXEL = { 2: 3, 6: 4 };

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

/** A PNG as RGBA pixels. Throws for any PNG this does not read, so the caller sends no copy at all. */
export function decodePng(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let header;
  const data = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const bpp = header === undefined ? undefined : BYTES_PER_PIXEL[header.colorType];
  if (header === undefined || header.bitDepth !== 8 || header.interlace !== 0 || bpp === undefined) {
    throw new Error('unsupported PNG');
  }
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) {
    throw new Error('truncated PNG');
  }
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? rows[(y - 1) * stride + x - bpp] : 0;
      const value = line[x];
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error('unsupported PNG filter');
      }
      rows[y * stride + x] = out & 0xff;
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = rows[i * bpp];
    pixels[i * 4 + 1] = rows[i * bpp + 1];
    pixels[i * 4 + 2] = rows[i * bpp + 2];
    pixels[i * 4 + 3] = bpp === 4 ? rows[i * bpp + 3] : 0xff;
  }
  return { width, height, pixels };
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody));
  return Buffer.concat([length, typeAndBody, crc]);
}

/** RGBA pixels as a PNG. */
export function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  // Each row stored as its difference from the row above (PNG filter "Up"): flat page areas then
  // compress to almost nothing, as in the browser's own PNG.
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    raw[out] = y === 0 ? 0 : 2;
    for (let x = 0; x < stride; x += 1) {
      const up = y === 0 ? 0 : pixels[(y - 1) * stride + x];
      raw[out + 1 + x] = (pixels[y * stride + x] - up) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 5×7 glyphs for the characters a ref is made of: `e` and digits. */
const GLYPHS = {
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

const RED = [0xe0, 0x00, 0x00];
const WHITE = [0xff, 0xff, 0xff];
/** What covers a password, card or one-time-code field in the model's copy. */
export const MASK_COLOR = [0x40, 0x40, 0x40];

function fill({ picture, left, top, width, height, color }) {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(picture.width, Math.ceil(left + width));
  const y1 = Math.min(picture.height, Math.ceil(top + height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * picture.width + x) * 4;
      picture.pixels[at] = color[0];
      picture.pixels[at + 1] = color[1];
      picture.pixels[at + 2] = color[2];
      picture.pixels[at + 3] = 0xff;
    }
  }
}

function outline({ picture, box, thickness }) {
  const { left, top, width, height } = box;
  fill({ picture, left, top, width, height: thickness, color: RED });
  fill({ picture, left, top: top + height - thickness, width, height: thickness, color: RED });
  fill({ picture, left, top, width: thickness, height, color: RED });
  fill({ picture, left: left + width - thickness, top, width: thickness, height, color: RED });
}

function label({ picture, box, ref, dot }) {
  const chars = [...ref].filter(char => GLYPHS[char] !== undefined);
  const pad = dot;
  const width = chars.length * 6 * dot + pad;
  const height = 7 * dot + 2 * pad;
  const left = Math.max(0, Math.min(box.left, picture.width - width));
  const top = box.top - height >= 0 ? box.top - height : box.top;
  fill({ picture, left, top, width, height, color: RED });
  chars.forEach((char, index) => {
    GLYPHS[char].forEach((row, y) => {
      [...row].forEach((bit, x) => {
        if (bit === '1') {
          fill({
            picture,
            left: left + pad + (index * 6 + x) * dot,
            top: top + pad + y * dot,
            width: dot,
            height: dot,
            color: WHITE,
          });
        }
      });
    });
  });
}

/**
 * The model's copy of a screenshot: every password, card or one-time-code field covered, and a red
 * box with its ref on each control. Boxes are in page pixels; `scale` turns them into picture pixels.
 */
export function markPicture({ png, scale, controls, masks }) {
  const picture = decodePng(png);
  const toPicture = box => ({
    left: box.left * scale,
    top: box.top * scale,
    width: box.width * scale,
    height: box.height * scale,
  });
  const thickness = Math.max(2, Math.round(2 * scale));
  for (const { box } of controls) {
    outline({ picture, box: toPicture(box), thickness });
  }
  for (const box of masks) {
    fill({ picture, ...toPicture(box), color: MASK_COLOR });
  }
  const dot = Math.max(1, Math.round(1.5 * scale));
  for (const { box, ref } of controls) {
    label({ picture, box: toPicture(box), ref, dot });
  }
  return encodePng(picture);
}
