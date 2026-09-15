import { mascotActionFor } from '@/atoms/MascotAnimator.js';
import { describe, expect, it } from 'vitest';

describe('mascotActionFor', () => {
  const baseState = {
    composerHasText: false,
    isThreadRunning: false,
    composerBusy: false,
    pauseView: 'compose' as const,
    messageParts: [],
  };

  // 1. Idle - slow breathing
  it('should return idle when nothing is running and no composer text', () => {
    const action = mascotActionFor(baseState);
    expect(action).toBe('idle');
  });

  // 2. Listening - lean with ear twitch
  it('should return listening when composer has text and nothing is running', () => {
    const action = mascotActionFor({
      ...baseState,
      composerHasText: true,
    });
    expect(action).toBe('listening');
  });

  it('should return idle when composer is busy even with text', () => {
    const action = mascotActionFor({
      ...baseState,
      composerHasText: true,
      composerBusy: true,
    });
    expect(action).toBe('idle');
  });

  // 3. Thinking - head tilt with dots
  it('should return thinking when thread is running without specific tool', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [],
    });
    expect(action).toBe('thinking');
  });

  // 4. Reading - page turn with nod
  it('should return reading when read_file tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'read_file',
        },
      ],
    });
    expect(action).toBe('reading');
  });

  it('should return reading when web_fetch tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'web_fetch',
        },
      ],
    });
    expect(action).toBe('reading');
  });

  it('should return reading when extract_document_text tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'extract_document_text',
        },
      ],
    });
    expect(action).toBe('reading');
  });

  it('should return reading when document.ingestion tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'document.ingestion',
        },
      ],
    });
    expect(action).toBe('reading');
  });

  // 5. Searching - magnifier sweep with lean
  it('should return searching when web_search tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'web_search',
        },
      ],
    });
    expect(action).toBe('searching');
  });

  // 6. Working - busy bob with sparkle
  it('should return working when exec tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'bash_exec',
        },
      ],
    });
    expect(action).toBe('working');
  });

  it('should return working when edit tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'file_edit',
        },
      ],
    });
    expect(action).toBe('working');
  });

  it('should return working when bash tool is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'bash',
        },
      ],
    });
    expect(action).toBe('working');
  });

  // 7. Waiting - blink
  it('should return waiting when pause view is mcp', () => {
    const action = mascotActionFor({
      ...baseState,
      pauseView: 'mcp',
    });
    expect(action).toBe('waiting');
  });

  it('should return waiting when pause view is ask-user', () => {
    const action = mascotActionFor({
      ...baseState,
      pauseView: 'ask-user',
    });
    expect(action).toBe('waiting');
  });

  // Priority: pause view takes precedence over running state
  it('should return waiting when pause view is mcp even if thread is running', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      pauseView: 'mcp',
    });
    expect(action).toBe('waiting');
  });

  // Tool name variations
  it('should recognize file_read as working', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'file_read',
        },
      ],
    });
    expect(action).toBe('working');
  });

  it('should recognize sh as working', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'sh',
        },
      ],
    });
    expect(action).toBe('working');
  });

  // Multiple tool calls - use the last one
  it('should use the last tool call when multiple are present', () => {
    const action = mascotActionFor({
      ...baseState,
      isThreadRunning: true,
      messageParts: [
        {
          type: 'tool-call',
          toolName: 'bash',
        },
        {
          type: 'tool-call',
          toolName: 'web_search',
        },
      ],
    });
    expect(action).toBe('searching');
  });
});
