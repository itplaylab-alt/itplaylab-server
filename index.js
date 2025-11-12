// index.js — ItplayLab 안정화 패치 v1.4.1
// 핵심: 안전한 종료, 재시도/타임아웃, 레이트리밋, JSON 크래시 방지, 트레이스 락, 보안/헬스체크 강화
// 필요 패키지: npm i express axios openai ajv ajv-formats helmet compression express-rate-limit

import express from "express";
import axios from "axios";
import crypto from "crypto";
import http from "http";
import https from "https";
// 👉 optional dynamic imports (not fatal if missing)
let helmet = null, compression = null, rateLimit = null;
async function _optImport(name){ try{ const m = await import(name); return m?.default || m; } catch { return null; } }
helmet = await _optImport("helmet");
compression = await _optImport("compression");
rateLimit = await _optImport("express-rate-limit");
import OpenAI from "openai";

const app = express();

/* ────────────────────────────────────────────────────────────
   0) 공통 설정: 요청ID, 보안헤더, 압축, 프록시 신뢰
──────────────────────────────────────────────────────────── */
app.set("trust proxy", true);
app.use((req, res, next) => {
  req._reqid = req.headers["x-request-id"] || `req_${crypto.randomBytes(6).toString("hex")}`;
  next();
});
const _noopMw = (req,res,next)=>next();
const helmetMw = helmet ? helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }) : _noopMw;
app.use(helmetMw);
const compressionMw = compression ? compression() : (req,res,next)=>next();
app.use(compressionMw);

/* ────────────────────────────────────────────────────────────
   1) 요청 로깅 + Content-Type 확인
──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  console.log(
    `[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers["content-type"] || ""} ip=${req.ip} id=${req._reqid}`
  );
  res.setHeader("X-Request-Id", req._reqid);
  next();
});

/* ────────────────────────────────────────────────────────────
   2) 바디 파서 (JSON 1MB 제한)
──────────────────────────────────────────────────────────── */
app.use(express.json({ limit: "1mb", type: ["application/json"] }));
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({ ok: false, error: "invalid_json", detail: err.message, request_id: req._reqid });
  }
  next();
});

/* ────────────────────────────────────────────────────────────
   3) Axios 기본값: 타임아웃/재시도/Keep-Alive
──────────────────────────────────────────────────────────── */
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });
const ax = axios.create({ timeout: 20_000, httpAgent: keepAliveHttp, httpsAgent: keepAliveHttps, validateStatus: () => true });
async function axPost(url, data, cfg = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const r = await ax.post(url, data, cfg).catch((e) => ({ status: 599, data: { ok: false, error: e.message } }));
    if (r.status >= 200 && r.status < 500) return r; // 5xx만 재시도
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return { status: 599, data: { ok: false, error: "retry_exhausted" } };
}

/* ────────────────────────────────────────────────────────────
   4) ENV 설정/검증
──────────────────────────────────────────────────────────── */
const REQUIRED_ENV = ["TELEGRAM_TOKEN", "TELEGRAM_ADMIN_CHAT_ID", "GAS_INGEST_URL", "INGEST_TOKEN", "OPENAI_API_KEY"]; // 필요 시 조정
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) console.warn(`[ENV] Missing (non-fatal in dev): ${missing.join(", ")}`);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval").split(",").map((s) => s.trim().toLowerCase());
const GAS_INGEST_URL = process.env.GAS_INGEST_URL || "";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_RESP = process.env.OPENAI_MODEL_RESP || "gpt-4.1-mini";
const OPENAI_MODEL_FALLBACK = process.env.OPENAI_MODEL_FALLBACK || "gpt-4o-mini";
const OPENAI_MODEL = process.env.OPENAI_MODEL || OPENAI_MODEL_RESP;
const PROJECT = process.env.PROJECT || "itplaylab";
const SERVICE_NAME = process.env.SERVICE_NAME || "render-bot";
const APPROVAL_MODE = String(process.env.APPROVAL_MODE || "true").toLowerCase() === "true";
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 3);
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// OpenAI
const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ────────────────────────────────────────────────────────────
   5) AJV 동적 로드 (미설치 허용)
──────────────────────────────────────────────────────────── */
let _ajv = null;
async function ensureAjv() {
  try {
    if (_ajv) return _ajv;
    const ajvMod = await import("ajv").catch(() => null);
    if (!ajvMod?.default) return null;
    const addFormatsMod = await import("ajv-formats").catch(() => null);
    const Ajv = ajvMod.default;
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (addFormatsMod?.default) addFormatsMod.default(ajv);
    _ajv = ajv;
    return _ajv;
  } catch (e) {
    console.warn("[AJV] dynamic load failed:", e.message);
    return null;
  }
}

/* ────────────────────────────────────────────────────────────
   6) 공용 유틸
──────────────────────────────────────────────────────────── */
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();
const fmtTsKR = (d = new Date()) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
const fmtTrace = (id) => `trace_id: <code>${id}</code>`;
const fmtTitle = (t) => `제목: <b>${t}</b>`;
const STEP_LABELS = { brief: "브리프", script: "스크립트", assets: "에셋/메타" };
const labelStep = (s) => STEP_LABELS[s] || s;

const DEFAULT_CHECKLIST = [
  { key: "accuracy", label: "내용 정확성" },
  { key: "brand", label: "브랜드 톤/보이스" },
  { key: "policy", label: "정책/저작권 준수" },
  { key: "length", label: "길이/템포" },
  { key: "thumbnail", label: "썸네일 적합성" },
];
const labelOf = (key) => DEFAULT_CHECKLIST.find((i) => i.key === key)?.label || key;
function parseChecks(text) {
  const m = text.match(/checks\s*=\s*(\[[^\]]+\]|[^\s]+)/i);
  if (!m) return [];
  const raw = m[1].startsWith("[") ? m[1].slice(1, -1) : m[1];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function approverName(from) {
  const p = [];
  if (from?.first_name) p.push(from.first_name);
  if (from?.last_name) p.push(from.last_name);
  return p.join(" ") || from?.username || `user_${from?.id || "unknown"}`;
}

/* ────────────────────────────────────────────────────────────
   7) GAS 로깅 (재시도 포함)
──────────────────────────────────────────────────────────── */
async function logToSheet(payload) {
  const t0 = Date.now();
  if (!GAS_INGEST_URL) return { ok: false, skipped: true };
  try {
    const r = await axPost(GAS_INGEST_URL, {
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
          typeof payload.revision_count === "number" ? payload.revision_count : "",
      }),
    });
    if (r.status >= 200 && r.status < 300) return { ok: true, latency_ms: Date.now() - t0 };
    return { ok: false, error: `gas_http_${r.status}`, latency_ms: Date.now() - t0 };
  } catch (e) {
    console.error("❌ GAS log fail:", e?.message);
    return { ok: false, error: e?.message, latency_ms: Date.now() - t0 };
  }
}

/* ────────────────────────────────────────────────────────────
   8) Telegram 전송 (재시도)
──────────────────────────────────────────────────────────── */
async function tgSend(chatId, text, parse_mode = "HTML", extra = {}) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    const r = await axPost(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode, disable_web_page_preview: true, ...extra });
    if (r.status >= 400) console.warn("[tgSend] http", r.status, r.data?.description);
    return r;
  } catch (e) {
    console.error("Telegram send error:", e?.message);
  }
}
async function tgAnswerCallback(id, text = "", show_alert = false) {
  try {
    await axPost(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: id, text, show_alert });
  } catch (e) {
    console.error("Telegram answerCallbackQuery error:", e?.message);
  }
}
const shouldNotify = (kind) => NOTIFY_LEVEL.includes(kind);
function buildNotifyMessage({ type, title, message }) {
  const ts = fmtTsKR();
  if (type === "success") return `✅ <b>${title || "처리 완료"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "error") return `❌ <b>${title || "오류 발생"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "approval") return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n🕒 ${ts}`;
}
function requireOpenAI(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
    return false;
  }
  return true;
}

/* ────────────────────────────────────────────────────────────
   9) 레이트 리밋 (텔레그램 웹훅 보호)
──────────────────────────────────────────────────────────── */
const webhookLimiter = rateLimit ? rateLimit({ windowMs: 10_000, max: 40, standardHeaders: true, legacyHeaders: false }) : ((req,res,next)=>next());
app.use(["/telegram/webhook", "/"], webhookLimiter);

/* ────────────────────────────────────────────────────────────
   10) 대시보드/헬스체크
──────────────────────────────────────────────────────────── */
app.get("/test/healthcheck", (req, res) => res.json({ ok: true, service: "Render → GAS Bridge + Notify + Approval Loop", status: "Render is alive ✅", timestamp: new Date().toISOString(), approval_mode: APPROVAL_MODE }));
app.get("/test/ready", (req, res) => {
  const ready = !!OPENAI_API_KEY && !!TELEGRAM_TOKEN;
  res.status(ready ? 200 : 503).json({ ok: ready, deps: { openai: !!OPENAI_API_KEY, telegram: !!TELEGRAM_TOKEN } });
});

// ➕ (복구) GAS 연동 테스트
app.get("/test/send-log", async (req, res) => {
  try {
    const r = await logToSheet({
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
    });
    res.json({ ok: true, sent_to_gas: r.ok, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ➕ (복구) 텔레그램 알림 테스트
app.get("/test/notify", async (req, res) => {
  try {
    const type = String(req.query.type || "success").toLowerCase();
    const title = String(req.query.title || "");
    const message = String(req.query.message || "");
    if (!NOTIFY_LEVEL.includes(type)) return res.json({ ok: true, sent: false, reason: "filtered_by_NOTIFY_LEVEL" });
    const text = buildNotifyMessage({ type, title, message });
    await tgSend(TELEGRAM_ADMIN_CHAT_ID, text);
    await logToSheet({ type: `notify_${type}`, input_text: title, output_text: message, project: PROJECT, category: "notify", note: "notify_test" });
    res.json({ ok: true, sent: true, type });
  } catch (e) {
    console.error("❌ notify error:", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});
});

/* ────────────────────────────────────────────────────────────
   11) OpenAI 공용 호출자 (Responses → Fallback) + 타임아웃
──────────────────────────────────────────────────────────── */
async function callOpenAIJson({ system, user, schema, schemaName = "itplaylab_schema" }) {
  const started = Date.now();
  let provider = "responses";
  let txt = "";
  let parsed = null;
  const timeoutMs = 30_000;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await oa.responses.create({ model: OPENAI_MODEL || OPENAI_MODEL_RESP, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } }, temperature: 0.2, signal: controller.signal });
    txt = resp?.output_text || resp?.output?.[0]?.content?.[0]?.text || "";
    parsed = txt ? JSON.parse(txt) : null;
  } catch (e) {
    provider = "chat.completions";
    try {
      const schemaHint = `다음 JSON 스키마에 맞춰 정확히 JSON만 출력하세요. 추가 설명 금지.\n${JSON.stringify(schema)}`;
      const comp = await oa.chat.completions.create({ model: OPENAI_MODEL_FALLBACK, response_format: { type: "json_object" }, messages: [{ role: "system", content: `${system}\n\n${schemaHint}` }, { role: "user", content: user }], temperature: 0.2 });
      txt = comp?.choices?.[0]?.message?.content || "";
      parsed = txt ? JSON.parse(txt) : null;
    } catch (e2) {
      clearTimeout(to);
      return { ok: false, error: `openai_call_failed: ${e2?.message || e?.message}`, provider, latency_ms: Date.now() - started };
    }
  }
  clearTimeout(to);
  const validator = await ensureAjv();
  if (!validator) return { ok: !!parsed, data: parsed, provider, latency_ms: Date.now() - started, errors: [], raw_text: txt };
  const validate = validator.compile(schema);
  const valid = !!parsed && validate(parsed);
  return { ok: !!valid, data: parsed, provider, latency_ms: Date.now() - started, errors: valid ? [] : validate.errors, raw_text: txt };
}

/* ────────────────────────────────────────────────────────────
   12) 스키마 (동일)
──────────────────────────────────────────────────────────── */
const SCHEMA_BRIEF = { type: "object", additionalProperties: false, properties: { brief_id: { type: "string" }, idea_id: { type: "string" }, goal: { type: "string" }, key_points: { type: "array", items: { type: "string" } }, hook: { type: "string" }, outline: { type: "array", items: { type: "object", properties: { sec: { type: "number" }, beat: { type: "string" } }, required: ["sec", "beat"] } }, channels: { type: "array", items: { type: "string" } }, due_date: { type: "string" }, owner: { type: "string" } }, required: ["brief_id", "goal", "outline"] };
const SCHEMA_SCRIPT = { type: "object", additionalProperties: false, properties: { brief_id: { type: "string" }, lang: { type: "string" }, shots: { type: "array", items: { type: "object", properties: { t_start: { type: "number" }, t_end: { type: "number" }, narration: { type: "string" }, overlay_text: { type: "string" }, asset_hint: { type: "string" } }, required: ["t_start", "t_end", "narration"] } } }, required: ["brief_id", "shots"] };
const SCHEMA_ASSETS = { type: "object", additionalProperties: false, properties: { brief_id: { type: "string" }, thumbnail_prompt: { type: "string" }, titles: { type: "array", items: { type: "string" } }, descriptions: { type: "array", items: { type: "string" } }, hashtags: { type: "array", items: { type: "string" } } }, required: ["brief_id", "thumbnail_prompt", "titles"] };

/* ────────────────────────────────────────────────────────────
   13) OpenAI 작업자 (동일)
──────────────────────────────────────────────────────────── */
async function aiBrief(idea) { return await callOpenAIJson({ system: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 작성하라.", user: JSON.stringify(idea), schema: SCHEMA_BRIEF, schemaName: "content_brief" }); }
async function aiScript(brief) { return await callOpenAIJson({ system: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 출력.", user: JSON.stringify(brief), schema: SCHEMA_SCRIPT, schemaName: "content_script" }); }
async function aiAssets({ brief_id, script }) { return await callOpenAIJson({ system: "너는 유튜브 운영자다. 썸네일 프롬프트와 제목/설명을 생성하라. 제목 3안, 해시태그 5개. JSON만 출력.", user: JSON.stringify({ brief_id, script }), schema: SCHEMA_ASSETS, schemaName: "content_assets" }); }

/* ────────────────────────────────────────────────────────────
   14) 상태 저장소 + 트레이스 락 (중복 실행 방지)
──────────────────────────────────────────────────────────── */
const traces = new Map();
function getLock(trace) { if (!trace._lock) trace._lock = { running: false, queue: Promise.resolve() }; return trace._lock; }
async function withTraceLock(trace, fn) { const lock = getLock(trace); lock.queue = lock.queue.then(async () => { if (lock.running) return; lock.running = true; try { await fn(); } finally { lock.running = false; } }); return lock.queue; }

/* ────────────────────────────────────────────────────────────
   15) 공정 실행기 (오류 로깅 유지)
──────────────────────────────────────────────────────────── */
async function executeStep(trace, stepName) {
  const startedAt = nowISO();
  let latency_ms = 0; let provider = "";
  try {
    let r;
    if (stepName === "brief") { r = await aiBrief({ title: trace.title, profile: trace.profile }); trace.lastOutput.brief = r.data; }
    else if (stepName === "script") { r = await aiScript(trace.lastOutput.brief); trace.lastOutput.script = r.data; }
    else if (stepName === "assets") { r = await aiAssets({ brief_id: trace.lastOutput.brief?.brief_id, script: trace.lastOutput.script }); trace.lastOutput.assets = r.data; }
    else { throw new Error(`unknown step: ${stepName}`); }

    latency_ms = r.latency_ms; provider = r.provider;
    if (!r.ok) { const reason = r.errors?.[0]?.message || r.error || "schema_validation_failed"; throw new Error(reason); }

    trace.history.push({ step: stepName, ok: true, latency_ms, provider, startedAt, finishedAt: nowISO() });
    await logToSheet({ type: `content_${stepName}`, input_text: trace.title, output_text: trace.lastOutput[stepName], project: PROJECT, category: stepName, note: `trace=${trace.id}`, latency_ms, trace_id: trace.id, step: stepName, ok: true, provider });
    if (shouldNotify("success")) {
      const msg = [fmtTitle(trace.title), fmtTrace(trace.id), `단계: <b>${labelStep(stepName)}</b>`, `지연시간: <code>${latency_ms}ms</code>`, `엔진: <code>${provider}</code>`].join("\n");
      await tgSend(trace.chatId, buildNotifyMessage({ type: "success", title: `${labelStep(stepName)} 완료`, message: msg }));
    }
    return { ok: true, latency_ms };
  } catch (e) {
    const error = e?.message || String(e);
    trace.history.push({ step: stepName, ok: false, latency_ms, provider, error, startedAt, finishedAt: nowISO() });
    await logToSheet({ type: `content_${stepName}`, input_text: trace.title, output_text: { error }, project: PROJECT, category: stepName, note: `trace=${trace.id}`, latency_ms, trace_id: trace.id, step: stepName, ok: false, error, provider });
    if (shouldNotify("error")) {
      const msg = [fmtTitle(trace.title), fmtTrace(trace.id), `단계: <b>${labelStep(stepName)}</b>`, `사유: <code>${error}</code>`, provider ? `엔진: <code>${provider}</code>` : ""].filter(Boolean).join("\n");
      await tgSend(trace.chatId, buildNotifyMessage({ type: "error", title: `${labelStep(stepName)} 실패`, message: msg }));
    }
    throw e;
  }
}
const getNextStep = (trace) => (trace.currentIndex + 1 < trace.steps.length ? trace.steps[trace.currentIndex + 1] : null);

/* ────────────────────────────────────────────────────────────
   16) 리비전/승인/일시정지 (동일, 락 적용)
──────────────────────────────────────────────────────────── */
function buildRevisionPrompts(stepName, trace, reason = "", checks = []) { /* … 기존과 동일 … */ }
async function redoCurrentStepWithRevision(trace, { reason = "", checks = [], by = "api" } = {}) { /* … 기존과 동일 … */ }

async function pauseForApproval(trace) { /* … 기존과 동일 … */ }

async function runFromCurrent(trace) {
  return withTraceLock(trace, async () => {
    trace.status = "running";
    const stepName = trace.steps[trace.currentIndex];
    await executeStep(trace, stepName);
    if (APPROVAL_MODE) { await pauseForApproval(trace); }
    else {
      trace.currentIndex += 1;
      if (trace.currentIndex < trace.steps.length) await runFromCurrent(trace);
      else { trace.status = "completed"; if (shouldNotify("success")) { const msg = [fmtTitle(trace.title), fmtTrace(trace.id), `진행 상태: <b>모든 단계 완료</b>`].join("\n"); await tgSend(trace.chatId, buildNotifyMessage({ type: "success", title: "출고 완료", message: msg })); } }
    }
  });
}

/* ────────────────────────────────────────────────────────────
   17) 파서/컨트롤러/웹훅 (기존과 동일) — 중복 승인 방지 보강
──────────────────────────────────────────────────────────── */
// … 여기서는 사용자의 원본 로직을 그대로 두되, approve 시 expectedNext 검증 이후
// withTraceLock(trace, () => runFromCurrent(trace)) 를 사용하도록 변경하면 이중 실행이 방지됩니다.

/* 예시: */
app.post("/approve", async (req, res) => {
  const { trace_id, step, checks = [], by = "api" } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace) return res.status(404).json({ ok: false, error: "trace not found", trace_id });
  const expectedNext = getNextStep(trace);
  if (step && expectedNext && step !== expectedNext) return res.status(400).json({ ok: false, error: `unexpected step. expected: ${expectedNext}`, trace_id });
  if (trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;
  await logToSheet({ type: "approval_approve", input_text: trace.title, output_text: { by, checks }, project: PROJECT, category: "approval", note: `trace=${trace.id}`, trace_id, step: trace.steps[trace.currentIndex], ok: true });
  try {
    await withTraceLock(trace, async () => { await runFromCurrent(trace); });
    return res.json({ ok: true, trace_id, status: trace.status, step: trace.steps[trace.currentIndex] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), trace_id });
  }
});

/* ────────────────────────────────────────────────────────────
   18) 에러 핸들러/안전 종료
──────────────────────────────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error("[UNHANDLED]", err?.stack || err);
  try { res.status(500).json({ ok: false, error: "internal_error", request_id: req._reqid }); } catch {}
});

// ====== 리포트 자동화 설비 v1 (Markdown 텍스트 중심) ======
function escapeHtml(s=""){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function buildReportMarkdown(trace){
  const success = trace.history.filter(h=>h.ok).length;
  const fail = trace.history.filter(h=>!h.ok).length;
  const avg = (()=>{ const v = trace.history.map(h=>h.latency_ms||0).filter(Boolean); return v.length? Math.round(v.reduce((a,b)=>a+b,0)/v.length):0; })();
  const steps = trace.steps.map((s,idx)=> `${idx<trace.currentIndex?"✔":"•"} ${labelStep(s)}`).join(" → ");
  const hist = trace.history.map(h=> `- ${labelStep(h.step)}: ${h.ok?"✅":"❌"} (${h.latency_ms||0}ms / ${h.provider||"-"})`).join("
");
  const out = Object.keys(trace.lastOutput||{}).join(", ") || "-";
  return `# 🎬 ItplayLab 콘텐츠 자동화 리포트
**제목:** ${escapeHtml(trace.title)}  
**Trace ID:** ${trace.id}  
**상태:** ${trace.status}  
**리비전:** ${trace.revisionCount}/${MAX_REVISIONS}  
**생성 시각:** ${trace.createdAt}

---

## 📊 진행 요약
${steps}

- 성공: ${success} / 실패: ${fail}
- 평균 지연시간: ${avg}ms

## 🧱 단계 기록
${hist}

## 📦 산출물
${out}
`; }

app.post("/report/generate", async (req,res)=>{
  const { trace_id } = req.body||{};
  const trace = traces.get(trace_id);
  if(!trace) return res.status(404).json({ ok:false, error:"trace not found", trace_id });
  const md = buildReportMarkdown(trace);
  await logToSheet({ type:"report_generated", input_text: trace.title, output_text: md, project: PROJECT, category:"report", trace_id, ok:true });
  res.json({ ok:true, trace_id, report: md });
});

app.post("/report/send", async (req,res)=>{
  const { trace_id, chat_id } = req.body||{};
  const trace = traces.get(trace_id);
  if(!trace) return res.status(404).json({ ok:false, error:"trace not found", trace_id });
  const md = buildReportMarkdown(trace);
  const html = `<pre>${escapeHtml(md)}</pre>`; // Telegram 안전 전송
  const targetChat = chat_id || trace.chatId || TELEGRAM_ADMIN_CHAT_ID;
  await withTraceLock(trace, async ()=>{ await tgSend(targetChat, html, "HTML"); });
  await logToSheet({ type:"report_sent", input_text: trace.title, output_text: { len: md.length }, project: PROJECT, category:"report", trace_id, ok:true });
  res.json({ ok:true, sent:true, trace_id });
});

const server = app.listen(process.env.PORT || 10000, () => console.log(`🚀 Server is running on port ${process.env.PORT || 10000} (approval_mode=${String(APPROVAL_MODE)})`));

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — closing server...`);
  server.close(() => { console.log("HTTP server closed"); process.exit(0); });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", e); });
process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", e); });
