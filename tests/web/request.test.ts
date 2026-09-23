import { afterEach, expect, test, vi } from 'vitest';
import { controlRequest, resetRequests } from '../../src/web/request';
import { patchSettings } from '../../src/web/api';

afterEach(() => { resetRequests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('cancels control requests after 15 seconds, including a stalled body', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Body aborted', 'AbortError')));
    } }));
  }));
  const request = controlRequest('/api/channels');
  const assertion = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  expect(signal!.aborted).toBe(true);
});

test('screen cancellation reaches fetch and prevents an old response being consumed', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  })));
  const request = controlRequest('/api/channels', { signal: controller.signal });
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});

test('session reset cancels pending work but allows the next session', async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockResolvedValueOnce(new Response('[]')));
  const old = controlRequest('/api/channels');
  resetRequests();
  complete(new Response('[1]'));
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect(await (await controlRequest('/api/channels')).json()).toEqual([]);
});

test('preference writes keep user order even when the first response is slow', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(Response.json({ audioLang: 'eng' }));
  vi.stubGlobal('fetch', fetch);
  const first = patchSettings({ audioLang: 'por' });
  const second = patchSettings({ audioLang: 'eng' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  finish(Response.json({ audioLang: 'por' }));
  await first;
  expect(await second).toEqual({ audioLang: 'eng' });
  expect(fetch.mock.calls.map(call => JSON.parse(call[1].body).audioLang)).toEqual(['por', 'eng']);
});
