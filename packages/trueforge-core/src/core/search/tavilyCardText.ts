import {
  TAVILY_API_HOST,
  TAVILY_EXTRACT_TOOL_NAME,
  TAVILY_SEARCH_CREDITS,
  TAVILY_SEARCH_TOOL_NAME,
} from './TavilyClient';

const NO_KEY_NOTE = "If you have not added a Tavily key, it uses Tavily's free allowance instead.";

function creditWord(count: number): string {
  return `${String(count)} Tavily ${count === 1 ? 'credit' : 'credits'}`;
}

/**
 * The approval sentence for a Tavily call: the exact words or links, where they go, and what it costs.
 * Only for a call the host itself served from api.tavily.com; null for anything else.
 */
export function tavilyApprovalWhat(input: {
  server_host: string | undefined;
  tool_name: string;
  canonical_params: Record<string, unknown>;
  /** Most characters of the query or link list to show. */
  max_chars: number;
}): string | null {
  if (input.server_host !== TAVILY_API_HOST) {
    return null;
  }
  const cut = (text: string): string => (text.length > input.max_chars ? `${text.slice(0, input.max_chars)}...` : text);
  const { query, urls } = input.canonical_params;
  if (input.tool_name === TAVILY_SEARCH_TOOL_NAME && typeof query === 'string') {
    return (
      `Search the web with Tavily for: ${cut(query)}. This sends those words to ${TAVILY_API_HOST} ` +
      `and uses ${creditWord(TAVILY_SEARCH_CREDITS)}. ${NO_KEY_NOTE}`
    );
  }
  if (input.tool_name === TAVILY_EXTRACT_TOOL_NAME && Array.isArray(urls)) {
    const links = urls.filter((url): url is string => typeof url === 'string').join(', ');
    return (
      `Read these web pages with Tavily: ${cut(links)}. This sends those links to ${TAVILY_API_HOST} ` +
      `and uses up to ${creditWord(1)}. ${NO_KEY_NOTE}`
    );
  }
  return null;
}
