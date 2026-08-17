/**
 * Data processing pipeline
 * Fetches, transforms, and caches API data
 */

interface ApiResponse<T> {
  data: T
  status: number
  timestamp: number
}

interface CacheEntry<T> {
  data: T
  expiry: number
}

interface FetchDataOptions {
  skipCache?: boolean
}

const cache = new Map<string, CacheEntry<any>>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export async function fetchData<T>(endpoint: string, options?: FetchDataOptions): Promise<T> {
  // Check cache first
  if (!options?.skipCache) {
    const cached = cache.get(endpoint)
    if (cached && cached.expiry > Date.now()) {
      console.log(`[Cache] HIT: ${endpoint}`)
      return cached.data
    }
  }

  console.log(`[Fetch] ${endpoint}`)
  const response = await fetch(endpoint)

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  const json: ApiResponse<T> = await response.json()

  // Cache the result
  cache.set(endpoint, {
    data: json.data,
    expiry: Date.now() + CACHE_TTL,
  })

  return json.data
}

export function transformData<T, R>(items: T[], transformer: (item: T, index: number) => R): R[] {
  return items.map((item, index) => {
    try {
      return transformer(item, index)
    } catch (err) {
      console.error(`[Transform] Error at index ${index}:`, err)
      throw err
    }
  })
}

export function filterByDate<T extends { createdAt: string }>(items: T[], startDate: string, endDate: string): T[] {
  const start = new Date(startDate).getTime()
  const end = new Date(endDate).getTime()

  return items.filter((item) => {
    const created = new Date(item.createdAt).getTime()
    return created >= start && created <= end
  })
}

export function aggregateByField<T>(items: T[], field: keyof T): Map<string, T[]> {
  const groups = new Map<string, T[]>()

  for (const item of items) {
    const key = String(item[field])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  return groups
}

export function clearCache(): void {
  cache.clear()
}

export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: cache.size,
    entries: [...cache.keys()],
  }
}
