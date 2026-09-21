/**
 * The single owner of the capped HTTP response-body read shared by the memory clients
 * ({@link ../hindsightClient} and {@link ./screenClient}). It caps against `content-length` first as
 * a fast path, then the actual bytes as they arrive, so a chunked response with no trustworthy
 * `content-length` is never buffered past the cap. Never throws: an over-cap body reports
 * `oversize`, and any decode or stream failure reports `unreadable` with the underlying `cause` so a
 * caller can still classify a timeout abort. Only a transport with no `response.body` (chiefly
 * mocked ones) falls back to materializing the whole body with `response.text()` before checking it.
 *
 * Both clients previously carried their own copy of this algorithm; keeping one owner means the
 * security-critical byte accounting cannot drift between them.
 */
export type BoundedBodyRead =
  { ok: true; text: string } | { ok: false; kind: 'oversize' } | { ok: false; kind: 'unreadable'; cause: unknown };

export async function readBodyWithinCap(response: Response, maxResponseBytes: number): Promise<BoundedBodyRead> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > maxResponseBytes) {
      return { ok: false, kind: 'oversize' };
    }
  }
  const body = response.body;
  if (body) {
    return readStreamedBodyWithinCap(body, maxResponseBytes);
  }
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      return { ok: false, kind: 'oversize' };
    }
    return { ok: true, text };
  } catch (cause) {
    return { ok: false, kind: 'unreadable', cause };
  }
}

async function readStreamedBodyWithinCap(
  body: ReadableStream<Uint8Array>,
  maxResponseBytes: number,
): Promise<BoundedBodyRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        return { ok: false, kind: 'oversize' };
      }
      chunks.push(value);
    }
  } catch (cause) {
    return { ok: false, kind: 'unreadable', cause };
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks, total)) };
}
