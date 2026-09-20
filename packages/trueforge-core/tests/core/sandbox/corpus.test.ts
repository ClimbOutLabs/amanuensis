import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchReplaceText } from '../../../src/core/sandbox/replaceTextDiagnostics';
import { extractStructuredEditPaths } from '../../../src/core/sandbox/structuredEditPaths';
import {
  normalizeStructuredEditArguments,
  type StructuredEditToolName,
} from '../../../src/core/sandbox/toolArgumentNormalization';

/**
 * Loads every fixture in tests/core/sandbox/corpus/<model>/<case>.json and replays it through
 * the normaliser and the existing structured-edit extraction functions, the same pipeline
 * `Sandbox.ts` runs a real tool call through. For replace_text fixtures, also runs the host-side
 * exact matcher against fixture file content — old_text must occur exactly once in it, after
 * normalisation, or the call is rejected. See corpus/README.md for how to add a case.
 */

interface CorpusFixture {
  tool: StructuredEditToolName;
  args: Record<string, unknown>;
  cwd: string;
  repositoryRoot: string;
  expect: {
    ok: boolean;
    normalizedPath?: string;
    notes?: string[];
    /**
     * replace_text fixtures with a `--fixture.txt` companion only: the exact matcher status the
     * case must produce ("exact_match" | "ambiguous" | "no_match"). Defaults to "exact_match"
     * when `expect.ok` is true and unset, or "no_match" when `expect.ok` is false and unset.
     */
    matchStatus?: 'exact_match' | 'ambiguous' | 'no_match';
  };
}

const CORPUS_ROOT = join(__dirname, 'corpus');

interface FixtureEntry {
  model: string;
  caseName: string;
  path: string;
}

function listFixtures(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  for (const modelEntry of readdirSync(CORPUS_ROOT, { withFileTypes: true })) {
    if (!modelEntry.isDirectory()) {
      continue;
    }
    const modelDir = join(CORPUS_ROOT, modelEntry.name);
    for (const fileName of readdirSync(modelDir)) {
      if (fileName.endsWith('.json')) {
        entries.push({
          model: modelEntry.name,
          caseName: fileName.replace(/\.json$/u, ''),
          path: join(modelDir, fileName),
        });
      }
    }
  }
  return entries;
}

function loadFixture(path: string): CorpusFixture {
  return JSON.parse(readFileSync(path, 'utf-8')) as CorpusFixture;
}

describe('model compatibility corpus', () => {
  const fixtures = listFixtures();

  it('is not empty (guard against a silently-empty corpus)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(7);
  });

  for (const fixture of fixtures) {
    it(`${fixture.model}/${fixture.caseName}`, () => {
      const raw = loadFixture(fixture.path);
      const normalization = normalizeStructuredEditArguments({
        toolName: raw.tool,
        args: raw.args,
        cwd: raw.cwd,
        repositoryRoot: raw.repositoryRoot,
      });

      // Every replace_text normalisation note (BOM strip, CRLF-to-LF, line-number-gutter strip)
      // comes from `normalizeStructuredEditArguments` itself, whether or not the fixture also
      // carries file content for the matcher — unlike the fuzzy matcher this replaced, the exact
      // matcher never produces notes of its own.
      if (raw.expect.notes !== undefined) {
        for (const note of raw.expect.notes) {
          expect(normalization.notes).toContain(note);
        }
      }

      if (raw.tool === 'apply_patch') {
        const patch = normalization.args['patch'];
        expect(typeof patch).toBe('string');
        const resolution = extractStructuredEditPaths({
          kind: 'apply_patch',
          repositoryRoot: raw.repositoryRoot,
          cwd: raw.cwd,
          patch: patch as string,
        });
        expect(resolution.status).toBe(raw.expect.ok ? 'valid' : 'invalid');
        if (!raw.expect.ok && resolution.status === 'invalid') {
          expect(resolution.failure).toMatch(/received/u);
          expect(resolution.failure).toMatch(/expected/u);
        }
        return;
      }

      const path = normalization.args['path'];
      expect(typeof path).toBe('string');

      // For replace_text fixtures with file content, test the host-side exact matcher instead
      if (raw.tool === 'replace_text') {
        const fixtureContentPath = fixture.path.replace(/\.json$/u, '--fixture.txt');
        const oldText = normalization.args['old_text'];
        expect(typeof oldText).toBe('string');

        if (existsSync(fixtureContentPath)) {
          const fileContent = readFileSync(fixtureContentPath, 'utf-8');
          const matchResult = matchReplaceText({
            fileContent,
            oldText: oldText as string,
            path: path as string,
          });

          const expectedStatus = raw.expect.matchStatus ?? (raw.expect.ok ? 'exact_match' : 'no_match');
          expect(matchResult.status).toBe(expectedStatus);
          if (matchResult.status !== 'exact_match') {
            expect(matchResult.rejection).toMatch(/received/u);
            expect(matchResult.rejection).toMatch(/expected/u);
          }
          return;
        }
      }

      // For other fixtures, check path extraction
      const resolution = extractStructuredEditPaths({
        kind: raw.tool,
        repositoryRoot: raw.repositoryRoot,
        cwd: raw.cwd,
        path: path as string,
      });
      expect(resolution.status).toBe(raw.expect.ok ? 'valid' : 'invalid');
      if (raw.expect.ok && resolution.status === 'valid' && raw.expect.normalizedPath !== undefined) {
        expect(resolution.paths).toContain(raw.expect.normalizedPath);
      }
      if (!raw.expect.ok && resolution.status === 'invalid') {
        expect(resolution.failure).toMatch(/received/u);
        expect(resolution.failure).toMatch(/expected/u);
      }
    });
  }
});
