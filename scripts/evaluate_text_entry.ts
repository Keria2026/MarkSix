// Local corpus evaluation only: no network, no database, no learned defaults installed.
import { parseText, compileRow } from "../frontend/src/lib/text-entry";
import type { Play } from "../frontend/src/lib/types";
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: bun scripts/evaluate_text_entry.ts /path/to/records.jsonl",
  );
const document = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const plays: Play[] = document.plays.map((p: Play, i: number) => ({
  ...p,
  id: i + 1,
  version: 1,
}));
const mapping = {
  natal: 6,
  zodiac: Array.from({ length: 49 }, (_, i) => (18 - (i % 12)) % 12),
};
const corpus = (await Bun.file(path).text())
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((s) => JSON.parse(s));
let ready = 0,
  blocked = 0,
  missingAmounts = 0;
const reasons: Record<string, number> = {};
for (const record of corpus) {
  if (typeof record.raw_text !== "string" || !Array.isArray(record.items))
    throw Error("Invalid corpus schema");
  const missing = record.items.some(
    (i: { amount_each?: number | null; amount_total?: number | null }) =>
      i.amount_each == null && i.amount_total == null,
  );
  if (missing) missingAmounts++;
  const rows = parseText(record.raw_text, plays);
  const results = rows.map((row) => compileRow(row, plays, mapping));
  const accepted = results.length > 0 && results.every((r) => !r.error);
  if (accepted && missing)
    throw Error(`Unsafe acceptance of missing money: ${record.id}`);
  if (accepted) ready++;
  else blocked++;
  for (const result of results)
    if (result.error) reasons[result.error] = (reasons[result.error] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      records: corpus.length,
      draft_ready: ready,
      requires_confirmation: blocked,
      records_with_missing_amount: missingAmounts,
      missing_amount_safety: "passed",
      note: "No aliases auto-confirmed; readiness is not financial accuracy or server validation.",
      reasons,
    },
    null,
    2,
  ),
);
