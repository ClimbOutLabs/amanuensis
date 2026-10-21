import { envManagedHelperModelFqn, routeHelperModel } from '../../../src/runtime/helperModelRouting';

const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
const SUPER = 'nvidia/nemotron-3-super-120b-a12b';

describe('envManagedHelperModelFqn', () => {
  it('names the small model on the env-managed provider', () => {
    expect(
      envManagedHelperModelFqn({ apiKey: 'k', managedByTrueFoundry: false, model: SUPER, cheaperModel: NANO }),
    ).toBe('tokenfactory/nvidia-nemotron-3-nano-30b-a3b');
  });

  it.each([
    ['no key', { apiKey: undefined, managedByTrueFoundry: false, model: SUPER, cheaperModel: NANO }],
    ['blank key', { apiKey: ' ', managedByTrueFoundry: false, model: SUPER, cheaperModel: NANO }],
    ['TrueFoundry owns the providers', { apiKey: 'k', managedByTrueFoundry: true, model: SUPER, cheaperModel: NANO }],
    ['no small model set', { apiKey: 'k', managedByTrueFoundry: false, model: SUPER, cheaperModel: undefined }],
    ['small model is the main model', { apiKey: 'k', managedByTrueFoundry: false, model: SUPER, cheaperModel: SUPER }],
  ])('has no helper model with %s', (_label, input) => {
    expect(envManagedHelperModelFqn(input)).toBeUndefined();
  });
});

describe('routeHelperModel', () => {
  const helperFqn = 'tokenfactory/nvidia-nemotron-3-nano-30b-a3b';

  it('sends helper jobs to the small model when the turn runs on Token Factory', () => {
    expect(routeHelperModel({ modelFqn: 'tokenfactory/nemotron-3-super-120b-a12b', helperFqn })).toBe(helperFqn);
  });

  it('leaves a local-only turn on its own model', () => {
    expect(routeHelperModel({ modelFqn: 'host/qwen', helperFqn })).toBe('host/qwen');
  });

  it('leaves the turn model alone when there is no helper model', () => {
    expect(routeHelperModel({ modelFqn: 'tokenfactory/nemotron-3-super-120b-a12b', helperFqn: undefined })).toBe(
      'tokenfactory/nemotron-3-super-120b-a12b',
    );
  });

  it('passes an unresolved turn model through', () => {
    expect(routeHelperModel({ modelFqn: undefined, helperFqn })).toBeUndefined();
  });
});
