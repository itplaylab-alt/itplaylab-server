// liteClient.js — ItplayLab LITE 엔진 전용 클라이언트
// 역할: LITE_SYSTEM_PROMPT + gpt-4o-mini 사용해서 빠른 JSON 응답 생성

import OpenAI from "openai";

const {
  OPENAI_API_KEY,
  LITE_SYSTEM_PROMPT,
  LITE_MODEL = "gpt-4o-mini",
} = process.env;

const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * LITE 전용 호출자
 * @param {string} task  - "brief" | "script" 등 작업명
 * @param {any} payload  - 실제 입력 데이터 (idea, brief 등)
 * @param {object} meta  - pattern_hint 등 부가 메타
 */
export async function callLiteGPT(task, payload = {}, meta = {}) {
  const started = Date.now();

  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      output: null,
      error: {
        code: "NO_API_KEY",
        message: "OPENAI_API_KEY missing",
      },
      debug: {
        engine: LITE_MODEL,
        latency_ms: 0,
      },
    };
  }

  const systemPrompt =
    LITE_SYSTEM_PROMPT ||
    "너는 ItplayLab LITE 엔진이다. 항상 JSON 하나만 반환하라.";

  // user 쪽에 전달할 페이로드(문자열)
  const userInput = JSON.stringify({
    task,
    input: payload,
    meta,
  });

  try {
    // 🔑 여기서 Responses API 규격을 맞춤
    const resp = await oa.responses.create({
      model: LITE_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              // *** 중요: Responses는 type: "input_text" 여야 함 ***
              type: "input_text",
              text: systemPrompt,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userInput,
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    // 텍스트 꺼내기 (Responses 표준)
    const txt =
      resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || "";

    let parsed;
    try {
      parsed = txt ? JSON.parse(txt) : null;
    } catch (e) {
      return {
        ok: false,
        output: null,
        error: {
          code: "JSON_PARSE_ERROR",
          message: e.message,
          raw: txt,
        },
        debug: {
          engine: LITE_MODEL,
          latency_ms: Date.now() - started,
        },
      };
    }

    // LITE_SYSTEM_PROMPT에서 정의한 최상위 구조를 그대로 받는 걸 가정:
    // { task, ok, output, meta, debug }
    const outerOk =
      typeof parsed?.ok === "boolean" ? parsed.ok : true;

    return {
      ok: outerOk,
      output: parsed?.output ?? parsed,
      error: outerOk ? null : parsed?.error ?? null,
      debug: {
        engine:
          parsed?.debug?.engine ||
          resp?.model ||
          LITE_MODEL,
        latency_ms:
          parsed?.debug?.latency_ms ||
          Date.now() - started,
      },
    };
  } catch (e) {
    return {
      ok: false,
      output: null,
      error: {
        code: "OPENAI_ERROR",
        message: e?.message || "unknown_openai_error",
        details: e?.response?.data,
      },
      debug: {
        engine: LITE_MODEL,
        latency_ms: Date.now() - started,
      },
    };
  }
}
