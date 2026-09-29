# 126. The Roles space edits fragment conditions and previews a rendering context

Status: accepted, 2026-09-29. Brings the fragment conditionality of [ADR 0123](0123-role-injection-for-native-clis.md) into the Roles space of [ADR 0082](0082-roles-space-for-instruction-fragments.md) and [ADR 0121](0121-roles-space-for-named-roles.md). No API change was needed.

## Decision

Conditions are edited in the existing fragment editor, beside the enabled switch, as one field per dimension ("Model equals", "Harness equals"). The fields come from one shared list of dimensions, so a new dimension appears without new editor structure. Values are free text, preserved verbatim and validated as the API does. The editor never offers a catalog of models or harnesses. The draft owns conditions as one canonical JSON field, so they share the existing conflict, keep-mine and use-theirs workflow. A save sends the complete replacement object only when conditions changed; unrelated edits omit it, and the API preserves it. Clearing sends `{}`, never empty strings. Creating or duplicating a fragment carries its conditions.

The Preview window owns one rendering context, held by the store for the page rather than for a Role. It survives Role selection and applies to both `role_preview` and `role_launch_preview`. Editing it rereads only those two previews. It never writes to a Role or configures a native runtime. An empty context omits the argument, which previews what Bots and Workers receive today. Preview reads are fenced by Role ID and context as well as by revision, so an answer for an earlier context is dropped even at a higher revision. The held preview records the context it answers, so the page shows "Updating…" rather than presenting it under the new context.

Fragment rows, category counts and the editor judge each fragment against that same context. They distinguish Off, Category off, Empty, Needs context and No match from Renders, so an enabled fragment whose conditions do not match is never called Off. When a context is set, the Preview window shows the equivalent `stack roles inject … --with-model … --with-harness …` prefix. It states that only those flags supply context and that Bots and Workers supply none.

## Consequences

Operators can author conditional fragments and check exactly what an injected launch receives without the API. Local counts and the preview's segments come from the same exact-match rule and context, so they agree. Wiring Bot or Worker launches to a context remains the separate backend decision named in ADR 0123. The page does not imply that choosing a Bot or Worker model activates conditional fragments.
