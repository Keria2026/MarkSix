import { test, expect } from "@playwright/test";

test("history erasure retries keep their ID, but closing and reopening starts a new operation", async ({
  page,
}) => {
  const password = process.env.TEST_ADMIN_PASSWORD;
  if (!password) throw new Error("TEST_ADMIN_PASSWORD is required");
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置" })
    .click();

  await page.getByRole("button", { name: "配置设置", exact: false }).click();

  // Intercept only erasure: simulate a server commit followed by a lost reply.
  // Login, settings and the rest of the page still use the real test backend.
  const ids: string[] = [];
  let reply = false;
  await page.route("**/api/history/clear", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.password).toBe(password);
    expect(body.confirmation).toBe("永久清空历史记录");
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
    );
    ids.push(body.request_id);
    if (reply) await route.fulfill({ json: { ok: true } });
    else await route.abort("connectionreset");
  });

  const dialog = page.getByRole("dialog", { name: "永久清空历史记录" });
  const open = async () => {
    await page.getByRole("button", { name: "清空我的历史记录" }).click();
    await expect(dialog.getByLabel("当前账号登录密码")).toHaveValue("");
    await expect(dialog.getByLabel("输入“永久清空历史记录”确认")).toHaveValue(
      "",
    );
    await dialog.getByLabel("当前账号登录密码").fill(password);
    await dialog
      .getByLabel("输入“永久清空历史记录”确认")
      .fill("永久清空历史记录");
  };
  const fail = async () => {
    await dialog.getByRole("button", { name: "确认永久清空" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "确认永久清空" }),
    ).toBeEnabled();
  };

  await open();
  await fail();
  await fail();
  expect(ids[1]).toBe(ids[0]);
  // All dismissal paths must discard the completed/uncertain operation ID.
  for (const close of [
    () => dialog.getByRole("button", { name: "取消", exact: true }).click(),
    () => page.keyboard.press("Escape"),
    () => dialog.getByRole("button", { name: "关闭对话框" }).click(),
  ]) {
    const previous = ids.at(-1);
    await close();
    await expect(dialog).toHaveCount(0);
    await open();
    await fail();
    expect(ids.at(-1)).not.toBe(previous);
  }
  reply = true;
  const last = ids.at(-1);
  await dialog.getByRole("button", { name: "确认永久清空" }).click();
  expect(ids.at(-1)).toBe(last);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("历史记录已永久清空");
  await open();
  await dialog.getByRole("button", { name: "确认永久清空" }).click();
  await expect(dialog).toHaveCount(0);
  expect(ids.at(-1)).not.toBe(last);
});
