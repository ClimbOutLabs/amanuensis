import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/** A run of streamed text sorted into the answer or into the reasoning. */
export interface ThinkSegment {
  kind: 'answer' | 'reasoning';
  text: string;
}

/**
 * `undecided` holds all text until a think tag shows which side of it the text is on. It is used
 * only when reasoning was requested, because a bare closing tag can only be placed after the fact.
 */
type SplitMode = 'undecided' | 'answer' | 'reasoning';

/** Splits streamed answer text into answer and reasoning around `<think>` and `</think>` tags. */
export class ThinkTagSplitter {
  #mode: SplitMode;
  /** Text held back because it may still grow into a tag (or, while undecided, the whole reply so far). */
  #held = '';
  /** Whitespace right after a closing tag is the gap before the answer, not part of it. */
  #trimAnswerStart = false;

  constructor({ bareClose }: { bareClose: boolean }) {
    this.#mode = bareClose ? 'undecided' : 'answer';
  }

  /** Feed one streamed piece; returns the segments that are safe to release now. */
  push(text: string): ThinkSegment[] {
    const segments: ThinkSegment[] = [];
    let input = this.#held + text;
    this.#held = '';
    for (;;) {
      const tag = nextTag(input);
      if (tag === undefined) {
        const hold = this.#mode === 'undecided' ? input.length : partialTagTail(input);
        this.#held = input.slice(input.length - hold);
        this.#emit({
          segments,
          kind: this.#mode === 'reasoning' ? 'reasoning' : 'answer',
          text: input.slice(0, input.length - hold),
        });
        return segments;
      }
      const before = input.slice(0, tag.at);
      input = input.slice(tag.at + tag.text.length);
      if (this.#mode === 'undecided') {
        if (tag.kind === 'open') {
          this.#emit({ segments, kind: 'answer', text: before });
          this.#mode = 'reasoning';
        } else {
          this.#emit({ segments, kind: 'reasoning', text: before });
          this.#mode = 'answer';
          this.#trimAnswerStart = true;
        }
        continue;
      }
      this.#emit({ segments, kind: this.#mode, text: before });
      if (tag.kind === 'open' && this.#mode === 'answer') {
        this.#mode = 'reasoning';
      } else if (tag.kind === 'close' && this.#mode === 'reasoning') {
        this.#mode = 'answer';
        this.#trimAnswerStart = true;
      }
      // Any other tag is a stray marker in the mode it appears in, so it is dropped.
    }
  }

  /** Releases everything still held, at the end of the reply or when the stream changes kind. */
  flush(): ThinkSegment[] {
    const segments: ThinkSegment[] = [];
    // Nothing held means no text has arrived yet, so the reply is still undecided.
    if (this.#mode === 'undecided' && this.#held === '') {
      return segments;
    }
    const held = this.#held;
    this.#held = '';
    // Held text was never a tag: it is text in whatever mode the reply is in now.
    this.#emit({ segments, kind: this.#mode === 'reasoning' ? 'reasoning' : 'answer', text: held });
    if (this.#mode === 'undecided') {
      this.#mode = 'answer';
    }
    return segments;
  }

  #emit({ segments, kind, text }: { segments: ThinkSegment[]; kind: ThinkSegment['kind']; text: string }): void {
    let released = text;
    if (kind === 'answer' && this.#trimAnswerStart) {
      released = released.trimStart();
      if (released !== '') {
        this.#trimAnswerStart = false;
      }
    }
    if (released !== '') {
      segments.push({ kind, text: released });
    }
  }
}

/** The first think tag in the text, if any. */
function nextTag(text: string): { kind: 'open' | 'close'; at: number; text: string } | undefined {
  const openAt = text.indexOf(OPEN_TAG);
  const closeAt = text.indexOf(CLOSE_TAG);
  if (openAt === -1 && closeAt === -1) {
    return undefined;
  }
  if (closeAt === -1 || (openAt !== -1 && openAt < closeAt)) {
    return { kind: 'open', at: openAt, text: OPEN_TAG };
  }
  return { kind: 'close', at: closeAt, text: CLOSE_TAG };
}

/** How many trailing characters could still grow into a think tag and must wait for more text. */
function partialTagTail(text: string): number {
  for (let hold = Math.min(text.length, CLOSE_TAG.length - 1); hold > 0; hold--) {
    const tail = text.slice(text.length - hold);
    if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) {
      return hold;
    }
  }
  return 0;
}

type PartController = TransformStreamDefaultController<LanguageModelV4StreamPart>;

/**
 * Writes split segments back into the stream as parts. Answer text keeps the id of the text block
 * it came from; each reasoning run gets its own block, opened on first use and closed before any
 * answer text or other part.
 */
class SegmentWriter {
  #openReasoningId: string | undefined;
  #reasoningRuns = 0;

  write({
    controller,
    segments,
    textId,
  }: {
    controller: PartController;
    segments: ThinkSegment[];
    textId: string;
  }): void {
    for (const segment of segments) {
      if (segment.kind === 'answer') {
        this.closeReasoning({ controller });
        controller.enqueue({ type: 'text-delta', id: textId, delta: segment.text });
        continue;
      }
      if (this.#openReasoningId === undefined) {
        this.#openReasoningId = `think-${String(this.#reasoningRuns++)}`;
        controller.enqueue({ type: 'reasoning-start', id: this.#openReasoningId });
      }
      controller.enqueue({ type: 'reasoning-delta', id: this.#openReasoningId, delta: segment.text });
    }
  }

  closeReasoning({ controller }: { controller: PartController }): void {
    if (this.#openReasoningId !== undefined) {
      controller.enqueue({ type: 'reasoning-end', id: this.#openReasoningId });
      this.#openReasoningId = undefined;
    }
  }
}

/**
 * Moves reasoning out of the answer text of a model that writes it inline. Each reasoning run is
 * emitted as reasoning-start, reasoning-delta and reasoning-end parts, which the adapter already
 * maps to thinking. `bareClose` is set when reasoning was requested: the reply may then begin
 * with reasoning that ends at a bare `</think>`.
 */
export function reasoningTagMiddleware({ bareClose }: { bareClose: boolean }): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const splitter = new ThinkTagSplitter({ bareClose });
      const writer = new SegmentWriter();
      // The text block the held answer belongs to, for text released by a later part.
      let textId = 'text';
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              // Raw parts only observe the provider's chunks (the adapter asks for them so its
              // stream deadlines can count progress the parser drops). They carry no model
              // output, so they pass through without flushing the splitter's held text.
              if (part.type === 'raw') {
                controller.enqueue(part);
                return;
              }
              if (part.type === 'text-delta') {
                textId = part.id;
                writer.write({ controller, segments: splitter.push(part.delta), textId });
                return;
              }
              if (part.type === 'text-start') {
                controller.enqueue(part);
                return;
              }
              // The end of a text block or any other part ends the run: held text goes out before
              // it, inside its own block, so the stream stays well formed.
              writer.write({ controller, segments: splitter.flush(), textId });
              writer.closeReasoning({ controller });
              controller.enqueue(part);
            },
            flush(controller) {
              writer.write({ controller, segments: splitter.flush(), textId });
              writer.closeReasoning({ controller });
            },
          }),
        ),
      };
    },
  };
}
