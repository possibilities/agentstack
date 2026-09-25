# 45. Links go to cards; clicking a card inspects it in an edge sheet

Status: accepted, 2026-09-25. Refines [ADR 0042](0042-canvas-spaces.md) and the inspector from [ADR 0024](0024-live-canvas-workbench.md).

Spaces made two interactions collide. A single `focus` both moved the canvas and opened the inspector, so a Packages index row opened the inspector instead of taking you to the package, and a jump into another space could leave the inspector showing a record from the space you had just left. The inspector also floated as an inset card over the canvas, hiding the cards it described.

The canvas now separates the two. **Links go to a card**: palette results, Packages index rows, Activity rows, inspector "Related" and operation links, and `?focus=` URLs pan to the card's home window, switching spaces if needed, and briefly flash it. They never open the inspector. **Clicking a card inspects it.** A window that represents one record, such as a package window, is itself a card: clicking its header inspects it. The inspector only ever describes something on the current canvas, so any space change closes it, and its "Show on canvas" action goes back to the inspected card.

The inspector is a sheet attached to the right edge of the screen. It slides in and, on wide screens, pushes the canvas, top bar, toolbar, and call dock aside rather than covering them; below 900 px it overlays. Because the world is anchored at the viewport's top left, opening it does not move the cards. The package inspector no longer repeats the package window's operation list and shows connection details instead.

Space tabs mark a space that needs attention — a Bot that needs inspection, an unfinished account removal, a failed sign-in, a stopped owner child, or a reconnecting channel — with the reasons in the tab's tooltip, so problems in a space you are not viewing stay discoverable. The top bar's connection summary lists every Package API that has a WebSocket endpoint instead of a fixed set.
