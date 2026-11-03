# Editable space preamble

Status: approved

## Problem

A space built with section markers (`<!-- @block:name -->`) splits into blocks that
edit_space can change one at a time. The text before the first marker, the preamble,
is not one of those blocks: no anchor names it, so no edit can ever change it. The
HTML shape the space tools teach puts the page header first, in a `.page-header`
element, so when a space is written or converted as HTML with sections, its title
and header land in the preamble and stay frozen for the life of the space. A person
who asks for a header change is told it cannot be done, short of rebuilding the
space or rolling it back to an older revision.

## The change

A preamble that holds any content becomes a block in its own right, under the
reserved anchor `preamble`. It is listed first wherever anchors and fingerprints
are shown: list_blocks, get_space, and the block outline an edit result returns.
edit_space block entries can replace it with the same fingerprint check every
other block gets, and insert entries can add content right after it. The
preamble's replaceable content ends where the separator before the first marker
begins, so a change keeps that separator. Emptying the preamble is allowed; the
existing refusal of a wholly empty body still applies. The separate preamble
summary list_blocks has always returned stays as it is, for current readers.

## Design decisions

- The preamble block is listed only when the preamble holds content. An empty or
  whitespace-only preamble has nothing to replace, and leaving it unlisted keeps
  the outlines of marker-first spaces exactly as they are today.
- If a marker is itself named `preamble`, that marker keeps the anchor, and the
  text before the first marker stays unaddressable in that space. One anchor
  never names two things.
- No safety check loosens. A read taken before the preamble changed cannot carry
  an edit to a later block: the preamble sits before every block, and stale-read
  handling already refuses when it changed. The shrink guard and the link and
  picture checks judge the final body, so they cover preamble edits unchanged.

## Out of scope

- Recognising HTML headings as blocks in spaces without markers.
- Any markdown to HTML conversion of a space body.
- Removing the separate preamble summary from list_blocks.

## Privacy

No new data flows. Space bodies already live on the person's own instance, and
this change only widens which part of a body the editing tools can address. It
collects nothing, sends nothing anywhere new, and changes no sharing behaviour.

## Testing

Tests use synthetic data only, never a person's real spaces. The space tool
suites gain cases for: replacing an HTML page header through the `preamble`
anchor with the rest of the body byte-identical; a wrong fingerprint refusing
and saving nothing; the marker-named-`preamble` collision; a stale read refusing
after the preamble changed; emptying a preamble; an insert after the preamble;
and an unseen link being left out of a preamble replacement, as with any block.
Existing space suites stay green, with the few expectations that pinned the old
unaddressable behaviour updated to the new one.
