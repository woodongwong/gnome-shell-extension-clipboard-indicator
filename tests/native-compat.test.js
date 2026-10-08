import St from 'gi://St';
import { boxLayoutOrientation } from '../compat.js';

// Inspect the installed native type; do not initialize a compositor, create
// actors or change the user's extension settings.
const names = St.BoxLayout.list_properties().map(property => property.name);
for (const vertical of [false, true]) {
    const properties = boxLayoutOrientation(vertical);
    for (const name of Object.keys(properties)) {
        if (!names.includes(name)) throw new Error(`Unsupported BoxLayout property: ${name}`);
    }
}
console.log('installed St.BoxLayout orientation properties: ok');
