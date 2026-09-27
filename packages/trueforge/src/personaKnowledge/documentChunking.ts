export interface ChunkingOptions {
  /** Soft target for chunk size in characters. Defaults to 1200. */
  chunkChars?: number;
  /** Overlap carried from the previous chunk, in characters. Defaults to 200. */
  overlapChars?: number;
  /** Hard cap on chunks per document. Defaults to 2000. */
  maxChunks?: number;
  /** Hard cap on input characters; the remainder is dropped. Defaults to 500_000. */
  maxChars?: number;
}

export interface ChunkedDocument {
  chunks: string[];
  /** True when the input exceeded maxChars and the tail was dropped. */
  truncated: boolean;
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'“([])/;
const PARAGRAPH_SPLIT = /\n{2,}/;

/**
 * Splits text into overlapping chunks on sentence boundaries. Paragraphs
 * longer than the target are split sentence-wise; a single over-long
 * sentence is hard-cut so no chunk can grow without bound.
 */
export function chunkText(text: string, options?: ChunkingOptions): ChunkedDocument {
  const chunkChars = options?.chunkChars ?? 1200;
  const overlapChars = options?.overlapChars ?? 200;
  const maxChunks = options?.maxChunks ?? 2000;
  const maxChars = options?.maxChars ?? 500_000;

  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (normalized.length === 0) {
    return { chunks: [], truncated: false };
  }
  const truncated = normalized.length > maxChars;
  const bounded = truncated ? normalized.slice(0, maxChars) : normalized;

  const sentences: string[] = [];
  for (const paragraph of bounded.split(PARAGRAPH_SPLIT)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      continue;
    }
    for (const sentence of trimmed.split(SENTENCE_BOUNDARY)) {
      const piece = sentence.trim();
      if (piece.length === 0) {
        continue;
      }
      if (piece.length <= chunkChars) {
        sentences.push(piece);
      } else {
        // One over-long sentence: hard-cut so chunks stay bounded.
        for (let offset = 0; offset < piece.length; offset += chunkChars) {
          sentences.push(piece.slice(offset, offset + chunkChars));
        }
      }
    }
  }

  const chunks: string[] = [];
  let current = '';
  const pushChunk = (body: string) => {
    const trimmed = body.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  };
  for (const sentence of sentences) {
    if (chunks.length >= maxChunks) {
      break;
    }
    const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (candidate.length > chunkChars && current.length > 0) {
      pushChunk(current);
      const tail = overlapTail(current, overlapChars);
      const retry = tail.length === 0 ? sentence : `${tail} ${sentence}`;
      current = retry.length > chunkChars ? sentence : retry;
    } else {
      current = candidate;
    }
  }
  pushChunk(current);
  return { chunks: chunks.slice(0, maxChunks), truncated };
}

/** Overlap tail: last ~overlapChars of the chunk, cut at a sentence start when one is near. */
function overlapTail(chunk: string, overlapChars: number): string {
  if (chunk.length <= overlapChars || overlapChars <= 0) {
    return '';
  }
  const tail = chunk.slice(chunk.length - overlapChars);
  const match = SENTENCE_BOUNDARY.exec(` ${tail}`);
  if (match?.index !== undefined && match.index < tail.length / 2) {
    return tail.slice(match.index + match[0].length).trim();
  }
  return tail.trim();
}
