# Model compatibility corpus

Real structured-edit tool-argument shapes, one JSON fixture per case, replayed through
`normalizeStructuredEditArguments` and the existing `extractStructuredEditPaths` pipeline by
`tests/core/sandbox/corpus.test.ts`. This is the regression net for "a model sent a shape we
had not seen before" bugs: fix the shape once in `toolArgumentNormalization.ts`, then add the
shape here so it never regresses silently.

## Layout

```
corpus/<model>/<case>.json
```

`<model>` is the model (or model family) whose real output the case is drawn from, or `generic`
for a shape that is not model-specific (an absolute path, a Unicode punctuation variant, a
baseline already-correct shape used to prove the normaliser is a no-op on well-formed input).
`<case>` is a short, specific, kebab-case name for the shape.

## Fixture shape

```jsonc
{
  "tool": "apply_patch" | "replace_text" | "write_file",
  "args": { /* the raw tool-call arguments, exactly as the model sent them */ },
  "cwd": "/repo",              // the effective cwd for this call
  "repositoryRoot": "/repo",   // the bound repository's workspace root
  "expect": {
    "ok": true,                 // whether the normalized argument should validate
    "normalizedPath": "src/a.ts", // replace_text/write_file only: the expected cwd-relative path
    "notes": ["..."],           // optional: normalisation notes that must appear (subset check)
    "matchStatus": "exact_match" // replace_text with a --fixture.txt companion only: the expected
                                 // matcher status ("exact_match" | "ambiguous" | "no_match").
                                 // Defaults to "exact_match" when `expect.ok` is true, or
                                 // "no_match" when `expect.ok` is false. old_text, after
                                 // normalisation (BOM strip, CRLF-to-LF), must occur exactly once
                                 // in the fixture file content, tried verbatim first and, only if
                                 // that misses, with a uniform line-number gutter stripped (see
                                 // replaceTextDiagnostics.ts) — the host never guesses at a
                                 // match, so a fixture whose old_text differs from the file by
                                 // anything beyond that (a whitespace or indentation drift, a
                                 // CRLF file against LF old_text) is expected to reject as
                                 // "no_match", not to match.
  }
}
```

For `apply_patch`, `expect.ok` is checked against `extractStructuredEditPaths` on the
normalized `patch`. For `replace_text`/`write_file`, it is checked against
`extractStructuredEditPaths` on the normalized `path`. When `expect.ok` is `false`, the test
also asserts the resulting failure message contains both `received` and `expected`, per the
rejection contract in `structuredEditRejection.ts`.

## Adding a case from a bug bundle

1. Find the exact tool-call arguments the model sent (the raw `args` object — patch text,
   `old_text`/`new_text`, `path`, `cwd` — not a paraphrase of it). The audit log or the sandbox
   tool-call transcript has this verbatim.
2. Create `corpus/<model>/<short-kebab-case-description>.json` with that `args` (redact secrets
   or anything not relevant to the shape bug — the fixture only needs to reproduce the shape,
   not the original file contents), the `cwd`/`repositoryRoot` the call actually ran against,
   and an `expect` block describing the correct outcome.
3. Run `pnpm --filter @truefoundry/trueforge-core test -- corpus.test.ts` and confirm the new
   case fails before any fix and passes after one (either a `toolArgumentNormalization.ts` rule
   or, if the shape is a genuinely new rejection, a `structuredEditRejection` call site with a
   `received`/`expected` pair specific enough for a retrying model to fix its next attempt).
4. If the fix changes `toolArgumentNormalization.ts`, also add a focused unit test in
   `toolArgumentNormalization.test.ts` for the rule in isolation — the corpus case proves the
   end-to-end shape works; the unit test proves the rule itself is correct.
