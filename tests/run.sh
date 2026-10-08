#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gnome_shell_typelib="$(find /usr/lib /usr/lib64 -name 'St-*.typelib' -print -quit 2>/dev/null || true)"
mutter_typelib="$(find /usr/lib /usr/lib64 -name 'Meta-*.typelib' -print -quit 2>/dev/null || true)"

if [[ -z "$gnome_shell_typelib" || -z "$mutter_typelib" ]]; then
    echo 'GNOME Shell typelibs were not found; cannot run GJS tests.' >&2
    exit 1
fi

gnome_shell_dir="$(dirname "$gnome_shell_typelib")"
mutter_dir="$(dirname "$mutter_typelib")"

# Exercise a real GI callback without a compositor, clipboard, or session bus.
gir_compiler="$(command -v g-ir-compiler || command -v gi-compile-repository)"
fixture_dir="$(mktemp -d /tmp/clipboard-bytes-test-XXXXXX)"
trap 'rm -f "$fixture_dir/libclipboard-bytes.so" "$fixture_dir/ClipboardBytes-1.0.typelib"; rmdir "$fixture_dir"' EXIT
gcc -shared -fPIC "$project_dir/tests/fixtures/clipboard-bytes.c" \
    -o "$fixture_dir/libclipboard-bytes.so" $(pkg-config --cflags --libs glib-2.0)
"$gir_compiler" "$project_dir/tests/fixtures/ClipboardBytes-1.0.gir" \
    -o "$fixture_dir/ClipboardBytes-1.0.typelib"

node --input-type=module --check < "$project_dir/registry.js"
node --input-type=module --check < "$project_dir/extension.js"
node --input-type=module --check < "$project_dir/confirmDialog.js"
node --input-type=module --check < "$project_dir/keyboard.js"
node --input-type=module --check < "$project_dir/compat.js"
node "$project_dir/tests/compat.test.js"
node "$project_dir/tests/history.test.js"

LD_LIBRARY_PATH="$fixture_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
GI_TYPELIB_PATH="$fixture_dir:$gnome_shell_dir:$mutter_dir${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
    gjs -m "$project_dir/tests/clipboard-lifetime.test.js"

GI_TYPELIB_PATH="$gnome_shell_dir:$mutter_dir${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
    gjs -m "$project_dir/tests/registry.test.js"

LD_LIBRARY_PATH="$gnome_shell_dir:$mutter_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
GI_TYPELIB_PATH="$gnome_shell_dir:$mutter_dir${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
    gjs -m "$project_dir/tests/native-compat.test.js"
