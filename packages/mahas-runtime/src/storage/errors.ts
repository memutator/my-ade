// storage/errors.ts — failure surface of the storage boundary.
//
// StorageError carries one of the fixed spec/common.md §4 ErrorCodes when a
// storage-level failure maps onto the shared error taxonomy
// (OPERATION_CONFLICT, ARTIFACT_MISMATCH, INVALID_TRANSITION, ...). Pure
// programmer errors (missing arguments, unconfigured store roots) throw a
// plain Error instead — they are bugs, not domain verdicts.

import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/index.ts'

export class StorageError extends Error {
  readonly code: ErrorCode
  readonly retry: ErrorRetry
  readonly details?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retry?: ErrorRetry; details?: unknown }
  ) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.retry = options?.retry ?? 'none'
    this.details = options?.details
  }

  /** project into the wire-facing spec/common.md §2 Error shape */
  toMahasError(): MahasError {
    return { code: this.code, message: this.message, retry: this.retry, details: this.details }
  }
}
