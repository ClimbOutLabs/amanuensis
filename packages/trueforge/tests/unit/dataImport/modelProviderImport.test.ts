/**
 * The planner and the import schema for provider setups, probed with the
 * attacks the cloud review named: an address hiding a key, an import that
 * repoints a keyed provider at another host, and a key written beside a
 * setup instead of inside it.
 */
import { ImportModelProvidersFileSchema } from '../../../src/dataImport/importSchemas';
import { mergeImportedProvider, planModelProviderImport } from '../../../src/dataImport/modelProviderImport';
import type { ModelProviderManifest } from '../../../src/schemas/modelProvider';

const NEXT_STEP = 'Export again from this Aman, then import the new file.';

describe('mergeImportedProvider', () => {
  const keyedExisting: ModelProviderManifest = {
    type: 'tokenfactory',
    base_url: 'https://tokenfactory.example.com/v1',
    auth: { api_key: 'FAKE-KEY-already-on-this-aman' },
    models: [{ model_id: 'extra-v1', name: 'extra-model', properties: {} }],
    stream_timeout: { chunk_ms: 30000 },
  };

  it('keeps the address of a keyed provider when the import names another host', () => {
    const merged = mergeImportedProvider({
      existing: keyedExisting,
      imported: {
        type: 'tokenfactory',
        base_url: 'https://evil.example.com/v1',
        models: [{ model_id: 'main-v1', name: 'main-model', properties: {} }],
        stream_timeout: { chunk_ms: 5000 },
      },
    });
    expect(merged.type).toBe('tokenfactory');
    expect(merged.base_url).toBe('https://tokenfactory.example.com/v1');
    expect(merged.auth).toEqual({ api_key: 'FAKE-KEY-already-on-this-aman' });
    expect(merged.models.map(model => model.name)).toEqual(['main-model', 'extra-model']);
    expect(merged.stream_timeout).toEqual({ chunk_ms: 5000 });
  });

  it('keeps the type of a keyed provider when the import names another kind under the same name', () => {
    const merged = mergeImportedProvider({
      existing: keyedExisting,
      imported: {
        type: 'custom',
        name: 'tokenfactory',
        base_url: 'https://evil.example.com/v1',
        models: [{ model_id: 'main-v1', name: 'main-model', properties: {} }],
      },
    });
    expect(merged.type).toBe('tokenfactory');
    expect(merged.base_url).toBe('https://tokenfactory.example.com/v1');
    expect(merged.auth).toEqual({ api_key: 'FAKE-KEY-already-on-this-aman' });
    expect('name' in merged).toBe(false);
    expect(merged.models.map(model => model.name)).toEqual(['main-model', 'extra-model']);
    // The import named no stream timeout, so the one already here stays.
    expect(merged.stream_timeout).toEqual({ chunk_ms: 30000 });
  });

  it('lets the imported setup win for a provider that holds no key', () => {
    const merged = mergeImportedProvider({
      existing: {
        type: 'openai',
        base_url: 'https://old.example.com/v1',
        models: [{ model_id: 'extra-v1', name: 'extra-model', properties: {} }],
      },
      imported: {
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        models: [{ model_id: 'main-v1', name: 'main-model', properties: {} }],
      },
    });
    expect(merged.base_url).toBe('https://api.openai.com/v1');
    expect(merged.auth).toBeUndefined();
    expect(merged.models.map(model => model.name)).toEqual(['main-model', 'extra-model']);
  });

  it('takes an imported provider as it stands when none is here', () => {
    const imported: ModelProviderManifest = {
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      models: [{ model_id: 'main-v1', name: 'main-model', properties: {} }],
    };
    expect(mergeImportedProvider({ imported, existing: undefined })).toEqual(imported);
  });

  it('plans a repointed import onto the address the key already belongs to', () => {
    const plan = planModelProviderImport({
      imported: [
        {
          name: 'tokenfactory',
          manifest: {
            type: 'tokenfactory',
            base_url: 'https://evil.example.com/v1',
            models: [{ model_id: 'main-v1', name: 'main-model', properties: {} }],
          },
        },
      ],
      existing: [
        { tenant_id: 'default', name: 'tokenfactory', manifest: keyedExisting, created_at: '', updated_at: '' },
      ],
      defaultModel: undefined,
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.manifest.base_url).toBe('https://tokenfactory.example.com/v1');
    expect(plan.writes[0]?.needsKey).toBe(false);
  });
});

describe('ImportModelProvidersFileSchema', () => {
  const validRecord = {
    name: 'lab-box',
    manifest: {
      type: 'custom',
      name: 'lab-box',
      base_url: 'https://llm.example.com/v1',
      models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
    },
  };

  function withBaseUrl(base_url: string) {
    return [{ ...validRecord, manifest: { ...validRecord.manifest, base_url } }];
  }

  it('accepts a plain provider setup', () => {
    expect(ImportModelProvidersFileSchema.safeParse([validRecord]).success).toBe(true);
  });

  it.each([
    ['userinfo', 'https://user:FAKE-KEY-hidden-in-the-address@llm.example.com/v1'],
    ['a query', 'https://llm.example.com/v1?api_key=FAKE-KEY-hidden-in-the-address'],
    ['a fragment', 'https://llm.example.com/v1#FAKE-KEY-hidden-in-the-address'],
  ])('refuses an address carrying a key in %s', (_part, baseUrl) => {
    const parsed = ImportModelProvidersFileSchema.safeParse(withBaseUrl(baseUrl));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes(NEXT_STEP))).toBe(true);
    }
  });

  it('refuses a key written beside a provider setup instead of inside it', () => {
    const parsed = ImportModelProvidersFileSchema.safeParse([{ ...validRecord, api_key: 'FAKE-KEY-beside' }]);
    expect(parsed.success).toBe(false);
  });

  it('refuses a setup carrying a key, and the refusal says what to do next', () => {
    const parsed = ImportModelProvidersFileSchema.safeParse([
      { ...validRecord, manifest: { ...validRecord.manifest, auth: { api_key: 'FAKE-KEY-in-the-manifest' } } },
    ]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('never carries a key'))).toBe(true);
      expect(parsed.error.issues.some(issue => issue.message.includes(NEXT_STEP))).toBe(true);
    }
  });

  it('refuses an entry named differently from its own setup, with the next step', () => {
    const parsed = ImportModelProvidersFileSchema.safeParse([{ ...validRecord, name: 'other-name' }]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes(NEXT_STEP))).toBe(true);
    }
  });
});
