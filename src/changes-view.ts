import { mapAsync } from 'es-toolkit'
import * as path from 'path'
import * as vscode from 'vscode'
import { iconResource } from './file-icons'
import { type ChangedFile, getChangedFiles, isUntracked } from './git'
import { openThreadCountsByPath } from './review-threads'
import { type ReviewedFiles, type ReviewState } from './reviewed-files'

/**
 * The Changes section: every file that differs from HEAD, and how far the
 * reviewer has got through it.
 *
 * The list is git's, not ours — the same working-tree changes the Source Control
 * view shows, including files an agent created. What Crit adds is the per-file
 * mark, which is why this section exists at all.
 */

export type ChangesNode = FileChangeNode | FolderChangeNode

export interface FileChangeNode {
  readonly kind: 'file'
  readonly file: ChangedFile
  readonly state: ReviewState
  readonly reviewedAt?: string
  /** Open review threads in this file — 0 when there is nothing to deal with. */
  readonly comments: number
  readonly resourceUri: vscode.Uri
}

export interface FolderChangeNode {
  readonly kind: 'folder'
  /** One segment, or several joined when a single-child chain was collapsed. */
  readonly label: string
  readonly resourceUri: vscode.Uri
  readonly children: ChangesNode[]
  /** Every file beneath, so the folder's checkbox can act on all of them. */
  readonly files: FileChangeNode[]
}

/** Persisted so the choice of layout survives a reload. */
const LAYOUT_KEY = 'crit.changesLayout'

/**
 * How many files may be in flight at once.
 *
 * Most rows resolve without touching the disk, but a diff where everything has
 * been marked reviewed is all reads, and running a few hundred of those at once
 * would hold every buffer at the same peak and saturate the thread pool the
 * rest of the extension host shares.
 */
const READ_CONCURRENCY = 12

/**
 * Whether a run of single-child folders collapses into one row.
 *
 * Deferred to `scm.compactFolders` rather than given a Crit setting of its own:
 * this tree is the Source Control view's changed-file list with review state on
 * it, and someone who turned compaction off there did so because they dislike
 * `a/b/c` rows, not because they dislike them in one particular view.
 */
export function compactFolders(): boolean {
  return vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true)
}

export class ChangesViewProvider implements vscode.TreeDataProvider<ChangesNode> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event

  private view: vscode.TreeView<ChangesNode> | undefined
  /** Every file row, flat, whatever the layout — what the batch commands act on. */
  private rows: FileChangeNode[] = []
  /** A node's folder in tree layout, so `reveal()` can expand its way down to it. */
  private parents = new Map<ChangesNode, ChangesNode>()

  // Declared and assigned rather than taken as constructor parameter
  // properties: the tests load this file through Node's type stripping, which
  // erases annotations but will not synthesize the assignments those imply.
  private readonly reviewed: ReviewedFiles
  private readonly memento: Pick<vscode.Memento, 'get' | 'update'>

  constructor(reviewed: ReviewedFiles, memento: Pick<vscode.Memento, 'get' | 'update'>) {
    this.reviewed = reviewed
    this.memento = memento
  }

  /** Lets the section header carry the progress count. */
  attach(view: vscode.TreeView<ChangesNode>): void {
    this.view = view
    void this.publishLayout()
  }

  refresh(): void {
    this.emitter.fire()
  }

  dispose(): void {
    this.emitter.dispose()
  }

  currentRows(): readonly FileChangeNode[] {
    return this.rows
  }

  // --------------- Layout ---------------

  isTreeLayout(): boolean {
    return this.memento.get<boolean>(LAYOUT_KEY, false)
  }

  setTreeLayout(asTree: boolean): void {
    void this.memento.update(LAYOUT_KEY, asTree)
    void this.publishLayout()
    this.refresh()
  }

  /** Drives which of the two layout buttons the title bar shows. */
  private publishLayout(): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', 'crit.changesAsTree', this.isTreeLayout())
  }

  // --------------- Tree data ---------------

  /**
   * Keep a mark with its file when the file moves.
   *
   * Renames reach us in two shapes. A staged one names both paths, so the mark
   * simply follows and its own hash decides whether the move also edited the
   * file. Anything else arrives as a new file with no stated origin — including
   * the rename of a file git never tracked, where the old path is not mentioned
   * at all — and only identical content can link it back to a mark.
   */
  private async followRenames(files: readonly ChangedFile[]): Promise<void> {
    for (const file of files) {
      if (file.renamedFrom) this.reviewed.moveMark(file.renamedFrom, file.uri)
    }
    await this.reviewed.reanchorRenames(files.filter(isUntracked).map((file) => file.uri))
  }

  async getChildren(element?: ChangesNode): Promise<ChangesNode[]> {
    if (element) return element.kind === 'folder' ? element.children : []

    const files = getChangedFiles()
    // Before the rows are built, so a mark that followed its file shows up on
    // the row that replaced it in this same refresh rather than the next one.
    await this.followRenames(files)
    const comments = openThreadCountsByPath()
    // `currentState` decides for itself whether this file has to be touched at
    // all: an unmarked one is answered from memory, and a marked one usually
    // from its `stat`. A feature-sized diff therefore reads almost nothing,
    // which it has to — this runs again on every refresh.
    this.rows = await mapAsync(
      files,
      async (file) => ({
        kind: 'file' as const,
        file,
        resourceUri: file.uri,
        state: await this.reviewed.currentState(file.uri),
        reviewedAt: this.reviewed.entry(file.uri)?.at,
        comments: comments.get(file.uri.fsPath) ?? 0,
      }),
      { concurrency: READ_CONCURRENCY },
    )

    this.updateSummary()
    if (!this.isTreeLayout()) {
      this.parents = new Map()
      return this.rows
    }
    const tree = buildFolderTree(this.rows, compactFolders())
    this.parents = indexParents(tree)
    return tree
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    // In tree layout the folder is the row above, so a file need not repeat it.
    return node.kind === 'folder' ? folderItem(node) : fileItem(node, !this.isTreeLayout())
  }

  /** Required by `TreeView.reveal()` to expand its way down to a nested node. */
  getParent(node: ChangesNode): ChangesNode | undefined {
    return this.parents.get(node)
  }

  /** Every file a node stands for: itself, or everything beneath a folder. */
  filesOf(node: ChangesNode): readonly FileChangeNode[] {
    return node.kind === 'folder' ? node.files : [node]
  }

  /** The row for an open document, so the view can follow it — `undefined` if it isn't a tracked change. */
  findFile(uri: vscode.Uri): FileChangeNode | undefined {
    return this.rows.find((row) => row.file.uri.toString() === uri.toString())
  }

  /**
   * What a click on the checkbox means.
   *
   * A stale row is ticked, so VS Code proposes clearing it — but on a row that
   * says "changed since you reviewed", the click means "I have looked again",
   * not "forget that I ever read this". Reading it as an unmark forced two
   * clicks to get back to reviewed, and threw away the snapshot in between.
   *
   * So anything stale re-marks. Clearing a mark deliberately is the context
   * menu's job, where it can be named.
   */
  checkboxIntent(node: ChangesNode, state: vscode.TreeItemCheckboxState): 'mark' | 'unmark' {
    if (state === vscode.TreeItemCheckboxState.Checked) return 'mark'
    return this.filesOf(node).some((file) => file.state === 'stale') ? 'mark' : 'unmark'
  }

  private updateSummary(): void {
    if (!this.view) return
    const total = this.rows.length
    if (total === 0) {
      this.view.description = undefined
      return
    }
    const reviewed = this.rows.filter((row) => row.state === 'reviewed').length
    const stale = this.rows.filter((row) => row.state === 'stale').length
    const suffix = stale > 0 ? `, ${stale} stale` : ''
    this.view.description = `${reviewed}/${total} reviewed${suffix}`
  }
}

// --------------- Rendering ---------------

/**
 * A mark survives the change that outdated it, so the tick survives with it.
 *
 * The checkbox only has two states, so `stale` is a tick *plus* a dot and a
 * reason — not a cleared box. Clearing it would say "you never read this", which
 * is both wrong and throws away the one thing that makes the state useful: the
 * snapshot behind "show changes since I reviewed".
 */
function fileItem(node: FileChangeNode, showDirectory: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(node.file.relativePath))
  // The icon theme's own icon for this file type, with no git colouring — see
  // `iconResource`. The row's status letter carries what the colour would have.
  item.resourceUri = iconResource(node.file.uri)
  item.iconPath = vscode.ThemeIcon.File
  item.collapsibleState = vscode.TreeItemCollapsibleState.None
  item.description = describe(node, showDirectory)
  item.tooltip = tooltip(node)
  item.contextValue = `critChange.${node.state}`
  item.checkboxState = {
    state: node.state === 'unreviewed' ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked,
    // The checkbox has no label of its own, so this is the only place the
    // stale row's click behaviour can be spelled out.
    tooltip:
      node.state === 'stale'
        ? `Reviewed ${relativeTime(node.reviewedAt)}, changed since — click to mark reviewed again`
        : node.state === 'reviewed'
          ? `Reviewed ${relativeTime(node.reviewedAt)} — click to clear`
          : 'Mark as reviewed',
  }
  if (node.state === 'stale') {
    // A dot, not a warning sign. Nothing is wrong — the file moved on after you
    // read it, which is the same thing an editor's dirty dot says. A plain
    // `ThemeIcon` takes over from the file icon so the row is scannable.
    item.iconPath = new vscode.ThemeIcon(
      'circle-filled',
      new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    )
  }
  item.command = {
    command: 'crit.openChange',
    title: 'Open Changes',
    arguments: [node],
  }
  return item
}

function folderItem(node: FolderChangeNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded)
  item.resourceUri = iconResource(node.resourceUri)
  item.iconPath = vscode.ThemeIcon.Folder
  item.contextValue = 'critChangeFolder'
  const stale = node.files.filter((file) => file.state === 'stale').length
  const comments = node.files.reduce((total, file) => total + file.comments, 0)
  item.checkboxState = {
    state: node.files.every((file) => file.state !== 'unreviewed')
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked,
    tooltip: stale > 0 ? `${stale} changed since you reviewed — click to mark all reviewed` : 'Mark all as reviewed',
  }
  item.description = [commentMarker(comments), stale > 0 ? `${stale} stale` : ''].filter(Boolean).join(' · ')
  return item
}

function describe(node: FileChangeNode, showDirectory: boolean): string {
  const dir = path.dirname(node.file.relativePath)
  const state =
    node.state === 'stale'
      ? 'changed since you reviewed'
      : node.state === 'reviewed'
        ? `reviewed ${relativeTime(node.reviewedAt)}`
        : showDirectory && dir !== '.'
          ? dir
          : ''
  return [node.file.status, commentMarker(node.comments), state].filter(Boolean).join(' · ')
}

/** `💬 2`, or nothing at all — a file with no open comments says nothing. */
function commentMarker(comments: number): string {
  return comments > 0 ? `💬 ${comments}` : ''
}

function tooltip(node: FileChangeNode): string {
  const lines = [node.file.relativePath, `Status: ${node.file.status}`]
  if (node.comments > 0) {
    lines.push(`${node.comments} open review comment${node.comments === 1 ? '' : 's'}`)
  }
  if (node.state === 'reviewed') lines.push(`Reviewed ${relativeTime(node.reviewedAt)}`)
  if (node.state === 'stale') {
    lines.push(`Reviewed ${relativeTime(node.reviewedAt)}, changed since`)
    lines.push('Use "Show Changes Since I Reviewed" to see only what moved.')
  }
  return lines.join('\n')
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return 'earlier'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'earlier'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// --------------- Folder tree ---------------

interface FolderBuilder {
  label: string
  resourceUri: vscode.Uri
  folders: Map<string, FolderBuilder>
  files: FileChangeNode[]
}

/**
 * Group the flat listing by directory, the way the Source Control view's tree
 * layout does — including collapsing a run of single-child folders into one row,
 * so `src/views/changes` costs one line rather than three.
 *
 * `compact` is the caller's reading of `scm.compactFolders` rather than a read
 * of its own, so the shape of the tree stays a pure function of its arguments.
 */
export function buildFolderTree(rows: readonly FileChangeNode[], compact = true): ChangesNode[] {
  if (rows.length === 0) return []
  const root: FolderBuilder = {
    label: '',
    // Never rendered — only the root's children are returned.
    resourceUri: rows[0].file.uri,
    folders: new Map(),
    files: [],
  }

  for (const row of rows) {
    const segments = row.file.relativePath.split(/[\\/]/)
    let folder = root
    for (let i = 0; i < segments.length - 1; i++) {
      const label = segments[i]
      let child = folder.folders.get(label)
      if (!child) {
        // Walk up from the file rather than guessing a workspace root: the
        // number of steps is exactly how far this folder sits above it.
        const ups = Array.from({ length: segments.length - 1 - i }, () => '..')
        child = {
          label,
          resourceUri: vscode.Uri.joinPath(row.file.uri, ...ups),
          folders: new Map(),
          files: [],
        }
        folder.folders.set(label, child)
      }
      folder = child
    }
    folder.files.push(row)
  }

  return finish(root, compact).children
}

function finish(builder: FolderBuilder, compact: boolean): FolderChangeNode {
  const folders = [...builder.folders.values()]
    .map((folder) => finish(folder, compact))
    .map((folder) => (compact ? collapse(folder) : folder))
  const children: ChangesNode[] = [...folders, ...builder.files]
  const files = [...folders.flatMap((folder) => folder.files), ...builder.files]
  return { kind: 'folder', label: builder.label, resourceUri: builder.resourceUri, children, files }
}

/** Every node's immediate parent, for `TreeDataProvider.getParent()`. */
function indexParents(nodes: readonly ChangesNode[]): Map<ChangesNode, ChangesNode> {
  const parents = new Map<ChangesNode, ChangesNode>()
  const walk = (children: readonly ChangesNode[], parent: ChangesNode | undefined) => {
    for (const child of children) {
      if (parent) parents.set(child, parent)
      if (child.kind === 'folder') walk(child.children, child)
    }
  }
  walk(nodes, undefined)
  return parents
}

/** `a` → `a/b` → `a/b/c` while a folder's only child is another folder. */
function collapse(node: FolderChangeNode): FolderChangeNode {
  let current = node
  while (current.children.length === 1 && current.children[0].kind === 'folder') {
    const only = current.children[0]
    current = {
      kind: 'folder',
      label: `${current.label}/${only.label}`,
      resourceUri: only.resourceUri,
      children: only.children,
      files: only.files,
    }
  }
  return current
}
