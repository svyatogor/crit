/code-review{{args}} — leave every finding as an inline comment in my editor
instead of reporting it in chat: call
mcp__crit__addDiffComment({ code, file, line, text }) once per finding, passing
code "{{code}}" exactly, the file path, and the 1-based line the finding sits on.
Write each comment as the change you want made.