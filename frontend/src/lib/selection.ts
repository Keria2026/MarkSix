import { label, options } from "./types";
import type { Kind } from "./types";

export function parseSelections(kind: Kind, input: string): number[] {
  // NFKC accepts full-width digits. Unicode punctuation includes Chinese separators.
  const normalized = input.normalize("NFKC");
  const tokens = (
    kind === "zodiac_count"
      ? normalized.replace(/(\d+)\s*种(?:生肖)?/gu, "$1")
      : normalized
  )
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);
  const allowed = options(kind);
  const values: number[] = [];
  for (const token of tokens) {
    const value = allowed.find((candidate) => {
      if (token === label(kind, candidate)) return true;
      if (kind === "number" || kind === "tail" || kind === "zodiac_count")
        return /^\d+$/.test(token) && Number(token) === candidate;
      if (kind === "wave") return token === ["红", "蓝", "绿"][candidate];
      return false;
    });
    if (value == null)
      throw new Error(`无法识别投注项“${token}”，请按当前玩法输入`);
    if (!values.includes(value)) values.push(value);
  }
  return values;
}
