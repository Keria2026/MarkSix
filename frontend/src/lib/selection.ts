import { label, options } from "./types";
import type { Kind } from "./types";

export function parseSelections(kind: Kind, input: string): number[] {
  if (input.length > 2048)
    throw new Error("投注项过长，最多2048字；请核对原文，不会自动截断");
  // Normalize full-width digits, but keep unknown operators in the token so
  // they cannot silently change a typed financial selection.
  const normalized = input.normalize("NFKC");
  if (/[+\-−‐‑‒–—―至到]/u.test(normalized))
    throw new Error(
      "请明确列出投注项，不能使用正负号或范围；可用空格、逗号分隔",
    );
  const tokens = (
    kind === "zodiac_count"
      ? normalized.replace(/(\d+)\s*种(?:生肖)?/gu, "$1")
      : normalized
  )
    .split(/[\s,，、;；:：.。/\[\]【】{}()（）]+/u)
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
    if (values.includes(value))
      throw new Error(`投注项“${token}”重复，请删除重复项后确认`);
    values.push(value);
  }
  return values;
}
