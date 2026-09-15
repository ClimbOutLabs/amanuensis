/**
 * Minimal local typings for the parts of `bash-parser`'s AST that
 * execResultSemantics.ts actually reads. `bash-parser` ships no types of its
 * own and has no published `@types` package, so these are hand-written
 * against its documented node shapes rather than generated. The ambient
 * module declaration in `../../types/bash-parser.d.ts` uses `ParseShell`
 * below to give the untyped `bash-parser` import a compiler-checked shape.
 */

export interface WordExpansion {
  type: string;
  /**
   * Present on a `ParameterExpansion` node (e.g. `${VAR:-default}`): the
   * parsed default/alternative value, itself a Word that can carry its own
   * nested expansions (including a disqualifying CommandExpansion or
   * ArithmeticExpansion).
   */
  word?: WordNode;
}

export interface WordNode {
  type: 'Word';
  text: string;
  expansion?: WordExpansion[];
}

export interface RedirectNode {
  type: 'Redirect';
}

export type CommandPart = WordNode | RedirectNode | { type: string };

export interface AssignmentWordNode {
  type: 'AssignmentWord';
  text: string;
}

export interface CommandNode {
  type: 'Command';
  name: WordNode;
  prefix?: (AssignmentWordNode | RedirectNode)[];
  suffix?: CommandPart[];
  async?: boolean;
}

export interface PipelineNode {
  type: 'Pipeline';
  commands: (CommandNode | OtherNode)[];
  /** Set when the pipeline is negated with a leading `!`. */
  bang?: boolean;
}

export interface OtherNode {
  type: string;
}

export interface BashScript {
  type: 'Script';
  commands: (CommandNode | PipelineNode | OtherNode)[];
}

export type ParseShell = (source: string) => BashScript;
