/** Pack → desktop descriptor carried by agents:manifest IPC. */

export interface HarnessDescriptor {
  match: string[]
  label: string
  domain?: string
  color?: string
  /** legacy pair; the session id is appended by the caller */
  resume?: { cmd: string; args: string[] }
  /** Pack recipe with the SESSION_SLOT placeholder */
  recipe?: { executable: string; args: string[] }
  hooks?: string
  maintenance?: string[]
  publisher?: string
  testOnly?: boolean
}
