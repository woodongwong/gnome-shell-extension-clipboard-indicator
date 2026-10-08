# Copy performance

History persistence runs in the GNOME Shell process, so even an idle callback
must keep individual main-loop iterations short. Asynchronous disk writes do
not make a preceding whole-history `JSON.stringify()` or UTF-8 conversion
asynchronous.

The registry writer now encodes JSON in bounded 16 Ki-character chunks and
awaits asynchronous writes and close between chunks. Existing JSON format and
image filenames are unchanged. Pending snapshots remain serialized/coalesced,
and image files finish writing before their references are published.

Clipboard entries retain owned references to native immutable buffers and cache image hashes.
Repeated copies move existing menu actors rather than rebuilding rows. Copying
the already-newest entry no longer rewrites unchanged history.

## Validation

The native callback fixture requires a C compiler, GLib development files,
`pkg-config`, and `g-ir-compiler` or `gi-compile-repository`, in addition to GJS
and GNOME Shell typelibs. It does not connect to the desktop or session bus.

Run `bash tests/run.sh` for:

- Multi-chunk Chinese/emoji/escaped-string round trips, including surrogate boundaries.
- Coalescing and ordering of writes, image-write deduplication and cache deletion.
- Native buffer reuse and invalidation after editing.
- A real GI callback with borrowed `GBytes`, including producer release and later Promise/GC access.
- Failed file operations and preservation of the old registry after an interrupted write.
- Row reuse, history order, selection and pin/unpin transition methods using desktop-free mocks.

On 2026-09-30, an isolated GJS process replayed a copy of a 100-entry registry
(about 6 MB of JSON, with 20 image entries). A 1 ms heartbeat measured the maximum
main-loop gap during persistence: 31.79 ms before and 1.44 ms after. Both versions
round-tripped all text contents. Total background persistence took 37.93 ms
before and 61.03 ms after: the improvement is responsiveness, not disk throughput.
No clipboard contents or private image data are included in this report.

These measurements do not verify the live compositor or every copy source.
GNOME Shell must reload the modified JavaScript on the next login; desktop
copying and menu interactions still need a post-login check.

## Native callback lifetime (2026-10-08)

On GJS 1.90.0, retaining the `GBytes` wrapper received by
`StClipboardContentCallbackFunc` does not retain the native buffer. Shell drops
the producer's reference when the callback returns. Reading the saved wrapper
later can use freed memory; the observed Shell core was in `g_bytes_get_data`
marshalling with an invalid length, followed by a failed ArrayBuffer allocation
and SIGSEGV. Disabling Clipboard Indicator restored ordinary desktop copying.

`ClipboardEntry.fromClipboard()` now creates an owning full-range `GBytes`
slice **inside** the callback. This keeps the immutable backing storage alive
without copying large image data. The native test fixture mirrors the callback's
transfer-none annotation and producer unref. Its destroy notifier detects the
old implementation freeing data at callback return without dereferencing the
dangling pointer. The fixed implementation retains it across a later main-loop
iteration and full GC for text and image entries.

Source ownership contracts:
[Shell's callback and producer cleanup](https://github.com/GNOME/gnome-shell/blob/51.0/src/st/st-clipboard.c),
[GJS transfer-none struct wrapping](https://github.com/GNOME/gjs/blob/1.90.0/gi/arg.cpp).
The isolated regression test is not a live-compositor validation; the extension
stays disabled until a fresh-login desktop check can be performed safely.
