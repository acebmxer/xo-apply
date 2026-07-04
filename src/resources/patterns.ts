/**
 * Helpers for XO "smart mode" patterns (evaluated by @vates/value-matcher).
 * Shapes verified against xo-web's pattern builders:
 * - explicit selection: `{ id: uuid }` or `{ id: { __or: [uuid, ...] } }`
 * - smart mode by tag:  `{ type: 'VM', tags: { __or: [[tag], ...] } }`
 *   (each tag is wrapped in a single-element array because VM.tags is an array)
 */

export function idPattern(ids: string[]): Record<string, unknown> {
  return ids.length === 1 ? { id: ids[0] } : { id: { __or: [...ids].sort() } }
}

export function tagsPattern(tags: string[]): Record<string, unknown> {
  return { type: 'VM', tags: { __or: tags.map(tag => [tag]) } }
}

/** Extract UUIDs from an explicit-selection pattern, or undefined if not one. */
export function extractIds(pattern: Record<string, unknown> | undefined): string[] | undefined {
  if (pattern === undefined) {
    return undefined
  }
  const keys = Object.keys(pattern)
  if (keys.length !== 1 || keys[0] !== 'id') {
    return undefined
  }
  const id = pattern.id
  if (typeof id === 'string') {
    return [id]
  }
  if (id !== null && typeof id === 'object') {
    const or = (id as Record<string, unknown>).__or
    if (Array.isArray(or) && or.every(v => typeof v === 'string') && Object.keys(id).length === 1) {
      return or as string[]
    }
  }
  return undefined
}

/**
 * Extract plain tag names from a simple smart-mode-by-tag pattern
 * (`{ type: 'VM', tags: { __or: [[tag], ...] } }`).
 * Returns undefined for anything more complex (excluded tags, pools, power
 * state...) — those round-trip through the `raw` escape hatch instead.
 */
export function extractTags(pattern: Record<string, unknown> | undefined): string[] | undefined {
  if (pattern === undefined) {
    return undefined
  }
  const keys = Object.keys(pattern).sort()
  const isTagsOnly = keys.join(',') === 'tags' || keys.join(',') === 'tags,type'
  if (!isTagsOnly || (pattern.type !== undefined && pattern.type !== 'VM')) {
    return undefined
  }
  const tags = pattern.tags
  if (tags === null || typeof tags !== 'object') {
    return undefined
  }
  const tagsObj = tags as Record<string, unknown>
  if (Object.keys(tagsObj).length !== 1 || !Array.isArray(tagsObj.__or)) {
    return undefined
  }
  const result: string[] = []
  for (const entry of tagsObj.__or) {
    if (Array.isArray(entry) && entry.length === 1 && typeof entry[0] === 'string') {
      result.push(entry[0])
    } else if (typeof entry === 'string') {
      // be tolerant of unwrapped tags (older jobs / hand-written patterns)
      result.push(entry)
    } else {
      return undefined
    }
  }
  return result
}

/**
 * Canonicalize a pattern for comparison: `{ id: x }` ≡ `{ id: { __or: [x] } }`,
 * `__or` arrays are order-insensitive, keys are sorted via stableStringify.
 */
export function canonicalizePattern(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizePattern)
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(obj)) {
      if (key === 'id' && typeof v === 'string') {
        result.id = { __or: [v] }
      } else if (key === '__or' && Array.isArray(v)) {
        result.__or = v.map(canonicalizePattern).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      } else {
        result[key] = canonicalizePattern(v)
      }
    }
    return result
  }
  return value
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function patternsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(canonicalizePattern(a)) === stableStringify(canonicalizePattern(b))
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}
