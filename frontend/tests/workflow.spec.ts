import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";

test("administrator records compound bets, cancels atomically, configures rules, and navigates mobile", async ({
  page,
}) => {
  const password = process.env.TEST_ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "TEST_ADMIN_PASSWORD must match the disposable e2e_server account",
    );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByRole("button", { name: "五有" }).click();
  await expect(
    page.getByRole("button", { name: "复式", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await page.getByLabel("启用复式投注").check();
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByRole("button", { name: "五有" }).click();
  await page.getByRole("button", { name: "复式", exact: true }).click();
  for (const name of ["鼠", "牛", "虎", "兔", "龙", "蛇", "马"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByText("¥ 18,000.00", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-total")).toContainText("¥ 2,100.00");
  await page.getByLabel("投注人", { exact: true }).fill("张三");
  await page.getByRole("button", { name: "确认录入投注" }).click();
  await expect(page.getByRole("status")).toContainText("投注已记录");
  await nav.getByRole("button", { name: "本期概览" }).click();
  const row = page.locator("tbody tr").filter({ hasText: "五有" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("21 注");
  await row.getByRole("button", { name: "详情" }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }).locator("tbody tr"),
  ).toHaveCount(21);
  await page.getByRole("button", { name: "修改金额", exact: true }).click();
  await page.getByLabel("修改后的每注金额（最多一位小数）").fill("150");
  await page.getByRole("button", { name: "确认修改", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "飞出", exact: true }).click();
  await page.getByLabel("飞出受注方").fill("李四");
  await page.getByLabel("每条基础注飞出金额（元）").fill("40");
  await page.getByRole("button", { name: "确认飞出", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "投注记录详情" }),
  ).toContainText("李四");
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav.getByRole("button", { name: "飞出受注统计", exact: true }).click();
  await expect(page.locator(".ledger-stats")).toContainText("¥ 840.00");
  await expect(page.locator(".ledger-stats")).toContainText("飞出受注方");
  await expect(page.locator(".ledger-stats")).not.toContainText("自留本金");
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  await expect(page.locator("tbody")).toContainText("张三");
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await page.getByLabel("投注总额下限（元）").fill("3200");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await row.getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "撤销飞出", exact: true }).click();
  await page.getByRole("button", { name: "确认撤销飞出", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "撤销整条记录" }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(row).toContainText("已撤销");
  await expect(page.locator(".stat").first()).toContainText("¥ 0.00");
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("尾数验收玩法");
  await page.getByLabel("投注对象", { exact: true }).selectOption("tail");
  await page.getByLabel("开奖对比范围").selectOption("all");
  await page.getByLabel("命中条件").selectOption("any");
  await page.getByLabel("含本赔率", { exact: true }).fill("3.1234");
  await page.getByLabel("最多可选数量（留空允许普通多选）").fill("1");
  await page.getByLabel("启用 0 尾特殊赔率").check();
  await page.getByLabel("0 尾含本赔率").fill("4.1234");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(
    page.getByRole("heading", { name: "尾数验收玩法" }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByLabel("搜索玩法名称").fill("尾数验收玩法");
  await expect(page.locator(".play-picker button.selected")).toContainText(
    "尾数验收玩法",
  );
  await page.getByRole("button", { name: "1尾", exact: true }).click();
  await page.getByRole("button", { name: "2尾", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "2尾", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("alert")).toContainText("最多选择 1 项");
  await page.getByLabel("搜索玩法名称").fill("");
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "尾数验收玩法", exact: true }),
    })
    .click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出此玩法" }).click();
  const file = await downloaded;
  const portable = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(portable.plays).toHaveLength(1);
  expect(portable.plays[0].rule.selection_limit).toBe(1);
  expect(portable.plays[0].rule.zero_tail_odds).toBe("4.1234");
  expect(portable.plays[0]).not.toHaveProperty("id");
  portable.plays[0].rule.name = "共享导入验收";
  await page.keyboard.press("Escape");
  await page.getByLabel("选择玩法文件").setInputFiles({
    name: "shared.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(portable)),
  });
  await expect(
    page.getByRole("dialog", { name: "导入玩法规则" }),
  ).toContainText("共享导入验收");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "共享导入验收", exact: true }),
    })
    .click();
  await page.getByRole("button", { name: "删除玩法", exact: true }).click();
  await page.getByRole("button", { name: "确认删除玩法", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "共享导入验收", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "五有", exact: true }) })
    .click();
  await expect(page.getByLabel("玩法名称")).toHaveValue("五有");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("三中二验收");
  await page.getByLabel("命中条件").selectOption("at_least");
  await page.getByLabel("开奖对比范围").selectOption("regular");
  await page.getByLabel("数量阈值", { exact: true }).fill("3");
  await page.getByLabel("最少命中数量").fill("2");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("heading", { name: "三中二验收" })).toBeVisible();
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("四肖亮验收");
  await page
    .getByLabel("投注对象", { exact: true })
    .selectOption("zodiac_count");
  await expect(page.getByLabel("开奖对比范围")).toBeDisabled();
  await page.getByLabel("目标生肖种数").fill("4");
  await page.getByLabel("含本赔率", { exact: true }).fill("15");
  await page.getByLabel("反水比例（%）").fill("10");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByLabel("搜索玩法名称").fill("四肖亮验收");
  await expect(page.locator(".option-grid button")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "4 种生肖", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("每注金额").fill("1");
  await page.getByRole("button", { name: "确认录入投注" }).click();
  await expect(page.getByRole("status")).toContainText("投注已记录");
  await nav.getByRole("button", { name: "玩法与配置" }).click();
  await page.getByRole("button", { name: "新建玩法" }).click();
  await page.getByLabel("玩法名称").fill("二中二含特验收");
  await page.getByLabel("开奖对比范围").selectOption("all");
  await page.getByLabel("数量阈值", { exact: true }).fill("2");
  await page.getByLabel("含本赔率", { exact: true }).fill("55");
  await page.getByLabel("启用一特一平赔率").check();
  await page.getByLabel("一特一平含本赔率").fill("25");
  await page.getByRole("button", { name: "保存玩法" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav.getByRole("button", { name: "录入投注" }).click();
  await page.getByLabel("搜索玩法名称").fill("二中二含特验收");
  await expect(
    page.getByText("两平码按 55 倍；一特一平按 25 倍返还。"),
  ).toBeVisible();
  await nav.getByRole("button", { name: "历史统计" }).click();
  await expect(page.locator("tbody")).toContainText("2026287");
  await page
    .locator("tbody tr")
    .filter({ hasText: "2026287" })
    .getByRole("button")
    .click();
  await expect(
    page.getByRole("heading", { name: "历史统计 · 第 2026287 期" }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "历史统计", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    nav.getByRole("button", { name: "官方频道", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  // API waves take precedence over the local table: 01 is normally red.
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.today.draw = {
      expect: "2026287",
      open_time: "2026-10-14T21:32:00",
      numbers: [1, 2, 3, 4, 5, 6, 7],
      waves: [2, 0, 1, 2, 0, 1, 2],
      zodiac: [6, 5, 4, 3, 2, 1, 0],
    };
    await route.fulfill({ response, json });
  });
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.locator(".draw-panel .ball").first()).toHaveAttribute(
    "data-wave",
    "2",
  );
  await expect(page.locator(".draw-panel .ball").first()).toHaveAttribute(
    "aria-label",
    "01 绿波",
  );
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("button", { name: "本期概览" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map((v) => ({
      id: v.id,
      description: v.description,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("activation and expiry keep business screens inaccessible until renewed", async ({
  page,
}) => {
  let active = false;
  await page.route("**/api/license", (route) =>
    route.fulfill({
      json: {
        active,
        hosted: true,
        message: "请激活此账号",
        expires_at: 1800000000,
        remaining_seconds: 120,
      },
    }),
  );
  await page.route("**/api/license/activate", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      code: "MSH1-" + "a".repeat(64),
    });
    expect(route.request().postDataJSON().request_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    active = true;
    await route.fulfill({ json: { active: true } });
  });
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "激活工作台" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByLabel("旧版授权服务地址")).toBeHidden();
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations.map((v) => v.id)).toEqual([]);
  await page.getByLabel("一次性授权码").fill("MSH1-" + "a".repeat(64));
  await page.getByRole("button", { name: "激活并进入" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置" })
    .click();
  await page.getByRole("button", { name: "配置设置", exact: false }).click();
  await expect(page.locator(".license-countdown")).toContainText("0 天");
  await page.evaluate(() => {
    Date.now = () => -2208988800000;
  });
  await expect(page.locator(".license-countdown")).toContainText("0 天 00:01:");
  active = false;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.getByRole("heading", { name: "激活工作台" })).toBeVisible();
  await expect(page.getByText("旧码与服务迁移", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("一次性授权码").fill("MSH1-" + "a".repeat(64));
  await page.getByRole("button", { name: "激活并进入" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
});

test("statistics lists current bets with multiple filters, stable amount ordering and live refresh", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find(
    (p: { rule: { kind: string; quantity: number } }) =>
      p.rule.kind === "number" && p.rule.quantity === 1,
  );
  async function add(bettor: string, amount: string) {
    const response = await page.request.post("/api/bets", {
      headers: { "X-MarkSix": "1" },
      data: {
        period: boot.today.id,
        play_id: play.id,
        play_version: play.version,
        selections: [6],
        compound: false,
        bettor,
        amount,
        request_id: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(200);
  }
  await add("筛选客户甲", "30");
  await add("筛选客户乙", "10");
  await add("筛选客户甲", "20");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav.getByRole("button", { name: "投注记录", exact: true }).click();
  const picker = page
    .locator(".record-picker")
    .filter({ hasText: "投注人多选" });
  await picker.locator("summary").click();
  await picker
    .getByRole("checkbox", { name: "筛选客户甲", exact: true })
    .check();
  await picker
    .getByRole("checkbox", { name: "筛选客户乙", exact: true })
    .check();
  const rows = page.locator(".records-panel tbody tr");
  await expect(rows).toHaveCount(3);
  await page.getByLabel("记录排序").selectOption("amount_asc");
  await expect(rows.first()).toContainText("¥ 10.00");
  await expect(rows.last()).toContainText("¥ 30.00");
  const plays = page.locator(".record-picker").filter({ hasText: "玩法多选" });
  await plays.locator("summary").click();
  await plays
    .getByRole("checkbox", { name: play.rule.name, exact: true })
    .check();
  await picker
    .getByRole("checkbox", { name: "筛选客户乙", exact: true })
    .uncheck();
  await expect(rows).toHaveCount(2);
  await page.getByLabel("记录排序").selectOption("amount_desc");
  await expect(rows.first()).toContainText("¥ 30.00");
  await add("筛选客户甲", "5");
  await expect(rows).toHaveCount(3, { timeout: 10000 });
  await expect(rows.last()).toContainText("¥ 5.00");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("narrow mobile navigation retains readable labels and touch targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByLabel("客户账号").fill("test-admin");
  await page.getByLabel("登录密码").fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await expect(nav).toBeVisible();
  const buttons = nav.locator(":scope > .nav-item > .nav-link");
  await expect(buttons).toHaveCount(5);
  for (const button of await buttons.all()) {
    const rect = await button.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(44);
    expect(rect!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(nav.getByText("概览", { exact: true })).toBeVisible();
  await expect(nav.locator(".nav-label").first()).toBeHidden();
  const overflow = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: Array.from(document.querySelectorAll("body *"))
      .map((element) => ({
        name: element.tagName + "." + element.className,
        right: Math.round(element.getBoundingClientRect().right),
      }))
      .filter((element) => element.right > window.innerWidth)
      .slice(0, 12),
  }));
  await page.screenshot({ path: "test-results/navigation-narrow.png" });
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(
    overflow.width,
  );
});
