// The longest-common-subsequence core. Used on lines by the diff view and smart
// insert's preview, and on words by the diff view's intra-line highlighting —
// hence `lcsOps` taking arrays rather than text.

export function lineDiff(a, b) {
  return condenseDiff(lineOps(a, b));
}

// The diff itself, uncondensed: a flat list of ctx/del/add ops. Split out from
// lineDiff because the git side-by-side view has to pair deletions with additions
// before any context is collapsed away.
function lineOps(a, b) {
  return lcsOps(a.split('\n'), b.split('\n'));
}

// Longest-common-subsequence diff of two arrays of strings. Used on lines here and
// on words in the git diff viewer, so it stays generic. The DP table is
// (n+1)×(m+1) — callers with unbounded input must size-check first (see DIFF_MAX_CELLS).
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
