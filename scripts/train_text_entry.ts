// Compile labelled training vocabulary. No parser outputs or held-out data are labels.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { CorpusRecord } from "./generate_text_entry";
import type { Play } from "../frontend/src/lib/types";
const source = process.argv[2];
if (!source)
  throw Error("Usage: bun scripts/train_text_entry.ts /path/to/train.jsonl");
const bytes = await Bun.file(source).text();
const records: CorpusRecord[] = bytes
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const defaults = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const names = new Set(defaults.plays.map((p: Play) => p.rule.name));
const counts = new Map<string, Map<string, number>>();
let examples = 0;
for (const record of records) {
  if (
    record.schema !== 2 ||
    record.is_synthetic !== true ||
    record.split !== "train" ||
    !Array.isArray(record.aliases) ||
    !record.expected
  )
    throw Error(
      "Only schema 2 labelled synthetic TRAIN records are accepted; validation/test cannot train vocabulary",
    );
  if (record.expected.status !== "accept") continue;
  for (const { alias, play } of record.aliases) {
    if (
      !/^[\p{L}\p{N}]{1,40}$/u.test(alias) ||
      !names.has(play) ||
      !record.expected.items.some((item) => item.play === play)
    )
      throw Error("Invalid supervised alias");
    const targets = counts.get(alias) ?? new Map<string, number>();
    targets.set(play, (targets.get(play) ?? 0) + 1);
    counts.set(alias, targets);
    examples++;
  }
}
if (!records.length || !examples)
  throw Error("Training corpus must contain supervised aliases");
const candidates = Object.fromEntries(
  [...counts]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([alias, targets]) => [
      alias,
      [...targets]
        .map(([name, count]) => ({ name, count }))
        .sort(
          (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
        ),
    ]),
);
const output = {
  generated_by: "scripts/train_text_entry.ts",
  schema: 2,
  source_sha256: createHash("sha256").update(bytes).digest("hex"),
  records: records.length,
  training_split: "train",
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
    labelled_examples: examples,
    aliases: counts.size,
    automatic_binding: false,
  }),
);
