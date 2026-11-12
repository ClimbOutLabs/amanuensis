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

# Longest phoneme string handed to the model at once. The model takes up to 510 tokens, but its
# memory grows with the length of each run: 400 went past the container's 1 GB, 150 peaks near 500 MB.
MAX_CHUNK_CHARS = 150

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
        return digit_words(str(n))
    words: list[str] = []
    for scale, name in _SCALES:
        if n >= scale:
            words += _under_thousand(n // scale) + [name]
            n %= scale
    if n or not words:
        words += _under_thousand(n)
    return words


# Longer runs of digits are read one by one. Turning them into a number first is pointless, and
# Python refuses past about 4300 digits.
MAX_NUMBER_DIGITS = 12


def digit_words(digits: str) -> list[str]:
    return [_ONES[int(d)] for d in digits]


def whole_words(digits: str) -> list[str]:
    """Spell a run of digits as a number, or digit by digit when it is too long to be one."""
    digits = digits or "0"
    if len(digits.lstrip("0")) > MAX_NUMBER_DIGITS:
        return digit_words(digits)
    return number_words(int(digits))


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
    words = whole_words(whole)
    if fraction:
        words.append("point")
        words += digit_words(fraction)
    return words


def _money_words(text: str) -> list[str]:
    whole, _, cents = text.replace(",", "").partition(".")
    words = whole_words(whole) + ["dollar" if whole.lstrip("0") == "1" else "dollars"]
    if cents:
        cent_value = int((cents + "0")[:2])
        if cent_value:
            # Said with their unit, so "$1,000.10" is not heard as a thousand dollars and a ten.
            words += ["and", *number_words(cent_value), "cent" if cent_value == 1 else "cents"]
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

# Digits with their own thousands commas ("1,000"). A comma after a number is a pause of its own, not part of it.
_DIGITS = r"(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)"
_TOKEN = re.compile(
    r"(?P<time>\b\d{1,2}:\d{2}\b)"
    rf"|(?P<money>\${_DIGITS}(?:\.\d+)?)"
    r"|(?P<ordinal>\b\d+(?:st|nd|rd|th)\b)"
    rf"|(?P<number>{_DIGITS}(?:\.\d+)?)"
    r"|(?P<word>[A-Za-z]+(?:'[A-Za-z]+)*)"
    r"|(?P<punct>\.\.\.|[.,!?;:\u2014\u2026])"
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
            yield "punct", "\u2026" if value == "..." else value
        elif kind == "time":
            hours, minutes = value.split(":")
            for word in _time_words(hours, minutes):
                yield "word", word
        elif kind == "money":
            for word in _money_words(value[1:]):
                yield "word", word
        elif kind == "ordinal":
            digits = value[:-2]
            spelled = digit_words(digits) if len(digits) > MAX_NUMBER_DIGITS else ordinal_words(int(digits))
            for word in spelled:
                yield "word", word
        elif kind == "number":
            for word in _decimal_words(value):
                yield "word", word
        elif kind == "symbol":
            for word in _SYMBOL_WORDS[value]:
                yield "word", word


def spoken_words(text: str) -> list[str]:
    """The words the voice says for this text, lower case, after cleaning and spelling out numbers."""
    return [word.lower() for kind, word in _tokens(normalize(text)) if kind == "word"]


# Numbers whose reading cannot be mistaken: plain digits with no leading zero, thousands in groups
# of three, at most two cents, a real time of day and an ordinal with its right ending (14th, 22nd). Anything
# else (1,5  007  10.0.0.1  11.06.2026  3th  9:60) is said differently from how it is written.
_NOT_MORE_DIGITS = r"(?![\w]|[.,:]\d)"
_WHOLE = r"(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)"
_PLAIN_NUMBER = re.compile(
    r"(?<![\w.,:$])(?:"
    r"(?P<ordinal>[1-9]\d*(?:st|nd|rd|th))"
    rf"|(?P<money>\${_WHOLE}(?:\.\d{{2}})?)"
    r"|(?P<time>(?:[01]?\d|2[0-3]):[0-5]\d)"
    rf"|(?P<number>{_WHOLE}(?:\.\d+)?)"
    r")" + _NOT_MORE_DIGITS
)
# How several numbers written side by side are heard. A "spelling" is one number as written: digits (with their
# own comma, point or colon), digits and a scale word ("5 million", "2 dozen"), or a run of number words
# ("twenty-five", "one thousand five hundred"). Two spellings joined by a gap of only blanks, signs that make no
# sound and pause marks ("1000 500", "1000 (500)", "1000; 500", "1000...500", "twenty (5)") are heard as one
# number or run on. "and" inside such a gap joins them too when the left side ends in a scale and the right is
# smaller ("1000 and 500" is "one thousand and five hundred"). Joined spellings are refused, except a date or
# time that is written with a comma.
# One table for number words: the plain numbers come from _ONES and _TENS above, the scales from here.
_SCALE_VALUES = {
    "dozen": 12,
    "hundred": 100,
    "thousand": 1_000,
    "grand": 1_000,
    "lakh": 100_000,
    "million": 1_000_000,
    "crore": 10_000_000,
    "billion": 1_000_000_000,
    "trillion": 1_000_000_000_000,
}
_WORD_VALUES = {word: value for value, word in enumerate(_ONES)} | {
    word: value * 10 for value, word in enumerate(_TENS) if word != "_"
}
_UNITS = "|".join(_WORD_VALUES)
_SCALE_WORDS = rf"(?:{'|'.join(_SCALE_VALUES)})s?"
_NUMBER_WORD = rf"(?:{_UNITS}|{_SCALE_WORDS})"
_DIGIT_SPELLING = r"\$?\d+(?:[,.:]\d+)*"
_NUMBER_SPELLING = re.compile(
    rf"(?i)(?<![A-Za-z0-9])(?<![A-Za-z]')"
    rf"(?:{_DIGIT_SPELLING}(?: (?:{_SCALE_WORDS})(?![A-Za-z0-9]))?"
    rf"|{_NUMBER_WORD}(?:[ -]{_NUMBER_WORD})*(?![A-Za-z0-9])(?!'[A-Za-z]))"
)
# Characters that make no sound between two numbers, defined once so every gap rule agrees. "&", "an" and "n"
# are not here: they are heard as "and".
_GAP_CHARS = r"[ \t\n\"'()\u2014\u2026;!?,:.\-]"
_SILENT_GAP = re.compile(rf"{_GAP_CHARS}+")
_SENTENCE_STOP_GAP = re.compile(r"[.!?][ \t\n]+")
_AND = r"(?:\band\b|\ban\b|\bn\b|&)"
_AND_GAP = re.compile(rf"{_GAP_CHARS}*(?:{_AND}{_GAP_CHARS}*)+", re.IGNORECASE)
# "two hundred and fifty" is one amount written in words, so it is read as it is written.
_WORD_AND_GAP = re.compile(r" +and +", re.IGNORECASE)
_COMMA_GAP = re.compile(r", +")
# Capitalised only: "may", "sat" and "sun" in lower case are ordinary words, not a date.
_MONTH_OR_WEEKDAY = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?"
    r"|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?"
    r"|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)"
)
# A comma is a pause, so it is plain only where a written date or time has one, and only after a month or a
# weekday: a day and a year ("Nov 6, 2026"), a day and a time ("Nov 6, 2:30") or a year and a time.
_AFTER_MONTH = re.compile(rf"\b{_MONTH_OR_WEEKDAY}\.?\s+$")
_AFTER_MONTH_AND_DAY = re.compile(rf"\b{_MONTH_OR_WEEKDAY}\.?\s+\d{{1,2}},\s+$")
_DAY = re.compile(r"\d{1,2}")
_YEAR = re.compile(r"(?:19|20)\d\d")
_CLOCK = re.compile(r"\d{1,2}:\d\d")


_PLAIN_AMOUNT = re.compile(r"\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?")


def _scale_of(word: str) -> int | None:
    word = word.lower()
    return _SCALE_VALUES.get(word) or _SCALE_VALUES.get(word.removesuffix("s"))


def _value(spelling: str) -> float | None:
    """What a spelling counts to, or None when it is not a plain amount (a time or "1.2.3", for one)."""
    text = spelling.lstrip("$")
    if text[:1].isdigit():
        digits, _, scale = text.partition(" ")
        if _PLAIN_AMOUNT.fullmatch(digits) is None:
            return None
        return float(digits.replace(",", "")) * (_scale_of(scale) or 1)
    total = 0.0
    current = 0.0
    for word in re.split(r"[ -]", text.lower()):
        scale = _scale_of(word)
        if word in _WORD_VALUES:
            current += _WORD_VALUES[word]
        elif scale is not None and scale < 1000:
            current = max(current, 1) * scale
        elif scale is not None:
            total += max(current, 1) * scale
            current = 0
    return total + current


def _ending_scale(spelling: str) -> int | None:
    """The scale a spelling ends in ("1000" and "one thousand" end in thousands, "1200" in hundreds)."""
    text = spelling.lstrip("$")
    if text[:1].isdigit():
        digits, _, scale = text.partition(" ")
        if scale:
            return _scale_of(scale)
        if _PLAIN_AMOUNT.fullmatch(digits) is None or "." in digits:
            return None
        whole = int(digits.replace(",", ""))
        for size in (10**12, 10**9, 10**7, 10**6, 10**5, 1000, 100):
            if whole >= size and whole % size == 0:
                return size
        return None
    return _scale_of(re.split(r"[ -]", text)[-1])


def _plain_comma(*, text: str, left: re.Match[str], right: re.Match[str]) -> bool:
    a, b, before = left.group(), right.group(), text[: left.start()]
    if _DAY.fullmatch(a) and (_YEAR.fullmatch(b) or _CLOCK.fullmatch(b)):
        return _AFTER_MONTH.search(before) is not None
    return _YEAR.fullmatch(a) is not None and _CLOCK.fullmatch(b) is not None and _AFTER_MONTH_AND_DAY.search(before) is not None


def _in_words(spelling: re.Match[str]) -> bool:
    return not spelling.group().lstrip("$")[:1].isdigit()


def _runs_numbers_together(text: str) -> bool:
    """True when two numbers written side by side are heard as one number or run on."""
    spellings = list(_NUMBER_SPELLING.finditer(text))
    for left, right in zip(spellings, spellings[1:]):
        gap = text[left.end() : right.start()]
        if _AND_GAP.fullmatch(gap):
            if _WORD_AND_GAP.fullmatch(gap) and _in_words(left) and _in_words(right):
                continue
            scale, smaller = _ending_scale(left.group()), _value(right.group())
            joined = scale is not None and smaller is not None and smaller < scale
        else:
            joined = _SILENT_GAP.fullmatch(gap) is not None and _SENTENCE_STOP_GAP.fullmatch(gap) is None
        if joined and not (_COMMA_GAP.fullmatch(gap) and _plain_comma(text=text, left=left, right=right)):
            return True
    return False


_WRITTEN_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)*")
# Characters the voice says as written: letters and digits, spaces, usual punctuation and a few symbols.
_PLAIN_CHARS = re.compile(r"[A-Za-z0-9 \n\t.,!?;:'\"()%&+@=$\u2014\u2026-]*")
_LONE_HYPHEN = re.compile(r"(?<![A-Za-z])-|-(?![A-Za-z])")
# A dot inside web-address-like text ("my.bank.com", "t.co", "163.com") is not heard as written. A single letter
# on each side ("e.g.", "p.m.", "U.S.") is said letter by letter and is allowed, and so is a closing dot
# ("Ph.D.").
_DOTTED_WORD = re.compile(r"[A-Za-z0-9]\.[A-Za-z]{2,}")


def _ordinal_suffix(n: int) -> str:
    if n % 100 in (11, 12, 13):
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def _spell_plain_number(match: re.Match[str]) -> str:
    kind = match.lastgroup
    value = match.group()
    if kind == "ordinal":
        digits, suffix = value[:-2], value[-2:]
        if len(digits) > MAX_NUMBER_DIGITS or suffix != _ordinal_suffix(int(digits)):
            return value  # "3th" stays digits, so the text is refused
        words = ordinal_words(int(digits))
    elif kind == "money":
        words = _money_words(value[1:])
    elif kind == "time":
        hours, minutes = value.split(":")
        words = _time_words(hours, minutes)
    else:
        words = _decimal_words(value)
    return f" {' '.join(words)} "


def reads_as_written(text: str) -> bool:
    """True when the voice would say exactly the words that are written, none lost, added or changed.

    Used for text a person must be able to check by ear: a number said another way, a link, a list
    mark, a letter outside plain English or a sign that is dropped all make it False.
    """
    # The raw characters are checked, before any folding: a superscript or full-width digit is not plain.
    written = text.replace("\r\n", "\n").replace("\u2019", "'").replace("\u2018", "'")
    if (
        _PLAIN_CHARS.fullmatch(written) is None
        or _LONE_HYPHEN.search(written)
        or _DOTTED_WORD.search(written)
        or _URL.search(written)
        or _runs_numbers_together(written)
    ):
        return False
    written = _PLAIN_NUMBER.sub(_spell_plain_number, written)
    for symbol, words in _SYMBOL_WORDS.items():
        written = written.replace(symbol, f" {' '.join(words)} ")
    if re.search(r"[\d$]", written):
        return False
    return [word.lower() for word in _WRITTEN_WORD.findall(written)] == spoken_words(text)


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


_SENTENCE_END = re.compile(r"(?<=[.!?\u2026])\s+")


def split_sentences(phonemes: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """One piece per sentence, so a streamed reply can start after the first one; overlong sentences split between words."""
    return [piece for sentence in _SENTENCE_END.split(phonemes) for piece in _split_long(sentence, limit) if piece]


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
