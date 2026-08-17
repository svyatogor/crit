# Crit

**Inline code review comments for VS Code — review AI-generated changes, submit feedback in batch, and let agents respond.**

Add review comments on any line in any file, then submit them all to Copilot, Claude Code, or any AI agent as a structured prompt. Comments include surrounding code context and git diff hunks so the AI knows exactly what changed and what you want fixed. Perfect for reviewing Copilot Edits, PR changes, or any code modifications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Quick Start

### 1. Add Review Comments
Open any file → hover on the line gutter → click the **`+`** icon → type your feedback (e.g., "rename this variable", "add error handling") → click **Add Comment**.

### 2. Review & Manage
Click the **status bar** (`💬 2 open · 1 resolved`) to open the **comment panel** — search, filter, batch-resolve, or navigate to any comment.

### 3. Submit to AI
- **Send to AI** — click the 📤 button on any thread or use the comment panel to send all open comments to your configured provider
- **Copy to Clipboard** — click 📋 to copy the structured prompt, then paste into Claude Code, Codex, or any AI chat
- **MCP Server** — Claude Code connects directly via MCP for real-time comment interaction

The default provider is **GitHub Copilot**. To use **Claude Code**, set **Crit: AI Provider** (`crit.aiProvider`) to `Claude Code` in VS Code settings. Send actions read this setting when invoked, so switching providers does not require a reload. Claude Code prompts include each comment's diagnostic code, preserving its VS Code window, project, and thread references for subsequent Crit MCP calls. Copilot prompts remain unchanged. If the selected provider cannot be opened, Crit copies the prompt to the clipboard instead.

---

## Features

![Inline Comments](examples/screenshot-inline.png)

### Inline Commenting on Any File
- **"+" gutter buttons** on every line — add comments on any file type (not just markdown)
- **Threaded replies** with **👤 User** and **🤖 Agent** role badges
- **Edit** comments inline, **resolve/reopen** threads, **delete** individual replies
- **Send to AI** button directly on each thread's title bar
- **Copy to Clipboard** button for pasting into any AI chat

### Git Diff Context in Prompts
When you submit comments, the prompt includes the **git diff hunk** for each commented line — showing what was added, removed, and changed. The AI sees both the current code and the change history:

```
### Line 15
```
→ 15 | const userData = await fetchUser(id);
```
**Git diff:**
```diff
@@ -13,5 +13,5 @@
-const data = fetch('/api/user/' + id);
+const userData = await fetchUser(id);
```
**Comment:** Good rename, but add error handling for the await
```

### Comment Panel (Status Bar)

![Comment Panel](examples/screenshot-panel.png)

Click the status bar to open an interactive panel with:
- **Search/filter** — type to find comments by text or filename
- **Global batch actions** — Send All to AI, Copy All, Resolve All, Delete Resolved, Clear All
- **Per-file batch actions** — Send to AI, Copy, Resolve, Delete Resolved scoped to a single file
- **Per-comment actions** — Go to, Send to AI, Copy, Resolve, Delete

### Comment Persistence
- Comments **survive window reloads** via VS Code workspace state
- **Branch-scoped** — comments are stored per repository + branch
- Switch branches → comments swap automatically
- New branches **inherit** comments from the parent branch, then diverge independently

### Line Tracking
- Comments **follow the code** when lines are added or removed above them
- CRLF-aware — works correctly on Windows with `\r\n` line endings

### Review Comments as Diagnostics
Every open review thread is also published as a VS Code **Information** diagnostic with the source `Crit`. This makes review feedback available to AI extensions that already read diagnostics from the current VS Code window and naturally keeps the feedback attached to the correct file and range.

- Only open threads are published; resolving a thread removes its diagnostic and reopening restores it
- Diagnostic messages contain the user-authored review requests, while agent replies remain in the full thread
- Multiple threads on the same range remain separate diagnostics
- Line tracking, edits, replies, deletion, reloads, and branch switches update the diagnostic collection

`Diagnostic.code` carries a short review label followed by the routing code, and is intentionally not added to the visible message:

```text
R3 crit:v1;<session>;<project>;<thread>
```

The leading `R3` is a display label — the same id used in generated prompts and in `listDiffComments` output, so a comment can be referred to by name in conversation. It is **never an address**: all tools route on the thread ref inside the code, because review labels are per-branch sequence numbers and are reused across branches.

| Field | Lifetime and purpose |
|---|---|
| `session` | Random identifier for the current extension-host/window activation; changes after reload or restart |
| `project` | Stable hash of the containing workspace-folder identity; distinct per root in multi-root workspaces and does not expose its path |
| `thread` | Stable random identifier persisted with the review thread across reloads and branch inheritance |

Each ref is 8 hex characters. They are routing metadata, **not authentication credentials**, so they carry only enough entropy to stay unique across the windows, projects, and threads on one machine — keeping `Diagnostic.code` short enough to read in the Problems view.

`Diagnostic.code` is a plain string by design. The object form (`{value, target}`) renders more compactly in the Problems view, but AI integrations that read diagnostics stringify this field and would receive `[object Object]`. AI integrations must preserve the code; the MCP server uses its fields to select the owning VS Code window, project, and thread. Tools also accept a code pasted with its `R3 ` prefix intact.

### 4 Copilot Language Model Tools
Enable in **Agent Mode → Tools** to let Copilot interact with your review comments:

![Agent Reply](examples/screenshot-agent.png)

| Tool | Description |
|---|---|
| `#listDiffComments` | List all comments with IDs, file locations, status, and thread text |
| `#replyToDiffComment` | Reply to a comment as the agent role |
| `#resolveDiffComment` | Mark a comment as resolved/done |
| `#deleteDiffComment` | Delete a comment thread |

**Example workflow:**
```
User: "Address all my review comments"
Agent: [calls #listDiffComments] → sees 3 open comments
       [makes code changes based on feedback]
       [calls #replyToDiffComment] → explains what was changed
       [calls #resolveDiffComment] → marks each as done
```

### MCP Server (Claude Code, Cursor, Windsurf, etc.)
The extension includes a standalone MCP server that any MCP-compatible AI client can connect to for real-time access to review comments. Available tools: `listDiffComments`, `replyToDiffComment`, `resolveDiffComment`, `deleteDiffComment`.

Each MCP tool requires the full `code` from a Crit diagnostic. The code identifies the VS Code window, workspace project, and review thread:

```text
crit:v1;<session>;<project>;<thread>
```

- `listDiffComments({ code })` routes to the encoded window and lists comments from the encoded project
- `replyToDiffComment({ code, text })` replies to the encoded thread
- `resolveDiffComment({ code })` resolves the encoded thread
- `deleteDiffComment({ code })` deletes the encoded thread

Always pass a current diagnostic code unchanged. A code from a closed or reloaded window is intentionally rejected as stale.

**Claude Code:**
```bash
# Windows:
claude mcp add -s user crit node "%USERPROFILE%\.vscode\extensions\jinqishen.crit-<version>\out\mcp-server.js"

# macOS/Linux:
claude mcp add -s user crit node ~/.vscode/extensions/jinqishen.crit-<version>/out/mcp-server.js
```

> Use `-s user` so the server is available in every directory. Without it, `claude mcp add` defaults to **local** scope and registers the server only for the directory you ran it in — it will appear to vanish when you start Claude Code anywhere else.

**Cursor:**
Add to your Cursor MCP settings (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "crit": {
      "command": "node",
      "args": ["<extension-path>/out/mcp-server.js"]
    }
  }
}
```

**Other MCP clients:**
Any client that supports the stdio transport can connect. The server binary is at:
```
<extension-install-path>/out/mcp-server.js
```
Run with: `node mcp-server.js` (stdio transport, no arguments needed).

> **Note:** The matching VS Code window must be running and activated for the MCP server to connect. The MCP server communicates with that window's local IPC server, so comments are always live.

### Clipboard Support
Every action that sends to AI also has a **Copy to Clipboard** variant — paste the structured prompt into Claude Code, Codex CLI, ChatGPT, or any AI:
- **Per-thread**: 📋 button on the thread title bar
- **Per-file**: Copy action in the comment panel
- **Global**: "Crit: Copy All to Clipboard" in the command palette

---

## Commands

| Command | Description |
|---|---|
| `Crit: Show Comments Panel` | Open the interactive comment panel |
| `Crit: Send All to AI` | Send all open comments to the configured AI provider |
| `Crit: Copy All to Clipboard` | Copy all open comments as a structured prompt |
| `Crit: Resolve All` | Resolve all open comments |
| `Crit: Delete All Resolved` | Delete all resolved comments |
| `Crit: Clear All Comments` | Delete all comments |

---

## Architecture

```
src/
  diagnostic-metadata.ts — Diagnostic identity and metadata codec
  extension.ts           — Comment controller, diagnostics, persistence, IPC server, Copilot tools
  mcp-server.ts          — Standalone MCP server for Claude Code (connects to IPC)
```

**IPC Server**: Every VS Code window starts a local HTTP server on `127.0.0.1` using a random port. It atomically publishes `${TMPDIR}/crit/instances/<sessionRef>.json`. The MCP server parses the diagnostic code, reads the descriptor named by its `sessionRef`, scopes listing by `projectRef`, and addresses mutations by `threadRef`. Closing a window removes only its own descriptor. All comment reads/writes still go through the owning extension instance as the single source of truth.

**Branch Scoping**: Comments are stored under `crit.state.{repoName}.{branchName}` in VS Code's workspace state. Branch switches are detected via the git extension API.

---

## Development

```bash
# Install dependencies
npm install

# Compile and run metadata and MCP routing tests
npm test

# Build extension + MCP server
npm run build

# Build extension only
npm run build:ext

# Build MCP server only
npm run build:mcp

# Package vsix
npx @vscode/vsce package --no-dependencies --allow-missing-repository

# Deploy to installed extension (dev shortcut)
Copy-Item "out\extension.js" "$HOME\.vscode\extensions\jinqishen.crit-0.1.0\out\extension.js" -Force
```

---

## Version History

| Version | Highlights |
|---|---|
| **0.1.3** | Git diff context in prompts — AI sees what changed, not just current code |
| **0.1.2** | Branch-scoped comment persistence — comments follow repo + branch, inherit on new branches |
| **0.1.1** | Clipboard support, bug fixes (activation crash, comment rendering, CRLF line tracking) |
| **0.1.0** | Initial release — inline comments, threaded replies, batch submit, comment panel, Copilot tools, MCP server, IPC, persistence, line tracking |

---

## License

[MIT](LICENSE)
