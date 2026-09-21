import { decideMemoryRoute } from '../../../../src/runtime/memory/memoryRouting';

describe('decideMemoryRoute', () => {
  it.each([
    'How much tax did I pay in 2025',
    'Try again',
    'What is the name of my bike?',
    'When did I last service the car',
    'Who is my accountant',
    'Did I pay the invoice from Acme',
    // One factual counterexample per synthesis keyword, so the keyword alone never routes.
    'What recommendations did my doctor make?',
    'When was the briefing?',
    'Where is the assessment report from the audit',
    'Is the summary email from Acme in my inbox',
    'Did I compare prices last year',
    'Who evaluated the vendor bids',
    'What did the overview slide say',
    'Which analyst wrote the recap',
  ])('keeps a factual lookup on recall: %s', message => {
    expect(decideMemoryRoute(message)).toEqual({ route: 'recall' });
  });

  it.each([
    'Summarize what we know about my taxes',
    'Give me a summary of the Acme project',
    'Send me a quick recap of the week',
    'Brief me on the bike situation',
    'What should I do about the overdue invoice?',
    'What do you recommend for the tax filing',
    'Could you suggest a plan for the audit',
    'Your take on the vendor bids?',
    'Compare my 2024 and 2025 tax bills',
    'Evaluate whether the GPU server is oversubscribed',
    'What have we learned about the GPU server',
    'What do we know about Acme',
    'How am I doing on the training plan',
    'Assess my readiness for the audit',
  ])('routes a synthesis-shaped ask to reflect: %s', message => {
    const decision = decideMemoryRoute(message);
    expect(decision.route).toBe('reflect');
    expect(typeof decision.matched).toBe('string');
  });

  it('records which pattern fired so the event can explain the route', () => {
    expect(decideMemoryRoute('please summarize this')).toEqual({ route: 'reflect', matched: '\\bsummari[sz]e\\b' });
  });

  it('is recall when there is no user message', () => {
    expect(decideMemoryRoute(undefined)).toEqual({ route: 'recall' });
  });
});
