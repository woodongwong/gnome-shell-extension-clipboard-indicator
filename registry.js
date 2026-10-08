import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;
const escapedByteRun = /(?:\\[0-9A-Fa-f]{2})+/g;
const escapedByte = /\\([0-9A-Fa-f]{2})/g;

const JSON_CHUNK_SIZE = 16 * 1024;

function* registryJsonTokens (registry) {
    yield '[';
    for (let i = 0; i < registry.length; i++) {
        yield i === 0 ? '{' : ',{';
        let separator = '';
        for (const [key, value] of Object.entries(registry[i])) {
            if (value === undefined) continue;
            yield separator + JSON.stringify(key) + ':';
            separator = ',';
            if (typeof value !== 'string') {
                yield JSON.stringify(value);
                continue;
            }

            yield '"';
            for (let start = 0; start < value.length;) {
                let end = Math.min(start + JSON_CHUNK_SIZE, value.length);
                // Keep surrogate pairs together; otherwise JSON.stringify
                // would escape the two halves instead of the original emoji.
                if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
                yield JSON.stringify(value.slice(start, end)).slice(1, -1);
                start = end;
            }
            yield '"';
        }
        yield '}';
    }
    yield ']';
}

export function* serializeRegistryChunks (registry) {
    let buffer = '';
    for (const token of registryJsonTokens(registry)) {
        for (let offset = 0; offset < token.length;) {
            let length = Math.min(JSON_CHUNK_SIZE - buffer.length, token.length - offset);
            // Do not split an unescaped surrogate pair when converting a
            // chunk to UTF-8. A one-character gap is flushed before the pair.
            const end = offset + length;
            if (end < token.length && /[\uD800-\uDBFF]/u.test(token[end - 1])) length--;
            buffer += token.slice(offset, offset + length);
            offset += length;
            if (buffer.length === JSON_CHUNK_SIZE || length === 0) {
                yield buffer;
                buffer = '';
            }
        }
    }
    if (buffer) yield buffer;
}

function closeStream (stream, cancellable = null) {
    return new Promise((resolve, reject) => {
        stream.close_async(GLib.PRIORITY_DEFAULT, cancellable, (obj, result) => {
            try {
                obj.close_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

export function decodeEscapedUtf8 (text) {
    return text.replace(escapedByteRun, run => {
        const bytes = Uint8Array.from(
            [...run.matchAll(escapedByte)], match => parseInt(match[1], 16)
        );

        try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

            // ASCII-only escapes commonly occur in paths and source code. The
            // broken clipboard representation we repair encodes non-ASCII UTF-8.
            return /[^\x00-\x7F]/u.test(decoded) ? decoded : run;
        }
        catch {
            // An incomplete or non-UTF-8 run is ordinary user content.
            return run;
        }
    });
}

export class Registry {
    #pendingEntries = null;
    #writeScheduledId = 0;
    #writeInProgress = false;
    #imageWrites = new Map();

    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
    }

    write (entries) {
        // Keep only the newest snapshot. UI actions can request several writes in
        // one main-loop iteration, and persisting every intermediate state both
        // blocks GNOME Shell during serialization and allows stale async writes
        // to finish last.
        this.#pendingEntries = entries.slice();
        this.#scheduleWrite();
    }

    #scheduleWrite () {
        if (this.#writeScheduledId !== 0 || this.#writeInProgress) return;

        this.#writeScheduledId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.#writeScheduledId = 0;
            this.#drainWrites();
            return GLib.SOURCE_REMOVE;
        });
    }

    async #drainWrites () {
        if (this.#writeInProgress) return;

        this.#writeInProgress = true;
        try {
            // A write requested while I/O is in progress replaces the pending
            // snapshot and is persisted after the current write. This preserves
            // ordering while coalescing transient states.
            while (this.#pendingEntries !== null) {
                const entries = this.#pendingEntries;
                this.#pendingEntries = null;
                const registry = await this.#buildRegistry(entries);
                await this.writeToFile(registry);
            }
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to write registry file');
            console.error(e);
        }
        finally {
            this.#writeInProgress = false;
            if (this.#pendingEntries !== null) this.#scheduleWrite();
        }
    }

    async #buildRegistry (entries) {
        const registryContent = [];
        const imageWrites = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                const filename = this.getEntryFilename(entry);
                item.contents = filename;
                imageWrites.push(this.writeEntryFile(entry));
            }

            if (entry.getTag()) item.tag = entry.getTag();
        }

        // Publish image references only after their files are complete.
        await Promise.all(imageWrites);
        return registryContent;
    }

    async writeToFile (registry) {
        // Make sure dir exists
        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));

        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const cancellable = new Gio.Cancellable();
        const stream = await new Promise((resolve, reject) => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                               GLib.PRIORITY_DEFAULT, cancellable, (obj, res) => {
                try {
                    resolve(obj.replace_finish(res));
                }
                catch (e) {
                    reject(e);
                }
            });
        });

        try {
            // Serialization, UTF-8 conversion and I/O are bounded per chunk.
            // An idle callback alone still freezes Shell if it encodes the
            // entire multi-megabyte history in a single main-loop iteration.
            for (const chunk of serializeRegistryChunks(registry)) {
                const contents = new GLib.Bytes(chunk);
                let offset = 0;
                while (offset < contents.get_size()) {
                    const remaining = GLib.Bytes.new_from_bytes(contents, offset, contents.get_size() - offset);
                    const written = await new Promise((resolve, reject) => {
                        stream.write_bytes_async(remaining, GLib.PRIORITY_DEFAULT,
                                                 cancellable, (obj, result) => {
                            try {
                                resolve(obj.write_bytes_finish(result));
                            }
                            catch (e) {
                                reject(e);
                            }
                        });
                    });
                    if (written <= 0) throw new Error('Clipboard Indicator: empty registry write');
                    offset += written;
                }
            }
            // Closing a replacement file can flush/fsync and rename it; this
            // must be asynchronous too, especially on a busy disk.
            await closeStream(stream, cancellable);
        } catch (error) {
            cancellable.cancel();
            try {
                await closeStream(stream, cancellable);
            } catch {
                // Preserve the original write error.
            }
            throw error;
        }
    }

    async read () {
        return new Promise(resolve => {
            if (GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) {
                let file = Gio.file_new_for_path(this.REGISTRY_PATH);
                let CACHE_FILE_SIZE = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);

                file.query_info_async('*', FileQueryInfoFlags.NONE,
                                      GLib.PRIORITY_DEFAULT, null, (src, res) => {
                    // Check if file size is larger than CACHE_FILE_SIZE
                    // If so, make a backup of file, and resolve with empty array
                    let file_info = src.query_info_finish(res);

                    if (file_info.get_size() >= CACHE_FILE_SIZE * 1024 * 1024) {
                        let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);

                        file.move(destination, FileCopyFlags.OVERWRITE, null, null);
                        resolve([]);
                        return;
                    }

                    file.load_contents_async(null, (obj, res) => {
                        let [success, contents] = obj.load_contents_finish(res);

                        if (success) {
                            let max_size = this.settings.get_int(PrefsFields.HISTORY_SIZE);
                            const cacheTextData = new TextDecoder().decode(contents);
                            let registry;
                            if (cacheTextData.trim().length == 0) {
                                registry = [];
                            } else {
                                registry = JSON.parse(cacheTextData);
                            }
                            const entriesPromises = registry.map(
                                jsonEntry => {
                                    return ClipboardEntry.fromJSON(jsonEntry)
                                }
                            );

                            Promise.all(entriesPromises).then(clipboardEntries => {
                                clipboardEntries = clipboardEntries
                                    .filter(entry => entry !== null);

                                let registryNoFavorite = clipboardEntries
                                    .filter(entry => !entry.isFavorite());

                                while (registryNoFavorite.length > max_size) {
                                    let oldestNoFavorite = registryNoFavorite.shift();
                                    let itemIdx = clipboardEntries.indexOf(oldestNoFavorite);
                                    clipboardEntries.splice(itemIdx,1);

                                    registryNoFavorite = clipboardEntries.filter(
                                        entry => !entry.isFavorite()
                                    );
                                }

                                resolve(clipboardEntries);
                            }).catch(e => {
                                console.error(e);
                            });
                        }
                        else {
                            console.error('Clipboard Indicator: failed to open registry file');
                        }
                    });
                });
            }
            else {
                resolve([]);
            }
        });
    }

    #entryFileExists (entry) {
        const filename = this.getEntryFilename(entry);
        return GLib.file_test(filename, FileTest.EXISTS);
    }

    async getEntryAsImage (entry) {
        if (entry.isImage() === false) return;

        if (this.#entryFileExists(entry) == false) {
            await this.writeEntryFile(entry);
        }

        const gicon = Gio.icon_new_for_string(this.getEntryFilename(entry));
        const stIcon = new St.Icon({ gicon });
        return stIcon;
    }

    async getEntryAsTexture (entry) {
        if (entry.isImage() === false) return null;

        if (this.#entryFileExists(entry) === false) {
            await this.writeEntryFile(entry);
        }

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.getHash()}`;
    }

    writeEntryFile (entry) {
        const filename = this.getEntryFilename(entry);
        if (this.#imageWrites.has(filename)) return this.#imageWrites.get(filename);
        if (this.#entryFileExists(entry)) return Promise.resolve();

        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
        const file = Gio.file_new_for_path(filename);
        const write = new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(entry.asBytes(), null, false,
                Gio.FileCreateFlags.NONE, null, (obj, result) => {
                    try {
                        obj.replace_contents_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
        }).finally(() => this.#imageWrites.delete(filename));
        this.#imageWrites.set(filename, write);
        return write;
    }

    async deleteEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));

        try {
            await new Promise((resolve, reject) => {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, (obj, result) => {
                    try {
                        obj.delete_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        }
        catch (e) {
            console.error(e);
        }
    }

    clearCacheFolder() {

        const CANCELLABLE = null;
        try {
            const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
            const enumerator = folder.enumerate_children("", 1, CANCELLABLE);

            let file;
            while ((file = enumerator.iterate(CANCELLABLE)[2]) != null) {
                file.delete(CANCELLABLE);
            }

        }
        catch (e) {
            console.error(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #nativeBytes = null;
    #hash = null;
    #favorite;
    #stringValue = null;
    #wasNormalized = false;

    static #decode (contents) {
        return Uint8Array.from(contents.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    }

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static fromClipboard (mimetype, bytes) {
        // StClipboard gives the callback a borrowed GBytes. In GJS 1.90 the
        // wrapper does not own it; St frees it as soon as the callback returns.
        // A full-range slice owns a reference to the backing bytes without
        // copying their contents, so Promise continuations/history remain safe.
        const ownedBytes = GLib.Bytes.new_from_bytes(bytes, 0, bytes.get_size());
        return new ClipboardEntry(mimetype, ownedBytes, false);
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        let bytes;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(jsonEntry.contents);
        }
        else {
            const filename = jsonEntry.contents;
            if (!GLib.file_test(filename, FileTest.EXISTS)) return null;

            let file = Gio.file_new_for_path(filename);

            const contentType = await file.query_info_async('*', FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                try {
                    const fileInfo = obj.query_info_finish(res);
                    return fileInfo.get_content_type();
                } catch (e) {
                    console.error(e);
                }
            });

            if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('text/')) {
                bytes = new TextEncoder().encode(jsonEntry.contents);
            }
            else {
                bytes = await new Promise((resolve, reject) => file.load_contents_async(null, (obj, res) => {
                    let [success, contents] = obj.load_contents_finish(res);

                    if (success) {
                        resolve(contents);
                    }
                    else {
                        reject(
                            new Error('Clipboard Indicator: could not read image file from cache')
                        );
                    }
                }));
            }
        }

        const entry = new ClipboardEntry(mimetype, bytes, favorite);
        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        return entry;
    }

    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        if (bytes instanceof GLib.Bytes) {
            this.#nativeBytes = bytes;
            this.#bytes = null;
        } else {
            this.#bytes = bytes;
        }
        this.#favorite = favorite;

        if (mimetype === 'text/plain') {
            const decoded = new TextDecoder().decode(this.#getData());
            const normalized = decodeEscapedUtf8(decoded);
            this.#stringValue = normalized;
            if (normalized !== decoded) {
                this.#bytes = new TextEncoder().encode(normalized);
                this.#nativeBytes = null;
                this.#wasNormalized = true;
            }
        }
    }

    #getData () {
        return this.#bytes ?? this.#nativeBytes.get_data();
    }

    getStringValue () {
        if (this.#stringValue === null) {
            this.#stringValue = this.isImage()
                ? `[Image ${this.getHash()}]`
                : new TextDecoder().decode(this.#getData());
        }
        return this.#stringValue;
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    wasNormalized () {
        return this.#wasNormalized;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    setText (text) {
        if (!this.isText()) return;
        this.#bytes = new TextEncoder().encode(text);
        this.#nativeBytes = null;
        this.#hash = null;
        this.#stringValue = text;
        this.#wasNormalized = false;
    }

    #tag = null;

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    asBytes () {
        this.#nativeBytes ??= GLib.Bytes.new(this.#bytes);
        return this.#nativeBytes;
    }

    getHash () {
        this.#hash ??= this.asBytes().hash();
        return this.#hash;
    }

    equals (otherEntry) {
        if (this.isImage() || otherEntry.isImage()) {
            if (!this.isImage() || !otherEntry.isImage()) return false;
            return this.asBytes().get_size() === otherEntry.asBytes().get_size() &&
                this.getHash() === otherEntry.getHash() &&
                this.asBytes().equal(otherEntry.asBytes());
        }
        return this.getStringValue() === otherEntry.getStringValue();
    }
}
