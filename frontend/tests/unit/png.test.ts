import { test, expect } from "bun:test";
import { unzlibSync } from "fflate";
import { pngEncoder } from "../../src/lib/png";

test("PNG strips form one complete lossless image with standard chunks", () => {
  const encoder = pngEncoder(2, 3);
  const pixels = new Uint8ClampedArray(
    Array.from({ length: 24 }, (_, i) => i * 10),
  );
  encoder.push(pixels.subarray(0, 8));
  encoder.push(pixels.subarray(8));
  const png = encoder.finish(),
    view = new DataView(png.buffer);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(view.getUint32(16)).toBe(2);
  expect(view.getUint32(20)).toBe(3);
  expect(view.getUint32(29)).toBe(0xb9eade81);
  const compressed: number[] = [],
    names: string[] = [];
  for (let i = 8; i < png.length; ) {
    const size = view.getUint32(i);
    const name = new TextDecoder().decode(png.subarray(i + 4, i + 8));
    names.push(name);
    if (name === "IDAT") compressed.push(...png.subarray(i + 8, i + 8 + size));
    i += size + 12;
  }
  expect(names[0]).toBe("IHDR");
  expect(names.at(-1)).toBe("IEND");
  const raw = unzlibSync(new Uint8Array(compressed));
  expect([...raw]).toEqual([
    0,
    ...pixels.subarray(0, 8),
    0,
    ...pixels.subarray(8, 16),
    0,
    ...pixels.subarray(16),
  ]);
  expect(() => encoder.finish()).toThrow();
  expect(() => encoder.push(pixels)).toThrow();
});
test("PNG encoding rejects incomplete, excessive and malformed pixel rows", () => {
  for (const n of [0, -1, 1.5, Infinity, 0x80000000])
    expect(() => pngEncoder(2, n)).toThrow();
  const encoder = pngEncoder(2, 3);
  expect(() => encoder.push(new Uint8ClampedArray(7))).toThrow();
  expect(() => encoder.push(new Uint8ClampedArray(32))).toThrow();
  expect(() => encoder.finish()).toThrow();
});

test("strip encoding supports images taller than a browser canvas", () => {
  const encoder = pngEncoder(2, 40000);
  for (let row = 0; row < 40000; row += 1000)
    encoder.push(new Uint8ClampedArray(8000).fill(255));
  const png = encoder.finish();
  expect(new DataView(png.buffer).getUint32(20)).toBe(40000);
});
