import { resolve } from 'node:path';

export const EMBEDDING_MODEL = 'hotchpotch/bekko-embedding-v1-a8m';
const BATCH_SIZE = 16;
const RRF_K = 60;

async function loadModel() {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = resolve(process.env.DOLSOT_EMBEDDING_CACHE_DIR ?? '.dolsot/models');
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
    device: 'cpu',
    dtype: 'fp32',
  });
  return async texts => (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
}

function key(tool) {
  return `${tool.serverId}\0${tool.name}`;
}

function documentText(tool) {
  return `${tool.name}\n${tool.description}`;
}

function validateVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new TypeError('embedding model returned an invalid batch');
  }
  const dimension = vectors[0]?.length;
  if (!Number.isInteger(dimension) || dimension === 0 || vectors.some(vector =>
    !Array.isArray(vector) || vector.length !== dimension || vector.some(value => !Number.isFinite(value)))) {
    throw new TypeError('embedding model returned an invalid vector');
  }
  return vectors;
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new TypeError('embedding dimensions do not match');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }
  if (!leftNorm || !rightNorm) throw new TypeError('embedding vector has zero magnitude');
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function compareTools(left, right) {
  const leftKey = `${left.serverId}\0${left.name}`;
  const rightKey = `${right.serverId}\0${right.name}`;
  return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
}

export class EmbeddingSearch {
  constructor({ modelLoader = loadModel } = {}) {
    this.modelLoader = modelLoader;
    this.modelPromise = null;
    this.cache = new Map();
  }

  async load() {
    if (!this.modelPromise) {
      this.modelPromise = Promise.resolve().then(this.modelLoader).catch(error => {
        this.modelPromise = null;
        throw error;
      });
    }
    return this.modelPromise;
  }

  syncCatalog(tools) {
    const current = new Map(tools.map(tool => [key(tool), documentText(tool)]));
    for (const [toolKey, entry] of this.cache) {
      if (current.get(toolKey) !== entry.text) this.cache.delete(toolKey);
    }
  }

  clear() {
    this.cache.clear();
  }

  async rank(query, tools) {
    if (!tools.length) return [];
    const embed = await this.load();
    const [queryVector] = validateVectors(await embed([query]), 1);
    const missing = tools.filter(tool => {
      const entry = this.cache.get(key(tool));
      return entry?.text !== documentText(tool);
    });
    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      const batch = missing.slice(offset, offset + BATCH_SIZE);
      const vectors = validateVectors(await embed(batch.map(documentText)), batch.length);
      for (let index = 0; index < batch.length; index += 1) {
        this.cache.set(key(batch[index]), { text: documentText(batch[index]), vector: vectors[index] });
      }
    }
    return tools.map(tool => ({
      tool,
      score: cosineSimilarity(queryVector, this.cache.get(key(tool)).vector),
    })).sort((a, b) => b.score - a.score || compareTools(a.tool, b.tool));
  }
}

export function reciprocalRankFusion(bm25Results, vectorResults) {
  const fused = new Map();
  for (const results of [bm25Results, vectorResults]) {
    results.forEach(({ tool }, index) => {
      const id = key(tool);
      const entry = fused.get(id) ?? { tool, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(id, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || compareTools(a.tool, b.tool));
}
