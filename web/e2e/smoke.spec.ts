import { expect, test, type Page } from '@playwright/test'

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

test('a chosen theme survives a reload', async ({ page }) => {
  await page.getByLabel('Toggle theme').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  // Asserted before anything else can settle: the theme is applied by an inline
  // script in the document head precisely so it is right on the first frame,
  // and a light-theme user should never watch the page flash dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('the two signal colours that used to be identical are not', async ({ page }) => {
  // --node-world and --danger were the same red, so "reaches outside the
  // cluster" and "no policy protects this" were indistinguishable. The Go test
  // guards the stylesheet; this guards what a browser actually resolves, which
  // is what the canvas paints.
  const colours = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      world: style.getPropertyValue('--node-world').trim(),
      danger: style.getPropertyValue('--danger').trim(),
      cidr: style.getPropertyValue('--node-cidr').trim(),
    }
  })

  expect(colours.world).not.toBe('')
  expect(colours.world).not.toBe(colours.danger)
  expect(colours.world).not.toBe(colours.cidr)
})

test('the canvas palette resolves from the stylesheet, not a stale copy', async ({ page }) => {
  // graph/style.ts used to restate the token table in hex for Sigma's benefit,
  // which is how the two files came to disagree. It reads the variables now, and
  // an unresolved token paints magenta rather than disappearing into black.
  const painted = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return ['--fg', '--danger', '--node-world', '--card-plate', '--picto'].map((t) =>
      style.getPropertyValue(t).trim(),
    )
  })

  for (const colour of painted) {
    expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
    expect(colour.toLowerCase()).not.toBe('#ff00ff')
  }
})

test('renders in Inter and JetBrains Mono, not a silent system fallback', async ({ page }) => {
  // 'Inter var' sat in the font stack for months without ever being loaded, so
  // the UI rendered in system-ui and nobody could tell from the CSS.
  await page.waitForFunction(() => document.fonts.status === 'loaded')

  const loaded = await page.evaluate(() => ({
    inter: document.fonts.check('16px Inter'),
    mono: document.fonts.check('16px "JetBrains Mono"'),
  }))

  expect(loaded.inter).toBe(true)
  expect(loaded.mono).toBe(true)
})

test.describe('with an operating system asking for light', () => {
  test.use({ colorScheme: 'light' })

  test('follows it when nobody has chosen a theme', async ({ page }) => {
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })

  test('but a stored choice wins', async ({ page }) => {
    // Someone who deliberately picked dark on a light machine meant it.
    await page.addInitScript(() => window.localStorage.setItem('marsad.theme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('the light theme is readable, not dark tokens on a white ground', async ({ page }) => {
    await page.reload()
    const { bg, fg } = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        bg: style.getPropertyValue('--bg').trim(),
        fg: style.getPropertyValue('--fg').trim(),
      }
    })
    // The classic failure is a theme whose colours are defined only inside a
    // [data-theme] block, so the un-stamped state renders one theme's text on
    // the other's ground.
    expect(bg.toLowerCase()).toBe('#f6f8fa')
    expect(fg.toLowerCase()).toBe('#111620')
  })
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


/**
 * The bounding box of everything the overlay actually painted.
 *
 * Camera and layout bugs are invisible to assertions about nodes: a graph
 * collapsed into a column of dots, and a camera that had wandered off, both
 * satisfied every `toBeVisible` in this file. What is painted, and where, is
 * the thing that was wrong, so it is the thing to measure.
 */
async function paintedBox(page: Page) {
  return await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.pointer-events-none')
    if (!c) return null
    const copy = document.createElement('canvas')
    copy.width = c.width
    copy.height = c.height
    const ctx = copy.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(c, 0, 0)
    const d = ctx.getImageData(0, 0, copy.width, copy.height).data
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    let lit = 0
    for (let y = 0; y < copy.height; y += 2) {
      for (let x = 0; x < copy.width; x += 2) {
        if (d[(y * copy.width + x) * 4 + 3] > 8) {
          lit++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 <= x0) return null
    return { width: x1 - x0, height: y1 - y0, lit }
  })
}

/** Wait until the overlay stops changing, so a measurement is of the finished
 * picture rather than of a frame partway through layout. */
async function settled(page: Page) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    const box = await paintedBox(page)
    const lit = box?.lit ?? 0
    if (lit > 0 && Math.abs(lit - last) < Math.max(150, lit * 0.02)) return box!
    last = lit
    await page.waitForTimeout(250)
  }
  throw new Error('the graph never settled')
}

const orphanGraph = (n: number, tag = 'a') => ({
  level: 'workload',
  nodes: Array.from({ length: n }, (_, i) => ({
    id: `wl:corp/Deployment/svc-${tag}${i}`,
    kind: 'workload',
    label: `svc-${tag}${i}`,
    namespace: 'corp',
    workloadKind: 'Deployment',
    replicas: 3,
    isolation: { ingress: false, egress: false },
    access: [],
  })),
  edges: [],
})

test('a namespace no policy selects lays out as a grid, not a column', async ({ page }) => {
  // Dagre ranks by edges, so nodes no edge touches all land in rank 0 and come
  // back as one column with an x-span of zero. That is the commonest shape
  // there is — a namespace with no policies has no edges at all, because
  // openness is drawn on the card rather than as edges to a hub — and the
  // camera could only frame the resulting column by zooming out until every
  // card was a bare dot. The column measured 148x886; the grid, 1230x702.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: orphanGraph(40) } }),
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')

  const box = await settled(page)
  expect(box.width).toBeGreaterThan(box.height)
})

test('a pan survives a cluster change, but not a change of view', async ({ page }) => {
  // The stream sends a fresh graph on any cluster change, and the camera used
  // to refit on every one of them. On a busy cluster that discarded a pan or a
  // zoom seconds after it was made, so the view appeared to move on its own.
  let socket: { send: (data: string) => void } | null = null
  await page.routeWebSocket(/\/api\/stream/, (ws) => {
    socket = ws
    ws.send(JSON.stringify({ type: 'graph', revision: 1, graph: orphanGraph(6) }))
  })
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 1, graph: orphanGraph(6) } }),
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')

  // Measured as how much of the overlay is painted, not where its bounding box
  // sits: a fitted graph fills the viewport, so its box is clipped by the canvas
  // edges and hardly moves however far the view is dragged. Panning content off
  // the edge is unambiguous — the picture loses paint, and a refit restores it.
  const framed = (await settled(page)).lit
  await page.mouse.move(900, 620)
  await page.mouse.down()
  await page.mouse.move(240, 180, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(600)

  const panned = (await settled(page)).lit
  expect(panned).toBeLessThan(framed * 0.5)

  // A workload is replaced: the node set changes, so the old behaviour refit,
  // but nothing about it was a request to look somewhere else. The replacement
  // is the same size and count as what it replaces, so any change in how much
  // is painted is the camera moving and nothing else.
  expect(socket).not.toBeNull()
  socket!.send(JSON.stringify({ type: 'graph', revision: 2, graph: orphanGraph(6, 'b') }))
  await page.waitForTimeout(1500)
  expect((await settled(page)).lit).toBeLessThan(framed * 0.5)

  // Asking to see something else is a different matter, and does reframe.
  await page.getByRole('radio', { name: 'Workload' }).click()
  await page.waitForTimeout(1500)

  expect((await settled(page)).lit).toBeGreaterThan(framed * 0.7)
})

test('selecting an open workload draws its exposure, unselected does not', async ({ page }) => {
  // Openness is stated as rows on the card because drawing it for every
  // unprotected workload is a hairball. For the one card someone selected it is
  // two lines, and the shape is the thing a graph is for.
  //
  // One node, open both ways: unselected the overlay paints a card, selected it
  // paints a card plus a pill either side, so the painted width has to grow.
  const exposed = {
    level: 'workload',
    nodes: [
      {
        id: 'wl:corp/Deployment/runner',
        kind: 'workload',
        label: 'runner',
        namespace: 'corp',
        workloadKind: 'Deployment',
        replicas: 1,
        isolation: { ingress: false, egress: false },
        access: [],
      },
      { id: 'any', kind: 'any', label: 'any' },
    ],
    edges: [
      { id: 'e1', source: 'any', target: 'wl:corp/Deployment/runner', kind: 'default' },
      { id: 'e2', source: 'wl:corp/Deployment/runner', target: 'any', kind: 'default' },
    ],
  }
  await page.route('**/api/graph*', (r) => r.fulfill({ json: { revision: 3, graph: exposed } }))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')

  const before = await settled(page)

  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('runner')
  await page.getByRole('option', { name: /runner/ }).first().click()

  const after = await settled(page)
  expect(after.width).toBeGreaterThan(before.width * 1.5)
})

/** How many painted pixels are within `tolerance` of a colour, sampled on a
 * grid. Used to ask whether the overlay drew something in danger colour at all,
 * which is not a question the painted bounding box can answer. */
async function countNear(page: Page, rgb: [number, number, number], tolerance = 40) {
  return await page.evaluate(
    ({ rgb, tolerance }) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.pointer-events-none')
      if (!c) return 0
      const copy = document.createElement('canvas')
      copy.width = c.width
      copy.height = c.height
      const ctx = copy.getContext('2d')
      if (!ctx) return 0
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(0, 0, copy.width, copy.height).data
      let hits = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3]! < 120) continue
        if (
          Math.abs(d[i]! - rgb[0]) < tolerance &&
          Math.abs(d[i + 1]! - rgb[1]) < tolerance &&
          Math.abs(d[i + 2]! - rgb[2]) < tolerance
        ) {
          hits++
        }
      }
      return hits
    },
    { rgb, tolerance },
  )
}

const soloWorkload = (isolated: boolean) => ({
  level: 'workload',
  nodes: [
    {
      id: 'wl:corp/Deployment/worker',
      kind: 'workload',
      label: 'worker',
      namespace: 'corp',
      workloadKind: 'Deployment',
      replicas: 1,
      isolation: { ingress: isolated, egress: isolated },
      access: [],
    },
    { id: 'any', kind: 'any', label: 'any' },
  ],
  edges: isolated
    ? []
    : [
        { id: 'e1', source: 'any', target: 'wl:corp/Deployment/worker', kind: 'default' },
        { id: 'e2', source: 'wl:corp/Deployment/worker', target: 'any', kind: 'default' },
      ],
})

test('an unprotected card says so at rest, without being selected', async ({ page }) => {
  // The whole point of the signal is that you see it while scanning, before you
  // have clicked anything. A card that only turns red on selection cannot be
  // the thing that makes you look.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: soloWorkload(false) } }),
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await settled(page)

  // #f75c61 — the dark theme's --danger.
  const danger = await countNear(page, [0xf7, 0x5c, 0x61])
  expect(danger).toBeGreaterThan(200)
})

test('a protected card is not painted in danger colour', async ({ page }) => {
  // The counterpart, so the test above is measuring the posture rather than
  // just the fact that the overlay paints something.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: soloWorkload(true) } }),
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await settled(page)

  const danger = await countNear(page, [0xf7, 0x5c, 0x61])
  expect(danger).toBeLessThan(50)
})

test('an unprotected card is taller, because it carries its exposure', async ({ page }) => {
  // The UNPROTECTED block is a heading plus two rows. A card without one is
  // header-only, so the difference is structural and not a matter of styling.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: soloWorkload(true) } }),
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  const protectedBox = await settled(page)

  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: soloWorkload(false) } }),
  )
  await page.reload()
  const openBox = await settled(page)

  expect(openBox.height).toBeGreaterThan(protectedBox.height)
})

test('the inspector explains an unprotected workload rather than leaving a blank', async ({
  page,
}) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('legacy')
  await page.getByRole('option', { name: /legacy/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector).toBeVisible()

  // The banner states the consequence, not just the fact.
  await expect(
    inspector.getByText(
      'No policy selects this workload, so Kubernetes allows everything to and from it',
    ),
  ).toBeVisible()

  // Both directions, named the way the evaluator names them.
  await expect(inspector.getByText('ingress not isolated')).toBeVisible()
  await expect(inspector.getByText('egress not isolated')).toBeVisible()

  // The exposure is rendered as rules, with the thing that decided them.
  // Exact, because the banner's prose above also ends "and out to anywhere".
  await expect(inspector.getByText('from anywhere', { exact: true })).toBeVisible()
  await expect(inspector.getByText('to anywhere', { exact: true })).toBeVisible()
  await expect(inspector.getByText('no rule — Kubernetes default')).toHaveCount(2)

  // Zero applied policies is a real empty state, not a sentence in a gap.
  await expect(inspector.getByText('Applied policies (0)')).toBeVisible()
  await expect(inspector.getByText('Nothing selects this workload')).toBeVisible()
})

test('a protected workload keeps its rules and its policy list', async ({ page }) => {
  // Guards the branch: the unprotected treatment must not leak onto a workload
  // that policies do cover.
  await page.locator('body').press('/')
  await page.getByPlaceholder('Search workloads, namespaces and peers…').fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector.getByText('ingress isolated')).toBeVisible()
  await expect(
    inspector.getByText('No policy selects this workload, so Kubernetes allows everything'),
  ).toBeHidden()
  await expect(inspector.getByText('Nothing selects this workload')).toBeHidden()
})

test('the header names the build that is answering', async ({ page }) => {
  // Which binary is running was unanswerable from Marsad itself, so "is this
  // the fixed build?" took two rounds of guessing. It comes from /api/meta
  // rather than the bundle: after an upgrade the page may still be the cached
  // one, and a number baked into it would report the build it was built from.
  await expect(page.getByRole('banner').getByText('v1.2.3-test')).toBeVisible()
})
