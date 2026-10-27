/* global globalThis */
// The Loyalty Connect web pixel: Shopify's storefront and checkout events to Loyalty Connect's collector. Runs in Shopify's strict
// sandbox (a web worker). Shopify loads it only after the visitor granted analytics and marketing. It must never throw: a pixel
// error can disturb the shop. The mapping is in ./payload.js (pure, tested by the app's test suite).
import { register } from "@shopify/web-pixels-extension";
import { body, buildEvent, endpointOf, sessionIds, SUBSCRIBED } from "./payload.js";

function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => (x + 256).toString(16).slice(1)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

register(({ analytics, browser, settings }) => {
  const endpoint = endpointOf(settings);
  if (!endpoint) return; // installed, but the app has not written the settings yet

  // one event at a time: two events at the same moment must not both create a visitor id
  let chain = Promise.resolve();
  const send = (event) => {
    chain = chain.then(async () => {
      try {
        const ids = await sessionIds(browser.localStorage, browser.sessionStorage, Date.now(), uuid);
        const e = buildEvent(event, ids, uuid);
        if (!e) return;
        const payload = body([e]);
        if (browser.sendBeacon && (await browser.sendBeacon(endpoint, payload))) return;
        await fetch(endpoint, { method: "POST", body: payload, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" });
      } catch {
        // never disturb the storefront
      }
    });
  };
  for (const name of SUBSCRIBED) analytics.subscribe(name, send);
});
