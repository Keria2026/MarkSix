import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  use: {
    actionTimeout: 15000,
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1080 },
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
