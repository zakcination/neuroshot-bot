/**
 * Server-side Kaspi payment verification — the "pull" half of removing manual
 * approval (the "push" half is the signed /api/kaspi/callback webhook in
 * webapp.ts). When the merchant REST API is configured (KASPI_API_BASE +
 * KASPI_API_TOKEN), we QUERY the real status of an order straight from Kaspi, so
 * «Я оплатил» becomes a genuine server check instead of a trusted button, and a
 * confirmed payment auto-grants patrons via the shared grantPurchase path.
 *
 * ⚠️ The exact status endpoint, auth scheme, and response field names differ by
 * Kaspi merchant-integration tier and must be confirmed against the live docs
 * before enabling (see docs/kaspi.md). Until KASPI_API_BASE/TOKEN are set this
 * returns "unknown" and the caller falls back to admin approval — so shipping it
 * dark is safe.
 */
import { config } from "./config.js";
import type { OrderRow } from "./db.js";

export type KaspiStatus = "paid" | "pending" | "failed" | "unknown";

/** Map Kaspi's reported status strings onto our coarse states. */
function classify(raw: string): KaspiStatus {
  const s = raw.toLowerCase();
  if (["paid", "success", "completed", "approved", "processed", "captured"].includes(s)) return "paid";
  if (["failed", "declined", "canceled", "cancelled", "error", "rejected"].includes(s)) return "failed";
  if (!s) return "unknown";
  return "pending";
}

/**
 * Ask Kaspi for the real status of one order. Returns "unknown" (never throws)
 * when the API isn't configured or the request fails, so the caller can fall
 * back to the interim admin-approval path.
 */
export async function kaspiVerifyOrder(order: OrderRow): Promise<KaspiStatus> {
  if (!config.kaspiApiBase || !config.kaspiApiToken) return "unknown";
  try {
    // Convention: GET {base}/payments/{orderId} with a Bearer token. Adjust the
    // path/params to Kaspi's actual status endpoint on integration.
    const res = await fetch(`${config.kaspiApiBase}/payments/${order.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.kaspiApiToken}`, Accept: "application/json" },
    });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { status?: string; state?: string; amount?: number };
    // If Kaspi returns an amount, it must match what we recorded for the order.
    if (data.amount != null && Number(data.amount) !== order.amount_kzt) return "failed";
    return classify(String(data.status ?? data.state ?? ""));
  } catch {
    return "unknown";
  }
}
