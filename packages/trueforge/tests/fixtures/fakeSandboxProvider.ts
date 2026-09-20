/**
 * Minimal `SandboxProvider` fake for unit tests: every method the tests under `artifacts/` and
 * `apis/` do not exercise returns an inert value or rejects, and `downloadFile` is driven by a
 * caller-supplied map/function so a test can script per-path behavior (a file's bytes, or a
 * specific SandboxError).
 */
import type {
  ExecResult,
  SandboxDownloadFileParams,
  SandboxProvider,
  VerifiedWorkspaceCommitResult,
} from '@truefoundry/trueforge-core/core';
import { SandboxFileNotFoundError } from '@truefoundry/trueforge-core/core';

export class FakeSandboxProvider implements SandboxProvider {
  readonly type = 'fake';

  constructor(private readonly downloadByPath: Map<string, Buffer | Error>) {}

  buildImage() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  getImageBuildStatus() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  createSandbox() {
    return Promise.resolve({ sandboxId: 'fake-sandbox' });
  }

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('exec is not used by this fixture'));
  }

  executeVerifiedWorkspaceCommit(): Promise<VerifiedWorkspaceCommitResult> {
    return Promise.reject(new Error('executeVerifiedWorkspaceCommit is not used by this fixture'));
  }

  acknowledgeWorkspaceTermination(): Promise<void> {
    return Promise.resolve();
  }

  getAdditionalInstructions() {
    return undefined;
  }

  getWorkspaceDir() {
    return undefined;
  }

  getToolResultDumpDir() {
    return '/tmp/tool-results';
  }

  getGitCredentialsPath() {
    return '/tmp/.git-credentials';
  }

  getFileUploadsDir() {
    return '/tmp/uploads';
  }

  getSkillsDir() {
    return '/tmp/skills';
  }

  getSkillDownloaderPath() {
    return '/tmp/skill_downloader.py';
  }

  downloadFile(params: SandboxDownloadFileParams): Promise<Buffer> {
    const scripted = this.downloadByPath.get(params.path);
    if (scripted === undefined) {
      return Promise.reject(new SandboxFileNotFoundError(params.path));
    }
    if (scripted instanceof Error) {
      return Promise.reject(scripted);
    }
    return Promise.resolve(scripted);
  }

  uploadFile(): Promise<void> {
    return Promise.resolve();
  }

  createCodeModeTransport(): never {
    throw new Error('Code Mode is not configured in this fixture');
  }
}
