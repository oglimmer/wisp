// The longest-common-subsequence core. Used on lines by the diff view and smart
// insert's preview, and on words by the diff view's intra-line highlighting —
// hence `lcsOps` taking arrays rather than text.

export function lineDiff(a, b) {
  return condenseDiff(diffOps(a.split('\n'), b.split('\n')));
}

// Longest-common-subsequence diff of two arrays of strings. Used on words by the git
// diff viewer and on block signatures by the WYSIWYG fold, so it stays generic. The DP
// table is (n+1)×(m+1), so this is only for inputs whose size the caller has bounded
// (see WORD_DIFF_MAX_CELLS, FOLD_MAX_CELLS) — for whole files use `diffOps`.
export function lcsOps(A, B) {
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: 'ctx', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: A[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: A[i++] });
  while (j < m) ops.push({ type: 'add', text: B[j++] });

  return ops;
}

// The line diff, uncondensed: a flat list of ctx/del/add ops, in source order. Split
// out from lineDiff because the git side-by-side view has to pair deletions with
// additions before any context is collapsed away.
//
// **This is the one that runs over whole files, so it is never a table over one.** A
// plain (n+1)×(m+1) DP is quadratic in the *file* rather than in the change, which is
// why the visual diff used to refuse anything past ~1200 lines — a table nobody could
// afford for a note with one paragraph edited in it. So the file is cut down to regions
// the exact table *can* afford, and only then handed to `lcsOps`:
//
//  - **The common prefix and suffix are matched off directly.** An edit in the middle
//    of a file leaves only the lines around it to diff, however long the file is. This
//    alone answers the ordinary case, and answers it exactly.
//  - **A region still too big is split on its anchors** — lines appearing exactly once
//    on each side, which can therefore only correspond to their twin (patience diff's
//    idea). The longest increasing run of those pairs cuts the region into independent
//    gaps, each diffed on its own; prose is nearly all unique lines, so a real note
//    decomposes into gaps of a few lines. Anchoring is *second* on purpose: committing
//    to a fixed point can match a line or two fewer than the optimal LCS, so anything
//    the table can still afford is diffed exactly, as it was before.
//  - **A gap with no anchor at all is halved by proportion** and each half diffed on
//    its own, which is what keeps a region of near-identical lines (a long checklist, a
//    log, a column of numbers) from coming back as "all of it changed". The lines either
//    side of a split can be paired worse than the optimal LCS would pair them; every
//    other line is matched exactly.
//
// Only a single line against thousands, or a nesting deeper than MAX_DEPTH, is reported
// as a wholesale replacement — every line deleted, every line added, which is correct
// but not minimal. Nothing is ever refused.
export function diffOps(A, B) {
  const ops = [];
  diffRange(A, 0, A.length, B, 0, B.length, ops, 0);
  return ops;
}

// How many DP cells one region may cost before it is split rather than diffed exactly:
// ~2000 lines against 2000, an Int32Array table of 16MB. Reached only by a region that
// survived prefix/suffix trimming, so it takes a file changed all the way through.
const REGION_MAX_CELLS = 4_000_000;
// Both ways of splitting a region recurse into the pieces, and a piece can need
// splitting again (a line can be unique within a gap without being unique in the file;
// half of a region can still be too big). Each level consumes an anchor or halves the
// left side, so this terminates on its own — the cap is a backstop, and a region that
// reaches it is replaced wholesale rather than nesting further.
const MAX_DEPTH = 40;

// Diff A[a0,a1) against B[b0,b1), appending ops to `out`.
function diffRange(A, a0, a1, B, b0, b1, out, depth) {
  while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
    out.push({ type: 'ctx', text: A[a0] });
    a0++;
    b0++;
  }
  // The suffix is emitted after the middle, so remember where it starts rather than
  // buffering it: A[a1..tail) is the run both sides end with.
  const tail = a1;
  while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) {
    a1--;
    b1--;
  }

  if (a0 === a1 || b0 === b1) {
    // One side has nothing left: whatever remains was added or deleted outright.
    replaceRange(A, a0, a1, B, b0, b1, out);
  } else if ((a1 - a0 + 1) * (b1 - b0 + 1) <= REGION_MAX_CELLS) {
    for (const op of lcsOps(A.slice(a0, a1), B.slice(b0, b1))) out.push(op);
  } else if (depth >= MAX_DEPTH) {
    replaceRange(A, a0, a1, B, b0, b1, out);
  } else {
    const anchors = commonUniqueLines(A, a0, a1, B, b0, b1);
    if (anchors.length) {
      let i = a0;
      let j = b0;
      for (const [ai, bj] of anchors) {
        diffRange(A, i, ai, B, j, bj, out, depth + 1);
        out.push({ type: 'ctx', text: A[ai] });
        i = ai + 1;
        j = bj + 1;
      }
      diffRange(A, i, a1, B, j, b1, out, depth + 1);
    } else if (a1 - a0 > 1 && b1 - b0 > 1) {
      // Nothing to anchor on, so there is no telling where the halves belong — split
      // both sides by proportion and diff each pair. Only the lines either side of the
      // split can be paired worse than the optimal LCS would pair them, which is a far
      // better answer than calling the whole region rewritten.
      const am = (a0 + a1) >> 1;
      const bm = b0 + Math.round(((am - a0) / (a1 - a0)) * (b1 - b0));
      diffRange(A, a0, am, B, b0, bm, out, depth + 1);
      diffRange(A, am, a1, B, bm, b1, out, depth + 1);
    } else {
      replaceRange(A, a0, a1, B, b0, b1, out);
    }
  }

  for (let i = a1; i < tail; i++) out.push({ type: 'ctx', text: A[i] });
}

function replaceRange(A, a0, a1, B, b0, b1, out) {
  for (let i = a0; i < a1; i++) out.push({ type: 'del', text: A[i] });
  for (let j = b0; j < b1; j++) out.push({ type: 'add', text: B[j] });
}

// The lines appearing exactly once in each of the two ranges, as [i, j] pairs whose
// order is increasing on *both* sides — so they can be used as fixed points. Pairs are
// collected in A order, then the longest run whose j also increases is kept, since two
// anchors that cross each other can't both be honoured.
function commonUniqueLines(A, a0, a1, B, b0, b1) {
  const once = (arr, from, to) => {
    const at = new Map(); // text -> its index, or -1 once a second copy is seen
    for (let k = from; k < to; k++) at.set(arr[k], at.has(arr[k]) ? -1 : k);
    return at;
  };
  const inA = once(A, a0, a1);
  const inB = once(B, b0, b1);

  const pairs = [];
  for (let i = a0; i < a1; i++) {
    if (inA.get(A[i]) !== i) continue; // not unique on this side
    const j = inB.get(A[i]);
    if (j === undefined || j === -1) continue;
    pairs.push([i, j]);
  }
  return longestIncreasing(pairs);
}

// Longest strictly-increasing subsequence of the pairs' second coordinate, via patience
// sort: `tails[l]` is the pair ending the cheapest chain of length l+1, and `prev`
// threads each pair back to the one before it.
function longestIncreasing(pairs) {
  const tails = [];
  const prev = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }

  const out = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    out.push(pairs[k]);
    k = prev[k];
  }
  return out.reverse();
}

// Keep 2 lines of context around each change; replace larger unchanged gaps with
// a single "⋯ N unchanged lines" marker.
function condenseDiff(ops) {
  const CONTEXT = 2;
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'ctx') {
      for (let d = -CONTEXT; d <= CONTEXT; d++) {
        if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
      }
    }
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (keep[k]) {
      out.push(ops[k]);
      k++;
    } else {
      let count = 0;
      while (k < ops.length && !keep[k]) {
        count++;
        k++;
      }
      out.push({ type: 'gap', text: `⋯ ${count} unchanged line${count === 1 ? '' : 's'}` });
    }
  }
  return out;
}
