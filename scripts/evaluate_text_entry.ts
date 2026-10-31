// Exact labelled evaluation. Never train from validation/test or treat acceptance as accuracy.
import { parseText, compileRow } from "../frontend/src/lib/text-entry";
import { basicCount, zodiacs } from "../frontend/src/lib/types";
import { dragPreview } from "../frontend/src/lib/drag";
import type { Play, SlipLine, Mapping } from "../frontend/src/lib/types";
import type { CorpusRecord, OracleItem } from "./generate_text_entry";
const source = process.argv[2];
if (!source)
  throw Error(
    "Usage: bun scripts/evaluate_text_entry.ts /path/to/{train,validation,test}.jsonl [report.json]",
  );
const defaults = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const plays: Play[] = defaults.plays.map((p: Play, i: number) => ({
  ...p,
  id: i + 1,
  version: 1,
}));
const records: CorpusRecord[] = (await Bun.file(source).text())
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const cents = (amount: string) => {
  const [a, b = ""] = amount.split(".");
  return BigInt(a) * 100n + BigInt(b.padEnd(2, "0"));
};
function canonical(item: SlipLine | OracleItem) {
  const play =
    "play_id" in item
      ? plays.find((p) => p.id === item.play_id)!.rule.name
      : item.play;
  return {
    play,
    market: item.market ?? "macau",
    selections: item.selections,
    compound: item.compound,
    amount_cents: String(cents(item.amount)),
    package_zodiacs: item.package_zodiacs ?? [],
    drag: item.drag ?? null,
  };
}
function quote(items: SlipLine[], mapping: Mapping) {
  let units = 0,
    stake = 0n;
  for (const item of items) {
    const rule = plays.find((p) => p.id === item.play_id)!.rule;
    let count: number;
    if (item.package_zodiacs?.length) {
      count = mapping.zodiac.filter((z) =>
        item.package_zodiacs!.includes(z),
      ).length;
      stake += cents(item.amount) * BigInt(item.package_zodiacs.length);
    } else {
      if (item.drag) {
        const d = item.drag;
        const text = (v: number[]) =>
          v
            .map((n) =>
              d.zodiac || rule.kind === "zodiac" ? zodiacs[n] : String(n),
            )
            .join(" ");
        count = dragPreview(
          rule,
          { left: text(d.left), right: text(d.right), zodiac: d.zodiac },
          mapping,
        ).units;
      } else count = basicCount(rule, item.selections, item.compound);
      stake += cents(item.amount) * BigInt(count);
    }
    units += count;
  }
  return { units, stake: String(stake) };
}
const families: Record<string, { records: number; exact: number }> = {};
const failures: { id: string; family: string; reason: string }[] = [];
let accepted = 0,
  blocked = 0,
  wrongAccepted = 0,
  unexpectedlyBlocked = 0;
for (const record of records) {
  if (
    record.schema !== 2 ||
    record.is_synthetic !== true ||
    !record.expected ||
    !record.mapping ||
    !record.aliases
  )
    throw Error("Expected schema 2 labelled semantic corpus");
  const habits = record.aliases.map((a) => ({
    alias: a.alias,
    play_id: plays.find((p) => p.rule.name === a.play)!.id,
    play_version: 1,
    amount_mode: a.amount_mode,
  }));
  const rows = parseText(record.raw_text, plays, habits);
  const compiled = rows.map((row) => compileRow(row, plays, record.mapping));
  const ready = rows.length > 0 && compiled.every((row) => !row.error);
  const family = (families[record.family] ??= { records: 0, exact: 0 });
  family.records++;
  let reason = "";
  if (record.expected.status === "blocked") {
    if (ready) {
      wrongAccepted++;
      reason = "unsafe_acceptance";
    } else blocked++;
  } else if (!ready) {
    unexpectedlyBlocked++;
    reason = compiled.find((row) => row.error)?.error ?? "empty_parse";
  } else {
    accepted++;
    const items = compiled.flatMap((row) => row.items);
    if (
      JSON.stringify(items.map(canonical)) !==
      JSON.stringify(record.expected.items.map(canonical))
    )
      reason = "semantic_mismatch";
    const actual = quote(items, record.mapping);
    if (
      !reason &&
      (actual.units !== record.expected.units ||
        actual.stake !== String(record.expected.stake))
    )
      reason = "units_or_stake_mismatch";
  }
  let cursor = 0;
  for (const row of rows) {
    if (
      row.source !== record.raw_text.slice(row.start, row.end) ||
      row.start < cursor ||
      !/^[\s,，、;；:：.。]*$/u.test(record.raw_text.slice(cursor, row.start))
    )
      reason = "lost_source_span";
    cursor = row.end;
  }
  if (!/^[\s,，、;；:：.。]*$/u.test(record.raw_text.slice(cursor)))
    reason = "lost_source_tail";
  if (reason) failures.push({ id: record.id, family: record.family, reason });
  else family.exact++;
}
const report = {
  records: records.length,
  split: records[0]?.split,
  accepted,
  blocked_as_expected: blocked,
  unsafe_acceptances: wrongAccepted,
  unexpectedly_blocked: unexpectedlyBlocked,
  exact: records.length - failures.length,
  families,
  failures: failures.slice(0, 40),
  failure_count: failures.length,
  note: "Exact comparisons include market, play, selections, compound/drag/package, per-unit amount, units and integer-cent stake. Synthetic held-out results do not establish real-world accuracy.",
};
if (process.argv[3])
  await Bun.write(process.argv[3], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (failures.length || !records.length) process.exitCode = 1;
