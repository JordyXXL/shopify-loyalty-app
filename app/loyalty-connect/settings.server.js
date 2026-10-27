/**
 * A tenant's Loyalty Connect settings (table LoyaltyConnectSettings, one row per tenant): on/off, the public key (cs_pub_, for the
 * web pixel) and the secret source key (cs_sec_, for the server API), both encrypted at rest (crypto.server.js), plus the status the
 * admin screen shows. Off, or no readable key: nothing is sent.
 */
import { encrypt, encryptionReady, tryDecrypt } from "./crypto.server.js";
import { PUBLIC_KEY_RE, SECRET_KEY_RE } from "./config.server.js";

export const publicKeyLabel = (tenantId) => `loyalty-connect:public-key:tenant:${tenantId}`;
export const secretKeyLabel = (tenantId) => `loyalty-connect:secret-key:tenant:${tenantId}`;
export const queueLabel = (tenantId) => `loyalty-connect:queue:tenant:${tenantId}`;

/** "cs_sec_…f3a9": enough to recognise a key, never enough to use it. */
export const keyHint = (key) => (key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null);

/**
 * The settings Loyalty Connect works with for a shop's webhook, or undefined. `live`: switched on and the tenant is active.
 * forErase: also a tenant that is switched off but delivered to Loyalty Connect before (an erasure must still reach what was sent).
 */
export async function settingsForShop(db, shop, { forErase = false } = {}) {
  const rows = await db.loyaltyConnectSettings.findMany({ where: { shopDomain: shop }, include: { tenant: true }, orderBy: { id: "asc" } });
  for (const row of rows) {
    if (!row.tenant || row.tenant.shopDomain !== shop) continue;
    const live = Boolean(row.enabled && row.tenant.isActive);
    if (!live && !(forErase && row.lastDeliveryAt)) continue;
    const secretKey = tryDecrypt(row.secretKeyEnc, secretKeyLabel(row.tenantId));
    if (!secretKey) {
      console.warn(`[LoyaltyConnect] tenant ${row.tenantId}: the secret key cannot be read (missing or changed LOYALTY_CONNECT_ENCRYPTION_KEY?); nothing is sent`);
      continue;
    }
    return { row, tenant: row.tenant, secretKey, live, domain: row.storefrontDomain || shop };
  }
  return undefined;
}

/**
 * Saves the settings from the admin screen. An empty secret key keeps the stored one. Switching on needs both keys, and only one
 * tenant per shop can have Loyalty Connect on (a shop has one web pixel of this app).
 */
export async function saveSettings(db, tenant, input) {
  const enabled = input.enabled === true;
  const publicKey = String(input.publicKey ?? "").trim();
  const secretKey = String(input.secretKey ?? "").trim();
  // switching off always works; storing a key needs the encryption key
  if ((publicKey || secretKey) && !encryptionReady()) return { ok: false, message: "LOYALTY_CONNECT_ENCRYPTION_KEY is not set on the server: keys cannot be stored." };
  if (publicKey && !PUBLIC_KEY_RE.test(publicKey)) return { ok: false, message: "The public key must look like cs_pub_… (from the source in Loyalty Connect)." };
  if (secretKey && !SECRET_KEY_RE.test(secretKey)) return { ok: false, message: "The secret source key must look like cs_sec_… (from the source in Loyalty Connect)." };
  const existing = await db.loyaltyConnectSettings.findFirst({ where: { tenantId: tenant.id } });
  const hasSecret = Boolean(secretKey || tryDecrypt(existing?.secretKeyEnc, secretKeyLabel(tenant.id)));
  if (enabled && (!publicKey || !hasSecret)) return { ok: false, message: "Switching Loyalty Connect on needs the public key and the secret source key." };
  if (enabled) {
    const other = await db.loyaltyConnectSettings.findFirst({ where: { shopDomain: tenant.shopDomain, enabled: true, tenantId: { not: tenant.id } } });
    if (other) return { ok: false, message: "Loyalty Connect is already on for another tenant of this shop. Switch it off there first." };
  }
  const data = {
    shopDomain: tenant.shopDomain,
    enabled,
    publicKeyEnc: publicKey ? encrypt(publicKey, publicKeyLabel(tenant.id)) : null,
    ...(secretKey ? { secretKeyEnc: encrypt(secretKey, secretKeyLabel(tenant.id)), secretKeyHint: keyHint(secretKey) } : {}),
    ...(input.storefrontDomain ? { storefrontDomain: String(input.storefrontDomain).slice(0, 191) } : {}),
  };
  const row = existing
    ? await db.loyaltyConnectSettings.update({ where: { id: existing.id }, data })
    : await db.loyaltyConnectSettings.create({ data: { tenantId: tenant.id, ...data } });
  return { ok: true, row };
}

/** What the admin screen may see of a row: never a secret, never an encrypted value. */
export function settingsView(row, counts = {}) {
  const publicKey = row ? tryDecrypt(row.publicKeyEnc, publicKeyLabel(row.tenantId)) ?? null : null;
  const secretReadable = row ? Boolean(tryDecrypt(row.secretKeyEnc, secretKeyLabel(row.tenantId))) : false;
  return {
    configured: Boolean(row),
    enabled: Boolean(row?.enabled),
    publicKey,
    secretKeyHint: row?.secretKeyHint ?? null,
    hasSecretKey: Boolean(row?.secretKeyEnc),
    keysReadable: !row || ((!row.publicKeyEnc || Boolean(publicKey)) && (!row.secretKeyEnc || secretReadable)),
    storefrontDomain: row?.storefrontDomain ?? null,
    pixelStatus: row?.pixelStatus ?? null,
    pixelError: row?.pixelError ?? null,
    pixelUpdatedAt: row?.pixelUpdatedAt ?? null,
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? null,
    lastDeliveryAt: row?.lastDeliveryAt ?? null,
    lastDeliveryStatus: row?.lastDeliveryStatus ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
    lastError: row?.lastError ?? null,
    counts: { PENDING: 0, PROCESSING: 0, DONE: 0, FAILED: 0, SKIPPED: 0, ...counts },
  };
}
