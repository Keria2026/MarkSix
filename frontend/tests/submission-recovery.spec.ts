import { test, expect } from "./authenticated";
for (const committed of [true, false])
  test(`reload recovers a text submission, committed=${committed}`, async ({
    page,
    context,
  }) => {
    const raw = "特码直选07各13",
      bettor = `恢复-${committed}-${Date.now()}`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page
      .getByRole("heading", { name: "本期概览", exact: true })
      .waitFor();
    await page.evaluate(() => navigator.clipboard.writeText(""));
    async function open() {
      await page
        .getByRole("navigation", { name: "主要导航" })
        .getByRole("button", { name: "录入投注", exact: true })
        .click();
      await page.getByRole("button", { name: "文本录注", exact: true }).click();
      await page.getByLabel("投注原文", { exact: true }).fill(raw);
      await page.getByRole("button", { name: "校验", exact: true }).click();
      const d = page.getByRole("dialog", { name: "确认投注单", exact: true });
      await d.getByLabel("投注人", { exact: true }).fill(bettor);
      await expect(
        d.getByRole("button", { name: "确认录入", exact: true }),
      ).toBeEnabled();
      return d;
    }
    const ids: string[] = [];
    await page.route("**/api/slips", async (route) => {
      ids.push(route.request().postDataJSON().request_id);
      if (ids.length === 1) {
        if (committed) expect((await route.fetch()).ok()).toBe(true);
        await route.abort("failed");
      } else await route.continue();
    });
    let d = await open();
    await d.getByRole("button", { name: "确认录入", exact: true }).click();
    await expect(d.getByRole("alert").last()).toBeVisible();
    const pending = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("marksix:pending-text:test-admin")!),
    );
    expect(pending.id).toBe(ids[0]);
    expect(pending.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(pending).sort()).toEqual(["fingerprint", "id"]);
    await page.reload();
    await page
      .getByRole("heading", { name: "本期概览", exact: true })
      .waitFor();
    if (committed) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            localStorage.getItem("marksix:pending-text:test-admin"),
          ),
        )
        .toBeNull();
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
        window.dispatchEvent(new Event("focus"));
      }, raw);
      await page.waitForTimeout(300);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(ids).toHaveLength(1);
    } else {
      d = await open();
      await d.getByRole("button", { name: "确认录入", exact: true }).click();
      await expect(d).toHaveCount(0);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
    }
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const result = await (
      await page.request.post("/api/records/search", {
        headers: { "X-MarkSix": "1" },
        data: { period: boot.today.id, bettors: [bettor] },
      })
    ).json();
    expect(result.total).toBe(1);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("marksix:pending-text:test-admin"),
      ),
    ).toBeNull();
    await page.evaluate(() => navigator.clipboard.writeText(""));
  });

test("storage failure blocks a financial request before it is sent", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("marksix:pending-text:"))
        throw new DOMException("denied", "SecurityError");
      original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByRole("heading", { name: "本期概览", exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("button", { name: "录入投注", exact: true })
    .click();
  await page.getByRole("button", { name: "文本录注", exact: true }).click();
  await page.getByLabel("投注原文", { exact: true }).fill("特码直选07各13");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认投注单", exact: true });
  await dialog.getByLabel("投注人", { exact: true }).fill("存储拒绝验收");
  const submit = dialog.getByRole("button", { name: "确认录入", exact: true });
  await expect(submit).toBeEnabled();
  let submitted = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/slips" && r.method() === "POST")
      submitted++;
  });
  await submit.click();
  await expect(dialog.getByRole("alert").last()).toContainText("本次未提交");
  expect(submitted).toBe(0);
});
