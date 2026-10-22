import { test, expect } from "./authenticated";
import { readFile } from "node:fs/promises";
import type { BettorStatement } from "../src/lib/bettor-statement";
import { unzipSync } from "fflate";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import {
  statementFilename,
  statementRows,
  statementTotals,
} from "../src/lib/bettor-statement";

const headers = { "X-MarkSix": "1" };
test("custom rule ordering survives reload without invalidating rule versions", async ({
  page,
}) => {
  await page.goto("/");
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const target = boot.plays
    .filter((p: { enabled: boolean }) => p.enabled)
    .at(-1);
  const nav = page.getByRole("navigation", { name: "主要导航" });
  try {
    await nav.getByRole("button", { name: "玩法与配置", exact: true }).click();
    await page.getByRole("button", { name: "排序玩法", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "排序玩法", exact: true });
    await dialog
      .getByRole("button", { name: `将${target.rule.name}置顶`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "保存排序", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await nav.getByRole("button", { name: "录入投注", exact: true }).click();
    await expect(page.locator(".play-picker button").first()).toContainText(
      target.rule.name,
    );
    await page.reload();
    await nav.getByRole("button", { name: "录入投注", exact: true }).click();
    await expect(page.locator(".play-picker button").first()).toContainText(
      target.rule.name,
    );
    const after = await (await page.request.get("/api/bootstrap")).json();
    expect(after.plays[0].version).toBe(target.version);
  } finally {
    const response = await page.request.put("/api/plays/order", {
      headers,
      data: {
        plays: boot.plays.map(
          ({ id, version }: { id: number; version: number }) => ({
            id,
            version,
          }),
        ),
      },
    });
    expect(response.ok()).toBe(true);
  }
});

test("mixed plays commit as one receipt, open child decisions, and cancel the whole receipt", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "录入投注", exact: true }).click();
  const bettor = `组合UI-${crypto.randomUUID().slice(0, 6)}`;
  await page.getByLabel("投注人", { exact: true }).fill(bettor);
  const search = page.getByLabel("搜索玩法名称");
  const options = page.getByLabel("输入投注项", { exact: true });
  await search.fill("特码直选");
  await options.fill("01、02");
  await page.getByLabel("每注金额", { exact: true }).fill("10");
  await page.getByRole("button", { name: "加入组合单", exact: true }).click();
  await expect(options).toHaveValue("");
  await options.fill("03");
  await page.getByLabel("每注金额", { exact: true }).fill("20");
  await page.getByRole("button", { name: "加入组合单", exact: true }).click();
  await search.fill("五有");
  await options.fill("鼠 牛 虎 兔 龙");
  await page.getByLabel("每注金额", { exact: true }).fill("30");
  await page.getByRole("button", { name: "加入组合单", exact: true }).click();
  const draft = page.getByLabel("组合单草稿", { exact: true });
  await expect(draft.locator("li")).toHaveCount(3);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(draft.locator(".slip-total")).toContainText("¥ 70.00");
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await nav.getByRole("button", { name: "录入投注", exact: true }).click();
  await expect(draft.locator("li")).toHaveCount(3);
  const requestIds: string[] = [];
  await page.route("**/api/slips", async (route) => {
    requestIds.push(route.request().postDataJSON().request_id);
    if (requestIds.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await draft
    .getByRole("button", { name: "确认录入组合单", exact: true })
    .click();
  await expect(draft.getByRole("alert")).toBeVisible();
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await nav.getByRole("button", { name: "录入投注", exact: true }).click();
  await draft
    .getByRole("button", { name: "确认录入组合单", exact: true })
    .click();
  await expect(draft).toHaveCount(0);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  const row = page
    .locator("section.records-panel")
    .filter({
      has: page.getByRole("heading", { name: "投注记录", exact: true }),
    })
    .locator("tbody tr")
    .filter({ hasText: bettor });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("组合单 · 3 项");
  await expect(row).toContainText("¥ 70.00");
  await row.getByRole("button", { name: /详情/ }).click();
  const detail = page.getByRole("dialog", { name: "组合单详情", exact: true });
  await detail
    .getByRole("button", { name: "分项判定与操作", exact: true })
    .first()
    .click();
  const child = page.getByRole("dialog", { name: "投注记录详情", exact: true });
  await expect(child).toBeVisible();
  await child.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await detail
    .getByRole("button", { name: "撤销整张组合单", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "确认撤销组合单", exact: true })
    .getByRole("button", { name: "确认整单撤销", exact: true })
    .click();
  await expect(detail).toContainText("已作废");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(row).toContainText("已撤销");
});

test("PDF archive contains each bettor under safe distinct filenames with embedded Chinese fonts", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const play = boot.plays.find(
    (p: { rule: { kind: string; quantity: number } }) =>
      p.rule.kind === "number" && p.rule.quantity === 1,
  );
  for (const bettor of ["PDF客户A", "PDF客户a"]) {
    const r = await page.request.post("/api/bets", {
      headers,
      data: {
        period: boot.today.id,
        play_id: play.id,
        play_version: play.version,
        selections: [6],
        compound: false,
        bettor,
        amount: "10",
        request_id: crypto.randomUUID(),
      },
    });
    expect(r.ok()).toBe(true);
  }
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出全部投注人账单", exact: true })
    .click();
  const result = await download;
  expect(result.suggestedFilename()).toContain(boot.today.id);
  const path = testInfo.outputPath("bettors.zip");
  await result.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  for (const name of ["PDF客户A.pdf", "PDF客户a (2).pdf"]) {
    expect(files[name]).toBeDefined();
    const doc = await PDFDocument.load(files[name]);
    expect(doc.getPageCount()).toBeGreaterThan(0);
    expect(doc.getTitle()).toContain("PDF客户");
    expect(
      doc.context
        .enumerateIndirectObjects()
        .some(
          ([, value]) =>
            value instanceof PDFDict && value.has(PDFName.of("FontFile2")),
        ),
    ).toBe(true);
  }
});

test("PDF names reject archive paths, reserved Windows names and case collisions", () => {
  const used = new Set<string>();
  expect(statementFilename("../甲:乙", used, "pdf")).toBe("_甲_乙.pdf");
  expect(statementFilename("CON", used, "pdf")).toBe("投注人-CON.pdf");
  expect(statementFilename("CON.ledger", used, "pdf")).toBe(
    "投注人-CON.ledger.pdf",
  );
  expect(statementFilename("σ", used, "pdf")).toBe("σ.pdf");
  expect(statementFilename("ς", used, "pdf")).toBe("ς (2).pdf");
  expect(statementFilename("A", used, "pdf")).toBe("A.pdf");
  expect(statementFilename("a", used, "pdf")).toBe("a (2).pdf");
  expect(
    new TextEncoder().encode(statementFilename("😀".repeat(80), used, "pdf"))
      .length,
  ).toBeLessThanOrEqual(255);
});

test("password dialog verifies confirmation, keeps wrong-password errors local and signs out on success", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "玩法与配置", exact: true })
    .click();
  await page.getByRole("button", { name: /配置设置/ }).click();
  let calls = 0;
  await page.route("**/api/account/password", (route) => {
    calls++;
    const input = route.request().postDataJSON();
    return route.fulfill(
      input.old_password === "wrong"
        ? { status: 422, json: { error: "原密码不正确" } }
        : { json: { ok: true } },
    );
  });
  await page.route("**/api/logout", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.getByRole("button", { name: "修改登录密码", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "修改登录密码",
    exact: true,
  });
  await dialog.getByLabel("原密码", { exact: true }).fill("wrong");
  await dialog.getByLabel("新密码", { exact: true }).fill("new-password-12345");
  await dialog
    .getByLabel("再次输入新密码", { exact: true })
    .fill("different-password");
  await dialog
    .getByRole("button", { name: "确认修改密码", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("两次新密码不一致");
  expect(calls).toBe(0);
  await dialog
    .getByLabel("再次输入新密码", { exact: true })
    .fill("new-password-12345");
  await dialog
    .getByRole("button", { name: "确认修改密码", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("原密码不正确");
  await dialog
    .getByLabel("原密码", { exact: true })
    .fill("correct-old-password");
  await dialog
    .getByRole("button", { name: "确认修改密码", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "进入工作台", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(2);
});

// Fontkit compact subsets use short loca offsets for small statements. Odd source
// offsets corrupt glyph outlines even when text extraction and the PDF header pass.
test("Chinese PDF font keeps glyph boundaries aligned for compact subsets", async () => {
  const bytes = await readFile("src/assets/NotoSansSC-Regular.ttf");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0)).toBe(0x00010000);
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const offset = 12 + i * 16;
    tables.set(
      bytes.toString("ascii", offset, offset + 4),
      view.getUint32(offset + 8),
    );
  }
  const longOffsets = view.getInt16(tables.get("head")! + 50) === 1;
  const count = view.getUint16(tables.get("maxp")! + 4);
  const location = tables.get("loca")!;
  let misaligned = 0;
  for (let i = 0; i <= count; i++) {
    const offset = longOffsets
      ? view.getUint32(location + i * 4)
      : view.getUint16(location + i * 2) * 2;
    if (offset % 4 !== 0) misaligned++;
  }
  expect(misaligned).toBe(0);
});

async function statementFixture(): Promise<BettorStatement> {
  return JSON.parse(await readFile("../test-results/slip-export.json", "utf8"));
}

test("statement sums receipts, excludes cancellation, handles refunded 49 and refuses inconsistent totals", async () => {
  const data = await statementFixture(),
    bettor = data.bettors[0];
  const rows = statementRows(bettor, true);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    stake: 119000n,
    rebate: 11900n,
    net: 265900n,
  });
  const wrong = structuredClone(bettor);
  wrong.totals.rebate++;
  expect(() => statementRows(wrong, true)).toThrow("明细与汇总不一致");
  const pending = structuredClone(bettor);
  pending.totals.net = null;
  for (const b of pending.bets)
    if (b.record.status !== "cancelled") {
      b.record.status = "pending";
      b.record.payout = null;
      b.results = null;
    }
  expect(statementRows(pending, false)[0].net).toBeNull();
  expect(() => statementRows(pending, true)).toThrow("结算记录不完整");
  const refunded = structuredClone(bettor);
  refunded.bets = [refunded.bets[0]];
  Object.assign(refunded.bets[0].record, {
    stake: 10000,
    payout: 10000,
    rebate: 0,
    void_stake: 10000,
  });
  refunded.bets[0].record.unit_count = 1;
  refunded.bets[0].atoms = [
    { ...refunded.bets[0].atoms[0], stake: 10000, rebate: 1000 },
  ];
  refunded.bets[0].results = [
    { voided: true, won: false, payout: 10000, rebate: 0, net: 0 },
  ];
  Object.assign(refunded.totals, {
    stake: 0,
    refunded: 10000,
    payout: 0,
    rebate: 0,
    net: 0,
  });
  expect(statementRows(refunded, true)[0]).toMatchObject({
    stake: 10000n,
    rebate: 0n,
    net: 0n,
  });
  const partial = structuredClone(bettor);
  partial.bets[0].record.status = "cancelled";
  Object.assign(partial.totals, {
    stake: 99000,
    payout: 333000,
    rebate: 9900,
    net: -243900,
  });
  const remaining = statementRows(partial, true);
  expect(remaining[0].stake).toBe(99000n);
  expect(remaining[0].createdAt).toBe(bettor.bets[0].record.created_at);
});

test("PDF and PNG use the compact receipt layout, paginate and release temporary fonts", async ({
  page,
}, testInfo) => {
  const data = await statementFixture();
  const bettor = data.bettors[0],
    original = bettor.bets[0];
  bettor.name = "分页对账客户";
  bettor.bets = Array.from({ length: 38 }, (_, i) => {
    const entry = structuredClone(original);
    Object.assign(entry.record, {
      id: `record-${String(i).padStart(3, "0")}`,
      slip_id: null,
      created_at: `2026-10-14T18:${String(i).padStart(2, "0")}:00`,
      stake: 1000,
      rebate: 100,
      payout: i % 2 ? 0 : 2000,
      status: "settled",
      void_stake: 0,
    });
    entry.record.unit_count = 1;
    entry.atoms = [
      { ...entry.atoms[0], stake: 1000, rebate: 100, rebate_percent: "10" },
    ];
    entry.results = [
      {
        voided: false,
        won: i % 2 === 0,
        payout: entry.record.payout!,
        rebate: 100,
        net: 1000 - entry.record.payout! - 100,
      },
    ];
    if (i % 7 === 0) {
      entry.record.unit_count = 2;
      entry.atoms = [
        { ...entry.atoms[0], stake: 500, rebate: 25, rebate_percent: "5" },
        { ...entry.atoms[0], stake: 500, rebate: 75, rebate_percent: "15" },
      ];
      entry.results = entry.atoms.map((atom) => ({
        voided: false,
        won: i % 2 === 0,
        payout: i % 2 ? 0 : 1000,
        rebate: atom.rebate,
        net: 500 - (i % 2 ? 0 : 1000) - atom.rebate,
      }));
    }
    return entry;
  }).reverse();
  Object.assign(bettor.totals, {
    stake: 38000,
    refunded: 0,
    rebate: 3800,
    payout: 38000,
    net: -3800,
  });
  await page.route("**/api/periods/*/bettor-export", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  let pdfPages = 0;
  for (const format of ["pdf", "png"]) {
    await page.getByLabel("账单导出格式").selectOption(format);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出全部投注人账单", exact: true })
      .click();
    await expect(page.getByLabel("账单导出格式")).toBeDisabled();
    const result = await download;
    const path = testInfo.outputPath(`compact-${format}.zip`);
    await result.saveAs(path);
    const files = unzipSync(new Uint8Array(await readFile(path)));
    if (format === "pdf") {
      const doc = await PDFDocument.load(files["分页对账客户.pdf"]);
      pdfPages = doc.getPageCount();
      expect(pdfPages).toBeGreaterThan(1);
    } else {
      expect(Object.keys(files)).toHaveLength(pdfPages);
      for (let i = 0; i < pdfPages; i++) {
        const bytes =
          files[`分页对账客户/${String(i + 1).padStart(3, "0")}.png`];
        expect([...bytes.slice(0, 8)]).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        expect(view.getUint32(16)).toBe(1191);
        expect(view.getUint32(20)).toBe(1684);
      }
      expect(
        await page.evaluate(
          () =>
            [...document.fonts].filter((f) =>
              f.family.startsWith("MarkSixStatement-"),
            ).length,
        ),
      ).toBe(0);
    }
    await expect(page.getByLabel("账单导出格式")).toBeEnabled();
  }
});

test("statement export cancellation never downloads partial PNG files", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "本期统计", exact: true }).click();
  await nav
    .getByRole("button", { name: "展开本期统计二级菜单", exact: true })
    .click();
  await nav
    .getByRole("button", { name: "投注人分类统计", exact: true })
    .click();
  await page.getByLabel("账单导出格式").selectOption("png");
  let resolveRequest!: () => void;
  const pending = new Promise<void>((resolve) => (resolveRequest = resolve));
  await page.route("**/api/periods/*/bettor-export", async (route) => {
    await pending;
    await route.fulfill({ json: await statementFixture() }).catch(() => {});
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page
    .getByRole("button", { name: "导出全部投注人账单", exact: true })
    .click();
  await page.getByRole("button", { name: "取消导出", exact: true }).click();
  resolveRequest();
  await expect(page.locator(".bettor-export [role=status]")).toHaveText(
    "已取消导出",
  );
  await expect(page.getByLabel("账单导出格式")).toBeEnabled();
  expect(downloads).toBe(0);
});

test("water bands use snapshot rates and already-rounded atom amounts; payout totals reconcile", async () => {
  const data = await statementFixture(),
    bettor = data.bettors[0];
  const entry = structuredClone(bettor.bets[0]);
  const atom = entry.atoms[0];
  entry.atoms = [
    { ...atom, stake: 20000, rebate: 1000, rebate_percent: "5.00" },
    { ...atom, stake: 30000, rebate: 3000, rebate_percent: "10" },
  ];
  entry.results = [
    { voided: false, won: false, payout: 0, rebate: 1000, net: 19000 },
    { voided: false, won: true, payout: 175000, rebate: 3000, net: -148000 },
  ];
  Object.assign(entry.record, {
    unit_count: 2,
    stake: 50000,
    payout: 175000,
    rebate: 4000,
    void_stake: 0,
  });
  bettor.bets = [entry];
  Object.assign(bettor.totals, {
    stake: 50000,
    payout: 175000,
    rebate: 4000,
    refunded: 0,
    net: -129000,
  });
  const rows = statementRows(bettor, true),
    total = statementTotals(rows, true);
  expect(rows[0].bands).toEqual([
    { rate: "5", base: 20000n, amount: 1000n },
    { rate: "10", base: 30000n, amount: 3000n },
  ]);
  expect(total).toMatchObject({
    stake: 50000n,
    payout: 175000n,
    rebate: 4000n,
    net: 129000n,
  });
  entry.atoms = [
    { ...atom, stake: 100, rebate: 1, rebate_percent: "0.50" },
    { ...atom, stake: 100, rebate: 1, rebate_percent: "0.5" },
  ];
  entry.results = entry.atoms.map(() => ({
    voided: false,
    won: false,
    payout: 0,
    rebate: 1,
    net: 99,
  }));
  Object.assign(entry.record, { stake: 200, payout: 0, rebate: 2 });
  Object.assign(bettor.totals, { stake: 200, payout: 0, rebate: 2, net: 198 });
  expect(statementRows(bettor, true)[0].bands).toEqual([
    { rate: "0.5", base: 200n, amount: 2n },
  ]);
  entry.atoms[0].rebate_percent = "bad";
  expect(() => statementRows(bettor, true)).toThrow("水钱比例");
});

test("zodiac packages split per zodiac, preserve draft mode and accept one decimal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("button", { name: "录入投注", exact: true }).click();
  await page.getByLabel("搜索玩法名称").fill("特码直选");
  await page.getByLabel("投注人", { exact: true }).fill("包肖UI");
  await page.getByRole("button", { name: "包肖投注", exact: true }).click();
  await page.getByLabel("输入投注项", { exact: true }).fill("狗 马");
  await page.getByLabel("每肖金额", { exact: true }).fill("100.1");
  await expect(page.locator(".summary-total")).toContainText("¥ 200.20");
  await expect(page.locator(".bet-summary")).toContainText("09");
  await nav.getByRole("button", { name: "本期概览", exact: true }).click();
  await nav.getByRole("button", { name: "录入投注", exact: true }).click();
  await expect(page.getByLabel("每肖金额", { exact: true })).toHaveValue(
    "100.1",
  );
  await page.getByLabel("每肖金额", { exact: true }).fill("100.12");
  await expect(
    page.getByRole("button", { name: "确认录入投注", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("每肖金额", { exact: true }).fill("100.1");
  await page.getByRole("button", { name: "加入组合单", exact: true }).click();
  const draft = page.getByLabel("组合单草稿", { exact: true });
  await expect(draft).toContainText("包肖：狗 · 马");
  await expect(draft.locator(".slip-total")).toContainText("¥ 200.20");
  await page.getByRole("button", { name: "直接选号", exact: true }).click();
  await page.getByLabel("输入投注项", { exact: true }).fill("44");
  await page.getByLabel("每注金额", { exact: true }).fill("10.5");
  await page.getByRole("button", { name: "加入组合单", exact: true }).click();
  await expect(draft.locator(".slip-total")).toContainText("¥ 210.70");
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/slips") && r.request().method() === "POST",
  );
  await draft
    .getByRole("button", { name: "确认录入组合单", exact: true })
    .click();
  const r = await response;
  expect(r.ok()).toBe(true);
  const id = (await r.json()).id;
  const detail = await (await page.request.get(`/api/slips/${id}`)).json();
  expect(detail.stake).toBe(21070);
  expect(detail.items[0].package_zodiacs).toEqual([10, 6]);
  expect(detail.items[0].unit_count).toBe(9);
  expect(detail.items[1].amount).toBe(1050);
  await expect(draft).toHaveCount(0);
});

test("settled current period still accepts entry and shows actual settlement preview", async ({
  page,
}) => {
  await page.route("**/api/bootstrap", async (route) => {
    const data = await (await route.fetch()).json();
    Object.assign(data.today, {
      state: "settled",
      phase: "settled",
      accepting_entries: true,
      draw: {
        numbers: [1, 2, 3, 4, 5, 6, 9],
        zodiac: [6, 5, 4, 3, 2, 1, 10],
        wave: [0, 0, 1, 1, 2, 2, 0],
        expect: data.today.id,
        open_time: "2026-10-14T21:34:00",
      },
    });
    await route.fulfill({ json: data });
  });
  await page.route("**/api/quote", (route) =>
    route.fulfill({
      json: {
        units: 1,
        stake: 1000,
        rebate: 100,
        max_return: 43000,
        max_profit: 42100,
        result: null,
        settled: true,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByLabel("搜索玩法名称").fill("特码直选");
  await page.getByLabel("投注人", { exact: true }).fill("开奖后客户");
  await page.getByLabel("输入投注项", { exact: true }).fill("09");
  await page.getByLabel("每注金额", { exact: true }).fill("10");
  await expect(
    page.getByRole("button", { name: "确认录入投注", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".quote-box")).toContainText("实际含本返还");
  await expect(page.locator(".quote-box")).toContainText("实际净输赢");
  await expect(page.locator(".quote-box")).toContainText("已确认开奖结果");
});
