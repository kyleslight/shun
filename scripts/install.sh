#!/bin/sh
set -eu
umask 077

fail() { printf 'Shun: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required to download Shun.'
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'Use the PowerShell installer on Windows.' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'This CPU is not supported yet.' ;; esac
case "$os-$arch" in darwin-arm64|darwin-x64|linux-x64) ;; *) fail 'A standalone build is not available for this platform yet.' ;; esac

base=https://github.com/kyleslight/shun/releases/latest/download
if [ -n "${SHUN_VERSION:-}" ]; then
  case "$SHUN_VERSION" in *[!0-9.]*|'') fail 'SHUN_VERSION must be a release version such as 0.1.145.' ;; esac
  base="https://github.com/kyleslight/shun/releases/download/v$SHUN_VERSION"
fi
destination=${SHUN_INSTALL_DIR:-"$HOME/.local/share/shun"}
bin=${SHUN_BIN_DIR:-"$HOME/.local/bin"}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
asset="shun-cli-$os-$arch.tar.gz"
printf 'Downloading Shun for %s…\n' "$os-$arch"
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "$base/$asset" -o "$temporary/$asset" || fail 'Could not download Shun. This release may not include the CLI yet.'
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "$base/$asset.sha256" -o "$temporary/checksum" || fail 'Could not download the release checksum.'
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$temporary/checksum")
[ "${#expected}" -eq 64 ] || fail 'Invalid release checksum.'
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$temporary/$asset" | awk '{print $1}')
else fail 'A SHA-256 utility is required.'; fi
[ "$actual" = "$expected" ] || fail 'Download verification failed. Nothing was installed.'
tar -xzf "$temporary/$asset" -C "$temporary"
version=$(cat "$temporary/shun/VERSION")
case "$version" in *[!0-9.]*|'') fail 'Invalid Shun version.' ;; esac
"$temporary/shun/shun" --version
mkdir -p "$destination/versions" "$bin"
if [ ! -d "$destination/versions/$version" ]; then
  stage="$destination/versions/.install-$version-$$"
  cp -R "$temporary/shun" "$stage"
  mv "$stage" "$destination/versions/$version"
fi
printf '%s\n' "$version" > "$destination/.current-$$"
mv -f "$destination/.current-$$" "$destination/current"
# Quote the installation path as shell data, including spaces and apostrophes.
quoted=$(printf '%s' "$destination" | sed "s/'/'\\\\''/g")
{
  printf '#!/bin/sh\nset -eu\nroot='"'%s'"'\n' "$quoted"
  printf 'version=$(cat "$root/current")\nexec "$root/versions/$version/shun" "$@"\n'
} > "$bin/.shun-$$"
chmod 755 "$bin/.shun-$$"
mv -f "$bin/.shun-$$" "$bin/shun"
printf '\nShun %s installed.\n' "$version"
case ":$PATH:" in
  *":$bin:"*) printf 'Run: shun\n' ;;
  *)
    profile=
    if [ "${SHUN_NO_MODIFY_PATH:-0}" != 1 ]; then
      case "${SHELL:-}" in
        */zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
        */bash) if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
      esac
    fi
    if [ -n "$profile" ]; then
      path_quoted=$(printf '%s' "$bin" | sed "s/'/'\\\\''/g")
      path_line=$(printf 'export PATH='"'%s'"':"$PATH"' "$path_quoted")
      mkdir -p "$(dirname "$profile")"
      if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then printf '\n# Shun CLI\n%s\n' "$path_line" >> "$profile"; fi
      printf 'Open a new terminal and run shun. PATH was added to %s.\n' "$profile"
    else printf 'Add this directory to PATH, then run shun:\n  %s\n' "$bin"; fi
    printf 'Or run now:\n  "%s/shun"\n' "$bin"
    ;;
esac
