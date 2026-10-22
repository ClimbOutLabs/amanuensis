/**
 * Prints what the model receives on each chat turn for the standard personal-instance setups:
 * the system prompt sections and the tool definitions, with a rough token count for each. Each
 * setup is measured for a few typical messages, since the message decides which tool bundles go out.
 *
 * Usage (from the repo root): pnpm prompt:report
 */
import type { PromptReport, PromptReportRow } from '@truefoundry/trueforge-core/core';
import {
  measurePersonalInstance,
  PROMPT_REPORT_TURN_NAMES,
  PROMPT_REPORT_TURNS,
  type PersonalInstanceName,
  type PromptReportTurn,
} from '../src/runtime/promptReport/personalInstance';

const SETUPS: { name: PersonalInstanceName; title: string }[] = [
  { name: 'personal', title: 'Personal instance: web search, maps, spaces, schedules, memory (no Google)' },
  { name: 'personal-with-google', title: 'Personal instance with Gmail and Google Calendar connected' },
  { name: 'personal-no-sandbox', title: 'Personal instance with the sandbox turned off (no exec tool)' },
  { name: 'personal-no-server-sandbox', title: 'Personal instance on a server with no sandbox (no exec tool)' },
  { name: 'personal-self-hosted', title: 'Personal instance on a self-hosted model (every built-in tool, no bundles)' },
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

function systemTotal(report: PromptReport): number {
  return report.sections
    .filter(section => !section.name.includes('/'))
    .reduce((sum, section) => sum + section.tokens, 0);
}

function toolTotal(report: PromptReport): number {
  return report.tools.reduce((sum, tool) => sum + tool.tokens, 0);
}

function printReport(title: string, report: PromptReport): void {
  console.log(`\n${title}\n`);
  console.log(`${'Section or tool'.padEnd(NAME_WIDTH)}${'Tokens'.padStart(8)}`);
  console.log('-'.repeat(NAME_WIDTH + 8));
  console.log('System prompt sections');
  for (const section of report.sections) {
    console.log(row(sectionLabel(section), section.tokens));
  }
  console.log(row('System prompt total', systemTotal(report)));
  console.log('\nTools (as sent to the model)');
  for (const tool of report.tools) {
    console.log(row(`  ${tool.name}`, tool.tokens));
  }
  console.log(row('Tools total', toolTotal(report)));
  console.log('-'.repeat(NAME_WIDTH + 8));
  console.log(row('Total per turn', report.totalTokens));
}

async function main(): Promise<void> {
  const summary: { setup: PersonalInstanceName; turn: PromptReportTurn; report: PromptReport }[] = [];
  for (const setup of SETUPS) {
    for (const turn of PROMPT_REPORT_TURN_NAMES) {
      const report = await measurePersonalInstance({ name: setup.name, turn });
      printReport(`${setup.title}, ${turn} turn: "${PROMPT_REPORT_TURNS[turn]}"`, report);
      summary.push({ setup: setup.name, turn, report });
    }
  }
  console.log('\nSummary (system prompt + tools = total per turn)\n');
  for (const { setup, turn, report } of summary) {
    console.log(
      `${`${setup}, ${turn}`.padEnd(40)}${String(systemTotal(report)).padStart(8)} +${String(toolTotal(report)).padStart(7)} =${String(report.totalTokens).padStart(7)}`,
    );
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
