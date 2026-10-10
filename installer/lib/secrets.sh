# shellcheck shell=bash
# Random secrets and password hashing. Secrets stay in shell memory and files; they never go in argv.

rand_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# Reads the password from the variable AMAN_PASSWORD (shell memory) and pipes it on stdin to the app
# image, which prints {"hash":"<bcrypt>"}. Prints only the hash.
hash_password() {
  local image=$1 out hash
  out=$(printf '%s\n' "$AMAN_PASSWORD" | D run --rm -i --network none "$image" amanuensis hash-password) ||
    die "the app image could not hash the password (amanuensis hash-password failed)"
  hash=$(printf '%s' "$out" | sed -n 's/.*"hash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s' "$hash" | grep -Eq '^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$' ||
    die "the app image returned something that is not a bcrypt hash"
  printf '%s\n' "$hash"
}
