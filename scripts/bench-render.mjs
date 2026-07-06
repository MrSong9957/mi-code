// Quick perf measurement: custom renderer frame timing.
// Run: npx tsx scripts/bench-render.mjs
// Not a vitest test — measurement only.

import { createCustomRenderer } from '../src/render/renderer.js';

const writes = [];
const stdout = { write: (s) => { writes.push(s); return true; }, columns: 200, rows: 50, isTTY: true };
const renderer = createCustomRenderer({ stdout });

// Build a fake tree with 1000 chars spread across 50 rows
const children = [];
for (let r = 0; r < 50; r++) {
  children.push({
    nodeName: 'ink-text',
    yogaNode: { getComputedLeft: () => 0, getComputedTop: () => r, getComputedWidth: () => 200, getComputedHeight: () => 1, getDisplay: () => 0 },
    childNodes: [{ nodeName: '#text', nodeValue: 'a'.repeat(20), childNodes: [] }],
    internal_transform: undefined,
  });
}
const tree = { nodeName: 'ink-root', yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 200, getComputedHeight: () => 50, getDisplay: () => 0 }, childNodes: children, style: {} };

// First frame (full write — 1000 new cells)
const t1 = performance.now();
renderer(tree, { width: 200, height: 50 });
const firstFrame = performance.now() - t1;

const firstBytes = writes.join('').length;
writes.length = 0;

// Second frame identical (diff should produce no patches → near-zero work)
const t2 = performance.now();
renderer(tree, { width: 200, height: 50 });
const secondFrame = performance.now() - t2;

const secondBytes = writes.join('').length;

console.log(`First frame (1000 cells, all new): ${firstFrame.toFixed(2)}ms, ${firstBytes} bytes`);
console.log(`Second frame (no changes): ${secondFrame.toFixed(2)}ms, ${secondBytes} bytes`);
