import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

for (const width of [390, 1440]) {
  for (const mode of ["hosted", "authority"]) {
    test(`${mode} login remains accessible at ${width}px, including pending and error states`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/site") return route.fulfill({ json: { mode } });
        if (path === "/api/login") await pending;
        return route.fulfill({
          status: 401,
          json: { error: "账号或密码无效" },
        });
      });
      await page.goto("/");
      const account = page.getByLabel(
        mode === "hosted" ? "客户账号" : "管理员账号",
      );
      await account.fill("synthetic-review");
      await page
        .getByLabel(mode === "hosted" ? "登录密码" : "密码", { exact: true })
        .fill("synthetic-password");
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page
        .getByRole("button", {
          name: mode === "hosted" ? "进入工作台" : "登录管理后台",
        })
        .click();
      const busy = page.getByRole("button", {
        name: mode === "hosted" ? "正在登录" : "登录管理后台",
      });
      await expect(busy).toBeDisabled();
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      finish();
      await expect(page.getByRole("alert")).toHaveText("账号或密码无效");
      await expect(page.getByRole("button")).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath("login.png") });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
}

test("management code expiry follows the same 06:00 business boundary as the server", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2040-01-02T17:00:00Z") });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { items: [] };
    if (path === "/api/site") json = { mode: "authority" };
    else if (path === "/api/session") json = { username: "synthetic-owner" };
    else if (path === "/api/codes")
      json = {
        items: [
          {
            id: "code",
            username: "sample",
            days: 7,
            redeem_through: "2040-01-02",
            redeemed_at: null,
            revoked_at: null,
            granted_through: null,
          },
        ],
      };
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "激活码", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "待使用", exact: true }),
  ).toBeVisible();
  await page.clock.setSystemTime(new Date("2040-01-02T22:00:00Z"));
  await page.reload();
  await page.getByRole("button", { name: "激活码", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "已过期", exact: true }),
  ).toBeVisible();
});
