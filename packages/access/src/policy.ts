export const scopes = ["brain:share", "brain:status", "content:read", "ui:view", "ui:control", "access:enroll"] as const;
export type Scope = typeof scopes[number];
export const clientKinds = ["chrome", "android", "browser", "desktop"] as const;
export type ClientKind = typeof clientKinds[number];
