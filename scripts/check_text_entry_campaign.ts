import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { parseText, compileText } from "../frontend/src/lib/text-entry";
import type { Play, SlipLine } from "../frontend/src/lib/types";
import { textCases, type TextCase } from "../frontend/tests/model/text-slips";
import { ruleBoundaryCases } from "../frontend/tests/model/text-rule-boundaries";
import {
  price,
  totals,
  canonical,
  type ReferenceLine,
} from "../frontend/tests/model/financial-oracle";
const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "20261102" },
    size: { type: "string", default: "2400" },
    output: { type: "string", default: "test-results/text-entry-campaign" },
    "max-failures": { type: "string", default: "100" },
    vectors: { type: "string" },
    suite: { type: "string", default: "standard" },
    cases: { type: "string" },
  },
});
if (!["standard", "rules"].includes(values.suite!))
  throw Error("Unknown text suite");
const records: string[] = [];
const seed = Number(values.seed),
  size = Number(values.size),
  maximum = Number(values["max-failures"]);
if (
  !Number.isInteger(seed) ||
  !Number.isInteger(size) ||
  size < 1 ||
  !Number.isInteger(maximum) ||
  maximum < 1
)
  throw Error("Invalid campaign bounds");
const defaults = await Bun.file(
  new URL("../backend/src/default-plays.json", import.meta.url),
).json();
const plays: Play[] = defaults.plays.map((play: Play, index: number) => ({
  ...play,
  id: index + 1,
  version: 1,
}));
const rules = plays.map((play) => play.rule);
const failures: unknown[] = [];
const families: Record<string, { total: number; exact: number }> = {};
const intentions = new Set<string>();
const texts = new Set<string>();
const hash = createHash("sha256");
const vectors: unknown[] = [];
let tested = 0,
  accepted = 0,
  blocked = 0;
const started = performance.now();
function check(record: TextCase) {
  const rows = parseText(record.raw, plays);
  const compiled = compileText(
    rows,
    plays,
    record.mappings.macau,
    record.mappings.hk,
  );
  const ready =
    rows.length > 0 &&
    compiled.every((row) => !row.error) &&
    compiled.some((row) => row.items.length > 0);
  const items = compiled.flatMap((row) => row.items);
  const actual: ReferenceLine[] = items.map((item: SlipLine) => ({
    play: plays.find((play) => play.id === item.play_id)!.rule.name,
    market: item.market ?? "macau",
    selections: item.selections,
    amount: item.amount,
    compound: item.compound,
    drag: item.drag,
    package_zodiacs: item.package_zodiacs,
  }));
  if (!record.accept)
    return ready ? { reason: "unsafe-acceptance", actual } : null;
  if (!ready)
    return {
      reason: "unexpected-block",
      errors: compiled.map((row) => row.error),
      rows,
    };
  const expected = price(record.lines, rules, record.mappings);
  const calculated = price(actual, rules, record.mappings);
  if (canonical(expected) !== canonical(calculated))
    return {
      reason: "financial-semantics",
      expected: totals(expected),
      actual: totals(calculated),
      expectedLines: record.lines,
      actualLines: actual,
    };
  let cursor = 0,
    previousStart = -1,
    previousEnd = -1;
  for (const row of rows) {
    const shared = row.start === previousStart && row.end === previousEnd;
    if (
      row.source !== record.raw.slice(row.start, row.end) ||
      (!shared &&
        (row.start < cursor ||
          !/^[\s,，、;；:：.。]*$/u.test(record.raw.slice(cursor, row.start))))
    )
      return { reason: "lost-source-span", rows };
    cursor = row.end;
    previousStart = row.start;
    previousEnd = row.end;
  }
  if (!/^[\s,，、;；:：.。]*$/u.test(record.raw.slice(cursor)))
    return { reason: "lost-source-tail", rows };
  return null;
}
for (const record of values.suite === "rules"
  ? ruleBoundaryCases(seed, size)
  : textCases(rules, seed, size)) {
  if (values.cases) records.push(JSON.stringify(record));
  tested++;
  const family = (families[record.family] ??= { total: 0, exact: 0 });
  family.total++;
  hash.update(record.raw + "\n");
  texts.add(record.raw.normalize("NFKC").replace(/\s/gu, ""));
  intentions.add(
    createHash("sha256")
      .update(
        record.accept
          ? canonical(price(record.lines, rules, record.mappings))
          : record.raw.normalize("NFKC").replace(/\s/gu, ""),
      )
      .digest("hex"),
  );
  let failure: unknown;
  try {
    failure = check(record);
  } catch (error) {
    failure = {
      reason: "exception",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (failure) {
    failures.push({
      id: record.id,
      family: record.family,
      raw: record.raw,
      ...(failure as object),
    });
    if (failures.length >= maximum) break;
  } else {
    family.exact++;
    if (record.accept) {
      accepted++;
      if (values.vectors && vectors.length < 192) {
        const items = compileText(
          parseText(record.raw, plays),
          plays,
          record.mappings.macau,
          record.mappings.hk,
        ).flatMap((row) => row.items);
        vectors.push({
          id: record.id,
          family: record.family,
          raw: record.raw,
          mappings: record.mappings,
          items: items.map((item) => ({
            input: item,
            expected: price(
              [
                {
                  play: plays.find((play) => play.id === item.play_id)!.rule
                    .name,
                  market: item.market ?? "macau",
                  selections: item.selections,
                  compound: item.compound,
                  amount: item.amount,
                  drag: item.drag,
                  package_zodiacs: item.package_zodiacs,
                },
              ],
              rules,
              record.mappings,
            ),
          })),
        });
      }
    } else blocked++;
  }
}
const report = {
  schema: 1,
  suite: values.suite,
  seed,
  requested: size,
  tested,
  unique_texts: texts.size,
  unique_intentions: intentions.size,
  sha256: hash.digest("hex"),
  accepted,
  blocked,
  failures: failures.length,
  milliseconds: Math.round(performance.now() - started),
  families,
  note: "Finite deterministic synthetic attempts; expected atoms and integer pricing are independent of production counting and planning. Formatting variants are not counted as distinct semantic proof.",
};
const output = resolve(values.output!);
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  resolve(output, "failures.jsonl"),
  failures.map((f) => JSON.stringify(f)).join("\n") +
    (failures.length ? "\n" : ""),
);
if (values.vectors)
  await writeFile(
    resolve(values.vectors),
    JSON.stringify({ schema: 1, seed, vectors }) + "\n",
  );
if (values.cases)
  await writeFile(resolve(values.cases), records.join("\n") + "\n");
console.log(JSON.stringify(report, null, 2));
if (failures.length || tested !== size) process.exitCode = 1;
