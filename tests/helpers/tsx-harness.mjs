import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// React decides whether the browser supports `input` events when react-dom is
// first imported. Without a document it falls back to the legacy IE polyfill,
// which jsdom cannot run, so controlled inputs never report changes. Give it a
// document up front; each `domHarness()` still swaps in its own window.
const bootstrap = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const [key, value] of Object.entries({
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

export { React, act };
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const projectRoot = new URL('../../', import.meta.url);

function resolveAlias(request) {
  const base = fileURLToPath(new URL(request, projectRoot));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve ${request} from the project root.`);
  return pathToFileURL(found);
}

/** Compile one TS/TSX source file and run it with the shared doubles. */
function loadModule(url, mocks, globals, cache) {
  const key = url.pathname;
  if (cache.has(key)) return cache.get(key);

  const exports = {};
  cache.set(key, exports);
  const require = createRequire(url);
  const requireModule = request => {
    if (request in mocks) return mocks[request];
    if (request.startsWith('@/')) return loadModule(resolveAlias(request.slice(2)), mocks, globals, cache);
    return require(request);
  };

  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(code, {
    exports, require: requireModule,
    console, setTimeout, clearTimeout, crypto, TextEncoder, URL, Event, Error, TypeError,
    ...globals,
  }, { filename: url.pathname });
  return exports;
}

/** Run the actual TS/TSX source with explicit dependency doubles, never a copy. */
export function loadSource(path, mocks = {}, globals = {}) {
  return loadModule(new URL(path, import.meta.url), mocks, globals, new Map());
}

export function domHarness() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  return {
    window: dom.window, root,
    async close() {
      await act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}
