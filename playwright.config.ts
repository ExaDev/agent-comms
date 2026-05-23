import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/bridges/user/web/e2e",
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    baseURL: "http://127.0.0.1",
  },
});
