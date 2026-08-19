const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const { bucketKey, hashContent, NO_REPO_BUCKET, ReviewedFiles } = require('../src/reviewed-files.ts')

/**
 * The model takes its storage, its content reads, and its bucket assignment as
 * dependencies, so a test can drive all three without an extension host.
 */
function harness({ bucketFor, maxHashBytes } = {}) {
  const store = new Map()
  const files = new Map()
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-snapshots-'))
  const reads = []
  // Stands in for a filesystem clock: every write lands at a later instant, so
  // the size/mtime gate behaves the way a real one does.
  let clock = 1000

  const reviewed = new ReviewedFiles({
    storage: {
      get: (key) => store.get(key),
      update: (key, value) => store.set(key, value),
      keys: () => [...store.keys()],
    },
    bucketKeyFor: bucketFor ?? (() => bucketKey('repo-aaaaaaaa', 'main')),
    readContent: async (uri) => {
      reads.push(uri.fsPath)
      return files.get(uri.fsPath)?.bytes
    },
    probe: async (uri) => {
      const file = files.get(uri.fsPath)
      if (!file) return undefined
      return { size: file.bytes.length, mtimeMs: file.mtimeMs, dirty: file.dirty }
    },
    snapshotDir,
    maxHashBytes,
  })

  function write(fsPath, content, { dirty = false } = {}) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    files.set(fsPath, { bytes, mtimeMs: (clock += 1000), dirty })
  }

  return {
    reviewed,
    store,
    snapshotDir,
    write,
    reads,
    /** Bump mtime without changing a byte — a checkout, a stash pop, a rewrite. */
    touch: (fsPath) => {
      const file = files.get(fsPath)
      if (file) file.mtimeMs += 1000
    },
    remove: (fsPath) => files.delete(fsPath),
    uri: (fsPath) => ({ fsPath }),
    snapshotDirs: () => fs.readdirSync(snapshotDir).sort(),
  }
}

test('a mark is fresh against the content it was taken from and stale against anything else', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'original\n')

  assert.equal(await h.reviewed.currentState(file), 'unreviewed')

  await h.reviewed.mark(file)
  assert.equal(await h.reviewed.currentState(file), 'reviewed')

  // What an agent editing the file looks like from here.
  h.write(file.fsPath, 'original\nplus a new line\n')
  assert.equal(await h.reviewed.currentState(file), 'stale')

  // The mark survives the change — that is what makes the delta diff possible.
  assert.ok(h.reviewed.entry(file))
})

test('re-marking a stale file makes it fresh again at the new content', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'one\n')
  await h.reviewed.mark(file)

  h.write(file.fsPath, 'two\n')
  assert.equal(await h.reviewed.currentState(file), 'stale')

  await h.reviewed.mark(file)
  assert.equal(await h.reviewed.currentState(file), 'reviewed')
})

test('a line-ending rewrite is a change like any other', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'first\nsecond\n')
  await h.reviewed.mark(file)

  // Rewriting the endings is a content change like any other: the hash names
  // raw bytes, so the mark goes stale and the snapshot stays a faithful
  // baseline for the bytes it was taken from.
  h.write(file.fsPath, 'first\r\nsecond\r\n')
  assert.equal(await h.reviewed.currentState(file), 'stale')
  assert.notEqual(hashContent('a\r\nb'), hashContent('a\nb'))
})

test('an unreadable file reads as stale, never as reviewed', async () => {
  const h = harness()
  const file = h.uri('/repo/src/gone.ts')
  h.write(file.fsPath, 'here\n')
  await h.reviewed.mark(file)

  h.remove(file.fsPath)
  assert.equal(await h.reviewed.currentState(file), 'stale')
  // Unmarked and unreadable is still simply unreviewed.
  assert.equal(await h.reviewed.currentState(h.uri('/repo/src/never.ts')), 'unreviewed')
})

test('unmarking removes only the file asked for', async () => {
  const h = harness()
  const kept = h.uri('/repo/a.ts')
  const dropped = h.uri('/repo/b.ts')
  h.write(kept.fsPath, 'a\n')
  h.write(dropped.fsPath, 'b\n')
  await h.reviewed.mark(kept)
  await h.reviewed.mark(dropped)

  h.reviewed.unmark(dropped)

  assert.equal(await h.reviewed.currentState(kept), 'reviewed')
  assert.equal(await h.reviewed.currentState(dropped), 'unreviewed')
})

test('marks live in the bucket of the repository and branch that owns the file', async () => {
  // Two checkouts with the same folder name, which is exactly the case a
  // basename-only key silently merged.
  const buckets = {
    '/work/api/src/a.ts': bucketKey('api-11111111', 'main'),
    '/side/api/src/a.ts': bucketKey('api-22222222', 'main'),
    '/loose/notes.md': NO_REPO_BUCKET,
  }
  const h = harness({ bucketFor: (uri) => buckets[uri.fsPath] })

  for (const fsPath of Object.keys(buckets)) h.write(fsPath, 'same content everywhere\n')
  await h.reviewed.mark(h.uri('/work/api/src/a.ts'))

  assert.equal(await h.reviewed.currentState(h.uri('/work/api/src/a.ts')), 'reviewed')
  assert.equal(await h.reviewed.currentState(h.uri('/side/api/src/a.ts')), 'unreviewed')
  assert.equal(await h.reviewed.currentState(h.uri('/loose/notes.md')), 'unreviewed')
  assert.deepEqual(
    [...h.store.keys()],
    [bucketKey('api-11111111', 'main')],
    'marking one repository must not create the other one a bucket',
  )
})

test('an unseen branch inherits, then diverges', () => {
  const h = harness()
  const from = bucketKey('repo-aaaaaaaa', 'main')
  const to = bucketKey('repo-aaaaaaaa', 'feature')
  h.store.set(from, { '/repo/a.ts': { hash: 'h1', at: 'now' } })

  assert.equal(h.reviewed.inherit(from, to), true)
  assert.deepEqual(h.reviewed.bucket(to), { '/repo/a.ts': { hash: 'h1', at: 'now' } })

  // Diverging: the copy is independent of its source.
  h.store.set(to, {})
  assert.deepEqual(h.reviewed.bucket(from), { '/repo/a.ts': { hash: 'h1', at: 'now' } })
})

test('a branch that already has marks is never overwritten by inheritance', () => {
  const h = harness()
  const from = bucketKey('repo-aaaaaaaa', 'main')
  const to = bucketKey('repo-aaaaaaaa', 'feature')
  h.store.set(from, { '/repo/a.ts': { hash: 'from', at: 'now' } })
  h.store.set(to, { '/repo/b.ts': { hash: 'to', at: 'now' } })

  assert.equal(h.reviewed.inherit(from, to), false)
  assert.deepEqual(h.reviewed.bucket(to), { '/repo/b.ts': { hash: 'to', at: 'now' } })
})

test('pruning retires marks for files no longer under review', async () => {
  const h = harness()
  const stillChanged = h.uri('/repo/a.ts')
  const committed = h.uri('/repo/b.ts')
  h.write(stillChanged.fsPath, 'a\n')
  h.write(committed.fsPath, 'b\n')
  await h.reviewed.mark(stillChanged)
  await h.reviewed.mark(committed)

  const pruned = h.reviewed.prune(bucketKey('repo-aaaaaaaa', 'main'), new Set([stillChanged.fsPath]))

  assert.equal(pruned, true)
  assert.equal(await h.reviewed.currentState(stillChanged), 'reviewed')
  assert.equal(await h.reviewed.currentState(committed), 'unreviewed')
  // Nothing to do the second time round.
  assert.equal(h.reviewed.prune(bucketKey('repo-aaaaaaaa', 'main'), new Set([stillChanged.fsPath])), false)
})

test('identical content marked twice is stored once', async () => {
  const h = harness()
  const a = h.uri('/repo/a.ts')
  const b = h.uri('/repo/b.ts')
  h.write(a.fsPath, 'shared\n')
  h.write(b.fsPath, 'shared\n')

  await h.reviewed.mark(a)
  await h.reviewed.mark(b)

  assert.equal(h.snapshotDirs().length, 1, 'content-addressed blobs must dedupe')
  assert.equal(await h.reviewed.snapshotContent(a), 'shared\n')
  assert.equal(await h.reviewed.snapshotContent(b), 'shared\n')
})

test('collection keeps a snapshot another branch still refers to', async () => {
  const h = harness()
  const file = h.uri('/repo/a.ts')
  h.write(file.fsPath, 'v1\n')
  await h.reviewed.mark(file)
  const v1 = h.reviewed.entry(file).hash

  // A second branch is left holding the v1 snapshot while this branch moves on.
  h.store.set(bucketKey('repo-aaaaaaaa', 'other'), { '/repo/a.ts': { hash: v1, at: 'earlier' } })
  h.write(file.fsPath, 'v2\n')
  await h.reviewed.mark(file)
  const v2 = h.reviewed.entry(file).hash

  assert.equal(await h.reviewed.collectGarbage(), 0)
  assert.deepEqual(h.snapshotDirs(), [v1, v2].sort())

  // Once nothing refers to v1, it goes.
  h.store.delete(bucketKey('repo-aaaaaaaa', 'other'))
  assert.equal(await h.reviewed.collectGarbage(), 1)
  assert.deepEqual(h.snapshotDirs(), [v2])
})

test('the snapshot of an unmarked file is simply absent', async () => {
  const h = harness()
  assert.equal(await h.reviewed.snapshotContent(h.uri('/repo/never.ts')), undefined)
})

// --------------- The size/mtime gate ---------------

test('an unmarked file is answered without touching it', async () => {
  const h = harness()
  const file = h.uri('/repo/src/big.ts')
  h.write(file.fsPath, 'whatever\n')

  assert.equal(await h.reviewed.currentState(file), 'unreviewed')
  assert.deepEqual(h.reads, [], 'an unreviewed verdict never depends on the content')
})

test('a mark that has not moved is confirmed without reading the file', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'original\n')
  await h.reviewed.mark(file)
  h.reads.length = 0

  assert.equal(await h.reviewed.currentState(file), 'reviewed')
  assert.deepEqual(h.reads, [], 'unmoved size and mtime are the whole answer')
})

test('a touched but unchanged file stays reviewed — the gate may only skip work', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'original\n')
  await h.reviewed.mark(file)

  // What a branch round trip does: rewrites the file, lands it byte-identical.
  h.touch(file.fsPath)
  h.reads.length = 0

  assert.equal(await h.reviewed.currentState(file), 'reviewed')
  assert.deepEqual(h.reads, [file.fsPath], 'a moved mtime forces the real comparison')
})

test('an unsaved buffer is never waved through by the gate', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'saved\n')
  await h.reviewed.mark(file)

  // Same bytes on disk, different bytes on screen: no stat can see this.
  h.write(file.fsPath, 'saved\nand typed since\n', { dirty: true })
  assert.equal(await h.reviewed.currentState(file), 'stale')
})

test('a mark taken on a dirty buffer does not record disk facts it did not hash', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'typed but unsaved\n', { dirty: true })

  const entry = await h.reviewed.mark(file)
  assert.equal(entry.tier, 'hash')
  assert.equal(entry.size, undefined, 'the disk describes different bytes than the ones hashed')
  assert.equal(entry.mtimeMs, undefined)
  assert.equal(await h.reviewed.currentState(file), 'reviewed')
})

test('a mark written before the gate existed still works, by hashing', async () => {
  const h = harness()
  const file = h.uri('/repo/a.ts')
  h.write(file.fsPath, 'legacy\n')
  // The shape marks had before sizes and tiers were recorded.
  h.store.set(bucketKey('repo-aaaaaaaa', 'main'), {
    [file.fsPath]: { hash: hashContent('legacy\n'), at: 'earlier' },
  })

  assert.equal(await h.reviewed.currentState(file), 'reviewed')
  h.write(file.fsPath, 'changed\n')
  assert.equal(await h.reviewed.currentState(file), 'stale')
})

// --------------- The stat tier ---------------

test('a file too large to hold is tracked by size and mtime, with no snapshot', async () => {
  const h = harness({ maxHashBytes: 64 })
  const file = h.uri('/repo/package-lock.json')
  h.write(file.fsPath, 'x'.repeat(200))

  const entry = await h.reviewed.mark(file)
  assert.equal(entry.tier, 'stat')
  assert.equal(entry.hash, undefined)
  assert.deepEqual(h.snapshotDirs(), [], 'nothing that large should be copied per mark')
  assert.deepEqual(h.reads, [], 'and it is never read in the first place')

  assert.equal(await h.reviewed.currentState(file), 'reviewed')
  assert.equal(await h.reviewed.snapshotContent(file), undefined)
})

test('a large file goes stale on a touch — false stale is the safe direction', async () => {
  const h = harness({ maxHashBytes: 64 })
  const file = h.uri('/repo/package-lock.json')
  h.write(file.fsPath, 'x'.repeat(200))
  await h.reviewed.mark(file)

  h.touch(file.fsPath)
  assert.equal(await h.reviewed.currentState(file), 'stale')
})

test('a binary file is tracked but never snapshotted, so no blob can be corrupted', async () => {
  const h = harness()
  const file = h.uri('/repo/icon.png')
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x41])])
  h.write(file.fsPath, png)

  const entry = await h.reviewed.mark(file)
  assert.equal(entry.tier, 'stat', 'a NUL byte means this cannot survive a text round trip')
  assert.deepEqual(h.snapshotDirs(), [])
  assert.equal(await h.reviewed.currentState(file), 'reviewed')
})

test('a stat-tier mark keeps no blob alive', async () => {
  const h = harness({ maxHashBytes: 64 })
  const small = h.uri('/repo/a.ts')
  const large = h.uri('/repo/big.bin')
  h.write(small.fsPath, 'small\n')
  h.write(large.fsPath, 'x'.repeat(200))
  await h.reviewed.mark(small)
  await h.reviewed.mark(large)

  assert.equal(await h.reviewed.collectGarbage(), 0, 'the one real blob is still referenced')
  h.reviewed.unmark(small)
  assert.equal(await h.reviewed.collectGarbage(), 1)
})

test('bytes are hashed, so two files that differ only outside UTF-8 differ', async () => {
  // Decoding these as UTF-8 collapses both to the same replacement characters,
  // which would let a changed file keep reading as reviewed.
  assert.notEqual(hashContent(Buffer.from([0xff, 0xfe, 0x41])), hashContent(Buffer.from([0xff, 0xff, 0x41])))
})

test('a snapshot is the file, byte for byte', async () => {
  const h = harness()
  const file = h.uri('/repo/utf8.ts')
  const text = 'const s = "héllo — ünïcode"\n'
  h.write(file.fsPath, text)
  await h.reviewed.mark(file)

  assert.equal(await h.reviewed.snapshotContent(file), text)
})

// --------------- Renames ---------------

test('a mark git reported as renamed follows its file, and stays reviewed', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'unchanged\n')
  await h.reviewed.mark(from)

  // What `git mv` looks like: the bytes reappear under another name.
  h.remove(from.fsPath)
  h.write(to.fsPath, 'unchanged\n')

  assert.equal(h.reviewed.moveMark(from, to), true)
  assert.equal(h.reviewed.entry(from), undefined)
  assert.equal(await h.reviewed.currentState(to), 'reviewed')
})

test('a rename that also edited the file keeps the mark, and reads stale', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'before\n')
  await h.reviewed.mark(from)
  const hash = h.reviewed.entry(from).hash

  h.remove(from.fsPath)
  h.write(to.fsPath, 'before\nand after\n')
  h.reviewed.moveMark(from, to)

  // The snapshot travels with the mark, so the delta diff still has a baseline.
  assert.equal(await h.reviewed.currentState(to), 'stale')
  assert.equal(h.reviewed.entry(to).hash, hash)
  assert.equal(await h.reviewed.snapshotContent(to), 'before\n')
})

test('a mark on the destination is not overwritten by one arriving from a rename', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'one\n')
  h.write(to.fsPath, 'two\n')
  await h.reviewed.mark(from)
  await h.reviewed.mark(to)

  assert.equal(h.reviewed.moveMark(from, to), false)
  assert.equal(await h.reviewed.currentState(to), 'reviewed')
})

test('an unstaged rename is linked by content, so the mark follows the bytes', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'moved verbatim\n')
  await h.reviewed.mark(from)

  h.remove(from.fsPath)
  h.write(to.fsPath, 'moved verbatim\n')

  assert.equal(await h.reviewed.reanchorRenames([to]), 1)
  assert.equal(h.reviewed.entry(from), undefined)
  assert.equal(await h.reviewed.currentState(to), 'reviewed')
})

test('a new file that merely resembles a deleted one does not inherit its mark', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'original\n')
  await h.reviewed.mark(from)

  h.remove(from.fsPath)
  h.write(to.fsPath, 'original, plus a line nobody reviewed\n')

  assert.equal(await h.reviewed.reanchorRenames([to]), 0)
  assert.equal(await h.reviewed.currentState(to), 'unreviewed')
})

test('one deleted file claims one destination, so a copy leaves the rest unreviewed', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const first = h.uri('/repo/src/a.ts')
  const second = h.uri('/repo/src/b.ts')
  h.write(from.fsPath, 'shared\n')
  await h.reviewed.mark(from)

  h.remove(from.fsPath)
  h.write(first.fsPath, 'shared\n')
  h.write(second.fsPath, 'shared\n')

  assert.equal(await h.reviewed.reanchorRenames([first, second]), 1)
  assert.equal(await h.reviewed.currentState(first), 'reviewed')
  assert.equal(await h.reviewed.currentState(second), 'unreviewed')
})

test('a deleted file still on disk moved nowhere, and nothing is read to find out', async () => {
  const h = harness()
  const from = h.uri('/repo/src/old.ts')
  const to = h.uri('/repo/src/new.ts')
  h.write(from.fsPath, 'still here\n')
  await h.reviewed.mark(from)
  h.write(to.fsPath, 'still here\n')

  h.reads.length = 0
  assert.equal(await h.reviewed.reanchorRenames([to]), 0)
  assert.deepEqual(h.reads, [])
})

test('a new file whose size matches no mark is settled without reading it', async () => {
  const h = harness()
  const file = h.uri('/repo/src/git.ts')
  h.write(file.fsPath, 'content\n')
  await h.reviewed.mark(file)

  const other = h.uri('/repo/src/new.ts')
  h.write(other.fsPath, 'a completely different length of content\n')
  h.reads.length = 0
  assert.equal(await h.reviewed.reanchorRenames([other]), 0)
  assert.deepEqual(h.reads, [])
})

test('renaming a file git never tracked still carries its mark', async () => {
  const h = harness()
  const from = h.uri('/repo/src/brand-new.ts')
  const to = h.uri('/repo/src/renamed.ts')
  h.write(from.fsPath, 'never committed\n')
  await h.reviewed.mark(from)

  // An untracked rename mentions neither the old path nor a deletion: the only
  // trace of the old name is the mark itself.
  h.remove(from.fsPath)
  h.write(to.fsPath, 'never committed\n')

  assert.equal(await h.reviewed.reanchorRenames([to]), 1)
  assert.equal(h.reviewed.entry(from), undefined)
  assert.equal(await h.reviewed.currentState(to), 'reviewed')
})

test('a mark whose file is still on disk is never re-anchored onto a twin', async () => {
  const h = harness()
  const marked = h.uri('/repo/src/original.ts')
  const copy = h.uri('/repo/src/copy.ts')
  h.write(marked.fsPath, 'duplicated\n')
  await h.reviewed.mark(marked)
  h.write(copy.fsPath, 'duplicated\n')

  assert.equal(await h.reviewed.reanchorRenames([copy]), 0)
  assert.equal(await h.reviewed.currentState(marked), 'reviewed')
  assert.equal(await h.reviewed.currentState(copy), 'unreviewed')
})
