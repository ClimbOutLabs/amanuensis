// Keeps one GitHub issue in step with the nightly run. Run by `npm run nightly:report` in the Nightly workflow.
//
// A failed run opens the issue, or adds a comment to the one already open. A passing run comments on
// the open issue and closes it. So an open issue always means the last nightly run did not pass.
import { fileURLToPath } from 'node:url';

export const ISSUE_TITLE = 'Nightly tests failed';
/** The login GitHub gives issues opened with a workflow's own token. */
export const ISSUE_AUTHOR = 'github-actions[bot]';

const NOT_PASSED = new Set(['failure', 'cancelled', 'timed_out']);

/** The names of the jobs in a run that did not pass, in run order. */
export function failedJobNames(jobs) {
  return jobs.filter(job => NOT_PASSED.has(job.conclusion)).map(job => job.name);
}

function failureText({ failedJobs, runUrl }) {
  const list =
    failedJobs.length === 0
      ? 'The run stopped before any job reported a failure.'
      : failedJobs.map(name => `- ${name}`).join('\n');
  return `The nightly run on \`main\` did not pass.\n\n${list}\n\nOpen the run to read the logs: ${runUrl}`;
}

/**
 * What to do with the nightly issue: `{ action: 'open' | 'comment' | 'close' | 'none', ... }`.
 * `openIssue` is the number of the nightly issue that is open now, or undefined.
 */
export function planReport({ result, failedJobs, openIssue, runUrl }) {
  // A newer run on the same branch cancels this one. That says nothing about the tests, so the
  // issue stays as the last finished run left it.
  if (result === 'cancelled') {
    return { action: 'none' };
  }
  if (result === 'success') {
    if (openIssue === undefined) {
      return { action: 'none' };
    }
    return { action: 'close', issue: openIssue, body: `The nightly run passed again: ${runUrl}` };
  }
  const body = failureText({ failedJobs, runUrl });
  if (openIssue === undefined) {
    return { action: 'open', title: ISSUE_TITLE, body };
  }
  return { action: 'comment', issue: openIssue, body };
}

/** The open nightly issue's number, from one page of open issues, or undefined. */
export function findOpenIssue(issues) {
  return issues.find(
    issue => issue.pull_request === undefined && issue.title === ISSUE_TITLE && issue.user?.login === ISSUE_AUTHOR,
  )?.number;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this from the Nightly workflow, which sets it.`);
  }
  return value;
}

async function main() {
  const api = requiredEnv('GITHUB_API_URL');
  const repo = requiredEnv('GITHUB_REPOSITORY');
  const runId = requiredEnv('GITHUB_RUN_ID');
  const token = requiredEnv('GITHUB_TOKEN');
  const result = requiredEnv('NIGHTLY_RESULT');
  const runUrl = `${requiredEnv('GITHUB_SERVER_URL')}/${repo}/actions/runs/${runId}`;

  const call = async (path, init) => {
    const response = await fetch(`${api}/repos/${repo}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${String(response.status)} for ${path}. Check that the Report job has "issues: write" and "actions: read", then run it again.`,
      );
    }
    return response.json();
  };
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

  const jobs = [];
  for (let page = 1; ; page += 1) {
    const batch = (await call(`/actions/runs/${runId}/jobs?per_page=100&page=${String(page)}`)).jobs;
    jobs.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  const openIssue = findOpenIssue(await call('/issues?state=open&creator=app%2Fgithub-actions&per_page=100'));
  const plan = planReport({ result, failedJobs: failedJobNames(jobs), openIssue, runUrl });

  if (plan.action === 'open') {
    const issue = await post('/issues', { title: plan.title, body: plan.body });
    console.log(`Opened issue #${String(issue.number)}.`);
  } else if (plan.action === 'comment') {
    await post(`/issues/${String(plan.issue)}/comments`, { body: plan.body });
    console.log(`Added the failure to issue #${String(plan.issue)}.`);
  } else if (plan.action === 'close') {
    await post(`/issues/${String(plan.issue)}/comments`, { body: plan.body });
    await call(`/issues/${String(plan.issue)}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`Closed issue #${String(plan.issue)}.`);
  } else {
    console.log('Nothing to report: the run passed with no issue open, or it was cancelled.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
