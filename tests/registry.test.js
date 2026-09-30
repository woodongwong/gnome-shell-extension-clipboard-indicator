import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { ClipboardEntry, Registry, decodeEscapedUtf8, serializeRegistryChunks } from '../registry.js';

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
    const chunkBoundaryText = 'a'.repeat(16383) + '😀问题\\\"\n\t\u0000' +
        '\uD800' + '\uDC00' + '\uD800X\uDC00' + '汉字😀'.repeat(16000);
    const chunkSnapshot = [{favorite: false, mimetype: 'text/plain;charset=utf-8',
        contents: chunkBoundaryText, tag: chunkBoundaryText}];
    const chunks = [...serializeRegistryChunks(chunkSnapshot)];
    assert(chunks.every(chunk => chunk.length <= 16384), 'JSON chunks exceeded the main-loop work limit');
    assert(chunks.join('') === JSON.stringify(chunkSnapshot), 'chunked JSON changed escaping or surrogate pairs');
    // Convert every chunk separately, exactly as the file writer does. Joining
    // JS strings alone would hide surrogate pairs broken at a UTF-8 boundary.
    const encodedChunks = chunks.map(chunk => new GLib.Bytes(chunk).get_data());
    const decodedChunks = encodedChunks.map(bytes => new TextDecoder().decode(bytes));
    assert(JSON.parse(decodedChunks.join(''))[0].contents === chunkBoundaryText,
        'per-chunk UTF-8 conversion corrupted clipboard text');
    assert([...serializeRegistryChunks([])].join('') === '[]', 'empty history was not serialized');

    const nativeBytes = new GLib.Bytes(new Uint8Array([1, 2, 3, 4]));
    const imageEntry = new ClipboardEntry('image/png', nativeBytes, false);
    assert(imageEntry.asBytes() === nativeBytes, 'native clipboard bytes were copied');
    const sameImage = new ClipboardEntry('image/png', new Uint8Array([1, 2, 3, 4]), false);
    assert(sameImage.asBytes() === sameImage.asBytes(), 'entry bytes were not cached');
    assert(imageEntry.equals(sameImage), 'identical images were not recognized');
    assert(!imageEntry.equals(new ClipboardEntry('image/png', new Uint8Array([1, 2, 3, 5]), false)),
        'different images compared equal');
    assert(!imageEntry.equals(new ClipboardEntry('text/plain', new TextEncoder().encode(imageEntry.getStringValue()), false)),
        'image description was mistaken for image data');
    const editable = new ClipboardEntry('text/plain;charset=utf-8', nativeBytes, false);
    const oldHash = editable.getHash();
    editable.setText('updated中文');
    assert(new TextDecoder().decode(editable.asBytes().get_data()) === 'updated中文', 'editing reused stale bytes');
    assert(editable.getHash() !== oldHash, 'editing reused a stale hash');

    const escapedChinese = String.raw`\E9\97\AE\E9\A2\98 6\EF\BC\9A`;
    assert(decodeEscapedUtf8(escapedChinese) === '问题 6：',
        'valid escaped UTF-8 was not decoded');
    assert(decodeEscapedUtf8(String.raw`C:\E9\docs`) === String.raw`C:\E9\docs`,
        'invalid escaped UTF-8 should remain unchanged');
    assert(decodeEscapedUtf8(String.raw`\41\42`) === String.raw`\41\42`,
        'ASCII escapes should remain unchanged');

    const repairedEntry = new ClipboardEntry(
        'text/plain', new TextEncoder().encode(escapedChinese), false
    );
    assert(repairedEntry.getStringValue() === '问题 6：',
        'text/plain entry was not repaired');
    assert(repairedEntry.wasNormalized(),
        'repaired entry was not marked for cache migration');

    const literalEntry = new ClipboardEntry(
        'text/plain;charset=utf-8', new TextEncoder().encode(escapedChinese), false
    );
    assert(literalEntry.getStringValue() === escapedChinese,
        'explicit UTF-8 content should not be normalized');
    assert(!literalEntry.wasNormalized(),
        'unchanged entry was incorrectly marked as normalized');

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

    await originalWriteToFile(chunkSnapshot);
    const [readSuccess, persistedBytes] = GLib.file_get_contents(registryPath);
    assert(readSuccess && new TextDecoder().decode(persistedBytes) === JSON.stringify(chunkSnapshot),
        'chunked async write did not round-trip the complete snapshot');

    // Abort after several chunks have reached the replacement stream. Even
    // finalizing the failed stream must not publish an incomplete history.
    const brokenSnapshot = [chunkSnapshot[0], {
        get contents () { throw new Error('Injected serialization failure'); },
    }];
    let failedMidWrite = false;
    try { await originalWriteToFile(brokenSnapshot); } catch { failedMidWrite = true; }
    assert(failedMidWrite, 'serialization failure did not reject the write');
    System.gc();
    await delay(10);
    const [, unchangedBytes] = GLib.file_get_contents(registryPath);
    assert(new GLib.Bytes(unchangedBytes).equal(new GLib.Bytes(persistedBytes)),
        'failed replacement published an incomplete history');

    const writeImage = registry.writeEntryFile(imageEntry);
    assert(registry.writeEntryFile(imageEntry) === writeImage, 'concurrent image writes were not coalesced');
    await writeImage;
    const imagePath = registry.getEntryFilename(imageEntry);
    const [imageSuccess, imageBytes] = GLib.file_get_contents(imagePath);
    assert(imageSuccess && new GLib.Bytes(imageBytes).equal(nativeBytes), 'image cache write changed its bytes');
    await registry.deleteEntryFile(imageEntry);
    assert(!GLib.file_test(imagePath, GLib.FileTest.EXISTS), 'deleted image remained in the cache');

    const brokenRegistry = new Registry({settings: {}, uuid: 'write-error-test'});
    brokenRegistry.REGISTRY_DIR = `${registryPath}/not-a-directory`;
    brokenRegistry.REGISTRY_PATH = `${brokenRegistry.REGISTRY_DIR}/registry.txt`;
    for (const operation of [
        () => brokenRegistry.writeToFile(chunkSnapshot),
        () => brokenRegistry.writeEntryFile(imageEntry),
    ]) {
        let rejected = false;
        try { await operation(); } catch { rejected = true; }
        assert(rejected, 'file I/O error did not reject its promise');
    }
    assert(GLib.file_test(registryPath, GLib.FileTest.EXISTS), 'failed write damaged the existing cache');

    console.log('registry queue, chunked UTF-8 persistence, cached image bytes and I/O errors: ok');
}
finally {
    const directory = Gio.file_new_for_path(testDir);
    const enumerator = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null))) directory.get_child(info.get_name()).delete(null);
    enumerator.close(null);
    directory.delete(null);
}
