---
Apply every change above. Keep all other code unchanged. Where a request is
unclear, looks wrong, or you disagree, make no change and ask instead.

Then respond via the `crit` MCP server:
- `mcp__crit__replyToDiffComment({ code, text })` — always, for every comment: what you changed, or your question or objection
- `mcp__crit__resolveDiffComment({ code })` — only for comments you actually finished; leave anything you questioned, skipped, or half-did open

Pass the exact **Diagnostic code** shown with each comment above as `code`. Do
not pass the R-label — it is only a display name. If a tool reports a stale or
unknown code, call `mcp__crit__listDiffComments({ code })` with any current code
to re-read the live threads.
