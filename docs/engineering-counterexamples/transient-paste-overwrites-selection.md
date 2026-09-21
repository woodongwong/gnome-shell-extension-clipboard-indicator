# Do not conflate selection with explicit paste

## Scenario and goal

Clipboard history supports two distinct actions: selecting an entry as the active clipboard value and explicitly pasting an entry into the focused application. Pointer clicks and Space should select; the paste button and `V` should paste; Enter may paste when the corresponding preference is enabled.

## Wrong choice and consequence

The row activation path treated every activation source as a paste request. As a result, a pointer click or Space sent a synthetic paste to the focused application when the user only intended to change the clipboard selection. Earlier cleanup also restored the previous clipboard entry after a row activation, which could revert the newly selected item.

## Better approach and signals

Determine behavior from the activation source instead of sharing one unconditional action:

- Pointer activation, accessibility activation, and Space update the selection without synthesizing a paste.
- Enter can select and paste when the preference is enabled, leaving the selected entry authoritative afterward.
- The dedicated paste button and `V` paste without changing the current selection, so their delayed cleanup restores the prior selected entry.
- Delayed cleanup must restore the state that is authoritative after the operation, not blindly restore the state captured before the operation.

When a feature temporarily mutates observable state and an event listener derives UI state from it, verify the full event sequence through the delayed cleanup, not only the synchronous selection update.

## Boundary

Restoring the pre-operation value is correct for explicit paste-only actions that promise not to change selection. It is incorrect for an action that also changes the active clipboard item. Applications that intentionally define click or Space as immediate paste may choose different bindings, but the distinction should remain explicit.

## Evidence and status

- Date: 2026-09-21
- Status: confirmed by the user's requested interaction and code-path analysis; click/Space behavior implemented and current setting applied, awaiting post-login interaction confirmation of the new source code.
- Relevant code: `extension.js`, row activation, Enter handling, and `#pasteItem()`.
