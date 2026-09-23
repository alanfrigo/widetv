import { expect, test } from '@playwright/test';
import { channels, episodes, fixture } from './fixture';

test.beforeEach(async ({ page }) => { await fixture(page); });

test('large catalog, search, remote focus and return to the original card', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
  await page.locator('#search-input').fill('Série 010');
  await expect(page.locator('#rail-shelf .card')).toHaveCount(1);
  const card = page.locator('#rail-shelf .card').first();
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#episode-list .ep')).toHaveCount(30);
  await page.locator('#series-back').click();
  await expect(card).toBeFocused();
});

test('a failed catalog can be retried without reloading', async ({ page }) => {
  let fail = true;
  await page.route('**/api/channels', route => route.fulfill(fail ? { status: 503 } : { json: channels }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
});

test('a delayed failure from series A cannot replace series B', async ({ page }) => {
  let release!: () => void;
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/channels/1/episodes', async route => { await gate; await route.fulfill({ status: 503 }).catch(() => {}); delivered(); });
  await page.goto('/');
  await page.locator('#rail-shelf .card').nth(0).click();
  await expect(page.locator('#screen-series')).toBeVisible();
  await page.locator('#series-back').click();
  await page.locator('#rail-shelf .card').nth(1).click();
  await expect(page.locator('#episode-list .ep')).toHaveCount(30);
  release();
  await delivery;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#series-title')).toHaveText('Série 002');
  await expect(page.locator('#episode-list .ep')).toHaveCount(30);
});

test('expired session returns to login and clears the old catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
  await page.route('**/api/channels/1/episodes', route => route.fulfill({ status: 401 }));
  await page.locator('#rail-shelf .card').first().click();
  await expect(page.locator('#screen-login')).toBeVisible();
});

test('progress refresh preserves cards, focus and scroll', async ({ page }) => {
  let positionMs = 1000;
  await page.route('**/api/history/resume', route => route.fulfill({ json: [{
    channelNumber: 1, channelName: channels[0]!.name, posterUrl: null, backdropUrl: null,
    episode: episodes(1)[0], positionMs, durationMs: 10_000, updatedAt: Date.now(), watchedAt: null,
  }] }));
  await page.goto('/');
  await expect(page.locator('#rail-resume .card')).toHaveCount(1);
  const card = page.locator('#rail-shelf .card').first();
  await card.evaluate(node => { Object.assign(window, { retainedCard: node }); });
  await card.click();
  await expect(page.locator('#episode-list .ep')).toHaveCount(30);
  positionMs = 3000;
  await page.locator('#series-back').click();
  await expect(page.locator('#rail-shelf .card').first().locator('.card__bar-fill')).toHaveCSS('width', /.+/);
  await expect.poll(() => page.locator('#rail-resume .card__bar-fill').first().evaluate(node => (node as HTMLElement).style.width)).toBe('30%');
  expect(await card.evaluate(node => node === (window as unknown as { retainedCard: Element }).retainedCard)).toBe(true);
  await expect(card).toBeFocused();
});

test('leaving during the first stream probe cannot start an abandoned video', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/stream/**', async route => {
    if (route.request().method() === 'HEAD') { await gate; await route.fulfill({ status: 200 }).catch(() => {}); }
    else { started = true; await route.fulfill({ status: 404 }); }
  });
  await page.goto('/');
  await page.locator('#rail-shelf .card').first().click();
  await page.locator('#episode-list .ep').first().click();
  await expect(page.locator('#screen-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#screen-series')).toBeVisible();
  release();
  // Wait through the response processing, not a fixed network delay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(started).toBe(false);
});

test('long season and compact viewport keep recovery and controls accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/channels/1/episodes', route => route.fulfill({ json: episodes(1, 500) }));
  await page.goto('/');
  await page.locator('#rail-shelf .card').first().click();
  await expect(page.locator('#episode-list .ep')).toHaveCount(500);
  await page.locator('#episode-list .ep').last().focus();
  await expect(page.locator('#episode-list .ep').last()).toBeFocused();
  await page.screenshot({ path: 'test-results/series-mobile.png', fullPage: false });
});

test('actual media starts and reports progress', async ({ page }) => {
  test.skip(!process.env.WIDETV_TEST_MEDIA, 'Generate the isolated FFmpeg fixture with npm run test:media.');
  await page.goto('/');
  await page.locator('#rail-shelf .card').first().click();
  await page.locator('#episode-list .ep').first().click();
  await expect.poll(() => page.locator('video').evaluateAll(videos => videos.some(video => video instanceof HTMLVideoElement && video.currentTime > 0 && !video.paused))).toBe(true);
  const saved = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname.startsWith('/api/history/'));
  await page.keyboard.press('Escape');
  expect((await saved).postDataJSON().positionMs).toBeGreaterThan(0);
});

test('the next VOD episode starts automatically at the end', async ({ page }) => {
  test.skip(!process.env.WIDETV_TEST_MEDIA, 'Requires the generated media fixture.');
  await page.goto('/');
  await page.locator('#rail-shelf .card').first().click();
  await page.locator('#episode-list .ep').first().click();
  await expect.poll(() => page.locator('video').evaluateAll(nodes => nodes.some(node => node instanceof HTMLVideoElement && !node.paused && node.currentTime > 0))).toBe(true);
  await page.locator('video').evaluateAll(nodes => {
    for (const node of nodes) if (node instanceof HTMLVideoElement && !node.paused) node.currentTime = node.duration - 0.1;
  });
  await expect(page.locator('video[src*="episode-2.mp4"]')).toHaveCount(1);
});

test('a preparing next episode never inherits the finished episode progress', async ({ page }) => {
  test.skip(!process.env.WIDETV_TEST_MEDIA, 'Requires the generated media fixture.');
  await page.clock.install();
  let wrongProgress = 0;
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().includes('episode-2.mp4')) wrongProgress++;
  });
  await page.route('**/api/stream/*episode-2.mp4*', route => route.fulfill({ status: 202 }));
  await page.goto('/');
  await page.locator('#rail-shelf .card').first().click();
  await page.locator('#episode-list .ep').first().click();
  await expect.poll(() => page.locator('video').evaluateAll(nodes => nodes.some(node => node instanceof HTMLVideoElement && !node.paused && node.currentTime > 0))).toBe(true);
  await page.locator('video').evaluateAll(nodes => {
    for (const node of nodes) if (node instanceof HTMLVideoElement && !node.paused) node.currentTime = node.duration - 0.1;
  });
  await expect(page.getByText('Preparando o episódio… começa sozinho')).toBeVisible();
  await page.clock.fastForward(12_000);
  await page.keyboard.press('Escape');
  expect(wrongProgress).toBe(0);
});

test('a late live tune cannot replace the channel selected afterwards', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  await page.route('**/api/channels/1/now', async route => {
    await gate;
    await route.fulfill({ json: {
      channel: channels[0], episode: episodes(1)[0], next: episodes(1)[1],
      offsetMs: 0, serverTimeMs: Date.now(), endsAtMs: Date.now() + 10_000,
    } }).catch(() => {});
    delivered();
  });
  await page.goto('/');
  await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
  const first = page.waitForRequest('**/api/channels/1/now');
  await page.locator('#hero-play').click();
  await first;
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('video[src*="2%2F"]')).toHaveCount(1);
  release();
  await delivery;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('video[src*="1%2F"]')).toHaveCount(0);
});

test('hidden catalog stops polling and refreshes on visibility return', async ({ page }) => {
  await page.clock.install();
  let nowRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/now') nowRequests++; });
  await page.goto('/');
  await expect(page.locator('#rail-live .card')).toHaveCount(24);
  const before = nowRequests;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(65_000);
  expect(nowRequests).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => nowRequests).toBeGreaterThan(before);
});
