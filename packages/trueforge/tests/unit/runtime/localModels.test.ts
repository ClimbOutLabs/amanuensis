import {
  isThisComputerModelUrl,
  localModelBridgeUrl,
  modelOnThisComputerMessage,
  placeOfModelHostFor,
  type LocalModels,
} from '../../../src/runtime/localModels';

const spark: LocalModels = {
  thisComputer: new Set([
    '127.0.0.1',
    'localhost',
    'host.docker.internal',
    '192.168.1.20',
    '100.101.102.103',
    'spark.example.ts.net',
  ]),
  ports: [30031],
};
const none: LocalModels = { thisComputer: new Set(), ports: [] };
const lookups = (table: Record<string, string[]>) => (hostname: string) => Promise.resolve(table[hostname] ?? []);

describe('isThisComputerModelUrl', () => {
  it.each([
    'https://spark.example.ts.net:8443/v1',
    'https://SPARK.example.ts.net./v1',
    'http://100.101.102.103:30031/v1',
    'http://192.168.1.20:30031/v1',
    'http://127.0.0.2:11434/v1',
    'http://[::1]:11434/v1',
    'http://host.docker.internal:11434/v1',
  ])('is true for %s', async baseUrl => {
    await expect(isThisComputerModelUrl({ baseUrl, local: spark, resolveHostAddresses: lookups({}) })).resolves.toBe(
      true,
    );
  });

  it('is true for a name that resolves to one of this computer’s addresses', async () => {
    await expect(
      isThisComputerModelUrl({
        baseUrl: 'http://spark:30031/v1',
        local: spark,
        resolveHostAddresses: lookups({ spark: ['192.168.1.20'] }),
      }),
    ).resolves.toBe(true);
  });

  it.each([
    'http://aman-local-model:30031/v1',
    'https://gpu.example.ts.net/v1',
    'http://100.101.102.200:8000/v1',
    'https://api.openai.com/v1',
    'not a url',
  ])('is false for %s', async baseUrl => {
    await expect(
      isThisComputerModelUrl({
        baseUrl,
        local: spark,
        resolveHostAddresses: lookups({
          'gpu.example.ts.net': ['100.101.102.200'],
          'api.openai.com': ['162.159.140.245'],
        }),
      }),
    ).resolves.toBe(false);
  });

  it('is false for a name that does not resolve, or whose lookup fails', async () => {
    await expect(
      isThisComputerModelUrl({ baseUrl: 'http://nowhere.invalid/v1', local: spark, resolveHostAddresses: lookups({}) }),
    ).resolves.toBe(false);
    await expect(
      isThisComputerModelUrl({
        baseUrl: 'http://broken.invalid/v1',
        local: spark,
        resolveHostAddresses: () => Promise.reject(new Error('lookup failed')),
      }),
    ).resolves.toBe(false);
  });

  it('is false for everything outside an installer instance, loopback included', async () => {
    await expect(
      isThisComputerModelUrl({ baseUrl: 'http://localhost:11434/v1', local: none, resolveHostAddresses: lookups({}) }),
    ).resolves.toBe(false);
  });
});

describe('placeOfModelHostFor', () => {
  it('tells the local link, this computer, and elsewhere apart by name', () => {
    const place = placeOfModelHostFor(spark);
    expect(place('aman-local-model')).toBe('local_link');
    expect(place('spark.example.ts.net')).toBe('this_computer');
    expect(place('100.101.102.103')).toBe('this_computer');
    expect(place('127.0.0.1')).toBe('this_computer');
    expect(place('gpu.example.ts.net')).toBe('elsewhere');
    expect(place('api.openai.com')).toBe('elsewhere');
  });

  it('still knows the local link outside an installer instance, and nothing else', () => {
    const place = placeOfModelHostFor(none);
    expect(place('aman-local-model')).toBe('local_link');
    expect(place('localhost')).toBe('elsewhere');
  });
});

describe('modelOnThisComputerMessage', () => {
  it('names the local link address when it carries one port', () => {
    expect(modelOnThisComputerMessage({ baseUrl: 'https://spark.example.ts.net:8443/v1', local: spark })).toBe(
      'spark.example.ts.net:8443 is this computer. Aman reaches a model on this computer through its own local link, ' +
        'because an address like this one can stop working after a network change on this computer, such as a software update. ' +
        'If your model server listens on port 30031, use the address http://aman-local-model:30031/v1 instead. ' +
        'For another port, run aman local-model with that port on this computer first.',
    );
  });

  it('lists the ports when the local link carries more than one', () => {
    const message = modelOnThisComputerMessage({
      baseUrl: 'http://localhost:11434/v1',
      local: { ...spark, ports: [30031, 11434] },
    });
    expect(message).toContain(`Use the address ${localModelBridgeUrl('PORT')} instead`);
    expect(message).toContain('The local link carries ports 30031, 11434.');
  });

  it('says how to set the local link up when it carries nothing yet', () => {
    expect(
      modelOnThisComputerMessage({ baseUrl: 'http://localhost:11434/v1', local: { ...spark, ports: [] } }),
    ).toContain(
      'On this computer, run aman local-model with the port your model server listens on, for example aman local-model 11434.',
    );
  });

  it('uses no dashes or semicolons', () => {
    for (const ports of [[], [30031], [30031, 11434]]) {
      expect(modelOnThisComputerMessage({ baseUrl: 'http://localhost:1/v1', local: { ...spark, ports } })).not.toMatch(
        /—|;/,
      );
    }
  });
});
