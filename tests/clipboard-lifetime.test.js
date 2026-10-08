import GLib from 'gi://GLib';
import ClipboardBytes from 'gi://ClipboardBytes?version=1.0';
import System from 'system';
import { ClipboardEntry } from '../registry.js';

function assert (condition, message) {
    if (!condition) throw new Error(message);
}

const expected = 'callback 中文 😀';
const before = ClipboardBytes.get_releases();
let borrowed;
ClipboardBytes.deliver(bytes => { borrowed = bytes; });
assert(borrowed instanceof GLib.Bytes, 'fixture did not return native clipboard bytes');
// Never dereference borrowed after delivery: on GJS 1.90 it already dangles.
assert(ClipboardBytes.get_releases() >= before, 'invalid native release counter');
const fixtureIsBorrowed = ClipboardBytes.get_releases() === before + 1;
borrowed = null;

const entries = [];
for (const mimetype of ['text/plain;charset=utf-8', 'text/plain', 'STRING', 'image/png']) {
    for (let copy = 0; copy < 100; copy++) {
        const releases = ClipboardBytes.get_releases();
        ClipboardBytes.deliver(bytes => {
            entries.push(ClipboardEntry.fromClipboard(mimetype, bytes));
        });
        assert(ClipboardBytes.get_releases() === releases,
            `${mimetype}: native clipboard buffer was freed at callback return`);
    }
}

// Use entries in a later main-loop iteration, after the producer has unreffed
// them and after a full GC, just as the extension's Promise continuation does.
await new Promise((resolve, reject) => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    try {
        System.gc();
        for (const entry of entries) {
            assert(new TextDecoder().decode(entry.asBytes().get_data()) === expected,
                `${entry.mimetype()}: bytes changed after callback return`);
            assert(entry.getHash() === entry.asBytes().hash(), 'cached hash changed');
            if (entry.isText()) assert(entry.getStringValue() === expected, 'clipboard text changed');
        }
        resolve();
    } catch (error) {
        reject(error);
    }
    return GLib.SOURCE_REMOVE;
}));
print(`native callback lifetime across Promise/GC: ok (borrowed wrapper: ${fixtureIsBorrowed})`);
