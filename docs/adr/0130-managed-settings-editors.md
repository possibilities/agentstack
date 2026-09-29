# 130. Managed settings editors in Fleet and Workers

Status: accepted, 2026-09-29. Presents the managed runtime settings of [ADR 0128](0128-managed-runtime-settings.md). Supersedes in part the read-only Workers space of [ADR 0102](0102-workers-space.md): Workers may now edit and apply saved model and effort settings, and nothing else. Replaces the Fleet Defaults form of [ADR 0037](0037-bot-launch-settings.md) with the managed editor.

## Decision

The UI edits managed settings where their instances already live. There is no Settings space.

- **Fleet.** Each Bot's action menu opens **Settings…**, a dialog keyed by Bot ID. The Bots window's Defaults button, and the palette's Bot defaults entry, open the same editor on the future-Bot defaults document. The legacy merge-only `bot_defaults_set` form is no longer offered; `bot_start`'s four-field launch settings remain in the Create and Start dialogs, and Create explains that it copies the current defaults.
- **Workers.** The Worker window gains a **Settings** tab. The Workers window's header opens provider defaults for Codex, Grok, Devin and Claude, with a reference account that only suggests choices. No prompt, permission answer, cancel, close or removal control is added.

One editor renders every target from the catalog the server returns. Controls are derived from each key's JSON Schema; there is no copied key inventory. Adapters supply native choices (live Bot discovery, or a Worker account catalog) and application actions.

## Presentation

Every field shows saved, loaded, resolved, effective, native-default and application-default evidence separately, labelled with where it came from. Evidence state is interpreted before value: a known native null, omission (Unset), and no observation (Not observed) are different text, never inferred with fallbacks. `pending` is labelled as saved-versus-loaded, not as a mismatch or a failure. Defaults documents show no pending or application state; they say they are copied into new instances. Voice fields take their loaded evidence from the connected call only.

Controls are tri-state: Unset, an explicit value, and for `voice.prompt` an explicit native null. An empty number is invalid rather than zero; an empty list is an explicit `[]`. Discovery that cannot answer (`null`) differs from discovery that offers nothing (`[]`); a saved identifier no longer offered stays selected and labelled. Dependencies are explained, never enforced by rewriting another field; the sandbox/profile exclusion is explained so the human resets one in the same save.

## Editing and application

A draft is local to one editor instance and keyed by its full target, so switching targets or opening another window never transfers intent. The saved view and its evidence are shared through the store, watched by target and re-read on the notices of ADR 0128's invalidation matrix, after reconnects, and after every settings write settles either way. Reads coalesce while notices stream.

Saving is review then save. The review previews the exact minimal patch against the draft's baseline revision; the save sends the same arguments and request ID and is single-flight. If another writer advances the saved revision, the draft is kept and the save is blocked until the human rebases or discards it. An unknown outcome keeps the exact payload and request ID for an explicit retry, which the server answers with the original receipt; nothing retries automatically. A settled save clears only the draft entries it carried. Closing with unsaved edits asks first.

Application is a separate, explicit action. **Start with saved settings** is offered only for a stopped, account-assigned, unfenced Bot; a running Bot is told its settings load on its next start and is never stopped by the editor. **Apply saved settings** is offered only from a fresh status read showing an idle Worker with a native session whose runtime matches the settings view, and sends that runtime as `expectedInstance`. Failures are shown and re-read, never replayed.

## Access

Remote `ui:view` can inspect and review but not save. Remote `ui:control` can save Bot settings and defaults, including next-call voice preferences, under the current Bot control selection; live call evidence is described as unavailable remotely because `voice_changed` is not delivered there. Worker settings writes remain local-only, matching the remote Access policy, which selects no Worker mutations. Changing that is a separate Access decision.

## Consequences

The Workers space is no longer purely read-only; this ADR bounds the exception to managed settings. New managed keys appear in the editors without UI changes, since controls follow the catalog. Pre-launch advanced settings for a brand-new Bot, a dedicated call snapshot identity, and audible voice verification still need backend work before the UI can offer them.
