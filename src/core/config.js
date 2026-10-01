/** Four Flavours global configuration. */
export const APP_VERSION = "2.0.0";
export const VERSION_SUFFIX = `?v=${encodeURIComponent(APP_VERSION)}`;

export const ROUTES = Object.freeze({
  POS: "/",
  ADMIN: "#/4",
  CUSTOMER: "?table="
});

/**
 * Canonical production URL.
 *
 * Never generate printed QR codes from window.location.origin because that
 * would allow localhost / Vercel preview URLs to accidentally become
 * permanent restaurant QR destinations.
 */
export const PUBLIC_APP_URL = "https://four-flavours.vercel.app";

/**
 * Returns the permanent customer menu URL for a specific table.
 *
 * Example:
 * https://four-flavours.vercel.app/?table=<TABLE_UUID>
 */
export function getCustomerTableUrl(tableId) {
  const id = String(tableId ?? "").trim();

  if (!id) {
    throw new Error(
      "A valid table ID is required to generate a QR code."
    );
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
