import { Zlib } from "fflate";

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++)
    i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i;
});
function chunk(name: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4))
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
  return out;
}

// Encode successive RGBA strips into one PNG without allocating a full-height canvas.
export function pngEncoder(width: number, height: number) {
  if (
    ![width, height].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 0x7fffffff,
    )
  )
    throw new Error("PNG 尺寸不合法");
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
  ];
  let rows = 0,
    finished = false;
  const stream = new Zlib({ level: 6 }, (bytes) =>
    parts.push(chunk("IDAT", bytes)),
  );
  return {
    push(rgba: Uint8ClampedArray) {
      const stride = width * 4,
        count = rgba.length / stride;
      if (finished || !Number.isInteger(count) || rows + count > height)
        throw new Error("PNG 像素行不完整");
      const filtered = new Uint8Array(rgba.length + count);
      for (let row = 0; row < count; row++)
        filtered.set(
          rgba.subarray(row * stride, (row + 1) * stride),
          row * (stride + 1) + 1,
        );
      stream.push(filtered);
      rows += count;
    },
    finish() {
      if (finished || rows !== height) throw new Error("PNG 像素行不完整");
      finished = true;
      stream.push(new Uint8Array(), true);
      parts.push(chunk("IEND", new Uint8Array()));
      const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },
  };
}
