// liteClient.js — LITE 엔진용 OpenAI 래퍼 (Responses API 최신 버전)

import OpenAI from "openai";

const oa = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LITE_MODEL = process.env.OPENAI_MODEL_LITE || "gpt-4o-mini";
const LITE_SYSTEM_PROMPT =
  process.env.LITE_SYSTEM_PROMPT ||
  "너는 ItplayLab 자동화 공정에서 동작하는 LITE 엔진이다. JSON 하나만 반환한다.";

/** Responses API용 input 포맷 생성 */
function buildInput(task, payload, meta) {
  return [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: LITE_SYSTEM_PROMPT,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            task,
            input: payload,
            meta,
          }),
        },
      ],
    },
  ];
}

/** Responses API 응답에서 텍스트만 뽑기 (output_text 기준) */
function extractOutputText(resp) {
  try {
    const contents = resp?.output?.[0]?.content || [];
    for (const part of contents) {
      // 새 포맷: type === "output_text"
      if (part.type === "output_text") {
        if (typeof part.text === "string") return part.text;

        // SDK/버전별 약간의 차이를 방어적으로 처리
        if (typeof part.output_text?.text === "string") {
          return part.output_text.text;
        }
        if (Array.isArray(part.output_text?.content)) {
          const first = part.output_text.content.find(
            (c) => typeof c.text === "string"
          );
          if (first) return first.text;
        }
      }

      // 혹시 옛 포맷(그냥 text 필드)일 경우 대비
      if (typeof part.text === "string") return part.text;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * LITE 엔진 호출
 * @param {string} task - "brief" | "script" 등
 * @param {any} payload - 입력 데이터 (아이디어, 브리프 등)
 * @param {object} meta  - 추가 메타정보
 */
export async function callLiteGPT(task, payload = {}, meta = {}) {
  const started = Date.now();

  try {
    const resp = await oa.responses.create({
      model: LITE_MODEL,
      input: buildInput(task, payload, meta),
      temperature: 0.2,
      // ⚠️ 여기에는 response_format / output_format 안 씀
      // LITE는 시스템 프롬프트만으로 JSON을 강제함
    });

    const latency_ms = Date.now() - started;
    const txt = extractOutputText(resp);

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
