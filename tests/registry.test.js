import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Registry } from '../registry.js';

function assert (condition, message) {
    if (!condition) throw new Error(message);
}

function delay (milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitFor (predicate, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await delay(5);
    }
    throw new Error(message);
}

class TestEntry {
    constructor (contents) {
        this.contents = contents;
    }

    isFavorite () { return false; }
    mimetype () { return 'text/plain;charset=utf-8'; }
    isText () { return true; }
    isImage () { return false; }
    getStringValue () { return this.contents; }
    getTag () { return null; }
}

const testDir = GLib.dir_make_tmp('clipboard-indicator-registry-test-XXXXXX');
const registryPath = `${testDir}/registry.txt`;
const registry = new Registry({ settings: {}, uuid: 'registry-test' });
registry.REGISTRY_DIR = testDir;
registry.REGISTRY_PATH = registryPath;
registry.BACKUP_REGISTRY_PATH = `${registryPath}~`;

const originalWriteToFile = registry.writeToFile.bind(registry);
let writeCount = 0;
let activeWrites = 0;
let maxActiveWrites = 0;

registry.writeToFile = async contents => {
    writeCount++;
    activeWrites++;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
        // Keep a write active long enough to enqueue a newer snapshot.
        await delay(25);
        await originalWriteToFile(contents);
    }
    finally {
        activeWrites--;
    }
};

function persistedContents () {
    if (!GLib.file_test(registryPath, GLib.FileTest.EXISTS)) return null;
    const [success, bytes] = GLib.file_get_contents(registryPath);
    if (!success) return null;
    return JSON.parse(new TextDecoder().decode(bytes))[0]?.contents ?? null;
}

try {
    registry.write([new TestEntry('obsolete')]);
    registry.write([new TestEntry('coalesced')]);

    await waitFor(
        () => activeWrites === 0 && persistedContents() === 'coalesced',
        'same-turn writes did not coalesce to the newest snapshot'
    );
    assert(writeCount === 1, `expected one coalesced write, got ${writeCount}`);

    registry.write([new TestEntry('in-flight')]);
    await waitFor(() => activeWrites === 1, 'write did not start');
    registry.write([new TestEntry('superseded')]);
    registry.write([new TestEntry('newest')]);

    await waitFor(
        () => activeWrites === 0 && persistedContents() === 'newest',
        'newest snapshot was not persisted after an in-flight write'
    );
    assert(writeCount === 3, `expected one in-flight and one follow-up write, got ${writeCount - 1}`);
    assert(maxActiveWrites === 1, `registry writes overlapped (${maxActiveWrites} active)`);

    console.log('registry write queue: ok');
}
finally {
    const registryFile = Gio.file_new_for_path(registryPath);
    if (registryFile.query_exists(null)) registryFile.delete(null);
    GLib.rmdir(testDir);
}
