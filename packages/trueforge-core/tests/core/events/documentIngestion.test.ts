import { DocumentIngestionEventSchema, EventType } from '../../../src/core/events/schema';

function baseEvent() {
  return {
    type: EventType.DOCUMENT_INGESTION,
    id: 'event-1',
    created_at: '2026-09-12T12:00:00.000Z',
    thread_id: 'main',
    file_name: 'report.pdf',
    staged_path: '/tmp/uploads/attachment-01-abc-report.pdf',
  };
}

describe('DocumentIngestionEventSchema', () => {
  it('parses a started event with no result fields', () => {
    const event = DocumentIngestionEventSchema.parse({ ...baseEvent(), phase: 'started' });
    expect(event.phase).toBe('started');
    expect(event.method).toBeUndefined();
    expect(event.page_count).toBeUndefined();
    expect(event.issue).toBeUndefined();
    expect(event.elapsed_ms).toBeUndefined();
  });

  it('parses a finished event carrying method, page count and elapsed time', () => {
    const event = DocumentIngestionEventSchema.parse({
      ...baseEvent(),
      phase: 'finished',
      method: 'native text',
      page_count: 3,
      elapsed_ms: 1234,
    });
    expect(event.method).toBe('native text');
    expect(event.page_count).toBe(3);
    expect(event.elapsed_ms).toBe(1234);
  });

  it('parses a failed event carrying an issue', () => {
    const event = DocumentIngestionEventSchema.parse({
      ...baseEvent(),
      phase: 'failed',
      issue: 'Could not extract report.pdf: OCR pipeline unavailable',
      elapsed_ms: 42,
    });
    expect(event.issue).toContain('OCR pipeline unavailable');
  });

  it('parses a cancelled event with no result fields', () => {
    const event = DocumentIngestionEventSchema.parse({ ...baseEvent(), phase: 'cancelled' });
    expect(event.phase).toBe('cancelled');
  });

  it('rejects an unknown phase', () => {
    expect(() => DocumentIngestionEventSchema.parse({ ...baseEvent(), phase: 'running' })).toThrow();
  });

  it('rejects a negative elapsed_ms', () => {
    expect(() => DocumentIngestionEventSchema.parse({ ...baseEvent(), phase: 'finished', elapsed_ms: -1 })).toThrow();
  });

  it('requires thread_id, unlike the run-scoped sandbox.created event', () => {
    const { thread_id: _threadId, ...withoutThreadId } = { ...baseEvent(), phase: 'started' };
    expect(() => DocumentIngestionEventSchema.parse(withoutThreadId)).toThrow();
  });
});
