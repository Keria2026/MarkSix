import { test, expect } from "./fixtures";

test("management dialogs send explicit lifecycle actions and keep failed input reviewable", async ({
  page,
}) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let customer = {
    id: "synthetic-id",
    username: "synthetic-account",
    state: "failed",
    disabled: false,
    permanent: false,
    active: false,
    authorized_through: null,
  };
  let removed = false,
    reject = true,
    revoked = false;
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json: unknown = {};
    if (request.method() !== "GET") {
      const body = request.postData() ? request.postDataJSON() : {};
      writes.push({ path, body });
      if (path === "/api/accounts" && reject) {
        reject = false;
        return route.fulfill({ status: 409, json: { error: "合成账号冲突" } });
      }
      if (path.endsWith("/provision")) customer.state = "ready";
      if (body.action === "rename") customer.username = body.username;
      if (body.action === "disable") customer.disabled = true;
      if (body.action === "enable") customer.disabled = false;
      if (body.action === "permanent") customer.permanent = body.enabled;
      if (body.action === "delete") removed = true;
      if (path.endsWith("/revoke")) revoked = true;
      if (path.endsWith("/codes")) json = { code: "synthetic-once-only-code" };
    } else if (path === "/api/site") json = { mode: "authority" };
    else if (path === "/api/session") json = { username: "synthetic-owner" };
    else if (path === "/api/accounts")
      json = { items: removed ? [] : [customer] };
    else if (path === "/api/administrators")
      json = { items: [{ id: "admin", username: "synthetic-owner" }] };
    else if (path === "/api/audit")
      json = {
        items: [
          {
            id: 1,
            administrator_id: "admin",
            account_id: "synthetic-id",
            event: "rename",
            created_at: "2040-01-01T12:00:00",
          },
        ],
      };
    else if (path === "/api/codes")
      json = {
        items: [
          {
            id: "code",
            account_id: "synthetic-id",
            username: customer.username,
            days: 7,
            redeem_through: "2099-01-01",
            redeemed_at: null,
            granted_through: null,
            revoked_at: revoked ? "2040-01-01" : null,
          },
        ],
      };
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "重试初始化" }).click();
  await expect(page.getByRole("button", { name: "重试初始化" })).toBeHidden();
  await page.getByRole("button", { name: "新增客户" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号", { exact: true }).fill("new-synthetic");
  await dialog.getByLabel("初始密码").fill("synthetic-password");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("合成账号冲突");
  await expect(dialog.getByLabel("账号", { exact: true })).toHaveValue(
    "new-synthetic",
  );
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "修改账号", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号", { exact: true }).fill("synthetic-renamed");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "synthetic-renamed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("新密码")
    .fill("synthetic-new-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  for (const action of [
    "停用",
    "启用",
    "设为永久授权",
    "取消永久授权",
    "撤销授权",
  ]) {
    await page.getByRole("button", { name: action, exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await page.getByRole("button", { name: "签发激活码", exact: true }).click();
  await page.getByRole("dialog").getByLabel("授权天数").fill("7");
  await page.getByRole("button", { name: "生成一次性激活码" }).click();
  await expect(page.getByLabel("完整激活码")).toHaveValue(
    "synthetic-once-only-code",
  );
  await page.getByRole("button", { name: "复制激活码" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
    "已复制",
  );
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "激活码", exact: true }).click();
  await page.getByRole("button", { name: "作废", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "作废", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "管理员", exact: true }).click();
  await page.getByRole("button", { name: "新增管理员" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号", { exact: true }).fill("new-admin");
  await dialog.getByLabel("初始密码").fill("synthetic-admin-password");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "操作日志", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "synthetic-id", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "客户管理", exact: true }).click();
  await page.getByLabel("搜索客户账号").fill("renamed");
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "永久删除全部资料" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("请输入“永久删除 synthetic-renamed”")
    .fill("永久删除 synthetic-renamed");
  await dialog.getByRole("button", { name: "永久删除全部资料" }).click();
  await expect(
    page.getByRole("heading", { name: "synthetic-renamed" }),
  ).toBeHidden();
  expect(
    writes
      .filter((w) => w.body.action === "permanent")
      .map((w) => w.body.enabled),
  ).toEqual([true, false]);
  expect(
    writes.find((w) => w.body.action === "delete")?.body.confirmation,
  ).toBe("永久删除 synthetic-renamed");
  await page.getByRole("button", { name: "退出管理后台" }).click();
  await expect(page.getByLabel("管理员账号")).toBeVisible();
});
