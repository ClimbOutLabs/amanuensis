/** Caps for images shown in chat. The sandbox script and the host checks both read these. */

/** Largest local image (upload, sandbox output, email attachment) accepted for re-encoding. */
export const CHAT_IMAGE_LOCAL_MAX_BYTES = 10 * 1024 * 1024;

/** Largest remote image body read from the network. */
export const CHAT_IMAGE_REMOTE_MAX_BYTES = 5 * 1024 * 1024;

/** Decode limits enforced inside the sandbox before any pixel data is loaded. */
export const CHAT_IMAGE_MAX_FRAME_PIXELS = 40_000_000;
export const CHAT_IMAGE_MAX_SIDE_PX = 16_384;
export const CHAT_IMAGE_MAX_FRAMES = 100;
export const CHAT_IMAGE_MAX_TOTAL_PIXELS = 200_000_000;

/** Re-encoded output limits: the sandbox downscales to the side cap and the host refuses anything larger. */
export const CHAT_IMAGE_OUTPUT_MAX_SIDE_PX = 2048;
export const CHAT_IMAGE_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** Re-encodes in flight at once, and the wall-clock budget for one. */
export const CHAT_IMAGE_MAX_CONCURRENT_REENCODES = 2;
export const CHAT_IMAGE_REENCODE_TIMEOUT_SECONDS = 20;

/** Remote fetch: total time budget and redirect hops, each hop re-checked. */
export const CHAT_IMAGE_FETCH_TIMEOUT_MS = 10_000;
export const CHAT_IMAGE_FETCH_MAX_REDIRECTS = 3;

/** Images one email card may show, and silent reply images per turn (the search loop breaker). */
export const CHAT_IMAGE_MAX_PER_EMAIL = 20;
export const CHAT_IMAGE_MAX_SILENT_PER_TURN = 20;

/** Cache: kept this long, and at most this many bytes per user (oldest removed first). */
export const CHAT_IMAGE_RETENTION_DAYS = 30;
export const CHAT_IMAGE_USER_MAX_BYTES = 256 * 1024 * 1024;
