// The main process lives in main/ (see CLAUDE.md). This entry is kept at the repo
// root so `package.json`'s "main" — and everything that launches the app through
// it — needs no knowledge of the layout.
import './main/index.mjs';

// Main-process stack traces name the .mts they were written in, not the emitted
// .mjs. Node has this off by default and an Electron app has no practical way to
// pass `--enable-source-maps`, so it is turned on here instead. (The renderer
// needs no equivalent: DevTools reads the `sourceMappingURL` by itself.)
//
// This runs *after* the import above — an ES module's imports are hoisted — so an
// error thrown while the graph is still evaluating is not mapped. That is a small
// gap on purpose: the alternative is a module imported ahead of index.mjs, which
// check-unbound.js would then report as unreachable from the main tree's entry.
process.setSourceMapsEnabled(true);
