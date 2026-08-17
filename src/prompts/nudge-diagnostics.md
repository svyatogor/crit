**{{subject}}**

1. Find them — call `getDiagnostics` and keep the diagnostics whose source is
   `Crit`. Each `code` field reads like `{{label}} {{code}}` — the leading label
   is a display name, the rest is the code that addresses the comment.
2. Read them — `mcp__crit__listDiffComments({ code })` once with any one of those
   codes: a diagnostic shows only the request text, while the listing gives every
   comment in the thread, including earlier replies, and whether it is already
   resolved. Read it before changing anything.
3. Handle each open comment — apply the change it asks for and nothing else, or,
   if the request is unclear, looks wrong, or you disagree, make no change and ask.
4. Reply — `mcp__crit__replyToDiffComment({ code, text })`, always: say what you
   changed, or ask your question or state your objection so the reviewer can answer.
5. Resolve — `mcp__crit__resolveDiffComment({ code })` only for comments you actually
   finished. Leave anything you questioned, skipped, or half-did open.

Always pass a comment's exact `code`, never the `R` label.
