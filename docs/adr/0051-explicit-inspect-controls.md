# 51. Explicit inspect controls

Status: accepted, 2026-09-25. Amends [ADR 0045](0045-canvas-links-and-inspector-sheet.md).

Clicking inside a card or a window header no longer inspects or moves focus: NodeCard drops its full-card Inspect button (and the pointer-events juggling it required), and a window header tap only drags. A card's visible name — the new `NodeTitle` button — and a node window's title button are the inspect controls, with `aria-pressed` selection state; NodeTitle takes an `onActivate` for deliberate navigation like the Packages index rows.

Actions never navigate as a side effect: starting a sign-in or adding an account leaves the view where it is. Deliberate links keep their behavior — related-account chips, inspector "Show on canvas" and Related buttons, palette jump items, and Activity rows still pan and flash. Inside a card, form fields now behave normally (the Devin paste input needs no `autoFocus`); modal dialogs keep first-field focus as the standard convention.
