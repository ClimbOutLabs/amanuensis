import { openUiSentences } from '../../../../src/runtime/memory/openUiText';

const BRIEF = [
  'root = Stack([header, emailCard, okCard, chart])',
  'header = TextContent("Good morning, Maya. Thursday 29 October.", "large-heavy")',
  'emailCard = Card([CardHeader("📥 Email", "2 need a reply"), emailTable])',
  'emailTable = Table([Col("From", froms), Col("Subject", subjects), Col("Priority", @Each(prios, "p", Tag(p, null, "sm", p == "high" ? "danger" : "neutral")))])',
  'froms = ["Priya Shah", "Tomas Reis"]',
  'subjects = ["Signed form due 3 November", "Lisbon studio lease renewal"]',
  'prios = ["high", "medium"]',
  'okCard = Card([CardHeader("✅ Needs your OK"), TextContent("- Send the signed form to Priya today.\\n- Reply to Tomas about the lease by Friday.")])',
  'chart = BarChart(["Mon", "Tue"], [Series("Mail", [3, 5])], "grouped")',
].join('\n');

describe('openUiSentences', () => {
  it('reads a brief as its heading, one sentence per table row, and one per list item', () => {
    expect(openUiSentences(BRIEF)).toEqual([
      'Good morning, Maya. Thursday 29 October.',
      '📥 Email: 2 need a reply',
      'Priya Shah, Signed form due 3 November',
      'Tomas Reis, Lisbon studio lease renewal',
      '✅ Needs your OK',
      'Send the signed form to Priya today.',
      'Reply to Tomas about the lease by Friday.',
    ]);
  });

  it('reads a KPI card as one sentence, both sides of a choice, and tab titles before their content', () => {
    const block = [
      'root = Stack([kpi, $open ? Callout("warning", "Late", "The form is overdue.") : TextContent("All on time."), tabs])',
      'kpi = Card([TextContent("Open items", "small"), TextContent("" + @Count(rows), "large-heavy"), TextContent("3")])',
      'tabs = Tabs([TabItem("today", "Today", [StepsItem("Call the bank", "Use the number on your card.")])])',
      'rows = []',
    ].join('\n');
    expect(openUiSentences(block)).toEqual([
      'Open items 3',
      'Late: The form is overdue.',
      'All on time.',
      'Today',
      'Call the bank: Use the number on your card.',
    ]);
  });

  it('yields nothing for a block without a root, one that does not parse, or one that refers to itself', () => {
    expect(openUiSentences('title = TextContent("Hello")')).toEqual([]);
    expect(openUiSentences('root = Stack([TextContent("Hello)])')).toEqual([]);
    expect(openUiSentences('root = Stack([root])')).toEqual([]);
  });
});
