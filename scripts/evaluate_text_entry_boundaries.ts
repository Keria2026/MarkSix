// Evaluate whole slips (including summary rows), against independently rendered labels.
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseText, compileText } from "../frontend/src/lib/text-entry";
import type { Play, SlipLine } from "../frontend/src/lib/types";
import { oracle, type OracleItem } from "./generate_text_entry";
import type { BoundaryRecord } from "./generate_text_entry_boundaries";

const output = resolve(process.argv[2] ?? "test-results/text-entry-boundaries");
const defaults = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const plays: Play[] = defaults.plays.map((p: Play, i: number) => ({
  ...p,
  id: i + 1,
  version: 1,
}));
const records: BoundaryRecord[] = (
  await Bun.file(resolve(output, "cases.jsonl")).text()
)
  .trim()
  .split(/\r?\n/u)
  .map((s) => JSON.parse(s));
const canonical = (items: OracleItem[]) =>
  items
    .map((item) => ({
      play: item.play,
      selections: [...item.selections].sort((a, b) => a - b),
      compound: item.compound,
      amount_cents: Math.round(Number(item.amount) * 100),
      package_zodiacs: [...(item.package_zodiacs ?? [])].sort((a, b) => a - b),
      drag: item.drag
        ? {
            left: [...item.drag.left].sort((a, b) => a - b),
            right: [...item.drag.right].sort((a, b) => a - b),
            zodiac: item.drag.zodiac,
          }
        : null,
    }))
    .map((item) => JSON.stringify(item))
    .sort();
function asOracle(items: SlipLine[]): OracleItem[] {
  return items.map((item) => {
    const play = plays.find((p) => p.id === item.play_id)!;
    return {
      ...item,
      drag: item.drag ?? undefined,
      play: play.rule.name,
      quantity: play.rule.combination_size,
    };
  });
}
type Outcome =
  | "exact_accept"
  | "expected_block"
  | "unexpected_block"
  | "semantic_mismatch"
  | "unexpected_accept";
const results = records.map((record) => {
  if (
    record.schema !== "text-entry-boundaries-v1" ||
    !record.is_synthetic ||
    record.split !== "diagnostic"
  )
    throw Error("Expected synthetic boundary diagnostic records");
  let rows: ReturnType<typeof parseText> = [],
    items: OracleItem[] = [],
    errors: string[] = [];
  try {
    rows = parseText(record.raw_text, plays);
    const compiled = compileText(rows, plays, record.mapping);
    errors = compiled.flatMap((c) => (c.error ? [c.error] : []));
    items = asOracle(compiled.flatMap((c) => c.items));
    if (!rows.length) errors.push("empty_parse");
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  const actual = oracle(items, record.mapping);
  const accepted = !errors.length;
  const exact =
    JSON.stringify(canonical(items)) ===
      JSON.stringify(canonical(record.expected.items)) &&
    actual.units === record.expected.units &&
    actual.stake === record.expected.stake;
  const outcome: Outcome =
    record.expected.status === "blocked"
      ? accepted
        ? "unexpected_accept"
        : "expected_block"
      : !accepted
        ? "unexpected_block"
        : exact
          ? "exact_accept"
          : "semantic_mismatch";
  // Multiple plays can intentionally share a source span. Check interval union,
  // not monotonic non-overlap, while still rejecting omitted business text.
  let cursor = 0;
  const sourceErrors: string[] = [];
  for (const row of [...rows].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (
      row.start < 0 ||
      row.end > record.raw_text.length ||
      row.end < row.start ||
      row.source !== record.raw_text.slice(row.start, row.end)
    )
      sourceErrors.push("invalid_source_span");
    if (
      row.start > cursor &&
      !/^[\s,，、;；:：.。]*$/u.test(record.raw_text.slice(cursor, row.start))
    )
      sourceErrors.push("uncovered_source_gap");
    cursor = Math.max(cursor, row.end);
  }
  if (!/^[\s,，、;；:：.。]*$/u.test(record.raw_text.slice(cursor)))
    sourceErrors.push("uncovered_source_tail");
  return {
    ...record,
    outcome,
    source_errors: [...new Set(sourceErrors)],
    actual: {
      accepted,
      ...actual,
      items,
      errors,
      rows: rows.map(
        ({ playLabel, body, amount, marker, summary, start, end }) => ({
          playLabel,
          body,
          amount,
          marker,
          summary: summary ?? false,
          start,
          end,
        }),
      ),
    },
  };
});
const counts = (data: typeof results) => {
  const totals = {
    exact_accept: 0,
    expected_block: 0,
    unexpected_block: 0,
    semantic_mismatch: 0,
    unexpected_accept: 0,
  };
  for (const result of data) totals[result.outcome]++;
  return totals;
};
const failed = results.filter(
  (r) =>
    !["exact_accept", "expected_block"].includes(r.outcome) ||
    r.source_errors.length,
);
const groups = [...new Set(results.map((r) => `${r.family}:${r.variant}`))].map(
  (key) => {
    const group = results.filter((r) => `${r.family}:${r.variant}` === key);
    return {
      family: group[0].family,
      variant: group[0].variant,
      basis: [...new Set(group.map((r) => r.basis))].join("/"),
      records: group.length,
      ...counts(group),
      example_id:
        group.find(
          (r) => !["exact_accept", "expected_block"].includes(r.outcome),
        )?.id ?? group[0].id,
    };
  },
);
const report = {
  evaluated_commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  records: results.length,
  ...counts(results),
  source_error_records: results.filter((r) => r.source_errors.length).length,
  by_basis: Object.fromEntries(
    [...new Set(results.map((r) => r.basis))].map((basis) => [
      basis,
      counts(results.filter((r) => r.basis === basis)),
    ]),
  ),
  templates: groups,
  note: "只测本地 parseText + compileText；未提交投注、未调用服务端预览。精确对比玩法、对象、复式/拖/包肖、每注金额、注数、总额。顺序不影响语义；不去掉重复投注项。候选扩展与已确认语义分别计数，禁止称为线上准确率。",
};
await Bun.write(
  resolve(output, "results.jsonl"),
  results.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
await Bun.write(
  resolve(output, "failures.jsonl"),
  failed.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
await Bun.write(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const csv = (v: unknown) => '"' + String(v ?? "").replace(/"/gu, '""') + '"';
const columns = [
  "id",
  "family",
  "variant",
  "basis",
  "outcome",
  "raw_text",
  "expected",
  "actual",
  "error",
];
await Bun.write(
  resolve(output, "failures.csv"),
  "\uFEFF" +
    columns.join(",") +
    "\r\n" +
    failed
      .map((r) =>
        [
          r.id,
          r.family,
          r.variant,
          r.basis,
          r.outcome,
          r.raw_text,
          JSON.stringify(r.expected),
          JSON.stringify({
            items: r.actual.items,
            units: r.actual.units,
            stake: r.actual.stake,
          }),
          r.actual.errors.join("; "),
        ]
          .map(csv)
          .join(","),
      )
      .join("\r\n") +
    "\r\n",
);
console.log(
  JSON.stringify(
    {
      ...report,
      templates: groups.filter(
        (g) => g.unexpected_block || g.semantic_mismatch || g.unexpected_accept,
      ),
    },
    null,
    2,
  ),
);
if (failed.length || !records.length) process.exitCode = 1;
