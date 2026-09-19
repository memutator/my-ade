/** Stable operation metadata shared by the daemon, CLI and desktop. */
export const INTEGRATION_DOMAIN_OPERATIONS = [
  ...['session.list', 'session.get', 'session.event.list', 'session.handle.list', 'session.hook.ingest', 'session.desktop.import']
    .map((name) => ({ name, contract: 'C-SESSIONS', owner: 'sessions' })),
  ...['usage.entry.get', 'usage.entry.list', 'usage.ledger.changes',
    'usage.counterRecompute.list', 'usage.counterRecompute.drain']
    .map((name) => ({ name, contract: 'C-METERING', owner: 'metering' })),
  ...['collection.source.list', 'collection.source.get', 'collection.source.observe',
    'collection.batch.list', 'collection.coverage.list', 'collection.request',
    'collection.request.list', 'collection.request.cancel', 'collection.request.claim', 'collection.request.complete']
    .map((name) => ({ name, contract: 'C-COLLECTION', owner: 'collection' })),
  ...[
    'catalog.snapshot', 'catalog.seed', 'catalog.organization.put', 'catalog.harness.put',
    'catalog.provider.put', 'catalog.offering.put', 'catalog.model.put', 'catalog.alias.observe', 'catalog.alias.resolve'
  ].map((name) => ({ name, contract: 'C-CATALOG', owner: 'catalog' })),
  ...[
    'inventory.snapshot', 'inventory.machine.put', 'inventory.installation.put',
    'inventory.installationRevision.append', 'inventory.credential.register', 'inventory.credential.refresh',
    'inventory.credential.replace', 'inventory.connection.put', 'inventory.identityClaim.put',
    'inventory.quotaPoolClaim.put', 'inventory.binding.put', 'inventory.observation.record'
  ].map((name) => ({ name, contract: 'C-INVENTORY', owner: 'inventory' })),
  ...[
    'auth.status', 'auth.intent.begin', 'auth.intent.record', 'auth.intent.complete', 'auth.intent.list',
    'auth.flow.list', 'auth.flow.status', 'auth.flow.cancel', 'auth.flow.refresh',
    'auth.connection.inventory', 'auth.locator.import', 'auth.locator.adopt', 'auth.quota.collect', 'auth.quota.current'
  ].map((name) => ({ name, contract: 'C-AUTH', owner: 'inventory' })),
  ...[
    'integration.pack.register', 'integration.pack.list', 'integration.capability.state',
    'integration.capability.check', 'integration.capability.invoke'
  ].map((name) => ({ name, contract: 'C-INTEGRATION', owner: 'integration' })),
  ...[
    'metering.quota.record', 'metering.quota.current', 'metering.quota.list',
    'metering.summary.query', 'metering.summary.rank', 'metering.pool.share',
    'metering.aggregate.refresh', 'metering.aggregate.rebuild', 'metering.aggregate.prune',
    'metering.statistic.definition.register', 'metering.statistic.coverage.project',
    'metering.statistic.refresh', 'metering.statistic.get', 'metering.statistic.list'
  ].map((name) => ({ name, contract: 'C-METERING', owner: 'metering' }))
] as const
