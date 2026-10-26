import test from 'node:test';
import assert from 'node:assert/strict';
import { solveBinaryEnergy, alphaExpansionMove, optimizePotts, pottsEnergy } from '../public/graph-cuts.js';
let seed = 192837;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

test('binary graph cuts equal exhaustive minima on asymmetric and negative-unary tiny energies', () => {
  for (let trial = 0; trial < 90; trial++) {
    const n = 2 + trial % 7, zero = Array.from({ length: n }, () => random() * 10 - 5), one = Array.from({ length: n }, () => random() * 10 - 5);
    const terms = [];
    for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) if (random() < .4) {
      const constant = random() * 3, a = random() * 4 - 2, b = random() * 4 - 2, w = random() * 3;
      terms.push({ u, v, e00: constant, e01: constant + b + w, e10: constant + a + w, e11: constant + a + b });
    }
    const cost = labels => labels.reduce((sum, value, i) => sum + (value ? one[i] : zero[i]), 0)
      + terms.reduce((sum, t) => sum + t[`e${labels[t.u]}${labels[t.v]}`], 0);
    let minimum = Infinity;
    for (let bits = 0; bits < 2 ** n; bits++) minimum = Math.min(minimum, cost(Array.from({ length: n }, (_, i) => (bits >> i) & 1)));
    const result = solveBinaryEnergy(zero, one, terms);
    assert(Math.abs(result.energy - minimum) < 1e-7, `flow value trial ${trial}`);
    assert(Math.abs(cost([...result.labels]) - minimum) < 1e-7, `cut labels trial ${trial}`);
  }
});

test('each Potts alpha move equals exhaustive keep/switch search, including pixels already alpha', () => {
  for (let trial = 0; trial < 60; trial++) {
    const n = 3 + trial % 5, k = 3, labels = Int32Array.from({ length: n }, () => Math.floor(random() * k));
    const unary = Float64Array.from({ length: n * k }, () => random() * 8), edges = [];
    for (let u = 0; u + 1 < n; u++) edges.push({ u, v: u + 1, weight: random() * 6 });
    for (let alpha = 0; alpha < k; alpha++) {
      let minimum = Infinity;
      for (let bits = 0; bits < 2 ** n; bits++) {
        const proposal = Int32Array.from(labels, (label, i) => (bits >> i) & 1 ? alpha : label);
        minimum = Math.min(minimum, pottsEnergy(proposal, unary, k, edges).total);
      }
      const result = alphaExpansionMove(labels, unary, k, edges, alpha);
      assert(Math.abs(result.total - minimum) < 1e-7);
      assert(Math.abs(result.cutEnergy - minimum) < 1e-7);
    }
  }
});

test('expansion changes a whole region that single-site ICM cannot improve, with monotone trace', () => {
  const unary = [0, 1, 0, 1], edges = [{ u: 0, v: 1, weight: 3 }];
  assert(pottsEnergy([0, 1], unary, 2, edges).total > pottsEnergy([1, 1], unary, 2, edges).total);
  const result = optimizePotts([1, 1], unary, 2, edges);
  assert.deepEqual([...result.labels], [0, 0]);
  let last = 2;
  for (const entry of result.trace) { assert(entry.total < last); last = entry.total; }
});

test('higher-order acceptance filter checks the complete energy rather than claiming an exact higher-order cut', () => {
  const extra = labels => labels[0] === 0 && labels[1] === 0 ? 10 : 0;
  const result = optimizePotts([1, 1], [0, 1, 0, 1], 2, [{ u: 0, v: 1, weight: 3 }], { extraEnergy: extra });
  assert.deepEqual([...result.labels], [1, 1]); assert.equal(result.energy.total, 2);
});

test('iterative flow handles a long chain without recursive stack overflow and rejects nonsubmodular terms', () => {
  const n = 20000, zero = new Float64Array(n), one = new Float64Array(n), terms = [];
  one[0] = 100; zero[n - 1] = 100;
  for (let i = 0; i + 1 < n; i++) terms.push({ u: i, v: i + 1, e00: 0, e01: 1, e10: 1, e11: 0 });
  assert.equal(solveBinaryEnergy(zero, one, terms).energy, 1);
  assert.throws(() => solveBinaryEnergy([0, 0], [1, 1], [{ u: 0, v: 1, e00: 1, e01: 0, e10: 0, e11: 1 }]), /submodular/);
});
