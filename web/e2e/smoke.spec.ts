import { expect, test, type Page } from '@playwright/test'

import {
  approximateVerdict,
  graph,
  meta,
  mockApi,
  undecidableVerdict,
  worldRuleDetails,
} from './fixtures'

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

  await page.getByPlaceholder(/Search workloads/).fill('api')
  await expect(page.getByRole('option', { name: /api/ }).first()).toBeVisible()
})

test('command palette opens with the meta shortcut too', async ({ page }) => {
  await page.locator('body').press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Search the cluster' })).toBeVisible()
})

test('selecting from the palette opens the inspector with the policy YAML', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector).toBeVisible()
  await expect(inspector.getByText(/Ingress — isolated/)).toBeVisible()

  // Traceability: the policy is listed and its original YAML is available
  // read-only. Scoped to the list entry, because the name deliberately appears
  // twice — once as the chip naming the rule's deciding policy, once here.
  await inspector.locator('summary').filter({ hasText: 'api-ingress' }).click()
  await expect(inspector.locator('pre')).toContainText('podSelector')
})

test('escape closes the inspector', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
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

test('the rail states what is hidden, and what is not', async ({ page }) => {
  // Hiding without saying so leaves someone wondering where their workloads
  // went — but so does saying nothing when nothing is hidden. The footer is
  // always present and states both cases.
  await expect(page.getByText(/Nothing hidden/)).toBeVisible()
  await expect(page.getByText(/\d+ of \d+ workloads/)).toBeVisible()

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByText('Only unprotected').click()

  await expect(page.getByText(/Filters are hiding part of this/)).toBeVisible()
  await page.getByRole('button', { name: 'reset' }).click()
  await expect(page.getByText(/Nothing hidden/)).toBeVisible()
})

test('the filters badge lights only when something is actually hidden', async ({ page }) => {
  // A badge that is always on is decoration. The one thing it has to be able to
  // say is "part of the picture is missing", which it cannot say if it looks
  // identical when nothing is.
  const badge = page.getByText('hiding', { exact: true })
  await expect(badge).toBeHidden()

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByText('Only unprotected').click()
  await expect(badge).toBeVisible()
})

test('each connection toggle says what turning it off would cost', async ({ page }) => {
  // A checkbox alone does not distinguish hiding four edges from hiding sixty.
  await page.getByRole('button', { name: 'Filters' }).click()

  const allowed = page.getByText('Allowed by a rule').locator('..')
  await expect(allowed.getByText(/^\d+$/)).toBeVisible()
})

test('the legend is always on screen and says motion means permitted', async ({ page }) => {
  // Marsad reads declared policy. Animated edges must not be mistaken for
  // observed traffic, so the legend says which it is.
  //
  // It used to be a popover behind a button, which put the key to a picture
  // made entirely of colour one click away from the picture — and the click had
  // to be repeated on every visit. The viewport assertion is kept from that
  // era: the popover once opened 684px above the top of the window, and the old
  // test still passed, because toBeVisible only requires a non-empty box rather
  // than one you can see.
  const bar = page.getByRole('list', { name: 'Legend' })
  await expect(bar).toBeVisible()

  for (const label of [
    'allowed by a rule',
    'depends on DNS',
    'allowed by default',
    'unprotected',
    'outside the cluster',
  ]) {
    await expect(bar.getByText(label, { exact: true })).toBeVisible()
  }

  const box = await bar.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)

  await bar.getByText('allowed by a rule', { exact: true }).hover()
  await expect(page.getByText(/never observes traffic/)).toBeVisible()
})

test('the canvas bar carries the zoom controls', async ({ page }) => {
  // They did not exist at all before: zooming was a wheel gesture or nothing,
  // which is unusable on a trackpad-less machine and undiscoverable everywhere.
  for (const name of ['Zoom in', 'Zoom out', 'Fit to view']) {
    await expect(page.getByRole('button', { name })).toBeVisible()
  }

  const before = await settled(page)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForTimeout(600)
  const after = await settled(page)
  expect(after.lit).toBeGreaterThan(before.lit)
})

test('namespaces are ordered worst first, with the empty ones set aside', async ({ page }) => {
  // Alphabetical order guarantees the thing you are looking for is wherever the
  // alphabet happens to put it. The rail is read top-down, so the namespaces
  // with a finding belong at the top — and a namespace with no workloads has no
  // posture to rank at all, so it is separated rather than sorted last.
  await page.route('**/api/namespaces', (r) =>
    r.fulfill({
      json: [
        { name: 'aaa-clean', workloads: 5, policies: 3, unprotected: 0 },
        { name: 'zzz-worst', workloads: 4, policies: 1, unprotected: 3 },
        { name: 'mmm-some', workloads: 6, policies: 2, unprotected: 1 },
        { name: 'bbb-empty', workloads: 0, policies: 0, unprotected: 0 },
      ],
    }),
  )
  await page.reload()

  const rail = page.getByRole('complementary')
  // Waited for explicitly: reading the list before the refetch lands measures
  // the order of the previous fixture, and passes or fails on timing.
  await expect(rail.getByRole('button', { name: /zzz-worst/ })).toBeVisible()

  const order = await rail.getByRole('button', { name: /-(clean|worst|some)/ }).allInnerTexts()
  const rank = (needle: string) => order.findIndex((t) => t.includes(needle))

  expect(rank('zzz-worst')).toBe(0)
  expect(rank('mmm-some')).toBe(1)
  expect(rank('aaa-clean')).toBe(2)

  // Not in the ranked list, and behind a disclosure that counts them.
  await expect(rail.getByText('with no workloads')).toBeVisible()
  await expect(rail.getByRole('button', { name: /bbb-empty/ })).toBeHidden()
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

  await expect(page.getByText(/^live/)).toBeVisible()

  await page.getByRole('radio', { name: 'Workload' }).click()
  await page.waitForTimeout(1200)
  await expect(page.getByText(/^live/)).toBeVisible()
  await expect(page.getByText(/snapshot|reconnecting/)).toBeHidden()
})

test('survives an edge whose rule list is null', async ({ page }) => {
  // An allowed-by-default edge has no rules behind it, and the server was
  // sending `via: null` rather than `[]`. Reading .length on it threw during
  // render, React unmounted the entire tree, and the dashboard went black — a
  // failure that looks like the cluster is unreachable when the data arrived
  // fine. The server no longer sends null; this proves the UI copes anyway.
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('legacy')
  await page.getByRole('option', { name: /legacy/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Details' })).toBeVisible()

  // The shell must still be there — a blank page is what the bug looked like.
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.locator('main canvas').first()).toBeVisible()
})

test('reports the websocket being down rather than looking live', async ({ page }) => {
  // No websocket is served by the preview server, so the UI must say the graph
  // has stopped updating instead of implying it still is. "offline" used to
  // cover both a socket that is retrying and one that has given up — different
  // situations, calling for different responses from whoever is reading it.
  await expect(page.getByText(/reconnecting/)).toBeVisible({ timeout: 10_000 })
})

test('a stopped stream says what you are looking at instead', async ({ page }) => {
  // A graph rendered from a four-minute-old snapshot looks exactly like one
  // rendered a second ago. That is the whole reason this state exists.
  await expect(page.getByText(/Live updates stopped/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep viewing snapshot' })).toBeVisible()
})

test('keeping the snapshot stops the retrying, and says so', async ({ page }) => {
  await page.getByRole('button', { name: 'Keep viewing snapshot' }).click()

  const header = page.getByRole('banner')
  await expect(header.getByText(/snapshot/)).toBeVisible()
  await expect(header.getByText(/reconnecting/)).toBeHidden()
  // Still offered a way back: choosing to stop watching is not the same as
  // choosing never to look again.
  await expect(header.getByRole('button', { name: 'Reconnect' })).toBeVisible()
})

test('simulate reports both halves, not just the answer', async ({ page }) => {
  await page.locator('body').press('s')
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

  // 'Denied' appears twice on purpose now — as the verdict and as the lit entry
  // on the four-state scale — so assert the one that carries the meaning.
  await expect(
    dialog.getByRole('list', { name: 'Verdict scale' }).locator('[aria-current="true"]'),
  ).toHaveText('Denied')

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
  await page.locator('body').press('s')
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
  await page.locator('body').press('s')
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
  await page.locator('body').press('s')
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
  // Given room: this drags the mouse and then waits for the overlay to stop
  // repainting, and under parallel load the settle can outlast the default
  // timeout. It measures real timing rather than asserting on a threshold that
  // could simply be loosened, so it gets more time instead of weaker checks.
  test.slow()

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
  await page.getByPlaceholder(/Search workloads/).fill('runner')
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
  await page.getByPlaceholder(/Search workloads/).fill('legacy')
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
  await expect(inspector.getByText(/Ingress — not isolated/)).toBeVisible()
  await expect(inspector.getByText(/Egress — not isolated/)).toBeVisible()

  // The exposure is rendered as rules, with the thing that decided them.
  // Exact, because the banner's prose above also ends "and out to anywhere".
  await expect(inspector.getByText('from anywhere', { exact: true })).toBeVisible()
  await expect(inspector.getByText('to anywhere', { exact: true })).toBeVisible()
  await expect(inspector.getByText('no rule — Kubernetes default')).toHaveCount(2)

  // Zero applied policies is a real empty state, not a sentence in a gap.
  await expect(inspector.getByText('Applied policies (0)')).toBeVisible()
  await expect(inspector.getByText('Nothing selects this workload')).toBeVisible()
})

test('the empty state names the policies that nearly matched, and why', async ({ page }) => {
  // The single most useful thing on this screen. "No policy selects this" is a
  // fact; which policy was *supposed* to is the question, and answering it by
  // hand means opening every policy in the namespace and comparing selectors.
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('legacy')
  await page.getByRole('option', { name: /legacy/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector.getByText('default-deny')).toBeVisible()

  // The whole selector is printed only when it says more than the failed clause
  // does. default-deny is a single clause, so it is not repeated; allow-api-to-db
  // has two, one of which the workload satisfies, so the full selector earns
  // its line.
  await expect(inspector.getByText('app in (api,db)')).toBeHidden()
  await expect(inspector.getByText('app=api,tier=core')).toBeVisible()

  // Both halves: the clause that failed, and what the workload has instead.
  await expect(inspector.getByText('app in (api, db)')).toBeVisible()
  await expect(inspector.getByText(/this workload has\s*app=legacy/).first()).toBeVisible()

  // A clause failing because the label is absent reads differently from one
  // failing on its value — one is a typo in the policy, the other in the pod.
  await expect(inspector.getByText(/this workload has no\s*tier\s*label/)).toBeVisible()

  // Nearest first.
  const order = await inspector.getByText(/^(default-deny|allow-api-to-db)$/).allInnerTexts()
  expect(order[0]).toBe('default-deny')
})

test('a rule names the policy that decided it, and opens its YAML', async ({ page }) => {
  // The rule identifier is precise and unreadable, and the precision only
  // matters once you have already found the policy.
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector.getByText('decided by').first()).toBeVisible()

  const chip = inspector.getByRole('button', { name: 'Show the YAML of api-ingress' })
  await expect(chip).toBeVisible()
  await chip.click()

  await expect(inspector.locator('pre')).toContainText('podSelector')
})

test('directions are named for what they do, with their isolation', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector.getByText('Accepts')).toBeVisible()
  await expect(inspector.getByText('Reaches')).toBeVisible()
  await expect(inspector.getByText(/Ingress — isolated/)).toBeVisible()
  await expect(inspector.getByText(/1 policy selects it/).first()).toBeVisible()
})

test('an approximate rule carries its reason where the rule is', async ({ page }) => {
  // Not a footnote: the uncertainty belongs to this rule, and a reader deciding
  // whether to trust it should not have to go looking.
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(
    inspector.getByText(/Marsad does not resolve DNS, so it cannot confirm/),
  ).toBeVisible()
})

test('the inspector offers to simulate from what it is describing', async ({ page }) => {
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  await page.getByRole('button', { name: 'Simulate from api' }).click()
  await expect(page.getByRole('dialog', { name: /Would this connection be allowed/ })).toBeVisible()
})

test('a protected workload keeps its rules and its policy list', async ({ page }) => {
  // Guards the branch: the unprotected treatment must not leak onto a workload
  // that policies do cover.
  await page.locator('body').press('/')
  await page.getByPlaceholder(/Search workloads/).fill('api')
  await page.getByRole('option', { name: /api/ }).first().click()

  const inspector = page.getByRole('dialog', { name: 'Details' })
  await expect(inspector.getByText(/Ingress — isolated/)).toBeVisible()
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

/* ------------------------------------------------- simulate and edge rules */

async function runSimulation(page: Page) {
  await page.locator('body').press('s')
  const dialog = page.getByRole('dialog', { name: /Would this connection be allowed/ })
  await expect(dialog).toBeVisible()
  await dialog.locator('#sim-from').fill('edge/web')
  await dialog.locator('#sim-to').fill('prod/api')
  await dialog.locator('#sim-port').fill('8080')
  await dialog.getByRole('button', { name: 'Check' }).click()
  return dialog
}

test('the two halves sit side by side, not stacked', async ({ page }) => {
  // "Both must permit" is the point of the panel, and stacked the second half
  // reads as a footnote to the first — which is the exact mistake this exists
  // to prevent.
  const dialog = await runSimulation(page)

  const egress = dialog.getByText('Egress · may the source leave')
  const ingress = dialog.getByText('Ingress · will the destination accept')
  await expect(egress).toBeVisible()
  await expect(ingress).toBeVisible()

  const a = await egress.boundingBox()
  const b = await ingress.boundingBox()
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  // Same row: their vertical centres line up, and one is to the right.
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(24)
  expect(b!.x).toBeGreaterThan(a!.x)
})

test('the verdict states the implication and shows the scale', async ({ page }) => {
  // "Denied" is a label. Which half refused is what decides whose policy you go
  // and edit, and the two look identical in a graph.
  const dialog = await runSimulation(page)

  await expect(dialog.getByText('The source may not leave.')).toBeVisible()
  await expect(dialog.getByText('The destination will accept.')).toBeVisible()

  const scale = dialog.getByRole('list', { name: 'Verdict scale' })
  await expect(scale).toBeVisible()
  for (const state of ['Allowed', 'Denied', 'Approximate', 'Undecidable']) {
    await expect(scale.getByText(state, { exact: true })).toBeVisible()
  }
  await expect(scale.locator('[aria-current="true"]')).toHaveText('Denied')
})

test('the refusing half says what it does accept', async ({ page }) => {
  // A denial says the connection fails. It does not say what the policy was
  // written for, and without that the next step is a guess.
  //
  // Picked from the suggestion list rather than typed: what a workload accepts
  // can only be read from a workload, and free text is a domain until the
  // cluster says otherwise. That is the behaviour, not a detail of the test.
  await page.locator('body').press('s')
  const dialog = page.getByRole('dialog', { name: /Would this connection be allowed/ })
  await expect(dialog).toBeVisible()

  await dialog.locator('#sim-from').fill('web')
  await dialog.locator('#sim-from').press('ArrowDown')
  await dialog.locator('#sim-from').press('Enter')
  await dialog.locator('#sim-to').fill('api')
  await dialog.locator('#sim-to').press('ArrowDown')
  await dialog.locator('#sim-to').press('Enter')
  await dialog.locator('#sim-port').fill('8080')
  await dialog.getByRole('button', { name: 'Check' }).click()

  // Egress is the half that refused, so the counterfactual is what the *source*
  // is permitted to reach — not what the destination accepts.
  await expect(dialog.getByText('What it does accept')).toBeVisible()
  await expect(dialog.getByText(/443\/TCP to \*\.s3\.us-east-1\.amazonaws\.com/)).toBeVisible()
})

test('an undecidable verdict has a path to the screen', async ({ page }) => {
  // It is in the model, it is produced by a domain-versus-address query, and
  // until now nothing in the UI could reach it.
  await page.route('**/api/simulate', (r) => r.fulfill({ json: undecidableVerdict }))
  const dialog = await runSimulation(page)

  await expect(dialog.getByText('Cannot be decided')).toBeVisible()
  await expect(
    dialog.getByText(/depends on what a domain name resolves to at runtime/),
  ).toBeVisible()
  await expect(
    dialog.getByRole('list', { name: 'Verdict scale' }).locator('[aria-current="true"]'),
  ).toHaveText('Undecidable')
})

test('an approximate verdict is allowed, and says what is approximate', async ({ page }) => {
  // Allowed and Approximate are both true: the question was answered, and it is
  // the rule's reach that configuration cannot pin down.
  await page.route('**/api/simulate', (r) => r.fulfill({ json: approximateVerdict }))
  const dialog = await runSimulation(page)

  await expect(
    dialog.getByRole('list', { name: 'Verdict scale' }).locator('[aria-current="true"]'),
  ).toHaveText('Approximate')
  await expect(dialog.getByText(/one leans on a rule whose reach depends on DNS/)).toBeVisible()
})

/** Where an edge of this colour is painted, as canvas-relative fractions. */
async function edgePixels(page: Page, rgb: [number, number, number]) {
  return await page.evaluate(
    ({ rgb }) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.pointer-events-none')
      if (!c) return []
      const copy = document.createElement('canvas')
      copy.width = c.width
      copy.height = c.height
      const ctx = copy.getContext('2d')
      if (!ctx) return []
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(0, 0, copy.width, copy.height).data

      const hits: { x: number; y: number }[] = []
      for (let y = 0; y < copy.height; y += 2) {
        for (let x = 0; x < copy.width; x += 2) {
          const i = (y * copy.width + x) * 4
          if (d[i + 3]! < 150) continue
          if (
            Math.abs(d[i]! - rgb[0]) < 30 &&
            Math.abs(d[i + 1]! - rgb[1]) < 30 &&
            Math.abs(d[i + 2]! - rgb[2]) < 30
          ) {
            hits.push({ x: x / copy.width, y: y / copy.height })
          }
        }
      }

      // Spread across the painted span rather than clustered anywhere in
      // particular. The access-point markers on a card are drawn in the same
      // colour as the edge that produced them, so not every matching pixel is
      // edge — and where the edge falls depends on a layout no test should
      // assume.
      hits.sort((a, b) => a.x - b.x || a.y - b.y)
      const wanted = 24
      const step = Math.max(1, Math.floor(hits.length / wanted))
      const spread: { x: number; y: number }[] = []
      for (let i = 0; i < hits.length && spread.length < wanted; i += step) {
        spread.push(hits[i]!)
      }
      return spread
    },
    { rgb },
  )
}

/**
 * Clicks the edge, found by the colour it is painted in.
 *
 * The graph is a canvas, so there is no element to target and no coordinate a
 * test should hardcode — dagre decides the layout, and an edge terminates on a
 * port row rather than a card's centre.
 *
 * Re-probed before every attempt, because the camera animates into its fit over
 * a few hundred milliseconds after the overlay stops changing: coordinates read
 * once and clicked later land where the edge *was*. That is what made the first
 * version of this pass and fail on alternate runs with nothing changed between
 * them.
 */
async function clickAnEdge(page: Page, rgb: [number, number, number] = [0x38, 0xd0, 0x80]) {
  /*
   * Namespace containers are drawn in the namespace's own palette hue, and the
   * palette assigns by position in the sorted list — which makes `prod` green,
   * the same green as an allowed edge. The container is far larger than the
   * line, so most matching pixels were its border, and whether any of the
   * sampled candidates landed on the actual edge came down to luck. Turning the
   * containers off leaves the edge as very nearly the only green thing on the
   * canvas.
   */
  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByText('Group by namespace').click()
  await page.getByRole('button', { name: 'Filters' }).click()
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()

  const box = await page.locator('main canvas').first().boundingBox()
  expect(box).not.toBeNull()

  const popover = page.getByRole('dialog', { name: 'Connection' })
  const inspector = page.getByRole('dialog', { name: 'Details' })

  const tried = new Set<string>()
  for (let attempt = 0; attempt < 24; attempt++) {
    const points = await edgePixels(page, rgb)
    expect(points.length, 'the edge was never painted').toBeGreaterThan(0)

    const point = points.find((p) => !tried.has(`${p.x},${p.y}`)) ?? points[0]!
    tried.add(`${point.x},${point.y}`)

    await page.mouse.click(box!.x + box!.width * point.x, box!.y + box!.height * point.y)
    if (await popover.isVisible()) return

    /*
     * A miss that lands on a card opens the inspector, and the inspector is a
     * 34rem panel over the right-hand side of the stage. Every later click then
     * lands on *it* rather than on the canvas, so the loop keeps going and
     * never reaches the edge again — which is why this failed having "tried"
     * two dozen candidates, and why it failed identically on retry rather than
     * flaking. Clearing the selection puts the canvas back.
     */
    if (await inspector.isVisible()) {
      await page.locator('body').press('Escape')
      await expect(inspector).toBeHidden()
    }
  }
  throw new Error('clicked every candidate on the edge and no popover opened')
}

const twoNodeGraph = (via: string[]) => ({
  level: 'workload',
  nodes: [
    {
      id: 'wl:prod/Deployment/web',
      kind: 'workload',
      label: 'web',
      namespace: 'prod',
      workloadKind: 'Deployment',
      replicas: 1,
      isolation: { ingress: true, egress: true },
    },
    {
      id: 'wl:prod/Deployment/db',
      kind: 'workload',
      label: 'db',
      namespace: 'prod',
      workloadKind: 'Deployment',
      replicas: 1,
      isolation: { ingress: true, egress: true },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'wl:prod/Deployment/web',
      target: 'wl:prod/Deployment/db',
      kind: 'allowed',
      ports: ['5432/TCP'],
      via,
    },
  ],
})

test('clicking an edge shows the rule behind it, where the edge is', async ({ page }) => {
  // Canvas plus an animating camera: the same timing-sensitive class as the
  // pan test, and it competes with fifty others for CPU under fullyParallel.
  test.slow()
  // The canvas bar has promised this since the beginning, and clicking an edge
  // opened the same side panel workloads use — several hundred pixels from the
  // question, after the graph had shifted to make room.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({
      json: {
        revision: 3,
        graph: twoNodeGraph(['networking.k8s.io/NetworkPolicy/prod/api-ingress#ingress[0]']),
      },
    }),
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await settled(page)
  await clickAnEdge(page)

  const popover = page.getByRole('dialog', { name: 'Connection' })
  await expect(popover.getByText('allowed by a rule')).toBeVisible()
  await expect(popover.getByText('5432/TCP')).toBeVisible()
  await expect(popover.getByText('api-ingress')).toBeVisible()

  // The excerpt, not the document: no apiVersion, no metadata.
  const yaml = await popover.locator('pre').innerText()
  expect(yaml).toContain('podSelector')
  expect(yaml).not.toContain('apiVersion')

  await expect(popover.getByRole('button', { name: /Copy YAML/ })).toBeVisible()
})

/*
 * Not tested here: selecting an edge dims the others.
 *
 * It is implemented — drawEdges takes its dim state from the selection as well
 * as from hover — but there is no honest assertion available from outside the
 * canvas. The access-point row a card draws for an incoming edge uses that
 * edge's own colour, and cards are not dimmed by selection, so counting pixels
 * of a colour measures the card as much as the line. Every threshold that made
 * the test pass was one that would also have passed with the dimming removed.
 *
 * A real assertion needs a way to address an edge that is not a pixel probe.
 * The keyboard path that gives edges a selectable identity is the one that will
 * make this testable, and the same gap is why an edge cannot be reached without
 * a mouse today.
 */

test('an edge admitting the whole internet says so', async ({ page }) => {
  // Canvas plus an animating camera: the same timing-sensitive class as the
  // pan test, and it competes with fifty others for CPU under fullyParallel.
  test.slow()
  // Derived from the rule, so it fires however the policy was written.
  await page.route('**/api/rules*', (r) => r.fulfill({ json: worldRuleDetails }))
  await page.route('**/api/graph*', (r) =>
    r.fulfill({
      json: {
        revision: 3,
        graph: twoNodeGraph(['networking.k8s.io/NetworkPolicy/prod/open-ingress#ingress[0]']),
      },
    }),
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await settled(page)
  await clickAnEdge(page)

  await expect(
    page.getByRole('dialog', { name: 'Connection' }).getByText(/accepts from every address/),
  ).toBeVisible()
})

/* --------------------------------------------------------------- states */

test('the startup screen reports real progress, and what Marsad will do', async ({ page }) => {
  // Waiting for informer caches is the slowest thing Marsad does on a large
  // cluster, and a bar that says nothing for forty seconds is indistinguishable
  // from one that is stuck. The counts come from /api/health, which is the one
  // endpoint that answers while everything else is still 503.
  await page.route('**/api/meta', (r) => r.fulfill({ status: 503, json: { error: 'syncing' } }))
  await page.route('**/api/namespaces', (r) => r.fulfill({ status: 503, json: { error: 'syncing' } }))
  await page.route('**/api/graph*', (r) => r.fulfill({ status: 503, json: { error: 'syncing' } }))
  await page.route('**/api/health', (r) =>
    r.fulfill({
      json: {
        ok: true,
        ready: false,
        time: new Date().toISOString(),
        progress: [
          { name: 'namespaces', synced: true, count: 8 },
          { name: 'workloads', synced: true, count: 10 },
          { name: 'network policies', synced: false, count: 3 },
        ],
      },
    }),
  )
  await page.goto('/')

  await expect(page.getByText('Reading your cluster')).toBeVisible()
  await expect(page.getByText(/8\s*namespaces/)).toBeVisible()
  await expect(page.getByText(/10\s*workloads/)).toBeVisible()
  // An unfinished group reports a lower bound, and says so rather than
  // presenting it as a total.
  await expect(page.getByText(/3\s*network policies\s*so far/)).toBeVisible()

  await expect(
    page.getByText('Read-only. Marsad lists and watches; it never writes.'),
  ).toBeVisible()
})

test('a cluster with no policies is a finding, not a blank screen', async ({ page }) => {
  await page.route('**/api/meta', (r) =>
    r.fulfill({ json: { ...meta, counts: { namespaces: 2, workloads: 6, policies: 0 } } }),
  )
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: { level: 'workload', nodes: [], edges: [] } } }),
  )
  await page.reload()

  await expect(page.getByText('No network policies at all')).toBeVisible()
  await expect(
    page.getByText(/There is nothing for Marsad to draw — which is itself the finding/),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show all 6 workloads' })).toBeVisible()
})

test('an over-narrow filter blames the filter, not the cluster', async ({ page }) => {
  // A graph with nodes, all of them protected: asking for only the unprotected
  // ones then empties the screen *by filtering*, which is the distinction this
  // state exists to draw. An already-empty graph hides nothing and is a
  // different message entirely.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({
      json: {
        revision: 3,
        graph: {
          level: 'workload',
          nodes: [
            {
              id: 'wl:prod/Deployment/api',
              kind: 'workload',
              label: 'api',
              namespace: 'prod',
              workloadKind: 'Deployment',
              replicas: 1,
              isolation: { ingress: true, egress: true },
            },
          ],
          edges: [],
        },
      },
    }),
  )
  await page.reload()

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByText('Only unprotected').click()

  await expect(page.getByText('No workload matches these filters')).toBeVisible()
  await expect(page.getByText('The cluster is fine — the filter is too narrow.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible()
})

test('the simulate panel says what it is waiting for', async ({ page }) => {
  // Not a blank area that looks the same before the first run as it does after
  // one that returned nothing.
  await page.locator('body').press('s')
  const dialog = page.getByRole('dialog', { name: /Would this connection be allowed/ })
  await expect(dialog.getByText(/Name both ends and a port/)).toBeVisible()
  await expect(dialog.getByText(/never opens a connection to find out/)).toBeVisible()
})

test('a cluster it cannot read gets the best error in the product', async ({ page }) => {
  // The most likely first-run failure there is, and it used to happen entirely
  // off-screen: the process exited, Kubernetes restarted it, and the
  // explanation lived only in a pod log somebody had to know to go and read.
  const message =
    'deployments.apps is forbidden: User "system:serviceaccount:marsad:marsad" cannot list resource "deployments" in API group "apps" at the cluster scope'

  await page.route('**/api/health', (r) =>
    r.fulfill({
      json: {
        ok: false,
        ready: false,
        time: new Date().toISOString(),
        fault: {
          kind: 'forbidden',
          message,
          hint: 'The credentials are valid but lack permission. Marsad only ever reads: get, list and watch.',
          host: 'https://api.example.eks.amazonaws.com',
        },
        clusterRole:
          'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: marsad\nrules:\n  - apiGroups: [apps]\n    resources: [deployments]\n    verbs: [get, list, watch]\n',
      },
    }),
  )
  await page.goto('/')

  await expect(page.getByText('Marsad is not allowed to read this cluster')).toBeVisible()
  await expect(page.getByText('https://api.example.eks.amazonaws.com')).toBeVisible()

  // Verbatim, in a block that reads as the cluster talking rather than Marsad
  // talking about the cluster. The resource and verb it names are the only
  // things that make this fixable.
  await expect(page.getByText('What the API server said')).toBeVisible()
  await expect(page.getByText(message)).toBeVisible()

  // And the way out travels with the problem.
  await expect(page.getByText('The ClusterRole it needs')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(page.getByText(/this screen goes away on its own/)).toBeVisible()
})

test('an unreachable cluster is not offered a ClusterRole', async ({ page }) => {
  // Applying RBAC does not fix a network route, and suggesting it sends someone
  // to change permissions that were never the problem.
  await page.route('**/api/health', (r) =>
    r.fulfill({
      json: {
        ok: false,
        ready: false,
        time: new Date().toISOString(),
        fault: {
          kind: 'unreachable',
          message: 'dial tcp 127.0.0.1:6443: connect: connection refused',
          hint: 'The API server was unreachable.',
        },
      },
    }),
  )
  await page.goto('/')

  await expect(page.getByText('The cluster could not be reached')).toBeVisible()
  await expect(page.getByText('The ClusterRole it needs')).toBeHidden()
})

/* ------------------------------------------------------------------- scale */

const manyNodes = (n: number) => ({
  level: 'workload',
  nodes: Array.from({ length: n }, (_, i) => ({
    id: `wl:corp/Deployment/svc-${i}`,
    kind: 'workload',
    label: `svc-${i}`,
    namespace: 'corp',
    workloadKind: 'Deployment',
    replicas: 1,
    isolation: { ingress: i % 3 !== 0, egress: true },
  })),
  edges: [],
})

test('a graph too large to read is refused, not shipped', async ({ page }) => {
  // Past the limit the layout is a hairball no amount of panning recovers, and
  // sending it only moves the discovery to the browser.
  await page.route('**/api/graph*', (r) =>
    r.fulfill({
      json: {
        revision: 3,
        graph: { level: 'workload', nodes: [], edges: [], oversize: { nodes: 400, limit: 220 } },
      },
    }),
  )
  await page.reload()

  await expect(page.getByText('Too much to draw at once')).toBeVisible()
  await expect(page.getByText(/400/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Search for a workload' })).toBeVisible()
})

test('a focused graph says how much it is not showing', async ({ page }) => {
  await page.route('**/api/graph*', (r) =>
    r.fulfill({
      json: {
        revision: 3,
        graph: {
          ...manyNodes(14),
          focus: {
            node: 'wl:corp/Deployment/svc-0',
            hops: 2,
            namespaces: 9,
            totalNamespaces: 42,
            workloads: 14,
            totalWorkloads: 96,
            hidden: 82,
          },
        },
      },
    }),
  )
  await page.reload()

  await expect(page.getByText(/Focused on/)).toBeVisible()
  await expect(page.getByText(/9 of 42 namespaces drawn/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear focus' })).toBeVisible()
})

test('the minimap appears once there is enough graph to get lost in', async ({ page }) => {
  await page.route('**/api/graph*', (r) =>
    r.fulfill({ json: { revision: 3, graph: manyNodes(20) } }),
  )
  await page.reload()
  await expect(page.getByLabel('Minimap')).toBeVisible()
})

test('the rail can be filtered, and says when nothing matches', async ({ page }) => {
  await page.route('**/api/namespaces', (r) =>
    r.fulfill({
      json: Array.from({ length: 8 }, (_, i) => ({
        name: `ns-${i}`,
        workloads: 2,
        policies: 1,
        unprotected: 0,
      })),
    }),
  )
  await page.reload()

  const rail = page.getByRole('complementary')
  const field = rail.getByLabel('Filter namespaces')
  await expect(field).toBeVisible()

  await field.fill('ns-3')
  await expect(rail.getByRole('button', { name: /ns-3/ })).toBeVisible()
  await expect(rail.getByRole('button', { name: /ns-4/ })).toBeHidden()

  await field.fill('nothing-like-this')
  await expect(rail.getByText('No namespace matches.')).toBeVisible()
})

test('only-reachable-from-outside is its own question', async ({ page }) => {
  // Distinct from unprotected: a workload can be selected by policies and still
  // accept from 0.0.0.0/0, which is a decision somebody made rather than one
  // nobody did.
  await page.getByRole('button', { name: 'Filters' }).click()
  const row = page.getByText('Only reachable from outside')
  await expect(row).toBeVisible()

  await row.click()
  await expect(page.getByText(/Filters are hiding part of this/)).toBeVisible()
})

/* -------------------------------------------------------------- the palette */

test('one entry in the header, not two', async ({ page }) => {
  // Search and simulate were adjacent buttons doing the same thing to different
  // halves of the question.
  const header = page.getByRole('banner')
  await expect(header.getByRole('button', { name: /Search or simulate/ })).toBeVisible()
  // The separate Simulate button is gone; `s` still opens the panel.
  await expect(header.getByRole('button', { name: /^Simulate/ })).toHaveCount(0)
})

test('policies are searchable by name', async ({ page }) => {
  // The direction a policy name actually arrives in: somebody says
  // "default-deny" and you want to know what it is and what it touches. Until
  // now you could only go the other way, from a workload to what selects it.
  await page.locator('body').press('/')
  const dialog = page.getByRole('dialog', { name: 'Search the cluster' })
  await dialog.getByPlaceholder(/Search workloads, namespaces, policies/).fill('default-deny')

  await expect(dialog.getByRole('option', { name: /default-deny/ })).toBeVisible()
  // A policy matching no workload looks like coverage in any list that does not
  // count.
  await expect(dialog.getByText('selects nothing')).toBeVisible()
})

test('workload rows carry their posture', async ({ page }) => {
  await page.locator('body').press('/')
  const dialog = page.getByRole('dialog', { name: 'Search the cluster' })

  await dialog.getByPlaceholder(/Search workloads/).fill('legacy')
  await expect(dialog.getByRole('option', { name: /legacy/ }).getByText('unprotected')).toBeVisible()

  await dialog.getByPlaceholder(/Search workloads/).fill('api')
  await expect(dialog.getByRole('option', { name: /api/ }).first().getByText('protected')).toBeVisible()
})

test('the palette launches the tool, not just navigation', async ({ page }) => {
  // ⌘↵ on a row opens the simulation already framed by it. Finding a thing and
  // then having to go and find it again somewhere else is the gap this closes.
  await page.locator('body').press('/')
  const dialog = page.getByRole('dialog', { name: 'Search the cluster' })
  await dialog.getByPlaceholder(/Search workloads/).fill('api')
  await expect(dialog.getByRole('option', { name: /api/ }).first()).toBeVisible()

  await dialog.getByPlaceholder(/Search workloads/).press('ControlOrMeta+Enter')

  const simulate = page.getByRole('dialog', { name: /Would this connection be allowed/ })
  await expect(simulate).toBeVisible()
  // Framed by the row it was launched from.
  await expect(simulate.locator('#sim-from')).toHaveValue(/api/)
})

test('the palette says which keys do what', async ({ page }) => {
  await page.locator('body').press('/')
  const dialog = page.getByRole('dialog', { name: 'Search the cluster' })
  // Each hint sits beside its key cap, so the element reads "↑↓ navigate".
  for (const hint of ['navigate', 'open', 'simulate from', 'close']) {
    await expect(dialog.getByText(hint, { exact: false }).first()).toBeVisible()
  }
})
