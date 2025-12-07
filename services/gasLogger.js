// services/gasLogger.js
import axios from "axios";
import { CONFIG } from "../lib/config.js";

const { GAS_INGEST_URL, INGEST_TOKEN, PROJECT, SERVICE_NAME } = CONFIG;

/**
 * GAS 스프레드시트 로깅 서비스
 * - 기존 index.js 의 logToSheet 그대로 옮긴 버전
 */
export async function logToSheet(payload = {}) {
  const t0 = Date.now();
  if (!GAS_INGEST_URL || !INGEST_TOKEN) {
    return { ok: false, skipped: true };
  }

  try {
    await axios.post(GAS_INGEST_URL, {
      token: INGEST_TOKEN,
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        chat_id: String(payload.chat_id ?? "system"),
        username: String(payload.username ?? "render_system"),
        type: String(payload.type ?? "system_log"),
        input_text: String(payload.input_text ?? ""),
        output_text:
          typeof payload.output_text === "string"
            ? payload.output_text
            : JSON.stringify(payload.output_text ?? ""),
        source: String(payload.source ?? "Render"),
        note: String(payload.note ?? ""),
        project: String(payload.project ?? PROJECT),
        category: String(payload.category ?? "system"),
        service: String(SERVICE_NAME),
        latency_ms: payload.latency_ms ?? 0,
        trace_id: payload.trace_id || "",
        step: payload.step || "",
        ok: typeof payload.ok === "boolean" ? payload.ok : "",
        error: payload.error || "",
        provider: payload.provider || "",
        revision_count:
          typeof payload.revision_count === "number"
            ? payload.revision_count
            : "",
      }),
    });

    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    console.error("❌ GAS log fail:", e?.message);
    return {
      ok: false,
      error: e?.message,
      latency_ms: Date.now() - t0,
    };
  }
}
