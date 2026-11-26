import { defineConfig } from "@playwright/test";
import config from "./playwright.config.ts";

export default defineConfig({
  ...config,
  testMatch: "**/docker-smoke.ts",
  outputDir: ".shipyard/playwright/docker-smoke",
  timeout: 120_000,
  use: { ...config.use, video: "off" },
});
