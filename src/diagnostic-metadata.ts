import { createHash, randomUUID } from 'crypto'

export const CRIT_DIAGNOSTIC_SOURCE = 'Crit'

export const CRIT_DIAGNOSTIC_VERSION = 1 as const

/**
 * Where a Crit code points.
 *
 * `threadRef` is absent in the shorter form, `crit:v1;<session>;<project>`,
 * which addresses a window and a project but no comment in particular. That form
 * exists because a review request has to be addressable before any comment
 * exists: the agent is asked to *create* the threads, so it cannot be handed a
 * thread's code. Tools that mutate one thread require the long form; listing and
 * creating accept either.
 */
export interface CritDiagnosticMetadata {
  version: typeof CRIT_DIAGNOSTIC_VERSION
  sessionRef: string
  projectRef: string
  threadRef?: string
}

/**
 * Refs are 8 hex chars (32 bits). They are routing metadata, never secrets, so
 * they only need to be unique across the handful of concurrent windows, the
 * workspace roots on one machine, and the threads within a branch — populations
 * in the hundreds, where 32 bits gives a collision chance around one in a
 * million. Keeping them short matters because the code is rendered verbatim in
 * the Problems view.
 *
 * All three are structurally identical; only position within the code
 * distinguishes them, so a single pattern validates any of them.
 */
const REF_PATTERN = /^[0-9a-f]{8}$/
const REF_HEX_LENGTH = 8

// Diagnostics render as `R3 crit:v1;…`, and agents copy the whole
// string. Accept an optional leading `R<n>` label so a pasted diagnostic code
// resolves without the caller having to strip it first. The thread segment is
// optional — see `CritDiagnosticMetadata`.
const DIAGNOSTIC_CODE_PATTERN = /^(?:R\d+\s+)?crit:v(\d+);([0-9a-f]{8});([0-9a-f]{8})(?:;([0-9a-f]{8}))?$/

export function createSessionRef(): string {
  return createRandomRef()
}

export function createThreadRef(): string {
  return createRandomRef()
}

export function createProjectRef(canonicalProjectIdentity: string): string {
  return createHash('sha256').update(canonicalProjectIdentity).digest('hex').slice(0, REF_HEX_LENGTH)
}

/** Session, project, and thread refs are structurally identical. */
export function isRef(value: string): boolean {
  return REF_PATTERN.test(value)
}

export function encodeDiagnosticMetadata(metadata: CritDiagnosticMetadata): string {
  validateMetadata(metadata)
  // Positional, not labelled: `session=`/`project=`/`thread=` cost 24 chars
  // and add nothing, since order already fixes the meaning.
  const code = `crit:v${metadata.version};${metadata.sessionRef};${metadata.projectRef}`
  return metadata.threadRef === undefined ? code : `${code};${metadata.threadRef}`
}

export function parseDiagnosticMetadata(code: string): CritDiagnosticMetadata | undefined {
  const match = DIAGNOSTIC_CODE_PATTERN.exec(code)
  if (!match) return undefined

  const version = Number(match[1])
  if (version !== CRIT_DIAGNOSTIC_VERSION) return undefined

  const metadata: CritDiagnosticMetadata = {
    version,
    sessionRef: match[2],
    projectRef: match[3],
    // Left off the object entirely rather than set to undefined, so a
    // round-tripped project code compares equal to the metadata it came from.
    ...(match[4] === undefined ? {} : { threadRef: match[4] }),
  }

  try {
    validateMetadata(metadata)
    return metadata
  } catch {
    return undefined
  }
}

function createRandomRef(): string {
  return randomUUID().replace(/-/g, '').slice(0, REF_HEX_LENGTH)
}

function validateMetadata(metadata: CritDiagnosticMetadata): void {
  if (metadata.version !== CRIT_DIAGNOSTIC_VERSION) {
    throw new Error(`Unsupported diagnostic metadata version: ${String(metadata.version)}`)
  }
  if (!isRef(metadata.sessionRef)) {
    throw new Error('Invalid Crit session reference.')
  }
  if (!isRef(metadata.projectRef)) {
    throw new Error('Invalid Crit project reference.')
  }
  if (metadata.threadRef !== undefined && !isRef(metadata.threadRef)) {
    throw new Error('Invalid Crit thread reference.')
  }
}
