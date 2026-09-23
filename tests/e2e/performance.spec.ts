import { test, expect } from '@playwright/test';
import { channels, episodes, fixture } from './fixture';
import { writeFileSync } from 'node:fs';

test('repeatable catalog and playback measurements', async ({ browser }, info) => {
  test.setTimeout(180_000);
  test.skip(process.env.WIDETV_PERF !== '1', 'Opt-in benchmark; avoids timing assertions in functional CI.');
  const samples = [];
  for (let run = 0; run < 7; run++) {
    const page = await browser.newPage();
    await fixture(page);
    let positionMs = 1000;
    await page.route('**/api/history/resume', route => route.fulfill({ json: [{
      channelNumber: 1, channelName: channels[0]!.name, posterUrl: null, backdropUrl: null,
      episode: episodes(1)[0], positionMs, durationMs: 10_000, updatedAt: Date.now(), watchedAt: null,
    }] }));
    let requests = 0;
    page.on('request', request => { if (request.url().includes('/api/')) requests++; });
    const start = performance.now();
    await page.goto(process.env.WIDETV_TEST_URL ?? 'http://127.0.0.1:5173');
    await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
    await expect(page.locator('#rail-resume .card')).toHaveCount(1);
    const catalogMs = performance.now() - start;
    const searchStart = performance.now();
    await page.locator('#search-input').fill('Série 010');
    await expect(page.locator('#rail-shelf .card')).toHaveCount(1);
    const searchMs = performance.now() - searchStart;
    await page.locator('#search-input').fill('');
    await expect(page.locator('#rail-shelf .card')).toHaveCount(500);
    await page.evaluate(() => {
      const counters = { removedCards: 0, longTasks: 0 };
      Object.assign(window, { benchmark: counters });
      new MutationObserver(mutations => {
        for (const mutation of mutations) counters.removedCards += mutation.removedNodes.length;
      }).observe(document.querySelector('#rail-shelf')!, { childList: true });
      new PerformanceObserver(list => { counters.longTasks += list.getEntries().length; }).observe({ type: 'longtask' });
    });
    const client = await page.context().newCDPSession(page);
    await client.send('HeapProfiler.collectGarbage');
    const before = await client.send('Runtime.getHeapUsage');
    const navigationStart = performance.now();
    for (let cycle = 0; cycle < 10; cycle++) {
      await page.locator('#rail-shelf .card').first().click();
      await expect(page.locator('#episode-list .ep')).toHaveCount(30);
      positionMs += 100;
      const response = page.waitForResponse('**/api/history/resume');
      await page.locator('#series-back').click();
      await response;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    const navigationMs = (performance.now() - navigationStart) / 10;
    await client.send('HeapProfiler.collectGarbage');
    const after = await client.send('Runtime.getHeapUsage');
    const dom = await client.send('Memory.getDOMCounters');
    const counters = await page.evaluate(() => (window as unknown as { benchmark: object }).benchmark);
    let firstFrameMs: number | null = null;
    let channelChangeMs: number | null = null;
    let droppedFrames: number | null = null;
    if (process.env.WIDETV_TEST_MEDIA) {
      await page.evaluate(() => {
        const measurements = { firstStart: 0, tuneStart: 0, first: 0, tune: 0 };
        Object.assign(window, { videoMeasurements: measurements });
        document.querySelector('#hero-play')!.addEventListener('click', () => { measurements.firstStart = performance.now(); }, { capture: true });
        document.addEventListener('keydown', event => { if (event.key === 'ArrowUp') measurements.tuneStart = performance.now(); }, { capture: true });
        for (const video of document.querySelectorAll('video')) {
          const frame = () => {
            if (measurements.firstStart && !measurements.first) measurements.first = performance.now() - measurements.firstStart;
            if (measurements.tuneStart && !measurements.tune && video.currentSrc.includes('2%2F')) measurements.tune = performance.now() - measurements.tuneStart;
            video.requestVideoFrameCallback(frame);
          };
          video.requestVideoFrameCallback(frame);
        }
      });
      await page.locator('#hero-play').click();
      const measurement = (field: 'first' | 'tune') => page.evaluate(key => (window as unknown as { videoMeasurements: { first: number; tune: number } }).videoMeasurements[key], field);
      await expect.poll(() => measurement('first')).toBeGreaterThan(0);
      firstFrameMs = await measurement('first');
      await page.keyboard.press('ArrowUp');
      await expect.poll(() => measurement('tune')).toBeGreaterThan(0);
      channelChangeMs = await measurement('tune');
      droppedFrames = await page.locator('video').evaluateAll(nodes => nodes.reduce((total, node) => total + (node instanceof HTMLVideoElement ? node.getVideoPlaybackQuality().droppedVideoFrames : 0), 0));
    }
    samples.push({ run, catalogMs, searchMs, navigationMs, firstFrameMs, channelChangeMs, droppedFrames,
      requests, heapBefore: before.usedSize, heapAfter: after.usedSize, nodes: dom.nodes, ...counters });
    await page.close();
  }
  const path = info.outputPath('performance.json');
  writeFileSync(path, JSON.stringify(samples, null, 2));
  if (process.env.WIDETV_PERF_OUTPUT) writeFileSync(process.env.WIDETV_PERF_OUTPUT, JSON.stringify(samples, null, 2));
  await info.attach('performance', { path, contentType: 'application/json' });
});

test('warm channel changes separate frame jitter from sustained regressions', async ({ page }, info) => {
  test.skip(process.env.WIDETV_PERF !== '1' || !process.env.WIDETV_TEST_MEDIA, 'Opt-in media benchmark.');
  test.setTimeout(60_000);
  await fixture(page);
  await page.goto('/');
  await page.locator('#hero-play').click();
  await expect.poll(() => page.locator('video').evaluateAll(nodes => nodes.some(node => node instanceof HTMLVideoElement && !node.paused && node.currentTime > 0))).toBe(true);
  await page.evaluate(() => {
    const measurement = { started: 0, expected: 2, duration: 0 };
    Object.assign(window, { warmTune: measurement });
    document.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { measurement.started = performance.now(); measurement.duration = 0; }
    }, { capture: true });
    for (const video of document.querySelectorAll('video')) {
      const frame = () => {
        if (measurement.started && !measurement.duration && video.currentSrc.includes(`${measurement.expected}%2F`)) {
          measurement.duration = performance.now() - measurement.started;
        }
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    }
  });
  const samples: number[] = [];
  for (let index = 0; index < 50; index++) {
    const target = index % 2 === 0 ? 2 : 1;
    await page.evaluate(expected => {
      const measurement = (window as unknown as { warmTune: { expected: number; duration: number; started: number } }).warmTune;
      measurement.expected = expected; measurement.duration = 0; measurement.started = 0;
    }, target);
    await page.keyboard.press(target === 2 ? 'ArrowUp' : 'ArrowDown');
    const duration = () => page.evaluate(() => (window as unknown as { warmTune: { duration: number } }).warmTune.duration);
    await expect.poll(duration).toBeGreaterThan(0);
    samples.push(await duration());
  }
  const path = info.outputPath('warm-channel-changes.json');
  writeFileSync(path, JSON.stringify(samples, null, 2));
  if (process.env.WIDETV_PERF_OUTPUT) writeFileSync(`${process.env.WIDETV_PERF_OUTPUT}.channels.json`, JSON.stringify(samples, null, 2));
  await info.attach('channel-changes', { path, contentType: 'application/json' });
});
