import { SkillCatalog } from '../../../src/catalog/SkillCatalog';

// A full sha1/sha256 object id, lowercase or uppercase hex (matches what
// git_downloader.py's OBJECT_ID_RE accepts and skips `git ls-remote` for).
const OBJECT_ID_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

describe('shipped skill catalog', () => {
  // A mutable ref (a branch like "main") on a shipped preset lets whoever controls the
  // upstream repo change what gets spliced into the model's system prompt between sessions
  // with nobody seeing a diff. Every `type: git` entry must pin a full commit object id so
  // `git_downloader.py`'s _resolve_object_id() uses it as-is instead of resolving a branch tip.
  it('pins every git skill to a full commit object id, never a branch or tag', () => {
    const skills = SkillCatalog.load().list();
    const gitSkills = skills.filter(skill => skill.type === 'git');

    expect(gitSkills.length).toBeGreaterThan(0);
    for (const skill of gitSkills) {
      expect([skill.name, skill.ref]).toEqual([skill.name, expect.stringMatching(OBJECT_ID_RE)]);
    }
  });

  // Loads the real shipped catalog/skill-catalog.yaml through SkillCatalog.load() — the exact
  // function behind "Failed to start server: Invalid config in shipped skill-catalog: ..." — so
  // a field the manifest schema (schemas/skill.ts) grows but the catalog schema
  // (schemas/skillCatalog.ts) doesn't mirror fails here instead of at server startup.
  it('loads without throwing, the same validation path the server runs at startup', () => {
    expect(() => SkillCatalog.load()).not.toThrow();
  });

  // requires is optional on catalog entries but, when present, must survive validation
  // (regression guard for the tavily-research preset).
  it('preserves the optional requires field on entries that declare one', () => {
    const skills = SkillCatalog.load().list();
    const tavily = skills.find(skill => skill.name === 'tavily-research');

    expect(tavily?.requires).toEqual(['tvly']);
  });
});
