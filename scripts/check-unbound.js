#!/usr/bin/env node
// Fail if any renderer ES module references an unbound name — or is never
// reached from the entry point at all.
//
// Both are the same class of bug, left by the renderer.js → renderer/ split.
// A free identifier that used to resolve via classic-script hoisting is now an
// undeclared reference (missing import / forgotten export), and it throws only
// when its code path runs, so it looks like a silent UI freeze. A module nobody
// imports is quieter still: index.html loads only `renderer/index.js` and the
// browser fetches the graph, so a file outside it never *runs* — its top-level
// listeners are simply never registered, and the feature does nothing at all.
//
// Usage: node scripts/check-unbound.js
// Exit 0 = clean, 1 = issues (or acorn missing / parse error).

'use strict';

const fs = require('fs');
const path = require('path');

let acorn;
try {
  acorn = require('acorn');
} catch {
  console.error('error: acorn is required (npm install — it is a devDependency)');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

// Browser + classic-script globals the renderer may touch without importing.
const GLOBALS = new Set([
  'window',
  'document',
  'console',
  'localStorage',
  'sessionStorage',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'queueMicrotask',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Math',
  'Date',
  'JSON',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'NaN',
  'Infinity',
  'undefined',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'CSS',
  'URL',
  'URLSearchParams',
  'Blob',
  'File',
  'FileReader',
  'Image',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'NodeFilter',
  'getComputedStyle',
  'navigator',
  'location',
  'history',
  'performance',
  'crypto',
  'TextEncoder',
  'TextDecoder',
  'structuredClone',
  'atob',
  'btoa',
  'Intl',
  'Proxy',
  'Reflect',
  'Symbol',
  'BigInt',
  'ArrayBuffer',
  'Uint8Array',
  'Int32Array',
  'Float64Array',
  'DataView',
  'fetch',
  'Response',
  'Request',
  'Headers',
  'AbortController',
  'alert',
  'confirm',
  'prompt',
  'ResizeObserver',
  'MutationObserver',
  'IntersectionObserver',
  'Range',
  'Selection',
  'Highlight', // CSS Custom Highlight API (find.js)
  'globalThis',
  'self',
  'origin',
  'isSecureContext',
  // Classic scripts loaded before the module graph in index.html:
  'marked',
  'TurndownService',
  'DOMPurify',
]);

function patternNames(pat, set) {
  if (!pat) return;
  if (pat.type === 'Identifier') set.add(pat.name);
  else if (pat.type === 'ObjectPattern') {
    for (const p of pat.properties) {
      if (p.type === 'RestElement') patternNames(p.argument, set);
      else patternNames(p.value, set);
    }
  } else if (pat.type === 'ArrayPattern') {
    for (const el of pat.elements) {
      if (!el) continue;
      if (el.type === 'RestElement') patternNames(el.argument, set);
      else patternNames(el, set);
    }
  } else if (pat.type === 'AssignmentPattern') patternNames(pat.left, set);
  else if (pat.type === 'RestElement') patternNames(pat.argument, set);
}

function isReference(node, parent) {
  if (node.type !== 'Identifier' || !parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    return false;
  }
  if (
    (parent.type === 'Property' || parent.type === 'PropertyDefinition') &&
    parent.key === node &&
    !parent.computed &&
    !parent.shorthand
  ) {
    return false;
  }
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) {
    return false;
  }
  if (parent.type === 'LabeledStatement' && parent.label === node) return false;
  if (
    (parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') &&
    parent.label === node
  ) {
    return false;
  }
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier'
  ) {
    return false;
  }
  if (parent.type === 'ExportSpecifier') return false;
  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return false;
  }
  if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if (parent.type === 'AssignmentPattern' && parent.left === node) return false;
  if (parent.type === 'CatchClause' && parent.param === node) return false;
  if (parent.type === 'RestElement' && parent.argument === node) return false;
  if (parent.type === 'MetaProperty') return false;
  if (parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') return false;
  return true;
}

function analyze(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  const moduleBindings = new Set();

  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') {
      for (const s of stmt.specifiers) moduleBindings.add(s.local.name);
    } else if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        if (stmt.declaration.type === 'FunctionDeclaration' && stmt.declaration.id) {
          moduleBindings.add(stmt.declaration.id.name);
        }
        if (stmt.declaration.type === 'ClassDeclaration' && stmt.declaration.id) {
          moduleBindings.add(stmt.declaration.id.name);
        }
        if (stmt.declaration.type === 'VariableDeclaration') {
          for (const d of stmt.declaration.declarations) patternNames(d.id, moduleBindings);
        }
      }
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      moduleBindings.add(stmt.id.name);
    } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
      moduleBindings.add(stmt.id.name);
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) patternNames(d.id, moduleBindings);
    }
  }

  const scopeStack = [moduleBindings];
  const issues = [];

  function resolve(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].has(name)) return true;
    }
    return GLOBALS.has(name);
  }

  function walkFull(node, parent) {
    if (!node || typeof node !== 'object') return;

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      for (const p of node.params) {
        if (p.type === 'AssignmentPattern') walkFull(p.right, p);
      }
      const bindings = new Set();
      if (node.id) bindings.add(node.id.name);
      for (const p of node.params) {
        patternNames(p.type === 'AssignmentPattern' ? p.left : p, bindings);
      }
      scopeStack.push(bindings);
      walkFull(node.body, node);
      scopeStack.pop();
      return;
    }

    if (node.type === 'BlockStatement') {
      const bindings = new Set();
      for (const stmt of node.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id) bindings.add(stmt.id.name);
        if (stmt.type === 'ClassDeclaration' && stmt.id) bindings.add(stmt.id.name);
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations) patternNames(d.id, bindings);
        }
      }
      scopeStack.push(bindings);
      for (const stmt of node.body) walkFull(stmt, node);
      scopeStack.pop();
      return;
    }

    if (node.type === 'CatchClause') {
      const bindings = new Set();
      if (node.param) patternNames(node.param, bindings);
      scopeStack.push(bindings);
      walkFull(node.body, node);
      scopeStack.pop();
      return;
    }

    if (
      node.type === 'ForStatement' ||
      node.type === 'ForOfStatement' ||
      node.type === 'ForInStatement'
    ) {
      const bindings = new Set();
      if (node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration') {
        for (const d of node.init.declarations) patternNames(d.id, bindings);
      }
      if (
        (node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
        node.left &&
        node.left.type === 'VariableDeclaration'
      ) {
        for (const d of node.left.declarations) patternNames(d.id, bindings);
      }
      scopeStack.push(bindings);
      for (const key of Object.keys(node)) {
        if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => walkFull(c, node));
        else if (child && child.type) walkFull(child, node);
      }
      scopeStack.pop();
      return;
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.superClass) walkFull(node.superClass, node);
      const bindings = new Set();
      if (node.id) bindings.add(node.id.name);
      scopeStack.push(bindings);
      walkFull(node.body, node);
      scopeStack.pop();
      return;
    }

    if (node.type === 'Identifier' && isReference(node, parent) && !resolve(node.name)) {
      issues.push({ name: node.name, line: node.loc.start.line });
    }

    if (node.type === 'VariableDeclarator') {
      if (node.init) walkFull(node.init, node);
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) walkFull(node.key, node);
      walkFull(node.value, node);
      return;
    }
    if (node.type === 'MemberExpression') {
      walkFull(node.object, node);
      if (node.computed) walkFull(node.property, node);
      return;
    }

    for (const key of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => walkFull(c, node));
      else if (child && child.type) walkFull(child, node);
    }
  }

  for (const stmt of ast.body) walkFull(stmt, null);
  return issues;
}

// The entry point index.html loads; everything else has to be reachable from it.
const ENTRY = 'index.js';

// The modules `file` imports (or re-exports from), by file name.
function importsOf(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module' });
  const out = [];
  for (const stmt of ast.body) {
    const kind = stmt.type;
    if (
      kind !== 'ImportDeclaration' &&
      kind !== 'ExportNamedDeclaration' &&
      kind !== 'ExportAllDeclaration'
    ) {
      continue;
    }
    // A side-effect import (`import './shortcuts.js'`) has no specifiers and is
    // exactly what a module registering listeners at load time needs.
    if (!stmt.source) continue;
    const m = /^\.\/(.+)$/.exec(String(stmt.source.value));
    if (m) out.push(m[1]);
  }
  return out;
}

function unreachable(files) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !files.includes(file)) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    for (const next of importsOf(src)) walk(next);
  };
  walk(ENTRY);
  return files.filter((f) => !seen.has(f));
}

function main() {
  const files = fs
    .readdirSync(RENDERER)
    .filter((f) => f.endsWith('.js'))
    .sort();

  let total = 0;

  for (const f of unreachable(files)) {
    console.error(
      `renderer/${f}: never imported — nothing in the graph from ${ENTRY} reaches it, so it never runs`
    );
    total++;
  }
  for (const f of files) {
    const rel = path.join('renderer', f);
    const src = fs.readFileSync(path.join(RENDERER, f), 'utf8');
    let issues;
    try {
      issues = analyze(src);
    } catch (err) {
      console.error(`error: ${rel}: parse failed: ${err.message}`);
      process.exit(1);
    }
    if (!issues.length) continue;
    // Dedupe by name@line
    const seen = new Set();
    for (const iss of issues) {
      const k = `${iss.name}@${iss.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.error(`${rel}:${iss.line}: unbound \`${iss.name}\` (missing import/export?)`);
      total++;
    }
  }

  if (total > 0) {
    console.error(`\n${total} unbound reference${total === 1 ? '' : 's'} in renderer/`);
    process.exit(1);
  }
}

main();
