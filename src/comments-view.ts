import { sortBy } from 'es-toolkit'
import * as path from 'path'
import * as vscode from 'vscode'
import { iconResource } from './file-icons'
import {
  commentText,
  getThreadsByFile,
  isResolved,
  type ReviewComment,
  threadLabel,
  threadPreview,
  type TrackedCommentThread,
} from './review-threads'

/**
 * The Comments section: every review thread, grouped by file.
 *
 * Threads already live in the gutter and in the Problems view, but neither
 * answers "what have I asked for, across the whole change" — the question a
 * reviewer has right before sending a batch to the agent. Ordering matches the
 * QuickPick panel so the two surfaces agree.
 *
 * Resolved threads stay listed rather than vanishing: they are the record of
 * what the agent has already answered. They are muted, and the section header
 * carries a toggle for hiding them outright.
 */

export type CommentNode = FileNode | ThreadNode

export interface FileNode {
  kind: 'file'
  relativePath: string
  uri: vscode.Uri
  threads: TrackedCommentThread[]
}

export interface ThreadNode {
  kind: 'thread'
  thread: TrackedCommentThread
}

export class CommentsViewProvider implements vscode.TreeDataProvider<CommentNode> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event

  private view: vscode.TreeView<CommentNode> | undefined
  private hideResolved = false
  private filter = ''

  attach(view: vscode.TreeView<CommentNode>): void {
    this.view = view
    this.updateSummary()
  }

  refresh(): void {
    this.emitter.fire()
    this.updateSummary()
  }

  dispose(): void {
    this.emitter.dispose()
  }

  isHidingResolved(): boolean {
    return this.hideResolved
  }

  setHideResolved(hide: boolean): void {
    this.hideResolved = hide
    void vscode.commands.executeCommand('setContext', 'crit.hidingResolved', hide)
    this.refresh()
  }

  currentFilter(): string {
    return this.filter
  }

  setFilter(filter: string): void {
    this.filter = filter.trim()
    void vscode.commands.executeCommand('setContext', 'crit.commentsFiltered', this.filter.length > 0)
    this.refresh()
  }

  getChildren(element?: CommentNode): CommentNode[] {
    if (element?.kind === 'thread') return []

    if (element?.kind === 'file') {
      return sortBy(this.visible(element.relativePath, element.threads), [(thread) => thread.range.start.line]).map(
        (thread) => ({ kind: 'thread', thread }),
      )
    }

    const nodes: FileNode[] = []
    for (const [relativePath, threads] of getThreadsByFile()) {
      const visible = this.visible(relativePath, threads)
      if (visible.length === 0) continue
      nodes.push({ kind: 'file', relativePath, uri: visible[0].uri, threads })
    }
    return nodes.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  getTreeItem(node: CommentNode): vscode.TreeItem {
    return node.kind === 'file' ? this.fileItem(node) : this.threadItem(node)
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const visible = this.visible(node.relativePath, node.threads)
    const open = visible.filter((thread) => !isResolved(thread)).length
    const item = new vscode.TreeItem(path.basename(node.relativePath), vscode.TreeItemCollapsibleState.Expanded)
    // A re-schemed URI: the icon theme's real icon for this file type, with no
    // git decoration colouring the name. `ThemeIcon.File` also stops VS Code
    // rendering this collapsible row with a folder icon. See `iconResource`.
    item.resourceUri = iconResource(node.uri)
    item.iconPath = vscode.ThemeIcon.File
    item.description = open === visible.length ? `${visible.length}` : `${open} open · ${visible.length}`
    item.tooltip = node.relativePath
    // The file-level batch commands address a file by its relative path.
    item.id = `crit.commentFile:${node.relativePath}`
    item.contextValue = 'critCommentFile'
    return item
  }

  private threadItem(node: ThreadNode): vscode.TreeItem {
    const { thread } = node
    const resolved = isResolved(thread)
    const item = new vscode.TreeItem(threadPreview(thread))
    item.id = `crit.thread:${thread.threadRef}`
    item.description = `${threadLabel(thread)} · L${thread.range.start.line + 1}`
    item.tooltip = threadTooltip(thread)
    item.contextValue = resolved ? 'critThread.resolved' : 'critThread.open'
    item.iconPath = resolved
      ? new vscode.ThemeIcon('check-all', new vscode.ThemeColor('descriptionForeground'))
      : new vscode.ThemeIcon(firstRole(thread) === 'agent' ? 'sparkle' : 'comment')
    item.command = {
      command: 'crit.goToThread',
      title: 'Go to Comment',
      arguments: [thread],
    }
    return item
  }

  /**
   * The threads a file should show, after the resolved toggle and the filter.
   *
   * A filter matching the *path* keeps every thread in that file, which is how
   * the old quick-pick behaved: typing a filename is a request for that file,
   * not for comments that happen to quote its name.
   */
  private visible(relativePath: string, threads: TrackedCommentThread[]): TrackedCommentThread[] {
    const shown = this.hideResolved ? threads.filter((thread) => !isResolved(thread)) : threads
    if (!this.filter) return shown

    const needle = this.filter.toLowerCase()
    if (relativePath.toLowerCase().includes(needle)) return shown
    return shown.filter((thread) =>
      thread.comments.some((comment) => commentText(comment).toLowerCase().includes(needle)),
    )
  }

  private updateSummary(): void {
    if (!this.view) return

    let open = 0
    let total = 0
    let matching = 0
    for (const [relativePath, threads] of getThreadsByFile()) {
      matching += this.visible(relativePath, threads).length
      for (const thread of threads) {
        total++
        if (!isResolved(thread)) open++
      }
    }

    if (total === 0) {
      this.view.description = undefined
      return
    }
    // While filtering, the count that matters is how much is on screen — the
    // header is the only place a filtered-away thread is still accounted for.
    this.view.description = this.filter
      ? `${matching} of ${total} matching "${this.filter}"`
      : `${open} open · ${total - open} resolved`
  }
}

function firstRole(thread: TrackedCommentThread): string {
  return (thread.comments[0] as ReviewComment | undefined)?.role ?? 'user'
}

function threadTooltip(thread: TrackedCommentThread): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  for (const comment of thread.comments) {
    const role = (comment as ReviewComment).role === 'agent' ? '🤖 Agent' : '👤 You'
    const body = typeof comment.body === 'string' ? comment.body : comment.body.value
    md.appendMarkdown(`**${role}**\n\n${body}\n\n`)
  }
  return md
}
