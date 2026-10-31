import { afterEach, expect, test } from "bun:test";
import { api, ApiError } from "../../src/lib/types";
import { createRequestScope } from "../../src/lib/requests";
import { businessDate } from "../../src/lib/business-date";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const headers of [
  { "X-Test": "object", "content-type": "application/custom" },
  new Headers({ "X-Test": "headers", "content-type": "application/custom" }),
  [
    ["X-Test", "tuples"],
    ["content-type", "application/custom"],
  ] as [string, string][],
])
  test("API preserves HeadersInit formats and required defaults", async () => {
    globalThis.fetch = (async (url, options) => {
      expect(url).toBe("/api/example");
      expect(options?.credentials).toBe("same-origin");
      const actual = new Headers(options?.headers);
      expect(actual.get("X-Test")).toBe(new Headers(headers).get("X-Test"));
      expect(actual.get("Content-Type")).toBe("application/custom");
      expect(actual.get("X-Marksix")).toBe("1");
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect(await api<{ ok: boolean }>("/example", { headers })).toEqual({
      ok: true,
    });
  });

for (const [body, status, message] of [
  ["not json", 200, "响应格式错误"],
  ["not json", 502, "请求失败（502）"],
  ['{"error":"请先登录"}', 401, "请先登录"],
  ['{"error":null}', 500, "操作失败"],
  ["null", 500, "操作失败"],
] as const)
  test(`API reports ${status} without leaking an HTML error page`, async () => {
    globalThis.fetch = (async (_url, options) => {
      expect(new Headers(options?.headers).get("Content-Type")).toBe(
        "application/json",
      );
      return new Response(body, { status });
    }) as typeof fetch;
    const error = await api("/example").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("Expected ApiError");
    expect(error.status).toBe(status);
    expect(error.message).toBe(message);
  });

test("disposed and pre-aborted requests never reach transport", async () => {
  let calls = 0;
  const scope = createRequestScope(() => {}, (async () => {
    calls++;
  }) as typeof api);
  const signal = AbortSignal.abort();
  await expect(scope.api("/data", { signal })).rejects.toThrow();
  scope.dispose();
  await expect(scope.api("/data")).rejects.toThrow();
  expect(calls).toBe(0);
});

test("caller cancellation suppresses a late authentication failure", async () => {
  const invalid: number[] = [];
  let fail!: (error: Error) => void;
  const scope = createRequestScope(
    (status) => invalid.push(status),
    (() =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })) as typeof api,
  );
  const controller = new AbortController();
  const request = scope.api("/data", { signal: controller.signal });
  controller.abort();
  fail(new ApiError(401, "old account"));
  await expect(request).rejects.toThrow();
  expect(invalid).toEqual([]);
});

test("ordinary failures do not invalidate an account and successes remain reusable", async () => {
  const invalid: number[] = [];
  let fail = true;
  const scope = createRequestScope(
    (status) => invalid.push(status),
    (async () => {
      if (fail) throw new ApiError(503, "unavailable");
      return { ok: true };
    }) as typeof api,
  );
  await expect(scope.api("/data")).rejects.toThrow("unavailable");
  fail = false;
  expect(await scope.api<{ ok: boolean }>("/data")).toEqual({ ok: true });
  expect(invalid).toEqual([]);
});

for (const [instant, expected] of [
  ["2040-01-01T15:59:59.999Z", "2040-01-01"],
  ["2040-01-01T16:00:00Z", "2040-01-01"],
  ["2040-01-01T21:59:59.999Z", "2040-01-01"],
  ["2040-01-01T22:00:00Z", "2040-01-02"],
  ["2039-12-31T22:00:00Z", "2040-01-01"],
  ["2040-02-28T22:00:00Z", "2040-02-29"],
])
  test(`business date respects Beijing 06:00: ${instant}`, () => {
    expect(businessDate(new Date(instant))).toBe(expected);
  });
