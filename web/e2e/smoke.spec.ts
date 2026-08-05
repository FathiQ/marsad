import { expect, test } from '@playwright/test'

import { mockApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
})

test('renders the shell and the cluster summary', async ({ page }) => {
  await expect(page).toHaveTitle('Marsad')

  const header = page.getByRole('banner')
  await expect(header.getByText('workloads')).toBeVisible()
  await expect(header.getByText('unprotected')).toBeVisible()
})

test('says so when a policy provider is unavailable', async ({ page }) => {
  // Silently omitting domain policies would be worse than a graph that admits
  // it cannot see them.
  await expect(page.getByText('domain policies off')).toBeVisible()
})

test('draws the graph on a canvas', async ({ page }) => {
  // Sigma renders to WebGL canvases; their presence is the signal that layout
  // ran and the renderer mounted rather than white-screening.
  await expect(page.locator('main canvas').first()).toBeVisible()
})

test('the flow overlay sits above the graph without stealing clicks', async ({ page }) => {
  // The animation must never intercept a click meant for a node.
  await expect(page.locator('main canvas.pointer-events-none')).toHaveCount(1)
})

test('command palette opens with / and finds a workload', async ({ page }) => {
  await page.locator('body').press('/')
  await expect(page.getByRole('dialog', { name: 'Search the cluster' })).toBeVisible()

  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('api')
  await expect(page.getByRole('option', { name: /api/ }).first()).toBeVisible()
})

test('command palette opens with the meta shortcut too', async ({ page }) => {
  await page.locator('body').press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Search the cluster' })).toBeVisible()
})

test('selecting from the palette opens the inspector with the policy YAML', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector).toBeVisible()
  await expect(inspector.getByText('ingress isolated')).toBeVisible()

  // Traceability: the policy is listed and its original YAML is available
  // read-only. Exact match, because the policy name also appears inside the
  // rule identifier on the effective-rules list — which is itself the point.
  await inspector.getByText('api-ingress', { exact: true }).click()
  await expect(inspector.locator('pre')).toContainText('podSelector')
})

test('escape closes the inspector', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()
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
  const workload = page.getByRole('radio', { name: 'Workload' })
  await workload.click()
  await expect(workload).toHaveAttribute('data-state', 'on')
})

test('filters hide elements and say how many', async ({ page }) => {
  // Hiding without saying so leaves someone wondering where their workloads
  // went, so the count and a reset are part of the contract.
  await page.getByText('Only unprotected').click()
  await expect(page.getByText(/\d+ hidden/)).toBeVisible()

  await page.getByRole('button', { name: 'reset' }).click()
  await expect(page.getByText(/\d+ hidden/)).toBeHidden()
})

test('the legend explains that motion means permitted, not observed', async ({ page }) => {
  // Marsad reads declared policy. Animated edges must not be mistaken for
  // observed traffic, so the legend says which it is.
  await page.getByRole('button', { name: 'Legend' }).click()
  await expect(page.getByText(/never observes traffic/)).toBeVisible()
})

test('namespace filter is selectable from the rail', async ({ page }) => {
  await page.getByRole('button', { name: /prod/ }).first().click()
  await expect(page.getByRole('button', { name: /clear 1/ })).toBeVisible()
})

test('reports the websocket being down rather than looking live', async ({ page }) => {
  // No websocket is served by the preview server, so the UI must degrade to
  // "offline" instead of implying the graph is still updating.
  await expect(page.getByText('offline')).toBeVisible({ timeout: 10_000 })
})
