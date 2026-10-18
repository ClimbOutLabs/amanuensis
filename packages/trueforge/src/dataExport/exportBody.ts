import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

/** Small writes are gathered to about this size before they are handed to the connection. */
const COALESCE_BYTES = 64 * 1024;
const QUEUE_BYTES = 256 * 1024;

/** The consumer cancelled the body, for example because the client went away. */
export class ExportBodyCancelledError extends Error {
  constructor() {
    super('The client closed the connection before the export finished.');
    this.name = 'ExportBodyCancelledError';
  }
}

/**
 * A response body fed by `produce`. When `produce` rejects the body errors, so the HTTP layer
 * drops the connection and the client sees a failed download instead of a short archive that
 * looks complete. When the consumer goes away the writable is destroyed, so `produce` fails at
 * its next write and stops. Memory stays bounded by the queue: writes wait while it is full.
 */
export function exportResponseBody({
  produce,
}: {
  produce: (out: Writable) => Promise<void>;
}): ReadableStream<Uint8Array> {
  let out: Writable | undefined;
  let resumeWrite: (() => void) | undefined;
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let pending: Buffer[] = [];
        let pendingBytes = 0;

        const flush = (): void => {
          if (pendingBytes === 0 || cancelled) {
            return;
          }
          controller.enqueue(Buffer.concat(pending));
          pending = [];
          pendingBytes = 0;
        };

        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            if (cancelled) {
              callback(new ExportBodyCancelledError());
              return;
            }
            pending.push(chunk);
            pendingBytes += chunk.byteLength;
            if (pendingBytes < COALESCE_BYTES) {
              callback();
              return;
            }
            flush();
            if ((controller.desiredSize ?? 0) > 0) {
              callback();
            } else {
              resumeWrite = callback;
            }
          },
          final(callback) {
            flush();
            callback();
          },
        });
        // Failures reach the consumer through the body; an unhandled 'error' event would crash the process.
        sink.on('error', () => undefined);
        out = sink;

        produce(sink)
          .then(async () => {
            sink.end();
            await finished(sink);
            if (!cancelled) {
              controller.close();
            }
          })
          .catch((error: unknown) => {
            sink.destroy();
            if (!cancelled) {
              controller.error(error);
            }
          });
      },
      pull() {
        const resume = resumeWrite;
        resumeWrite = undefined;
        resume?.();
      },
      cancel() {
        cancelled = true;
        out?.destroy(new ExportBodyCancelledError());
        resumeWrite = undefined;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: QUEUE_BYTES }),
  );
}
