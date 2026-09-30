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

node --input-type=module --check < "$project_dir/registry.js"
node --input-type=module --check < "$project_dir/extension.js"
node "$project_dir/tests/history.test.js"

GI_TYPELIB_PATH="$gnome_shell_dir:$mutter_dir${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
    gjs -m "$project_dir/tests/registry.test.js"
