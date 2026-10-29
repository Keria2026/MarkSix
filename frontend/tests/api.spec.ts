import { test, expect } from "@playwright/test";
import { api, ApiError } from "../src/lib/types";

test("malformed successful responses fail closed and HTTP errors retain their status", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>proxy error</html>");
    await expect(api("/slips")).rejects.toMatchObject({
      status: 200,
      message: "响应格式错误",
    });
    globalThis.fetch = async () => new Response("expired", { status: 401 });
    await expect(api("/bootstrap")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/bootstrap")).rejects.toMatchObject({ status: 401 });
    globalThis.fetch = async () => Response.json(null, { status: 401 });
    await expect(api("/bootstrap")).rejects.toMatchObject({ status: 401 });
    globalThis.fetch = async () =>
      Response.json({ error: "整单未保存" }, { status: 422 });
    await expect(api("/slips")).rejects.toMatchObject({
      status: 422,
      message: "整单未保存",
    });
    globalThis.fetch = async () => Response.json({ id: "saved" });
    await expect(api("/slips")).resolves.toEqual({ id: "saved" });
  } finally {
    globalThis.fetch = original;
  }
});
