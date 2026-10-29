import type { DepOptimizationOptions } from 'vite';

/**
 * The SDK loads from source in dev, about 1,700 files. One request per file pushes a page load past
 * 2,000 requests, and a reload or second tab then hits the browser's open-request limit, so imports
 * fail and the app never mounts. One pre-bundled file keeps a load to a few hundred requests.
 */
export const DEV_OPTIMIZE_DEPS: DepOptimizationOptions = { include: ['@truefoundry/trueforge-sdk'] };
