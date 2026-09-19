import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface SecretMaterialRecord {
  revision: number
  material: Record<string, unknown>
}
export interface ManagedSecretStore {
  put(input: {
    offeringId: string
    material: Record<string, unknown>
    ownership: 'mahas'
  }): Promise<{ ref: string; revision: number }>
  read(ref: string): Promise<SecretMaterialRecord | null>
  compareAndSwap(
    ref: string,
    expectedRevision: number,
    material: Record<string, unknown>
  ): Promise<{ ok: boolean; revision: number }>
  discard(ref: string): Promise<boolean>
}

const PREFIX = 'mahas-secret://provider-credentials/'

/** Mahas-owned secrets only. User CLI files remain untouched locator refs. */
export class FileManagedSecretStore implements ManagedSecretStore {
  readonly #locks = new Map<string, Promise<unknown>>()
  readonly #root: string
  constructor(root: string) {
    this.#root = root
  }

  async put(input: {
    offeringId: string
    material: Record<string, unknown>
    ownership: 'mahas'
  }): Promise<{ ref: string; revision: number }> {
    const id = randomUUID(),
      ref = `${PREFIX}${id}`
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    await this.#write(id, { revision: 1, offeringId: input.offeringId, material: input.material })
    return { ref, revision: 1 }
  }
  async read(ref: string): Promise<SecretMaterialRecord | null> {
    const id = this.#id(ref)
    try {
      const raw = JSON.parse(await readFile(join(this.#root, `${id}.json`), 'utf8')) as Record<
        string,
        unknown
      >
      if (
        !Number.isSafeInteger(raw.revision) ||
        !raw.material ||
        typeof raw.material !== 'object' ||
        Array.isArray(raw.material)
      )
        throw new Error('managed secret record is malformed')
      return { revision: raw.revision as number, material: raw.material as Record<string, unknown> }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async compareAndSwap(
    ref: string,
    expectedRevision: number,
    material: Record<string, unknown>
  ): Promise<{ ok: boolean; revision: number }> {
    const id = this.#id(ref)
    return this.#serialize(id, async () => {
      const current = await this.read(ref)
      if (!current) throw new Error('managed secret not found')
      if (current.revision !== expectedRevision) return { ok: false, revision: current.revision }
      const revision = current.revision + 1
      await this.#write(id, { revision, material })
      return { ok: true, revision }
    })
  }
  async discard(ref: string): Promise<boolean> {
    const id = this.#id(ref)
    return this.#serialize(id, async () => {
      try {
        await rm(join(this.#root, `${id}.json`))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  }
  #id(ref: string): string {
    if (!ref.startsWith(PREFIX)) throw new Error('ref is not a mahas-owned provider secret')
    const id = ref.slice(PREFIX.length)
    if (!id || basename(id) !== id || !/^[A-Za-z0-9-]+$/.test(id))
      throw new Error('invalid managed secret ref')
    return id
  }
  async #write(id: string, value: unknown): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const path = join(this.#root, `${id}.json`),
      temp = join(this.#root, `.${id}.${randomUUID()}.tmp`)
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temp, path)
  }
  async #serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(key) ?? Promise.resolve(),
      next = prior.catch(() => undefined).then(action)
    this.#locks.set(key, next)
    try {
      return await next
    } finally {
      if (this.#locks.get(key) === next) this.#locks.delete(key)
    }
  }
}

export const isManagedSecretRef = (ref: string): boolean => ref.startsWith(PREFIX)
