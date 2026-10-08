# A JS wrapper is not necessarily an owning native reference

## Scenario and goal

Avoid large buffer copies while processing clipboard history inside Shell.

## Wrong choice and consequence

The 2026-09-30 optimization saved the `GLib.Bytes` wrapper supplied by
`StClipboardContentCallbackFunc` directly in history. On GJS 1.90, callback
transfer-none structs use non-owning wrappers. Shell unrefs the native bytes
after the callback, leaving history with a dangling native pointer. A later
Promise continuation can crash the compositor instead of raising a JS error.

## Better approach and boundary

Acquire an owning full-range `GLib.Bytes.new_from_bytes()` slice while the
callback's native bytes are valid. This retains storage without duplicating
image data. Only native data already owned by the caller can be cached directly.
Do not infer ownership from the wrapper being reachable in JS or from tests
that only construct `new GLib.Bytes()` (which already owns its buffer).

Test the producer dropping its reference, then access the consumer's buffer in
a later main-loop iteration after GC. Use a native destroy notifier to detect
premature release without deliberately reading freed memory. Keep such tests
outside the live desktop/session bus.

## Evidence and status

- 2026-10-08, confirmed on GJS 1.90.0 / GNOME Shell 51.0.
- Shell core PID 3428: `g_bytes_get_data` marshalling used an invalid native
  length; failed ArrayBuffer allocation was followed by SIGSEGV.
- User confirmed ordinary copying works after disabling only Clipboard Indicator.
- Native lifetime test fails on the old capture with "buffer was freed at
  callback return"; the owned-reference implementation passes deferred access
  and GC checks. Live desktop validation remains pending a fresh login.
- See `tests/clipboard-lifetime.test.js`, `tests/fixtures/`,
  `ClipboardEntry.fromClipboard()` and `docs/copy-performance.md`.
