// liteClient.js — LITE 엔진용 OpenAI 래퍼 (Responses API 최신 버전)

import OpenAI from "openai";

const oa = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LITE_MODEL = process.env.OPENAI_MODEL_LITE || "gpt-4o-mini";
const LITE_SYSTEM_PROMPT =
  process.env.LITE_SYSTEM_PROMPT ||
  "너는 ItplayLab 자동화 공정에서 동작하는 LITE 엔진이다. JSON 하나만 반환한다.";

/**
 * LITE 엔진 호출
 * @param {string} task - "brief" | "script" 등
 * @param {any} payload - 입력 데이터 (아이디어, 브리프 등)
 * @param {object} meta - 추가 메타정보
 */
export async function callLiteGPT(task, payload = {}, meta = {}) {
  const started = Date.now();

  try {
    const resp = await oa.responses.create({
      model: LITE_MODEL,
      input: [
        {
          role: "system",
          content: LITE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            task,
            input: payload,
            meta,
          }),
        },
      ],
      temperature: 0.2,
    });

    const latency_ms = Date.now() - started;

    const txt =
      resp?.output_text ||
      resp?.output?.[0]?.content?.[0]?.text ||
      "";

    if (!txt) {
      return {
        ok: false,
        output: null,
        error: "empty_response",
        debug: {
          engine: LITE_MODEL,
          latency_ms,
          raw_response: resp,
        },
      };
    }

    let parsed = null;
    let ok = true;
    let error = null;

    try {
      parsed = JSON.parse(txt);
    } catch {
      ok = false;
      error = "json_parse_failed";
    }

    return {
      ok,
      output: parsed || txt,
      error,
      debug: {
        engine: LITE_MODEL,
        latency_ms,
        raw_response: resp,
      },
    };
  } catch (e) {
    const latency_ms = Date.now() - started;
    console.error("[callLiteGPT] error:", e?.message || e);
    return {
      ok: false,
      output: null,
      error: e?.message || String(e),
      debug: {
        engine: LITE_MODEL,
        latency_ms,
      },
    };
  }
}
