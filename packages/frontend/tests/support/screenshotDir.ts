/** Where browser tests write their screenshots, under a caller-named temp folder prefix. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function screenshotDir(prefix: string): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), prefix));
}
