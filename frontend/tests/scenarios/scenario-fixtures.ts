import { test as base } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import v8ToIstanbul from "v8-to-istanbul";

// Keep browser coverage separate from Bun coverage: generated Svelte code must
// be mapped back to its source before any percentage can describe the UI.
export const test = base.extend({
  page: async ({ page }, use, info) => {
    if (!process.env.COVERAGE_DIR) return use(page);
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    const reports = [];
    for (const entry of entries) {
      if (!entry.url || !entry.source) continue;
      const url = new URL(entry.url);
      if (!url.pathname.startsWith("/src/")) continue;
      const path = resolve(`.${decodeURIComponent(url.pathname)}`);
      const converter = v8ToIstanbul(path, 0, { source: entry.source });
      await converter.load();
      converter.applyCoverage(entry.functions);
      reports.push(converter.toIstanbul());
    }
    const directory = resolve(process.env.COVERAGE_DIR);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, `${info.testId}-${info.retry}.json`),
      JSON.stringify(reports),
    );
  },
});
export { expect } from "@playwright/test";
