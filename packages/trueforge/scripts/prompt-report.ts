/**
 * Prints what the model receives on each chat turn for the standard personal-instance setups:
 * the system prompt sections and the tool definitions, with a rough token count for each.
 *
 * Usage (from the repo root): pnpm prompt:report
 */
import type { PromptReport, PromptReportRow } from '@truefoundry/trueforge-core/core';
import { measurePersonalInstance, type PersonalInstanceName } from '../src/runtime/promptReport/personalInstance';

const SETUPS: { name: PersonalInstanceName; title: string }[] = [
  { name: 'personal', title: 'Personal instance: web search, maps, spaces, schedules, memory (no Google)' },
  { name: 'personal-with-google', title: 'Personal instance with Gmail and Google Calendar connected' },
  { name: 'personal-no-sandbox', title: 'Personal instance with the sandbox turned off (no exec tool)' },
];

const NAME_WIDTH = 60;

function row(name: string, tokens: number): string {
  return `${name.padEnd(NAME_WIDTH)}${String(tokens).padStart(8)}`;
}

function sectionLabel(row: PromptReportRow): string {
  const depth = row.name.split('/').length - 1;
  const leaf = row.name.split('/').pop() ?? row.name;
  return `${'  '.repeat(depth)}${leaf}`;
}

function printReport(title: string, report: PromptReport): void {
  const systemTotal = report.sections
    .filter(section => !section.name.includes('/'))
    .reduce((sum, section) => sum + section.tokens, 0);
  const toolTotal = report.tools.reduce((sum, tool) => sum + tool.tokens, 0);
  console.log(`\n${title}\n`);
  console.log(`${'Section or tool'.padEnd(NAME_WIDTH)}${'Tokens'.padStart(8)}`);
  console.log('-'.repeat(NAME_WIDTH + 8));
  console.log('System prompt sections');
  for (const section of report.sections) {
    console.log(row(sectionLabel(section), section.tokens));
  }
  console.log(row('System prompt total', systemTotal));
  console.log('\nTools (as sent to the model)');
  for (const tool of report.tools) {
    console.log(row(`  ${tool.name}`, tool.tokens));
  }
  console.log(row('Tools total', toolTotal));
  console.log('-'.repeat(NAME_WIDTH + 8));
  console.log(row('Total per turn', report.totalTokens));
}

async function main(): Promise<void> {
  for (const setup of SETUPS) {
    printReport(setup.title, await measurePersonalInstance({ name: setup.name }));
  }
  console.log(
    '\nNot measured: memory provider tools. No captured tool list exists yet, so they are left out of the totals.',
  );
  console.log('Token counts are estimates (characters / 4), the same estimate the runtime uses.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
