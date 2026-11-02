import { test, expect } from "./scenario-fixtures";
import { signIn, textMode, check } from "./customer-fixtures";

for (const width of [320, 390, 720, 1440])
  test(`manual controls have usable targets and do not move after selection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await page.request.put("/api/settings/entry-mode", {
      headers: { "X-Marksix": "1" },
      data: { entry_mode: "manual" },
    });
    await page.reload();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "录入投注", exact: true })
      .click();
    await page.getByLabel("搜索玩法名称").fill("特码");
    await page
      .locator(".play-picker button")
      .filter({ has: page.locator("span", { hasText: /^特码$/ }) })
      .click();
    const amount = page.getByRole("textbox", { name: "每注金额", exact: true });
    await amount.fill("00000000000010.19");
    await expect(amount).toHaveValue("00000000000010.19");
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#manual-amount-error")).toBeVisible();
    await amount.fill("12.5");
    await expect(amount).toHaveAttribute("aria-invalid", "false");
    const buttons = page.locator(".option-grid.number-grid button");
    await expect(buttons).toHaveCount(49);
    const before = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    for (const rect of before) {
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    // All 49 choices, and deselection, use the same grid geometry.
    for (let index = 0; index < 49; index++) await buttons.nth(index).click();
    const selected = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-pressed")),
    );
    expect(selected).toEqual(Array(49).fill("true"));
    await buttons.nth(0).click();
    await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "false");
    const after = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    // Scrolling is expected while clicking a long grid; compare layout coordinates.
    expect(after.map((r) => [r.x, r.width, r.height])).toEqual(
      before.map((r) => [r.x, r.width, r.height]),
    );
    expect(
      after.map((r, i) => r.y - after[0].y - (before[i].y - before[0].y)),
    ).toEqual(Array(49).fill(0));
    await buttons.nth(1).focus();
    await page.keyboard.press("Space");
    await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "false");
    await page.getByPlaceholder("手工填写姓名或代号").fill("ergonomics");
    await page.getByRole("button", { name: "加入组合单", exact: true }).click();
    const combined = page.getByRole("textbox", {
      name: "组合单第1项每注金额",
      exact: true,
    });
    await combined.fill("00000000000010.19");
    await expect(combined).toHaveValue("00000000000010.19");
    await expect(
      page.getByRole("button", { name: "确认录入组合单", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("editing a valid quoted amount into an unsafe one disables confirmation and retains text", async ({
  page,
}) => {
  await signIn(page);
  await textMode(page);
  const modal = await check(page, "澳门特码01各10", "edit-contract");
  const submit = modal.getByRole("button", { name: "确认录入", exact: true });
  const amount = modal.getByRole("textbox", { name: /金额/ }).first();
  await amount.fill("0000000000010.19");
  await expect(submit).toBeDisabled();
  await expect(amount).toHaveValue("0000000000010.19");
  await amount.fill("12.5");
  await expect(submit).toBeEnabled();
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await expect(page.getByLabel("投注原文")).toHaveValue("澳门特码01各10");
});
