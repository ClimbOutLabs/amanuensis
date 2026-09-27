import fuzzysort from "fuzzysort";
import { Box, Text } from "ink";
import { Fragment, memo, useMemo } from "react";
import { defaultBindings, type KeyBinding, type KeyCategory } from "../keymap.js";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  theme: Theme;
  filter: string;
  cursor: number;
}

// Category render order — most-used-first. Keeps the unfiltered grid stable
// across releases (vs. derive-from-data which would jitter if a category
// loses or gains its first binding).
const CATEGORY_ORDER: KeyCategory[] = ["Movement", "Panes", "Folders", "Actions", "UI", "Misc"];

// `keys` column width — the longest key id we display is `Escape` (6 chars).
const KEY_COL = 7;

function HelpModalImpl({ theme, filter, cursor }: Props) {
  // Unfiltered grid lays out two columns (`left` + `right`) per category;
  // filtered hits collapse into a single ranked list with character-level
  // highlights so the user can see WHY a row matched.
  const filtered = useMemo(() => filterBindings(filter), [filter]);

  if (filter.length > 0) {
    return (
      <ModalScreen theme={theme} title="Keybindings" footerHint={filteredFooter()}>
        <PromptRow theme={theme} filter={filter} hits={filtered.length} />
        <Box height={1} />
        {filtered.length === 0 ? (
          <ModalRow theme={theme} color={theme.dim}>
            no matches — press Esc to clear or close help
          </ModalRow>
        ) : (
          filtered.map((hit, i) => (
            <FilteredRow
              key={hit.binding.keys}
              theme={theme}
              hit={hit}
              selected={i === Math.min(cursor, filtered.length - 1)}
            />
          ))
        )}
      </ModalScreen>
    );
  }

  // Unfiltered: categorised + two-column grid.
  const grouped = groupByCategory();
  return (
    <ModalScreen theme={theme} title="Keybindings" footerHint={unfilteredFooter()}>
      <PromptRow theme={theme} filter={filter} hits={defaultBindings.length} />
      {CATEGORY_ORDER.map((category) => {
        const items = grouped[category];
        if (!items || items.length === 0) return null;
        const half = Math.ceil(items.length / 2);
        const left = items.slice(0, half);
        const right = items.slice(half);
        return (
          <Fragment key={category}>
            <Box height={1} />
            <ModalRow theme={theme} bold color={theme.accent}>
              {category}
            </ModalRow>
            <Box flexDirection="row">
              <Box flexDirection="column" width={48}>
                {left.map((b) => (
                  <PlainRow key={b.keys} theme={theme} binding={b} />
                ))}
              </Box>
              <Box flexDirection="column">
                {right.map((b) => (
                  <PlainRow key={b.keys} theme={theme} binding={b} />
                ))}
              </Box>
            </Box>
          </Fragment>
        );
      })}
    </ModalScreen>
  );
}

function PromptRow({ theme, filter, hits }: { theme: Theme; filter: string; hits: number }) {
  // Mirrors the sesh fzf popup: a fixed prompt char, then the live filter
  // text + a block-cursor character so the user can see the insertion point.
  return (
    <Text backgroundColor={theme.modalBg}>
      <Text color={theme.accent} backgroundColor={theme.modalBg} bold>
        {"⚡ "}
      </Text>
      <Text color={theme.fg} backgroundColor={theme.modalBg}>
        {filter}
      </Text>
      <Text color={theme.accent} backgroundColor={theme.modalBg}>
        {"_"}
      </Text>
      <Text color={theme.dim} backgroundColor={theme.modalBg}>
        {`   ${hits} match${hits === 1 ? "" : "es"}`}
      </Text>
    </Text>
  );
}

function PlainRow({ theme, binding }: { theme: Theme; binding: KeyBinding }) {
  return (
    <ModalRow theme={theme}>
      <Text color={theme.accent} backgroundColor={theme.modalBg}>
        {`  ${binding.keys.padEnd(KEY_COL)}`}
      </Text>
      <Text color={theme.fg} backgroundColor={theme.modalBg}>
        {` ${binding.desc}`}
      </Text>
    </ModalRow>
  );
}

interface FilteredHit {
  binding: KeyBinding;
  // Indexes of matched characters in the joined "keys + desc" string —
  // produced by fuzzysort.go's `indexes` array; used to bold the chars
  // that participated in the match.
  keysIdx: readonly number[];
  descIdx: readonly number[];
}

function FilteredRow({
  theme,
  hit,
  selected,
}: {
  theme: Theme;
  hit: FilteredHit;
  selected: boolean;
}) {
  const bg = selected ? theme.selectedBg : theme.modalBg;
  const fg = selected ? theme.selectedFg : theme.fg;
  const accentColor = selected ? theme.selectedFg : theme.accent;
  return (
    <ModalRow theme={theme} backgroundColor={bg}>
      <Text color={accentColor} backgroundColor={bg}>
        {`  ${selected ? "❯" : " "} `}
      </Text>
      <HighlightedText
        text={hit.binding.keys.padEnd(KEY_COL)}
        // Highlight only the chars that participated in the match — fuzzysort
        // returns absolute indexes into the original (un-padded) string, so a
        // padded display still highlights at the right offsets.
        matchIdx={hit.keysIdx}
        baseColor={accentColor}
        matchColor={accentColor}
        backgroundColor={bg}
        boldMatch
      />
      <Text color={fg} backgroundColor={bg}>
        {" "}
      </Text>
      <HighlightedText
        text={hit.binding.desc}
        matchIdx={hit.descIdx}
        baseColor={fg}
        matchColor={theme.accent}
        backgroundColor={bg}
        boldMatch
      />
    </ModalRow>
  );
}

function HighlightedText({
  text,
  matchIdx,
  baseColor,
  matchColor,
  backgroundColor,
  boldMatch,
}: {
  text: string;
  matchIdx: readonly number[];
  baseColor: string;
  matchColor: string;
  backgroundColor: string;
  boldMatch: boolean;
}) {
  if (matchIdx.length === 0) {
    return (
      <Text color={baseColor} backgroundColor={backgroundColor}>
        {text}
      </Text>
    );
  }
  // Walk the string and emit alternating <Text> chunks for matched vs
  // unmatched characters. fuzzysort's indexes are sorted ascending. We
  // capture each chunk's starting offset to use as its stable key — chunk
  // boundaries are deterministic for a given (text, matchIdx) pair.
  const matches = new Set(matchIdx);
  const chunks: Array<{ s: string; hit: boolean; offset: number }> = [];
  let current = { s: "", hit: matches.has(0), offset: 0 };
  for (let i = 0; i < text.length; i++) {
    const hit = matches.has(i);
    if (hit !== current.hit && current.s.length > 0) {
      chunks.push(current);
      current = { s: "", hit, offset: i };
    }
    current.s += text[i];
  }
  if (current.s.length > 0) chunks.push(current);
  return (
    <>
      {chunks.map((c) => (
        <Text
          key={`${c.offset}:${c.s}`}
          color={c.hit ? matchColor : baseColor}
          backgroundColor={backgroundColor}
          bold={c.hit && boldMatch}
        >
          {c.s}
        </Text>
      ))}
    </>
  );
}

function groupByCategory(): Record<KeyCategory, KeyBinding[]> {
  const out = {} as Record<KeyCategory, KeyBinding[]>;
  for (const b of defaultBindings) {
    if (!out[b.category]) out[b.category] = [];
    out[b.category].push(b);
  }
  return out;
}

function filterBindings(filter: string): FilteredHit[] {
  const q = filter.trim();
  if (q.length === 0) return [];
  // Score against `keys` + `desc` separately so a hit on either column wins.
  // Threshold is permissive — sesh's fzf is permissive by default and users
  // expect "spm" to find "Mark as spam".
  const results = fuzzysort.go(q, defaultBindings, {
    keys: ["keys", "desc"],
    threshold: -10_000,
    limit: 100,
  });
  return results.map((r) => {
    // `r` is `{ obj, [0]: keysResult, [1]: descResult, score }`. The per-key
    // result objects expose `indexes` (the matched-char offsets).
    const keysRes = r[0];
    const descRes = r[1];
    return {
      binding: r.obj,
      keysIdx: keysRes?.indexes ?? [],
      descIdx: descRes?.indexes ?? [],
    };
  });
}

function unfilteredFooter(): string {
  return "type to filter • Esc / ? to close";
}

function filteredFooter(): string {
  return "j/k cursor • Esc to clear filter • ? to close";
}

export const HelpModal = memo(HelpModalImpl);
