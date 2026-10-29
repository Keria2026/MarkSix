import { test as base, expect, type Cookie } from "@playwright/test";

// UI-only suites reuse a real session in memory. Authentication suites remain independent.
export const test = base.extend<{}, { sessionCookies: Cookie[] }>({
  sessionCookies: [
    async ({ playwright }, use, workerInfo) => {
      const request = await playwright.request.newContext({
        baseURL: workerInfo.project.use.baseURL,
      });
      try {
        const response = await request.post("/api/login", {
          headers: { "X-MarkSix": "1" },
          data: {
            username: "test-admin",
            password: process.env.TEST_ADMIN_PASSWORD,
          },
        });
        expect(response.status()).toBe(200);
        await use((await request.storageState()).cookies);
      } finally {
        await request.dispose();
      }
    },
    { scope: "worker" },
  ],
  storageState: async ({ sessionCookies, playwright }, use, info) => {
    const storageState = { cookies: sessionCookies, origins: [] };
    const request = await playwright.request.newContext({
      baseURL: info.project.use.baseURL,
      storageState,
    });
    try {
      // Existing business suites explicitly exercise all modules. Product defaults
      // are tested separately; fixture setup must not change the app's defaults.
      expect(
        (
          await request.put("/api/settings/features", {
            headers: { "X-MarkSix": "1" },
            data: { layoffs: true, manual_entry: true, text_entry: true },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await request.put("/api/settings/entry-mode", {
            headers: { "X-MarkSix": "1" },
            data: { entry_mode: "manual" },
          })
        ).ok(),
      ).toBe(true);
    } finally {
      await request.dispose();
    }
    await use(storageState);
  },
});
export { expect };
