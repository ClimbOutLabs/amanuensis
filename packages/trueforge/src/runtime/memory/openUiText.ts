/**
 * The words a person reads in an OpenUI block, one sentence per heading, table row, list item or card.
 * The block is a small program (`name = Component(...)`), so the text is found by walking the components
 * from `root`, not by stripping tags. Data that only exists at run time (`@Each`, `$filter`, a query) has
 * no words here and is skipped. Never throws: a block that does not parse yields no sentences.
 */

/** Most tokens read from one block; a longer block is a wall of data, not advice. */
const MAX_TOKENS = 20_000;
/** Deepest component nesting walked; past it the rest is skipped. */
const MAX_DEPTH = 32;
/** Most sentences taken from one block. */
const MAX_SENTENCES = 200;
/** Most rows read from one table. */
const MAX_TABLE_ROWS = 60;

type Token =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string };

type Node =
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: Node[] }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'ref'; name: string }
  | { kind: 'either'; branches: Node[] }
  | { kind: 'other' };

const PUNCT = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '.', '?']);
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '=', '<', '>', '+', '-', '*', '/', '!'];

function isNameStart(char: string): boolean {
  return /[\p{L}_@$]/u.test(char);
}

function isNameChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/** The tokens of a block, or undefined when the text has a shape the language does not have. */
function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length && tokens.length < MAX_TOKENS) {
    const char = source[i] ?? '';
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === '"') {
      let value = '';
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i] ?? '';
        if (c === '\\') {
          const next = source[i + 1] ?? '';
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else if (c === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          value += c;
          i += 1;
        }
      }
      if (!closed) {
        return undefined;
      }
      tokens.push({ kind: 'string', value });
    } else if (/[0-9]/.test(char)) {
      let end = i + 1;
      while (end < source.length && /[0-9.]/.test(source[end] ?? '')) {
        end += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(i, end) });
      i = end;
    } else if (isNameStart(char)) {
      let end = i + 1;
      while (end < source.length && isNameChar(source[end] ?? '')) {
        end += 1;
      }
      tokens.push({ kind: 'name', value: source.slice(i, end) });
      i = end;
    } else if (PUNCT.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
    } else {
      const operator = OPERATORS.find(op => source.startsWith(op, i));
      if (operator === undefined) {
        return undefined;
      }
      tokens.push({ kind: 'punct', value: operator });
      i += operator.length;
    }
  }
  return tokens;
}

/** Reads `name = expression` statements into a map; a block that does not parse yields an empty map. */
class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  statements(): Map<string, Node> {
    const definitions = new Map<string, Node>();
    try {
      while (this.index < this.tokens.length) {
        const name = this.tokens[this.index];
        const equals = this.tokens[this.index + 1];
        if (name?.kind !== 'name' || equals?.kind !== 'punct' || equals.value !== '=') {
          return new Map();
        }
        this.index += 2;
        definitions.set(name.value, this.expression());
      }
    } catch {
      return new Map();
    }
    return definitions;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && token.value === value;
  }

  private expect(value: string): void {
    if (!this.isPunct(value)) {
      throw new Error(`expected ${value}`);
    }
    this.index += 1;
  }

  /** An operand, then any run of binary operators and at most one ternary; only the text-bearing parts survive. */
  private expression(): Node {
    const node = this.operand();
    let plain = true;
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'punct' || token.value === '=' || !OPERATORS.includes(token.value)) {
        break;
      }
      this.index += 1;
      this.operand();
      plain = false;
    }
    if (this.isPunct('?')) {
      this.index += 1;
      const yes = this.expression();
      this.expect(':');
      const no = this.expression();
      return { kind: 'either', branches: [yes, no] };
    }
    return plain ? node : { kind: 'other' };
  }

  private operand(): Node {
    const token = this.peek();
    if (token === undefined) {
      throw new Error('unexpected end');
    }
    if (token.kind === 'punct' && (token.value === '!' || token.value === '-')) {
      this.index += 1;
      this.operand();
      return { kind: 'other' };
    }
    if (token.kind === 'punct' && token.value === '(') {
      this.index += 1;
      const inner = this.expression();
      this.expect(')');
      return inner;
    }
    let node = this.primary(token);
    for (;;) {
      if (this.isPunct('.')) {
        this.index += 1;
        const field = this.peek();
        if (field?.kind !== 'name') {
          throw new Error('expected a field name');
        }
        this.index += 1;
        node = { kind: 'other' };
      } else if (this.isPunct('[')) {
        this.index += 1;
        this.expression();
        this.expect(']');
        node = { kind: 'other' };
      } else {
        return node;
      }
    }
  }

  private primary(token: Token): Node {
    this.index += 1;
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'number':
        return { kind: 'string', value: token.value };
      case 'name': {
        if (this.isPunct('(')) {
          this.index += 1;
          const args = this.list(')');
          return { kind: 'call', name: token.value, args };
        }
        if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
          return { kind: 'other' };
        }
        return token.value.startsWith('$') ? { kind: 'other' } : { kind: 'ref', name: token.value };
      }
      case 'punct':
        if (token.value === '[') {
          return { kind: 'array', items: this.list(']') };
        }
        if (token.value === '{') {
          this.object();
          return { kind: 'other' };
        }
        throw new Error(`unexpected ${token.value}`);
    }
  }

  private list(close: string): Node[] {
    const items: Node[] = [];
    while (!this.isPunct(close)) {
      items.push(this.expression());
      if (this.isPunct(',')) {
        this.index += 1;
      } else if (!this.isPunct(close)) {
        throw new Error(`expected ${close}`);
      }
    }
    this.index += 1;
    return items;
  }

  private object(): void {
    while (!this.isPunct('}')) {
      const key = this.peek();
      if (key?.kind !== 'name' && key?.kind !== 'string') {
        throw new Error('expected a key');
      }
      this.index += 1;
      this.expect(':');
      this.expression();
      if (this.isPunct(',')) {
        this.index += 1;
      }
    }
    this.index += 1;
  }
}

/** Components that are controls, pictures, code or charts: nothing in them is advice. */
const SILENT = new Set([
  'Image',
  'ImageBlock',
  'ImageGallery',
  'CodeBlock',
  'Separator',
  'Button',
  'Buttons',
  'FormControl',
  'Input',
  'Select',
  'SelectItem',
  'TextArea',
  'Action',
  'BarChart',
  'LineChart',
  'AreaChart',
  'RadarChart',
  'HorizontalBarChart',
  'PieChart',
  'RadialChart',
  'SingleStackedBarChart',
  'ScatterChart',
  'Series',
  'Slice',
  'ScatterSeries',
  'Point',
]);

const MARKDOWN_LINE_MARK = /^(?:#{1,6}\s+|(?:[-*•]|\d{1,3}[.)])\s+|>\s*)/;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Markdown text as sentences: every heading and list item on its own, the rest joined as prose. */
function markdownSentences(text: string): string[] {
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) {
      out.push(prose.join(' '));
      prose = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = clean(raw.replace(/\*\*|__|`/g, ''));
    if (line === '') {
      flush();
    } else if (MARKDOWN_LINE_MARK.test(line)) {
      flush();
      out.push(clean(line.replace(MARKDOWN_LINE_MARK, '')));
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.filter(sentence => sentence !== '');
}

class Walker {
  private readonly open = new Set<string>();

  constructor(private readonly definitions: ReadonlyMap<string, Node>) {}

  /** The one string a node holds (resolving a reference), or undefined when it holds none or several. */
  private text(node: Node | undefined, depth: number): string | undefined {
    if (node === undefined || depth > MAX_DEPTH) {
      return undefined;
    }
    if (node.kind === 'string') {
      return clean(node.value);
    }
    if (node.kind === 'ref') {
      return this.withRef(node.name, target => this.text(target, depth + 1));
    }
    if (node.kind === 'call') {
      const sentences = this.sentences(node, depth + 1);
      return sentences.length === 1 ? sentences[0] : undefined;
    }
    return undefined;
  }

  private withRef<T>(name: string, read: (target: Node) => T): T | undefined {
    const target = this.definitions.get(name);
    if (target === undefined || this.open.has(name)) {
      return undefined;
    }
    this.open.add(name);
    try {
      return read(target);
    } finally {
      this.open.delete(name);
    }
  }

  private items(node: Node | undefined, depth: number): Node[] {
    if (node === undefined || depth > MAX_DEPTH) {
      return [];
    }
    if (node.kind === 'array') {
      return node.items;
    }
    if (node.kind === 'ref') {
      return this.withRef(node.name, target => this.items(target, depth + 1)) ?? [];
    }
    return [];
  }

  /** The sentences of a table: one per row, its cells apart by ", ". Columns without literal data add no cells. */
  private tableSentences(table: Node, depth: number): string[] {
    const columns = this.items(table.kind === 'call' ? table.args[0] : undefined, depth).flatMap(column => {
      const resolved = column.kind === 'ref' ? this.definitions.get(column.name) : column;
      return resolved?.kind === 'call' && resolved.name === 'Col' ? [this.items(resolved.args[1], depth + 1)] : [];
    });
    const rowCount = Math.min(MAX_TABLE_ROWS, Math.max(0, ...columns.map(cells => cells.length)));
    const rows: string[] = [];
    for (let row = 0; row < rowCount; row += 1) {
      const cells = columns.flatMap(cells => this.text(cells[row], depth + 1) ?? []).filter(cell => cell !== '');
      if (cells.length > 0) {
        rows.push(cells.join(', '));
      }
    }
    return rows;
  }

  /** A card reads as one sentence; a child with several sentences of its own (a table, a list) keeps them apart. */
  private cardSentences(children: readonly Node[], depth: number): string[] {
    const out: string[] = [];
    let inline: string[] = [];
    for (const child of children) {
      const sentences = this.sentences(child, depth + 1);
      if (sentences.length === 1) {
        inline.push(sentences[0] ?? '');
      } else if (sentences.length > 1) {
        if (inline.length > 0) {
          out.push(inline.join(' '));
          inline = [];
        }
        out.push(...sentences);
      }
    }
    if (inline.length > 0) {
      out.push(inline.join(' '));
    }
    return out;
  }

  private titled({ title, body }: { title: string | undefined; body: string | undefined }): string[] {
    const head = title ?? '';
    const rest = body ?? '';
    if (head === '') {
      return rest === '' ? [] : [rest];
    }
    return [rest === '' ? head : `${head}: ${rest}`];
  }

  sentences(node: Node | undefined, depth: number): string[] {
    if (node === undefined || depth > MAX_DEPTH) {
      return [];
    }
    switch (node.kind) {
      case 'string':
        return markdownSentences(node.value);
      case 'array':
        return node.items.flatMap(item => this.sentences(item, depth + 1));
      case 'ref':
        return this.withRef(node.name, target => this.sentences(target, depth + 1)) ?? [];
      case 'either':
        return node.branches.flatMap(branch => this.sentences(branch, depth + 1));
      case 'other':
        return [];
      case 'call':
        return this.componentSentences(node, depth);
    }
  }

  private componentSentences(node: Node & { kind: 'call' }, depth: number): string[] {
    const [first, second, third] = node.args;
    if (SILENT.has(node.name) || node.name.startsWith('@')) {
      return [];
    }
    switch (node.name) {
      case 'TextContent':
      case 'MarkDownRenderer':
        return markdownSentences(this.rawText(first, depth));
      case 'CardHeader':
        return this.titled({ title: this.text(first, depth), body: this.text(second, depth) });
      case 'Callout':
      case 'TextCallout':
        return this.titled({ title: this.text(second, depth), body: this.text(third, depth) });
      case 'StepsItem':
        return this.titled({ title: this.text(first, depth), body: this.text(second, depth) });
      case 'TabItem':
      case 'AccordionItem':
        return [
          ...this.titled({ title: this.text(second, depth), body: undefined }),
          ...this.sentences(third, depth + 1),
        ];
      case 'Tag':
        return this.titled({ title: this.text(first, depth), body: undefined });
      case 'TagBlock': {
        const tags = this.items(first, depth).flatMap(tag => this.text(tag, depth + 1) ?? []);
        return tags.length === 0 ? [] : [tags.join(', ')];
      }
      case 'Table':
        return this.tableSentences(node, depth);
      case 'Card':
        return this.cardSentences(this.items(first, depth), depth);
      default:
        // A layout or unknown component: its nested components may hold words; its own string props are settings.
        return node.args.flatMap(arg => (arg.kind === 'string' ? [] : this.sentences(arg, depth + 1)));
    }
  }

  /** The string a text node holds with its line breaks kept, so markdown lines can be told apart. */
  private rawText(node: Node | undefined, depth: number): string {
    if (node === undefined || depth > MAX_DEPTH) {
      return '';
    }
    if (node.kind === 'string') {
      return node.value;
    }
    if (node.kind === 'ref') {
      return this.withRef(node.name, target => this.rawText(target, depth + 1)) ?? '';
    }
    return '';
  }
}

/** The sentences a person reads in one OpenUI block, walked from `root`. Exported for tests. */
export function openUiSentences(source: string): string[] {
  const tokens = tokenize(source);
  if (tokens === undefined) {
    return [];
  }
  const definitions = new Parser(tokens).statements();
  const root = definitions.get('root');
  if (root === undefined) {
    return [];
  }
  return new Walker(definitions)
    .sentences(root, 0)
    .map(clean)
    .filter(sentence => sentence !== '')
    .slice(0, MAX_SENTENCES);
}
