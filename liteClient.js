// liteClient.js — 최신 Responses API 완전 호환 버전

import OpenAI from "openai";

const oa = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LITE_MODEL = process.env.OPENAI_MODEL_LITE || "gpt-4o-mini";
const LITE_SYSTEM_PROMPT =
  process.env.LITE_SYSTEM_PROMPT ||
  "너는 ItplayLab 자동화 공정에서 동작하는 LITE 엔진이다. JSON 하나만 반환한다.";

export async function callLiteGPT(task, payload = {}, meta = {}) {
  const started = Date.now();

  try {
    const resp = await oa.responses.create({
      model: LITE_MODEL,

      input: [
        {
          role: "system",
          content: [
            { type: "input_text", text: LITE_SYSTEM_PROMPT },
          ]
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
              })
            }
          ]
        }
      ],

      response: {
        format: {
          type: "json_object"   // ⬅️ 최신 Responses API 규칙
        }
      },

      temperature: 0.2,
    });

    const latency_ms = Date.now() - started;

    const txt = resp?.output_text || "";

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
        raw: resp,
      },
    };

  } catch (e) {
    const latency_ms = Date.now() - started;
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
