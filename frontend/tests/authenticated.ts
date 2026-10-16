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
  storageState: async ({ sessionCookies }, use) => {
    await use({ cookies: sessionCookies, origins: [] });
  },
});
export { expect };
