/**
 * Drives `document.visibilityState` and `visibilitychange` for hidden-tab tests.
 * jsdom exposes `visibilityState` on the prototype, so this shadows it with an own
 * property and `restore()` removes the shadow to bring back the jsdom default.
 */
export function stubVisibility() {
  let state: 'visible' | 'hidden' = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  return {
    hide() {
      state = 'hidden';
    },
    show() {
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    restore() {
      Reflect.deleteProperty(document, 'visibilityState');
    },
  };
}
