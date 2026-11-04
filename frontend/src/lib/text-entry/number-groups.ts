// Group separators have a different role from separators within a number list.
// Only a complete multi-number block establishes grouping: a flat 01 02 03
// list must never be arbitrarily chunked into pairs or triples.
export function numberGroups(body: string, quantity: number): string[] | null {
  if (quantity < 2) return null;
  const count = (part: string) =>
    /^\d{1,2}(?:[\s.、‐‑‒–—―−-]+\d{1,2})*$/u.test(part.trim())
      ? (part.match(/\d+/gu)?.length ?? 0)
      : 0;
  function inline(part: string) {
    const compact = part.replace(/\s*([.、‐‑‒–—―−-])\s*/gu, "$1").trim();
    const words = compact.split(/\s+/u);
    return words.length > 1 &&
      words.every((word) => count(word) > 0) &&
      words.some((word) => count(word) >= quantity)
      ? words
      : [part.trim()];
  }
  const parts = body
    .split(/[,，;；/\r\n]+/u)
    .filter((part) => part.trim())
    .flatMap(inline);
  return parts.length > 1 &&
    parts.every((part) => count(part) > 0) &&
    parts.some((part) => count(part) >= quantity)
    ? parts
    : null;
}
