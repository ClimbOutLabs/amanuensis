import { pageSummary, parseMemoryPage } from '../../../../src/runtime/memory/memoryPages';

function pageOf(body: string) {
  return parseMemoryPage({
    content: `---\nkind: person\ntitle: Wendy\n---\n# Wendy\n${body}`,
    fallback: { kind: 'person', title: 'Wendy' },
  });
}

const OWN = '<!-- fact: id=f_01 src=you_said since=2026-01-01 -->';
const MAIL = '<!-- fact: id=f_02 src=mail since=2026-01-01 -->';

describe('pageSummary', () => {
  it('is the line under the title when there is one', () => {
    const page = pageOf(`\nThe owner's wife.\n\n## Now\n- Likes tea. ${OWN}\n`);
    expect(pageSummary(page)).toBe("The owner's wife.");
  });

  it('is the first own statement under Now when there is no line under the title', () => {
    const page = pageOf(`\n## Now\n- Likes tea. ${OWN}\n- Likes jam.\n`);
    expect(pageSummary(page)).toBe('Likes tea.');
  });

  it('counts a bullet the person typed by hand', () => {
    expect(pageSummary(pageOf('\n## Now\n- Typed by hand\n'))).toBe('Typed by hand');
  });

  it('never takes a statement that was read', () => {
    const page = pageOf(`\n## Now\n- Booked a table. ${MAIL}\n\n## Unconfirmed\n- Maybe a cat. ${OWN}\n`);
    expect(pageSummary(page)).toBeUndefined();
    const later = pageOf(`\n## Now\n- Booked a table. ${MAIL}\n- Likes tea. ${OWN}\n`);
    expect(pageSummary(later)).toBe('Likes tea.');
  });

  it('is undefined for a page with no summary and no own statement', () => {
    expect(pageSummary(pageOf(''))).toBeUndefined();
  });
});
