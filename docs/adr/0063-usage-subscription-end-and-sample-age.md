# 63. Usage subscription end and sample age

Status: accepted, 2026-09-26. Extends the `usage` Package API from
[ADR 0044](0044-owner-usage-observations.md) and the Usage window from
[ADR 0062](0062-usage-limits-and-grok-bot-card.md).

## Decision

Each `usage_snapshot` account carries a nullable, account-level
`subscription`: when its current paid subscription period ends, where that
end came from, and when the provider last confirmed it. Only two sources
expose it today:

- **Devin** (`plan_period`): the `planEnd` of `GetUserStatus`, already
  measured as `usage.periodEnd`; it is confirmed at the measurement time.
- **Codex Bot** (`sign_in_claim`): the `chatgpt_subscription_active_until`
  claim of the stored sign-in's ID token, with the claim's own
  `chatgpt_subscription_last_checked`. It is re-read from the local credential
  every cycle and never persisted, like the native identity.

Codex Worker logins store only OpenCode's access token, whose claims carry no
subscription dates, and ChatGPT's accounts-check endpoint refuses these
tokens, so they report `null`. Grok's billing and Grok Bot's CLI report only
weekly usage periods, and a Claude credential holds no end date; they also
report `null` rather than presenting a usage window as a subscription.

The field is account-level rather than part of `usage` so that a Bot and
Worker linked by native identity keep equal measurements and still share one
Usage card; the card shows the first subscription end in its row. Neither
source says whether the subscription renews, so the card reads "sub ends"
(or "sub ended") with the source and check time in its tooltip.

Every Usage card also shows how long ago its measurement was sampled: the
oldest measurement of a linked row, plus Grok Bot's own time when it shares
the Grok Worker card. The freshness dot alone hid a seven-hour-old value
behind a tooltip.

## Consequences

A signed-in Codex Bot's end date is only as current as the credential
owner's last token refresh; the check time makes that visible. Adding a
provider source means adding a `source` value, not new UI.
