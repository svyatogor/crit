# Crit

**Inline code review comments for VS Code — review AI-generated changes, submit feedback in batch, and let agents respond.**

Add review comments on any line in any file, then submit them all to Copilot, Claude Code, or any AI agent as a structured prompt. Comments include surrounding code context and git diff hunks so the AI knows exactly what changed and what you want fixed. Perfect for reviewing Copilot Edits, PR changes, or any code modifications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Quick Start

### 1. Add Review Comments

Open any file → hover on the line gutter → click the **`+`** icon → type your feedback (e.g., "rename this variable", "add error handling") → click **Add Comment**.

### 2. Work Through the Change

Open the **Crit** sidebar — the status bar (`💬 2 open · 1 resolved`) reveals it. **Changes** lists every file that differs from HEAD — tick each one off as you read it, and see at a glance when an agent has touched one you had already finished. **Comments** lists every thread you have left, grouped by file.

### 3. Submit to AI

- **Send to AI** — click the 📤 button on any thread, or **Send All to AI** in the Comments section's title bar
- **Copy to Clipboard** — click 📋 to copy the structured prompt, then paste into Claude Code, Codex, or any AI chat
- **MCP Server** — Claude Code connects directly via MCP for real-time comment interaction

### 4. Or Have the AI Review You

Run **`Crit: Ask AI to Review Changes`** (or **`…Review This File`**) and the AI reviews your code and leaves its findings as inline comments you can reply to, resolve, or send straight back to be fixed. Needs the Claude Code provider — see [Ask the AI to Review Your Code](#ask-the-ai-to-review-your-code).

The default provider is **GitHub Copilot**. To use **Claude Code**, set **Crit: AI Provider** (`crit.aiProvider`) to `Claude Code` in VS Code settings. Send actions read this setting when invoked, so switching providers does not require a reload. Claude Code prompts include each comment's diagnostic code, preserving its VS Code window, project, and thread references for subsequent Crit MCP calls. Copilot prompts remain unchanged. If the selected provider cannot be opened, Crit copies the prompt to the clipboard instead.

---

## Features

### The Crit Sidebar

A **Crit** icon in the activity bar holds the two things a review needs at once.

**Changes** lists every file that differs from HEAD — the same working-tree changes the Source Control view shows, including files an agent just created. Each row has a checkbox: tick it when you have read the file. The header keeps the count (`4/9 reviewed`) and switches between a **flat list** and a **folder tree**, collapsing single-child folder chains the way the Source Control view does. Tick a folder to tick everything beneath it.

A row also carries `💬 2` when the file has open review comments, so the two sections line up: the file you still owe an answer on is marked in the list you are working down. Folder rows total their descendants' counts. Resolved threads stop marking a file, since the point of the marker is what is left to deal with.

**Comments** lists every review thread grouped by file, with the line and the `R3` label each thread is known by elsewhere. Send, resolve, or delete a thread inline; resolved threads stay listed but muted, and the header has a toggle to hide them.

### Reviewed Marks That Go Stale, Not Missing

A mark records the **content** the file had when you ticked it, not the time you ticked it. So when an agent edits a file you had already read, the mark does not silently vanish — it becomes **stale**: the tick stays, the row's icon becomes a dot in the theme's modified colour (the same thing an editor's dirty dot says — nothing is wrong, the file just moved on), and the description reads `changed since you reviewed`. You _did_ read that file, and clearing the tick would deny it.

That retained mark is the point: **Show Changes Since I Reviewed** opens a diff of the file as you last saw it against the file now, so a one-line fix in a 900-line file costs you one line of re-reading rather than the whole file.

Clicking a stale row's checkbox **re-reviews** it — one click, back to fresh at the new content. VS Code offers to clear the tick, since the box is ticked, but on a row saying `changed since you reviewed` a click means "I have looked again", not "forget that I read this"; taking it literally cost two clicks and discarded the snapshot in between. Clearing a mark on purpose is the context menu's **Mark as Not Reviewed**, where it can be named. The same rule applies to a folder row holding anything stale.

Because freshness is content-derived, it behaves the way you would expect without any bookkeeping: a formatter run or a `touch` that leaves the bytes alone does _not_ invalidate a mark, and an agent writing to a file nobody has open _does_.

Marks are scoped per **repository and branch**, like comments — park a review, take a hotfix branch, come back to your progress intact. A new branch inherits the marks you had, and anything that does not belong on it shows up as stale rather than as a false checkmark. Committing a file retires its mark, since it is no longer under review.

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

````
**Git diff:**
```diff
@@ -13,5 +13,5 @@
-const data = fetch('/api/user/' + id);
+const userData = await fetchUser(id);
````

**Comment:** Good rename, but add error handling for the await

````

### Batch Actions and Filtering

Everything the old status-bar quick-pick did now lives in the sidebar, where the thread it acts on is visible:
- **Section title bar** — Send All to AI, Resolve All, Delete Resolved, Clear All, the filter, and the show/hide-resolved toggle
- **Per-file row** — Send to AI, Copy, Resolve, Delete Resolved, scoped to that file
- **Per-thread row** — Go to, Send to AI, Copy, Resolve/Reopen, Delete

The status bar itself now just reveals the Comments section.

**Filter** narrows the section as you type, by comment text or by file name — a file name matches the whole file, since asking for `parser.ts` is asking for that file rather than for comments quoting it. The header switches to `2 of 7 matching "error"` while a filter is active, so nothing is hidden without being counted, and the title bar's button becomes a clear-filter button.

### The Built-in Comments View

Because Crit registers a comment controller, its threads also appear in VS Code's own Comments view — that view collects threads from every extension, and there is no way to opt out of feeding it.

VS Code reveals that view whenever a thread gains a comment, which takes the sidebar away from Crit's. The `comments.openView` setting governs this, and at its default `firstFile` the reveal is gated only on whether that view currently has a rendered tree — a far weaker gate than "once", since it comes back after the view is hidden or the window reloads. So the first time you write a comment, Crit offers to set `comments.openView` to `never`, with a **Don't Show Again**. Nothing is written to your settings unless you accept; because that setting is global rather than per-extension, accepting also stops other comment providers revealing that view.

Crit cannot fix this from the inside. Nothing on `CommentController` or `CommentThread` suppresses the reveal, and the one contribution point that reaches that view's rows — `commentsView/commentThread/context` — is proposed API, unusable in a published extension. Its container is created at runtime rather than declared in a manifest, and `contributes.views` resolves only a fixed set of built-in container ids, so Crit's own views cannot be placed beside it either. Hence the separate sidebar.

### Comment Persistence
- Comments **survive window reloads** via VS Code workspace state
- **Branch-scoped** — comments are stored per repository + branch
- Switch branches → comments swap automatically
- New branches **inherit** comments from the parent branch, then diverge independently

### Line Tracking
- Comments **follow the code** when lines are added or removed above them
- CRLF-aware — works correctly on Windows with `\r\n` line endings

### Ask the AI to Review Your Code
The reverse of every other Crit flow: instead of you commenting and the AI answering, the AI reviews and comments, and you read its findings inline where they belong.

- **`Crit: Ask AI to Review Changes`** — the uncommitted changes in the workspace
- **`Crit: Ask AI to Review This File`** — the file in the active editor
- Both also appear in the Changes section's title bar, which is there even with nothing changed yet
- In a git workspace, a **sparkle** button sits in the Source Control view's title bar for the whole diff, and on hover over any changed file for that one file

The agent runs its own `code-review` skill and posts each finding through `addDiffComment`, so the findings arrive as ordinary Crit threads: they show up in the gutter and the Problems view, you can reply to them, resolve them, or send them straight back with **Send to AI** to have the finding fixed. Nothing is edited on your behalf — a review request explicitly asks for comments, not changes.

Requesting a review needs the **Claude Code** provider (`crit.aiProvider`). Copilot's review runs inside its own UI and would need a separate integration to land findings as Crit comments, so a Copilot user is told that rather than handed a prompt that goes nowhere. The request is delivered the same three ways a comment batch is — running terminal, then cross-session message, then a new conversation — and all three send the literal `/code-review` slash command, which expands on every one of them. All three receive the same text: the CLI reads a multi-line `Terminal.sendText` as a paste, so the request keeps its line breaks on every path.

### Review Comments as Diagnostics
Every open review thread is also published as a VS Code **Information** diagnostic with the source `Crit`. This makes review feedback available to AI extensions that already read diagnostics from the current VS Code window and naturally keeps the feedback attached to the correct file and range.

- Only open threads are published; resolving a thread removes its diagnostic and reopening restores it
- Diagnostic messages contain the user-authored review requests, while agent replies remain in the full thread
- Multiple threads on the same range remain separate diagnostics
- Line tracking, edits, replies, deletion, reloads, and branch switches update the diagnostic collection

`Diagnostic.code` carries a short review label followed by the routing code, and is intentionally not added to the visible message:

```text
R3 crit:v1;<session>;<project>;<thread>
````

The leading `R3` is a display label — the same id used in generated prompts and in `listDiffComments` output, so a comment can be referred to by name in conversation. It is **never an address**: all tools route on the thread ref inside the code, because review labels are per-branch sequence numbers and are reused across branches.

| Field     | Lifetime and purpose                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session` | Random identifier for the current extension-host/window activation; changes after reload or restart                                                                    |
| `project` | Stable hash of the containing workspace-folder identity; distinct per root in multi-root workspaces and does not expose its path                                       |
| `thread`  | Stable random identifier persisted with the review thread across reloads and branch inheritance — omitted by a project code, which addresses a window and project only |

Each ref is 8 hex characters. They are routing metadata, **not authentication credentials**, so they carry only enough entropy to stay unique across the windows, projects, and threads on one machine — keeping `Diagnostic.code` short enough to read in the Problems view.

`Diagnostic.code` is a plain string by design. The object form (`{value, target}`) renders more compactly in the Problems view, but AI integrations that read diagnostics stringify this field and would receive `[object Object]`. AI integrations must preserve the code; the MCP server uses its fields to select the owning VS Code window, project, and thread. Tools also accept a code pasted with its `R3 ` prefix intact.

### 4 Copilot Language Model Tools

Enable in **Agent Mode → Tools** to let Copilot interact with your review comments:

![Agent Reply](examples/screenshot-agent.png)

| Tool                  | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `#listDiffComments`   | List all comments with IDs, file locations, status, and thread text |
| `#replyToDiffComment` | Reply to a comment as the agent role                                |
| `#resolveDiffComment` | Mark a comment as resolved/done                                     |
| `#deleteDiffComment`  | Delete a comment thread                                             |

**Example workflow:**

```
User: "Address all my review comments"
Agent: [calls #listDiffComments] → sees 3 open comments
       [makes code changes based on feedback]
       [calls #replyToDiffComment] → explains what was changed
       [calls #resolveDiffComment] → marks each as done
```

### MCP Server (Claude Code, Cursor, Windsurf, etc.)

The extension includes a standalone MCP server that any MCP-compatible AI client can connect to for real-time access to review comments. Available tools: `listDiffComments`, `addDiffComment`, `replyToDiffComment`, `resolveDiffComment`, `deleteDiffComment`.

Every MCP tool takes a `code`. A **thread code** comes from a Crit diagnostic and identifies the VS Code window, the workspace project, and one review thread:

```text
crit:v1;<session>;<project>;<thread>
```

A **project code** drops the thread segment and identifies just the window and project:

```text
crit:v1;<session>;<project>
```

That shorter form exists because [a review request](#ask-the-ai-to-review-your-code) has to be addressable before any comment exists — the agent is being asked to _create_ the threads, so there is no thread to name yet.

- `listDiffComments({ code })` routes to the encoded window and lists comments from the encoded project — either code shape
- `addDiffComment({ code, file, line, endLine?, text })` creates a new comment thread in the encoded project — either code shape; answers with the new thread's own code
- `replyToDiffComment({ code, text })` replies to the encoded thread
- `resolveDiffComment({ code })` resolves the encoded thread
- `deleteDiffComment({ code })` deletes the encoded thread

The last three act on exactly one thread, so they require a thread code and refuse a project code with a message pointing at `listDiffComments`.

`addDiffComment` counts lines **from 1**, as every listing and diagnostic reports them. `file` is resolved relative to the workspace folders of the addressed project; a line past the end of the file is clamped to the last line rather than refused, since an agent may be reading a diff of a file the user has since edited. Paths that resolve outside those folders are rejected — the IPC server listens on loopback, so `projectRef` bounds where a comment can land and is not merely a lookup key.

Always pass a current diagnostic code unchanged. A code from a closed or reloaded window is intentionally rejected as stale.

**Claude Code:**
Run **Crit: Install MCP Server for Claude Code** from the Command Palette. It registers the server as `crit` at **user** scope, so it is available in every directory, and re-running it repairs a stale entry.

The path it registers is _not_ inside the extension directory — that directory carries the version (`svyatogor.crit-<version>`) and would move on every update. The extension instead stages the bundle to a fixed path on activation and registers that:

```text
~/.crit/mcp/mcp-server.js
```

An extension update replaces the staged copy in place, so **updating Crit never requires re-installing the MCP server**.

To register it by hand instead:

```bash
claude mcp add -s user crit -- node ~/.crit/mcp/mcp-server.js
```

> Use `-s user`. Without it, `claude mcp add` defaults to **local** scope and registers the server only for the directory you ran it in — it will appear to vanish when you start Claude Code anywhere else.

If the provider is **Claude Code** and no `crit` server is registered, the first send in a window offers to install it — with **Don't Show Again** if you would rather wire it up yourself. The check is `claude mcp get crit`, run once per window in the workspace folder, so the CLI decides what counts as registered: config location, scopes, and directory all follow its own rules. Matching is by name, so repointing the `crit` entry at a different build is a supported thing to do — Crit sees it as installed and leaves it alone.

`claude` is looked up on the extension host's `PATH`. VS Code has already resolved that PATH by running your login _and_ interactive shell, so **mise**, **asdf**, **nix**, and **volta** setups are picked up, including rc-file activation like `mise activate zsh`. If yours is somewhere that lookup can't reach, set `crit.claudePath`.

The registered interpreter is the bare word `node`, resolved by whatever environment Claude Code itself runs in; no absolute toolchain path is recorded, so the server is never pinned to a runtime version that a later `mise prune` or nix GC can delete.

**Cursor:**
Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "crit": {
      "command": "node",
      "args": ["<home>/.crit/mcp/mcp-server.js"]
    }
  }
}
```

**Other MCP clients:**
Any client that supports the stdio transport can connect. Point it at the staged copy, which keeps its path across extension updates:

```
<home>/.crit/mcp/mcp-server.js
```

Run with: `node mcp-server.js` (stdio transport, no arguments needed).

> **Note:** The matching VS Code window must be running and activated for the MCP server to connect. The MCP server communicates with that window's local IPC server, so comments are always live.

### Clipboard Support

Every action that sends to AI also has a **Copy to Clipboard** variant — paste the structured prompt into Claude Code, Codex CLI, ChatGPT, or any AI:

- **Per-thread**: 📋 button on the thread title bar
- **Per-file**: Copy action on a file row in the Comments section
- **Global**: 📋 button in the Comments section header, or "Crit: Copy All to Clipboard" in the command palette

---

## Commands

| Command                            | Description                                                          |
| ---------------------------------- | -------------------------------------------------------------------- |
| `Crit: Ask AI to Review Changes`   | Have the AI review the uncommitted changes and leave inline comments |
| `Crit: Ask AI to Review This File` | Have the AI review the active file and leave inline comments         |
| `Crit: Send All to AI`             | Send all open comments to the configured AI provider                 |
| `Crit: Copy All to Clipboard`      | Copy all open comments as a structured prompt                        |
| `Crit: Resolve All`                | Resolve all open comments                                            |
| `Crit: Delete All Resolved`        | Delete all resolved comments                                         |
| `Crit: Clear All Comments`         | Delete all comments                                                  |
| `Crit: Mark All Files Reviewed`    | Tick every file in the Changes section                               |
| `Crit: Clear All Reviewed Marks`   | Untick every file in the Changes section                             |
| `Crit: Filter Comments`            | Narrow the Comments section by comment text or file name             |
| `Crit: Clear Comment Filter`       | Drop the active comment filter                                       |

---

## Architecture

```
src/
  diagnostic-metadata.ts — Diagnostic identity and metadata codec
  extension.ts           — Comment controller, diagnostics, persistence, IPC server, Copilot tools
  review-threads.ts      — The review model: threads, the refs addressing them, serialization
  comment-targets.ts     — Resolving the file and line an agent names, bounded to the project
  review-request.ts      — Asking the AI to review, and where its findings go
  reviewed-files.ts      — Which files are read and whether that still holds (no vscode: plain Node)
  review-progress.ts     — The same model wired to this window: buckets, branches, content reads
  changes-view.ts        — The Changes section: git's changed files, plus each one's mark
  comments-view.ts       — The Comments section: threads grouped by file
  comments-view-reveal.ts — Offers to stop VS Code's own Comments view stealing the sidebar
  snapshot-content.ts    — Serves the reviewed-at copy of a file, read-only, for the delta diff
  file-icons.ts          — File-type icons in the trees without picking up file decorations
  git.ts                 — Repository identity, changed files, diff hunks
  claude-delivery.ts     — Terminal, then cross-session message, then new conversation
  prompts.ts             — Everything the extension says to an agent (templates in prompts/)
  mcp-server.ts          — Standalone MCP server for Claude Code (connects to IPC)
  mcp-install.ts         — Stages the MCP bundle at a version-stable path, registers it with Claude Code
```

**IPC Server**: Every VS Code window starts a local HTTP server on `127.0.0.1` using a random port. It atomically publishes `${TMPDIR}/crit/instances/<sessionRef>.json`. The MCP server parses the code, reads the descriptor named by its `sessionRef`, scopes listing and comment creation by `projectRef`, and addresses mutations by `threadRef`. Closing a window removes only its own descriptor. All comment reads/writes still go through the owning extension instance as the single source of truth.

**Branch Scoping**: Comments are stored under `crit.state.{repoName}.{branchName}` in VS Code's workspace state. Branch switches are detected via the git extension API.

**Reviewed Marks**: Stored under `crit.reviewed.{repoName}-{hash8}.{branchName}`, keyed by absolute path, each entry holding the content's sha256 and the time of the mark. The hash suffix on the repository name disambiguates two checkouts that share a folder name in one multi-root workspace, which a bare name would silently merge. Each repository's HEAD is followed separately, so a branch switch in one leaves the others' marks alone.

The content a mark was taken at is copied to `${storageUri}/snapshots/<sha256>/<filename>` — content-addressed, so the same content marked on two branches costs one blob. It is served back through the read-only `crit-snapshot:` scheme. Collection spans every bucket rather than the active one, since a blob one branch has moved past may be the baseline another branch still needs.

**Tree Row Icons**: rows carry a `resourceUri` re-schemed to `crit-icon:`, keeping the path. `TreeItem.resourceUri` is the only thing that resolves the icon theme's real per-extension icon (with `iconPath` set to `ThemeIcon.File`), but it also opts the row into every registered `FileDecorationProvider` — so a plain `file:` URI had git tinting filenames by working-tree status, which in the Comments section is unrelated to anything the row shows. The icon theme resolves from the path and ignores the scheme; git's decoration provider keys on the whole URI string and its ignore provider skips non-`file` schemes. Re-scheming keeps the icon and drops the colour. In Changes, the status letter leads the description instead, which is more precise than a colour anyway.

Reviewed marks are deliberately _not_ part of `serializeState()`: that structure doubles as the MCP wire format, so folding them in would publish your review progress to every `listDiffComments` call.

---

## Development

```bash
# Install dependencies
npm install

# Typecheck, then run the tests
npm test

# Typecheck only (tsc never emits — esbuild owns every artifact)
npm run typecheck

# Build extension + MCP server
npm run build

# Build extension only
npm run build:ext

# Build MCP server only
npm run build:mcp

# `out/` holds the two shipped bundles and nothing else — esbuild is the only
# thing that writes there. Tests require `src/*.ts` directly, relying on Node's
# native type stripping, so there is no second build to keep in sync.

# Package vsix
npx @vscode/vsce package --no-dependencies --allow-missing-repository

# Deploy to installed extension (dev shortcut)
Copy-Item "out\extension.js" "$HOME\.vscode\extensions\svyatogor.crit-0.1.0\out\extension.js" -Force
```

---

## Version History

| Version   | Highlights                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.4.1** | Request a review from the Source Control view — the whole diff from its title bar, or one changed file inline                                                 |
| **0.4.0** | AI-authored reviews — `Crit: Ask AI to Review Changes`, the `addDiffComment` MCP tool, and the project code that addresses a window before any comment exists |
| **0.1.3** | Git diff context in prompts — AI sees what changed, not just current code                                                                                     |
| **0.1.2** | Branch-scoped comment persistence — comments follow repo + branch, inherit on new branches                                                                    |
| **0.1.1** | Clipboard support, bug fixes (activation crash, comment rendering, CRLF line tracking)                                                                        |
| **0.1.0** | Initial release — inline comments, threaded replies, batch submit, comment panel, Copilot tools, MCP server, IPC, persistence, line tracking                  |

---

## License

[MIT](LICENSE)
