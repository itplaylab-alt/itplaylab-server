// index.js — ITPlayLab 통합본 (승인 루프 + 기존 Render→GAS 브리지 병합)
// ────────────────────────────────────────────────────────────
// 기존 코드(요청 로깅/GAS 로깅/Telegram 알림/Responses API) +
// 승인 루프(/approve,/reject,/status) + 통합 파이프라인(/content/run)
// 한 파일로 복붙하여 바로 구동 가능한 형태
// Node.js 18+, Express, axios, openai
// ────────────────────────────────────────────────────────────

import express from "express";
import axios from "axios";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

/* ────────────────────────────────────────────────────────────
   0) 요청 로깅 + Content-Type 확인 (가장 위, 미들웨어들보다 먼저)
──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  console.log(
    `[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers["content-type"] || ""}`
  );
  next();
});

/* ────────────────────────────────────────────────────────────
   1) 바디 파서 (JSON) — 용량 제한 및 타입 지정
──────────────────────────────────────────────────────────── */
app.use(express.json({ limit: "1mb", type: ["application/json"] }));

/* JSON 파싱 에러를 400으로 돌려보내기 */
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res
      .status(400)
      .json({ ok: false, error: "invalid_json", detail: err.message });
  }
  next();
});

/* 디버그용 에코 엔드포인트 (본문/헤더 그대로 보기) */
app.post("/debug/echo", (req, res) => {
  console.log("[ECHO]", req.body);
  res.json({ ok: true, headers: req.headers, body: req.body });
});

// ========== ENV ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const GAS_INGEST_URL = process.env.GAS_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const PROJECT = process.env.PROJECT || "itplaylab";
const SERVICE_NAME = process.env.SERVICE_NAME || "render-bot";
const APPROVAL_MODE = String(process.env.APPROVAL_MODE || "true").toLowerCase() === "true"; // 단계별 승인 대기

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// OpenAI Client
const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========== 공통 유틸 ==========
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();

// 공통: GAS 로깅
async function logToSheet(payload) {
  const t0 = Date.now();
  if (!GAS_INGEST_URL) return { ok: false, skipped: true };
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
      }),
    });
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    console.error("❌ GAS log fail:", e?.message);
    return { ok: false, error: e?.message, latency_ms: Date.now() - t0 };
  }
}

// 공통: 텔레그램 전송
async function tgSend(chatId, text, parse_mode = "HTML") {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    return await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("Telegram send error:", e?.message);
  }
}

// 메시지 포맷
function buildNotifyMessage({ type, title, message }) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  if (type === "success") return `✅ <b>${title || "성공"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "error") return `❌ <b>${title || "오류"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "approval") return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n⏱ ${ts}`;
}

const shouldNotify = (kind) => NOTIFY_LEVEL.includes(kind);

function requireOpenAI(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
    return false;
  }
  return true;
}

// ========== 헬스체크/테스트 ==========
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render → GAS Bridge + Notify + Approval Loop",
    status: "Render is alive ✅",
    timestamp: new Date().toISOString(),
    approval_mode: APPROVAL_MODE,
  });
});

app.get("/test/send-log", async (req, res) => {
  try {
    const payload = {
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
    };
    const r = await logToSheet(payload);
    res.json({ ok: true, sent_to_gas: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.get("/test/notify", async (req, res) => {
  try {
    const type = String(req.query.type || "success").toLowerCase();
    const title = String(req.query.title || "");
    const message = String(req.query.message || "");

    if (!shouldNotify(type)) {
      return res.json({ ok: true, sent: false, reason: "filtered_by_NOTIFY_LEVEL" });
    }

    const text = buildNotifyMessage({ type, title, message });
    await tgSend(TELEGRAM_ADMIN_CHAT_ID, text);

    await logToSheet({
      type: `notify_${type}`,
      input_text: title,
      output_text: message,
      project: PROJECT,
      category: "notify",
      note: "notify_test",
    });

    res.json({ ok: true, sent: true, type });
  } catch (e) {
    console.error("❌ notify error:", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ========== OpenAI 작업자 (Responses API + JSON Schema) ==========
async function aiBrief(idea) {
  const t0 = Date.now();
  const response_format = {
    type: "json_schema",
    json_schema: {
      name: "content_brief",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          brief_id: { type: "string" },
          idea_id: { type: "string" },
          goal: { type: "string" },
          key_points: { type: "array", items: { type: "string" } },
          hook: { type: "string" },
          outline: {
            type: "array",
            items: {
              type: "object",
              properties: { sec: { type: "number" }, beat: { type: "string" } },
              required: ["sec", "beat"],
            },
          },
          channels: { type: "array", items: { type: "string" } },
          due_date: { type: "string" },
          owner: { type: "string" },
        },
        required: ["brief_id", "goal", "outline"],
      },
    },
  };

  const messages = [
    { role: "system", content: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 작성하라." },
    { role: "user", content: JSON.stringify(idea) },
  ];

  const resp = await oa.responses.create({ model: OPENAI_MODEL, input: messages, response_format });
  const raw = resp?.output_text || "";
  const brief = raw ? JSON.parse(raw) : { fallback: true };
  return { ok: true, latency_ms: Date.now() - t0, data: brief };
}

async function aiScript(brief) {
  const t0 = Date.now();
  const response_format = {
    type: "json_schema",
    json_schema: {
      name: "content_script",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          brief_id: { type: "string" },
          lang: { type: "string" },
          shots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                t_start: { type: "number" },
                t_end: { type: "number" },
                narration: { type: "string" },
                overlay_text: { type: "string" },
                asset_hint: { type: "string" },
              },
              required: ["t_start", "t_end", "narration"],
            },
          },
        },
        required: ["brief_id", "shots"],
      },
    },
  };

  const messages = [
    { role: "system", content: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게." },
    { role: "user", content: JSON.stringify(brief) },
  ];

  const resp = await oa.responses.create({ model: OPENAI_MODEL, input: messages, response_format });
  const raw = resp?.output_text || "";
  const script = raw ? JSON.parse(raw) : { fallback: true };
  return { ok: true, latency_ms: Date.now() - t0, data: script };
}

async function aiAssets({ brief_id, script }) {
  const t0 = Date.now();
  const response_format = {
    type: "json_schema",
    json_schema: {
      name: "content_assets",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          brief_id: { type: "string" },
          thumbnail_prompt: { type: "string" },
          titles: { type: "array", items: { type: "string" } },
          descriptions: { type: "array", items: { type: "string" } },
          hashtags: { type: "array", items: { type: "string" } },
        },
        required: ["brief_id", "thumbnail_prompt", "titles"],
      },
    },
  };

  const messages = [
    { role: "system", content: "너는 유튜브 운영자다. 썸네일 프롬프트와 제목/설명을 생성하라. 제목 3안, 해시태그 5개." },
    { role: "user", content: JSON.stringify({ brief_id, script }) },
  ];

  const resp = await oa.responses.create({ model: OPENAI_MODEL, input: messages, response_format });
  const raw = resp?.output_text || "";
  const assets = raw ? JSON.parse(raw) : { fallback: true };
  return { ok: true, latency_ms: Date.now() - t0, data: assets };
}

// ========== 상태 저장소 (in-memory) ==========
// 운영 환경에선 Redis/DB 권장
const traces = new Map();
/* 구조
traces.set(traceId, {
  id, createdAt, chatId, title, profile,
  steps: ["brief","script","assets"],
  currentIndex: 0,
  approvalMode: true,
  history: [ { step, ok, latency_ms, error, startedAt, finishedAt } ],
  lastOutput: { brief, script, assets },
  status: "initialized"|"running"|"paused"|"rejected"|"completed",
  rejectReason,
});
*/

// ========== 공정 실행기 ==========
async function executeStep(trace, stepName) {
  const startedAt = nowISO();
  let latency_ms = 0;
  try {
    let r;
    if (stepName === "brief") {
      r = await aiBrief({ title: trace.title, profile: trace.profile });
      trace.lastOutput.brief = r.data;
    } else if (stepName === "script") {
      r = await aiScript(trace.lastOutput.brief);
      trace.lastOutput.script = r.data;
    } else if (stepName === "assets") {
      r = await aiAssets({ brief_id: trace.lastOutput.brief?.brief_id, script: trace.lastOutput.script });
      trace.lastOutput.assets = r.data;
    } else {
      throw new Error(`unknown step: ${stepName}`);
    }
    latency_ms = r.latency_ms;

    trace.history.push({ step: stepName, ok: true, latency_ms, startedAt, finishedAt: nowISO() });

    // GAS 로그
    await logToSheet({
      type: `content_${stepName}`,
      input_text: trace.title,
      output_text: trace.lastOutput[stepName],
      project: PROJECT,
      category: stepName,
      note: `trace=${trace.id}`,
      latency_ms,
      trace_id: trace.id,
      step: stepName,
      ok: true,
    });

    if (shouldNotify("success")) {
      await tgSend(
        trace.chatId,
        buildNotifyMessage({ type: "success", title: `${stepName} 완료`, message: `trace_id: ${trace.id}\nlatency: ${latency_ms}ms` })
      );
    }

    return { ok: true, latency_ms };
  } catch (e) {
    const error = e?.message || String(e);
    trace.history.push({ step: stepName, ok: false, latency_ms, error, startedAt, finishedAt: nowISO() });

    await logToSheet({
      type: `content_${stepName}`,
      input_text: trace.title,
      output_text: { error },
      project: PROJECT,
      category: stepName,
      note: `trace=${trace.id}`,
      latency_ms,
      trace_id: trace.id,
      step: stepName,
      ok: false,
      error,
    });

    if (shouldNotify("error")) {
      await tgSend(
        trace.chatId,
        buildNotifyMessage({ type: "error", title: `${stepName} 실패`, message: `trace_id: ${trace.id}\n${error}` })
      );
    }
    throw e;
  }
}

const getNextStep = (trace) => (trace.currentIndex + 1 < trace.steps.length ? trace.steps[trace.currentIndex + 1] : null);

async function pauseForApproval(trace) {
  const next = getNextStep(trace);
  if (!next) {
    trace.status = "completed";
    if (shouldNotify("success")) await tgSend(trace.chatId, buildNotifyMessage({ type: "success", title: "모든 단계 완료", message: `trace_id: ${trace.id}` }));
    return;
  }
  trace.status = "paused";
  if (shouldNotify("approval")) {
    await tgSend(
      trace.chatId,
      buildNotifyMessage({
        type: "approval",
        title: `다음 단계 승인 대기: ${next}`,
        message: `trace_id: ${trace.id}\n승인: /approve ${trace.id} step=${next}\n반려: /reject ${trace.id} reason="사유"\n상태: /status ${trace.id}`,
      })
    );
  }
}

async function runFromCurrent(trace) {
  trace.status = "running";
  // 현재 인덱스의 스텝 1개 실행
  const stepName = trace.steps[trace.currentIndex];
  await executeStep(trace, stepName);

  // 승인 모드면 멈추고 다음 스텝 대기, 아니면 자동 인덱스 증가
  if (APPROVAL_MODE) {
    await pauseForApproval(trace);
  } else {
    trace.currentIndex += 1;
    if (trace.currentIndex < trace.steps.length) {
      await runFromCurrent(trace); // 재귀 진행
    } else {
      trace.status = "completed";
      if (shouldNotify("success")) await tgSend(trace.chatId, buildNotifyMessage({ type: "success", title: "모든 단계 완료", message: `trace_id: ${trace.id}` }));
    }
  }
}

// ========== 자연어 파서(경량) ==========
function parseFreeText(text) {
  const lower = text.toLowerCase();
  let intent = "run";
  let steps = ["brief", "script", "assets"];
  if (lower.includes("브리프")) { intent = "brief"; steps = ["brief"]; }
  if (lower.includes("스크립트")) { intent = "run_parts"; steps = ["script"]; }
  if (lower.includes("에셋") || lower.includes("메타")) { intent = "run_parts"; steps = ["assets"]; }
  const title = text.replace(/(브리프|스크립트|에셋|만들어줘|전체|전부|메타|전략)/g, "").trim() || "무제";
  const profileMatch = text.match(/profile=([\w-]+)/i);
  const profile = profileMatch ? profileMatch[1] : "-";
  return { intent, title, steps, profile };
}

// ========== REST: 콘텐츠 라인(단일 스텝) ==========
app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = req.body || {};
    if (!idea.title) return res.status(400).json({ ok: false, error: "title required" });
    const r = await aiBrief(idea);
    await logToSheet({ type: "content_brief", input_text: idea.title, output_text: r.data, project: PROJECT, category: "brief", note: `via /content/brief`, latency_ms: r.latency_ms, ok: true });
    res.json({ ok: true, latency_ms: Date.now() - t0, brief: r.data });
  } catch (e) {
    console.error("openai brief error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

app.post("/content/script", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const brief = req.body || {};
    const r = await aiScript(brief);
    await logToSheet({ type: "content_script", input_text: brief.brief_id || "", output_text: r.data, project: PROJECT, category: "content", note: `via /content/script`, latency_ms: r.latency_ms, ok: true });
    res.json({ ok: true, latency_ms: Date.now() - t0, script: r.data });
  } catch (e) {
    console.error("openai script error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

app.post("/content/assets", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const { brief_id, script } = req.body || {};
    const r = await aiAssets({ brief_id, script });
    await logToSheet({ type: "content_assets", input_text: brief_id || "", output_text: r.data, project: PROJECT, category: "asset", note: `via /content/assets`, latency_ms: r.latency_ms, ok: true });
    res.json({ ok: true, latency_ms: Date.now() - t0, assets: r.data });
  } catch (e) {
    console.error("openai assets error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// ========== REST: 통합 파이프라인 (/content/run) ==========
app.post("/content/run", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const started = Date.now();
  const { title, steps = ["brief", "script", "assets"], profile = "-", chatId = TELEGRAM_ADMIN_CHAT_ID } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: "title required" });

  const trace_id = genTraceId();
  const trace = { id: trace_id, createdAt: nowISO(), chatId, title, profile, steps, currentIndex: 0, approvalMode: APPROVAL_MODE, history: [], lastOutput: {}, status: "initialized" };
  traces.set(trace_id, trace);

  try {
    await runFromCurrent(trace); // 현재 인덱스 스텝 실행 (승인모드면 대기)
    res.json({ ok: true, latency_ms: Date.now() - started, trace_id, step: trace.steps[trace.currentIndex], status: trace.status });
  } catch (e) {
    res.status(500).json({ ok: false, latency_ms: Date.now() - started, trace_id, step: trace.steps[trace.currentIndex], error: String(e?.message || e) });
  }
});

// ========== 승인 컨트롤러 ==========
app.post("/approve", async (req, res) => {
  const { trace_id, step } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  if (trace.status === "rejected") return res.status(400).json({ ok: false, error: "already rejected", trace_id });

  const expectedNext = getNextStep(trace);
  if (step && expectedNext && step !== expectedNext) {
    return res.status(400).json({ ok: false, error: `unexpected step. expected: ${expectedNext}`, trace_id });
  }

  // 다음 스텝으로 인덱스 이동 후 실행
  if (trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;
  try {
    await runFromCurrent(trace);
    res.json({ ok: true, latency_ms: 0, trace_id, status: trace.status, step: trace.steps[trace.currentIndex] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), trace_id });
  }
});

app.post("/reject", async (req, res) => {
  const { trace_id, reason = "" } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  trace.status = "rejected";
  trace.rejectReason = reason;
  await logToSheet({ type: "approval_reject", input_text: trace.title, output_text: { reason }, project: PROJECT, category: "approval", note: `trace=${trace.id}`, trace_id, step: trace.steps[trace.currentIndex], ok: false, error: `REJECTED: ${reason}` });
  if (shouldNotify("approval")) await tgSend(trace.chatId, buildNotifyMessage({ type: "error", title: "반려됨", message: `trace_id: ${trace.id}\n사유: ${reason}` }));
  res.json({ ok: true, latency_ms: 0, trace_id, status: trace.status });
});

app.get("/status/:trace_id", async (req, res) => {
  const trace_id = req.params.trace_id;
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  res.json({ ok: true, latency_ms: 0, trace_id, status: trace.status, current_index: trace.currentIndex, steps: trace.steps, history: trace.history, last_output_keys: Object.keys(trace.lastOutput || {}) });
});

// ========== Telegram Webhook ==========
// 명령 예시:
// /approve trc_abc123 step=script
// /reject trc_abc123 reason="내용 불충분"
// /status trc_abc123
function parseTelegramCommand(text) {
  const [cmd, idOrText, ...rest] = text.trim().split(/\s+/);
  const trace_id = idOrText && idOrText.startsWith("trc_") ? idOrText : undefined;
  const argsText = rest.join(" ");
  const stepMatch = argsText.match(/step=([a-z]+)/i);
  const reasonMatch = argsText.match(/reason=("([^"]+)"|([^\s]+))/i);
  const reason = reasonMatch ? (reasonMatch[2] || reasonMatch[3]) : undefined;
  const step = stepMatch ? stepMatch[1] : undefined;
  return { cmd, trace_id, step, reason };
}

app.post("/telegram/webhook", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text.startsWith("/approve")) {
      const { trace_id, step } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);
      if (!trace) {
        await tgSend(chatId, `trace not found: ${trace_id}`);
      } else {
        const expectedNext = getNextStep(trace);
        if (step && expectedNext && step !== expectedNext) {
          await tgSend(chatId, `unexpected step. expected: ${expectedNext}`);
        } else {
          if (trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;
          await runFromCurrent(trace);
          await tgSend(chatId, buildNotifyMessage({ type: "success", title: "승인 처리됨", message: `trace_id: ${trace_id}\n상태: ${trace.status}` }));
        }
      }
      return res.json({ ok: true });
    }

    if (text.startsWith("/reject")) {
      const { trace_id, reason = "" } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);
      if (!trace) {
        await tgSend(chatId, `trace not found: ${trace_id}`);
      } else {
        trace.status = "rejected";
        trace.rejectReason = reason;
        await logToSheet({ type: "approval_reject", input_text: trace.title, output_text: { reason }, project: PROJECT, category: "approval", note: `trace=${trace.id}`, trace_id, step: trace.steps[trace.currentIndex], ok: false, error: `REJECTED: ${reason}` });
        await tgSend(chatId, buildNotifyMessage({ type: "error", title: "반려됨", message: `trace_id: ${trace.id}\n사유: ${reason}` }));
      }
      return res.json({ ok: true });
    }

    if (text.startsWith("/status")) {
      const { trace_id } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);
      if (!trace) {
        await tgSend(chatId, `trace not found: ${trace_id}`);
      } else {
        const hist = trace.history.map(h => `${h.step}:${h.ok ? "✅" : "❌"}(${h.latency_ms}ms)`).join(" → ");
        await tgSend(chatId, `📊 상태 — ${trace.title}\ntrace_id: ${trace.id}\n진행: ${hist || "-"}\n현재: index ${trace.currentIndex}/${trace.steps.length}\n상태: ${trace.status}`);
      }
      return res.json({ ok: true });
    }

    // 자연어 요청 → 통합 실행
    if (!text.startsWith("/")) {
      const { title, steps, profile } = parseFreeText(text);
      const payload = { title, steps, profile, chatId };
      const trace_id = genTraceId();
      const trace = { id: trace_id, createdAt: nowISO(), chatId, title, profile, steps, currentIndex: 0, approvalMode: APPROVAL_MODE, history: [], lastOutput: {}, status: "initialized" };
      traces.set(trace_id, trace);
      await tgSend(chatId, buildNotifyMessage({ type: "success", title: "요청 접수", message: `trace_id: ${trace_id}` }));
      try {
        await runFromCurrent(trace);
      } catch (e) {
        // 실패시 알림은 executeStep에서 처리됨
      }
      await logToSheet({ type: "telegram_text", input_text: text, output_text: payload, project: PROJECT, category: "chat", note: `trace=${trace_id}`, trace_id });
      return res.json({ ok: true });
    }

    // 기타 명령 미매칭: 에코
    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ /telegram/webhook error:", e?.message);
    if (shouldNotify("error")) {
      try {
        await tgSend(
          TELEGRAM_ADMIN_CHAT_ID,
          buildNotifyMessage({ type: "error", title: "Webhook 처리 오류", message: e?.message || "unknown" })
        );
      } catch {}
    }
    return res.sendStatus(500);
  }
});

// ========== 기존 루트 웹훅(/) — 유지(간단 에코) ==========
app.post("/", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");

    await logToSheet({
      chat_id: chatId,
      username: message.from?.username || "",
      type: "telegram_text",
      input_text: text,
      output_text: `당신이 보낸 메시지: ${text}`,
      project: PROJECT,
      category: "chat",
      note: "root webhook",
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ webhook error:", e?.message);
    if (shouldNotify("error")) {
      try {
        await tgSend(
          TELEGRAM_ADMIN_CHAT_ID,
          buildNotifyMessage({ type: "error", title: "Webhook 처리 오류", message: e?.message || "unknown" })
        );
      } catch {}
    }
    res.sendStatus(500);
  }
});

// ========== START ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT} (approval_mode=${APPROVAL_MODE})`);
});
