import { pinyin } from "pinyin-pro";

// Character readings are context-free. Bound this cache and never cache a
// customer's full phrase, play binding, or account-specific preference.
const readings = new Map<string, string>();
function reading(char: string) {
  if (!/\p{Script=Han}/u.test(char)) return char;
  const cached = readings.get(char);
  if (cached !== undefined) return cached;
  const value = pinyin(char, { toneType: "none", traditional: true });
  if (readings.size >= 4096) readings.delete(readings.keys().next().value!);
  readings.set(char, value);
  return value;
}

// Per-character readings keep domain terms independent of surrounding prose.
export function phoneticKey(text: string): string {
  return [...text.normalize("NFKC")].map(reading).join("|");
}
