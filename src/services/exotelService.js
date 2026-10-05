import { env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

/**
 * Checks whether Exotel outbound telephony credentials and ExoPhone are configured.
 */
export function isExotelConfigured() {
  const missing = [];
  if (!env.EXOTEL_ACCOUNT_SID) missing.push("EXOTEL_ACCOUNT_SID");
  if (!env.EXOTEL_API_KEY) missing.push("EXOTEL_API_KEY");
  if (!env.EXOTEL_API_TOKEN) missing.push("EXOTEL_API_TOKEN");
  if (!env.EXOTEL_EXOPHONE) missing.push("EXOTEL_EXOPHONE");

  return {
    configured: missing.length === 0,
    missing,
    subDomain: env.EXOTEL_SUB_DOMAIN || "api.exotel.com",
    exoPhone: env.EXOTEL_EXOPHONE || null,
    accountSid: env.EXOTEL_ACCOUNT_SID || null,
  };
}

/**
 * Normalizes phone numbers for Exotel India PSTN format.
 * Converts 10-digit Indian mobile numbers into standard dialable format.
 */
export function normalizePhoneForExotel(phone) {
  if (!phone || typeof phone !== "string") return "";
  let cleaned = phone.trim().replace(/[\s\-()]/g, "");

  // If already starts with +91 or 91 with 10 digits following:
  if (cleaned.startsWith("+91") && cleaned.length === 13) {
    return cleaned.slice(1); // "91XXXXXXXXXX" or "0XXXXXXXXXX"
  }
  if (cleaned.startsWith("91") && cleaned.length === 12) {
    return cleaned;
  }
  // Standard 10-digit Indian mobile
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `0${cleaned}`;
  }
  return cleaned;
}

/**
 * Initiates a real outbound call using Exotel Calls API (v1/Accounts/{AccountSid}/Calls/connect.json).
 *
 * @param {Object} params
 * @param {string} params.toPhone - The destination visitor phone number to call.
 * @param {Object} [params.customData] - Optional metadata/tags.
 * @returns {Promise<{ success: boolean, callSid: string, status: string, dateCreated: string, raw: Object }>}
 */
export async function createExotelOutboundCall({ toPhone, customData = {} }) {
  const check = isExotelConfigured();
  if (!check.configured) {
    throw new HttpError(
      503,
      `Exotel telephony configuration is missing on server: ${check.missing.join(", ")}. Please configure Exotel credentials in backend environment.`,
    );
  }

  const normalizedTo = normalizePhoneForExotel(toPhone);
  if (!normalizedTo) {
    throw new HttpError(
      422,
      "Please provide a valid destination phone number for Exotel call.",
    );
  }

  const subDomain = env.EXOTEL_SUB_DOMAIN || "api.exotel.com";
  const accountSid = env.EXOTEL_ACCOUNT_SID;
  const apiKey = env.EXOTEL_API_KEY;
  const apiToken = env.EXOTEL_API_TOKEN;
  const exoPhone = env.EXOTEL_EXOPHONE;

  const endpoint = `https://${subDomain}/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/connect.json`;

  const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString("base64")}`;

  const formBody = new URLSearchParams({
    From: normalizedTo,
    To: exoPhone,
    CallerId: exoPhone,
    CallType: "trans",
    TimeLimit: "1800",
    TimeOut: "30",
  });

  if (customData.customField) {
    formBody.append("CustomField", String(customData.customField));
  }
  if (customData.statusCallback) {
    formBody.append("StatusCallback", String(customData.statusCallback));
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const restException = payload?.RestException || payload?.rest_exception;
      const errorMsg =
        restException?.Message ||
        restException?.message ||
        payload?.message ||
        `Exotel HTTP ${response.status}: ${response.statusText}`;

      const statusCode =
        response.status === 401 || response.status === 403
          ? 502
          : response.status;
      throw new HttpError(statusCode, `Exotel Provider Error: ${errorMsg}`);
    }

    const callData = payload?.Call || payload?.call || payload;
    const callSid = callData?.Sid || callData?.sid || `exotel_${Date.now()}`;
    const status = callData?.Status || callData?.status || "queued";

    return {
      success: true,
      callSid,
      status,
      dateCreated:
        callData?.DateCreated ||
        callData?.date_created ||
        new Date().toISOString(),
      from: callData?.From || normalizedTo,
      to: callData?.To || exoPhone,
      raw: callData,
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      `Failed to connect to Exotel Telephony API: ${err.message || "Network Error"}`,
    );
  }
}
