/**
 * Ambient module declaration for `bash-parser`. The package ships no types
 * of its own and has no published `@types` package, so this hand-written
 * declaration gives the default export a compiler-checked signature instead
 * of an `@ts-expect-error` + `as` cast at each import site.
 *
 * The signature is an inline `import(...)` type reference rather than a
 * top-level `import` statement on purpose: with a top-level `import` here,
 * tsc stops treating this file's `declare module 'bash-parser'` as an
 * ambient module declaration for the real `bash-parser` package and falls
 * back to reporting an implicit `any` at every import site - the inline
 * form avoids that.
 *
 * The referenced AST shape lives in `../core/sandbox/bashParserTypes.ts`,
 * hand-written against bash-parser's documented output for the properties
 * execResultSemantics.ts reads.
 */
declare module 'bash-parser' {
  const parseShell: import('../core/sandbox/bashParserTypes').ParseShell;
  export default parseShell;
}
