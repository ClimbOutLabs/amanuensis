/**
 * The search declaration of a server the person designates as the web search provider, read
 * from the server's own tool list at designation time. The split is stored on the connector
 * record and every consumer of the designation reads it from there; nothing downstream
 * recognises a provider by its address or keeps a list of tool names.
 *
 * A tool counts only when the server itself declares it read-only and open-world: a
 * designated provider's silent running is for reading the open web, and a server's word
 * that a tool only reads and reaches beyond itself is the claim the rest of the permission
 * layer already works from. A read-only tool the server declares closed-world, or leaves
 * undeclared, is the server's own internal reading, not web search, so it is not captured
 * and keeps asking like any other connector tool. Between the captured tools, a page
 * reader is the one whose own input schema takes the address of the page to read, in a
 * `url` or `urls` argument; every other captured tool is a search tool, whose results are
 * recorded as search hits.
 */

/** One tool of a server's own list, with the parts of its declaration the capture reads. */
export interface SearchProviderToolListEntry {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> | undefined } | undefined;
  annotations?:
    | { readOnlyHint?: boolean | undefined; openWorldHint?: boolean | undefined }
    | undefined;
}

/** The declaration captured from one server's tool list. */
export interface SearchProviderToolDeclaration {
  /** Bare names of the server's search tools: read-only, open-world tools that take no page address. */
  search_tools: string[];
  /** Bare names of the server's page-read tools: read-only, open-world tools that take the page address they read. */
  page_read_tools: string[];
}

/** The argument names a page reader takes the address of the page to read in. */
const PAGE_ADDRESS_ARGUMENTS: ReadonlySet<string> = new Set(['url', 'urls']);

export function declaredSearchProviderTools(
  tools: readonly SearchProviderToolListEntry[],
): SearchProviderToolDeclaration {
  const search_tools: string[] = [];
  const page_read_tools: string[] = [];
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.openWorldHint !== true) {
      continue;
    }
    const properties = tool.inputSchema?.properties ?? {};
    const readsPage = Object.keys(properties).some(name => PAGE_ADDRESS_ARGUMENTS.has(name.toLowerCase()));
    if (readsPage) {
      if (!page_read_tools.includes(tool.name)) {
        page_read_tools.push(tool.name);
      }
    } else if (!search_tools.includes(tool.name)) {
      search_tools.push(tool.name);
    }
  }
  return { search_tools, page_read_tools };
}
