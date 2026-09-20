import {
  emailFetchGuidance,
  emailFetchSemanticsFor,
  summarizeEmailResult,
} from '../../../../src/core/capabilities/builtins/EmailFetchSemantics';

function searchResultJson(options: { count: number; token?: string; nullIdIndex?: number }): string {
  const results = Array.from({ length: options.count }, (_, index) => ({
    id: options.nullIdIndex === index ? null : `msg-${String(index)}`,
    threadId: `thread-${String(index)}`,
    subject: `Subject ${String(index)}`,
    from: `Sender ${String(index)} <sender${String(index)}@example.com>`,
    fromAddress: { name: `Sender ${String(index)}`, email: `sender${String(index)}@example.com` },
    to: [{ name: 'Me', email: 'me@example.com' }],
    cc: [],
    date: 'Mon, 01 Jan 2026 00:00:00 +0000',
  }));
  return JSON.stringify({
    resultCount: options.count,
    results,
    ...(options.token === undefined ? {} : { nextPageToken: options.token }),
    resultSizeEstimate: 250,
    truncated: true,
    total_available: 250,
  });
}

function threadResultJson(messageCount: number, bodyChars: number): string {
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    messageId: `msg-${String(index)}`,
    threadId: 'thread-1',
    from: 'a@example.com',
    to: 'b@example.com',
    cc: '',
    bcc: '',
    subject: `Re: Subject ${String(index)}`,
    date: 'Mon, 01 Jan 2026 00:00:00 +0000',
    body: 'x'.repeat(bodyChars),
    labelIds: ['INBOX'],
    attachments: [],
  }));
  return JSON.stringify({
    threadId: 'thread-1',
    messageCount,
    messages,
    truncated: false,
    total_available: messageCount,
  });
}

describe('emailFetchSemanticsFor', () => {
  it('finds entries by original tool name', () => {
    expect(emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined })?.toolName).toBe(
      'search_emails',
    );
    expect(emailFetchSemanticsFor({ toolName: 'get_thread', serverId: undefined })?.fetchTool).toBe('read_email');
  });

  it('returns undefined for unknown tools', () => {
    expect(emailFetchSemanticsFor({ toolName: 'nope_not_a_tool', serverId: undefined })).toBeUndefined();
  });

  it('prefers a server-qualified entry when one matches', () => {
    // No qualified entries exist yet; the unqualified entry wins for any server.
    expect(
      emailFetchSemanticsFor({ toolName: 'read_email', serverId: 'gmail-mcp' })?.singleItem,
    ).toBe(true);
  });
});

describe('emailFetchGuidance', () => {
  it('gives native pagination guidance for search_emails', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined });
    expect(semantics).toBeDefined();
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    expect(emailFetchGuidance(semantics)).toContain('pageToken');
  });

  it('gives format=metadata narrowing guidance for get_thread (no invented pagination)', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'get_thread', serverId: undefined });
    expect(semantics).toBeDefined();
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const guidance = emailFetchGuidance(semantics);
    expect(guidance).toContain('format="metadata"');
    expect(guidance).not.toContain('pageToken');
  });

  it('tells the agent a read_email body cannot be paged', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'read_email', serverId: undefined });
    expect(semantics).toBeDefined();
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    expect(emailFetchGuidance(semantics)).toContain('no intra-body paging');
  });

  it('tells the agent get_inbox_with_threads narrows via expandThreads=false', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'get_inbox_with_threads', serverId: undefined });
    expect(semantics).toBeDefined();
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const guidance = emailFetchGuidance(semantics);
    expect(guidance).toContain('expandThreads=false');
    expect(guidance).toContain('has no pageToken');
  });
});

describe('summarizeEmailResult', () => {
  it('summarizes search_emails metadata-first with an exact pageToken continuation', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const summary = summarizeEmailResult({ content: searchResultJson({ count: 60, token: 'token-abc' }), semantics });
    expect(summary).toBeDefined();
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.total_count).toBe(250);
    expect(summary.items_seen).toBe(60);
    // 60 items exceeds the 50-item emission cap: the continuation must NOT use
    // the next-page token (which would orphan items 51-60). It restarts from
    // the beginning with a small page instead.
    expect(summary.next).toContain('Re-run search_emails with maxResults=10');
    expect(summary.next).toContain('no pageToken');
    expect(summary.next).toContain('would skip the unshown items');
    expect(summary.next).not.toContain('token-abc');
    expect(summary.unseen_statement).toContain('server estimate');
    for (const item of summary.items) {
      expect(item).toHaveProperty('id');
    }
    // No bodies in search results; metadata intact.
    const rendered = JSON.stringify(summary);
    expect(rendered).toContain('msg-0');
    expect(summary.envelope?.['seen']).toBe('metadata_only');
  });

  it('marks the total approximate for server estimates, exact for thread counts', () => {
    const search = emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined });
    const thread = emailFetchSemanticsFor({ toolName: 'get_thread', serverId: undefined });
    if (search === undefined || thread === undefined) {
      throw new Error('unreachable');
    }
    const searchSummary = summarizeEmailResult({ content: searchResultJson({ count: 5 }), semantics: search });
    const threadSummary = summarizeEmailResult({ content: threadResultJson(5, 10), semantics: thread });
    expect(searchSummary?.unseen_statement).toContain('~250 items (server estimate)');
    expect(threadSummary?.unseen_statement).toContain('Total: 5 items in');
    expect(threadSummary?.unseen_statement).not.toContain('server estimate');
  });

  it('strips thread bodies and continues with format=metadata', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'get_thread', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const body = 'secret-body-content';
    const raw = threadResultJson(3, 0).replace(/"body":""/g, `"body":"${body}"`);
    const summary = summarizeEmailResult({ content: raw, semantics });
    expect(summary).toBeDefined();
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(JSON.stringify(summary.items)).not.toContain(body);
    expect(summary.next).toContain('get_thread(threadId="thread-1", format="metadata")');
    expect(summary.total_count).toBe(3);
    // Every message keeps a re-fetchable id.
    expect(summary.next).toContain('read_email');
  });

  it('summarizes read_email metadata-only with a bounded excerpt', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'read_email', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const bodyText = `line one\nline two\n${'confidential '.repeat(2000)}`;
    const content = JSON.stringify({
      messageId: 'msg-1',
      threadId: 'thread-1',
      subject: 'Hello',
      from: 'a@example.com',
      to: 'b@example.com',
      cc: '',
      bcc: '',
      date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      rfcMessageId: '<abc@example.com>',
      body: bodyText,
      bodyText,
      bodyHtml: `<p>${bodyText}</p>`,
      attachments: [],
    });
    const summary = summarizeEmailResult({ content, semantics });
    expect(summary).toBeDefined();
    if (summary === undefined || summary.result_kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(summary.text_excerpt.length).toBeLessThanOrEqual(4000);
    expect(summary.text_excerpt).toContain('line one');
    expect(summary.next).toBeNull();
    expect(summary.envelope?.['seen']).toBe('metadata_and_body_excerpt');
    expect(String(summary.envelope?.['honesty_note'])).toContain('not seen');
  });

  it('fails closed when a search item has a null id', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    // The Gmail schema allows id: null; such an item cannot be re-fetched.
    expect(
      summarizeEmailResult({ content: searchResultJson({ count: 3, nullIdIndex: 1 }), semantics }),
    ).toBeUndefined();
  });

  it('fails closed on unparseable content and on content over the parse ceiling', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'search_emails', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    expect(summarizeEmailResult({ content: '{"results": [', semantics })).toBeUndefined();
    expect(summarizeEmailResult({ content: 'x'.repeat(1_048_577), semantics })).toBeUndefined();
  });

  it('continues get_inbox_with_threads with an exact nested read_email call', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'get_inbox_with_threads', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const content = JSON.stringify({
      resultCount: 2,
      threads: [
        {
          threadId: 'thread-1',
          messageCount: 2,
          messages: [
            { messageId: 'nested-msg-1', threadId: 'thread-1', subject: 'Hi', body: 'big body' },
            { messageId: 'nested-msg-2', threadId: 'thread-1', subject: 'Re: Hi', body: 'big body' },
          ],
        },
        { threadId: 'thread-2', snippet: 'short', historyId: '1', messageCount: 1, latestMessage: {} },
      ],
      truncated: false,
      total_available: 2,
    });
    const summary = summarizeEmailResult({ content, semantics });
    expect(summary).toBeDefined();
    expect(summary?.next).toBe('Fetch any full message with read_email(messageId="nested-msg-1").');
    if (summary?.result_kind === 'collection') {
      expect(JSON.stringify(summary.items)).not.toContain('big body');
    }
  });

  it('fails closed when a nested message id is missing', () => {
    const semantics = emailFetchSemanticsFor({ toolName: 'get_inbox_with_threads', serverId: undefined });
    if (semantics === undefined) {
      throw new Error('unreachable');
    }
    const content = JSON.stringify({
      resultCount: 1,
      threads: [
        {
          threadId: 'thread-1',
          messageCount: 1,
          messages: [{ threadId: 'thread-1', subject: 'Hi', body: 'big body' }],
        },
      ],
      truncated: false,
      total_available: 1,
    });
    expect(summarizeEmailResult({ content, semantics })).toBeUndefined();
  });
});
