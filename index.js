/*
 ItplayLab 콘텐츠 자동화 서버 (승인 루프 포함)
 - Telegram Webhook 기반 자연어 명령 → OpenAI 생성 → GAS 로그 → 승인/반려 루프
 - Node.js 18+, Express, OpenAI SDK

 ENV 요구사항
 -----------------
 PORT=3000
 OPENAI_API_KEY=...
 TELEGRAM_BOT_TOKEN=...
 TELEGRAM_DEFAULT_CHAT_ID=...   // 기본 알림 채널 ID (선택)
 GAS_LOG_WEBHOOK_URL=...        // Google Apps Script WebApp URL (POST JSON)
 NOTIFY_LEVEL=success,error,approval  // default
 APPROVAL_MODE=true             // true면 단계별 수동 승인

 주요 기능
 -----------------
 1) /content/brief | /content/script | /content/assets : 단일 스텝 실행
 2) /content/run   : [brief→script→assets] 순차 실행, 각 스텝 종료마다 승인 대기
 3) /approve, /reject, /status : 승인 루프 컨트롤 (REST + Telegram 명령 모두 지원)
 4) /telegram/webhook : Telegram 명령 처리 (/approve, /reject, /status)

 검증 포맷
 -----------------
 모든 스텝/엔드포인트 응답은 아래 포맷을 따름
 { ok: true|false, latency_ms: number, trace_id: string, step?: string, error?: string }
*/

import express from "express";
import crypto from "crypto";
import { OpenAI } from "openai";

// Node 18+ 에서 fetch 전역 사용 가능

// -------------------- 설정 --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_DEFAULT_CHAT_ID = process.env.TELEGRAM_DEFAULT_CHAT_ID; // 선택
const GAS_LOG_WEBHOOK_URL = process.env.GAS_LOG_WEBHOOK_URL;
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval").split(",");
const APPROVAL_MODE = String(process.env.APPROVAL_MODE || "true").toLowerCase() === "true";

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!GAS_LOG_WEBHOOK_URL) console.warn("[WARN] GAS_LOG_WEBHOOK_URL not set – logging to GAS disabled");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- 유틸 --------------------
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();

async function sendTelegram(chatId, text, options = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId || TELEGRAM_DEFAULT_CHAT_ID, text, parse_mode: "Markdown", ...options };
  if (!body.chat_id) return; // 채널 미설정 시 무시
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    return json;
  } catch (e) {
    console.error("Telegram send error", e);
  }
}

async function logToGAS(payload) {
  if (!GAS_LOG_WEBHOOK_URL) return { ok: false, skipped: true };
  try {
    const res = await fetch(GAS_LOG_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const json = await res.json().catch(() => ({}));
    return json;
  } catch (e) {
    console.error("GAS log error", e);
    return { ok: false, error: String(e) };
  }
}

const shouldNotify = (kind) => NOTIFY_LEVEL.includes(kind);

async function withRetry(fn, retries = 2, delayMs = 800) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// -------------------- 상태 저장소 (in-memory) --------------------
// 실제 운영에서는 Redis/DB 권장
const traces = new Map();
/*
traces.set(traceId, {
  createdAt, chatId, title,
  steps: ["brief","script","assets"],
  currentIndex: 0,
  approvalMode: true,
  history: [ { step, ok, latency_ms, error, startedAt, finishedAt } ],
  lastOutput: { brief, script, assets },
  notifyLevel: ["success","error","approval"],
  status: "running"|"paused"|"rejected"|"completed",
  rejectReason: string | undefined
})
*/

// -------------------- OpenAI 작업자 --------------------
async function generateBrief(title, profile = "-") {
  const started = Date.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: "You generate Korean content briefs as structured JSON." },
      { role: "user", content: `제목: ${title}\n프로필: ${profile}\nJSON으로 브리프 생성: {title, objective, key_points[], target_audience, call_to_action}` }
    ],
    response_format: { type: "json_object" }
  });
  const text = completion.choices[0]?.message?.content || "{}";
  const latency_ms = Date.now() - started;
  return { ok: true, latency_ms, data: JSON.parse(text) };
}

async function generateScript(briefJson) {
  const started = Date.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: "You write concise Korean video scripts as JSON." },
      { role: "user", content: `브리프:\n${JSON.stringify(briefJson)}\nJSON 스크립트 생성: {hook, beats[], outro}` }
    ],
    response_format: { type: "json_object" }
  });
  const text = completion.choices[0]?.message?.content || "{}";
  const latency_ms = Date.now() - started;
  return { ok: true, latency_ms, data: JSON.parse(text) };
}

async function generateAssets(scriptJson) {
  const started = Date.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      { role: "system", content: "You output asset metadata for uploads as JSON." },
      { role: "user", content: `스크립트:\n${JSON.stringify(scriptJson)}\nJSON 메타데이터 생성: {title, description, tags[], thumbnails[]}` }
    ],
    response_format: { type: "json_object" }
  });
  const text = completion.choices[0]?.message?.content || "{}";
  const latency_ms = Date.now() - started;
  return { ok: true, latency_ms, data: JSON.parse(text) };
}

async function executeStep(trace, stepName) {
  const startedAt = nowISO();
  const t0 = Date.now();
  try {
    let res;
    if (stepName === "brief") {
      res = await withRetry(() => generateBrief(trace.title, trace.profile));
      trace.lastOutput.brief = res.data;
    } else if (stepName === "script") {
      res = await withRetry(() => generateScript(trace.lastOutput.brief));
      trace.lastOutput.script = res.data;
    } else if (stepName === "assets") {
      res = await withRetry(() => generateAssets(trace.lastOutput.script));
      trace.lastOutput.assets = res.data;
    } else {
      throw new Error(`Unknown step: ${stepName}`);
    }

    const latency_ms = res.latency_ms;
    trace.history.push({ step: stepName, ok: true, latency_ms, startedAt, finishedAt: nowISO() });

    // 로그 기록
    await logToGAS({
      timestamp: nowISO(),
      date: new Date().toLocaleDateString("ko-KR"),
      title: trace.title,
      step: stepName,
      ok: true,
      latency_ms,
      trace_id: trace.id,
      error: ""
    });

    if (shouldNotify("success")) {
      await sendTelegram(trace.chatId, `✅ *${trace.title}* — *${stepName}* 완료\ntrace_id: ${trace.id}\nlatency: ${latency_ms}ms`);
    }
    return { ok: true, latency_ms };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const error = String(err?.message || err);
    trace.history.push({ step: stepName, ok: false, latency_ms, error, startedAt, finishedAt: nowISO() });
    await logToGAS({
      timestamp: nowISO(),
      date: new Date().toLocaleDateString("ko-KR"),
      title: trace.title,
      step: stepName,
      ok: false,
      latency_ms,
      trace_id: trace.id,
      error
    });
    if (shouldNotify("error")) {
      await sendTelegram(trace.chatId, `❌ *${trace.title}* — *${stepName}* 실패\ntrace_id: ${trace.id}\nerror: ${error}`);
    }
    throw err;
  }
}

function getNextStep(trace) {
  if (trace.currentIndex + 1 >= trace.steps.length) return null;
  return trace.steps[trace.currentIndex + 1];
}

async function pauseForApproval(trace) {
  trace.status = "paused";
  const next = getNextStep(trace);
  if (!next) {
    trace.status = "completed";
    if (shouldNotify("success")) await sendTelegram(trace.chatId, `✅ 모든 단계 완료 — trace_id: ${trace.id}`);
    return;
  }
  if (shouldNotify("approval")) {
    await sendTelegram(
      trace.chatId,
      `🛎 다음 단계 승인 대기: *${next}*\ntrace_id: ${trace.id}\n승인: /approve ${trace.id} step=${next}\n반려: /reject ${trace.id} reason="사유"\n상태: /status ${trace.id}`
    );
  }
}

async function runFromCurrent(trace) {
  trace.status = "running";
  while (trace.currentIndex < trace.steps.length) {
    const stepName = trace.steps[trace.currentIndex];
    await executeStep(trace, stepName);

    // 다음 단계로 진행할지 결정
    if (APPROVAL_MODE) {
      await pauseForApproval(trace);
      // 승인 명령 대기: 루프 중단 (REST/Telegram에서 승인시 재개)
      break;
    } else {
      // 자동 진행
      trace.currentIndex += 1;
      if (trace.currentIndex >= trace.steps.length) {
        trace.status = "completed";
        if (shouldNotify("success")) await sendTelegram(trace.chatId, `✅ 모든 단계 완료 — trace_id: ${trace.id}`);
        break;
      }
    }
  }
}

// -------------------- 자연어 파서(간단 버전) --------------------
// 실제 파서는 별도 모듈 사용 가능. 여기서는 intent/steps/title/profile 추출의 최소 로직만 구현.
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
  return { intent, title, steps, profile, notify: "default" };
}

// -------------------- REST: 콘텐츠 엔드포인트 --------------------
app.post("/content/brief", async (req, res) => {
  const { title, profile = "-", chatId = TELEGRAM_DEFAULT_CHAT_ID } = req.body || {};
  const trace_id = genTraceId();
  const started = Date.now();
  try {
    const trace = { id: trace_id, createdAt: nowISO(), chatId, title, profile, steps: ["brief"], currentIndex: 0, approvalMode: false, history: [], lastOutput: {}, notifyLevel: NOTIFY_LEVEL, status: "running" };
    traces.set(trace_id, trace);

    const r = await executeStep(trace, "brief");
    trace.currentIndex = 1;
    trace.status = "completed";

    res.json({ ok: true, latency_ms: Date.now() - started, trace_id, step: "brief", data: trace.lastOutput.brief });
  } catch (e) {
    res.status(500).json({ ok: false, latency_ms: Date.now() - started, trace_id, step: "brief", error: String(e?.message || e) });
  }
});

app.post("/content/script", async (req, res) => {
  const { brief, chatId = TELEGRAM_DEFAULT_CHAT_ID } = req.body || {};
  const trace_id = genTraceId();
  const started = Date.now();
  try {
    const trace = { id: trace_id, createdAt: nowISO(), chatId, title: brief?.title || "무제", profile: "-", steps: ["script"], currentIndex: 0, approvalMode: false, history: [], lastOutput: { brief }, notifyLevel: NOTIFY_LEVEL, status: "running" };
    traces.set(trace_id, trace);

    const r = await executeStep(trace, "script");
    trace.currentIndex = 1;
    trace.status = "completed";
    res.json({ ok: true, latency_ms: Date.now() - started, trace_id, step: "script", data: trace.lastOutput.script });
  } catch (e) {
    res.status(500).json({ ok: false, latency_ms: Date.now() - started, trace_id, step: "script", error: String(e?.message || e) });
  }
});

app.post("/content/assets", async (req, res) => {
  const { script, chatId = TELEGRAM_DEFAULT_CHAT_ID } = req.body || {};
  const trace_id = genTraceId();
  const started = Date.now();
  try {
    const trace = { id: trace_id, createdAt: nowISO(), chatId, title: script?.title || "무제", profile: "-", steps: ["assets"], currentIndex: 0, approvalMode: false, history: [], lastOutput: { script }, notifyLevel: NOTIFY_LEVEL, status: "running" };
    traces.set(trace_id, trace);

    const r = await executeStep(trace, "assets");
    trace.currentIndex = 1;
    trace.status = "completed";
    res.json({ ok: true, latency_ms: Date.now() - started, trace_id, step: "assets", data: trace.lastOutput.assets });
  } catch (e) {
    res.status(500).json({ ok: false, latency_ms: Date.now() - started, trace_id, step: "assets", error: String(e?.message || e) });
  }
});

app.post("/content/run", async (req, res) => {
  const { title, steps = ["brief", "script", "assets"], profile = "-", chatId = TELEGRAM_DEFAULT_CHAT_ID } = req.body || {};
  const trace_id = genTraceId();
  const started = Date.now();

  const trace = { id: trace_id, createdAt: nowISO(), chatId, title, profile, steps, currentIndex: 0, approvalMode: APPROVAL_MODE, history: [], lastOutput: {}, notifyLevel: NOTIFY_LEVEL, status: "initialized" };
  traces.set(trace_id, trace);

  try {
    await runFromCurrent(trace); // 첫 스텝 실행 + (승인모드면) 대기
    res.json({ ok: true, latency_ms: Date.now() - started, trace_id, step: trace.steps[trace.currentIndex], status: trace.status });
  } catch (e) {
    res.status(500).json({ ok: false, latency_ms: Date.now() - started, trace_id, step: trace.steps[trace.currentIndex], error: String(e?.message || e) });
  }
});

// -------------------- 승인 컨트롤러 (REST) --------------------
app.post("/approve", async (req, res) => {
  const { trace_id, step } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  if (trace.status === "rejected") return res.status(400).json({ ok: false, error: "already rejected", trace_id });

  const expectedNext = getNextStep({ ...trace, currentIndex: trace.currentIndex });
  if (step && expectedNext && step !== expectedNext) {
    return res.status(400).json({ ok: false, error: `unexpected step. expected: ${expectedNext}`, trace_id });
  }

  // 승인 → 다음 단계 인덱스 증가 후 실행
  if (trace.currentIndex < trace.steps.length) trace.currentIndex += 1;
  try {
    await runFromCurrent(trace); // 다음 스텝 1개 실행 후 (승인모드면) 다시 대기
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
  await logToGAS({ timestamp: nowISO(), date: new Date().toLocaleDateString("ko-KR"), title: trace.title, step: trace.steps[trace.currentIndex], ok: false, latency_ms: 0, trace_id, error: `REJECTED: ${reason}` });
  if (shouldNotify("approval")) await sendTelegram(trace.chatId, `⛔️ 반려됨 — trace_id: ${trace.id}\n사유: ${reason}`);
  res.json({ ok: true, latency_ms: 0, trace_id, status: trace.status });
});

app.get("/status/:trace_id", async (req, res) => {
  const trace_id = req.params.trace_id;
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  res.json({ ok: true, latency_ms: 0, trace_id, status: trace.status, current_index: trace.currentIndex, steps: trace.steps, history: trace.history, last_output_keys: Object.keys(trace.lastOutput || {}) });
});

// -------------------- Telegram Webhook --------------------
// 명령 포맷 예시:
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
  const update = req.body;
  try {
    if (update?.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text.startsWith("/approve")) {
        const { trace_id, step } = parseTelegramCommand(text);
        if (!trace_id) return res.json({ ok: true });
        const r = await fetch("/approve", { method: "POST" }); // NOOP for serverless; fall back below
        const trace = traces.get(trace_id);
        if (!trace) {
          await sendTelegram(chatId, `trace not found: ${trace_id}`);
        } else {
          const expectedNext = getNextStep(trace);
          if (step && expectedNext && step !== expectedNext) {
            await sendTelegram(chatId, `unexpected step. expected: ${expectedNext}`);
          } else {
            if (trace.currentIndex < trace.steps.length) trace.currentIndex += 1;
            await runFromCurrent(trace);
            await sendTelegram(chatId, `✅ 승인 처리됨 — trace_id: ${trace_id}\n상태: ${trace.status}`);
          }
        }
      }

      if (text.startsWith("/reject")) {
        const { trace_id, reason = "" } = parseTelegramCommand(text);
        const trace = traces.get(trace_id);
        if (!trace) {
          await sendTelegram(chatId, `trace not found: ${trace_id}`);
        } else {
          trace.status = "rejected";
          trace.rejectReason = reason;
          await logToGAS({ timestamp: nowISO(), date: new Date().toLocaleDateString("ko-KR"), title: trace.title, step: trace.steps[trace.currentIndex], ok: false, latency_ms: 0, trace_id, error: `REJECTED: ${reason}` });
          await sendTelegram(chatId, `⛔️ 반려됨 — trace_id: ${trace_id}\n사유: ${reason}`);
        }
      }

      if (text.startsWith("/status")) {
        const { trace_id } = parseTelegramCommand(text);
        const trace = traces.get(trace_id);
        if (!trace) {
          await sendTelegram(chatId, `trace not found: ${trace_id}`);
        } else {
          const hist = trace.history.map(h => `${h.step}:${h.ok ? "✅" : "❌"}(${h.latency_ms}ms)`).join(" → ");
          await sendTelegram(chatId, `📊 상태 — ${trace.title}\ntrace_id: ${trace.id}\n진행: ${hist || "-"}\n현재: index ${trace.currentIndex}/${trace.steps.length}\n상태: ${trace.status}`);
        }
      }

      // 자연어 요청 처리 (예: "AI자동화 콘텐츠 전략 브리프 만들어줘")
      if (!text.startsWith("/")) {
        const { intent, title, steps, profile } = parseFreeText(text);
        const payload = { title, steps, profile, chatId };
        const resp = await fetch(`http://localhost:${PORT}/content/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const json = await resp.json().catch(() => ({}));
        await sendTelegram(chatId, `🚀 요청 접수 — *${title}*\ntrace_id: ${json.trace_id || "-"}`);
      }
    }
  } catch (e) {
    console.error("/telegram/webhook error", e);
  }
  res.json({ ok: true });
});

// -------------------- 상태 점검 --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "itplaylab-automation", time: nowISO(), approval_mode: APPROVAL_MODE });
});

// -------------------- 서버 시작 --------------------
app.listen(PORT, () => {
  console.log(`[ItplayLab] server listening on :${PORT}`);
});
