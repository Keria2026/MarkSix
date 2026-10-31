import { monetaryLiteral } from "./amount";
const number = "[\\d零〇一二两三四五六七八九十百千万]+";
const money = number + "(?:\\.\\d+)?";
const currency = "(?:元|米|斤|块)?";
const base = `${number}\\s*组\\s*(?:共|合计)\\s*${money}\\s*${currency}`;
const breakdown = `(?:[二三四五2345]有\\s*${number}\\s*组\\s*[,，]\\s*)+共\\s*${number}\\s*组\\s*${money}\\s*${currency}`;
// The lexer and editable-summary validation share one grammar.
export const summaryPattern = new RegExp(
  `^(?:${base}|${breakdown})(?=\\s*(?:$|[\\r\\n,，;；。]))`,
  "u",
);
export function readSummary(body: string) {
  const text = body.normalize("NFKC").trim();
  if (summaryPattern.exec(text)?.[0] !== text) return null;
  const simple = /^(.*?)\s*组\s*(?:共|合计)\s*(.*?)\s*(?:元|米|斤|块)?$/u.exec(
    text,
  );
  const detailed = simple
    ? null
    : /^(.*?)共\s*(.*?)\s*组\s*(.*?)\s*(?:元|米|斤|块)?$/u.exec(text);
  const count = monetaryLiteral((simple?.[1] ?? detailed?.[2] ?? "").trim());
  const amount = monetaryLiteral((simple?.[2] ?? detailed?.[3] ?? "").trim());
  if (!count || !/^\d+$/u.test(count) || !amount) return null;
  const plays: { name: string; count: string }[] = [];
  if (detailed)
    for (const match of detailed[1].matchAll(
      /([二三四五2345])有\s*([\d零〇一二两三四五六七八九十百千万]+)\s*组/gu,
    )) {
      const n = Number(monetaryLiteral(match[1]));
      const units = monetaryLiteral(match[2]);
      if (
        !units ||
        !/^\d+$/u.test(units) ||
        plays.some((p) => p.name === "一二三四五"[n - 1] + "有")
      )
        return null;
      plays.push({ name: "一二三四五"[n - 1] + "有", count: units });
    }
  return {
    count,
    amount: amount.replace(/(\.\d*?[1-9])0+$|\.0+$/u, "$1"),
    plays,
  };
}
