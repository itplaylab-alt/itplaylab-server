// services/gasLogger.js
import fetch from "node-fetch";
import { CONFIG } from "../lib/config.js";

/**
 * GAS 스프레드시트 로깅 서비스
 * - logToSheet(type, input_text, output_text, meta)
 */
export async function logToSheet(payload = {}) {
  try {
    if (!CONFIG.GAS_INGEST_URL || !CONFIG.INGEST_TOKEN) {
      console.warn("⚠️ GAS 로깅이 비활성화됨: 환경변수 없음");
      return { ok: false, disabled: true };
    }

    const res = await fetch(CONFIG.GAS_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    console.error("🚨 GAS 로깅 오류:", err);
    return { ok: false, error: err.message };
  }
}
