import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = join(tmpdir(), 'widetv-test-media');
mkdirSync(directory, { recursive: true });
const media = join(directory, 'episode.mp4');
const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  '-movflags', '+faststart', media], { stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const test = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, WIDETV_TEST_MEDIA: media },
});
process.exit(test.status ?? 1);
