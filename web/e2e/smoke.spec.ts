import { expect, test } from '@playwright/test'

import { mockApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
})

test('renders the shell and the cluster summary', async ({ page }) => {
  await expect(page).toHaveTitle('Marsad')

  // The header counts are the first thing proving data reached the UI. Scoped
  // to the header, since "workloads" also appears in the sidebar.
  const header = page.locator('.header')
  await expect(header.locator('.stat', { hasText: 'workloads' })).toBeVisible()
  await expect(header.locator('.stat.alert')).toContainText('unprotected')
})

test('says so when a policy provider is unavailable', async ({ page }) => {
  // Silently omitting domain policies would be worse than a graph that admits
  // it cannot see them.
  await expect(page.getByText('domain policies unavailable')).toBeVisible()
})

test('draws the graph on a canvas', async ({ page }) => {
  // Sigma renders to WebGL canvases; their presence is the signal that layout
  // ran and the renderer mounted rather than white-screening.
  await expect(page.locator('.canvas canvas').first()).toBeVisible()
  await expect(page.locator('.canvas canvas')).not.toHaveCount(0)
})

test('lists namespaces with their unprotected counts', async ({ page }) => {
  await expect(page.getByRole('button', { name: /prod/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /edge/ })).toBeVisible()
})

test('search focuses with / and finds a workload', async ({ page }) => {
  await page.locator('body').press('/')
  const search = page.getByLabel('Search namespaces and workloads')
  await expect(search).toBeFocused()

  await search.fill('api')
  await expect(page.getByText('Jump to')).toBeVisible()
})

test('opens the detail drawer and shows the applied policy YAML', async ({ page }) => {
  await page.locator('body').press('/')
  const search = page.getByLabel('Search namespaces and workloads')
  await search.fill('api')
  await page.getByRole('button', { name: /^api/ }).first().click()

  const drawer = page.getByRole('dialog', { name: 'Details' })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.badge', { hasText: 'ingress isolated' })).toBeVisible()

  // Traceability: the policy is listed, and its original YAML is available
  // read-only. This is the feature the whole tool exists for.
  //
  // Exact match matters here: the policy name also appears inside the rule
  // identifier on the effective-rules list, which is itself the point.
  await drawer.getByText('api-ingress', { exact: true }).click()
  await expect(drawer.locator('pre.yaml')).toContainText('podSelector')
})

test('escape closes the drawer', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByLabel('Search namespaces and workloads').fill('api')
  await page.getByRole('button', { name: /^api/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Details' })).toBeVisible()

  await page.locator('body').press('Escape')
  await expect(page.getByRole('dialog', { name: 'Details' })).toBeHidden()
})

test('toggles between dark and light', async ({ page }) => {
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await page.getByLabel('Toggle theme').click()
  await expect(html).toHaveAttribute('data-theme', 'light')
})

test('switches aggregation level', async ({ page }) => {
  await page.getByRole('button', { name: 'Workload', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Workload', exact: true })).toHaveClass(/on/)
})

test('reports the websocket being down rather than looking live', async ({ page }) => {
  // No websocket is served by the preview server, so the UI must degrade to
  // "offline" instead of implying the graph is still updating.
  await expect(page.getByText('offline')).toBeVisible({ timeout: 10_000 })
})
