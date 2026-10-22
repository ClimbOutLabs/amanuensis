/**
 * Builds a structured XML system prompt as a tree of named sections.
 *
 * Each node is an XML section (e.g. `<sandbox>`) that can contain
 * plain text and/or nested sections. Children are always rendered
 * in insertion order.
 *
 * @example
 * // Creating nested and sibling sections:
 *
 * const root = InstructionBuilder.createSystemPrompt(rootAgentIdentity({ assistantName: 'Nata' }));
 *
 * // Add a leaf section (tag + text, no further nesting)
 * root.addSection('rules', 'Follow these rules...');
 *
 * // Add raw text without a wrapping tag
 * root.addContent('Some standalone text');
 *
 * // Begin a section you want to nest into — returns the child builder
 * const capabilities = root.beginSection('capabilities');
 * capabilities.addSection('tool-a', 'Tool A instructions');
 * capabilities.addSection('tool-b', 'Tool B instructions');
 *
 * // Nest deeper — beginSection on a child
 * const sandbox = capabilities.beginSection('sandbox');
 * sandbox.addContent('Sandbox overview');
 * sandbox.addSection('skill', 'Skill details');
 *
 * // Back to root level — just use the root reference again
 * root.addSection('user-instructions', userInput, true); // escapeContent = true
 *
 * console.log(root.build());
 *
 * // Output:
 * // <system-prompt>
 * //   <agent-identity>...</agent-identity>
 * //   <rules>Follow these rules...</rules>
 * //   Some standalone text
 * //   <capabilities>
 * //     <tool-a>Tool A instructions</tool-a>
 * //     <tool-b>Tool B instructions</tool-b>
 * //     <sandbox>
 * //       Sandbox overview
 * //       <skill>Skill details</skill>
 * //     </sandbox>
 * //   </capabilities>
 * //   <user-instructions><![CDATA[...]]></user-instructions>
 * // </system-prompt>
 */

import { DEFAULT_ASSISTANT_NAME } from './personas/assistantName';

/** Names for a root identity. Missing, null or blank values use the fallbacks on `rootAgentIdentity`. */
export interface RootAgentNames {
  assistantName?: string | null | undefined;
  /** The name the person asked to be called by, such as a preferred name. */
  personName?: string | null | undefined;
}

function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * The identity of the root assistant. Without a person name the wording speaks of "the person you work for"
 * instead of a possessive, so the text never reads "the person you work for's".
 */
export function rootAgentIdentity({ assistantName, personName }: RootAgentNames): string {
  const assistant = nonBlank(assistantName) ?? DEFAULT_ASSISTANT_NAME;
  const person = nonBlank(personName);
  if (person === undefined) {
    return `You are ${assistant}, chief of staff to the person you work for. You keep track of their life: appointments, deadlines, messages, plans and promises. You work only for them, on their own computer. Be brief, warm and concrete. Check with them before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.`;
  }
  return `You are ${assistant}, ${person}'s chief of staff. You keep track of ${person}'s life: appointments, deadlines, messages, plans and promises. You work only for ${person}, on their own computer. Be brief, warm and concrete. Check with ${person} before anything important or anything that leaves their computer. Never invent facts: if you did not read it, say so.`;
}

export class InstructionBuilder {
  /** The XML tag name for this section node. */
  private currentTag: string;
  private escapeContent: boolean;
  private children: (string | InstructionBuilder)[] = [];

  constructor(currentTag: string, escapeContent = false) {
    this.currentTag = currentTag;
    this.escapeContent = escapeContent;
  }

  /** Creates the root `<system-prompt>` node with the given identity in `<agent-identity>`. */
  static createSystemPrompt(identity: string): InstructionBuilder {
    const builder = new InstructionBuilder('system-prompt');
    builder.addSection('agent-identity', identity);
    return builder;
  }

  /** Adds raw text (no wrapping tag) to this section. Empty strings are ignored. */
  addContent(content: string): this {
    const trimmed = content.trim();
    if (trimmed) {
      this.children.push(trimmed);
    }
    return this;
  }

  /**
   * Adds a leaf section: `<tag>content</tag>`. Empty content is ignored.
   * Set escapeContent = true to wrap content in CDATA (for arbitrary/untrusted text).
   */
  addSection(tag: string, content: string, escapeContent = false): this {
    const trimmed = content.trim();
    if (!trimmed) {
      return this;
    }
    const child = new InstructionBuilder(tag, escapeContent);
    child.children.push(trimmed);
    this.children.push(child);
    return this;
  }

  /** Creates a nested section and returns it so you can add children to it. */
  beginSection(tag: string): InstructionBuilder {
    const child = new InstructionBuilder(tag);
    this.children.push(child);
    return child;
  }

  /** Recursively renders the tree into an XML string. Empty sections are skipped. */
  build(): string {
    const inner: string[] = [];
    for (const child of this.children) {
      if (typeof child === 'string') {
        inner.push(child);
      } else {
        const output = child.build();
        if (output) {
          inner.push(output);
        }
      }
    }

    if (inner.length === 0) {
      return '';
    }

    const body = inner.join('\n\n');
    if (this.escapeContent) {
      return `<${this.currentTag}><![CDATA[\n${body}\n]]></${this.currentTag}>`;
    }
    return `<${this.currentTag}>\n${body}\n</${this.currentTag}>`;
  }
}
