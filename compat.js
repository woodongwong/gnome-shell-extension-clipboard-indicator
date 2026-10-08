import Clutter from 'gi://Clutter';
import St from 'gi://St';

// orientation was added in Shell 48; vertical was removed in Shell 51.
// Keep the same layout on the older Shell versions we still support.
const hasOrientation = St.BoxLayout.list_properties().some(property => property.name === 'orientation');

export function boxLayoutOrientation (vertical) {
    return hasOrientation
        ? {orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL}
        : {vertical};
}
