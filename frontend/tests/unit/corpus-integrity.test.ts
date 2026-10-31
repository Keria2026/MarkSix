import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  generateCorpus,
  verifyRecords,
  semanticKey,
  type CorpusRecord,
  type OracleItem,
} from "../../../scripts/generate_text_entry";

test("full synthetic corpus is reproducible and contains 30,000 disjoint texts and intentions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marksix-corpus-"));
  try {
    const first = await generateCorpus(directory);
    const records: CorpusRecord[] = [];
    for (const [split, count] of Object.entries(first.splits)) {
      const text = await readFile(join(directory, `${split}.jsonl`), "utf8");
      const rows = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(count);
      expect(rows.every((row) => row.split === split)).toBe(true);
      expect(createHash("sha256").update(text).digest("hex")).toBe(
        first.sha256[split],
      );
      records.push(...rows);
    }
    expect(verifyRecords(records, 30000)).toEqual({
      unique_ids: 30000,
      unique_normalized_texts: 30000,
      unique_semantic_groups: 30000,
    });
    expect(first.splits).toEqual({
      train: 21000,
      validation: 4500,
      test: 4500,
    });
    expect(Object.keys(first.families).length).toBe(41);
    const second = await generateCorpus(directory);
    expect(second.sha256).toEqual(first.sha256);
    expect(() => verifyRecords(records.slice(1), 30000)).toThrow(
      "count mismatch",
    );
    expect(() => verifyRecords([...records, records[0]], 30001)).toThrow(
      "Duplicate",
    );
    const original = records.find((row) => row.expected.status === "accept")!;
    expect(() =>
      verifyRecords([{ ...original, semantic_group: "bad" }], 1),
    ).toThrow("fingerprint");
    expect(() =>
      verifyRecords([{ ...original, schema: 1 } as unknown as CorpusRecord], 1),
    ).toThrow("labelled");
    const another = records.find((row) => row.split === "test")!;
    expect(() =>
      verifyRecords([original, { ...another, template: original.template }], 2),
    ).toThrow("leaks");
    await expect(generateCorpus(directory, undefined, 99)).rejects.toThrow(
      "integer",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("spacing, fullwidth digits, reordered selections and equivalent amounts cannot inflate diversity", () => {
  const item: OracleItem = {
    play: "特码",
    selections: [7, 8],
    compound: false,
    quantity: 1,
    amount: "10",
  };
  expect(semanticKey("特码07 08各10", true, [item])).toBe(
    semanticKey("特碼０８、０７各１０元", true, [
      { ...item, selections: [8, 7], amount: "10.00" },
    ]),
  );
  expect(semanticKey("", true, [item])).not.toBe(
    semanticKey("", true, [{ ...item, amount: "20" }]),
  );
});
