import { defineConfig } from "@playwright/test";

const recording = process.env.SHIPYARD_RECORD_DEMO === "1";
const viewport = { width: 1320, height: 800 };

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".shipyard/playwright/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    viewport,
    colorScheme: "dark",
    reducedMotion: "reduce",
    video: recording ? { mode: "on", size: viewport } : "off",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
