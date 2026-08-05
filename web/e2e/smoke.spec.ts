import { expect, test } from '@playwright/test'

import { graph, mockApi } from './fixtures'

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

test('the legend opens on screen and explains that motion means permitted', async ({ page }) => {
  // Marsad reads declared policy. Animated edges must not be mistaken for
  // observed traffic, so the legend says which it is.
  //
  // The viewport assertion matters as much as the text one: the previous
  // implementation opened 684px above the top of the window, so pressing the
  // button appeared to do nothing — and this test still passed, because
  // toBeVisible only requires a non-empty box, not one you can see.
  await page.getByRole('button', { name: 'Legend' }).click()

  const panel = page.getByRole('dialog', { name: 'Legend' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/never observes traffic/)).toBeVisible()

  const box = await panel.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
})

test('escape closes the legend', async ({ page }) => {
  await page.getByRole('button', { name: 'Legend' }).click()
  await expect(page.getByRole('dialog', { name: 'Legend' })).toBeVisible()
  await page.locator('body').press('Escape')
  await expect(page.getByRole('dialog', { name: 'Legend' })).toBeHidden()
})

test('namespace filter is selectable from the rail', async ({ page }) => {
  await page.getByRole('button', { name: /prod/ }).first().click()
  await expect(page.getByRole('button', { name: /clear 1/ })).toBeVisible()
})

test('the graph keeps painting through a zoom gesture', async ({ page }) => {
  // Two bugs made the cards strobe during a zoom, and both were invisible in a
  // still screenshot. The overlay canvas was being cleared between draws because
  // resizing it to its existing size still wipes the bitmap; and the card,
  // chip and dot thresholds sat right where the default zoom lands, so a small
  // scroll flipped cards in and out of existence. Sampling how much of the
  // overlay is painted across a gesture catches either returning.
  const painted = () =>
    page.evaluate(() => {
      const canvases = [...document.querySelectorAll('main canvas')] as HTMLCanvasElement[]
      const overlay = canvases[canvases.length - 1]
      if (!overlay) return 0
      const ctx = overlay.getContext('2d')
      if (!ctx) return 0
      const { data } = ctx.getImageData(0, 0, overlay.width, overlay.height)
      let count = 0
      for (let i = 3; i < data.length; i += 4 * 97) if ((data[i] ?? 0) > 8) count++
      return count
    })

  await page.waitForTimeout(1500)
  await page.mouse.move(700, 450)

  const samples: number[] = []
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? -140 : 140)
    await page.waitForTimeout(80)
    samples.push(await painted())
  }

  // Nothing may go blank, and no frame may lose most of the picture.
  const peak = Math.max(...samples)
  expect(Math.min(...samples)).toBeGreaterThan(0)
  expect(Math.min(...samples)).toBeGreaterThan(peak * 0.35)
})

test('stays live when the graph query changes', async ({ page }) => {
  // Changing the query tears the stream down and opens a replacement. The old
  // socket's close event arrives *after* the new one has connected, and it used
  // to report "offline" — overwriting a healthy status with a stale one, with
  // nothing to set it back. The badge then read offline while updates were
  // arriving normally, which is worse than useless: it is a lie about freshness.
  await page.routeWebSocket(/\/api\/stream/, (ws) => {
    ws.send(JSON.stringify({ type: 'graph', revision: 1, graph }))
  })
  await page.reload()

  await expect(page.getByText('live')).toBeVisible()

  await page.getByRole('radio', { name: 'Workload' }).click()
  await page.waitForTimeout(1200)
  await expect(page.getByText('live')).toBeVisible()
  await expect(page.getByText('offline')).toBeHidden()
})

test('survives an edge whose rule list is null', async ({ page }) => {
  // An allowed-by-default edge has no rules behind it, and the server was
  // sending `via: null` rather than `[]`. Reading .length on it threw during
  // render, React unmounted the entire tree, and the dashboard went black — a
  // failure that looks like the cluster is unreachable when the data arrived
  // fine. The server no longer sends null; this proves the UI copes anyway.
  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('legacy')
  await page.getByRole('option', { name: /legacy/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Details' })).toBeVisible()

  // The shell must still be there — a blank page is what the bug looked like.
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.locator('main canvas').first()).toBeVisible()
})

test('reports the websocket being down rather than looking live', async ({ page }) => {
  // No websocket is served by the preview server, so the UI must degrade to
  // "offline" instead of implying the graph is still updating.
  await expect(page.getByText('offline')).toBeVisible({ timeout: 10_000 })
})

test('simulate reports both halves, not just the answer', async ({ page }) => {
  await page.getByRole('button', { name: /Simulate/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // The legend once opened 684px above the viewport and still passed
  // toBeVisible, so assert the dialog is actually inside the window.
  const box = await dialog.boundingBox()
  const size = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size!.height + 1)

  await dialog.locator('#sim-from').fill('edge/web')
  await dialog.locator('#sim-to').fill('prod/api')
  await dialog.locator('#sim-port').fill('8080')
  await dialog.getByRole('button', { name: 'Check' }).click()

  await expect(dialog.getByText('Denied', { exact: true })).toBeVisible()

  // Both directions are reported even though egress alone settles it: the fix
  // for each lives in a different policy, in a different namespace. The headings
  // are uppercased by CSS, so match the text that is actually in the DOM.
  const egress = dialog.locator('section', { hasText: /may the source leave/i })
  const ingress = dialog.locator('section', { hasText: /will the destination accept/i })
  await expect(egress).toBeVisible()
  await expect(ingress).toBeVisible()
  await expect(egress.getByText('denied', { exact: true })).toBeVisible()
  await expect(ingress.getByText('allowed', { exact: true })).toBeVisible()

  // A layer that cannot resolve a domain has not denied it, and the panel must
  // not report it as though it had.
  await expect(dialog.getByText('aws-anp · undecidable')).toBeVisible()
})

test('a free-text destination says how it was read', async ({ page }) => {
  await page.getByRole('button', { name: /Simulate/ }).click()
  const dialog = page.getByRole('dialog')

  await dialog.locator('#sim-to').fill('sts.amazonaws.com')
  await expect(dialog.getByText('read as a domain')).toBeVisible()

  // The hint used to float over the end of the field, hiding exactly the part
  // of a long domain worth reading. It belongs beside the label.
  const field = await dialog.locator('#sim-to').boundingBox()
  const hint = await dialog.getByText('read as a domain').boundingBox()
  expect(hint!.y + hint!.height).toBeLessThanOrEqual(field!.y + 1)

  await dialog.locator('#sim-to').fill('10.0.0.1/32')
  await expect(dialog.getByText('read as an address')).toBeVisible()
})

test('the suggestion list is reachable, navigable and sensibly ordered', async ({ page }) => {
  await page.getByRole('button', { name: /Simulate/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('#sim-from').click()

  const list = dialog.getByRole('listbox').first()
  await expect(list).toBeVisible()

  // The list used to sit inside the dialog's own scroll container, which cut it
  // off and left the lower options unreachable. toBeVisible does not catch
  // clipping, so hit-test the bottom edge for real.
  const box = await list.boundingBox()
  expect(box).not.toBeNull()
  const reachable = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="listbox"]')),
    { x: box!.x + box!.width / 2, y: box!.y + box!.height - 4 },
  )
  expect(reachable).toBe(true)

  // Someone's own workloads come before Kubernetes' own.
  const first = await list.getByRole('option').first().textContent()
  expect(first).not.toContain('kube-system')

  // Typing narrows, and the keyboard alone can finish the job.
  await dialog.locator('#sim-from').fill('web')
  await dialog.locator('#sim-from').press('ArrowDown')
  await dialog.locator('#sim-from').press('Enter')
  await expect(dialog.locator('#sim-from')).toHaveValue('edge/web')
  await expect(list).toBeHidden()
})

test('escape dismisses the suggestion list before the dialog', async ({ page }) => {
  await page.getByRole('button', { name: /Simulate/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('#sim-to').click()
  await expect(dialog.getByRole('listbox').first()).toBeVisible()

  await dialog.locator('#sim-to').press('Escape')
  await expect(dialog.getByRole('listbox')).toBeHidden()
  await expect(dialog).toBeVisible()

  await dialog.locator('#sim-to').press('Escape')
  await expect(dialog).toBeHidden()
})
