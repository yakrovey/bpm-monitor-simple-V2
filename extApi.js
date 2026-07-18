// Единый API для Chrome / Edge / Яндекс / Firefox / Safari (Web Extension).
export const ext = globalThis.browser ?? globalThis.chrome;

if (!ext?.runtime) {
  throw new Error('WebExtension API недоступен в этом браузере');
}
