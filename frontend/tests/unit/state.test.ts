import { test, expect, afterEach } from "bun:test";
import { textSubmission } from "../../src/lib/text-entry/submission";
import { textFingerprint } from "../../src/lib/text-entry/clipboard";
import { createRequestScope } from "../../src/lib/requests";
import {
  api,
  ApiError,
  annualMapping,
  entryCents,
  basicCount,
} from "../../src/lib/types";
import { entryModeFor } from "../../src/lib/features";
import { plays } from "./support";
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function storage() {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => entries.get(k) ?? null,
      setItem: (k: string, v: string) => entries.set(k, v),
      removeItem: (k: string) => entries.delete(k),
    },
  });
  return entries;
}
test("lost response after commit is recovered after reconstruction without a second POST", async () => {
  const entries = storage();
  let posts = 0;
  let saved = false;
  const hashes: string[] = [];
  const transport = (async (_path: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      posts++;
      saved = true;
      throw Error("response lost");
    }
    return { id: saved ? "recorded" : null };
  }) as typeof api;
  await expect(
    textSubmission("a", transport, (h) => hashes.push(h)).submit(
      { items: [] },
      "尾中0尾各100",
    ),
  ).rejects.toThrow("response lost");
  const pending = JSON.parse([...entries.values()][0]);
  expect(Object.keys(pending).sort()).toEqual(["fingerprint", "id"]);
  expect(pending.fingerprint).toBe(await textFingerprint("尾中0尾各100"));
  const rebuilt = textSubmission("a", transport, (h) => hashes.push(h));
  expect(await rebuilt.submit({ items: [] }, "尾中0尾各100")).toEqual({
    replayed: true,
  });
  expect(posts).toBe(1);
  expect(entries.size).toBe(0);
  expect(hashes).toHaveLength(1);
});
test("pre-commit failure reuses UUID and blocks a different pending original", async () => {
  storage();
  const ids: string[] = [];
  const transport = (async (_path: string, o?: RequestInit) => {
    if (o?.method === "POST") {
      ids.push(JSON.parse(o.body as string).request_id);
      if (ids.length === 1) throw Error("offline");
      return { id: "saved" };
    }
    return { id: null };
  }) as typeof api;
  await expect(
    textSubmission("a", transport, () => {}).submit({}, "3尾5000"),
  ).rejects.toThrow();
  await expect(
    textSubmission("a", transport, () => {}).submit({}, "4尾500"),
  ).rejects.toThrow("上一笔");
  await textSubmission("a", transport, () => {}).submit({}, "3尾5000");
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});
test("storage failure prevents a financial request, pending recovery stays within account", async () => {
  const entries = storage();
  let calls = 0;
  const transport = (async () => {
    calls++;
    return { id: null };
  }) as typeof api;
  entries.set(
    "marksix:pending-text:a",
    JSON.stringify({ id: crypto.randomUUID(), fingerprint: "a".repeat(64) }),
  );
  expect(await textSubmission("b", transport, () => {}).recover()).toBeNull();
  expect(calls).toBe(0);
  localStorage.setItem = () => {
    throw Error("denied");
  };
  await expect(
    textSubmission("b", transport, () => {}).submit({}, "3尾5000"),
  ).rejects.toThrow("本次未提交");
  expect(calls).toBe(0);
});
test("account disposal rejects late transport completion", async () => {
  let finish: (v: unknown) => void = () => {};
  const late = new Promise((resolve) => {
    finish = resolve;
  });
  const invalid: number[] = [];
  const scope = createRequestScope(
    (s) => invalid.push(s),
    (async () => await late) as typeof api,
  );
  const pending = scope.api("/bootstrap");
  scope.dispose();
  finish({ secret: "previous account" });
  await expect(pending).rejects.toThrow();
  expect(invalid).toEqual([]);
});
test("authentication invalidation reaches the caller once", async () => {
  const statuses: number[] = [];
  const scope = createRequestScope((s) => statuses.push(s), (async () => {
    throw new ApiError(402, "expired");
  }) as typeof api);
  await expect(scope.api("/bootstrap")).rejects.toThrow("expired");
  expect(statuses).toEqual([402]);
  scope.dispose();
});
test("entry modes and integer money helpers", () => {
  expect(entryCents("0.1")).toBe(10n);
  expect(entryCents("1.01")).toBeNull();
  expect(
    entryModeFor({
      entry_mode: "text",
      manual_entry: true,
      text_entry: true,
      layoffs: false,
    }),
  ).toBe("text");
  expect(
    entryModeFor({
      entry_mode: "text",
      manual_entry: true,
      text_entry: false,
      layoffs: false,
    }),
  ).toBe("manual");
  expect(
    entryModeFor({
      entry_mode: "text",
      manual_entry: false,
      text_entry: false,
      layoffs: false,
    }),
  ).toBeNull();
  expect(annualMapping(2026).zodiac).toHaveLength(49);
  expect(
    basicCount(
      plays.find((p) => p.rule.name === "三有")!.rule,
      [1, 6, 10, 11],
      true,
    ),
  ).toBe(4);
});

for (const value of [
  "null",
  "42",
  '"text"',
  "[]",
  "{",
  "{}",
  JSON.stringify({ id: "-".repeat(36), fingerprint: "a".repeat(64) }),
  JSON.stringify({ id: crypto.randomUUID(), fingerprint: "bad" }),
])
  test(`corrupt receipt blocks every financial request: ${value}`, async () => {
    const entries = storage();
    entries.set("marksix:pending-text:a", value);
    let calls = 0;
    const transport = (async () => {
      calls++;
      return {};
    }) as typeof api;
    await expect(
      textSubmission("a", transport, () => {}).submit({}, "sample"),
    ).rejects.toThrow("待处理提交标识损坏");
    expect(calls).toBe(0);
    expect(entries.get("marksix:pending-text:a")).toBe(value);
  });

test("unreadable receipt storage fails closed", async () => {
  storage();
  localStorage.getItem = () => {
    throw Error("denied");
  };
  let calls = 0;
  await expect(
    textSubmission(
      "a",
      (async () => {
        calls++;
      }) as typeof api,
      () => {},
    ).recover(),
  ).rejects.toThrow("请允许本站存储");
  expect(calls).toBe(0);
});

test("post-commit cleanup failure retains the receipt and cannot duplicate a write", async () => {
  storage();
  let posts = 0;
  const transport = (async (_path, options) => {
    if (options?.method === "POST") {
      posts++;
      return { id: "saved" };
    }
    return { id: "saved" };
  }) as typeof api;
  let blocked = true;
  const remember = () => {
    if (blocked) throw Error("storage changed");
  };
  const submission = textSubmission("a", transport, remember);
  await expect(submission.submit({}, "sample")).rejects.toThrow(
    "storage changed",
  );
  blocked = false;
  expect(await submission.submit({}, "sample")).toEqual({ replayed: true });
  expect(posts).toBe(1);
});
