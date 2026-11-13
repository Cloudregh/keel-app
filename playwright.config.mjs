// Playwright setup. Browsers: Chromium, Firefox, WebKit (install with `npx playwright install`).
// In environments where Playwright can't download browsers, set PW_CHROMIUM_EXECUTABLE to a local Chrome.
import { defineConfig, devices } from "@playwright/test";

const chromiumLaunch = process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {};
const PORT = Number(process.env.KEEL_TEST_PORT || 4173);

export default defineConfig({
  testDir: "tests/js",
  timeout: 30_000,
  retries: 0,                       // flaky tests are bugs: never retried to green
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", timezoneId: "Africa/Accra", locale: "en-GB",
    // Request routing (fake tracker, blocked fonts) doesn't apply to service-worker-controlled pages in WebKit and
    // Firefox, so tests run without the app's service worker; J11 opts back in to test offline use.
    serviceWorkers: "block",
    // The app's Content-Security-Policy only lets it reach the real tracker address, and functional tests reach a
    // fake one instead (tests/js/fixtures/tracker-guard.mjs), so they run without it. The policy itself is tested
    // with this switched off in tests/js/e2e/csp.spec.mjs.
    bypassCSP: true },
  webServer: { command: `python3 -m http.server ${PORT} --bind 127.0.0.1`, url: `http://127.0.0.1:${PORT}/index.html`, reuseExistingServer: true },
  projects: [
    { name: "unit", testMatch: /unit\/.*\.spec\.mjs/, use: { ...devices["Desktop Chrome"], launchOptions: chromiumLaunch } },
    { name: "chromium", testMatch: /e2e\/.*\.spec\.mjs/, use: { ...devices["Desktop Chrome"], launchOptions: chromiumLaunch } },
    { name: "firefox", testMatch: /e2e\/.*\.spec\.mjs/, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testMatch: /e2e\/.*\.spec\.mjs/, use: { ...devices["Desktop Safari"] } }
  ]
});
