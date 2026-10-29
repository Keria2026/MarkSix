// Supervised vocabulary suggestions only. Never install account preferences or amounts.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { parseText } from "../frontend/src/lib/text-entry";
import type { Play } from "../frontend/src/lib/types";
const source = process.argv[2];
if (!source)
  throw Error(
    "Usage: bun scripts/train_text_entry.ts /path/to/synthetic.jsonl",
  );
const bytes = await Bun.file(source).text();
const records = bytes
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const defaults = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const plays: Play[] = defaults.plays.map((p: Play, i: number) => ({
  ...p,
  id: i + 1,
  version: 1,
}));
const names: Record<string, string> = {
  特码: "特码",
  正码: "平码",
  平码: "平码",
  一肖: "一肖中",
  三全中: "三中三",
  三中二: "三中二",
  二中二: "二中二",
  尾数: "尾中",
  波色: "波色",
};
const counts: Record<string, Record<string, number>> = {};
let aligned = 0,
  examples = 0;
for (const record of records) {
  if (
    record.is_synthetic !== true ||
    typeof record.raw_text !== "string" ||
    !Array.isArray(record.items)
  )
    throw Error(
      "Only explicitly marked, labelled synthetic records are accepted",
    );
  const rows = parseText(record.raw_text, plays);
  if (rows.length !== record.items.length || rows.some((row) => !row.playLabel))
    continue;
  aligned++;
  rows.forEach((row, index) => {
    const item = record.items[index];
    const count = item.zodiacs?.length;
    const name =
      item.play === "连肖" && count >= 2 && count <= 5
        ? ["", "", "二有", "三有", "四有", "五有"][count]
        : names[item.play];
    if (!name || !plays.some((p) => p.rule.name === name)) return;
    counts[row.playLabel] ??= {};
    counts[row.playLabel][name] = (counts[row.playLabel][name] ?? 0) + 1;
    examples++;
  });
}
const candidates = Object.fromEntries(
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([alias, targets]) => [
      alias,
      Object.entries(targets)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    ]),
);
const output = {
  generated_by: "scripts/train_text_entry.ts",
  schema: 1,
  source_sha256: createHash("sha256").update(bytes).digest("hex"),
  records: records.length,
  aligned_records: aligned,
  labelled_examples: examples,
  candidates,
};
const directory = new URL("../frontend/src/lib/generated/", import.meta.url);
await mkdir(directory, { recursive: true });
await Bun.write(
  new URL("text-entry-candidates.json", directory),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    records: records.length,
    aligned_records: aligned,
    labelled_examples: examples,
    aliases: Object.keys(candidates).length,
    automatic_binding: false,
  }),
);
