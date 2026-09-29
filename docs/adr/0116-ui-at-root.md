# 116. Serve the UI at the origin root

Status: accepted, 2026-09-28.

The UI's Fleet bench lives only at `/`; the other benches live at `/<space>`. Navigation, deep links, local browser bootstrap, server status URLs and the authenticated Access UI origin use these paths. The integrated reference is available at `/?reference=overview`. `/connect/local` remains the separate local bootstrap route and `/connect` remains the remote pairing route.

The prior `/x` route and its children are removed without redirects or aliases. The remote UI proxy forwards only the root, known spaces and required assets, and continues to authenticate them before contacting the loopback Next server. Earlier ADRs describe the routes in effect when they were accepted.
