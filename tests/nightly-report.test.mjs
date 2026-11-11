import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ISSUE_AUTHOR, ISSUE_TITLE, failedJobNames, findOpenIssue, planReport } from '../scripts/nightly-report.mjs';

const runUrl = 'https://github.test/owner/repo/actions/runs/7';

test('a first failure opens the issue and names the failed jobs', () => {
  const plan = planReport({ result: 'failure', failedJobs: ['Package (frontend)'], openIssue: undefined, runUrl });
  assert.equal(plan.action, 'open');
  assert.equal(plan.title, ISSUE_TITLE);
  assert.match(plan.body, /- Package \(frontend\)/);
  assert.ok(plan.body.includes(runUrl), 'the issue links the run');
});

test('a repeat failure adds to the open issue instead of opening another', () => {
  const plan = planReport({ result: 'failure', failedJobs: ['Store Tests'], openIssue: 12, runUrl });
  assert.equal(plan.action, 'comment');
  assert.equal(plan.issue, 12);
});

test('a cancelled run leaves the issue as it was', () => {
  assert.deepEqual(planReport({ result: 'cancelled', failedJobs: [], openIssue: undefined, runUrl }), {
    action: 'none',
  });
  assert.deepEqual(planReport({ result: 'cancelled', failedJobs: ['Store Tests'], openIssue: 12, runUrl }), {
    action: 'none',
  });
});

test('a failure with no failed job still opens the issue', () => {
  const plan = planReport({ result: 'failure', failedJobs: [], openIssue: undefined, runUrl });
  assert.equal(plan.action, 'open');
  assert.match(plan.body, /stopped before any job reported a failure/);
});

test('a pass closes the open issue, and does nothing when none is open', () => {
  assert.deepEqual(planReport({ result: 'success', failedJobs: [], openIssue: 12, runUrl }), {
    action: 'close',
    issue: 12,
    body: `The nightly run passed again: ${runUrl}`,
  });
  assert.deepEqual(planReport({ result: 'success', failedJobs: [], openIssue: undefined, runUrl }), {
    action: 'none',
  });
});

test('failed, cancelled and timed out jobs are listed; passed and skipped ones are not', () => {
  assert.deepEqual(
    failedJobNames([
      { name: 'a', conclusion: 'success' },
      { name: 'b', conclusion: 'failure' },
      { name: 'c', conclusion: 'skipped' },
      { name: 'd', conclusion: 'timed_out' },
      { name: 'e', conclusion: 'cancelled' },
    ]),
    ['b', 'd', 'e'],
  );
});

test('only the workflow’s own open issue with the nightly title is reused', () => {
  const bot = { login: ISSUE_AUTHOR };
  assert.equal(
    findOpenIssue([
      { number: 1, title: ISSUE_TITLE, user: { login: 'someone' } },
      { number: 2, title: 'Another report', user: bot },
      { number: 3, title: ISSUE_TITLE, user: bot, pull_request: {} },
      { number: 4, title: ISSUE_TITLE, user: bot },
    ]),
    4,
  );
  assert.equal(findOpenIssue([]), undefined);
});
