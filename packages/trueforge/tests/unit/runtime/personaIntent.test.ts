import type { ILLM } from '@truefoundry/trueforge-core/core';
import type { Persona } from '../../../src/personas/persona';
import { classifyPersonaIntentWithLlm, isUnambiguousDirectPersonaInvocation } from '../../../src/runtime/personaIntent';

function persona(input: { id: string; displayName: string }): Persona {
  return {
    tenant_id: 'default',
    id: input.id,
    created_by: 'user-1',
    display_name: input.displayName,
    aliases: [],
    instructions: `Answer as ${input.displayName}.`,
    model_name: 'local/model',
    created_at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    updated_by: 'user-1',
  };
}

function llmReturning(raw: string, onRequest?: (request: Parameters<ILLM['createNonStream']>[0]) => void): ILLM {
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('persona intent classification does not stream');
    },
    createNonStream(request): ReturnType<ILLM['createNonStream']> {
      onRequest?.(request);
      return Promise.resolve({
        output: { role: 'assistant', content: raw },
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        finish_reason: 'stop',
      });
    },
  };
}

async function decision(input: { message: string; raw: string; personas: Persona[]; defaultAssistantName?: string }) {
  return (
    await classifyPersonaIntentWithLlm({
      message: input.message,
      currentPersona: undefined,
      defaultAssistantName: input.defaultAssistantName,
      personas: input.personas,
      llm: llmReturning(input.raw),
    })
  ).decision;
}

describe('persona intent host validation', () => {
  it('keeps compatibility-expanded identity offsets aligned with source text', () => {
    const ffi = persona({ id: 'ffi-id', displayName: 'ffi' });
    expect(
      isUnambiguousDirectPersonaInvocation({
        message: 'ﬃ,cancel.',
        persona: ffi,
        defaultAssistantName: 'Aman',
        personas: [ffi],
      }),
    ).toBe(false);

    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    expect(
      isUnambiguousDirectPersonaInvocation({
        message: '````\nZara, answer.\n````',
        persona: zara,
        defaultAssistantName: 'Aman',
        personas: [zara],
      }),
    ).toBe(false);
  });

  it('accepts a complete, unquoted request clause for the configured target', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = 'Could Zara answer this?';

    await expect(
      decision({
        message,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
  });

  it('rejects model-proposed selection from quoted or negated text', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const quotedMessage = 'The transcript says "Could Zara answer this?"';
    const quotedEvidence = 'Could Zara answer this?';
    const straightQuotedMessage = "The transcript says 'Could Zara answer this?' and I disagree.";
    const unterminatedQuotedMessages = [
      'The transcript says "Could Zara answer this? and I disagree.',
      "The transcript says 'Could Zara answer this? and I disagree.",
    ];
    const markdownQuotedMessages = [
      'Transcript:\n> Could Zara answer this?',
      'Transcript:\n~~~\nCould Zara answer this?\n~~~',
      'Transcript:\n````\nCould Zara answer this?\n````',
      'Transcript:\n``````\nCould Zara answer this?\n``````',
      'Transcript:\n```typescript\nCould Zara answer this?\n```',
      'Transcript:\n`````\nCould Zara answer this?',
      'Example: ``Could Zara answer this?``',
      'Transcript:\n- ~~~\n  Could Zara answer this?\n  ~~~',
      'Transcript:\n    Could Zara answer this?',
      'Transcript:\n\tCould Zara answer this?',
    ];
    const negatedMessage = "Don't switch to Zara.";

    await expect(
      decision({
        message: quotedMessage,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: quotedEvidence }),
      }),
    ).resolves.toBeUndefined();
    for (const message of unterminatedQuotedMessages) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }
    for (const message of markdownQuotedMessages) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      decision({
        message: straightQuotedMessage,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: straightQuotedMessage,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      decision({
        message: negatedMessage,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: negatedMessage }),
      }),
    ).resolves.toBeUndefined();

    const scopedStyle = 'Zara should answer, but not respond in detail.';
    await expect(
      decision({
        message: scopedStyle,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: scopedStyle }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
  });

  it('rejects truncated evidence that omits source-message negation', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = "Don't let Zara answer this.";

    await expect(
      decision({
        message,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Zara answer this' }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects exclusion and post-target negation in the complete source clause', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    for (const message of [
      'Please continue without switching to Zara.',
      'Anyone but Zara should answer.',
      'No switching to Zara.',
      'Stop Zara from answering.',
      'Please refrain from switching to Zara.',
      "I didn't ask Zara to answer.",
      "Zara isn't allowed to answer.",
      'Zara should not answer this.',
      "Zara, don't answer this.",
      'Zara, don’t answer this.',
    ]) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('uses the last explicit target clause when the user corrects the requested speaker', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const nova = persona({ id: 'nova-id', displayName: 'Nova' });
    const rejectedMessage = 'Could Zara answer this? Actually, not Zara.';

    await expect(
      decision({
        message: rejectedMessage,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer this?',
        }),
      }),
    ).resolves.toBeUndefined();

    const acceptedMessage = "Don't let Zara answer. Actually, Zara should answer.";
    await expect(
      decision({
        message: acceptedMessage,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Actually, Zara should answer.',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    for (const message of [
      'Use Zara. Actually, Nova should answer.',
      'Use Zara. Nova should answer instead.',
      'Use Zara. Actually, no.',
    ]) {
      await expect(
        decision({
          message,
          personas: [zara, nova],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Use Zara.' }),
        }),
      ).resolves.toBeUndefined();
    }

    const unrelatedNo = 'Use Zara. I have no other questions.';
    await expect(
      decision({
        message: unrelatedNo,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Use Zara.' }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
  });

  it('accepts positive contrasts while rejecting only the excluded identity', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const nova = persona({ id: 'nova-id', displayName: 'Nova' });
    const message = 'Could Zara, not Nova, answer this?';

    await expect(
      decision({
        message,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
    await expect(
      decision({
        message,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: nova.id, evidence: message }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects ambiguous targets and the source identity in an explicit switch', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const nova = persona({ id: 'nova-id', displayName: 'Nova' });
    const ambiguous = 'Could Zara or Nova answer?';
    for (const selected of [zara, nova]) {
      await expect(
        decision({
          message: ambiguous,
          personas: [zara, nova],
          raw: JSON.stringify({ action: 'select_persona', persona_id: selected.id, evidence: ambiguous }),
        }),
      ).resolves.toBeUndefined();
    }

    const directional = 'Switch from Zara to Nova.';
    await expect(
      decision({
        message: directional,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: directional }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      decision({
        message: directional,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: nova.id, evidence: directional }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: nova.id });
  });

  it('keeps punctuation inside a configured identity name within one source clause', async () => {
    const doctor = persona({ id: 'doctor-id', displayName: 'Dr. Who' });
    const message = 'Could Dr. Who answer this?';

    await expect(
      decision({
        message,
        personas: [doctor],
        raw: JSON.stringify({ action: 'select_persona', persona_id: doctor.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: doctor.id });

    const compatibilityMessage = 'Could Ｄｒ. Who answer this?';
    await expect(
      decision({
        message: compatibilityMessage,
        personas: [doctor],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: doctor.id,
          evidence: compatibilityMessage,
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: doctor.id });
  });

  it('keeps canonically equivalent decomposed names within one source clause', async () => {
    const doctor = persona({ id: 'doctor-id', displayName: 'Á.B' });
    const message = 'Could A\u0301.B answer this?';

    await expect(
      decision({
        message,
        personas: [doctor],
        raw: JSON.stringify({ action: 'select_persona', persona_id: doctor.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: doctor.id });
  });

  it('keeps contextual Unicode case folding aligned with configured identity keys', async () => {
    const doctor = persona({ id: 'doctor-id', displayName: 'ΟΣ. 123' });
    const message = 'Can I speak to ΟΣ. 123?';

    await expect(
      decision({
        message,
        personas: [doctor],
        raw: JSON.stringify({ action: 'select_persona', persona_id: doctor.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: doctor.id });
  });

  it('rejects persona requests copied from international quotation marks', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    for (const message of [
      'The transcript says «Could Zara answer this?»',
      'The transcript says ‹Could Zara answer this?›',
      'The transcript says 「Could Zara answer this?」',
      'The transcript says 『Could Zara answer this?』',
      'The transcript says „Could Zara answer this?“',
      'The transcript says ‚Could Zara answer this?‘',
      'The transcript says ＂Could Zara answer this?＂',
      'The transcript says «Could Zara answer this?',
      'Transcript:\n「\nCould Zara answer this?\n」',
      'The transcript says: Could Zara answer this?',
    ]) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('allows a request after a completed international quotation', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = '„Nothing relevant“; Could Zara answer?';

    await expect(
      decision({
        message,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: ' Could Zara answer?' }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const completedStraightQuoteBeforeLaterPossessive = "'Nothing.' Zara, answer. Chris' notes can wait.";
    await expect(
      decision({
        message: completedStraightQuoteBeforeLaterPossessive,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: ' Zara, answer.',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
  });

  it('rejects separate requests for different personas as ambiguous', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const nova = persona({ id: 'nova-id', displayName: 'Nova' });
    const message = 'Could Zara answer? Could Nova answer?';

    for (const selected of [zara, nova]) {
      await expect(
        decision({
          message,
          personas: [zara, nova],
          raw: JSON.stringify({
            action: 'select_persona',
            persona_id: selected.id,
            evidence: selected === zara ? 'Could Zara answer?' : ' Could Nova answer?',
          }),
        }),
      ).resolves.toBeUndefined();
    }

    const mentionedOnly = 'Could Zara answer? What did Nova say yesterday?';
    await expect(
      decision({
        message: mentionedOnly,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const sameClauseMentionedOnly = 'Zara, tell me what Inez said.';
    const inez = persona({ id: 'inez-id', displayName: 'Inez' });
    await expect(
      decision({
        message: sameClauseMentionedOnly,
        personas: [zara, inez],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: sameClauseMentionedOnly,
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const declarativeCapability = 'Zara can answer questions about finance.';
    await expect(
      decision({
        message: declarativeCapability,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: declarativeCapability }),
      }),
    ).resolves.toBeUndefined();

    const modalRequest = 'Can Zara answer this?';
    await expect(
      decision({
        message: modalRequest,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: modalRequest }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const correctionWordInTopic = 'Could Zara answer? I would rather discuss Nova today.';
    await expect(
      decision({
        message: correctionWordInTopic,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    for (const message of ['Zara, could Inez answer too?', 'Zara, Inez, answer directly.']) {
      await expect(
        decision({
          message,
          personas: [zara, inez],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }

    const correctedRequest = 'Could Zara answer? I would rather have Nova answer.';
    await expect(
      decision({
        message: correctedRequest,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Could Zara answer?' }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      decision({
        message: correctedRequest,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: nova.id,
          evidence: ' I would rather have Nova answer.',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: nova.id });

    const preferenceRequest = "Could Zara answer? I'd like Nova to answer.";
    await expect(
      decision({
        message: preferenceRequest,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Could Zara answer?' }),
      }),
    ).resolves.toBeUndefined();

    const hearFromRequest = 'Could Zara answer? I would like to hear from Nova.';
    await expect(
      decision({
        message: hearFromRequest,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Could Zara answer?' }),
      }),
    ).resolves.toBeUndefined();

    const sameClausePreference = "Zara, I'd like Nova to answer instead.";
    await expect(
      decision({
        message: sameClausePreference,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: sameClausePreference }),
      }),
    ).resolves.toBeUndefined();

    for (const message of ['Zara, make Nova answer instead.', 'Could Zara answer? I would rather hear from Nova.']) {
      await expect(
        decision({
          message,
          personas: [zara, nova],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }

    const laterSubject = "Zara, I'd like Nova to be the subject.";
    await expect(
      decision({
        message: laterSubject,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: laterSubject }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const reportedSpeech = 'Zara, tell me what Inez would say.';
    await expect(
      decision({
        message: reportedSpeech,
        personas: [zara, inez],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: reportedSpeech }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const reportedAnswer = 'Zara, tell me how Inez would answer.';
    await expect(
      decision({
        message: reportedAnswer,
        personas: [zara, inez],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: reportedAnswer }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const delegatedCorrection = 'Zara, get Nova to answer instead.';
    await expect(
      decision({
        message: delegatedCorrection,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: delegatedCorrection }),
      }),
    ).resolves.toBeUndefined();

    const codeBeforeRequest = '````\nNothing relevant\n````\nCould Zara answer?';
    await expect(
      decision({
        message: codeBeforeRequest,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const possessiveMention = "Could Zara answer? I want Nova's notes.";
    await expect(
      decision({
        message: possessiveMention,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });

    const alternateVerb = 'Could Zara answer? Could Nova handle this?';
    await expect(
      decision({
        message: alternateVerb,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toBeUndefined();

    const imperative = 'Could Zara answer? Ask Nova to handle this.';
    await expect(
      decision({
        message: imperative,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toBeUndefined();

    const multiTokenLead = 'Could Zara answer? Speak to Nova.';
    await expect(
      decision({
        message: multiTokenLead,
        personas: [zara, nova],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Could Zara answer?',
        }),
      }),
    ).resolves.toBeUndefined();

    const alternateImperativeLead = 'Ask Zara; choose Nova.';
    await expect(
      decision({
        message: alternateImperativeLead,
        personas: [zara, nova],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: 'Ask Zara;' }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a request-shaped clause inside a multiline quotation', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    for (const message of [
      'Transcript:\n"\nCould Zara answer this?\n"',
      "Transcript:\n'\nCould Zara answer this?\n'",
    ]) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({
            action: 'select_persona',
            persona_id: zara.id,
            evidence: 'Could Zara answer this?',
          }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('does not treat a possessive apostrophe as a quotation opener', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = "James' request: Could Zara answer this?";

    await expect(
      decision({
        message,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
  });

  it('does not close a straight quotation at an apostrophe inside a contraction', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = "Here is text: 'I'd like Zara to answer.'";

    await expect(
      decision({
        message,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
      }),
    ).resolves.toBeUndefined();

    const curlyMessage = 'Here is text: ‘I’d like Zara to answer.’';
    await expect(
      decision({
        message: curlyMessage,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: curlyMessage }),
      }),
    ).resolves.toBeUndefined();

    const possessiveCurlyMessage = 'Here is text: ‘James’ request says Zara should answer.’';
    await expect(
      decision({
        message: possessiveCurlyMessage,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: possessiveCurlyMessage,
        }),
      }),
    ).resolves.toBeUndefined();

    const separateQuotes = "'Nothing' and 'Could Zara answer?'";
    await expect(
      decision({
        message: separateQuotes,
        personas: [zara],
        raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: separateQuotes }),
      }),
    ).resolves.toBeUndefined();

    const quotedRequestBeforeOutsidePossessive = "'James' request: Zara answer.' Chris' notes.";
    await expect(
      decision({
        message: quotedRequestBeforeOutsidePossessive,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Zara answer.',
        }),
      }),
    ).resolves.toBeUndefined();

    const possessiveInsideQuoteWithoutTerminalPunctuation = "'James' request says Zara should answer', then continue.";
    await expect(
      decision({
        message: possessiveInsideQuoteWithoutTerminalPunctuation,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Zara should answer',
        }),
      }),
    ).resolves.toBeUndefined();

    const ambiguousPossessiveInsideQuotedNounPhrase = "'James' request names Zara' is quoted.";
    await expect(
      decision({
        message: ambiguousPossessiveInsideQuotedNounPhrase,
        personas: [zara],
        raw: JSON.stringify({
          action: 'select_persona',
          persona_id: zara.id,
          evidence: 'Zara',
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('distinguishes response constraints from cancellation after direct address', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    for (const message of [
      'Zara, no introduction please; answer directly.',
      'Zara, no citations; keep it concise.',
      'Zara, stop using lengthy preambles.',
      'Zara, never mind the preamble; answer directly.',
      'Zara, explain `never mind`.',
      'Zara, no `citations`; answer directly.',
    ]) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toMatchObject({ action: 'select_persona', persona_id: zara.id });
    }

    for (const message of [
      'Zara, no.',
      'Zara, no, never mind.',
      'Zara, never mind that.',
      'Zara, never mind, thank you.',
      'Zara, scratch that.',
      'Zara, cancel, please.',
      'Zara, cancel that request.',
      'Zara, cancel the switch.',
    ]) {
      await expect(
        decision({
          message,
          personas: [zara],
          raw: JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects a shorter identity that overlaps a longer configured name', async () => {
    const ann = persona({ id: 'ann-id', displayName: 'Ann' });
    const annMarie = persona({ id: 'ann-marie-id', displayName: 'Ann Marie' });
    const message = 'Could Ann Marie answer this?';

    await expect(
      decision({
        message,
        personas: [ann, annMarie],
        raw: JSON.stringify({ action: 'select_persona', persona_id: ann.id, evidence: message }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      decision({
        message,
        personas: [ann, annMarie],
        raw: JSON.stringify({ action: 'select_persona', persona_id: annMarie.id, evidence: message }),
      }),
    ).resolves.toMatchObject({ action: 'select_persona', persona_id: annMarie.id });
  });

  it('uses only standard request fields unless non-thinking support is advertised', async () => {
    const zara = persona({ id: 'zara-id', displayName: 'Zara' });
    const message = 'Could Zara answer this?';
    let captured: Parameters<ILLM['createNonStream']>[0] | undefined;

    await classifyPersonaIntentWithLlm({
      message,
      currentPersona: undefined,
      defaultAssistantName: 'Mannie',
      personas: [zara],
      llm: llmReturning(
        JSON.stringify({ action: 'select_persona', persona_id: zara.id, evidence: message }),
        request => {
          captured = request;
        },
      ),
    });

    if (captured === undefined) {
      throw new Error('persona preflight request was not captured');
    }
    expect(captured.response_format).toBeUndefined();
    expect(Reflect.get(captured, 'enable_thinking')).toBeUndefined();
    expect(Reflect.get(captured, 'reasoning_effort')).toBeUndefined();
  });
});
