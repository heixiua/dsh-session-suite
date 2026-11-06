/**
 * Optional dense embeddings for memory reranking.
 *
 * Design constraints, in the order they shaped this file:
 *
 * 1. **Never download anything implicitly.** A memory plugin that silently pulls
 *    several hundred megabytes onto someone's disk is not acceptable; the model
 *    is installed deliberately, and this module only loads what is already there.
 * 2. **Never break recall.** Embedding is an optimisation. Any failure — no model,
 *    unreadable file, out-of-memory, a provider that changed shape — must degrade
 *    to "no reranking", never to an exception on the recall path.
 * 3. **The model is swappable.** Two providers are supported without changing the
 *    engine: a local transformers.js pipeline, and any OpenAI-compatible
 *    /embeddings endpoint (Zhipu, SiliconFlow, and friends). The engine only ever
 *    sees `{ vector }` or `undefined`.
 *
 * The default is the local pipeline, because recall runs on the prompt path and
 * must not depend on a network round trip: a busy or rate-limited provider would
 * turn every step into a slow one.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * A provider that never produces vectors.
 *
 * This is the default. Reranking then costs nothing and changes nothing, which
 * is the correct behaviour for a library with no model installed.
 */
export const DISABLED_PROVIDER = {
  name: 'disabled',
  available: false,
  async embed() {
    return undefined
  },
}

/**
 * A local transformers.js pipeline.
 *
 * The model directory is supplied by the caller; nothing is downloaded here. If
 * the directory or the runtime is missing, `available` stays false and the
 * provider behaves like the disabled one.
 *
 * @param {object} input provider input
 * @param {string} input.modelDir absolute directory holding the model files
 * @param {string} [input.pipeline] transformers.js pipeline name
 * @param {number} [input.batchSize] texts per inference call
 * @returns {Promise<object>} provider
 */
export async function createLocalProvider({ modelDir, pipeline = 'feature-extraction', batchSize = 16, runtime }) {
  if (typeof modelDir !== 'string' || !modelDir) return DISABLED_PROVIDER
  // Point at the model directory itself; transformers.js accepts a path and will
  // not reach the network when the files are present.
  if (!fs.existsSync(modelDir)) return DISABLED_PROVIDER

  let transformers = runtime
  if (!transformers) {
    try {
      // Resolved at runtime so a profile without the package still loads the bundle.
      transformers = await import('@xenova/transformers')
    } catch {
      try {
        transformers = await import('@huggingface/transformers')
      } catch {
        return DISABLED_PROVIDER
      }
    }
  }

  // Turn OFF remote fetching before creating the pipeline.
  //
  // Passing a directory to pipeline() is NOT enough: when any expected file is
  // missing, transformers.js silently falls back to downloading the model from
  // Hugging Face. On a network where that host is unreachable the failure surfaces
  // as `fetch failed` / CONNECT_TIMEOUT, which looks like a network problem rather
  // than a missing-file problem — and worse, on a reachable network the plugin would
  // pull hundreds of megabytes onto a user's disk without asking. allowRemoteModels
  // = false turns a missing file into a clear, immediate error instead.
  //
  // transformers.js resolves a model by joining localModelPath with the model id, so
  // localModelPath must be the PARENT directory and the id the folder name. An
  // absolute path passed as the id defeats that join and triggers the remote lookup.
  let modelId = modelDir
  try {
    if (transformers.env) {
      transformers.env.allowRemoteModels = false
      transformers.env.allowLocalModels = true
      const parent = path.dirname(modelDir)
      transformers.env.localModelPath = parent
      modelId = path.basename(modelDir)
    }
  } catch {
    /* an older runtime without env is still usable with an explicit path */
  }

  const extractor = await transformers.pipeline(pipeline, modelId)

  return {
    name: 'local',
    available: true,
    modelDir,
    /**
     * @param {string} text input
     * @returns {Promise<number[] | undefined>} embedding
     */
    async embed(text) {
      const value = String(text ?? '').trim()
      if (!value) return undefined
      try {
        const output = await extractor(value, { pooling: 'mean', normalize: true })
        // transformers.js returns a Tensor; `data` is the flat Float32Array.
        const data = output?.data ?? output?.[0]?.data ?? output
        if (!data) return undefined
        return Array.from(data, Number)
      } catch {
        return undefined
      }
    },
    /**
     * Embed many texts in one call. Falls back to per-text calls when the
     * runtime does not support batches, which is slower but still correct.
     *
     * @param {string[]} texts inputs
     * @returns {Promise<Array<number[] | undefined>>} embeddings
     */
    async embedMany(texts) {
      const list = Array.isArray(texts) ? texts : []
      if (list.length === 0) return []
      try {
        const output = await extractor(list, { pooling: 'mean', normalize: true })
        const rows = output?.tolist?.() ?? output?.data ?? undefined
        if (Array.isArray(rows) && rows.length === list.length && Array.isArray(rows[0])) {
          return rows.map(row => Array.from(row, Number))
        }
        if (rows && rows.length === list.length * (rows[0]?.length ?? 0)) {
          // Flat buffer: split into equal rows.
          const width = rows.length / list.length
          const out = []
          for (let index = 0; index < list.length; index += 1) {
            out.push(Array.from(rows.slice(index * width, (index + 1) * width), Number))
          }
          return out
        }
      } catch {
        /* fall through to per-item calls */
      }
      const out = []
      for (const text of list.slice(0, batchSize * 8)) out.push(await this.embed(text))
      return out
    },
  }
}

/**
 * An OpenAI-compatible /embeddings endpoint.
 *
 * Used when the user prefers no local files. Every failure returns undefined, so
 * a flaky endpoint degrades to lexical ranking rather than failing recall.
 *
 * @param {object} input provider input
 * @param {string} input.baseUrl endpoint base, e.g. https://api.siliconflow.cn/v1
 * @param {string} input.apiKey bearer token
 * @param {string} input.model model id
 * @param {number} [input.timeoutMs] request timeout
 * @returns {object} provider
 */
export function createRemoteProvider({ baseUrl, apiKey, model, timeoutMs = 5000 }) {
  if (typeof baseUrl !== 'string' || !baseUrl || !apiKey || !model) return DISABLED_PROVIDER
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`

  return {
    name: 'remote',
    available: true,
    model,
    /**
     * @param {string} text input
     * @returns {Promise<number[] | undefined>} embedding
     */
    async embed(text) {
      const value = String(text ?? '').trim()
      if (!value) return undefined
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: value }),
          signal: controller.signal,
        })
        if (!response.ok) return undefined
        const payload = await response.json()
        const vector = payload?.data?.[0]?.embedding
        return Array.isArray(vector) ? vector.map(Number) : undefined
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Build the provider described by plugin config, or the disabled one.
 *
 * Configuration is read defensively: a half-written block yields the disabled
 * provider rather than a crash, because this runs during plugin installation.
 *
 * @param {any} config plugin config
 * @returns {Promise<object>} provider
 */
export async function createEmbeddingProvider(config) {
  const block = config?.embedding
  if (!block || typeof block !== 'object' || block.enabled === false) return DISABLED_PROVIDER

  if (block.provider === 'remote') {
    return createRemoteProvider({
      baseUrl: block.baseUrl,
      apiKey: block.apiKey,
      model: block.model,
      timeoutMs: Number(block.timeoutMs) || 5000,
    })
  }

  const modelDir = typeof block.modelDir === 'string' && block.modelDir
    ? block.modelDir
    : path.join(config?.root ?? '', 'models', String(block.model ?? 'bge-base-zh-v1.5'))
  try {
    return await createLocalProvider({
      modelDir,
      pipeline: typeof block.pipeline === 'string' ? block.pipeline : 'feature-extraction',
    })
  } catch {
    return DISABLED_PROVIDER
  }
}
