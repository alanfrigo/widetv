import { expect, test, vi } from 'vitest';
import { awaitMediaReady, startPlayback } from '../../src/web/playback';

test('metadata completion removes both listeners', async () => {
  const media = Object.assign(new EventTarget(), { readyState: 0 });
  const remove = vi.spyOn(media, 'removeEventListener');
  const ready = awaitMediaReady(media, 100);
  media.dispatchEvent(new Event('loadedmetadata'));
  expect(await ready).toBe('ready');
  expect(remove).toHaveBeenCalledTimes(2);
});

test('cancelled metadata does not wait for the timeout', async () => {
  const media = Object.assign(new EventTarget(), { readyState: 0 });
  const abort = new AbortController();
  const ready = awaitMediaReady(media, 10_000, abort.signal);
  abort.abort();
  expect(await ready).toBe('cancelled');
});

test('an abandoned autoplay attempt cannot mute the new playback', async () => {
  const abort = new AbortController();
  let reject!: (reason: Error) => void;
  const media = { muted: false, play: vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; })) };
  const playing = startPlayback(media, false, abort.signal);
  abort.abort();
  reject(new Error('NotAllowedError'));
  await playing;
  expect(media.muted).toBe(false);
  expect(media.play).toHaveBeenCalledTimes(1);
});
