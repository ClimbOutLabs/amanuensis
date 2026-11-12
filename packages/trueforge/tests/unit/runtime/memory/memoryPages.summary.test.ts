import {
  pageDescription,
  pageSummary,
  parseMemoryPage,
  renderMemoryPage,
  withPageAbout,
} from '../../../../src/runtime/memory/memoryPages';

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

describe('the line Aman writes on what a page covers', () => {
  it('is kept in the settings block and leaves every other byte as it was', () => {
    const page = pageOf(`\n## Now\n- Likes tea. ${OWN}\n`);
    const described = withPageAbout(page, 'Wife. Read when planning: weekends, gifts.');
    expect(renderMemoryPage(described)).toBe(
      renderMemoryPage(page).replace(
        'title: Wendy\n---',
        'title: Wendy\nabout: "Wife. Read when planning: weekends, gifts."\n---',
      ),
    );
    const read = parseMemoryPage({ content: renderMemoryPage(described), fallback: { kind: 'person', title: 'W' } });
    expect(read.frontMatter.about).toBe('Wife. Read when planning: weekends, gifts.');
  });

  it('replaces an earlier line instead of adding a second one', () => {
    const twice = withPageAbout(withPageAbout(pageOf(''), 'First.'), 'Second.');
    expect(renderMemoryPage(twice).match(/^about:/gm)).toHaveLength(1);
    expect(twice.frontMatter.about).toBe('Second.');
  });

  it('leaves a page with no settings block, or a line spread over several lines by hand, unchanged', () => {
    const bare = parseMemoryPage({ content: '# Wendy\n', fallback: { kind: 'person', title: 'Wendy' } });
    expect(withPageAbout(bare, 'Wife.')).toBe(bare);
    const spread = parseMemoryPage({
      content: '---\nkind: person\ntitle: Wendy\nabout: >\n  Typed over\n  two lines.\n---\n# Wendy\n',
      fallback: { kind: 'person', title: 'Wendy' },
    });
    expect(withPageAbout(spread, 'Wife.')).toBe(spread);
  });

  it('is what the screen shows unless the person wrote a line under the title, and is never the summary the model gets', () => {
    const page = withPageAbout(pageOf(`\n## Now\n- Likes tea. ${OWN}\n`), 'Wife. Read when planning weekends.');
    expect(pageDescription(page)).toBe('Wife. Read when planning weekends.');
    expect(pageSummary(page)).toBe('Likes tea.');
    const written = withPageAbout(pageOf(`\nThe owner's wife.\n\n## Now\n- Likes tea. ${OWN}\n`), 'Wife.');
    expect(pageDescription(written)).toBe("The owner's wife.");
    expect(pageDescription(pageOf(`\n## Now\n- Likes tea. ${OWN}\n`))).toBe('Likes tea.');
  });
});
