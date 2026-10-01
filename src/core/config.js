/** Four Flavours global configuration. */
export const APP_VERSION = "2.0.0";
export const VERSION_SUFFIX = `?v=${encodeURIComponent(APP_VERSION)}`;

export const ROUTES = Object.freeze({
  POS: "/",
  ADMIN: "#/4",
  CUSTOMER: "?table="
});

/**
 * Canonical public URL for Four Flavours.
 *
 * IMPORTANT:
 * This is intentionally NOT derived from window.location.origin.
 * Admin users may generate QR codes while working from localhost or a
 * Vercel preview deployment. Printed QR codes must ALWAYS point to the
 * live production restaurant URL.
 */
export const PUBLIC_APP_URL = "https://tff.vercel.app";

/**
 * Creates the permanent customer menu URL for a table.
 *
 * Example:
 * https://tff.vercel.app/?table=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export function getCustomerTableUrl(tableId) {
  const id = String(tableId ?? "").trim();

  if (!id) {
    throw new Error("A valid table ID is required to create the QR URL.");
  }

  return `${PUBLIC_APP_URL}/?table=${encodeURIComponent(id)}`;
}

export const DEFAULT_SETTINGS = Object.freeze({
  restaurant_name: "Four Flavours",
  upi_id: "",
  cgst_rate: 2.5,
  sgst_rate: 2.5,
  currency_symbol: "₹",
  receipt_footer: "Thank you. Visit again."
});

export function getRuntimeConfig() {
  const runtime = globalThis.__SAVRIVO_CONFIG__ ?? {};
  return {
    SUPABASE_URL: String(runtime.SUPABASE_URL ?? "").trim(),
    SUPABASE_ANON_KEY: String(runtime.SUPABASE_ANON_KEY ?? "").trim()
  };
}

export function versionedAsset(path) {
  if (!path) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}v=${encodeURIComponent(APP_VERSION)}`;
}

export function isConfigured() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getRuntimeConfig();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;
}
