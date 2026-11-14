#!/bin/sh
# Tests that every cargo command in scripts/rust.sh except rustfmt carries --locked, so a check never resolves dependencies afresh, and that this test fails when the flag is removed from any one of them. rustfmt reads no lock file and takes no such flag.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# The cargo command lines of a script that are not comments, not rustfmt and lack --locked.
unlocked() {
  grep -nE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z]' "$1" | grep -v 'cargo fmt' | grep -v -- '--locked' || true
}

commands=$(grep -cE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z]' "$here/rust.sh")
if [ "$commands" -lt 2 ]; then echo "FAIL found $commands cargo commands in rust.sh, the pattern is wrong"; failures=$((failures + 1)); fi

if [ -n "$(unlocked "$here/rust.sh")" ]; then
  echo "FAIL a cargo command in rust.sh lacks --locked:"; unlocked "$here/rust.sh"; failures=$((failures + 1))
else
  echo "ok   every cargo command in rust.sh except fmt carries --locked"
fi

# Remove --locked from each locked line in turn: the check must notice every time.
for number in $(grep -nE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z].*--locked' "$here/rust.sh" | cut -d: -f1); do
  sed "${number}s/ --locked//" "$here/rust.sh" > "$work/mutant.sh"
  if [ -n "$(unlocked "$work/mutant.sh")" ]; then echo "ok   removing --locked from line $number is noticed"; else echo "FAIL removing --locked from line $number goes unnoticed"; failures=$((failures + 1)); fi
done

# The pinned toolchain wins over a host's override and over a cargo earlier on PATH: stubs stand in for rustup and for two cargos, one in the pinned toolchain's directory and one a host would have first on PATH.
mkdir -p "$work/scripts" "$work/rust" "$work/pinned" "$work/host"
cp "$here/rust.sh" "$work/scripts/rust.sh"
printf '[toolchain]\nchannel = "9.9.9"\n' > "$work/rust/rust-toolchain.toml"
printf '#!/bin/sh\necho "pinned cargo on toolchain $RUSTUP_TOOLCHAIN"\n' > "$work/pinned/cargo"
printf '#!/bin/sh\necho "host cargo"\n' > "$work/host/cargo"
printf '#!/bin/sh\ncase "$1" in show) exit 0 ;; which) echo "%s/pinned/cargo" ;; esac\n' "$work" > "$work/host/rustup"
chmod +x "$work/pinned/cargo" "$work/host/cargo" "$work/host/rustup"
out=$(env RUSTUP_TOOLCHAIN=bogus PATH="$work/host:$PATH" sh "$work/scripts/rust.sh" test 2>&1) || true
if [ "$out" = "pinned cargo on toolchain 9.9.9" ]; then echo "ok   rust.sh runs the pinned toolchain's cargo whatever the host sets"; else echo "FAIL rust.sh ran: $out"; failures=$((failures + 1)); fi
exit "$failures"
