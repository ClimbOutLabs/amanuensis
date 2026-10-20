#!/usr/bin/env bash
# Letter ranges like A-Z follow the user's locale on macOS, so each one must run under LC_ALL=C or use a POSIX class.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Prints "file:line" for each letter range that no LC_ALL=C in its function covers. A function is covered when its
# body sets LC_ALL=C anywhere; a range outside any function is never covered.
letter_range_gaps() {
  local file=$1 line tok body lines=
  local LC_ALL=C
  while IFS=: read -r line tok; do
    body=${tok:1:${#tok}-2}
    case "$body" in '!'* | '^'*) body=${body:1} ;; esac
    case "$body" in -*) continue ;; esac
    if [[ $body == *[A-Za-z]-[A-Za-z]* ]]; then lines="$lines $line"; fi
  done < <(grep -no '\[[^] ]*\]' "$file")
  awk -v lines="$lines" -v file="$file" '
    BEGIN { n = split(lines, want, " "); for (i = 1; i <= n; i++) pending[want[i]] = 1 }
    /^[A-Za-z_][A-Za-z0-9_]*\(\) *[{]/ { cur = ++id }
    cur && /LC_ALL=C/ { covered[cur] = 1 }
    (NR in pending) { where[NR] = cur }
    /^[A-Za-z_][A-Za-z0-9_]*\(\) *[{].*[}][ \t]*$/ || /^[}]/ { cur = 0 }
    END {
      for (i = 1; i <= n; i++) {
        l = want[i]
        if (seen[l]++) continue
        if (!where[l] || !covered[where[l]]) print file ":" l
      }
    }' "$file"
}

test_the_guard_flags_only_uncovered_letter_ranges() {
  t_begin "the letter-range guard flags uncovered ranges and accepts LC_ALL=C or POSIX classes"
  local dir out
  dir=$(mktemp -d)
  cat >"$dir/bad.sh" <<'EOF'
f() {
  [[ $1 == *[A-Z]* ]]
}
g() { [[ $1 == [a-z]* ]]; }
[[ $1 == x[a-z] ]]
EOF
  cat >"$dir/good.sh" <<'EOF'
f() {
  local LC_ALL=C
  [[ $1 == *[A-Z]* ]]
}
g() { printf x | LC_ALL=C sed 's/[a-z]//'; }
h() {
  [[ $1 == *[[:upper:]]* ]]
}
EOF
  out=$(letter_range_gaps "$dir/bad.sh")
  assert_eq "$out" "$dir/bad.sh:2
$dir/bad.sh:4
$dir/bad.sh:5" "the three uncovered ranges are reported"
  out=$(letter_range_gaps "$dir/good.sh")
  assert_eq "$out" "" "covered ranges and POSIX classes are not reported"
  rm -rf "$dir"
}

test_every_installer_letter_range_runs_in_the_c_locale() {
  t_begin "every letter range in install.sh and lib is covered by LC_ALL=C in its function"
  local out f
  out=$(for f in "$INSTALLER_DIR/install.sh" "$INSTALLER_DIR"/lib/*.sh; do letter_range_gaps "$f"; done)
  assert_eq "$out" "" "a letter range is not covered by LC_ALL=C; use local LC_ALL=C in its function or a POSIX class"
}

test_aman_maya_passes_the_name_check_in_a_utf8_locale() {
  t_begin "aman-maya is a valid name under en_US.UTF-8, a capital is still refused, and a multibyte character stays whole"
  local loc out
  loc=$(locale -a 2>/dev/null | grep -iE '^en_US\.utf-?8$' | head -n 1 || true)
  if [ -z "$loc" ]; then
    printf 'note: en_US.UTF-8 is not installed here; the guard above is the protection on this machine\n'
    t_pass
    return
  fi
  out=$(LC_ALL=$loc bash -c ". '$INSTALLER_DIR/lib/common.sh'; name_problem aman-maya")
  assert_eq "$out" "" "aman-maya is accepted"
  out=$(LC_ALL=$loc bash -c ". '$INSTALLER_DIR/lib/common.sh'; name_problem Aman")
  assert_contains "$out" "has capital letters" "a capital letter is still refused"
  out=$(LC_ALL=$loc bash -c ". '$INSTALLER_DIR/lib/common.sh'; name_problem aé")
  assert_contains "$out" "has the character é" "a multibyte character is shown whole"
}

test_the_guard_flags_only_uncovered_letter_ranges
test_every_installer_letter_range_runs_in_the_c_locale
test_aman_maya_passes_the_name_check_in_a_utf8_locale
tests_finish
