import { createHash, randomUUID } from 'crypto'

export const CRIT_DIAGNOSTIC_SOURCE = 'Crit'

export const CRIT_DIAGNOSTIC_VERSION = 2 as const

/**
 * Where a Crit code points.
 *
 * `threadRef` is absent in the shorter form, `crit:v2;<project>`, which
 * addresses a project but no comment in particular. That form exists because a
 * review request has to be addressable before any comment exists: the agent is
 * asked to *create* the threads, so it cannot be handed a thread's code. Tools
 * that mutate one thread require the long form; listing and creating accept
 * either.
 *
 * There is deliberately nothing here naming a window. Codes outlive the window
 * that minted them — an agent holds one for the whole of a review, across every
 * reload and reconnect in that span — while an extension-host activation does
 * not. So a code names only what is durable, and `ipc-registry` answers the
 * perishable half of the question: which live window holds this project *now*.
 */
export interface CritDiagnosticMetadata {
  version: typeof CRIT_DIAGNOSTIC_VERSION
  projectRef: string
  threadRef?: string
}

/**
 * Refs are 8 hex chars (32 bits). They are routing metadata, never secrets, so
 * they only need to be unique across the workspace roots on one machine and the
 * threads within a branch — populations in the hundreds, where 32 bits gives a
 * collision chance around one in a million. Keeping them short matters because
 * the code is rendered verbatim in the Problems view.
 *
 * Both are structurally identical; only position within the code distinguishes
 * them, so a single pattern validates either.
 */
const REF_PATTERN = /^[0-9a-f]{8}$/
const REF_HEX_LENGTH = 8

// Diagnostics render as `R3 crit:v2;…`, and agents copy the whole
// string. Accept an optional leading `R<n>` label so a pasted diagnostic code
// resolves without the caller having to strip it first. The thread segment is
// optional — see `CritDiagnosticMetadata`.
const DIAGNOSTIC_CODE_PATTERN = /^(?:R\d+\s+)?crit:v(\d+);([0-9a-f]{8})(?:;([0-9a-f]{8}))?$/

export function createThreadRef(): string {
  return createRandomRef()
}

export function createProjectRef(canonicalProjectIdentity: string): string {
  return createHash('sha256').update(canonicalProjectIdentity).digest('hex').slice(0, REF_HEX_LENGTH)
}

/** Project and thread refs are structurally identical. */
export function isRef(value: string): boolean {
  return REF_PATTERN.test(value)
}

export function encodeDiagnosticMetadata(metadata: CritDiagnosticMetadata): string {
  validateMetadata(metadata)
  // Positional, not labelled: `project=`/`thread=` cost 16 chars and add
  // nothing, since order already fixes the meaning.
  const code = `crit:v${metadata.version};${metadata.projectRef}`
  return metadata.threadRef === undefined ? code : `${code};${metadata.threadRef}`
}

export function parseDiagnosticMetadata(code: string): CritDiagnosticMetadata | undefined {
  const match = DIAGNOSTIC_CODE_PATTERN.exec(code)
  if (!match) return undefined

  const version = Number(match[1])
  if (version !== CRIT_DIAGNOSTIC_VERSION) return undefined

  const metadata: CritDiagnosticMetadata = {
    version,
    projectRef: match[2],
    // Left off the object entirely rather than set to undefined, so a
    // round-tripped project code compares equal to the metadata it came from.
    ...(match[3] === undefined ? {} : { threadRef: match[3] }),
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
  if (!isRef(metadata.projectRef)) {
    throw new Error('Invalid Crit project reference.')
  }
  if (metadata.threadRef !== undefined && !isRef(metadata.threadRef)) {
    throw new Error('Invalid Crit thread reference.')
  }
}
