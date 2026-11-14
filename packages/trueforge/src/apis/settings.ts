/**
 * Admin/settings API surface under /api/v1/settings.
 * Sub-routers (model-providers, mcp-servers, skills, sandbox-providers, run-code) mount here.
 * Auth is applied at the /api/v1/settings mount boundary in app.ts (admin when auth is enabled).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { McpCatalog } from '../catalog/McpCatalog';
import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IMcpToolGrantStore } from '../db/mcpToolGrantStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import type { NightlyMemoryJob } from '../runtime/memory/nightlyService';
import type { CheckSavedModelProvider } from '../runtime/modelProviderCheck';
import type { ResolveAddresses } from '../runtime/remoteAddress';
import { getSharedRunCodeService } from '../runtime/sessionResources';
import type { TokenFactoryBudget } from '../runtime/tokenFactoryBudget';
import { sandboxDisabledByInstaller } from '../sandbox/slotBackend';
import { createFirstRunGuideRouter } from './firstRunGuide';
import { createGitCommitIdentityRouter } from './gitCommitIdentity';
import { createSettingsMcpServersRouter } from './mcpServers';
import { createMemoryNightlyRouter } from './memoryNightly';
import { createMemoryPageSortingRouter } from './memoryPageSorting';
import { createMemoryRecallRouter } from './memoryRecall';
import { createMemoryScreensRouter } from './memoryScreens';
import { createMemorySummarizeRouter } from './memorySummarize';
import { createModelProvidersRouter } from './modelProviders';
import { createRunCodeRouter } from './runCode';
import { createSandboxProvidersRouter } from './sandboxProviders';
import { createSkillsRouter, type ResolveSkillStore } from './skills';
import { createTokenFactoryUsageRouter } from './tokenFactoryUsage';
import { createToolOutputScreensRouter } from './toolOutputScreens';

export interface SettingsRouterDeps<TTransaction> {
  mcpCatalog: McpCatalog;
  resolveModelProviderStore: (c: Context) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (c: Context) => IMcpServerWithAuthStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  toolGrantStore: IMcpToolGrantStore<TTransaction>;
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  personalizationStore: Pick<IPersonalizationStore<TTransaction>, 'getProfile'>;
  tokenFactoryBudget: TokenFactoryBudget;
  /** Runs the memory tidy-up now, and tells where one stands. */
  memoryTidy: NightlyMemoryJob;
  /** Model providers the environment owns (see `envManagedModelProviderNames`). */
  envManagedModelProviderNames: ReadonlySet<string>;
  /** Name lookups for the checks on model addresses; tests replace it. */
  resolveHostAddresses?: ResolveAddresses;
  /** Runs the one test call for a just-saved model provider; its outcome is stored on the provider. */
  checkSavedProvider: CheckSavedModelProvider;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

export function createSettingsRouter<TTransaction>(deps: SettingsRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  router.route(
    '/model-providers',
    createModelProvidersRouter({
      resolveModelProviderStore: deps.resolveModelProviderStore,
      withTransaction: deps.withTransaction,
      resolveRequestContext: deps.resolveRequestContext,
      envManagedNames: deps.envManagedModelProviderNames,
      ...(deps.resolveHostAddresses === undefined ? {} : { resolveHostAddresses: deps.resolveHostAddresses }),
      checkSavedProvider: deps.checkSavedProvider,
      logger: deps.logger,
    }),
  );
  router.route(
    '/mcp-servers',
    createSettingsMcpServersRouter({
      mcpCatalog: deps.mcpCatalog,
      resolveMcpServerStore: deps.resolveMcpServerStore,
      tokenStore: deps.tokenStore,
      toolGrantStore: deps.toolGrantStore,
      withTransaction: deps.withTransaction,
      logger: deps.logger,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/skills',
    createSkillsRouter({
      resolveSkillStore: deps.resolveSkillStore,
      withTransaction: deps.withTransaction,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/sandbox-providers',
    createSandboxProvidersRouter({
      resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
      withTransaction: deps.withTransaction,
      logger: deps.logger,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/run-code',
    createRunCodeRouter({
      backend: () => configuration.SANDBOX_BACKEND,
      sandboxDisabledByInstaller,
      imageConfigured: () => configuration.SANDBOX_BACKEND === 'slots' || configuration.SANDBOX_IMAGE.trim() !== '',
      ensureReady: signal => getSharedRunCodeService(deps.logger).ensureReady(signal),
    }),
  );
  router.route(
    '/tool-output-screens',
    createToolOutputScreensRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route(
    '/memory-screens',
    createMemoryScreensRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route(
    '/git-commit-identity',
    createGitCommitIdentityRouter({
      globalSettingsStore: deps.globalSettingsStore,
      personalizationStore: deps.personalizationStore,
      resolveRequestContext: deps.resolveRequestContext,
      logger: deps.logger,
    }),
  );
  router.route(
    '/memory-recalls',
    createMemoryRecallRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route(
    '/memory-summarize',
    createMemorySummarizeRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route(
    '/memory-page-sorting',
    createMemoryPageSortingRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route(
    '/memory-nightly',
    createMemoryNightlyRouter({
      globalSettingsStore: deps.globalSettingsStore,
      memoryTidy: deps.memoryTidy,
      logger: deps.logger,
    }),
  );
  router.route(
    '/first-run-guide',
    createFirstRunGuideRouter({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    }),
  );
  router.route('/token-factory-usage', createTokenFactoryUsageRouter({ budget: deps.tokenFactoryBudget }));
  return router;
}
