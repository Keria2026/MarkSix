import { test, expect } from "./authenticated";
import { readFile } from "node:fs/promises";
import type { BettorStatement } from "../src/lib/bettor-statement";
import { unzipSync } from "fflate";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import { statementFilename, statementRows } from "../src/lib/bettor-statement";

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
  Object.assign(partial.totals, { stake: 99000, rebate: 9900, net: -243900 });
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
