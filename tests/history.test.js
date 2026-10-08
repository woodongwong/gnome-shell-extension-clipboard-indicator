import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual indicator methods without running a second GNOME Shell
// or connecting test actors to the user's desktop/session bus.
const source = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class', 'class');
const context = vm.createContext({
    Extension: class {},
    PanelMenu: {Button: class {}},
    St: {ClipboardType: {CLIPBOARD: 1}},
    GObject: {registerClass: (_properties, type) => type},
    PopupMenu: {Ornament: {DOT: 1}},
});
vm.runInContext(source + '\nglobalThis.Indicator = ClipboardIndicator;', context);
const indicator = new context.Indicator();
let writes = 0;
let clipboardWrites = 0;
indicator._updateCache = () => writes++;
indicator.preventIndicatorUpdate = true;
indicator.extension = {clipboard: {set_content: () => clipboardWrites++}};

const historyBox = {};
const historyRows = [];
indicator.historySection = {
    box: historyBox,
    get firstMenuItem () { return historyRows[0]; },
    moveMenuItem (item, position) {
        historyRows.splice(historyRows.indexOf(item), 1);
        historyRows.splice(position, 0, item);
    },
};
indicator.favoritesSection = {box: {}};
function row (name) {
    return {
        entry: {isFavorite: () => false, mimetype: () => 'text/plain', asBytes: () => name},
        clipContents: name,
        actor: {get_parent: () => historyBox},
        _ornamentIcon: {opacity: 0},
        setOrnament () {},
    };
}
const older = row('older');
const newest = row('newest');
indicator.clipItemsRadioGroup = [older, newest];
older.radioGroup = newest.radioGroup = indicator.clipItemsRadioGroup;
historyRows.push(newest, older);

indicator._selectMenuItem(older, false);
indicator._moveItemFirst(older);
assert.equal(historyRows[0], older, 'existing row did not move to the top');
assert.equal(indicator.clipItemsRadioGroup.at(-1), older, 'persistence order was not updated');
assert.equal(older.currentlySelected, true, 'moving a row cleared its selection');
assert.equal(newest.currentlySelected, false, 'previous row remained selected');
assert.equal(clipboardWrites, 0, 'observing an external copy rewrote the clipboard');
assert.equal(writes, 1);

indicator._moveItemFirst(older);
assert.equal(writes, 1, 'copying the newest entry unnecessarily saved all history again');
const menu = {close: () => { menu.closed = true; }};
newest.menu = menu;
indicator._onMenuItemSelectedAndMenuClose(newest, true);
assert.equal(newest.currentlySelected, true, 'row activation did not select it');
assert.equal(older.currentlySelected, false);
assert.equal(clipboardWrites, 1, 'selection did not update the clipboard exactly once');
assert.equal(menu.closed, true);

// Pin/unpin changes sections and intentionally follows the rebuild path.
let rebuilt = false;
older.entry.isFavorite = () => true;
indicator._removeEntry = (item, options) => {
    assert.equal(item, older);
    assert.equal(options.deleteCachedFile, false);
    assert.equal(options.persist, false);
};
indicator._addEntry = (entry, selected, autoSet) => {
    assert.equal(entry, older.entry);
    assert.equal(selected, false);
    assert.equal(autoSet, false);
    rebuilt = true;
};
indicator._moveItemFirst(older);
assert.equal(rebuilt, true);
assert.equal(writes, 2);
console.log('history row reuse, recency, selection and pin transition: ok');

// Verify the actual async refresh path acquires ownership inside the native
// callback, not in the Promise continuation after that callback has returned.
context.Shell = {Global: {get: () => ({display: {focusWindow: null}})}};
let callbackLive = false;
let captures = 0;
let added;
const capturedEntry = {isImage: () => false};
context.ClipboardEntry = {
    fromClipboard (mimetype, bytes) {
        assert.equal(callbackLive, true, 'clipboard ownership acquired after callback return');
        assert.equal(mimetype, 'text/plain;charset=utf-8');
        assert.equal(bytes.get_size(), 4);
        captures++;
        return capturedEntry;
    },
};
const refreshIndicator = new context.Indicator();
refreshIndicator.clipItemsRadioGroup = [];
refreshIndicator._addEntry = entry => {
    assert.equal(callbackLive, false, 'refresh did not cross the async ownership boundary');
    added = entry;
};
refreshIndicator._removeOldestEntries = () => {};
refreshIndicator._updateCache = () => {};
refreshIndicator._showNotification = () => {};
refreshIndicator._blinkIcon = () => {};
context._ = text => text;
for (const offeredType of ['text/plain;charset=utf-8', 'UTF8_STRING']) {
    added = null;
    refreshIndicator.extension = {clipboard: {
        get_content (_selection, mimetype, callback) {
            callbackLive = true;
            try {
                callback(null, mimetype === offeredType ? {get_size: () => 4} : null);
            } finally {
                callbackLive = false;
            }
        },
    }};
    await refreshIndicator._refreshIndicator();
    assert.equal(added, capturedEntry, 'async refresh did not use the owned clipboard entry');
}
assert.equal(captures, 2, 'clipboard ownership was not acquired exactly once per copy');
console.log('clipboard capture owns bytes inside callback before async refresh: ok');
