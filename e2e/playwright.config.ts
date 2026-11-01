// Browser E2E for the maintenance panel against a production build (`next start`), with dummy credentials that exist only in this CI job.
// Run by .github/workflows/e2e.yml; not part of the app (excluded from the app's tsconfig, @playwright/test is installed with --no-save in CI).
import { defineConfig } from "@playwright/test";
import path from "node:path";

const APP = path.join(__dirname, "..");   // `next start` runs in the app directory

const PW = process.env.E2E_PW ?? "local-e2e-only-password";
export default defineConfig({
  testDir: ".",
  testMatch: /vault-backup\.spec\.ts/,
  repeatEach: 8,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["github"]],
  use: { browserName: "chromium", trace: "off" },
  webServer: [
    // maintenance ENABLED (dummy, job-local credentials)
    { command: "npx next start -p 3100", port: 3100, reuseExistingServer: false, timeout: 120_000, cwd: APP,
      env: { MAINTENANCE_ENABLED: "1", MAINTENANCE_BASIC_USER: "e2e-user", MAINTENANCE_BASIC_PASSWORD: PW } },
    // maintenance DISABLED (no variables): the area must be a 404
    { command: "npx next start -p 3101", port: 3101, reuseExistingServer: false, timeout: 120_000, cwd: APP,
      env: { MAINTENANCE_ENABLED: "", MAINTENANCE_BASIC_USER: "", MAINTENANCE_BASIC_PASSWORD: "" } },
  ],
});
