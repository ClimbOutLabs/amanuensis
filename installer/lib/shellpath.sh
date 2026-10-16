# shellcheck shell=bash
# Puts the aman command on the PATH of new terminals with one managed block in the shell profiles.

PATH_BLOCK_BEGIN='# >>> amanuensis (managed by the installer) >>>'
PATH_BLOCK_END='# <<< amanuensis <<<'

# The profile files this person's shells read, one per line: the ones that exist, plus the one for their own shell
# (bash when nothing says otherwise).
shell_profiles() {
  local shell_name
  shell_name=$(basename "${SHELL:-bash}")
  if [ -f "$HOME/.bashrc" ] || [ "$shell_name" = bash ] || { [ ! -f "$HOME/.zshrc" ] && [ "$shell_name" != zsh ]; }; then
    printf '%s\n' "$HOME/.bashrc"
  fi
  if [ -f "$HOME/.zshrc" ] || [ "$shell_name" = zsh ]; then printf '%s\n' "$HOME/.zshrc"; fi
  # macOS terminals start bash as a login shell, which reads .bash_profile and not .bashrc.
  if [ "$(uname -s)" = Darwin ] && { [ -f "$HOME/.bash_profile" ] || [ "$shell_name" = bash ]; }; then
    printf '%s\n' "$HOME/.bash_profile"
  fi
}

path_block() {
  local bin=$AMAN_HOME/bin keep=\$PATH home_var=\$HOME
  valid_home_path "$bin" || die "The folder for Aman data has characters that cannot go into a shell profile"
  case "$bin" in "$HOME"/*) bin="$home_var${bin#"$HOME"}" ;; esac
  printf '%s\nexport PATH="%s:%s"\n%s\n' "$PATH_BLOCK_BEGIN" "$bin" "$keep" "$PATH_BLOCK_END"
}

# True when the profile holds exactly the current block.
path_profile_ready() { # file
  [ -f "$1" ] && grep -Fqx "$(path_block | sed -n 2p)" "$1" && grep -Fqx "$PATH_BLOCK_BEGIN" "$1"
}

path_ready() {
  local file
  while IFS= read -r file; do
    path_profile_ready "$file" || return 1
  done < <(shell_profiles)
  return 0
}

# Replaces the managed block of a profile, or appends it; everything else in the file stays as it was.
path_profile_apply() { # file
  local file=$1 tmp
  [ -d "$(dirname "$file")" ] || return 0
  touch "$file"
  tmp=$(umask 077 && mktemp "${TMPDIR:-/tmp}/aman-profile.XXXXXX")
  awk -v b="$PATH_BLOCK_BEGIN" -v e="$PATH_BLOCK_END" '
    $0 == b { skip = 1; next }
    skip && $0 == e { skip = 0; next }
    !skip { print }' "$file" >"$tmp"
  { cat "$tmp"; if [ -s "$tmp" ]; then printf '\n'; fi; path_block; } >"$tmp.new"
  # Written through the file itself so its mode, owner and any symlink stay as they are.
  cat "$tmp.new" >"$file"
  rm -f "$tmp" "$tmp.new"
}

install_path_block() {
  local file
  while IFS= read -r file; do
    path_profile_apply "$file"
  done < <(shell_profiles)
}
