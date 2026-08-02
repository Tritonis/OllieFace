// node crop.mjs <in.png> <out.png> x0 y0 x1 y1 [zoom]
import { readPNG } from './png.mjs';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

export function writePNG(file, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = writePNG._t || (writePNG._t = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
      return t;
    })());
    let c = -1; for (const b of body) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeInt32BE(c ^ -1);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const [inF, outF, ...rest] = process.argv.slice(2);
if (inF) {
  const [x0, y0, x1, y1] = rest.slice(0, 4).map(Number);
  const z = Number(rest[4] ?? 1);
  const img = readPNG(inF);
  const w = (x1 - x0) * z, h = (y1 - y0) * z;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y0 + (y / z | 0)) * img.w + x0 + (x / z | 0)) * 4, d = (y * w + x) * 4;
    out[d] = img.rgba[s]; out[d + 1] = img.rgba[s + 1]; out[d + 2] = img.rgba[s + 2]; out[d + 3] = 255;
  }
  writePNG(outF, w, h, out);
  console.log(`${outF} ${w}x${h}`);
}
