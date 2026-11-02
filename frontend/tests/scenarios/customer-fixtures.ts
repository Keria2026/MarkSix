import type { Page } from "@playwright/test";
import { expect } from "./scenario-fixtures";
export async function signIn(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "" },
    });
  });
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
  const response = await page.request.put("/api/settings/features", {
    headers: { "X-Marksix": "1" },
    data: { layoffs: false, manual_entry: true, text_entry: true },
  });
  expect(response.ok()).toBe(true);
}
export async function textMode(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await expect(page.getByLabel("投注原文")).toBeVisible();
}
export async function check(page: Page, raw: string, bettor: string) {
  await page.getByLabel("投注原文").fill(raw);
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "确认投注单" });
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder("填写投注人").fill(bettor);
  await expect(
    modal.getByRole("button", { name: "确认录入", exact: true }),
  ).toBeEnabled();
  return modal;
}
