import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AppSettings, ChannelSummary, EpisodeRef } from '../../src/shared/api-types';

export const channels: ChannelSummary[] = Array.from({ length: 500 }, (_, i) => ({
  number: i + 1, name: `Série ${String(i + 1).padStart(3, '0')}`, episodeCount: 30,
  posterUrl: null, backdropUrl: null, year: 2020, overview: 'Uma série para testar navegação e reprodução.', seasons: [1],
}));
export function episodes(channel: number, count = 30): EpisodeRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${channel}/episode-${i + 1}.mp4`, title: `Episódio ${i + 1}`, season: 1, episode: i + 1,
    durationMs: 10_000, width: 320, height: 180, audioTracks: [], subtitleTracks: [], thumbUrl: null,
  }));
}
export const settings: AppSettings = {
  audioLang: 'por', subtitleLang: null, subtitlesAuto: false, rescanTime: null,
  autoRemux: false, remuxCacheMaxBytes: 0, autoThumbs: false, smartGrouping: false, tmdbConfigured: false,
};
export const status = {
  scan: { state: 'idle', progress: null, startedAt: null, last: null },
  metadata: { state: 'idle', last: null }, remux: { state: 'idle' },
  thumbs: { state: 'idle', progress: null, last: null },
};

export async function fixture(page: Page): Promise<void> {
  const media = process.env.WIDETV_TEST_MEDIA ? readFileSync(process.env.WIDETV_TEST_MEDIA) : null;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/stream/')) {
      if (route.request().method() === 'HEAD') return route.fulfill({ status: 200 });
      if (media) {
        const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
        return route.fulfill({ status: range ? 206 : 200, body: media.subarray(start, end + 1), contentType: 'video/mp4',
          headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${media.length}` } : {}) },
        });
      }
      return route.fulfill({ status: 404 });
    }
    const series = path.match(/\/channels\/(\d+)\/episodes/);
    const nowChannel = path.match(/\/channels\/(\d+)\/now/);
    const now = channels.slice(0, 24).map(channel => ({
      channel, episode: episodes(channel.number)[0]!, next: episodes(channel.number)[1]!,
      offsetMs: 0, serverTimeMs: Date.now(), endsAtMs: Date.now() + 10_000,
    }));
    const json = path === '/api/channels' ? channels
      : series ? episodes(Number(series[1]))
      : nowChannel ? now.find(n => n.channel.number === Number(nowChannel[1]))
      : path === '/api/now' ? now
      : path === '/api/settings' ? settings
      : path === '/api/library/status' ? status
      : path.startsWith('/api/history') ? [] : {};
    await route.fulfill({ json });
  });
}
