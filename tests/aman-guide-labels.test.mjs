import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readExternalHostsAllowlist } from '../scripts/check-external-hosts.mjs';
import { defaultSources, readInstallerCommands, readSettingsPanels } from '../scripts/check-help-coverage.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = path.join(repoRoot, 'packages/trueforge/guide');

// Maps each label a page tells the person to click to the UI file that owns it. This is the one list.
async function readLabelOwners() {
  return JSON.parse(await readFile(path.join(guideDir, 'ui-labels.json'), 'utf8'));
}

/** In guide pages, bold text means a label on screen. */
function boldPhrases(text) {
  return [...text.matchAll(/\*\*([^*\n]+)\*\*/g)].map(match => match[1]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the label is a whole string literal or a whole line of JSX text in the source. */
function sourceShowsLabel({ source, label }) {
  const escaped = escapeRegExp(label);
  return new RegExp(`(['"\`])${escaped}\\1|^\\s*${escaped}\\s*$|>${escaped}<`, 'm').test(source);
}

test('every label a page tells the person to click is listed with its UI file', async () => {
  const owners = await readLabelOwners();
  const topicsDir = path.join(guideDir, 'topics');
  for (const name of (await readdir(topicsDir)).filter(item => item.endsWith('.md'))) {
    for (const label of boldPhrases(await readFile(path.join(topicsDir, name), 'utf8'))) {
      assert.ok(owners[label] !== undefined, `${name} names "${label}", which is not in guide/ui-labels.json`);
    }
  }
});

test('every listed label still exists in the UI source that owns it', async () => {
  const owners = await readLabelOwners();
  for (const [label, file] of Object.entries(owners)) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.ok(
      sourceShowsLabel({ source, label }),
      `"${label}" is no longer in ${file}. Update the guide page and ui-labels.json.`,
    );
  }
});

test('every listed label is used by at least one page', async () => {
  const owners = await readLabelOwners();
  const topicsDir = path.join(guideDir, 'topics');
  const used = new Set();
  for (const name of (await readdir(topicsDir)).filter(item => item.endsWith('.md'))) {
    for (const label of boldPhrases(await readFile(path.join(topicsDir, name), 'utf8'))) {
      used.add(label);
    }
  }
  assert.deepEqual(
    Object.keys(owners).filter(label => !used.has(label)),
    [],
    'ui-labels.json lists labels no page uses',
  );
});

test('the label check fails when a label is renamed', () => {
  const source = "<Button>{'Build Agent'}</Button>";
  assert.ok(sourceShowsLabel({ source, label: 'Build Agent' }));
  assert.ok(!sourceShowsLabel({ source: source.replace('Build Agent', 'Make Agent'), label: 'Build Agent' }));
});

async function readTopicFiles() {
  const topicsDir = path.join(guideDir, 'topics');
  const names = (await readdir(topicsDir)).filter(item => item.endsWith('.md')).sort();
  return Promise.all(names.map(async name => ({ name, text: await readFile(path.join(topicsDir, name), 'utf8') })));
}

/**
 * Every Settings panel a page sends the person to: "Settings, then Memory", "click **Settings**, then
 * click **Permissions**" or "click **Settings**, click **Connectors**". Returns the words after the
 * step, so a check can see whether they start with a real panel title.
 */
function settingsPathSteps(text) {
  return [...text.matchAll(/Settings(?:\*\*)?,? (?:then )?(?:click )?(?:\*\*)?([A-Z][^.,:*\n]*)/g)].map(
    match => match[1],
  );
}

/** The panel title a step names, or null when no panel title starts it. Longest title first. */
function panelNamedBy({ step, panelLabels }) {
  const sorted = [...panelLabels].sort((a, b) => b.length - a.length);
  return sorted.find(label => step === label || step.startsWith(`${label} `)) ?? null;
}

/** Every `aman <command>` a page tells the person to type. */
function installerCommandsNamed(text) {
  return [...text.matchAll(/`aman ([a-z][a-z-]*)/g)].map(match => match[1]);
}

/** Every `pnpm <script>` a page names. */
function rootScriptsNamed(text) {
  return [...text.matchAll(/`pnpm ([a-z][a-z0-9:-]*)/g)].map(match => match[1]);
}

/** The host of every web address a page names. */
function hostsNamed(text) {
  return [...text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(match => match[1].toLowerCase());
}

/** The hosts a help page may link to: allowed hosts whose category is link-only, such as docs and setup consoles. */
function readLinkHosts() {
  const { categories, allowed } = readExternalHostsAllowlist({ rootDirectory: repoRoot });
  return new Set(
    [...allowed.values()].filter(entry => categories.get(entry.category)?.linkOnly === true).map(entry => entry.host),
  );
}

async function realPanelLabels() {
  const source = await readFile(defaultSources(repoRoot).settingsPath, 'utf8');
  return readSettingsPanels(source).map(panel => panel.label);
}

test('every Settings path a page names ends at a real Settings panel', async () => {
  const panelLabels = await realPanelLabels();
  for (const { name, text } of await readTopicFiles()) {
    for (const step of settingsPathSteps(text)) {
      assert.ok(
        panelNamedBy({ step, panelLabels }) !== null,
        `${name} sends the person to Settings, then "${step}", which is not a Settings panel. Use one of: ${panelLabels.join(', ')}.`,
      );
    }
  }
});

test('a renamed Settings panel breaks the page that names it', () => {
  const page =
    'Open Settings, then Memory, to read it. Click **More**, click **Settings**, then click **Permissions**.';
  const steps = settingsPathSteps(page);
  assert.deepEqual(steps, ['Memory', 'Permissions']);
  assert.ok(steps.every(step => panelNamedBy({ step, panelLabels: ['Memory', 'Permissions'] }) !== null));
  assert.equal(panelNamedBy({ step: 'Memory', panelLabels: ['Remembering', 'Permissions'] }), null);
  assert.equal(panelNamedBy({ step: 'Skills to see the skills', panelLabels: ['Skills'] }), 'Skills');
});

test('every installer command a page names exists', async () => {
  const sources = defaultSources(repoRoot);
  const commands = readInstallerCommands({
    cliSource: await readFile(sources.installerCliPath, 'utf8'),
    shellSource: await readFile(sources.installerShellPath, 'utf8'),
  });
  for (const { name, text } of await readTopicFiles()) {
    for (const command of installerCommandsNamed(text)) {
      assert.ok(
        commands.has(command),
        `${name} names \`aman ${command}\`, which the installer does not have. Fix the page or add the command.`,
      );
    }
  }
});

test('a page naming a command that does not exist fails', () => {
  const commands = new Set(['doctor', 'backup']);
  const named = installerCommandsNamed('Type `aman doctor`. Then type `aman restore latest`.');
  assert.deepEqual(named, ['doctor', 'restore']);
  assert.deepEqual(
    named.filter(command => !commands.has(command)),
    ['restore'],
  );
});

test('every root script a page names exists in package.json', async () => {
  const scripts = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  for (const { name, text } of await readTopicFiles()) {
    for (const script of rootScriptsNamed(text)) {
      assert.ok(
        scripts[script] !== undefined,
        `${name} names \`pnpm ${script}\`, which is not a root script. Fix the page.`,
      );
    }
  }
  assert.deepEqual(rootScriptsNamed('Run `pnpm guide:build` and `pnpm no-such`.'), ['guide:build', 'no-such']);
});

test('every web address a page names is on the external-hosts allowlist as a link', async () => {
  const allowed = readLinkHosts();
  for (const { name, text } of await readTopicFiles()) {
    for (const host of hostsNamed(text)) {
      assert.ok(
        allowed.has(host),
        `${name} links to ${host}, which is not on scripts/external-hosts.allowlist.json as a link-only host. Add it there with a reason, or drop the link.`,
      );
    }
  }
  assert.deepEqual(hostsNamed('It starts with https://. See https://Support.Google.com/a.'), ['support.google.com']);
});
