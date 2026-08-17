**{{subject}}**

1. Read them — `mcp__crit__listDiffComments({ code })` with this code:
   `{{code}}`
   The listing gives each thread its own code, every comment in it (including
   earlier replies), and whether it is already resolved. Read it before changing
   anything.
2. Handle each open comment — apply the change it asks for and nothing else, or,
   if the request is unclear, looks wrong, or you disagree, make no change and ask.
3. Reply — `mcp__crit__replyToDiffComment({ code, text })`, always: say what you
   changed, or ask your question or state your objection so the reviewer can answer.
4. Resolve — `mcp__crit__resolveDiffComment({ code })` only for comments you actually
   finished. Leave anything you questioned, skipped, or half-did open.

Always pass a comment's exact `code` from the listing, never the `R` label.
