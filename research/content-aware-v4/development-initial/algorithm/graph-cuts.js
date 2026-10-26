/** Binary submodular graph cuts and Potts alpha expansion (BVZ, PAMI 2001).
 * Dinic uses explicit stacks; a large connected image cannot overflow JS recursion.
 */
const EPS = 1e-10;

class Dinic {
  constructor(nodes, estimatedArcs) {
    this.head = new Int32Array(nodes).fill(-1); this.to = new Int32Array(Math.max(16, estimatedArcs));
    this.next = new Int32Array(this.to.length); this.cap = new Float64Array(this.to.length); this.length = 0;
    this.level = new Int32Array(nodes); this.ptr = new Int32Array(nodes); this.queue = new Int32Array(nodes);
    this.pathNodes = new Int32Array(nodes); this.pathEdges = new Int32Array(nodes); this.pathCapacity = new Float64Array(nodes);
  }
  add(u, v, capacity, reverse = 0) {
    if (capacity <= EPS && reverse <= EPS) return;
    if (this.length + 2 > this.to.length) {
      for (const key of ['to', 'next', 'cap']) { const replacement = new this[key].constructor(this[key].length * 2); replacement.set(this[key]); this[key] = replacement; }
    }
    let e = this.length; this.to[e] = v; this.cap[e] = capacity; this.next[e] = this.head[u]; this.head[u] = e;
    e++; this.to[e] = u; this.cap[e] = reverse; this.next[e] = this.head[v]; this.head[v] = e; this.length += 2;
  }
  bfs(source, sink) {
    this.level.fill(-1); let head = 0, tail = 0; this.queue[tail++] = source; this.level[source] = 0;
    while (head < tail) {
      const v = this.queue[head++];
      for (let e = this.head[v]; e >= 0; e = this.next[e]) if (this.cap[e] > EPS && this.level[this.to[e]] < 0) {
        this.level[this.to[e]] = this.level[v] + 1; this.queue[tail++] = this.to[e];
      }
    }
    return this.level[sink] >= 0;
  }
  flow(source, sink) {
    let total = 0;
    while (this.bfs(source, sink)) {
      this.ptr.set(this.head); let depth = 0; this.pathNodes[0] = source; this.pathCapacity[0] = Infinity;
      while (depth >= 0) {
        const v = this.pathNodes[depth];
        if (v === sink) {
          const amount = this.pathCapacity[depth]; total += amount;
          for (let i = 0; i < depth; i++) { const e = this.pathEdges[i]; this.cap[e] -= amount; this.cap[e ^ 1] += amount; }
          depth = 0; continue;
        }
        let edge = this.ptr[v];
        while (edge >= 0 && (this.cap[edge] <= EPS || this.level[this.to[edge]] !== this.level[v] + 1)) edge = this.next[edge];
        this.ptr[v] = edge;
        if (edge < 0) {
          this.level[v] = -1;
          if (depth === 0) break;
          depth--; this.ptr[this.pathNodes[depth]] = this.next[this.pathEdges[depth]];
        } else {
          this.pathEdges[depth] = edge; this.pathNodes[depth + 1] = this.to[edge];
          this.pathCapacity[depth + 1] = Math.min(this.pathCapacity[depth], this.cap[edge]); depth++;
        }
      }
    }
    return total;
  }
  reachable(source) {
    const seen = new Uint8Array(this.head.length); let head = 0, tail = 0; this.queue[tail++] = source; seen[source] = 1;
    while (head < tail) {
      const v = this.queue[head++];
      for (let e = this.head[v]; e >= 0; e = this.next[e]) if (this.cap[e] > EPS && !seen[this.to[e]]) { seen[this.to[e]] = 1; this.queue[tail++] = this.to[e]; }
    }
    return seen;
  }
}

/** Minimise arbitrary unary costs plus submodular binary pair terms exactly. */
export function solveBinaryEnergy(unary0, unary1, terms = []) {
  const n = unary0.length;
  if (unary1.length !== n) throw new Error('Binary unary dimensions differ');
  const zero = Float64Array.from(unary0), one = Float64Array.from(unary1), graph = new Dinic(n + 2, 4 * n + 2 * terms.length + 8);
  let constant = 0;
  for (const term of terms) {
    const { u, v, e00, e01, e10, e11 } = term;
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= n || v >= n || u === v || ![e00, e01, e10, e11].every(Number.isFinite)) throw new Error('Invalid binary pair term');
    const weight = (e01 + e10 - e00 - e11) / 2;
    if (weight < -1e-8) throw new Error('Pair term is not submodular');
    const w = Math.max(0, weight);
    constant += e00; one[u] += e10 - e00 - w; one[v] += e01 - e00 - w;
    graph.add(u, v, w, w);
  }
  const source = n, sink = n + 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(zero[i]) || !Number.isFinite(one[i])) throw new Error('Binary unary must be finite');
    const minimum = Math.min(zero[i], one[i]); constant += minimum;
    graph.add(source, i, one[i] - minimum); graph.add(i, sink, zero[i] - minimum);
  }
  const value = graph.flow(source, sink), reachable = graph.reachable(source);
  return { labels: Uint8Array.from({ length: n }, (_, i) => reachable[i] ? 0 : 1), energy: constant + value };
}

export function pottsEnergy(labels, unary, labelCount, edges) {
  let data = 0, pairwise = 0;
  for (let i = 0; i < labels.length; i++) data += unary[i * labelCount + labels[i]];
  for (const { u, v, weight } of edges) if (labels[u] !== labels[v]) pairwise += weight;
  return { data, pairwise, total: data + pairwise };
}

/** The best binary keep-or-alpha move, with no approximation in the cut. */
export function alphaExpansionMove(labels, unary, labelCount, edges, alpha) {
  if (!Number.isInteger(alpha) || alpha < 0 || alpha >= labelCount || unary.length !== labels.length * labelCount) throw new Error('Invalid expansion dimensions');
  const n = labels.length, zero = new Float64Array(n), one = new Float64Array(n);
  for (let i = 0; i < n; i++) { zero[i] = unary[i * labelCount + labels[i]]; one[i] = unary[i * labelCount + alpha]; }
  const terms = edges.map(({ u, v, weight }) => {
    if (!(weight >= 0 && Number.isFinite(weight))) throw new Error('Potts weights must be nonnegative');
    return { u, v, e00: labels[u] === labels[v] ? 0 : weight, e01: labels[u] === alpha ? 0 : weight, e10: labels[v] === alpha ? 0 : weight, e11: 0 };
  });
  const cut = solveBinaryEnergy(zero, one, terms);
  const proposal = Int32Array.from(labels, (label, i) => cut.labels[i] ? alpha : label);
  return { labels: proposal, ...pottsEnergy(proposal, unary, labelCount, edges), cutEnergy: cut.energy };
}

/** Bounded alpha-expansion passes. Optional higher-order energy is evaluated
 * after each exact pairwise proposal and accepted only on full-energy descent;
 * this filter does not make that higher-order term graph-representable.
 */
export function optimizePotts(labels, unary, labelCount, edges, options = {}) {
  let current = Int32Array.from(labels), energy = pottsEnergy(current, unary, labelCount, edges);
  const extra = options.extraEnergy || (() => 0), trace = [], maxPasses = options.maxPasses ?? 2;
  let higherOrder = extra(current), moves = 0, accepted = 0, passes = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false; passes++;
    for (let alpha = 0; alpha < labelCount; alpha++) {
      const proposal = alphaExpansionMove(current, unary, labelCount, edges, alpha); moves++;
      const candidateExtra = extra(proposal.labels);
      if (proposal.total + candidateExtra < energy.total + higherOrder - 1e-7) {
        current = proposal.labels; energy = { data: proposal.data, pairwise: proposal.pairwise, total: proposal.total }; higherOrder = candidateExtra;
        changed = true; accepted++;
        const entry = { stage: 'alpha-expansion', pass, alpha, data: energy.data, pairwise: energy.pairwise, island: higherOrder, total: energy.total + higherOrder };
        trace.push(entry); options.onAccept?.(entry, current);
      }
    }
    if (!changed) break;
  }
  return { labels: current, energy: { ...energy, island: higherOrder, total: energy.total + higherOrder }, trace, moves, accepted, passes };
}
