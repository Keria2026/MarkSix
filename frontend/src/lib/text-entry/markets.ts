import type { TextRow } from "../text-entry";
import type { Market } from "../types";
import { tokenize, marketLabels, type Token } from "./lexer";

// Remove recognized labels before financial tokenization so insertion between
// fields (or inside a play/amount) cannot split the financial meaning. Every
// token is mapped back to original character offsets for review.
export function tokenizeMarkets(
  raw: string,
  names: string[],
  canResolve: (name: string) => boolean,
) {
  const original = tokenize(raw, names, canResolve);
  const literal: Token[] = [
    ...raw.matchAll(new RegExp(marketLabels.join("|"), "gu")),
  ].map((match) => ({
    kind: "market",
    text: match[0],
    start: match.index!,
    end: match.index! + match[0].length,
  }));
  // Preserve existing recognized spellings/transcriptions such as 新奥 too.
  const markers: Token[] = [];
  for (const token of [
    ...original.filter((t) => t.kind === "market"),
    ...literal,
  ].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!markers.length || token.start >= markers[markers.length - 1].end)
      markers.push(token);
  }
  const omitted = new Set<number>();
  for (const marker of markers) {
    // Exact configured names and confirmed aliases retain their own rate/rule.
    if (
      original.some(
        (token) =>
          token.kind === "play" &&
          names.includes(token.text) &&
          token.start <= marker.start &&
          token.end >= marker.end,
      )
    )
      continue;
    for (let i = marker.start; i < marker.end; i++) omitted.add(i);
    let right = original.findIndex((t) => t.start >= marker.end);
    let left = original.length - 1;
    while (left >= 0 && original[left].end > marker.start) left--;
    while (
      original[left]?.kind === "separator" &&
      /^\s*$/u.test(original[left].text)
    )
      left--;
    while (
      original[right]?.kind === "separator" &&
      /^\s*$/u.test(original[right].text)
    )
      right++;
    if (
      original[left]?.kind === "group-open" &&
      original[right]?.kind === "group-close"
    ) {
      for (const token of [original[left], original[right]])
        for (let i = token.start; i < token.end; i++) omitted.add(i);
    }
  }
  const offsets: number[] = [];
  let clean = "";
  for (let i = 0; i < raw.length; i++)
    if (!omitted.has(i)) {
      offsets.push(i);
      clean += raw[i];
    }
  const tokens = (
    markers.length ? tokenize(clean, names, canResolve) : original
  ).map((token) => ({
    ...token,
    lexicalStart: token.start,
    lexicalEnd: token.end,
    start: offsets[token.start] ?? raw.length,
    end: (offsets[token.end - 1] ?? raw.length - 1) + 1,
  }));
  return { tokens, markers };
}

// Multiple plays expanded from one source segment share one market decision.
export interface MarketRange {
  first: number;
  count: number;
  start: number;
  end: number;
}

export function assignMarkets(
  raw: string,
  rows: TextRow[],
  ranges: MarketRange[],
  markers: Token[],
): void {
  if (!markers.length || !ranges.length) return;
  const groups = ranges.map((range) => ({
    ...range,
    explicit: new Set<Market>(),
    headings: new Set<Market>(),
    left: range.start,
    right: range.end,
  }));
  for (const marker of markers) {
    let index = groups.findIndex(
      (g) => marker.start >= g.start && marker.end <= g.end,
    );
    let heading = false;
    if (index < 0) {
      const next = groups.findIndex((g) => g.start >= marker.end);
      if (next === 0) index = 0;
      else if (next < 0) index = groups.length - 1;
      else {
        const before = raw.slice(groups[next - 1].end, marker.start);
        const after = raw.slice(marker.end, groups[next].start);
        // A boundary after the label attaches it to the completed preceding bet.
        // A boundary before it starts the following bet; without a boundary the
        // existing prefix convention applies (100香港特码...).
        index =
          /[\r\n,，;；。!！]/u.test(after) && !/[\r\n,，;；。!！]/u.test(before)
            ? next - 1
            : next;
      }
      if (next >= 0) {
        const lineStart = raw.lastIndexOf("\n", marker.start - 1) + 1;
        const newline = raw.indexOf("\n", marker.end);
        const lineEnd = newline < 0 ? raw.length : newline;
        heading = /^[\s:：,，;；]*$/u.test(
          raw.slice(lineStart, marker.start) + raw.slice(marker.end, lineEnd),
        );
        if (heading) index = next;
      }
    }
    const group = groups[index];
    const market = /[港香]/u.test(marker.text) ? "hk" : "macau";
    (heading ? group.headings : group.explicit).add(market);
    group.left = Math.min(group.left, marker.start);
    group.right = Math.max(group.right, marker.end);
  }
  let inherited: Market = "macau";
  for (const group of groups) {
    if (group.headings.size === 1) inherited = [...group.headings][0];
    const market: Market = [...group.explicit][0] ?? inherited;
    const conflict = group.explicit.size > 1 || group.headings.size > 1;
    for (const row of rows.slice(group.first, group.first + group.count)) {
      if (market === "hk") row.market = market;
      if (conflict) row.marketConflict = true;
    }
    if (!conflict) inherited = market;
  }
  // Keep labels with their source bet in the editable confirmation. Do not
  // move boundaries across a summary or an unrecognized fragment.
  for (let i = 1; i < groups.length; i++) {
    const previous = groups[i - 1],
      next = groups[i];
    if (previous.first + previous.count !== next.first) continue;
    const boundary = Math.max(
      previous.right,
      Math.min(rows[next.first].start, next.left),
    );
    for (const row of rows.slice(
      previous.first,
      previous.first + previous.count,
    ))
      row.end = boundary;
    for (const row of rows.slice(next.first, next.first + next.count))
      row.start = boundary;
  }
  for (const [index, row] of rows.entries()) {
    row.source = raw.slice(row.start, row.end);
    row.key = `${row.start}:${row.end}:${index}`;
  }
}
