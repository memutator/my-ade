// Desktop-state compatibility for the usage widget.
//
// The widget used to be driven by `settings.usageAccounts`: records the user
// created through the old sign-in form, each naming a harness (`provider`) and
// a credential file. Those records still exist in persisted desktop state, so
// they have to keep hydrating — but they are NOT the inventory domain:
//
//   · `provider` was never a catalog Provider id; it selected which CLI reads
//     the file. Everything reaching the domain is resolved to `harnessId` here
//     and stays labelled as a legacy registration in the UI.
//   · the canonical equivalents (ProviderCredential + ProviderConnection) are
//     owned by the daemon store. A legacy record is handed to the daemon read
//     as a display-only hint (`DomainLegacySource`), never as an identity.
//
// Nothing in this file parses a credential, opens a file, or calls a provider.

import type { DomainLegacySource } from '../../../../preload/domain'
import type { UsageAccount } from '../../types'

/** the harness a desktop account record refers to, old field included */
export function legacyAccountHarnessId(account: UsageAccount): string | undefined {
  return account.harnessId ?? account.provider
}

/** default label for a registered account: profile dirs name the account
 *  ('login-homes/amir/auth.json' → 'amir'); free-standing files fall back to
 *  their basename sans extension ('bob.json' → 'bob') */
const KNOWN_CRED_FILES = new Set([
  'auth.json',
  '.credentials.json',
  'oauth_creds.json',
  'config.json',
  'credentials.toml',
  'apps.json',
  'hosts.yml'
])

export function accountLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  const base = parts[parts.length - 1] ?? path
  if (!KNOWN_CRED_FILES.has(base)) return base.replace(/\.[^.]+$/, '') || base
  return parts.length > 1 ? (parts[parts.length - 2] ?? base) : base
}

export interface LegacyAccountRecord {
  account: UsageAccount
  harnessId: string
  label: string
}

/** accounts that can be shown at all — a record with no harness or no path
 *  cannot be attributed to anything and is skipped rather than guessed at */
export function legacyAccountRecords(accounts: UsageAccount[]): LegacyAccountRecord[] {
  return accounts.flatMap((account): LegacyAccountRecord[] => {
    const harnessId = legacyAccountHarnessId(account)
    if (!harnessId || !account.path) return []
    return [{ account, harnessId, label: account.label ?? accountLabel(account.path) }]
  })
}

export function toLegacySource(record: LegacyAccountRecord): DomainLegacySource {
  return {
    id: record.account.id,
    path: record.account.path,
    harnessId: record.harnessId,
    label: record.label
  }
}
