import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusRecord } from "../../scripts/generate_text_entry";
const root = fileURLToPath(new URL("../../", import.meta.url));
let directory: string;
const script = (name: string) => resolve(root, `scripts/${name}_text_entry.ts`);
const read = (name: string): CorpusRecord[] =>
  readFileSync(resolve(directory, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
test.beforeAll(() => {
  directory = mkdtempSync(resolve(tmpdir(), "marksix-corpus-"));
  execFileSync("bun", [script("generate"), directory], {
    cwd: root,
    stdio: "pipe",
  });
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("5000 semantic labels have disjoint texts, target groups and rendering templates", () => {
  const seenText = new Set<string>(),
    groups = new Set<string>(),
    templates = new Set<string>();
  let total = 0;
  for (const [split, size] of [
    ["train", 3500],
    ["validation", 750],
    ["test", 750],
  ] as const) {
    const rows = read(split);
    expect(rows).toHaveLength(size);
    total += rows.length;
    const localGroups = new Set<string>(),
      localTemplates = new Set<string>();
    for (const row of rows) {
      assert.equal(row.schema, 2);
      assert.equal(row.is_synthetic, true);
      assert.equal(row.split, split);
      assert.equal(seenText.has(row.raw_text), false);
      seenText.add(row.raw_text);
      assert.equal(groups.has(row.semantic_group), false);
      localGroups.add(row.semantic_group);
      assert.equal(templates.has(row.template), false);
      localTemplates.add(row.template);
      assert.equal(Number.isInteger(row.expected.stake), true);
    }
    for (const group of localGroups) groups.add(group);
    for (const template of localTemplates) templates.add(template);
  }
  expect(total).toBe(5000);
});

test("generation is reproducible and held-out data cannot train vocabulary", () => {
  const second = resolve(directory, "repeat");
  execFileSync("bun", [script("generate"), second], {
    cwd: root,
    stdio: "pipe",
  });
  for (const split of ["train", "validation", "test"])
    expect(readFileSync(resolve(directory, `${split}.jsonl`), "utf8")).toBe(
      readFileSync(resolve(second, `${split}.jsonl`), "utf8"),
    );
  for (const split of ["validation", "test"]) {
    const result = spawnSync(
      "bun",
      [script("train"), resolve(directory, `${split}.jsonl`)],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TRAIN");
  }
});

test("evaluation rejects an accepted record with an incorrect principal label", () => {
  const row = read("train").find((r) => r.expected.status === "accept")!;
  row.expected.stake++;
  const path = resolve(directory, "wrong-label.jsonl");
  writeFileSync(path, JSON.stringify(row) + "\n");
  const result = spawnSync("bun", [script("evaluate"), path], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    failure_count: 1,
    failures: [{ reason: "units_or_stake_mismatch" }],
  });
});
