// liteClient.js — LITE 엔진용 OpenAI 래퍼 (chat.completions + json_object)

import OpenAI from "openai";

const oa = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LITE_MODEL = process.env.OPENAI_MODEL_LITE || "gpt-4o-mini";

// Render 대시보드에 넣어둔 긴 한글 프롬프트 그대로 사용
// (지금 LITE_SYSTEM_PROMPT 환경변수에 등록해 둔 그 텍스트)
const LITE_SYSTEM_PROMPT =
  process.env.LITE_SYSTEM_PROMPT ||
  "너는 ItplayLab 자동화 공정에서 동작하는 LITE 엔진이다. JSON 하나만 반환한다.";

/**
 * LITE 엔진 호출
 * @param {string} task - "brief" | "script" | "copy" ...
 * @param {any} payload - 입력 데이터 (아이디어, 브리프 등)
 * @param {object} meta  - 추가 메타정보
 */
export async function callLiteGPT(task, payload = {}, meta = {}) {
  const started = Date.now();

  try {
    // 모델이 참고할 유저 입력 래핑
    const userPayload = {
      task,
      input: payload,
      meta,
    };

    const comp = await oa.chat.completions.create({
      model: LITE_MODEL,
      response_format: { type: "json_object" }, // ✅ JSON 강제
      messages: [
        {
          role: "system",
          content: LITE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          // 프롬프트에서 "입력은 JSON으로 온다"고 가정했으니 실제로도 JSON 문자열로 보냄
          content: JSON.stringify(userPayload),
        },
      ],
      temperature: 0.2,
    });

    const latency_ms = Date.now() - started;

    const txt = comp.choices?.[0]?.message?.content?.trim() || "";

    let parsed = null;
    let ok = true;
    let error = null;

    try {
      parsed = JSON.parse(txt);
    } catch (e) {
      ok = false;
      error = "json_parse_failed";
      console.error("[callLiteGPT] JSON parse failed:", txt);
    }

    return {
      ok,
      output: parsed || txt,
      error,
      debug: {
        engine: LITE_MODEL,
        latency_ms,
        raw_text: txt,
      },
    };
  } catch (e) {
    const latency_ms = Date.now() - started;
    console.error("[callLiteGPT] error:", e?.response?.data || e?.message || e);
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
