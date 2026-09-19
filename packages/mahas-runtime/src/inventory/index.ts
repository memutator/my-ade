import type { DatabaseSync } from 'node:sqlite'
import { CATALOG_SCHEMA_SQL, applyCatalogSchema } from '../catalog/migration.ts'
import {
  registerCatalogOperations,
  type CatalogOperationRegistry
} from '../catalog/operations.ts'
import { INVENTORY_SCHEMA_SQL, applyInventorySchema } from './migration.ts'
import {
  registerInventoryOperations,
  type InventoryOperationRegistry
} from './operations.ts'

export { INVENTORY_SCHEMA_SQL, applyInventorySchema } from './migration.ts'
export {
  appendInstallationRevision,
  getInventorySnapshot,
  putBinding,
  putIdentityClaim,
  putInstallation,
  putMachine,
  putProviderConnection,
  putQuotaPoolClaim,
  recordInventoryObservation,
  refreshCredential,
  registerCredential,
  replaceCredential,
  resolveInventoryRevisions
} from './repository.ts'
export type {
  InventoryObservationOutcome,
  InventorySnapshot
} from './repository.ts'
export { INVENTORY_OPERATION_NAMES, registerInventoryOperations } from './operations.ts'
export type { InventoryOperationRegistry } from './operations.ts'
export * from './auth/index.ts'
export {
  ensureHarnessInstallation,
  ensureLocalMachine,
  LOCAL_MACHINE_ID_FILENAME
} from './local.ts'
export type { EnsureHarnessInstallationInput, LocalMachineIo } from './local.ts'

/** Root wiring may append these SQL blocks to its numbered control migration. */
export const CATALOG_INVENTORY_MIGRATIONS = [
  { id: 'catalog-schema-v1', sql: CATALOG_SCHEMA_SQL },
  { id: 'inventory-schema-v1', sql: INVENTORY_SCHEMA_SQL }
] as const

export const CATALOG_INVENTORY_SCHEMA_SQL = `${CATALOG_SCHEMA_SQL}\n${INVENTORY_SCHEMA_SQL}`

export function applyCatalogInventorySchema(db: DatabaseSync): void {
  applyCatalogSchema(db)
  applyInventorySchema(db)
}

export function registerCatalogInventoryOperations(
  registry: CatalogOperationRegistry & InventoryOperationRegistry
): void {
  registerCatalogOperations(registry)
  registerInventoryOperations(registry)
}
