/**
 * Complete-linkage agglomerative clustering of speaker embeddings, ported
 * from sherpa-onnx's `FastClustering` (hclust-cpp / fastcluster by Daniel
 * Müllner, BSD): cosine dissimilarity, nearest-neighbour-chain linkage,
 * merges stably sorted by height, then an R-style `cutree`.
 *
 * Labels are 0-based in order of first appearance, matching sherpa-onnx.
 * Unlike sherpa-onnx, a requested cluster count larger than the number of
 * embeddings is clamped instead of collapsing everything into one cluster.
 */

/**
 * @param {Float32Array} embeddings row-major [rows, dim]
 * @param {number} rows
 * @param {{ numClusters?: number, threshold?: number }} options a positive
 *   `numClusters` wins; otherwise merging stops at `threshold` (default 0.5)
 * @returns {Int32Array}
 */
export function clusterSpeakerEmbeddings(embeddings, rows, options) {
  if (rows <= 0) return new Int32Array(0);
  if (rows === 1) return new Int32Array(1);
  const dim = embeddings.length / rows;
  const distances = cosineDistances(embeddings, rows, dim);
  const { merge, height } = completeLinkage(rows, distances);
  const numClusters = options.numClusters ?? 0;
  if (numClusters > 0) {
    return cutTreeK(rows, merge, Math.min(numClusters, rows));
  }
  const threshold = options.threshold ?? 0.5;
  let steps = 0;
  while (steps < rows - 1 && height[steps] < threshold) steps += 1;
  return cutTreeK(rows, merge, rows - steps);
}

/**
 * Condensed upper-triangle matrix of `1 - cos`, clamped at 0.
 * @param {Float32Array} embeddings
 * @param {number} rows
 * @param {number} dim
 */
function cosineDistances(embeddings, rows, dim) {
  const unit = new Float32Array(embeddings.length);
  for (let row = 0; row < rows; row += 1) {
    const offset = row * dim;
    let norm = 0;
    for (let k = 0; k < dim; k += 1) norm += embeddings[offset + k] ** 2;
    norm = Math.sqrt(norm);
    const scale = norm > 0 ? 1 / norm : 1;
    for (let k = 0; k < dim; k += 1) {
      unit[offset + k] = embeddings[offset + k] * scale;
    }
  }
  // Float64 keeps parity with fastcluster's double matrix; long recordings
  // fall back to Float32 so the matrix stays within browser memory.
  const pairs = (rows * (rows - 1)) / 2;
  const distances =
    pairs <= 8_000_000 ? new Float64Array(pairs) : new Float32Array(pairs);
  let index = 0;
  for (let i = 0; i < rows; i += 1) {
    const a = i * dim;
    for (let j = i + 1; j < rows; j += 1) {
      const b = j * dim;
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += unit[a + k] * unit[b + k];
      distances[index] = Math.max(0, 1 - Math.fround(dot));
      index += 1;
    }
  }
  return distances;
}

/**
 * fastcluster's `NN_chain_core` for complete linkage plus
 * `generate_R_dendrogram`: R merge format (atoms are -1..-N, clusters are the
 * 1-based merge step that created them).
 * @param {number} n
 * @param {Float64Array | Float32Array} distances condensed, modified in place
 */
function completeLinkage(n, distances) {
  const at = (/** @type {number} */ r, /** @type {number} */ c) =>
    ((2 * n - 3 - r) * r) / 2 + c - 1;
  const succ = new Int32Array(n + 1);
  const pred = new Int32Array(n + 1);
  for (let i = 0; i <= n; i += 1) {
    succ[i] = i + 1;
    pred[i] = i - 1;
  }
  let start = 0;
  const remove = (/** @type {number} */ idx) => {
    if (idx === start) start = succ[idx];
    else {
      succ[pred[idx]] = succ[idx];
      pred[succ[idx]] = pred[idx];
    }
  };

  /** @type {Array<{ node1: number, node2: number, dist: number }>} */
  const steps = [];
  const chain = new Int32Array(n);
  let tip = 0;
  let idx1 = 0;
  let idx2 = 0;
  let min = 0;

  for (let step = 0; step < n - 1; step += 1) {
    if (tip <= 3) {
      chain[0] = idx1 = start;
      tip = 1;
      idx2 = succ[idx1];
      min = distances[at(idx1, idx2)];
      for (let i = succ[idx2]; i < n; i = succ[i]) {
        const d = distances[at(idx1, i)];
        if (d < min) {
          min = d;
          idx2 = i;
        }
      }
    } else {
      tip -= 3;
      idx1 = chain[tip - 1];
      idx2 = chain[tip];
      min = distances[idx1 < idx2 ? at(idx1, idx2) : at(idx2, idx1)];
    }

    do {
      chain[tip] = idx2;
      for (let i = start; i < idx2; i = succ[i]) {
        const d = distances[at(i, idx2)];
        if (d < min) {
          min = d;
          idx1 = i;
        }
      }
      for (let i = succ[idx2]; i < n; i = succ[i]) {
        const d = distances[at(idx2, i)];
        if (d < min) {
          min = d;
          idx1 = i;
        }
      }
      idx2 = idx1;
      idx1 = chain[tip];
      tip += 1;
    } while (idx2 !== chain[tip - 2]);

    steps.push({ node1: idx1, node2: idx2, dist: min });
    if (idx1 > idx2) [idx1, idx2] = [idx2, idx1];
    remove(idx1);

    let i = start;
    for (; i < idx1; i = succ[i]) {
      const target = at(i, idx2);
      distances[target] = Math.max(distances[target], distances[at(i, idx1)]);
    }
    for (; i < idx2; i = succ[i]) {
      const target = at(i, idx2);
      distances[target] = Math.max(distances[target], distances[at(idx1, i)]);
    }
    for (i = succ[idx2]; i < n; i = succ[i]) {
      const target = at(idx2, i);
      distances[target] = Math.max(distances[target], distances[at(idx1, i)]);
    }
  }

  // Array.prototype.sort is stable, matching std::stable_sort.
  steps.sort((a, b) => a.dist - b.dist);
  const parent = new Int32Array(2 * n - 1);
  let nextParent = n;
  const find = (/** @type {number} */ idx) => {
    let root = idx;
    while (parent[root] !== 0) root = parent[root];
    while (parent[idx] !== 0 && parent[idx] !== root) {
      const next = parent[idx];
      parent[idx] = root;
      idx = next;
    }
    return root;
  };

  const merge = new Int32Array(2 * (n - 1));
  const height = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    let node1 = find(steps[i].node1);
    let node2 = find(steps[i].node2);
    parent[node1] = parent[node2] = nextParent;
    nextParent += 1;
    if (node1 > node2) [node1, node2] = [node2, node1];
    merge[i] = node1 < n ? -node1 - 1 : node1 - n + 1;
    merge[i + n - 1] = node2 < n ? -node2 - 1 : node2 - n + 1;
    height[i] = steps[i].dist;
  }
  return { merge, height };
}

/**
 * hclust-cpp's `cutree_k`.
 * @param {number} n
 * @param {Int32Array} merge
 * @param {number} clusters
 */
function cutTreeK(n, merge, clusters) {
  const labels = new Int32Array(n);
  if (clusters > n || clusters < 2) return labels;
  const lastMerge = new Int32Array(n);
  for (let k = 1; k <= n - clusters; k += 1) {
    let m1 = merge[k - 1];
    let m2 = merge[n - 1 + k - 1];
    if (m1 < 0 && m2 < 0) {
      lastMerge[-m1 - 1] = k;
      lastMerge[-m2 - 1] = k;
    } else if (m1 < 0 || m2 < 0) {
      let atom;
      if (m1 < 0) {
        atom = -m1;
        m1 = m2;
      } else atom = -m2;
      for (let l = 0; l < n; l += 1) if (lastMerge[l] === m1) lastMerge[l] = k;
      lastMerge[atom - 1] = k;
    } else {
      for (let l = 0; l < n; l += 1) {
        if (lastMerge[l] === m1 || lastMerge[l] === m2) lastMerge[l] = k;
      }
    }
  }
  let label = 0;
  const z = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j += 1) {
    if (lastMerge[j] === 0) labels[j] = label++;
    else {
      if (z[lastMerge[j]] < 0) z[lastMerge[j]] = label++;
      labels[j] = z[lastMerge[j]];
    }
  }
  return labels;
}
