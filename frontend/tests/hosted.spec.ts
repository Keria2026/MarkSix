import { test, expect, chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("hosted manager creates and activates customer, replaces session and permanently deletes", async () => {
  test.skip(
    !process.env.HOSTED_OWNER_PASSWORD,
    "Run against isolated hosted_acceptance Docker services",
  );
  const browser = await chromium.launch({
    proxy:
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY
        ? {
            server: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)!,
            bypass: "app.marksix.test,admin.marksix.test,localhost,127.0.0.1",
          }
        : undefined,
    args: [
      "--host-resolver-rules=MAP app.marksix.test 127.0.0.1, MAP admin.marksix.test 127.0.0.1",
      "--proxy-bypass-list=app.marksix.test;admin.marksix.test;localhost;127.0.0.1",
    ],
  });
  const managerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const customerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const replacementContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const manager = await managerContext.newPage();
  const customer = await customerContext.newPage();
  const replacement = await replacementContext.newPage();
  const errors: string[] = [];
  for (const page of [manager, customer, replacement])
    page.on("pageerror", (e) => errors.push(e.message));
  const name = `browser-${crypto.randomUUID().slice(0, 8)}`;
  const password = crypto.randomUUID();
  try {
    await manager.goto("https://admin.marksix.test:18443/");
    await manager
      .getByLabel("管理员账号")
      .fill(process.env.HOSTED_OWNER_USERNAME ?? "owner");
    await manager
      .getByLabel("密码", { exact: true })
      .fill(process.env.HOSTED_OWNER_PASSWORD!);
    await manager.getByRole("button", { name: "登录管理后台" }).click();
    await expect(
      manager.getByRole("heading", { name: "客户管理", exact: true }),
    ).toBeVisible();
    await manager
      .getByRole("button", { name: "新增客户", exact: true })
      .click();
    let dialog = manager.getByRole("dialog", { name: "新增客户" });
    await dialog.getByLabel("账号", { exact: true }).fill(name);
    await dialog.getByLabel("初始密码").fill(password);
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect(manager.getByRole("dialog")).toHaveCount(0);
    const card = manager
      .locator("article")
      .filter({ has: manager.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "签发激活码" }).click();
    await manager.getByRole("button", { name: "生成一次性激活码" }).click();
    const code = await manager.getByLabel("完整激活码").inputValue();
    expect(code).toMatch(/^MSH1-[a-f0-9]{64}$/);
    await manager.getByRole("button", { name: "关闭对话框" }).click();
    await customer.goto("https://app.marksix.test:18443/");
    await customer.getByLabel("客户账号").fill(name);
    await customer.getByLabel("登录密码").fill(password);
    await customer.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      customer.getByRole("heading", { name: "激活工作台" }),
    ).toBeVisible();
    await customer.getByLabel("一次性授权码").fill(code);
    await expect(customer.getByText("旧码与服务迁移")).toHaveCount(0);
    await customer.getByRole("button", { name: "激活并进入" }).click();
    await expect(
      customer.getByRole("heading", { name: "本期概览", exact: true }),
    ).toBeVisible();
    await replacement.goto("https://app.marksix.test:18443/");
    await replacement.getByLabel("客户账号").fill(name);
    await replacement.getByLabel("登录密码").fill(password);
    await replacement.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      replacement.getByRole("heading", { name: "本期概览", exact: true }),
    ).toBeVisible();
    await expect(
      customer.getByRole("button", { name: "进入工作台" }),
    ).toBeVisible({ timeout: 15000 });
    await replacement
      .getByRole("navigation", { name: "主要导航" })
      .getByRole("button", { name: "玩法与配置" })
      .click();
    await replacement
      .getByRole("button", { name: "配置设置", exact: false })
      .click();
    await replacement.getByRole("button", { name: "清空我的历史记录" }).click();
    const erasure = replacement.getByRole("dialog", {
      name: "永久清空历史记录",
    });
    await expect(erasure).toContainText("不可恢复");
    await expect(
      erasure.getByRole("button", { name: "确认永久清空" }),
    ).toBeDisabled();
    await erasure.getByLabel("当前账号登录密码").fill(password);
    await erasure
      .getByLabel("输入“永久清空历史记录”确认")
      .fill("永久清空历史记录");
    await erasure.getByRole("button", { name: "确认永久清空" }).click();
    await expect(erasure).toHaveCount(0);
    await expect(replacement.getByRole("status")).toContainText(
      "历史记录已永久清空",
    );
    expect(
      (await new AxeBuilder({ page: manager }).analyze()).violations,
    ).toEqual([]);
    await manager.setViewportSize({ width: 320, height: 780 });
    expect(
      await manager.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page: manager }).analyze()).violations,
    ).toEqual([]);
    await card.getByRole("button", { name: "永久删除", exact: true }).click();
    dialog = manager.getByRole("dialog", { name: "永久删除客户" });
    await expect(
      dialog.getByRole("button", { name: "永久删除全部资料" }),
    ).toBeDisabled();
    await dialog
      .getByLabel(`请输入“永久删除 ${name}”`)
      .fill(`永久删除 ${name}`);
    await dialog.getByRole("button", { name: "永久删除全部资料" }).click();
    await expect(card).toHaveCount(0);
    await expect(
      replacement.getByRole("button", { name: "进入工作台" }),
    ).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
