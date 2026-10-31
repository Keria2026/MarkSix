import { monetaryLiteral } from "./amount";

// The lexer and editable-summary validation share one grammar.
export const summaryPattern =
  /^[\d零〇一二两三四五六七八九十百千万]+\s*组\s*(?:共|合计)\s*[\d零〇一二两三四五六七八九十百千万]+(?:\.[\d]+)?\s*(?:元|米|斤|块)?(?=\s*(?:$|[\r\n,，;；]))/u;
export function readSummary(body: string) {
  const text = body.normalize("NFKC").trim();
  if (summaryPattern.exec(text)?.[0] !== text) return null;
  const parts = /^(.*?)\s*组\s*(?:共|合计)\s*(.*?)\s*(?:元|米|斤|块)?$/u.exec(
    text,
  );
  if (!parts) return null;
  const count = monetaryLiteral(parts[1].trim());
  const amount = monetaryLiteral(parts[2].trim());
  if (!count || !/^\d+$/u.test(count) || !amount) return null;
  return { count, amount: amount.replace(/(\.\d*?[1-9])0+$|\.0+$/u, "$1") };
}
