# Temporary paste state must not overwrite a new selection

## Scenario and goal

With “Paste on select” enabled, clicking a history row should paste that entry and leave the clicked entry selected. Clicking the dedicated paste button should paste without changing the current selection.

## Wrong choice and consequence

The row-click path captured the previously selected entry, temporarily put the clicked entry on the clipboard, marked it selected, and then restored the previous entry after the synthetic paste. The clipboard listener treated that restoration as a new selection event, so the user's new selection was reverted.

## Better approach and signals

The caller that owns the interaction semantics must explicitly choose the post-paste clipboard state:

- Row activation and Enter restore the clicked entry because they are selection actions.
- The dedicated paste button restores the prior selected entry because it is only a paste action.
- Delayed cleanup must restore the state that is authoritative after the operation, not blindly restore the state captured before the operation.

When a feature temporarily mutates observable state and an event listener derives UI state from it, verify the full event sequence through the delayed cleanup, not only the synchronous selection update.

## Boundary

Restoring the pre-operation value is correct for temporary actions that explicitly promise not to change selection. It is incorrect when the same action also represents a user selection.

## Evidence and status

- Date: 2026-09-20
- Status: confirmed by user report and code-path analysis; fix deployed, awaiting user interaction confirmation.
- Relevant code: `extension.js`, row activation and `#pasteItem()`.
