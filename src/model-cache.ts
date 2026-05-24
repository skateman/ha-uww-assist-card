/**
 * Browser-cached wake-word fetcher.
 *
 * Uses the standard Cache Storage API (available outside service
 * workers in all modern browsers). The cache key is the **full URL**
 * — including any `?v=...` query string — so versioned model URLs
 * are perfectly handled: bumping `?v=2` causes a fresh fetch while
 * the old entry stays around (and gets evicted by quota pressure).
 *
 * We cache both the manifest JSON and the .tflite bytes. uww.js
 * accepts `{ manifest, modelData: ArrayBuffer }` directly, so we can
 * skip its own fetch path entirely and avoid double network hits.
 *
 * Cache failures (private mode, quota exceeded, opaque-origin CORS
 * blocks) are non-fatal — we always fall back to a plain network
 * fetch.
 */

import { validateManifest, type WakeWordManifest } from 'uww.js';

const CACHE_NAME = 'uww-assist-card-models-v1';

export interface CachedManifest {
  manifest: WakeWordManifest;
  modelData: ArrayBuffer;
  /** True if both manifest and model came from the local cache. */
  fromCache: boolean;
}

/**
 * Fetch (or read-from-cache) a microWakeWord manifest + its model.
 *
 * @param manifestUrl Full manifest URL, including any version query.
 *                    The model URL inside the manifest is resolved
 *                    relative to this URL, and inherits the query
 *                    string if the model path is relative — that way
 *                    bumping `?v=` invalidates BOTH manifest and model
 *                    even though only one URL is provided.
 */
export async function loadManifestAndModel(
  manifestUrl: string,
): Promise<CachedManifest> {
  const cache = await openCacheSafe();

  const { json: rawManifest, fromCache: manifestFromCache } = await fetchJson(
    cache,
    manifestUrl,
  );
  const manifest = validateManifest(rawManifest);

  // Resolve the model URL relative to the manifest URL — and preserve
  // the manifest's query string if the model path was relative. So
  // `…/hey_jarvis.json?v=2` + `model: "hey_jarvis.tflite"` → `…/hey_jarvis.tflite?v=2`,
  // tying their cache lifetimes together via a single version bump.
  const modelUrl = resolveModelUrl(manifest.model, manifestUrl);

  const { bytes: modelData, fromCache: modelFromCache } = await fetchBytes(
    cache,
    modelUrl,
  );

  return {
    manifest,
    modelData,
    fromCache: manifestFromCache && modelFromCache,
  };
}

/**
 * Fetch (or read-from-cache) a bare .tflite model URL (no manifest).
 */
export async function loadModel(
  modelUrl: string,
): Promise<{ modelData: ArrayBuffer; fromCache: boolean }> {
  const cache = await openCacheSafe();
  const { bytes, fromCache } = await fetchBytes(cache, modelUrl);
  return { modelData: bytes, fromCache };
}

// ── internals ─────────────────────────────────────────────────────────

async function openCacheSafe(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function fetchJson(
  cache: Cache | null,
  url: string,
): Promise<{ json: unknown; fromCache: boolean }> {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      try {
        return { json: await hit.json(), fromCache: true };
      } catch {
        // Corrupt cache entry — fall through and re-fetch.
      }
    }
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `uww-assist-card: failed to fetch ${url} (HTTP ${res.status})`,
    );
  }
  // Clone before reading; the body stream can only be consumed once.
  await tryCachePut(cache, url, res.clone());
  return { json: await res.json(), fromCache: false };
}

async function fetchBytes(
  cache: Cache | null,
  url: string,
): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      try {
        return { bytes: await hit.arrayBuffer(), fromCache: true };
      } catch {
        // fall through
      }
    }
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `uww-assist-card: failed to fetch ${url} (HTTP ${res.status})`,
    );
  }
  await tryCachePut(cache, url, res.clone());
  return { bytes: await res.arrayBuffer(), fromCache: false };
}

async function tryCachePut(
  cache: Cache | null,
  url: string,
  response: Response,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(url, response);
  } catch (err) {
    // QuotaExceeded, opaque responses, etc. Cache is a best-effort
    // optimization — log and keep going.
    // eslint-disable-next-line no-console
    console.warn(`uww-assist-card: cache.put failed for ${url}`, err);
  }
}

function resolveModelUrl(modelPath: string, manifestUrl: string): string {
  const resolved = new URL(modelPath, manifestUrl);
  // If the resolved model URL has no query string but the manifest URL
  // did, inherit it. This lets a single `?v=N` bump on the manifest URL
  // invalidate both manifest and model cache entries in one step.
  if (!resolved.search) {
    const manifestSearch = new URL(manifestUrl).search;
    if (manifestSearch) resolved.search = manifestSearch;
  }
  return resolved.href;
}
