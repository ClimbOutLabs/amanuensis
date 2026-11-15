import type { FC, SVGProps } from 'react';

import ConfluenceLogo from './catalog/mcp-confluence.svg';
import ExaLogo from './catalog/mcp-exa.svg';
import GithubLogo from './catalog/mcp-github.svg';
import JiraLogo from './catalog/mcp-jira.svg';
import LinearLogo from './catalog/mcp-linear.svg';
import NotionLogo from './catalog/mcp-notion.svg';
import PosthogLogo from './catalog/mcp-posthog.svg';
import SentryLogo from './catalog/mcp-sentry.svg';
import StripeLogo from './catalog/mcp-stripe.svg';
import SupabaseLogo from './catalog/mcp-supabase.svg';
import TavilyLogo from './catalog/mcp-tavily.svg';
import AlibabaLogo from './catalog/model-alibaba.svg';
import AnthropicLogo from './catalog/model-anthropic.svg';
import FireworksLogo from './catalog/model-fireworks.svg';
import GoogleGeminiLogo from './catalog/model-google-gemini.svg';
import MoonshotLogo from './catalog/model-moonshot.svg';
import OpenAiLogo from './catalog/model-openai.svg';
import TogetherLogo from './catalog/model-together.svg';
import ZaiLogo from './catalog/model-zai.svg';

export type CatalogLogoKind = 'model' | 'mcp';

/**
 * Logos for the shipped model and MCP catalogs, bundled so the browser never fetches them from
 * another site. Keyed by `<kind>/<catalog name>`: a model provider's `type`, an MCP server's `name`.
 * They draw in `currentColor`, so one file serves light and dark mode.
 */
export const CATALOG_LOGOS: Readonly<Record<string, FC<SVGProps<SVGSVGElement>>>> = {
  'model/openai': OpenAiLogo,
  'model/anthropic': AnthropicLogo,
  'model/google-gemini': GoogleGeminiLogo,
  'model/fireworks': FireworksLogo,
  'model/zai': ZaiLogo,
  'model/moonshot': MoonshotLogo,
  'model/alibaba': AlibabaLogo,
  'model/together': TogetherLogo,
  'mcp/linear': LinearLogo,
  'mcp/notion': NotionLogo,
  'mcp/sentry': SentryLogo,
  'mcp/exa': ExaLogo,
  'mcp/github': GithubLogo,
  'mcp/tavily': TavilyLogo,
  'mcp/supabase': SupabaseLogo,
  'mcp/stripe': StripeLogo,
  'mcp/confluence': ConfluenceLogo,
  'mcp/jira': JiraLogo,
  'mcp/posthog': PosthogLogo,
};
