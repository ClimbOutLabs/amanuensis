#!/bin/sh
# Installs the optional toolchain packs into the guest image while it is built.
#   install-packs.sh <packs_dir> <comma separated packs>
# Archives in <packs_dir>/archives were downloaded and checked by `pnpm sandbox:slots --add`; they are checked
# again here against the pinned SHA256SUMS, so a changed or truncated file stops the build.
set -eu

dir="${1:?packs directory}"
packs="${2:-}"
root="${AMAN_PACKS_ROOT:-}"
arch="$(uname -m)"
case "$arch" in
  x86_64) go_arch=amd64 ;;
  aarch64) go_arch=arm64 ;;
  *) echo "install-packs: unsupported architecture $arch" >&2; exit 1 ;;
esac

verify() {
  name="$(basename "$1")"
  expected="$(awk -v n="$name" '$2 == n { print $1 }' "$dir/SHA256SUMS")"
  [ -n "$expected" ] || { echo "install-packs: no pinned checksum for $name" >&2; exit 1; }
  actual="$(sha256sum "$1" | cut -d ' ' -f 1)"
  [ "$actual" = "$expected" ] || { echo "install-packs: checksum mismatch for $name" >&2; exit 1; }
}

# The single archive matching a pattern, or a clear error.
archive() {
  set -- $dir/archives/$1
  [ -f "$1" ] && [ "$#" -eq 1 ] || { echo "install-packs: expected exactly one archive matching $dir/archives/$1" >&2; exit 1; }
  verify "$1"
  echo "$1"
}

link() {
  mkdir -p "$root/usr/local/bin"
  ln -sf "$1" "$root/usr/local/bin/$(basename "$1")"
}

install_go() {
  zip="$(archive "go-*-linux-$go_arch.zip")"
  tmp="$(mktemp -d)"
  unzip -q "$zip" -d "$tmp"
  mkdir -p "$root/opt"
  mv "$tmp"/golang.org/toolchain@*/ "$root/opt/go"
  rm -rf "$tmp"
  link /opt/go/bin/go
  link /opt/go/bin/gofmt
}

install_rust() {
  tmp="$(mktemp -d)"
  for component in rustc cargo rust-std; do
    tarball="$(archive "$component-*-$arch-unknown-linux-gnu.tar.gz")"
    tar -xzf "$tarball" -C "$tmp"
  done
  for installer in "$tmp"/*/install.sh; do
    sh "$installer" --prefix="$root/opt/rust" --disable-ldconfig >/dev/null
  done
  rm -rf "$tmp"
  link /opt/rust/bin/rustc
  link /opt/rust/bin/rustdoc
  link /opt/rust/bin/cargo
}

# Java comes from the Ubuntu archive, whose packages apt verifies by signature.
install_java() {
  apt-get update
  apt-get install -y --no-install-recommends openjdk-21-jdk-headless
  apt-get clean
  rm -rf /var/lib/apt/lists/*
}

for pack in $(echo "$packs" | tr ',' ' '); do
  case "$pack" in
    go) install_go ;;
    rust) install_rust ;;
    java) install_java ;;
    *) echo "install-packs: unknown pack $pack" >&2; exit 1 ;;
  esac
done
