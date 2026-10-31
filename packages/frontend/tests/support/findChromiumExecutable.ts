import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Locates a Chromium-family browser so browser tests run without Playwright's own download. */
/** `bundledPath` is playwright-core's own browser path, tried after the environment overrides. */
export function findChromiumExecutable(bundledPath: string): string {
  const candidates: string[] = [];
  const add = (candidate: string | undefined) => {
    if (candidate != null && candidate.length > 0) candidates.push(candidate);
  };

  add(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']);
  add(process.env['CHROME_PATH']);
  add(process.env['EDGE_PATH']);
  add(bundledPath);
  // A shared browser directory may hold a browser for another Playwright release under a plain name.
  const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (browsersPath != null && browsersPath.length > 0) add(join(browsersPath, 'chromium'));

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'];
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (programFiles != null) add(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86 != null) {
      add(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (localAppData != null) {
      add(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/google-chrome-stable');
    add('/usr/bin/chromium');
    add('/usr/bin/chromium-browser');
  }

  const executable = candidates.find(candidate => existsSync(candidate));
  if (executable == null) {
    throw new Error(
      'A Chromium browser is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, CHROME_PATH, or EDGE_PATH.',
    );
  }
  return executable;
}
