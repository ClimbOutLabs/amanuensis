import { chatTitleContext } from '../../../../src/runtime/memory/chatTitleContext';
import { formatRetainEntry } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { buildRetainItem } from '../../../../src/runtime/memory/memoryRetain';

describe('chatTitleContext', () => {
  it('labels an ordinary title', () => {
    expect(chatTitleContext({ title: ' Trip planning ', assistantNames: ['Zara'] })).toBe('Chat title: Trip planning');
  });

  it('omits a title equal to the assistant name', () => {
    expect(chatTitleContext({ title: 'Zara', assistantNames: ['Zara'] })).toBeUndefined();
  });

  it('matches case-insensitively and by substring', () => {
    expect(chatTitleContext({ title: 'hey ZARA, hi', assistantNames: ['zara'] })).toBeUndefined();
    expect(
      chatTitleContext({ title: 'Milo', assistantNames: [null, undefined, '  ', 'Zara', 'milo'] }),
    ).toBeUndefined();
  });

  it('matches whole words only and escapes regex metacharacters', () => {
    expect(chatTitleContext({ title: 'Alpine hikes', assistantNames: ['Al'] })).toBe('Chat title: Alpine hikes');
    expect(chatTitleContext({ title: 'Chat with A.I. (beta)', assistantNames: ['A.I. (beta)'] })).toBeUndefined();
    expect(chatTitleContext({ title: 'AxI', assistantNames: ['A.I'] })).toBe('Chat title: AxI');
  });

  it('omits a title equal to another persona name or alias', () => {
    expect(chatTitleContext({ title: 'Zara', assistantNames: ['Milo', 'Zara', 'Z'] })).toBeUndefined();
    expect(chatTitleContext({ title: 'Z', assistantNames: ['Milo', 'Zara', 'Z'] })).toBeUndefined();
  });

  it('collapses multi-line titles into one quoted line', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
      sessionTitle: chatTitleContext({ title: 'Trip\n\n  planning\r\n> x', assistantNames: [] }),
    });
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(formatRetainEntry(item).split('\n').at(-1)).toBe('> Chat title: Trip planning > x');
  });

  it('ignores blank assistant names and empty titles', () => {
    expect(chatTitleContext({ title: 'Plans', assistantNames: ['', null] })).toBe('Chat title: Plans');
    expect(chatTitleContext({ title: '  ', assistantNames: [] })).toBeUndefined();
    expect(chatTitleContext({ title: undefined, assistantNames: [] })).toBeUndefined();
  });

  it('keeps a persona-named chat title out of the retained summary item', () => {
    const base = {
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
      summarizedContent: 'Discussed travel plans.',
    };
    const personaNamed = buildRetainItem({
      ...base,
      sessionTitle: chatTitleContext({ title: 'Zara', assistantNames: ['Zara'] }),
    });
    expect(personaNamed?.content).toBe('Turn summary: Discussed travel plans.');
    expect(personaNamed?.context).toBeUndefined();

    const normal = buildRetainItem({
      ...base,
      sessionTitle: chatTitleContext({ title: 'Trip planning', assistantNames: ['Zara'] }),
    });
    expect(normal?.context).toBe('Chat title: Trip planning');
  });
});
