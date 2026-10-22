"""English text to Kokoro phoneme strings, using misaki's word lists only.

Words are looked up in misaki's American English gold and silver lists. Numbers,
times, money and ordinals are spelled out first. A word in neither list is tried
without a common ending (-s, -'s, -ed, -ing, -ly), short all-capital words are
read letter by letter, and anything left is sounded out with simple spelling
rules. No espeak, no neural fallback: every piece here is permissively licensed.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from collections.abc import Iterator

# Longest phoneme string handed to the model at once; the model's own limit is
# 510 tokens, and 400 leaves room for the boundary tokens and odd characters.
MAX_CHUNK_CHARS = 400

_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen "
    "fourteen fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((10**9, "billion"), (10**6, "million"), (1000, "thousand"))
_ORDINAL_EXCEPTIONS = {
    "one": "first",
    "two": "second",
    "three": "third",
    "five": "fifth",
    "eight": "eighth",
    "nine": "ninth",
    "twelve": "twelfth",
}


def _under_thousand(n: int) -> list[str]:
    words: list[str] = []
    if n >= 100:
        words += [_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        words.append(_TENS[n // 10])
        n %= 10
        if n:
            words.append(_ONES[n])
    elif n or not words:
        words.append(_ONES[n])
    return words


def number_words(n: int) -> list[str]:
    """Spell a non-negative integer in English words; past a trillion, digit by digit."""
    if n >= 10**12:
        return [_ONES[int(d)] for d in str(n)]
    words: list[str] = []
    for scale, name in _SCALES:
        if n >= scale:
            words += _under_thousand(n // scale) + [name]
            n %= scale
    if n or not words:
        words += _under_thousand(n)
    return words


def ordinal_words(n: int) -> list[str]:
    words = number_words(n)
    last = words[-1]
    if last in _ORDINAL_EXCEPTIONS:
        words[-1] = _ORDINAL_EXCEPTIONS[last]
    elif last.endswith("y"):
        words[-1] = last[:-1] + "ieth"
    else:
        words[-1] = last + "th"
    return words


def _decimal_words(text: str) -> list[str]:
    whole, _, fraction = text.replace(",", "").partition(".")
    words = number_words(int(whole or "0"))
    if fraction:
        words.append("point")
        words += [_ONES[int(d)] for d in fraction]
    return words


def _money_words(text: str) -> list[str]:
    whole, _, cents = text.replace(",", "").partition(".")
    dollars = int(whole or "0")
    words = number_words(dollars) + ["dollar" if dollars == 1 else "dollars"]
    if cents:
        cent_value = int((cents + "0")[:2])
        if cent_value:
            words += number_words(cent_value)
    return words


def _time_words(hours: str, minutes: str) -> list[str]:
    words = number_words(int(hours))
    m = int(minutes)
    if m == 0:
        return words + ["o'clock"]
    if m < 10:
        return words + ["oh"] + number_words(m)
    return words + number_words(m)


_MARKDOWN_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+|www\.\S+")
_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_LIST_MARKER = re.compile(r"^\s*(?:[-*+>]|\d+[.)])\s+")
_STRIP_CHARS = re.compile(r"[*_#`~|<>\[\]{}]")
_SPACES = re.compile(r"\s+")

_TOKEN = re.compile(
    r"(?P<time>\b\d{1,2}:\d{2}\b)"
    r"|(?P<money>\$\d[\d,]*(?:\.\d+)?)"
    r"|(?P<ordinal>\b\d+(?:st|nd|rd|th)\b)"
    r"|(?P<number>\d[\d,]*(?:\.\d+)?)"
    r"|(?P<word>[A-Za-z]+(?:'[A-Za-z]+)*)"
    r"|(?P<punct>\.\.\.|[.,!?;:—…])"
    r"|(?P<symbol>[%&+@=])"
)
_SYMBOL_WORDS = {"%": ["percent"], "&": ["and"], "+": ["plus"], "@": ["at"], "=": ["equals"]}


def normalize(text: str) -> str:
    """Reduce chat Markdown to plain sentences: no code blocks, links read by their text."""
    text = unicodedata.normalize("NFKC", text).replace("’", "'").replace("‘", "'")
    text = _CODE_BLOCK.sub(" ", text)
    text = _MARKDOWN_LINK.sub(r"\1", text)
    text = _URL.sub(" a link ", text)
    lines: list[str] = []
    for raw in text.splitlines():
        line = _SPACES.sub(" ", _STRIP_CHARS.sub(" ", _LIST_MARKER.sub("", raw))).strip()
        if not line:
            continue
        if line[-1] not in ".!?;:,":
            line += "."
        lines.append(line)
    return " ".join(lines)


def _tokens(text: str) -> Iterator[tuple[str, str]]:
    """Yield ('word', w) and ('punct', p) pairs with numbers and symbols spelled out."""
    for match in _TOKEN.finditer(text):
        kind = match.lastgroup
        value = match.group()
        if kind == "word":
            yield "word", value
        elif kind == "punct":
            yield "punct", "…" if value == "..." else value
        elif kind == "time":
            hours, minutes = value.split(":")
            for word in _time_words(hours, minutes):
                yield "word", word
        elif kind == "money":
            for word in _money_words(value[1:]):
                yield "word", word
        elif kind == "ordinal":
            for word in ordinal_words(int(value[:-2])):
                yield "word", word
        elif kind == "number":
            for word in _decimal_words(value):
                yield "word", word
        elif kind == "symbol":
            for word in _SYMBOL_WORDS[value]:
                yield "word", word


# Spelling rules for words in neither list: longest match first.
_SPELLING_RULES: tuple[tuple[str, str], ...] = (
    ("tion", "ʃən"),
    ("sion", "ʒən"),
    ("igh", "I"),
    ("tch", "ʧ"),
    ("th", "θ"),
    ("sh", "ʃ"),
    ("ch", "ʧ"),
    ("ph", "f"),
    ("ck", "k"),
    ("ng", "ŋ"),
    ("qu", "kw"),
    ("wh", "w"),
    ("ee", "i"),
    ("ea", "i"),
    ("oo", "u"),
    ("ou", "W"),
    ("ow", "O"),
    ("oa", "O"),
    ("ai", "A"),
    ("ay", "A"),
    ("oi", "Y"),
    ("oy", "Y"),
    ("au", "ɔ"),
    ("aw", "ɔ"),
    ("er", "əɹ"),
    ("ar", "ɑɹ"),
    ("or", "ɔɹ"),
    ("a", "æ"),
    ("e", "ɛ"),
    ("i", "ɪ"),
    ("o", "ɑ"),
    ("u", "ʌ"),
    ("y", "i"),
    ("c", "k"),
    ("g", "ɡ"),
    ("j", "ʤ"),
    ("q", "k"),
    ("r", "ɹ"),
    ("x", "ks"),
)
_KEPT_LETTERS = frozenset("bdfhklmnpstvwz")
_SIBILANTS = frozenset("szʃʒʧʤ")
_VOICELESS = frozenset("ptkfθ")


def sound_out(word: str) -> str:
    """Rough phonemes from spelling alone, stressed on the first syllable."""
    w = word.lower()
    out: list[str] = []
    i = 0
    while i < len(w):
        for graphemes, phones in _SPELLING_RULES:
            if w.startswith(graphemes, i):
                out.append(phones)
                i += len(graphemes)
                break
        else:
            if w[i] in _KEPT_LETTERS:
                out.append(w[i])
            i += 1
    # A silent final e after a consonant is common enough to drop.
    if len(w) > 3 and w.endswith("e") and out and out[-1] == "ɛ":
        out.pop()
    return "ˈ" + "".join(out)


class Lexicon:
    """misaki's gold and silver American English word lists."""

    def __init__(self, *tables: dict[str, object]) -> None:
        self._tables = tables

    @classmethod
    def load(cls, directory: str) -> Lexicon:
        tables = []
        for name in ("us_gold.json", "us_silver.json"):
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                tables.append(json.load(fh))
        return cls(*tables)

    def lookup(self, word: str) -> str | None:
        for candidate in dict.fromkeys((word, word.lower(), word.capitalize())):
            for table in self._tables:
                entry = table.get(candidate)
                if isinstance(entry, dict):
                    # Part-of-speech variants: the plain reading, else the first one listed.
                    entry = entry.get("DEFAULT") or next((v for v in entry.values() if isinstance(v, str) and v), None)
                if isinstance(entry, str) and entry:
                    return entry
        return None

    def _with_ending(self, word: str) -> str | None:
        w = word.lower()
        if w.endswith("'s") and (base := self.lookup(w[:-2])):
            return base + _plural_ending(base)
        if w.endswith("s") and len(w) > 3 and not w.endswith("ss") and (base := self.lookup(w[:-1])):
            return base + _plural_ending(base)
        if w.endswith("es") and len(w) > 4 and (base := self.lookup(w[:-2])) and base[-1] in _SIBILANTS:
            return base + "ɪz"
        if w.endswith("ed") and len(w) > 4:
            base = self.lookup(w[:-2]) or self.lookup(w[:-1])
            if base:
                return base + ("ɪd" if base[-1] in "td" else "t" if base[-1] in _VOICELESS else "d")
        if w.endswith("ing") and len(w) > 5:
            base = self.lookup(w[:-3]) or self.lookup(w[:-3] + "e")
            if base:
                return base + "ɪŋ"
        if w.endswith("ly") and len(w) > 4 and (base := self.lookup(w[:-2])):
            return base + "li"
        return None

    def word(self, word: str) -> str:
        found = self.lookup(word) or self._with_ending(word)
        if found:
            return found
        if word.isupper() and len(word) <= 5:
            letters = [self.lookup(letter) for letter in word]
            if all(letters):
                return " ".join(letter for letter in letters if letter)
        return sound_out(word)


def _plural_ending(base: str) -> str:
    last = base[-1]
    if last in _SIBILANTS:
        return "ɪz"
    return "s" if last in _VOICELESS else "z"


def to_phonemes(text: str, lexicon: Lexicon) -> str:
    """Plain or Markdown text to one Kokoro phoneme string."""
    out = ""
    for kind, value in _tokens(normalize(text)):
        if kind == "punct":
            out = out.rstrip(" ") + value
            continue
        if out and not out.endswith(" "):
            out += " "
        out += lexicon.word(value)
    return out.strip()


_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def split_chunks(phonemes: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split at sentence ends, packing sentences up to the limit; overlong sentences split between words."""
    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE_END.split(phonemes):
        for piece in _split_long(sentence, limit):
            if current and len(current) + 1 + len(piece) > limit:
                chunks.append(current)
                current = piece
            else:
                current = f"{current} {piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


def _split_long(sentence: str, limit: int) -> list[str]:
    if len(sentence) <= limit:
        return [sentence]
    pieces: list[str] = []
    current = ""
    for part in sentence.split():
        while len(part) > limit:
            pieces.append(part[:limit])
            part = part[limit:]
        if current and len(current) + 1 + len(part) > limit:
            pieces.append(current)
            current = part
        else:
            current = f"{current} {part}" if current else part
    if current:
        pieces.append(current)
    return pieces
