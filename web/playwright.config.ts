import { defineConfig, devices } from '@playwright/test'

// The smoke test runs against the built bundle with the API mocked, so it needs
// no cluster and runs identically on a laptop and in CI. Integration against a
// real cluster is the kind-based e2e, not this.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Capped deliberately. Several tests measure real canvas timing — a camera
  // that animates into its fit, an overlay that has to stop repainting before a
  // measurement means anything — and Playwright's default worker count starves
  // them on a busy machine. They then fail for lack of CPU rather than for any
  // reason in the product, which is the worst kind of red.
  // One on CI, where the runner is small and the graph tests are the first
  // thing to starve; three locally, which is fast without contending.
  workers: process.env.CI ? 1 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    // Stated rather than inherited. Marsad defaults to dark, and Playwright
    // defaults to light, so leaving this out would silently test the theme the
    // product does not lead with — and the tests that care about the OS
    // preference say so themselves with test.use().
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
