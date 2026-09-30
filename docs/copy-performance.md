# Copy performance

History persistence runs in the GNOME Shell process, so even an idle callback
must keep individual main-loop iterations short. Asynchronous disk writes do
not make a preceding whole-history `JSON.stringify()` or UTF-8 conversion
asynchronous.

The registry writer now encodes JSON in bounded 16 Ki-character chunks and
awaits asynchronous writes and close between chunks. Existing JSON format and
image filenames are unchanged. Pending snapshots remain serialized/coalesced,
and image files finish writing before their references are published.

Clipboard entries retain native immutable buffers and cache image hashes.
Repeated copies move existing menu actors rather than rebuilding rows. Copying
the already-newest entry no longer rewrites unchanged history.

## Validation

Run `bash tests/run.sh` for:

- Multi-chunk Chinese/emoji/escaped-string round trips, including surrogate boundaries.
- Coalescing and ordering of writes, image-write deduplication and cache deletion.
- Native buffer reuse and invalidation after editing.
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
