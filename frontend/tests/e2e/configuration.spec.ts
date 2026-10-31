import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function settings(page: Page) {
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "玩法与配置" })
    .click();
}

test("configuration editor preserves values after failure, then creates, batches, orders and deletes a custom play", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "新建玩法", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新建玩法" });
  await dialog.getByLabel("玩法名称").fill("合成配置测试");
  await dialog
    .getByLabel("投注对象", { exact: true })
    .selectOption("zodiac_count");
  await expect(dialog.getByLabel("目标生肖种数")).toBeVisible();
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("wave");
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("tail");
  await dialog.getByLabel("启用 0 尾特殊赔率").check();
  await dialog.getByLabel("0 尾含本赔率").fill("2");
  await dialog.getByLabel("启用 0 尾特殊反水").check();
  await dialog.getByLabel("0 尾反水（%）", { exact: true }).fill("7.25");
  await dialog.getByLabel("启用本命生肖特殊赔率").check();
  await dialog.getByLabel("启用本命肖特殊反水").check();
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("number");
  await expect(dialog.getByLabel("启用 0 尾特殊反水")).toBeHidden();
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("tail");
  await dialog.getByLabel("启用 0 尾特殊反水").check();
  await dialog.getByLabel("命中条件").selectOption("hard_pair");
  await expect(dialog.getByLabel("启用 0 尾特殊反水")).toBeHidden();
  await dialog.getByLabel("命中条件").selectOption("all");
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("number");
  let reject = true;
  await page.route("**/api/plays", async (route) => {
    if (reject)
      return route.fulfill({ status: 409, json: { error: "合成并发冲突" } });
    await route.continue();
  });
  await dialog.getByRole("button", { name: "保存玩法" }).click();
  await expect(dialog.getByText("合成并发冲突")).toBeVisible();
  await expect(dialog.getByLabel("玩法名称")).toHaveValue("合成配置测试");
  reject = false;
  await dialog.getByRole("button", { name: "保存玩法" }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("搜索配置玩法").fill("合成配置测试");
  await page.getByLabel("选择玩法 合成配置测试", { exact: true }).check();
  await page.getByRole("button", { name: "批量调整" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("批量含本赔率").fill("5");
  await dialog.getByLabel("批量反水比例（%）").fill("1");
  await dialog.getByLabel("批量启用状态").selectOption("true");
  await dialog.getByRole("button", { name: "保存批量调整" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "排序玩法", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "排序玩法" });
  await dialog.getByRole("button", { name: "将合成配置测试置顶" }).click();
  await dialog.getByRole("button", { name: "下移合成配置测试" }).click();
  await dialog.getByRole("button", { name: "上移合成配置测试" }).click();
  await dialog.getByRole("button", { name: "保存排序" }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("选择玩法 合成配置测试", { exact: true }).check();
  await page.getByRole("button", { name: "批量删除" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认批量删除" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByLabel("选择玩法 合成配置测试", { exact: true }),
  ).toBeHidden();
});

test("zero-tail rebate can be validated, saved as zero, batch updated and cleared", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "新建玩法", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新建玩法" });
  await dialog.getByLabel("玩法名称").fill("合成0尾反水");
  await dialog.getByLabel("投注对象", { exact: true }).selectOption("tail");
  await dialog.getByLabel("开奖对比范围").selectOption("all");
  await dialog.getByLabel("反水比例（%）", { exact: true }).fill("3");
  await dialog.getByLabel("启用 0 尾特殊反水").check();
  const rate = dialog.getByLabel("0 尾反水（%）", { exact: true });
  await expect(rate).toHaveValue("3");
  await dialog.getByLabel("启用 0 尾特殊反水").uncheck();
  await expect(rate).toBeHidden();
  await dialog.getByLabel("启用 0 尾特殊反水").check();
  await rate.fill("100.01");
  await dialog.getByRole("button", { name: "保存玩法" }).click();
  await expect(dialog.getByRole("alert")).toContainText("0 尾特殊反水");
  await expect(rate).toHaveValue("100.01");
  await rate.fill("7.25");
  await dialog.getByRole("button", { name: "保存玩法" }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("搜索配置玩法").fill("合成0尾反水");
  await page.getByRole("button", { name: /^合成0尾反水/ }).click();
  dialog = page.getByRole("dialog", { name: "编辑玩法" });
  await expect(dialog.getByLabel("启用 0 尾特殊反水")).toBeChecked();
  await expect(dialog.getByLabel("0 尾反水（%）", { exact: true })).toHaveValue(
    "7.25",
  );
  await dialog.getByLabel("0 尾反水（%）", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "保存玩法" }).click();
  await expect(dialog).toBeHidden();
  async function exportedRate() {
    const response = await page.request.get("/api/plays/export");
    expect(response.ok()).toBe(true);
    const data = await response.json();
    return data.plays.find(
      (p: { rule: { name: string } }) => p.rule.name === "合成0尾反水",
    ).rule.zero_tail_rebate_percent;
  }
  expect(await exportedRate()).toBe("0");
  for (const clear of [false, true]) {
    await page.getByLabel("选择玩法 合成0尾反水", { exact: true }).check();
    await page.getByRole("button", { name: "批量调整" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("特殊赔率与反水", { exact: true }).click();
    if (clear) await dialog.getByLabel("清除0 尾特殊反水（%）").check();
    else await dialog.getByLabel("批量0 尾特殊反水（%）").fill("6.5");
    await dialog.getByRole("button", { name: "保存批量调整" }).click();
    await expect(dialog).toBeHidden();
    expect(await exportedRate()).toBe(clear ? null : "6.5");
  }
  await page.getByRole("button", { name: /^合成0尾反水/ }).click();
  dialog = page.getByRole("dialog", { name: "编辑玩法" });
  await expect(dialog.getByLabel("启用 0 尾特殊反水")).not.toBeChecked();
  await expect(
    dialog.getByLabel("0 尾反水（%）", { exact: true }),
  ).toBeHidden();
  await dialog.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByLabel("选择玩法 合成0尾反水", { exact: true }).check();
  await page.getByRole("button", { name: "批量删除" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认批量删除" }).click();
  await expect(dialog).toBeHidden();
});

test("settings save future mapping and reset failed switches; history retry retains its request id", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "配置设置", exact: true }).click();
  await page.getByLabel("生效日期").fill("2040-01-03");
  await page.getByLabel("本命生肖").selectOption("1");
  await page.getByText("编辑 49 个号码对应的生肖").click();
  await page.getByLabel("01 生肖").selectOption("2");
  const mapping = page.waitForRequest(
    (r) => r.url().endsWith("/settings/mapping") && r.method() === "PUT",
  );
  await page.getByRole("button", { name: "安排生效" }).click();
  expect((await mapping).postDataJSON().mapping.zodiac[0]).toBe(2);
  await expect(
    page.getByText("生肖映射已保存，将于指定日期生效"),
  ).toBeVisible();
  await page.route("**/api/settings/features", (route) =>
    route.fulfill({ status: 409, json: { error: "合成功能冲突" } }),
  );
  const control = page.getByRole("switch", { name: "飞出投注", exact: true });
  const original = await control.isChecked();
  await control.click();
  await expect(page.getByText("合成功能冲突")).toBeVisible();
  await expect(control).toBeChecked({ checked: original });
  const requests: { request_id: string }[] = [];
  await page.route("**/api/history/clear", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: requests.length === 1 ? 503 : 200,
      json: requests.length === 1 ? { error: "合成暂时失败" } : { ok: true },
    });
  });
  await page.getByRole("button", { name: "清空我的历史记录" }).click();
  const dialog = page.getByRole("dialog", { name: "永久清空历史记录" });
  await expect(
    dialog.getByRole("button", { name: "确认永久清空" }),
  ).toBeDisabled();
  await dialog.getByLabel("当前账号登录密码").fill("synthetic-password");
  await dialog
    .getByLabel("输入“永久清空历史记录”确认")
    .fill("永久清空历史记录");
  await dialog.getByRole("button", { name: "确认永久清空" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("合成暂时失败");
  await dialog.getByRole("button", { name: "确认永久清空" }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[0].request_id).toBe(requests[1].request_id);
});

test("password dialog validates confirmations, clears rejected passwords and requires relogin after success", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "配置设置", exact: true }).click();
  await page.getByRole("button", { name: "修改登录密码", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修改登录密码" });
  await dialog
    .getByLabel("原密码", { exact: true })
    .fill("synthetic-old-password");
  await dialog
    .getByLabel("新密码", { exact: true })
    .fill("synthetic-new-password");
  await dialog.getByLabel("再次输入新密码").fill("synthetic-different");
  await dialog.getByRole("button", { name: "确认修改密码" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("两次新密码不一致");
  await dialog.getByLabel("再次输入新密码").fill("synthetic-new-password");
  let reject = true;
  await page.route("**/api/account/password", (route) =>
    route.fulfill({
      status: reject ? 403 : 200,
      json: reject ? { error: "原密码错误" } : { ok: true },
    }),
  );
  await dialog.getByRole("button", { name: "确认修改密码" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("原密码错误");
  await expect(dialog.getByLabel("原密码", { exact: true })).toHaveValue("");
  await dialog
    .getByLabel("原密码", { exact: true })
    .fill("synthetic-old-password");
  reject = false;
  await dialog.getByRole("button", { name: "确认修改密码" }).click();
  await expect(page.getByLabel("客户账号")).toBeVisible();
});

test("account statement exports a real PNG archive and supports cancelling an outstanding snapshot", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "本期统计", exact: true })
    .click();
  await page.getByRole("button", { name: "展开本期统计二级菜单" }).click();
  await page
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find(
    (p: { rule: { name: string } }) => p.rule.name === "特码",
  );
  const response = await page.request.post("/api/bets", {
    headers: { "X-Marksix": "1" },
    data: {
      period: boot.today.id,
      bettor: "synthetic-export",
      request_id: crypto.randomUUID(),
      play_id: play.id,
      play_version: play.version,
      selections: [7],
      compound: false,
      amount: "20",
    },
  });
  expect(response.ok()).toBe(true);
  await page.getByLabel("账单导出格式").selectOption("png");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部投注人账单" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("png.zip");
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const { unzipSync } = await import("fflate");
  const files = unzipSync(Buffer.concat(chunks));
  expect(
    Object.keys(files).some(
      (name) => name.includes("synthetic-export") && name.endsWith(".png"),
    ),
  ).toBe(true);
  for (const bytes of Object.values(files))
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect(page.getByText("已导出全部投注人 PNG 账单")).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/bettor-export?combined=true", async (route) => {
    await pending;
    await route.fulfill({ json: { bettors: [] } }).catch(() => {});
  });
  await page.getByRole("button", { name: "导出全部投注人账单" }).click();
  await page.getByRole("button", { name: "取消导出" }).click();
  release();
  await expect(page.getByText("已取消导出")).toBeVisible();
  await page.getByRole("button", { name: "导出全部投注人账单" }).click();
  await expect(page.getByRole("alert")).toContainText("本期暂无投注人记录");
});
