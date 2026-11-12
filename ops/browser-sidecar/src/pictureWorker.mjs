// Draws the model's copy of a screenshot off the sidecar's main thread, so one person's picture
// never holds up another person's browser calls.
import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';

import { markPicture } from './pictureMarks.mjs';

parentPort.postMessage(markPicture({ ...workerData, png: Buffer.from(workerData.png) }));
