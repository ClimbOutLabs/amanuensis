# Plan: Attribution footer

Spec: `specs/001-attribution-footer/spec.md`

> Retrospective example. Kept brief on purpose.

## Approach

Render the footer as part of the artifact template rather than the content
body, so user edits to the body (REQ-3) cannot remove or alter it. The
footer component takes the artifact metadata (created timestamp, assistant
identity) as props.

## Files and interfaces

- Artifact rendering templates: add footer slot below content body.
- Footer component: props `{ generatedAt, assistantName }`, muted styling.

## Decisions

1. Decision: footer lives in the template, not the stored content.
   - Considered: appending footer text into the content itself.
   - Chosen because: content edits would destroy it; REQ-3 requires
     durability.

## Risks

- Risk: existing artifacts rendered before this change have no footer.
  Mitigation: footer renders from metadata at view time, so it applies
  retroactively.

## Test strategy

- AC-1, AC-2 → component test: render artifact, assert footer present with
  notice, timestamp, name.
- AC-3 → edit body, re-render, assert footer unchanged.
- AC-4 → style assertion: footer type scale below body.
