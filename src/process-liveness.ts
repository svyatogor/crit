/**
 * Whether `pid` names a process running on this machine.
 *
 * Every on-disk registry this extension reads — Claude Code's session
 * descriptors and our own IPC instance descriptors — is written by a live
 * process and orphaned when that process dies without cleaning up. The pid is
 * the only field that can be checked against reality, and it is only meaningful
 * because these registries are host-local.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 performs the permission and existence checks without
    // delivering a signal.
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user.
    return isErrnoException(error) && error.code === 'EPERM'
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
