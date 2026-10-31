import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const shouldFail of [false, true])
  test(`boundary evaluator exits ${shouldFail ? "nonzero for a semantic mismatch" : "successfully for a correctly blocked record"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "marksix-evaluator-"));
    try {
      const record = {
        schema: "text-entry-boundaries-v1",
        is_synthetic: true,
        split: "diagnostic",
        id: "synthetic-cli-contract",
        family: "cli",
        variant: "exit",
        source_examples: [],
        basis: "invalid",
        note: "independent CLI contract",
        raw_text: shouldFail ? "特码07各10元" : "取消这张，特码07各10元",
        mapping: {
          natal: 0,
          zodiac: Array.from({ length: 49 }, (_, i) => i % 12),
        },
        expected: {
          status: shouldFail ? "accept" : "blocked",
          items: [],
          units: 0,
          stake: 0,
        },
      };
      await writeFile(
        join(directory, "cases.jsonl"),
        JSON.stringify(record) + "\n",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          new URL(
            "../../../scripts/evaluate_text_entry_boundaries.ts",
            import.meta.url,
          ).pathname,
          directory,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe("");
      expect(exit).toBe(shouldFail ? 1 : 0);
      expect(output).toContain(
        shouldFail ? '"semantic_mismatch": 1' : '"expected_block": 1',
      );
      expect(
        JSON.parse(await readFile(join(directory, "report.json"), "utf8")),
      ).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
