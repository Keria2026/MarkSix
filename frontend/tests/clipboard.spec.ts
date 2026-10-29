import { test, expect } from "./authenticated";
import { readFileSync } from "node:fs";
import type { Play } from "../src/lib/types";
import AxeBuilder from "@axe-core/playwright";
const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "确认投注单", exact: true });

test("foreground clipboard opens review, requires explicit recording and skips the last recorded text after reload", async ({
  page,
  context,
}) => {
  const defaults = JSON.parse(
    readFileSync(
      new URL("../../backend/src/default-plays.json", import.meta.url),
      "utf8",
    ),
  );
  const boot = await (await page.request.get("/api/bootstrap")).json();
  for (const name of ["三有", "八不中"])
    if (!boot.plays.some((p: Play) => p.rule.name === name)) {
      const response = await page.request.post("/api/plays", {
        headers: { "X-MarkSix": "1" },
        data: defaults.plays.find((p: Play) => p.rule.name === name).rule,
      });
      expect(response.ok()).toBe(true);
    }
  let submitted = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/slips" &&
      request.method() === "POST"
    )
      submitted++;
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("heading", { name: "本期概览", exact: true }).waitFor();
  const original =
    "複三友：牛狗嗎豬各60米；八不中{01 02 03 04 05 06 07 08]各10";
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("普通聊天：今天下午见");
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(300);
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  }, original);
  const review = dialog(page);
  await expect(review).toBeVisible();
  await expect(review.locator(".text-entry-rows > li")).toHaveCount(2);
  await expect(
    review.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeDisabled();
  await review
    .getByLabel("投注人", { exact: true })
    .fill(`剪切板验收-${Date.now()}`);
  const submit = review.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  expect(submitted).toBe(0);
  const rows = review.locator(".text-entry-rows > li");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await rows
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).borderRadius)),
    ).toBeGreaterThan(0);
    expect(
      await rows.first().evaluate((el) => getComputedStyle(el).borderTopStyle),
    ).toBe("solid");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/clipboard-review-${width}.png`,
    });
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('dialog[aria-label="确认投注单"]')
        .analyze()
    ).violations,
  ).toEqual([]);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/slips") && r.request().method() === "POST",
  );
  await submit.click();
  expect((await response).ok()).toBe(true);
  await expect(review).toHaveCount(0);
  expect(submitted).toBe(1);
  const fingerprint = await page.evaluate(() =>
    localStorage.getItem("marksix:last-text:test-admin"),
  );
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await page.getByRole("heading", { name: "本期概览", exact: true }).waitFor();
  await page.waitForTimeout(350);
  await expect(review).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  await expect(review).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("特碼直選07各12米");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "返回修改", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  await expect(review).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText(""));
});

test("clipboard permission fallback preserves existing drafts and ignores a late read when text entry is disabled", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "读取剪切板投注", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "读取剪切板投注", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "浏览器未允许读取剪切板",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () =>
          new Promise<string>((resolve) => {
            (window as any).releaseClipboard = resolve;
          }),
      },
    });
  });
  await page
    .getByRole("button", { name: "读取剪切板投注", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseClipboard))
    .toBe("function");
  const changed = await page.request.put("/api/settings/features", {
    headers: { "X-MarkSix": "1" },
    data: { layoffs: false, manual_entry: true, text_entry: false },
  });
  expect(changed.ok()).toBe(true);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "读取剪切板投注", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseClipboard("特码直选07各15"));
  await page.waitForTimeout(250);
  await expect(dialog(page)).toHaveCount(0);
});
