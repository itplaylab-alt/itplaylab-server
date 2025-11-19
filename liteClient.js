// liteClient.js
// ItplayLab LITE GPT 클라이언트 (Responses API + gpt-4o-mini)

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LITE_SYSTEM_PROMPT = process.env.LITE_SYSTEM_PROMPT;

/**
 * LITE 모드 GPT 호출
 * @param {string} task - "brief" | "script" | "report" ...
 * @param {object} input - 작업별 입력 데이터
 * @param {object} meta - { user_id?, request_id?, lang?, brand? ... }
 * @returns {Promise<object>} - LITE 엔진의 JSON 응답
 */
export async function callLiteGPT(task, input = {}, meta = {}) {
  const body = {
    mode: "LITE",
    task,
    meta: {
      lang: "ko",
      brand: "ItplayLab",
      request_id: new Date().toISOString(),
      ...meta,
    },
    input,
  };

  const startedAt = Date.now();

  let response;
  try {
    response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: [{ type: "text", text: LITE_SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [{ type: "text", text: JSON.stringify(body) }],
        },
      ],
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      task,
      mode: "LITE",
      error: {
        code: "OPENAI_ERROR",
        message: error.message,
      },
      debug: {
        engine: "gpt-4o-mini",
        latency_ms: latencyMs,
      },
    };
  }

  const latencyMs = Date.now() - startedAt;

  let parsed;
  try {
    const text = response.output[0].content[0].text;
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      task,
      mode: "LITE",
      error: {
        code: "PARSE_ERROR",
        message: error.message,
      },
      debug: {
        engine: "gpt-4o-mini",
        latency_ms: latencyMs,
      },
    };
  }

  if (!parsed.debug) {
    parsed.debug = {};
  }
  parsed.debug.engine = "gpt-4o-mini";
  parsed.debug.latency_ms = latencyMs;

  // 안전장치: task / mode 없으면 채워주기
  if (!parsed.task) parsed.task = task;
  if (!parsed.meta) parsed.meta = {};
  if (!parsed.meta.mode) parsed.meta.mode = "LITE";

  return parsed;
}
