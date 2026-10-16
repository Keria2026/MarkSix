import { test, expect } from "./authenticated";
import type { Locator, Page } from "@playwright/test";
import { parseSelections } from "../src/lib/selection";

async function openZodiacs(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注" })
    .click();
  await page.getByRole("button", { name: "五有" }).click();
}

async function appearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      border: style.borderTopColor,
      shadow: style.boxShadow,
    };
  });
}

test.describe("touch selection", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("deselecting a zodiac restores the untouched white appearance", async ({
    page,
  }) => {
    await openZodiacs(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const dog = page.getByRole("button", { name: "狗", exact: true });
    const base = await appearance(
      page.getByRole("button", { name: "猪", exact: true }),
    );
    for (const name of ["蛇", "马", "羊", "鸡"])
      await page.getByRole("button", { name, exact: true }).tap();

    // Repeat without tapping elsewhere: touch Safari can retain the last hover.
    for (let i = 0; i < 2; i++) {
      await dog.tap();
      await expect(dog).toHaveAttribute("aria-pressed", "true");
      await expect(dog.locator(".selection-check")).toHaveCount(1);
      await expect
        .poll(async () => (await appearance(dog)).image)
        .not.toBe("none");
      await dog.tap();
      await expect(dog).toHaveAttribute("aria-pressed", "false");
      await expect(dog.locator(".selection-check")).toHaveCount(0);
      await expect.poll(() => appearance(dog)).toEqual(base);
      await expect(page.locator(".selection-meta")).toContainText("已选 4 项");
      await expect(page.locator(".option.selected")).toHaveCount(4);
    }
    await page.getByRole("button", { name: "清空选择", exact: true }).tap();
    await expect(page.locator(".option.selected")).toHaveCount(0);
    await expect.poll(() => appearance(dog)).toEqual(base);
  });
});

test("mouse hover preserves selection fill and keyboard focus stays visible", async ({
  page,
}) => {
  await openZodiacs(page);
  const dog = page.getByRole("button", { name: "狗", exact: true });
  const base = await appearance(
    page.getByRole("button", { name: "猪", exact: true }),
  );
  await dog.click();
  await dog.hover();
  await expect(dog).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await appearance(dog)).image).not.toBe("none");
  await dog.click();
  await expect(dog).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => (await appearance(dog)).background)
    .toBe(base.background);
  await expect.poll(async () => (await appearance(dog)).image).toBe("none");
  await expect(dog.locator(".selection-check")).toHaveCount(0);
  await page.keyboard.press("Tab");
  const pig = page.getByRole("button", { name: "猪", exact: true });
  await expect(pig).toBeFocused();
  expect(
    await pig.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.matches(":focus-visible") && style.outlineStyle !== "none";
    }),
  ).toBe(true);
});

test("typed options accept Unicode delimiters and reject unknown values without losing order", () => {
  expect(
    parseSelections(
      "number",
      "０６，45、01；02：03/04\\05 | 06! 08?09@10#11$12%13^14&15*16(17)[18]{19}〈20〉…21—22_23\n24\t25",
    ),
  ).toEqual([
    6, 45, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25,
  ]);
  expect(parseSelections("zodiac", "鼠、牛，虎；马 鼠")).toEqual([0, 1, 2, 6]);
  expect(parseSelections("wave", "红 蓝波，绿；红波")).toEqual([0, 1, 2]);
  expect(parseSelections("tail", "0尾、01，9尾")).toEqual([0, 1, 9]);
  expect(parseSelections("size", "大，小")).toEqual([1, 0]);
  expect(parseSelections("parity", "单，双")).toEqual([1, 0]);
  expect(parseSelections("zodiac_count", "4、4种生肖")).toEqual([4]);
  expect(parseSelections("number", "， ；")).toEqual([]);
  for (const value of ["00", "50", "01 abc", "1至5"])
    expect(() => parseSelections("number", value)).toThrow();
});

test("typed selections share grid limits, keep partial input, and preserve hard-pair order", async ({
  page,
}) => {
  await openZodiacs(page);
  const input = page.getByLabel("输入投注项", { exact: true });
  await input.fill("鼠、牛，虎；兔 龙");
  await expect(page.locator(".option.selected")).toHaveCount(5);
  await input.fill("鼠、牛，虎；兔 龙 马");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("最多选择 5 项");
  await expect(page.locator(".option.selected")).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "确认录入投注" }),
  ).toBeDisabled();
  await input.fill("鼠 牛");
  await page.getByRole("button", { name: "虎", exact: true }).click();
  await expect(input).toHaveValue("鼠 牛 虎");
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(input).toHaveValue("");
  await page.getByLabel("搜索玩法名称").fill("特码直选");
  await input.pressSequentially("01 02,03");
  await expect(page.locator(".option.selected")).toHaveCount(3);
  await expect(input).toHaveValue("01 02,03");
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const base = boot.plays.find(
    (p: { rule: { kind: string } }) => p.rule.kind === "number",
  ).rule;
  const pair = await page.request.post("/api/plays", {
    headers: { "X-MarkSix": "1" },
    data: {
      ...base,
      name: "文本特碰验收",
      kind: "number",
      scope: "all",
      condition: "hard_pair",
      relation: "eq",
      quantity: 2,
      combination_size: 2,
      compound_enabled: false,
      selection_limit: 2,
      special_hit_odds: null,
    },
  });
  expect(pair.ok()).toBe(true);
  const id = (await pair.json()).id;
  try {
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await page.getByLabel("搜索玩法名称").fill("文本特碰验收");
    await input.fill("45，06");
    await expect(
      page.getByText("当前：特码 45 → 平码 06", { exact: false }),
    ).toBeVisible();
    await input.fill("45,06,07");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(".option.selected")).toHaveCount(2);
    await input.fill("06/45");
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await expect(
      page.getByText("当前：特码 06 → 平码 45", { exact: false }),
    ).toBeVisible();
    await input.fill("06,未知");
    await expect(page.getByRole("alert")).toContainText("无法识别");
    await expect(page.locator(".option.selected")).toHaveCount(2);
  } finally {
    await page.request.delete(`/api/plays/${id}`, {
      headers: { "X-MarkSix": "1" },
      data: { version: 1 },
    });
  }
});
