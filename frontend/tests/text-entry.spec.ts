import { test, expect } from "./authenticated";
import AxeBuilder from "@axe-core/playwright";

test("text paste previews without writes, submits one idempotent slip and learns confirmed aliases", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  const panel = page.getByRole("region", { name: "文本录注" });
  const bettor = `文本验收-${Date.now()}`;
  await panel.getByLabel("投注人", { exact: true }).fill(bettor);
  await panel.getByLabel("投注原文").fill("特：07各10\n特：08各20");
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find(
    (p: { rule: { name: string } }) => p.rule.name === "特码直选",
  );
  await page.request.delete("/api/text-entry/preferences/特", {
    headers: { "X-Marksix": "1" },
  });
  // Reload the component's habit cache after clearing only this test alias.
  await page.getByRole("button", { name: "手工录注", exact: true }).click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await expect(panel.locator(".text-entry-rows > li")).toHaveCount(2);
  const previewButton = panel.getByRole("button", { name: "校验并预览整单" });
  await expect(previewButton).toBeDisabled();
  await panel.getByLabel("“特”对应玩法").selectOption(String(play.id));
  const records = async () =>
    await (
      await page.request.post("/api/records/search", {
        headers: { "X-Marksix": "1" },
        data: { period: boot.today.id, bettors: [bettor] },
      })
    ).json();
  expect((await records()).total).toBe(0);
  await previewButton.click();
  await expect(panel.locator(".slip-total")).toContainText("1 张投注单");
  expect((await records()).total).toBe(0);
  const submit = panel.getByRole("button", {
    name: "确认录入整单",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await panel.getByLabel("第1项金额", { exact: true }).fill("15");
  await expect(submit).toBeDisabled();
  await previewButton.click();
  await expect(panel.locator(".slip-total")).toContainText("35");
  expect(
    (await new AxeBuilder({ page }).include(".text-entry").analyze())
      .violations,
  ).toEqual([]);
  await panel.getByLabel("已逐项核对玩法、选项和总金额").check();
  const requests: {
    request_id: string;
    items: unknown[];
    text_preferences: unknown[];
  }[] = [];
  await page.route("**/api/slips", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await submit.click();
  await expect(panel.getByRole("alert").last()).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(panel.getByLabel("投注原文")).toHaveValue("");
  expect(requests).toHaveLength(2);
  expect(requests[0].request_id).toBe(requests[1].request_id);
  expect(requests[0]).not.toHaveProperty("raw");
  const saved = await records();
  expect(saved.total).toBe(1);
  expect(saved.items[0].grouped).toBe(true);
  expect(saved.items[0].items).toHaveLength(2);
  expect(saved.items[0].stake).toBe(3500);
  await panel.getByLabel("投注原文").fill("特：09各30");
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await expect(panel.getByLabel("“特”对应玩法")).toHaveValue(String(play.id));
  await expect(previewButton).toBeEnabled();
  await previewButton.click();
  await panel.getByLabel("已逐项核对玩法、选项和总金额").check();
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.plays.find((p: { id: number }) => p.id === play.id).version++;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(submit).toBeDisabled();
  await page.unroute("**/api/bootstrap");
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel.screenshot({ path: `test-results/text-entry-${width}.png` });
  }
  await panel.getByText("已记住的习惯", { exact: false }).click();
  await panel.getByRole("button", { name: "忘记特", exact: true }).click();
  await expect
    .poll(
      async () =>
        await (await page.request.get("/api/text-entry/preferences")).json(),
    )
    .not.toContainEqual(expect.objectContaining({ alias: "特" }));
});

test("unknown fragments and ambiguous amounts block the whole text slip", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  const panel = page.getByRole("region", { name: "文本录注" });
  await panel.getByLabel("投注人", { exact: true }).fill("文本阻断验收");
  await panel
    .getByLabel("投注原文")
    .fill("特码直选：羊300\n特码直选：07各10 未知要求");
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await expect(panel.locator(".text-entry-rows > li")).toHaveCount(3);
  await expect(
    panel.getByRole("button", { name: "校验并预览整单" }),
  ).toBeDisabled();
  await panel.getByLabel("第1项金额含义").selectOption("package");
  await expect(
    panel.getByRole("button", { name: "校验并预览整单" }),
  ).toBeDisabled();
  await expect(panel.locator("blockquote").last()).toContainText("未知要求");
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "本期概览", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await expect(panel.getByLabel("投注原文")).toHaveValue(/未知要求/u);
  const oversized = "特码".repeat(6001);
  await panel.getByLabel("投注原文").fill(oversized);
  await expect(panel.getByLabel("投注原文")).toHaveValue(oversized);
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await expect(panel.getByRole("alert").last()).toContainText("12,000");
  await expect(panel.locator(".text-entry-rows > li")).toHaveCount(0);
});

test("a customer can teach a new alias and a per-zodiac amount, then forget it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本期概览", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  const panel = page.getByRole("region", { name: "文本录注" });
  const alias = "个人新简称";
  await page.request.delete(`/api/text-entry/preferences/${alias}`, {
    headers: { "X-Marksix": "1" },
  });
  await page.getByRole("button", { name: "手工录注", exact: true }).click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find(
    (p: { rule: { name: string } }) => p.rule.name === "特码直选",
  );
  await panel.getByLabel("投注人", { exact: true }).fill("学习金额验收");
  await panel.getByLabel("投注原文").fill(`${alias}羊300`);
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await panel
    .getByRole("combobox", { name: "对应玩法", exact: true })
    .selectOption(String(play.id));
  await panel.getByLabel("未识别的玩法简称（可选）").fill(alias);
  await panel.getByLabel("第1项投注项").fill("羊");
  await panel.getByLabel("第1项金额含义").selectOption("package");
  await panel.getByRole("button", { name: "校验并预览整单" }).click();
  await expect(panel.locator(".slip-total")).toContainText("300");
  await panel.getByLabel("已逐项核对玩法、选项和总金额").check();
  await panel
    .getByRole("button", { name: "确认录入整单", exact: true })
    .click();
  await expect(panel.getByLabel("投注原文")).toHaveValue("");
  await page.reload();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await panel.getByLabel("投注人", { exact: true }).fill("学习金额验收");
  await panel.getByLabel("投注原文").fill(`${alias}马300`);
  await panel.getByRole("button", { name: "识别整单", exact: true }).click();
  await expect(panel.getByLabel(`“${alias}”对应玩法`)).toHaveValue(
    String(play.id),
  );
  await expect(panel.getByLabel("第1项金额含义")).toHaveValue("package");
  await panel.getByRole("button", { name: "校验并预览整单" }).click();
  await expect(panel.locator(".slip-total")).toContainText("5 注");
  await expect(panel.locator(".slip-total")).toContainText("300");
  await panel.getByText("已记住的习惯", { exact: false }).click();
  await panel
    .getByRole("button", { name: `忘记${alias}`, exact: true })
    .click();
});
