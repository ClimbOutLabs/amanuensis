import type { CreateSandboxFromSnapshotParams } from '@daytona/sdk';
import { Daytona, DaytonaError, Sandbox as DaytonaSandbox } from '@daytona/sdk';
import { sandboxEgressDomainAllowList } from '../../../src/core/sandbox/egressPolicy';
import { DaytonaSandboxProvider } from '../../../src/core/sandbox/provider/DaytonaProvider';
import { SandboxNotAvailableError } from '../../../src/core/sandbox/SandboxErrors';
import { withTimeout } from '../../../src/core/util/promiseUtils';
import { makeSilentLogger } from '../harnessMocks';

const API_URL = 'https://daytona.test/api';

/**
 * Nightona/Daytona has no local network to talk to, so the wiring test only needs to
 * see the exact params `create()` was called with. The mock captures them and throws
 * before doing any I/O; a function typed to always throw is assignable to any return
 * type (`never` is a subtype of everything), so this needs no unsound cast to satisfy
 * the SDK's `Promise<Sandbox>` signature.
 */
function captureCreateParams(client: Daytona): { params: () => CreateSandboxFromSnapshotParams | undefined } {
  let captured: CreateSandboxFromSnapshotParams | undefined;
  jest.spyOn(client, 'create').mockImplementation((params?: CreateSandboxFromSnapshotParams) => {
    captured = params;
    throw new Error('stop-before-http');
  });
  return { params: () => captured };
}

function makeDaytonaSandbox(name: string): DaytonaSandbox {
  const candidate: unknown = Object.create(DaytonaSandbox.prototype);
  if (!(candidate instanceof DaytonaSandbox)) {
    throw new Error('failed to construct Daytona sandbox fixture');
  }
  Object.defineProperty(candidate, 'name', { value: name, enumerable: true });
  return candidate;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DaytonaSandboxProvider egress allowlist', () => {
  it('scopes every newly created sandbox to the shared egress domain allowlist', async () => {
    const client = new Daytona({ apiKey: 'dtn-test', useDeprecatedPolling: true });
    const capture = captureCreateParams(client);
    const provider = new DaytonaSandboxProvider({
      client,
      apiKey: 'dtn-test',
      apiUrl: API_URL,
      tenantName: 'test-tenant',
      sandboxImage: 'registry.example.com/sandbox:029ea5ff',
      timeoutMs: 1000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
    });

    await expect(provider.createSandbox()).rejects.toThrow('stop-before-http');

    expect(capture.params()?.domainAllowList).toBe(sandboxEgressDomainAllowList());
    expect(capture.params()?.domainAllowList).toContain('pypi.org');
    expect(capture.params()?.domainAllowList).toContain('github.com');
  });

  it('cleans a late newly created sandbox after abort without deleting a prior sandbox', async () => {
    const client = new Daytona({ apiKey: 'dtn-test', useDeprecatedPolling: true });
    const existing = makeDaytonaSandbox('test-tenant.existing');
    const late = makeDaytonaSandbox('test-tenant.late');
    const lateCreationStarted = Promise.withResolvers<void>();
    const lateCreation = Promise.withResolvers<DaytonaSandbox>();
    const deleted = Promise.withResolvers<DaytonaSandbox>();
    jest
      .spyOn(client, 'create')
      .mockResolvedValueOnce(existing)
      .mockImplementationOnce(() => {
        lateCreationStarted.resolve();
        return lateCreation.promise;
      });
    const deleteSandbox = jest.spyOn(client, 'delete').mockImplementation(sandbox => {
      deleted.resolve(sandbox);
      return Promise.resolve();
    });
    const getSandbox = jest.spyOn(client, 'get').mockRejectedValue(new DaytonaError('not found', 404));
    const provider = new DaytonaSandboxProvider({
      client,
      apiKey: 'dtn-test',
      apiUrl: API_URL,
      tenantName: 'test-tenant',
      sandboxImage: 'registry.example.com/sandbox:029ea5ff',
      timeoutMs: 1000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
    });

    await expect(provider.createSandbox()).resolves.toEqual({ sandboxId: existing.name });
    const controller = new AbortController();
    const cancelledCreation = provider.createSandbox({ signal: controller.signal });
    await withTimeout(lateCreationStarted.promise, 500, 'late Daytona creation start');
    controller.abort(new Error('cancel Daytona creation'));
    await expect(cancelledCreation).rejects.toThrow('cancel Daytona creation');

    lateCreation.resolve(late);
    expect(await withTimeout(deleted.promise, 500, 'late Daytona cleanup')).toBe(late);
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(deleteSandbox).toHaveBeenCalledWith(late, 10, false);
    expect(deleteSandbox).not.toHaveBeenCalledWith(existing, expect.anything(), expect.anything());

    await expect(provider.exec({ sandboxId: late.name, command: 'true' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    expect(getSandbox).toHaveBeenCalledWith(late.name);
  });
});
