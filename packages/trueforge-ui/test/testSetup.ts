import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { vi } from 'vitest';

// Mirror `src/index.ts`: agent SVGs register into the Icon map. Tests that import
// atoms/theme modules directly never hit the package entry, so load them here.
import '../src/icons/registerAgentIcons.js';

// jsdom does not define isSecureContext; the clipboard API is the default path, and copyText tests set it per case.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
}

// react-syntax-highlighter ships both CJS and ESM; refractor (its dependency)
// is ESM-only and breaks when required via CJS. Mock in tests since it is
// external in production anyway.
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({
    children,
    language,
  }: {
    children?: string;
    language?: string;
    PreTag?: unknown;
    CodeTag?: unknown;
    style?: unknown;
    showLineNumbers?: boolean;
  }) =>
    createElement(
      'pre',
      { className: `language-${language ?? 'text'}`, 'data-testid': 'aui-syntax-highlighter' },
      createElement('code', null, children),
    ),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneDark: {},
  oneLight: {},
}));

vi.mock('@openuidev/react-lang', () => ({
  Renderer: ({ response, isStreaming }: { response?: string | null; isStreaming?: boolean }) =>
    createElement('div', { 'data-testid': 'aui-openui-renderer', 'data-streaming': String(!!isStreaming) }, response),
}));

vi.mock('@openuidev/react-ui', () => ({
  ThemeProvider: ({ children }: { children?: ReactNode }) => children,
  openuiLibrary: {},
}));

// jsdom does not implement ResizeObserver; assistant-ui's viewport/scroll
// tracking primitives use it, so tests need a no-op stand-in.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}

// jsdom's Blob/File does not implement arrayBuffer(); code that sniffs file bytes (e.g. image
// attachment handling) needs it, and FileReader is the one primitive jsdom does provide.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// jsdom's Blob does not implement text() either. Since Node 24, undici's Response#blob() builds
// its result with the global Blob, which the jsdom environment replaces, so every fetched blob
// in a test is a jsdom Blob. Browsers implement text() (UTF-8 decode), so fill it the same way.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this, 'utf-8');
    });
  };
}

// jsdom does not implement <dialog>'s showModal/close/show methods (the element
// renders, but the imperative API is a no-op that never toggles the `open`
// attribute or fires `close`). Every modal built on HTMLDialogElement
// (CenteredModal and its callers, including ConnectorSettings and
// AddMcpServerForm) calls `close()` from a layout effect, so without this the
// whole modal family throws `el.close is not a function` in any test that opens
// one. One shared polyfill here covers every such test instead of per-test stubs.
if (typeof HTMLDialogElement !== 'undefined') {
  const dialogProto = HTMLDialogElement.prototype;
  Object.defineProperties(dialogProto, {
    show: {
      configurable: true,
      writable: true,
      value: function show(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    showModal: {
      configurable: true,
      writable: true,
      value: function showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      writable: true,
      value: function close(this: HTMLDialogElement, returnValue?: string) {
        const wasOpen = this.hasAttribute('open');
        this.removeAttribute('open');
        if (returnValue !== undefined) {
          this.returnValue = returnValue;
        }
        if (wasOpen) {
          this.dispatchEvent(new Event('close'));
        }
      },
    },
  });
}

// Node 25+ exposes a broken `localStorage` getter unless `--localstorage-file` is
// set; that shadows jsdom's implementation and makes `window.localStorage` undefined.
const localStorageWorks =
  typeof globalThis.localStorage?.getItem === 'function' && typeof globalThis.localStorage?.removeItem === 'function';
if (!localStorageWorks) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
}
