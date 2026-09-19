/**
 * Dependency-free, JSON-compatible schema DSL used at the AdapterPack boundary.
 * The values below are the machine authority; exported payload types are inferred
 * from them rather than maintained as a second handwritten contract.
 */
export type IntegrationSchema =
  | { readonly oneOf: readonly IntegrationSchema[] }
  | { readonly type: 'string'; readonly enum?: readonly string[] }
  | { readonly type: 'number'; readonly integer?: boolean; readonly minimum?: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'null' }
  | { readonly type: 'array'; readonly items: IntegrationSchema }
  | {
      readonly type: 'object'
      readonly properties: Readonly<Record<string, IntegrationSchema>>
      readonly required?: readonly string[]
      readonly additionalProperties?: boolean
    }

type RequiredKeys<S extends Extract<IntegrationSchema, { type: 'object' }>> =
  S['required'] extends readonly string[] ? S['required'][number] & keyof S['properties'] : never

export type InferIntegrationSchema<S extends IntegrationSchema> =
  S extends { oneOf: readonly (infer O extends IntegrationSchema)[] }
    ? InferIntegrationSchema<O>
    : S extends { type: 'string'; enum: readonly (infer V extends string)[] }
    ? V
    : S extends { type: 'string' }
      ? string
      : S extends { type: 'number' }
        ? number
        : S extends { type: 'boolean' }
          ? boolean
          : S extends { type: 'null' }
            ? null
            : S extends { type: 'array'; items: infer I extends IntegrationSchema }
              ? InferIntegrationSchema<I>[]
              : S extends {
                    type: 'object'
                    properties: infer P extends Record<string, IntegrationSchema>
                    required?: readonly string[]
                  }
                ? { [K in RequiredKeys<S>]: InferIntegrationSchema<P[K]> } & {
                    [K in Exclude<keyof P, RequiredKeys<S>>]?: InferIntegrationSchema<P[K]>
                  } & (S extends { additionalProperties: true } ? Record<string, unknown> : unknown)
                : never

const stringSchema = { type: 'string' } as const
const numberSchema = { type: 'number' } as const
const nonNegativeNumberSchema = { type: 'number', minimum: 0 } as const
const booleanSchema = { type: 'boolean' } as const
const nullSchema = { type: 'null' } as const
const nullableNonNegativeNumberSchema = { oneOf: [nonNegativeNumberSchema, nullSchema] } as const
const jsonRecordSchema = { type: 'object', properties: {}, additionalProperties: true } as const

const evidenceSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    description: stringSchema,
    data: jsonRecordSchema
  },
  additionalProperties: false
} as const

const diagnosticSchema = {
  type: 'object',
  properties: {
    code: stringSchema,
    severity: { type: 'string', enum: ['info', 'warning', 'error'] },
    message: stringSchema,
    details: jsonRecordSchema
  },
  required: ['code', 'severity', 'message'],
  additionalProperties: false
} as const

const recipeSchema = {
  type: 'object',
  properties: {
    executable: stringSchema,
    args: { type: 'array', items: stringSchema },
    env: jsonRecordSchema,
    cwd: stringSchema,
    preconditions: { type: 'array', items: stringSchema }
  },
  required: ['executable', 'args', 'env', 'preconditions'],
  additionalProperties: false
} as const

const usageValuesSchema = {
  type: 'object',
  properties: {
    inputTotal: numberSchema,
    outputTotal: numberSchema,
    total: numberSchema,
    cacheReadInput: numberSchema,
    cacheWriteInput: numberSchema,
    reasoningOutput: numberSchema
  },
  additionalProperties: false
} as const

/** The sole schema registry for payloads entering or leaving external Packs. */
export const CAPABILITY_PAYLOAD_SCHEMAS = {
  identify: {
    request: {
      type: 'object',
      properties: {
        machineId: stringSchema,
        candidateLocators: { type: 'array', items: stringSchema },
        environment: jsonRecordSchema
      },
      required: ['machineId', 'candidateLocators'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        installations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              harnessId: stringSchema,
              executableLocator: stringSchema,
              configNamespace: stringSchema,
              dataNamespace: stringSchema,
              presence: { type: 'string', enum: ['present', 'absent', 'unknown'] },
              executableIdentity: jsonRecordSchema,
              version: stringSchema,
              evidence: { type: 'array', items: evidenceSchema }
            },
            required: ['harnessId', 'configNamespace', 'dataNamespace', 'presence', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['installations'],
      additionalProperties: false
    }
  },
  launch: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        workingDirectory: stringSchema,
        nativeSessionId: stringSchema,
        inputs: jsonRecordSchema
      },
      required: ['installationId', 'workingDirectory', 'inputs'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: { recipe: recipeSchema, support: jsonRecordSchema },
      required: ['recipe', 'support'],
      additionalProperties: false
    }
  },
  resume: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        sessionHandle: jsonRecordSchema,
        workingDirectory: stringSchema
      },
      required: ['installationId', 'sessionHandle'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        support: { type: 'string', enum: ['supported', 'unsupported', 'unknown'] },
        recipe: recipeSchema,
        reason: stringSchema
      },
      required: ['support'],
      additionalProperties: false
    }
  },
  wake: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        sessionHandle: jsonRecordSchema,
        input: stringSchema,
        expectedProcessIdentity: jsonRecordSchema
      },
      required: ['installationId', 'sessionHandle', 'input'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        support: { type: 'string', enum: ['supported', 'unsupported', 'unknown'] },
        effect: jsonRecordSchema,
        limits: jsonRecordSchema,
        reason: stringSchema
      },
      required: ['support'],
      additionalProperties: false
    }
  },
  events: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        source: jsonRecordSchema,
        cursor: jsonRecordSchema,
        maxRecords: { type: 'number', integer: true, minimum: 1 }
      },
      required: ['installationId', 'source', 'maxRecords'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        events: { type: 'array', items: jsonRecordSchema },
        nextCursor: jsonRecordSchema,
        exhausted: booleanSchema
      },
      required: ['events', 'exhausted'],
      additionalProperties: false
    }
  },
  sessions: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        source: jsonRecordSchema,
        cursor: jsonRecordSchema,
        maxRecords: { type: 'number', integer: true, minimum: 1 }
      },
      required: ['installationId', 'source', 'maxRecords'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        sessions: { type: 'array', items: jsonRecordSchema },
        handles: { type: 'array', items: jsonRecordSchema },
        attachments: { type: 'array', items: jsonRecordSchema },
        nextCursor: jsonRecordSchema,
        exhausted: booleanSchema
      },
      required: ['sessions', 'handles', 'attachments', 'exhausted'],
      additionalProperties: false
    }
  },
  usage: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        source: jsonRecordSchema,
        cursor: jsonRecordSchema,
        maxRecords: { type: 'number', integer: true, minimum: 1 }
      },
      required: ['installationId', 'source', 'maxRecords'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        readings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sourceRecordKey: stringSchema,
              sourceRecordRevision: stringSchema,
              sessionNativeId: stringSchema,
              measurementKey: stringSchema,
              mode: { type: 'string', enum: ['delta', 'cumulative'] },
              counterScope: stringSchema,
              counterEpoch: stringSchema,
              values: usageValuesSchema,
              timeCoverage: jsonRecordSchema,
              attribution: jsonRecordSchema,
              sourceEvidence: jsonRecordSchema
            },
            required: ['sourceRecordKey', 'measurementKey', 'mode', 'values', 'timeCoverage', 'sourceEvidence'],
            additionalProperties: false
          }
        },
        nextCursor: jsonRecordSchema,
        exhausted: booleanSchema
      },
      required: ['readings', 'exhausted'],
      additionalProperties: false
    }
  },
  bindings: {
    request: {
      type: 'object',
      properties: { installationId: stringSchema, configSnapshot: jsonRecordSchema },
      required: ['installationId', 'configSnapshot'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        credentials: { type: 'array', items: jsonRecordSchema },
        connections: { type: 'array', items: jsonRecordSchema },
        bindings: { type: 'array', items: jsonRecordSchema }
      },
      required: ['credentials', 'connections', 'bindings'],
      additionalProperties: false
    }
  },
  maintenance: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        action: stringSchema,
        target: jsonRecordSchema,
        dryRun: booleanSchema
      },
      required: ['installationId', 'action', 'target', 'dryRun'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        applicable: booleanSchema,
        effects: { type: 'array', items: jsonRecordSchema },
        evidence: { type: 'array', items: evidenceSchema }
      },
      required: ['applicable', 'effects', 'evidence'],
      additionalProperties: false
    }
  },
  auth: {
    request: {
      type: 'object',
      properties: {
        offeringId: stringSchema,
        action: { type: 'string', enum: ['discover', 'login', 'refresh', 'revoke'] },
        credentialRef: stringSchema,
        expectedMaterialRevision: { type: 'number', integer: true, minimum: 0 },
        input: jsonRecordSchema
      },
      required: ['offeringId', 'action', 'input'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['complete', 'needs-input', 'effect-required', 'failed', 'unknown'] },
        credentialChange: jsonRecordSchema,
        requiredInput: jsonRecordSchema,
        effect: jsonRecordSchema,
        identityClaims: { type: 'array', items: jsonRecordSchema }
      },
      required: ['state'],
      additionalProperties: false
    }
  },
  quota: {
    request: {
      type: 'object',
      properties: {
        connectionId: stringSchema,
        credentialMaterial: jsonRecordSchema,
        requestedAt: numberSchema
      },
      required: ['connectionId', 'credentialMaterial', 'requestedAt'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        providerMeasuredAt: numberSchema,
        identityClaims: { type: 'array', items: jsonRecordSchema },
        planClaims: { type: 'array', items: jsonRecordSchema },
        meters: { type: 'array', items: jsonRecordSchema },
        entitlements: { type: 'array', items: jsonRecordSchema },
        status: { type: 'string', enum: ['success', 'partial', 'failure'] }
      },
      required: ['identityClaims', 'planClaims', 'meters', 'entitlements', 'status'],
      additionalProperties: false
    }
  }
} as const satisfies Record<string, { request: IntegrationSchema; response: IntegrationSchema }>

export type IntegrationCapability = keyof typeof CAPABILITY_PAYLOAD_SCHEMAS
export type CapabilityRequestPayload<C extends IntegrationCapability> =
  InferIntegrationSchema<(typeof CAPABILITY_PAYLOAD_SCHEMAS)[C]['request']>
export type CapabilityResponsePayload<C extends IntegrationCapability> =
  InferIntegrationSchema<(typeof CAPABILITY_PAYLOAD_SCHEMAS)[C]['response']>

const packSourceSchema = {
  type: 'object',
  properties: {
    sourceKey: stringSchema,
    kind: { type: 'string', enum: ['file', 'database', 'hook-stream', 'provider-api', 'other'] },
    locator: jsonRecordSchema,
    generation: stringSchema,
    identityEvidence: jsonRecordSchema
  },
  required: ['sourceKey', 'kind', 'locator', 'generation', 'identityEvidence'],
  additionalProperties: false
} as const

const attributionHintSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    providerId: stringSchema,
    offeringId: stringSchema,
    connectionId: stringSchema,
    requestedModel: jsonRecordSchema,
    servedModel: jsonRecordSchema,
    basis: { type: 'string', enum: ['reported', 'configured-at-time', 'correlated'] },
    confidence: { type: 'string', enum: ['verified', 'observed', 'inferred', 'unknown'] },
    evidence: { type: 'array', items: evidenceSchema }
  },
  required: ['sourceRecordKey', 'basis', 'confidence', 'evidence'],
  additionalProperties: false
} as const

const packSessionSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    harnessId: stringSchema,
    originMachineId: stringSchema,
    namespace: stringSchema,
    nativeSessionKey: stringSchema,
    parentNativeSessionKey: stringSchema,
    title: stringSchema,
    firstObservedAt: numberSchema,
    lastObservedAt: numberSchema,
    metadata: jsonRecordSchema
  },
  required: [
    'sourceRecordKey',
    'harnessId',
    'namespace',
    'nativeSessionKey',
    'firstObservedAt',
    'lastObservedAt',
    'metadata'
  ],
  additionalProperties: false
} as const

const packSessionHandleSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    sessionNativeKey: stringSchema,
    installationId: stringSchema,
    nativeId: stringSchema,
    locator: jsonRecordSchema,
    resumeSupport: { type: 'string', enum: ['supported', 'unsupported', 'unknown'] },
    observedAt: numberSchema,
    evidence: { type: 'array', items: evidenceSchema }
  },
  required: [
    'sourceRecordKey',
    'sessionNativeKey',
    'nativeId',
    'resumeSupport',
    'observedAt',
    'evidence'
  ],
  additionalProperties: false
} as const

const packSessionAttachmentSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    sessionNativeKey: stringSchema,
    installationId: stringSchema,
    machineId: stringSchema,
    processIdentity: jsonRecordSchema,
    executionId: stringSchema,
    observedFrom: numberSchema,
    observedUntil: numberSchema,
    evidence: { type: 'array', items: evidenceSchema }
  },
  required: ['sourceRecordKey', 'sessionNativeKey', 'machineId', 'observedFrom', 'evidence'],
  additionalProperties: false
} as const

const packSessionEventSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    sessionNativeKey: stringSchema,
    attachmentSourceRecordKey: stringSchema,
    kind: {
      type: 'string',
      enum: [
        'session-start',
        'session-end',
        'turn-start',
        'turn-complete',
        'turn-cancelled',
        'needs-input',
        'idle',
        'error',
        'other'
      ]
    },
    nativeKind: stringSchema,
    nativeTurnId: stringSchema,
    occurredAt: numberSchema,
    observedAt: numberSchema,
    origin: stringSchema,
    payload: jsonRecordSchema,
    evidence: { type: 'array', items: evidenceSchema }
  },
  required: ['sourceRecordKey', 'kind', 'nativeKind', 'observedAt', 'origin', 'payload', 'evidence'],
  additionalProperties: false
} as const

const usageTimeSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['point'] },
        at: numberSchema,
        basis: stringSchema,
        nativeTimestamp: stringSchema,
        nativeUtcOffsetMinutes: numberSchema,
        precision: stringSchema
      },
      required: ['kind', 'at', 'basis'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['interval'] },
        startExclusive: numberSchema,
        endInclusive: numberSchema,
        basis: stringSchema,
        precision: stringSchema
      },
      required: ['kind', 'startExclusive', 'endInclusive', 'basis'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['unknown'] }, reason: stringSchema },
      required: ['kind', 'reason'],
      additionalProperties: false
    }
  ]
} as const

const packUsageValuesSchema = {
  type: 'object',
  properties: {
    inputTotal: nullableNonNegativeNumberSchema,
    outputTotal: nullableNonNegativeNumberSchema,
    total: nullableNonNegativeNumberSchema,
    cacheReadInput: nullableNonNegativeNumberSchema,
    cacheWriteInput: nullableNonNegativeNumberSchema,
    reasoningOutput: nullableNonNegativeNumberSchema
  },
  required: [
    'inputTotal',
    'outputTotal',
    'total',
    'cacheReadInput',
    'cacheWriteInput',
    'reasoningOutput'
  ],
  additionalProperties: false
} as const

const packUsageReadingSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    sourceRecordRevision: stringSchema,
    sessionNativeKey: stringSchema,
    measurementKey: stringSchema,
    mode: { type: 'string', enum: ['delta', 'cumulative'] },
    counterScope: stringSchema,
    counterEpoch: stringSchema,
    /** What the collector knows about the relation between this epoch and the
     *  counter's previous epoch. Absent means the collector has no basis, which
     *  the ledger must not read as "this is the first epoch". */
    counterEpochRelation: { type: 'string', enum: ['first', 'disjoint', 'unknown'] },
    /** Required evidence when counterEpochRelation is 'disjoint' — a declared
     *  reset/rotate must be attributable, never inferred from a value drop. */
    counterEpochEvidence: { type: 'array', items: evidenceSchema },
    values: packUsageValuesSchema,
    semantics: {
      type: 'object',
      properties: {
        unit: { type: 'string', enum: ['tokens'] },
        componentRelations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: stringSchema,
              relation: { type: 'string', enum: ['includes', 'excludes', 'overlaps', 'unknown'] },
              other: stringSchema
            },
            required: ['component', 'relation', 'other'],
            additionalProperties: false
          }
        },
        reportedTotal: nullableNonNegativeNumberSchema,
        calculatedTotal: nullableNonNegativeNumberSchema,
        totalMismatch: booleanSchema,
        completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
        nativeFields: jsonRecordSchema
      },
      required: ['unit', 'componentRelations', 'completeness', 'nativeFields'],
      additionalProperties: false
    },
    timeCoverage: usageTimeSchema,
    /** How this record's tokens overlap another accounted stream. The ledger
     *  stores the declared relation instead of assuming every reading is direct,
     *  so a parent/child or mirrored stream cannot inflate confirmed totals. */
    overlap: {
      type: 'object',
      properties: {
        relation: {
          type: 'string',
          enum: ['direct', 'includes', 'included-by', 'overlaps', 'unknown']
        },
        scope: { type: 'string', enum: ['request', 'session', 'counter', 'other'] },
        scopeKey: stringSchema,
        counterpartSourceRecordKey: stringSchema,
        reason: stringSchema,
        evidence: { type: 'array', items: evidenceSchema }
      },
      required: ['relation', 'evidence'],
      additionalProperties: false
    },
    sourceEvidence: jsonRecordSchema
  },
  required: [
    'sourceRecordKey',
    'measurementKey',
    'mode',
    'values',
    'semantics',
    'timeCoverage',
    'sourceEvidence'
  ],
  additionalProperties: false
} as const

const quotaMeterSchema = {
  type: 'object',
  properties: {
    key: stringSchema,
    label: stringSchema,
    resource: stringSchema,
    scope: stringSchema,
    sharedPoolKey: stringSchema,
    unit: stringSchema,
    used: nullableNonNegativeNumberSchema,
    limit: nullableNonNegativeNumberSchema,
    remaining: nullableNonNegativeNumberSchema,
    utilization: nullableNonNegativeNumberSchema,
    period: jsonRecordSchema,
    availability: { type: 'string', enum: ['known', 'unknown', 'unlimited'] }
  },
  required: ['key', 'label', 'resource', 'scope', 'unit', 'availability'],
  additionalProperties: false
} as const

const packQuotaReadingSchema = {
  type: 'object',
  properties: {
    sourceRecordKey: stringSchema,
    connectionId: stringSchema,
    observedAt: numberSchema,
    providerMeasuredAt: numberSchema,
    identityClaims: { type: 'array', items: jsonRecordSchema },
    planClaims: { type: 'array', items: jsonRecordSchema },
    meters: { type: 'array', items: quotaMeterSchema },
    entitlements: { type: 'array', items: jsonRecordSchema },
    status: { type: 'string', enum: ['success', 'partial', 'failure'] },
    sourceEvidence: jsonRecordSchema
  },
  required: [
    'sourceRecordKey',
    'connectionId',
    'observedAt',
    'identityClaims',
    'planClaims',
    'meters',
    'entitlements',
    'status',
    'sourceEvidence'
  ],
  additionalProperties: false
} as const

const packCoverageSchema = {
  type: 'object',
  properties: {
    completeness: { type: 'string', enum: ['complete', 'partial', 'gap', 'unknown'] },
    interval: {
      type: 'object',
      properties: { start: numberSchema, end: numberSchema },
      required: ['start', 'end'],
      additionalProperties: false
    },
    gapReason: stringSchema,
    watermark: stringSchema
  },
  required: ['completeness'],
  additionalProperties: false
} as const

/**
 * Generic discovery/collection schemas shared by events, sessions, usage and
 * quota implementations. Capability-specific payloads above remain available
 * for imperative capabilities. This object is the complete Pack wire authority.
 */
export const PACK_BOUNDARY_SCHEMAS = {
  capabilities: CAPABILITY_PAYLOAD_SCHEMAS,
  sourceDiscovery: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        configNamespace: stringSchema,
        dataNamespace: stringSchema,
        capability: stringSchema
      },
      required: ['installationId', 'configNamespace', 'dataNamespace', 'capability'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: { sources: { type: 'array', items: packSourceSchema } },
      required: ['sources'],
      additionalProperties: false
    }
  },
  collection: {
    request: {
      type: 'object',
      properties: {
        installationId: stringSchema,
        source: packSourceSchema,
        cursor: jsonRecordSchema,
        maxRecords: { type: 'number', integer: true, minimum: 1 },
        maxBytes: { type: 'number', integer: true, minimum: 1 },
        deadlineAt: numberSchema
      },
      required: ['installationId', 'source', 'maxRecords', 'maxBytes', 'deadlineAt'],
      additionalProperties: false
    },
    response: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sourceRecordKey: stringSchema,
              sourceRecordRevision: stringSchema,
              occurredAt: numberSchema,
              factType: stringSchema,
              payloadSchema: stringSchema,
              payload: jsonRecordSchema,
              evidence: { type: 'array', items: evidenceSchema }
            },
            required: ['sourceRecordKey', 'factType', 'payloadSchema', 'payload', 'evidence'],
            additionalProperties: false
          }
        },
        sessions: { type: 'array', items: packSessionSchema },
        handles: { type: 'array', items: packSessionHandleSchema },
        attachments: { type: 'array', items: packSessionAttachmentSchema },
        events: { type: 'array', items: packSessionEventSchema },
        usageReadings: { type: 'array', items: packUsageReadingSchema },
        usageAttributionHints: { type: 'array', items: attributionHintSchema },
        quotaReadings: { type: 'array', items: packQuotaReadingSchema },
        nextCursor: jsonRecordSchema,
        exhausted: booleanSchema,
        coverage: packCoverageSchema,
        diagnostics: { type: 'array', items: diagnosticSchema }
      },
      required: [
        'observations',
        'sessions',
        'handles',
        'attachments',
        'events',
        'usageReadings',
        'usageAttributionHints',
        'quotaReadings',
        'exhausted',
        'coverage',
        'diagnostics'
      ],
      additionalProperties: false
    }
  }
} as const

export type PackSourceDiscoveryRequest =
  InferIntegrationSchema<typeof PACK_BOUNDARY_SCHEMAS.sourceDiscovery.request>
export type PackSourceDiscoveryResult =
  InferIntegrationSchema<typeof PACK_BOUNDARY_SCHEMAS.sourceDiscovery.response>
export type PackCollectionRequest = InferIntegrationSchema<typeof PACK_BOUNDARY_SCHEMAS.collection.request>
export type PackCollectionResult = InferIntegrationSchema<typeof PACK_BOUNDARY_SCHEMAS.collection.response>
export type PackSessionObservation = PackCollectionResult['sessions'][number]
export type PackSessionHandleObservation = PackCollectionResult['handles'][number]
export type PackSessionAttachmentObservation = PackCollectionResult['attachments'][number]
export type PackSessionEventObservation = PackCollectionResult['events'][number]
export type PackUsageReadingObservation = PackCollectionResult['usageReadings'][number]
export type PackUsageOverlapDeclaration = NonNullable<PackUsageReadingObservation['overlap']>
export type PackUsageCounterEpochRelation = NonNullable<
  PackUsageReadingObservation['counterEpochRelation']
>
export type PackUsageAttributionHint = PackCollectionResult['usageAttributionHints'][number]
export type PackQuotaReadingObservation = PackCollectionResult['quotaReadings'][number]

export interface SchemaValidationIssue {
  path: string
  code: 'type' | 'required' | 'unknown-field' | 'enum' | 'minimum' | 'integer' | 'semantic'
  message: string
}

/** Small validator used by both registry conformance and runtime envelopes. */
export function validateIntegrationSchema(
  schema: IntegrationSchema,
  value: unknown,
  path = '$'
): SchemaValidationIssue[] {
  if ('oneOf' in schema) {
    const results = schema.oneOf.map((candidate) => validateIntegrationSchema(candidate, value, path))
    return results.some((candidate) => candidate.length === 0)
      ? []
      : results[0] ?? [{ path, code: 'type', message: 'value does not match any allowed schema' }]
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [{ path, code: 'type', message: 'expected string' }]
    if (schema.enum && !schema.enum.includes(value)) return [{ path, code: 'enum', message: 'unexpected enum value' }]
    return []
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [{ path, code: 'type', message: 'expected finite number' }]
    if (schema.integer && !Number.isInteger(value)) return [{ path, code: 'integer', message: 'expected integer' }]
    if (schema.minimum !== undefined && value < schema.minimum) return [{ path, code: 'minimum', message: `expected >= ${schema.minimum}` }]
    return []
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [{ path, code: 'type', message: 'expected boolean' }]
  if (schema.type === 'null') return value === null ? [] : [{ path, code: 'type', message: 'expected null' }]
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [{ path, code: 'type', message: 'expected array' }]
    return value.flatMap((item, index) => validateIntegrationSchema(schema.items, item, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path, code: 'type', message: 'expected object' }]
  }
  const record = value as Record<string, unknown>
  const issues: SchemaValidationIssue[] = []
  for (const key of schema.required ?? []) {
    if (!(key in record)) issues.push({ path: `${path}.${key}`, code: 'required', message: 'required field is missing' })
  }
  for (const [key, item] of Object.entries(record)) {
    const property = schema.properties[key]
    if (property) issues.push(...validateIntegrationSchema(property, item, `${path}.${key}`))
    else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, code: 'unknown-field', message: 'unknown field' })
  }
  return issues
}

export function validateCapabilityPayload<C extends IntegrationCapability>(
  capability: C,
  direction: 'request' | 'response',
  value: unknown
): SchemaValidationIssue[] {
  return validateIntegrationSchema(CAPABILITY_PAYLOAD_SCHEMAS[capability][direction], value)
}

export type PackBoundaryKind = 'sourceDiscovery' | 'collection'

export function validatePackBoundaryPayload(
  boundary: PackBoundaryKind,
  direction: 'request' | 'response',
  value: unknown
): SchemaValidationIssue[] {
  const schema = PACK_BOUNDARY_SCHEMAS[boundary][direction]
  const issues = validateIntegrationSchema(schema, value)
  if (boundary !== 'collection' || direction !== 'response' || typeof value !== 'object' || value === null) {
    return issues
  }
  const readings = (value as { usageReadings?: unknown }).usageReadings
  if (!Array.isArray(readings)) return issues
  readings.forEach((reading, index) => {
    if (typeof reading !== 'object' || reading === null) return
    const record = reading as {
      mode?: unknown
      counterScope?: unknown
      counterEpoch?: unknown
      counterEpochRelation?: unknown
      counterEpochEvidence?: unknown
      timeCoverage?: unknown
      overlap?: unknown
    }
    const evidenceCount = (candidate: unknown): number =>
      Array.isArray(candidate) ? candidate.length : 0
    const time = record.timeCoverage
    if (typeof time === 'object' && time !== null) {
      const interval = time as { kind?: unknown; startExclusive?: unknown; endInclusive?: unknown }
      if (
        interval.kind === 'interval' &&
        typeof interval.startExclusive === 'number' &&
        typeof interval.endInclusive === 'number' &&
        interval.endInclusive <= interval.startExclusive
      ) {
        issues.push({
          path: `$.usageReadings[${index}].timeCoverage.endInclusive`,
          code: 'semantic',
          message: 'interval endInclusive must be greater than startExclusive'
        })
      }
    }
    // A cumulative counter is meaningless without the scope/epoch it belongs to:
    // the ledger keys checkpoints by them, so a missing pair cannot be repaired later.
    if (record.mode === 'cumulative') {
      for (const field of ['counterScope', 'counterEpoch'] as const) {
        const candidate = record[field]
        if (typeof candidate !== 'string' || candidate.length === 0) {
          issues.push({
            path: `$.usageReadings[${index}].${field}`,
            code: 'semantic',
            message: `cumulative reading requires ${field}`
          })
        }
      }
    }
    // A declared disjoint epoch is a reset claim: without evidence the ledger must
    // keep the reading unresolved instead of restarting a counter on assertion alone.
    if (record.counterEpochRelation === 'disjoint' && evidenceCount(record.counterEpochEvidence) === 0) {
      issues.push({
        path: `$.usageReadings[${index}].counterEpochEvidence`,
        code: 'semantic',
        message: 'counterEpochRelation disjoint requires counterEpochEvidence'
      })
    }
    if (typeof record.overlap === 'object' && record.overlap !== null) {
      const overlap = record.overlap as { relation?: unknown; evidence?: unknown }
      if (overlap.relation !== undefined && overlap.relation !== 'direct' &&
          evidenceCount(overlap.evidence) === 0) {
        issues.push({
          path: `$.usageReadings[${index}].overlap.evidence`,
          code: 'semantic',
          message: 'a non-direct overlap relation requires evidence'
        })
      }
    }
  })
  // A batch that is not exhausted must hand the collector a resume position;
  // otherwise the next tick re-reads the same place and never advances.
  if ((value as { exhausted?: unknown }).exhausted === false) {
    const nextCursor = (value as { nextCursor?: unknown }).nextCursor
    if (typeof nextCursor !== 'object' || nextCursor === null) {
      issues.push({
        path: '$.nextCursor',
        code: 'semantic',
        message: 'exhausted=false requires nextCursor so collection can resume'
      })
    }
  }
  return issues
}

const emptyCollectionResult = {
  observations: [],
  sessions: [],
  handles: [],
  attachments: [],
  events: [],
  usageReadings: [],
  usageAttributionHints: [],
  quotaReadings: [],
  exhausted: true,
  coverage: { completeness: 'complete' },
  diagnostics: []
} as const

const validUsageReadingFixture = {
  sourceRecordKey: 'record-1',
  measurementKey: 'request-1',
  mode: 'delta',
  values: {
    inputTotal: 1,
    outputTotal: 1,
    total: 2,
    cacheReadInput: null,
    cacheWriteInput: null,
    reasoningOutput: null
  },
  semantics: {
    unit: 'tokens',
    componentRelations: [],
    completeness: 'complete',
    nativeFields: {}
  },
  timeCoverage: { kind: 'point', at: 1, basis: 'request-complete' },
  sourceEvidence: {}
} as const

/** Conformance fixtures that every runner can apply to the same schema authority. */
export const PACK_BOUNDARY_NEGATIVE_CASES = [
  {
    name: 'reject-string-token-count',
    value: {
      ...emptyCollectionResult,
      usageReadings: [
        { ...validUsageReadingFixture, values: { ...validUsageReadingFixture.values, inputTotal: '1' } }
      ]
    },
    expectedCode: 'type',
    expectedPath: '$.usageReadings[0].values.inputTotal'
  },
  {
    name: 'reject-negative-token-count',
    value: {
      ...emptyCollectionResult,
      usageReadings: [
        { ...validUsageReadingFixture, values: { ...validUsageReadingFixture.values, total: -1 } }
      ]
    },
    expectedCode: 'minimum',
    expectedPath: '$.usageReadings[0].values.total'
  },
  {
    name: 'reject-reversed-time-interval',
    value: {
      ...emptyCollectionResult,
      usageReadings: [
        {
          ...validUsageReadingFixture,
          timeCoverage: { kind: 'interval', startExclusive: 10, endInclusive: 5, basis: 'counter-delta' }
        }
      ]
    },
    expectedCode: 'semantic',
    expectedPath: '$.usageReadings[0].timeCoverage.endInclusive'
  },
  {
    name: 'reject-session-without-native-identity',
    value: {
      ...emptyCollectionResult,
      sessions: [
        {
          sourceRecordKey: 'session-1',
          harnessId: 'harness-1',
          namespace: 'default',
          firstObservedAt: 1,
          lastObservedAt: 1,
          metadata: {}
        }
      ]
    },
    expectedCode: 'required',
    expectedPath: '$.sessions[0].nativeSessionKey'
  },
  {
    name: 'reject-cumulative-without-counter-identity',
    value: {
      ...emptyCollectionResult,
      usageReadings: [{ ...validUsageReadingFixture, mode: 'cumulative' }]
    },
    expectedCode: 'semantic',
    expectedPath: '$.usageReadings[0].counterScope'
  },
  {
    name: 'reject-disjoint-epoch-without-evidence',
    value: {
      ...emptyCollectionResult,
      usageReadings: [
        {
          ...validUsageReadingFixture,
          mode: 'cumulative',
          counterScope: 'account',
          counterEpoch: 'epoch-2',
          counterEpochRelation: 'disjoint'
        }
      ]
    },
    expectedCode: 'semantic',
    expectedPath: '$.usageReadings[0].counterEpochEvidence'
  },
  {
    name: 'reject-overlap-relation-without-evidence',
    value: {
      ...emptyCollectionResult,
      usageReadings: [
        { ...validUsageReadingFixture, overlap: { relation: 'included-by', evidence: [] } }
      ]
    },
    expectedCode: 'semantic',
    expectedPath: '$.usageReadings[0].overlap.evidence'
  },
  {
    name: 'reject-unexhausted-batch-without-next-cursor',
    value: { ...emptyCollectionResult, exhausted: false },
    expectedCode: 'semantic',
    expectedPath: '$.nextCursor'
  }
] as const
