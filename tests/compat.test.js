import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function source (filename) {
    return fs.readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export /gm, '');
}

for (const modern of [false, true]) {
    const context = vm.createContext({
        St: {BoxLayout: {list_properties: () => [{name: modern ? 'orientation' : 'vertical'}]}},
        Clutter: {Orientation: {VERTICAL: 1, HORIZONTAL: 0}},
    });
    vm.runInContext(source('compat.js'), context);
    for (const vertical of [false, true]) {
        const properties = vm.runInContext(`boxLayoutOrientation(${vertical})`, context);
        assert.equal(JSON.stringify(properties), JSON.stringify(modern
            ? {orientation: vertical ? 1 : 0} : {vertical}));
    }
}

for (const modern of [false, true]) {
    let devices = 0;
    let disposed = false;
    let disconnected = false;
    const device = {run_dispose: () => { disposed = true; }};
    const backend = {get_default_seat: () => ({
        create_virtual_device: type => {
            assert.equal(type, 1);
            devices++;
            return device;
        },
    })};
    const context = vm.createContext({
        global: {stage: modern ? {context: {get_backend: () => backend}} : {}},
        Clutter: {InputDeviceType: {KEYBOARD_DEVICE: 1},
            ...(modern ? {} : {get_default_backend: () => backend})},
        Main: {inputMethod: {connectObject () {}, disconnectObject () { disconnected = true; }}},
    });
    vm.runInContext(source('keyboard.js') + '\nconst keyboard = new Keyboard(); keyboard.destroy();', context);
    assert.equal(devices, 1);
    assert.equal(disposed, true);
    assert.equal(disconnected, true);
}

console.log('Shell 46/47 and 48–51 layout and keyboard compatibility: ok');
