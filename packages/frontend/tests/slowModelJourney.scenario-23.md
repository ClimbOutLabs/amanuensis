# Journey scenario 23, for the coordinator to take

This file is not part of the test suite on this branch. It is the text of one new scenario for
`packages/frontend/tests/slowModelJourney.journey.ts` on the branch `test/slow-model-journey`:
append the code block below at the end of that file, after scenario 22. It uses only helpers that
file already defines (`personalPage`, `openHome`, `openChat`, `send`, `sessionIdOf`,
`assistantReplies`, `waitForReplyText`, `waitForIdle`, `until`, `pause`, `stopButton`,
`agentDetailsToggle`, `agentDetailsAreOn`, `isShorteningCall`, `search`, `readPage`,
`firstResultUrl`, `searchResults`, `FINAL_TEXT`, `SLOW`, `configuration`, `api`).

Why it exists: scenario 22 checks that earlier turns stay folded while a long turn runs, but its
long turn never shortens the history. The report behind this scenario is that earlier turns show
their steps on long turns when agent details are off, and the standing hypothesis was that the
history shortening (compaction) rebuilds the earlier turns unfolded. A unit test on this branch
(`packages/trueforge-core/tests/agent-session/compactionKeepsEarlierTurnEvents.test.ts`) drives
the real shortening inside a later turn and proves the earlier turn's served events and stored
state do not change at all, so the rebuilding, if it happens, lives in the live browser layer this
scenario exercises. This scenario is scenario 22 with the shortening forced on, the same switch
scenario 9 uses (`CONTEXT_COMPACTION_THRESHOLD_TOKENS = 200`), plus a check that a shortening
really happened so it cannot pass without one.

```ts
journey(
  '23. agent details off: earlier turns stay folded while a long turn shortens the history, and after a reload',
  SCENARIO_LIMIT_MS,
  async () => {
    const page = await personalPage();
    api.model.setPlanner(exchange => {
      if (exchange.message.includes('harbour lights')) {
        if (exchange.toolResults.length === 0) return search('harbour lights');
        if (exchange.toolResults.length === 1) return readPage(firstResultUrl(exchange.toolResults[0]));
      }
      if (exchange.message.includes('lighthouse keepers')) {
        if (exchange.toolResults.length < 5) return search(`lighthouse keepers ${String(exchange.toolResults.length)}`);
      }
      return undefined;
    });
    api.mcp.setSearchResults(searchResults);
    const originalThreshold = configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS;
    try {
      await openHome(page);
      await send(page, 'Tell me about harbour lights');
      await page.waitForURL(/\/sessions\//, { timeout: UI_LIMIT_MS });
      const sessionId = sessionIdOf(page);
      await waitForReplyText(page, 'the first reply', 1);
      await waitForIdle(page, 'the first reply');

      const toggle = agentDetailsToggle(page);
      assert.equal(await agentDetailsAreOn(toggle), false, 'agent details are off in this chat');
      const folded = async (label: string): Promise<void> => {
        assert.equal(
          await page.getByTestId('assistant-message-agent-internals').count(),
          0,
          `${label}: a turn shows its steps while agent details are off`,
        );
        assert.ok(
          (await assistantReplies(page).getByText(FINAL_TEXT).count()) >= 1,
          `${label}: the first reply's answer is still showing`,
        );
      };
      await folded('after the first turn');

      // A second, long turn, with the shortening threshold dropped so the history is shortened
      // inside it, as happens on a long real conversation.
      configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS = 200;
      const callsBefore = api.model.calls().length;
      api.model.setPacing(SLOW);
      await send(page, 'Now tell me about lighthouse keepers');
      await until('the second turn running (Cancel showing)', UI_LIMIT_MS, async () => stopButton(page).isVisible());
      // Wait until this turn has really shortened the history at least once, checking the fold
      // while the turn is still running.
      await until('the history shortened during the second turn', UI_LIMIT_MS, async () => {
        await folded('while the second turn runs, before the shortening');
        return api.model
          .calls()
          .slice(callsBefore)
          .some(call => isShorteningCall(call));
      });
      await folded('while the second turn runs, after the shortening');

      // A reload mid-turn re-reads the chat from the server; every turn must stay folded.
      await openChat(page, sessionId);
      await until('the second turn still running after the reload', UI_LIMIT_MS, async () =>
        stopButton(page).isVisible(),
      );
      await folded('after a reload mid-turn, with the history shortened');

      await stopButton(page).click();
      await waitForIdle(page, 'the second reply stopped');
      await folded('after the second turn stopped');
    } finally {
      configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS = originalThreshold;
      api.model.setPlanner(undefined);
      api.mcp.setSearchResults(undefined);
      api.model.setPacing(undefined);
    }
  },
);
```
