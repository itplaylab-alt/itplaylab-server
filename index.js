// index.js — ItplayLab 운영 통합본 (테스트 라우트 + 승인 루프 + GAS 로깅 + Telegram + OpenAI)
// Node 18+ / ESM. 필요한 패키지: express, axios, openai (AJV는 없으면 자동 스킵)

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
// Supabase REST 클라이언트 (job_queue 전용)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabaseRest =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? axios.create({
        baseURL: `${SUPABASE_URL}/rest/v1`,
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
      })
    : null;
import crypto from "crypto";
import OpenAI from "openai";
import { callLiteGPT } from "./liteClient.js";
import {
  findByTraceId,
  updateVideoStatus,
  createJobFromPlanQueueRow,
  // ✅ worker가 가져갈 다음 Job 1건 pop
  popNextJobForWorker,
} from "./src/jobRepo.js";

import { startVideoGeneration } from "./src/videoFactoryClient.js";
// Supabase job_queue에서 PENDING 하나 꺼내 RUNNING 으로 잠그기
async function popNextJobFromSupabase() {
  if (!supabaseRest) {
    throw new Error("supabase_not_configured");
  }

  // 1) 가장 오래된 PENDING job 1개 조회
  const { data: jobs } = await supabaseRest.get("/job_queue", {
    params: {
      select: "*",
      status: "eq.PENDING",
      order: "created_at.asc",
      limit: 1,
    },
  });

  // 대기 중인 job 이 없으면 null
  if (!jobs || jobs.length === 0) {
    return null;
  }

  const job = jobs[0];

  // 2) RUNNING 으로 잠그기 (locked_at / locked_by 세팅)
  const updates = {
    status: "RUNNING",
    locked_at: new Date().toISOString(),
    locked_by: "server", // 필요하면 나중에 worker 이름으로 변경
  };

  await supabaseRest.patch(`/job_queue?id=eq.${job.id}`, updates);

  // 갱신된 필드까지 합쳐서 리턴
  return { ...job, ...updates };
}
const app = express();

/* ────────────────────────────────────────────────────────────
   0) 공통 미들웨어
──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  console.log(
    `[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${
      req.headers["content-type"] || ""
    }`
  );
  next();
});
app.use(express.json({ limit: "1mb", type: ["application/json"] }));

// ✅ Healthcheck (Render / PowerShell 확인용)
app.get("/healthcheck", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "itplaylab-server",
    ts: new Date().toISOString(),
    env: {
      approval_mode: process.env.APPROVAL_MODE || null,
      autopilot_env: process.env.AUTOPILOT_ENV || null,
      has_sheet_id: !!process.env.AUTOPILOT_SHEET_ID,
      has_gas_url: !!process.env.GAS_AUTOPILOT_URL,
    },
  });
});

// ✅ AutoPilot v1 – PlanQueue 실데이터 수신 + JobRow 생성
app.post("/autopilot/planqueue", async (req, res) => {
  try {
    const body = req.body || {};
    const { secret, payload } = body;

    // 1) 인증키 확인
    if (!secret || secret !== process.env.AUTOPILOT_API_KEY) {
      console.warn("[AUTOPILOT][PLANQUEUE] ❌ invalid secret");
      return res.status(401).json({
        ok: false,
        error: "invalid_secret",
      });
    }

    // 2) payload 로그
    console.log(
      "[AUTOPILOT][PLANQUEUE] ✅ received:",
      JSON.stringify(payload, null, 2)
    );

    // 2-1) PlanQueue row 기반 JobRow 생성
    const job = await createJobFromPlanQueueRow(payload);

    if (!job) {
      console.warn("[AUTOPILOT][PLANQUEUE] ❌ job create 실패");
      return res.status(500).json({
        ok: false,
        error: "job_create_failed",
      });
    }

    console.log("[AUTOPILOT][PLANQUEUE] ✅ JobRow created:", job);

    // 3) 생성된 Job 정보 응답
    return res.status(200).json({
      ok: true,
      job,
    });
  } catch (err) {
    console.error("[AUTOPILOT][PLANQUEUE] ❌ error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      detail: err.message,
    });
  }
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({
      ok: false,
      error: "invalid_json",
      detail: err.message,
    });
  }
  next();
});

/* 디버그 에코 */
app.post("/debug/echo", (req, res) =>
  res.json({ ok: true, headers: req.headers, body: req.body })
);

/* ────────────────────────────────────────────────────────────
   1) ENV & 상수
──────────────────────────────────────────────────────────── */
const {
  TELEGRAM_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID,
  NOTIFY_LEVEL = "success,error,approval",
  GAS_INGEST_URL,
  INGEST_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL_RESP = "gpt-4.1-mini",
  OPENAI_MODEL_FALLBACK = "gpt-4o-mini",
  OPENAI_MODEL, // 선택적(하위호환)
  PROJECT = "itplaylab",
  SERVICE_NAME = "render-bot",
  APPROVAL_MODE: APPROVAL_MODE_RAW = "true",
  MAX_REVISIONS: MAX_REVISIONS_RAW = "3",
  // ✅ worker 전용 인증키(있으면 사용, 없으면 프리)
  JOBQUEUE_WORKER_SECRET = "",
} = process.env;

const APPROVAL_MODE = String(APPROVAL_MODE_RAW).toLowerCase() === "true";
const MAX_REVISIONS = Number(MAX_REVISIONS_RAW) || 3;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

/* AJV 동적 로드(없어도 동작) */
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
   2) 유틸
──────────────────────────────────────────────────────────── */
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();
const fmtTsKR = (d = new Date()) =>
  d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
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
const shouldNotify = (kind) =>
  NOTIFY_LEVEL.split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(kind);
const labelOf = (key) =>
  DEFAULT_CHECKLIST.find((i) => i.key === key)?.label || key;

function parseChecks(text) {
  const m = text.match(/checks\s*=\s*(\[[^\]]+\]|[^\s]+)/i);
  if (!m) return [];
  const raw = m[1].startsWith("[") ? m[1].slice(1, -1) : m[1];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function approverName(from) {
  const p = [];
  if (from?.first_name) p.push(from.first_name);
  if (from?.last_name) p.push(from.last_name);
  return p.join(" ") || from?.username || `user_${from?.id || "unknown"}`;
}
function buildNotifyMessage({ type, title, message }) {
  const ts = fmtTsKR();
  if (type === "success")
    return `✅ <b>${title || "처리 완료"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "error")
    return `❌ <b>${title || "오류 발생"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "approval")
    return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n🕒 ${ts}`;
}

function requireOpenAI(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
    return false;
  }
  return true;
}

/* GAS 로깅 */
async function logToSheet(payload) {
  const t0 = Date.now();
  if (!GAS_INGEST_URL || !INGEST_TOKEN) return { ok: false, skipped: true };
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

/* 텔레그램 */
async function tgSend(chatId, text, parse_mode = "HTML", extra = {}) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    return await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode,
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    console.error("Telegram send error:", e?.message);
  }
}
async function tgAnswerCallback(id, text = "", show_alert = false) {
  try {
    return await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: id,
      text,
      show_alert,
    });
  } catch (e) {
    console.error("Telegram answerCallbackQuery error:", e?.message);
  }
}

// === VIDEO_STATIC_START ===
// 🔥 v0.1: /videos 정적 파일 제공
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/videos", express.static(path.join(__dirname, "videos")));
// === VIDEO_STATIC_END ===

/* ────────────────────────────────────────────────────────────
   3) 테스트 라우트
──────────────────────────────────────────────────────────── */

// 가장 단순한 핑 라우트 (Express/포트 살아있는지 확인용)
app.get("/__ping", (req, res) => {
  console.log("[HEALTH] __ping called");
  res.send("OK");
});

app.get("/test/healthcheck", (req, res) => {
  console.log("[HEALTH] /test/healthcheck hit");
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
    const r = await logToSheet({
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
    });
    res.json({ ok: true, sent_to_gas: !!r.ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.get("/test/notify", async (req, res) => {
  try {
    const type = String(req.query.type || "success").toLowerCase();
    const title = String(req.query.title || "Ping");
    const message = String(req.query.message || "Render Notify Test");
    if (!shouldNotify(type))
      return res.json({
        ok: true,
        sent: false,
        reason: "filtered_by_NOTIFY_LEVEL",
      });
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
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* 3-1) jobRepo 연동 테스트용 라우트
   - /job/by-trace-id/:id  : 시트에서 ROW 조회
   - /job/update-video     : 시트에 영상 상태/경로 업데이트
*/
app.get("/job/by-trace-id/:trace_id", async (req, res) => {
  const trace_id = req.params.trace_id;
  try {
    const row = await findByTraceId(trace_id);
    if (!row) {
      return res
        .status(404)
        .json({ ok: false, error: "job_not_found", trace_id });
    }
    return res.json({ ok: true, trace_id, row });
  } catch (e) {
    console.error("❌ /job/by-trace-id error:", e?.message);
    return res.status(500).json({
      ok: false,
      error: e?.message || "jobRepo_error",
      trace_id,
    });
  }
});

app.post("/job/update-video", async (req, res) => {
  const {
    trace_id,
    video_status,
    video_path,
    video_latency_ms,
    yt_status,
    yt_video_id,
    kpi_grade,
    error_log,
  } = req.body || {};

  if (!trace_id) {
    return res.status(400).json({ ok: false, error: "trace_id_required" });
  }

  try {
    const updated = await updateVideoStatus(trace_id, {
      video_status,
      video_path,
      video_latency_ms,
      yt_status,
      yt_video_id,
      kpi_grade,
      error_log,
    });

    return res.json({ ok: true, trace_id, row: updated });
  } catch (e) {
    console.error("❌ /job/update-video error:", e?.message);
    return res.status(500).json({
      ok: false,
      error: e?.message || "jobRepo_error",
      trace_id,
    });
  }
});

/* 3-2) Worker용 JobQueue 라우트: /next-job
   - Render Background Worker가 폴링하는 엔드포인트
   - POST/GET 둘 다 지원
   - jobRepo.popNextJobForWorker를 통해 '대기중인 Job 1건'을 pop + 잠금
*/

function isJobqueueAuthOk(req) {
  // env에 JOBQUEUE_WORKER_SECRET이 없으면 인증 스킵
  if (!JOBQUEUE_WORKER_SECRET) return true;
  const key =
    req.headers["x-jobqueue-secret"] ||
    req.headers["x-api-key"] ||
    req.query?.secret ||
    req.body?.secret;
  return key && key === JOBQUEUE_WORKER_SECRET;
}

function extractWorkerMeta(req) {
  const workerId =
    req.body?.worker_id ||
    req.headers["x-worker-id"] ||
    req.headers["x-render-worker-id"] ||
    "anonymous_worker";
  const workerType =
    req.body?.worker_type || req.headers["x-worker-type"] || "render_worker";
  const hostname = req.headers["x-render-compute-hostname"] || "";
  return {
    worker_id: String(workerId),
    worker_type: String(workerType),
    hostname: String(hostname),
  };
}

// Supabase 기반 next-job 핸들러
async function handleNextJob(req, res) {
  try {
    // 1) worker 인증 (선택)
    const expected = process.env.JOBQUEUE_WORKER_SECRET;
    const provided =
      req.headers["x-jobqueue-secret"] ||
      req.headers["x-api-key"] ||
      (req.query && req.query.secret);

    if (expected && expected !== provided) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized_worker",
      });
    }

    // 2) Supabase에서 PENDING job 하나 꺼내오기
    const job = await popNextJobFromSupabase();

    // 3) 대기 job 없으면 no_pending_job 반환
    if (!job) {
      return res.json({
        ok: true,
        has_job: false,
        job: null,
        message: "no_pending_job",
      });
    }

    // 4) job 하나 성공적으로 할당
    return res.json({
      ok: true,
      has_job: true,
      job,
    });
  } catch (err) {
    console.error("❌ /next-job error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "next_job_failed",
      detail: err?.message || String(err),
    });
  }
}
async function handleJobStatusUpdate(req, res) {
  try {
    const jobId = req.params.id;
    const { status, worker_id, latency_ms, error_message } = req.body;

    if (!["DONE", "FAILED"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("job_queue")
      .update({
        status,
        worker_id,
        latency_ms,
        error_message,
        finished_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", jobId)
      .select()
      .maybeSingle();

    if (error) {
      console.error("❌ job update error:", error);
      return res.status(500).json({ error: "update_failed", detail: error });
    }

    return res.json({ ok: true, job: data });
  } catch (err) {
    console.error("❌ /job/:id/status error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}

app.post("/next-job", handleNextJob);
app.get("/next-job", handleNextJob);
// /job/:id/status
app.post(
  "/job/:id/status",
  requireJobQueueSecret,
  express.json(),
  handleJobStatusUpdate
);
/* 대시보드 */
const traces = new Map();
function getTraceSnapshot(t) {
  return {
    trace_id: t.id,
    title: t.title,
    status: t.status,
    current_step: t.steps[t.currentIndex] || null,
    current_index: t.currentIndex,
    steps: t.steps,
    revisionCount: t.revisionCount || 0,
    createdAt: t.createdAt,
  };
}
function groupActive(limitPerBucket = 20) {
  const buckets = {
    running: [],
    paused: [],
    manual_review: [],
    completed: [],
    rejected: [],
  };
  for (const t of traces.values()) {
    const snap = getTraceSnapshot(t);
    if (buckets[snap.status]) buckets[snap.status].push(snap);
    else buckets.paused.push(snap);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k]
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt))
      .reverse();
    buckets[k] = buckets[k].slice(0, limitPerBucket);
  }
  const counts = Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, v.length])
  );
  const total = Array.from(traces.keys()).length;
  return { total, counts, buckets };
}
app.get("/dashboard/active", (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  res.json({ ok: true, ...groupActive(limit) });
});

/* ────────────────────────────────────────────────────────────
   4) OpenAI 공용 호출자 (Responses → Fallback)
──────────────────────────────────────────────────────────── */
async function callOpenAIJson({
  system,
  user,
  schema,
  schemaName = "itplaylab_schema",
}) {
  const started = Date.now();
  let provider = "responses";
  let txt = "";
  let parsed = null;

  try {
    const resp = await oa.responses.create({
      model: OPENAI_MODEL || OPENAI_MODEL_RESP,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response: {
        format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        },
      },
      temperature: 0.2,
    });

    txt =
      resp?.output_text ||
      resp?.output?.[0]?.content?.[0]?.text ||
      "";
    parsed = txt ? JSON.parse(txt) : null;
  } catch (e) {
    // Fallback: Chat Completions
    provider = "chat.completions";
    try {
      const schemaHint = `다음 JSON 스키마에 맞춰 정확히 JSON만 출력하세요. 추가 설명 금지.\n${JSON.stringify(
        schema
      )}`;
      const comp = await oa.chat.completions.create({
        model: OPENAI_MODEL_FALLBACK,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${system}\n\n${schemaHint}`,
          },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      });
      txt = comp?.choices?.[0]?.message?.content || "";
      parsed = txt ? JSON.parse(txt) : null;
    } catch (e2) {
      return {
        ok: false,
        error: `openai_call_failed: ${e2?.message || e?.message}`,
        provider,
        latency_ms: Date.now() - started,
      };
    }
  }

  const validator = await ensureAjv();
  if (!validator)
    return {
      ok: !!parsed,
      data: parsed,
      provider,
      latency_ms: Date.now() - started,
      errors: [],
      raw_text: txt,
    };
  const validate = validator.compile(schema);
  const valid = !!parsed && validate(parsed);
  return {
    ok: !!valid,
    data: parsed,
    provider,
    latency_ms: Date.now() - started,
    errors: valid ? [] : validate.errors,
    raw_text: txt,
  };
}

/* 스키마 */
const SCHEMA_BRIEF = {
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
        properties: {
          sec: { type: "number" },
          beat: { type: "string" },
        },
        required: ["sec", "beat"],
      },
    },
    channels: { type: "array", items: { type: "string" } },
    due_date: { type: "string" },
    owner: { type: "string" },
  },
  required: ["brief_id", "goal", "outline"],
};
const SCHEMA_SCRIPT = {
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
};
const SCHEMA_ASSETS = {
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
};

/* AI 작업자 (DEEP 모드) */
async function aiBrief(idea) {
  return await callOpenAIJson({
    system:
      "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 작성하라.",
    user: JSON.stringify(idea),
    schema: SCHEMA_BRIEF,
    schemaName: "content_brief",
  });
}
async function aiScript(brief) {
  return await callOpenAIJson({
    system:
      "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 출력.",
    user: JSON.stringify(brief),
    schema: SCHEMA_SCRIPT,
    schemaName: "content_script",
  });
}
async function aiAssets({ brief_id, script }) {
  return await callOpenAIJson({
    system:
      "너는 유튜브 운영자다. 썸네일 프롬프트와 제목/설명을 생성하라. 제목 3안, 해시태그 5개. JSON만 출력.",
    user: JSON.stringify({ brief_id, script }),
    schema: SCHEMA_ASSETS,
    schemaName: "content_assets",
  });
}

/* ────────────────────────────────────────────────────────────
   4-1) LITE AI 작업자
──────────────────────────────────────────────────────────── */
async function aiBriefLite(idea, meta = {}) {
  const r = await callLiteGPT("brief", idea, {
    pattern_hint: "auto",
    ...meta,
  });

  return {
    ok: r.ok,
    data: r.output,
    provider: r.debug?.engine || "gpt-4o-mini-lite",
    latency_ms: r.debug?.latency_ms ?? 0,
    raw: r,
  };
}

async function aiScriptLite(brief, meta = {}) {
  const r = await callLiteGPT("script", brief, {
    pattern_hint: "auto",
    ...meta,
  });

  return {
    ok: r.ok,
    data: r.output,
    provider: r.debug?.engine || "gpt-4o-mini-lite",
    latency_ms: r.debug?.latency_ms ?? 0,
    raw: r,
  };
}

/* ────────────────────────────────────────────────────────────
   5) 공정 실행기
──────────────────────────────────────────────────────────── */
async function executeStep(trace, stepName) {
  const startedAt = nowISO();
  let latency_ms = 0;
  let provider = "";
  try {
    let r;
    if (stepName === "brief") {
      r = await aiBrief({
        title: trace.title,
        profile: trace.profile,
      });
      trace.lastOutput.brief = r.data;
    } else if (stepName === "script") {
      r = await aiScript(trace.lastOutput.brief);
      trace.lastOutput.script = r.data;
    } else if (stepName === "assets") {
      r = await aiAssets({
        brief_id: trace.lastOutput.brief?.brief_id,
        script: trace.lastOutput.script,
      });
      trace.lastOutput.assets = r.data;
    } else {
      throw new Error(`unknown step: ${stepName}`);
    }
    latency_ms = r.latency_ms;
    provider = r.provider;
    if (!r.ok)
      throw new Error(
        r.errors?.[0]?.message || r.error || "schema_validation_failed"
      );

    trace.history.push({
      step: stepName,
      ok: true,
      latency_ms,
      provider,
      startedAt,
      finishedAt: nowISO(),
    });
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
      provider,
    });

    if (shouldNotify("success")) {
      const msg = [
        fmtTitle(trace.title),
        fmtTrace(trace.id),
        `단계: <b>${labelStep(stepName)}</b>`,
        `지연시간: <code>${latency_ms}ms</code>`,
        `엔진: <code>${provider}</code>`,
      ].join("\n");
      await tgSend(
        trace.chatId,
        buildNotifyMessage({
          type: "success",
          title: `${labelStep(stepName)} 완료`,
          message: msg,
        })
      );
    }
    return { ok: true, latency_ms };
  } catch (e) {
    const error = e?.message || String(e);
    trace.history.push({
      step: stepName,
      ok: false,
      latency_ms,
      provider,
      error,
      startedAt,
      finishedAt: nowISO(),
    });
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
      provider,
    });
    if (shouldNotify("error")) {
      const msg = [
        fmtTitle(trace.title),
        fmtTrace(trace.id),
        `단계: <b>${labelStep(stepName)}</b>`,
        `사유: <code>${error}</code>`,
        provider ? `엔진: <code>${provider}</code>` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await tgSend(
        trace.chatId,
        buildNotifyMessage({
          type: "error",
          title: `${labelStep(stepName)} 실패`,
          message: msg,
        })
      );
    }
    throw e;
  }
}
const getNextStep = (trace) =>
  trace.currentIndex + 1 < trace.steps.length
    ? trace.steps[trace.currentIndex + 1]
    : null;

async function pauseForApproval(trace) {
  const next = getNextStep(trace);
  if (!next) {
    trace.status = "completed";
    if (shouldNotify("success")) {
      const msg = [
        fmtTitle(trace.title),
        fmtTrace(trace.id),
        `진행 상태: <b>모든 단계 완료</b>`,
      ].join("\n");
      await tgSend(
        trace.chatId,
        buildNotifyMessage({
          type: "success",
          title: "출고 완료",
          message: msg,
        })
      );
    }
    return;
  }
  trace.status = "paused";
  if (shouldNotify("approval")) {
    const nextK = labelStep(next);
    const checklistLine = DEFAULT_CHECKLIST.map(
      (i) => `- ${i.label} (${i.key})`
    ).join("\n");
    const revLine =
      trace.revisionCount > 0
        ? `수정 회차: <b>${trace.revisionCount}</b> / ${MAX_REVISIONS}`
        : `수정 회차: 0 / ${MAX_REVISIONS}`;
    const msg = [
      fmtTitle(trace.title),
      fmtTrace(trace.id),
      revLine,
      `다음 단계: <b>${nextK}</b>`,
      "",
      "검수 체크리스트:",
      checklistLine,
      "",
      "버튼 또는 명령 사용:",
      `<code>/approve ${trace.id} step=${next} checks=accuracy,policy</code>`,
      `<code>/reject ${trace.id} reason="톤 수정 필요" checks=brand,length</code>`,
      `상태: <code>/status ${trace.id}</code>`,
    ].join("\n");
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: `✅ 승인 (다음: ${nextK})`,
            callback_data: `appr:${trace.id}:${next}`,
          },
        ],
        [
          {
            text: "❌ 반려",
            callback_data: `rej:${trace.id}`,
          },
          {
            text: "📊 상태",
            callback_data: `stat:${trace.id}`,
          },
        ],
      ],
    };
    await tgSend(
      trace.chatId,
      buildNotifyMessage({
        type: "approval",
        title: "다음 단계 승인 대기",
        message: msg,
      }),
      "HTML",
      { reply_markup: keyboard }
    );
  }
}

async function runFromCurrent(trace) {
  trace.status = "running";
  const stepName = trace.steps[trace.currentIndex];
  await executeStep(trace, stepName);
  if (APPROVAL_MODE) {
    await pauseForApproval(trace);
  } else {
    trace.currentIndex += 1;
    if (trace.currentIndex < trace.steps.length) await runFromCurrent(trace);
    else {
      trace.status = "completed";
      if (shouldNotify("success")) {
        const msg = [
          fmtTitle(trace.title),
          fmtTrace(trace.id),
          `진행 상태: <b>모든 단계 완료</b>`,
        ].join("\n");
        await tgSend(
          trace.chatId,
          buildNotifyMessage({
            type: "success",
            title: "출고 완료",
            message: msg,
          })
        );
      }
    }
  }
}
/* ────────────────────────────────────────────────────────────
   6) 파서
──────────────────────────────────────────────────────────── */
function parseFreeText(text) {
  const lower = text.toLowerCase();
  let steps = ["brief", "script", "assets"];
  if (lower.includes("브리프")) steps = ["brief"];
  if (lower.includes("스크립트")) steps = ["script"];
  if (lower.includes("에셋") || lower.includes("메타")) steps = ["assets"];
  const title =
    text
      .replace(/(브리프|스크립트|에셋|만들어줘|전체|전부|메타|전략)/g, "")
      .trim() || "무제";
  const profileMatch = text.match(/profile=([\w-]+)/i);
  const profile = profileMatch ? profileMatch[1] : "-";
  return { title, steps, profile };
}
function parseTelegramCommand(text) {
  const [cmd, idOrText, ...rest] = text.trim().split(/\s+/);
  const trace_id =
    idOrText && idOrText.startsWith("trc_") ? idOrText : undefined;
  const argsText = rest.join(" ");
  const stepMatch = argsText.match(/step=([a-z]+)/i);
  const reasonMatch = argsText.match(/reason=("([^"]+)"|([^\s]+))/i);
  const reason = reasonMatch ? reasonMatch[2] || reasonMatch[3] : undefined;
  const step = stepMatch ? stepMatch[1] : undefined;
  return { cmd, trace_id, step, reason };
}

/* ────────────────────────────────────────────────────────────
   7) REST: 콘텐츠 라인
──────────────────────────────────────────────────────────── */

/* LITE 전용 라인 */
app.post("/content/lite/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = req.body || {};
    if (!idea.title)
      return res.status(400).json({ ok: false, error: "title required" });

    const r = await aiBriefLite(idea);

    await logToSheet({
      type: "content_lite_brief",
      input_text: idea.title,
      output_text: r.data,
      project: PROJECT,
      category: "brief_lite",
      note: "via /content/lite/brief",
      latency_ms: r.latency_ms,
      ok: r.ok,
      provider: r.provider,
    });

    res.json({
      ok: r.ok,
      latency_ms: Date.now() - t0,
      brief: r.data,
      debug: {
        provider: r.provider,
        latency_ms: r.latency_ms,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "lite_openai_error" });
  }
});

app.post("/content/lite/script", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const brief = req.body || {};
    const r = await aiScriptLite(brief);

    await logToSheet({
      type: "content_lite_script",
      input_text: brief.brief_id || "",
      output_text: r.data,
      project: PROJECT,
      category: "script_lite",
      note: "via /content/lite/script",
      latency_ms: r.latency_ms,
      ok: r.ok,
      provider: r.provider,
    });

    res.json({
      ok: r.ok,
      latency_ms: Date.now() - t0,
      script: r.data,
      debug: {
        provider: r.provider,
        latency_ms: r.latency_ms,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "lite_openai_error" });
  }
});

/* 기존 DEEP 모드 라인 */
app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = req.body || {};
    if (!idea.title)
      return res.status(400).json({ ok: false, error: "title required" });
    const r = await aiBrief(idea);
    await logToSheet({
      type: "content_brief",
      input_text: idea.title,
      output_text: r.data,
      project: PROJECT,
      category: "brief",
      note: "via /content/brief",
      latency_ms: r.latency_ms,
      ok: r.ok,
      provider: r.provider,
    });
    res.json({
      ok: r.ok,
      latency_ms: Date.now() - t0,
      brief: r.data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});
app.post("/content/script", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const brief = req.body || {};
    const r = await aiScript(brief);
    await logToSheet({
      type: "content_script",
      input_text: brief.brief_id || "",
      output_text: r.data,
      project: PROJECT,
      category: "content",
      note: "via /content/script",
      latency_ms: r.latency_ms,
      ok: r.ok,
      provider: r.provider,
    });
    res.json({
      ok: r.ok,
      latency_ms: Date.now() - t0,
      script: r.data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});
app.post("/content/assets", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const { brief_id, script } = req.body || {};
    const r = await aiAssets({ brief_id, script });
    await logToSheet({
      type: "content_assets",
      input_text: brief_id || "",
      output_text: r.data,
      project: PROJECT,
      category: "asset",
      note: "via /content/assets",
      latency_ms: r.latency_ms,
      ok: r.ok,
      provider: r.provider,
    });
    res.json({
      ok: r.ok,
      latency_ms: Date.now() - t0,
      assets: r.data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});
app.post("/content/run", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const started = Date.now();
  const {
    title,
    steps = ["brief", "script", "assets"],
    profile = "-",
    chatId = TELEGRAM_ADMIN_CHAT_ID,
  } = req.body || {};
  if (!title)
    return res.status(400).json({ ok: false, error: "title required" });

  const trace_id = genTraceId();
  const trace = {
    id: trace_id,
    createdAt: nowISO(),
    chatId,
    title,
    profile,
    steps,
    currentIndex: 0,
    approvalMode: APPROVAL_MODE,
    history: [],
    lastOutput: {},
    status: "initialized",
    revisionCount: 0,
  };
  traces.set(trace_id, trace);

  try {
    await runFromCurrent(trace);
    res.json({
      ok: true,
      latency_ms: Date.now() - started,
      trace_id,
      step: trace.steps[trace.currentIndex],
      status: trace.status,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      latency_ms: Date.now() - started,
      trace_id,
      step: trace.steps[trace.currentIndex],
      error: String(e?.message || e),
    });
  }
});
// 단순 파이프라인 실행용 엔드포인트 (/content/run 래핑 버전)
app.post("/content/pipeline", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const started = Date.now();

  try {
    const {
      title,
      idea_id,
      steps = ["brief", "script", "assets"],
      profile = "default",
      chatId = TELEGRAM_ADMIN_CHAT_ID,
    } = req.body || {};

    const finalTitle = title || idea_id;
    if (!finalTitle) {
      return res
        .status(400)
        .json({ ok: false, error: "title_or_idea_id_required" });
    }

    const trace_id = genTraceId();
    const trace = {
      id: trace_id,
      createdAt: nowISO(),
      chatId,
      title: finalTitle,
      profile,
      steps,
      currentIndex: 0,
      approvalMode: APPROVAL_MODE,
      history: [],
      lastOutput: {},
      status: "initialized",
      revisionCount: 0,
    };
    traces.set(trace_id, trace);

    await runFromCurrent(trace);

    return res.json({
      ok: true,
      latency_ms: Date.now() - started,
      trace_id,
      step: trace.steps[trace.currentIndex],
      status: trace.status,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      latency_ms: Date.now() - started,
      error: String(e?.message || e),
    });
  }
});

/* 승인/반려/상태/리포트 */
app.post("/approve", async (req, res) => {
  const { trace_id, step, checks = [], by = "api" } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace)
    return res
      .status(404)
      .json({ ok: false, error: "trace not found", trace_id });

  const expectedNext = getNextStep(trace);
  if (step && expectedNext && step !== expectedNext)
    return res.status(400).json({
      ok: false,
      error: `unexpected step. expected: ${expectedNext}`,
      trace_id,
    });

  if (trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;
  await logToSheet({
    type: "approval_approve",
    input_text: trace.title,
    output_text: { by, checks },
    project: PROJECT,
    category: "approval",
    note: `trace=${trace.id}`,
    trace_id,
    step: trace.steps[trace.currentIndex],
    ok: true,
  });

  try {
    await runFromCurrent(trace);
    return res.json({
      ok: true,
      trace_id,
      status: trace.status,
      step: trace.steps[trace.currentIndex],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      trace_id,
    });
  }
});
app.post("/reject", async (req, res) => {
  const { trace_id, reason = "", checks = [], by = "api" } = req.body || {};
  const trace = traces.get(trace_id);
  if (!trace)
    return res
      .status(404)
      .json({ ok: false, error: "trace not found", trace_id });
  trace.status = "rejected";
  trace.rejectReason = reason;
  await logToSheet({
    type: "approval_reject",
    input_text: trace.title,
    output_text: { by, reason, checks },
    project: PROJECT,
    category: "approval",
    note: `trace=${trace.id}`,
    trace_id,
    step: trace.steps[trace.currentIndex],
    ok: false,
    error: `REJECTED: ${reason}`,
  });

  if (shouldNotify("approval")) {
    const msg = [
      fmtTitle(trace.title),
      fmtTrace(trace.id),
      `진행 상태: <b>반려</b>`,
      `반려자: <b>${by}</b>`,
      `사유: <code>${reason || "-"}</code>`,
      checks.length
        ? `체크: ${checks.map((k) => labelOf(k)).join(", ")}`
        : "체크: -",
    ].join("\n");
    await tgSend(
      trace.chatId,
      buildNotifyMessage({
        type: "error",
        title: "반려 처리됨",
        message: msg,
      })
    );
  }
  res.json({ ok: true, trace_id, status: trace.status });
});
app.get("/status/:trace_id", (req, res) => {
  const trace = traces.get(req.params.trace_id);
  if (!trace)
    return res.status(404).json({
      ok: false,
      error: "trace not found",
      trace_id: req.params.trace_id,
    });
  res.json({
    ok: true,
    latency_ms: 0,
    trace_id: trace.id,
    status: trace.status,
    current_index: trace.currentIndex,
    steps: trace.steps,
    history: trace.history,
    last_output_keys: Object.keys(trace.lastOutput || {}),
  });
});
function buildSummaryReport(trace) {
  const success = trace.history.filter((h) => h.ok).length;
  const fail = trace.history.filter((h) => !h.ok).length;
  const vals = trace.history
    .map((h) => Number(h.latency_ms || 0))
    .filter((v) => v > 0);
  const avgLatency = vals.length
    ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
    : 0;
  const stepsMark = trace.steps
    .map((s, idx) =>
      idx < trace.currentIndex
        ? `✔ ${labelStep(s)}`
        : idx === trace.currentIndex
        ? `⏳ ${labelStep(s)}`
        : `… ${labelStep(s)}`
    )
    .join(" → ");
  const outKeys = Object.keys(trace.lastOutput || {});
  return [
    fmtTitle(trace.title),
    fmtTrace(trace.id),
    `상태: <b>${trace.status}</b> (수정 회차: ${trace.revisionCount}/${MAX_REVISIONS})`,
    `진행: ${stepsMark}`,
    `성공/실패: ${success}/${fail}`,
    `평균 지연: ${avgLatency}ms`,
    `산출물: ${outKeys.length ? outKeys.join(", ") : "-"}`,
  ].join("\n");
}

/* ────────────────────────────────────────────────────────────
   8) Telegram Webhook
──────────────────────────────────────────────────────────── */
// --------------------------------------------------------------
// 테스트용 GAS 로깅 엔드포인트
// --------------------------------------------------------------
app.get("/test/gas-log", async (req, res) => {
  try {
    const result = await logToSheet({
      chat_id: "render_test_chat",
      username: "render_server",
      type: "render_test_v0_1",
      input_text: "hello_from_/test/gas-log",
      ts: new Date().toISOString(),
    });

    return res.status(result.ok ? 200 : 500).json({
      from: "render",
      endpoint: "/test/gas-log",
      gas_ingest_url: GAS_INGEST_URL,
      payload_example: {
        chat_id: "render_test_chat",
        username: "render_server",
        type: "render_test_v0_1",
        input_text: "hello_from_/test/gas-log",
      },
      result,
    });
  } catch (err) {
    console.error("[GET /test/gas-log] error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const cq = body.callback_query || null;
    const message = body.message || body.edited_message || cq?.message || null;

    // --------------------------------------------------------------
    // Telegram → GAS 공용 로깅 (fire & forget)
    // --------------------------------------------------------------
    try {
      const fromAll = cq?.from || message?.from || {};
      const chatForLog = message?.chat || cq?.message?.chat || {};

      const chatIdForLog = chatForLog.id || TELEGRAM_ADMIN_CHAT_ID;
      const usernameForLog =
        fromAll.username ||
        [fromAll.first_name, fromAll.last_name].filter(Boolean).join(" ") ||
        "unknown";
      const textForLog = (cq?.data || message?.text || "").trim();

      logToSheet({
        chat_id: chatIdForLog,
        username: usernameForLog,
        type: cq ? "tg_callback" : "tg_message",
        input_text: textForLog,
        pipeline_stage: "telegram_webhook",
      }).catch((err) => {
        console.error("[telegram/webhook] logToSheet error:", err);
      });
    } catch (err) {
      console.error("[telegram/webhook] logging block failed:", err);
    }

    // --------------------------------------------------
    // 1) callback_query 처리 (버튼 눌렀을 때)
    // --------------------------------------------------
    if (cq) {
      const data = cq.data || "";
      const from = cq.from;
      const chatId = cq.message?.chat?.id || TELEGRAM_ADMIN_CHAT_ID;
      const answer = (text) => tgAnswerCallback(cq.id, text, false);

      // ✅ 인라인 승인(appr:...) 버튼
      if (data.startsWith("appr:")) {
        const [, tid, step] = data.split(":");
        const trace = traces.get(tid);

        if (!trace) {
          await answer("작업을 찾을 수 없습니다.");
          return res.json({ ok: true });
        }

        const expectedNext = getNextStep(trace);
        if (expectedNext && step && expectedNext !== step) {
          await answer(`예상 단계와 다릅니다. expected: ${expectedNext}`);
          return res.json({ ok: true });
        }

        if (trace.currentIndex + 1 < trace.steps.length) {
          trace.currentIndex += 1;
        }

        const approvedBy = approverName(from);

        await logToSheet({
          type: "approval_approve",
          input_text: trace.title,
          output_text: { by: approvedBy, checks: ["inline"] },
          project: PROJECT,
          category: "approval",
          note: `trace=${trace.id}`,
          trace_id: trace.id,
          step: trace.steps[trace.currentIndex],
          ok: true,
        });

        // 🔥 승인 후 mock 영상 생성 시도
        try {
          await startVideoGeneration(trace.id);
        } catch (err) {
          console.error(
            "[VideoFactory] Failed to start video generation:",
            err?.message || err
          );
          // 영상 생성 실패해도 승인/다음 단계 진행은 계속
        }

        await answer("✅ 승인 처리됨");
        await tgSend(
          chatId,
          `✅ <b>승인 처리</b>\n${fmtTitle(
            trace.title
          )}\n${fmtTrace(trace.id)}\n다음 단계 진행합니다.`,
          "HTML"
        );

        try {
          await runFromCurrent(trace);
        } catch (err) {
          console.error("[runFromCurrent] error:", err);
        }

        return res.json({ ok: true });
      }

      // ❌ 인라인 반려(rej:...) 버튼
      if (data.startsWith("rej:")) {
        const [, tid] = data.split(":");
        const trace = traces.get(tid);

        if (!trace) {
          await answer("작업을 찾을 수 없습니다.");
          return res.json({ ok: true });
        }

        trace.status = "rejected";
        const rejectedBy = approverName(from);

        await logToSheet({
          type: "approval_reject",
          input_text: trace.title,
          output_text: { by: rejectedBy, reason: "inline_reject" },
          project: PROJECT,
          category: "approval",
          note: `trace=${trace.id}`,
          trace_id: trace.id,
          step: trace.steps[trace.currentIndex],
          ok: false,
          error: "REJECTED:inline",
        });

        await answer("❌ 반려 처리됨");

        const msg = [
          fmtTitle(trace.title),
          fmtTrace(trace.id),
          `진행 상태: <b>반려</b>`,
          `반려자: <b>${rejectedBy}</b>`,
          `사유: <code>inline_reject</code>`,
        ].join("\n");

        await tgSend(
          chatId,
          buildNotifyMessage({
            type: "error",
            title: "반려 처리됨",
            message: msg,
          })
        );

        return res.json({ ok: true });
      }

      // ℹ️ 상태 조회(stat:...) 버튼
      if (data.startsWith("stat:")) {
        const [, tid] = data.split(":");
        const trace = traces.get(tid);

        if (!trace) {
          await answer("작업을 찾을 수 없습니다.");
          return res.json({ ok: true });
        }

        const hist = trace.history
          .map(
            (h) =>
              `${labelStep(h.step)}:${
                h.ok ? "✅" : "❌"
              }(${h.latency_ms ?? 0}ms/${h.provider || "-"})`
          )
          .join(" → ");

        const msg = [
          fmtTitle(trace.title),
          fmtTrace(trace.id),
          `진행 기록: ${hist || "-"}`,
          `현재 위치: index ${trace.currentIndex}/${trace.steps.length}`,
          `상태: <b>${trace.status}</b>`,
        ].join("\n");

        await answer("ℹ️ 상태 전송");
        await tgSend(chatId, msg, "HTML");

        return res.json({ ok: true });
      }

      // 처리되지 않은 버튼
      await answer("처리되지 않은 버튼");
      return res.json({ ok: true });
    }

    // --------------------------------------------------
    // 2) 일반 메시지 처리 (슬래시 명령 & 자연어)
    // --------------------------------------------------
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    // /approve, /승인
    if (text.startsWith("/approve") || text.startsWith("/승인")) {
      const { trace_id, step } = parseTelegramCommand(text);
      const checks = parseChecks(text);
      const trace = trace_id && traces.get(trace_id);

      if (!trace) {
        await tgSend(
          chatId,
          `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`
        );
        return res.json({ ok: true });
      }

      const expectedNext = getNextStep(trace);
      if (step && expectedNext && step !== expectedNext) {
        await tgSend(
          chatId,
          `예상 단계와 다릅니다. expected: ${expectedNext}`
        );
        return res.json({ ok: true });
      }

      if (trace.currentIndex + 1 < trace.steps.length) {
        trace.currentIndex += 1;
      }

      const approvedBy = approverName(message.from);

      await logToSheet({
        type: "approval_approve",
        input_text: trace.title,
        output_text: { by: approvedBy, checks },
        project: PROJECT,
        category: "approval",
        note: `trace=${trace.id}`,
        trace_id: trace.id,
        step: trace.steps[trace.currentIndex],
        ok: true,
      });

      await runFromCurrent(trace);

      const msg = [
        fmtTitle(trace.title),
        fmtTrace(trace.id),
        `승인자: <b>${approvedBy}</b>`,
        checks.length
          ? `체크: ${checks.map((k) => labelOf(k)).join(", ")}`
          : "체크: -",
        `상태: <b>${trace.status}</b>`,
      ].join("\n");

      await tgSend(
        chatId,
        buildNotifyMessage({
          type: "success",
          title: "승인 처리됨",
          message: msg,
        })
      );

      return res.json({ ok: true });
    }

    // /reject, /반려
    if (text.startsWith("/reject") || text.startsWith("/반려")) {
      const { trace_id, reason = "" } = parseTelegramCommand(text);
      const checks = parseChecks(text);
      const trace = trace_id && traces.get(trace_id);

      if (!trace) {
        await tgSend(
          chatId,
          `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`
        );
        return res.json({ ok: true });
      }

      trace.status = "rejected";
      trace.rejectReason = reason;

      const rejectedBy = approverName(message.from);

      await logToSheet({
        type: "approval_reject",
        input_text: trace.title,
        output_text: { by: rejectedBy, reason, checks },
        project: PROJECT,
        category: "approval",
        note: `trace=${trace.id}`,
        trace_id: trace.id,
        step: trace.steps[trace.currentIndex],
        ok: false,
        error: `REJECTED: ${reason}`,
      });

      const msg = [
        fmtTitle(trace.title),
        fmtTrace(trace.id),
        `진행 상태: <b>반려</b>`,
        `반려자: <b>${rejectedBy}</b>`,
        `사유: <code>${reason || "-"}</code>`,
        checks.length
          ? `체크: ${checks.map((k) => labelOf(k)).join(", ")}`
          : "체크: -",
      ].join("\n");

      await tgSend(
        chatId,
        buildNotifyMessage({
          type: "error",
          title: "반려 처리됨",
          message: msg,
        })
      );

      return res.json({ ok: true });
    }

    // /status, /상태
    if (text.startsWith("/status") || text.startsWith("/상태")) {
      const { trace_id } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);

      if (!trace) {
        await tgSend(
          chatId,
          `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`
        );
      } else {
        const hist = trace.history
          .map(
            (h) =>
              `${labelStep(h.step)}:${
                h.ok ? "✅" : "❌"
              }(${h.latency_ms ?? 0}ms/${h.provider || "-"})`
          )
          .join(" → ");

        const msg = [
          fmtTitle(trace.title),
          fmtTrace(trace.id),
          `진행 기록: ${hist || "-"}`,
          `현재 위치: index ${trace.currentIndex}/${trace.steps.length}`,
          `상태: <b>${trace.status}</b>`,
        ].join("\n");

        await tgSend(chatId, msg, "HTML");
      }

      return res.json({ ok: true });
    }

    // /report, /리포트
    if (text.startsWith("/report") || text.startsWith("/리포트")) {
      const { trace_id } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);

      if (!trace) {
        await tgSend(
          chatId,
          `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`
        );
        return res.json({ ok: true });
      }

      await tgSend(chatId, buildSummaryReport(trace), "HTML");
      return res.json({ ok: true });
    }

    // 자연어 요청 (트레이스 생성)
    if (!text.startsWith("/")) {
      const { title, steps, profile } = parseFreeText(text);
      const trace_id = genTraceId();
      const trace = {
        id: trace_id,
        createdAt: nowISO(),
        chatId,
        title,
        profile,
        steps,
        currentIndex: 0,
        approvalMode: APPROVAL_MODE,
        history: [],
        lastOutput: {},
        status: "initialized",
        revisionCount: 0,
      };

      traces.set(trace_id, trace);

      await tgSend(
        chatId,
        buildNotifyMessage({
          type: "success",
          title: "요청 접수",
          message: `${fmtTrace(trace_id)}`,
        })
      );

      try {
        await runFromCurrent(trace);
      } catch (err) {
        console.error("[runFromCurrent] error:", err);
      }

      await logToSheet({
        type: "telegram_text",
        input_text: text,
        output_text: { title, steps, profile, chatId },
        project: PROJECT,
        category: "chat",
        note: `trace=${trace_id}`,
        trace_id,
      });

      return res.json({ ok: true });
    }

    // 기타: 단순 에코
    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ /telegram/webhook error:", e?.message);
    if (shouldNotify("error")) {
      try {
        await tgSend(
          TELEGRAM_ADMIN_CHAT_ID,
          buildNotifyMessage({
            type: "error",
            title: "Webhook 처리 오류",
            message: e?.message || "unknown",
          })
        );
      } catch (err) {
        console.error("tgSend admin error:", err);
      }
    }
    return res.sendStatus(500);
  }
});
/* 루트 웹훅(에코) */
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
          buildNotifyMessage({
            type: "error",
            title: "Webhook 처리 오류",
            message: e?.message || "unknown",
          })
        );
      } catch {}
    }
    res.sendStatus(500);
  }
});

// Google Apps Script 연결 테스트
app.get("/test-gas", async (req, res) => {
  try {
    const resp = await fetch(process.env.GAS_INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: process.env.INGEST_TOKEN,
        contents: {
          type: "test_log",
          message: "hello_from_render_test",
        },
      }),
    });

    const text = await resp.text();
    return res.send(`GAS Response: ${text}`);
  } catch (e) {
    console.error("GAS ERROR:", e);
    return res.status(500).send("GAS ERROR");
  }
});

// ⚠️ 필요하면 환경변수로 dev 여부 제어
const IS_DEV = true;

/**
 * DEV 1) video_status 업데이트 테스트
 * GET /dev/test-video-status?trace_id=trc_xxxx&status=video_generating
 */
if (IS_DEV) {
  app.get("/dev/test-video-status", async (req, res) => {
    const traceId = req.query.trace_id;
    const status = req.query.status || "video_generating";

    if (!traceId) {
      return res
        .status(400)
        .json({ ok: false, error: "trace_id query param required" });
    }

    try {
      const result = await updateVideoStatus(traceId, status);
      return res.json({ ok: true, traceId, status, result });
    } catch (err) {
      console.error("GET /dev/test-video-status error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "internal_error" });
    }
  });

  /**
   * DEV 2) video-factory callback 직접 호출 테스트 (성공)
   * POST /dev/test-callback-done
   * body: { trace_id, video_url?, thumbnail_url?, duration? }
   */
  app.post("/dev/test-callback-done", async (req, res) => {
    const {
      trace_id: traceId,
      video_url,
      thumbnail_url,
      duration,
    } = req.body || {};

    if (!traceId) {
      return res
        .status(400)
        .json({ ok: false, error: "trace_id required in body" });
    }

    try {
      await updateVideoStatus(traceId, "video_done", {
        video_url,
        video_thumbnail_url: thumbnail_url,
        video_duration_sec: duration,
      });

      await updateVideoStatus(traceId, "upload_pending");

      return res.json({
        ok: true,
        traceId,
        status: "video_done → upload_pending",
      });
    } catch (err) {
      console.error("POST /dev/test-callback-done error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "internal_error" });
    }
  });

  /**
   * DEV 3) video-factory callback 직접 호출 테스트 (실패)
   * POST /dev/test-callback-failed
   * body: { trace_id, error_message? }
   */
  app.post("/dev/test-callback-failed", async (req, res) => {
    const { trace_id: traceId, error_message } = req.body || {};

    if (!traceId) {
      return res
        .status(400)
        .json({ ok: false, error: "trace_id required in body" });
    }

    try {
      await updateVideoStatus(traceId, "video_failed", {
        video_error_message: error_message || "mock error from dev route",
      });

      return res.json({
        ok: true,
        traceId,
        status: "video_failed",
      });
    } catch (err) {
      console.error("POST /dev/test-callback-failed error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "internal_error" });
    }
  });

  /**
   * DEV 4) startVideoGeneration 단독 테스트
   * GET /dev/test-start-video?trace_id=trc_xxxx
   */
  app.get("/dev/test-start-video", async (req, res) => {
    const traceId = req.query.trace_id;

    if (!traceId) {
      return res
        .status(400)
        .json({ ok: false, error: "trace_id query param required" });
    }

    try {
      await startVideoGeneration(traceId);
      return res.json({ ok: true, traceId });
    } catch (err) {
      console.error("GET /dev/test-start-video error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "internal_error" });
    }
  });
}

const PORT = process.env.PORT || 10000;

/* ─────────────────────────────────────────────
   AutoPilot v1 — Plan → Produce 단일 루프
───────────────────────────────────────────── */

const GAS_AUTOPILOT_URL = process.env.GAS_AUTOPILOT_URL;
const AUTOPILOT_API_KEY = process.env.AUTOPILOT_API_KEY;

// GAS 호출 헬퍼
async function callAutopilotGAS(action, payload = {}) {
  const res = await axios.post(GAS_AUTOPILOT_URL, {
    action,
    api_key: AUTOPILOT_API_KEY,
    ...payload,
  });
  return res.data;
}

// topic → 테스트용 콘텐츠 생성
async function autopilotProduce(topic) {
  const prompt = `주제: ${topic}
한 문단짜리 아주 짧은 테스트 스크립트를 작성해줘.`;

  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL_RESP,
    messages: [
      { role: "system", content: "테스트용 콘텐츠 생성기" },
      { role: "user", content: prompt },
    ],
    max_tokens: 200,
  });

  return r.choices?.[0]?.message?.content || "";
}

// AutoPilot 실행 라우트
app.post("/autopilot/run", async (req, res) => {
  console.log("[AutoPilot] run");

  try {
    const plan = await callAutopilotGAS("getNextPlan");

    if (!plan || !plan.plan_id) {
      return res.json({
        ok: true,
        message: "no pending plan",
      });
    }

    await callAutopilotGAS("updatePlanStatus", {
      plan_id: plan.plan_id,
      status: "processing",
    });

    const result = await autopilotProduce(plan.topic);

    await callAutopilotGAS("logProduction", {
      plan_id: plan.plan_id,
      result,
    });

    await callAutopilotGAS("incrementKPI", {
      date: new Date().toISOString().slice(0, 10),
      field: "produced",
      amount: 1,
    });

    await callAutopilotGAS("updatePlanStatus", {
      plan_id: plan.plan_id,
      status: "done",
    });

    res.json({
      ok: true,
      plan_id: plan.plan_id,
    });
  } catch (e) {
    console.error("[AutoPilot ERROR]", e);
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});
// 3-x) JobQueue Worker용 next-job 엔드포인트 (임시 버전)
app.get("/next-job", (req, res) => {
  const expected = process.env.JOBQUEUE_WORKER_SECRET;
  const provided = req.headers["x-jobqueue-secret"];

  if (expected && provided !== expected) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized_worker",
    });
  }

  return res.json({
    ok: true,
    has_job: false,
    job: null,
    message: "no_pending_job",
  });
});

app.listen(PORT, () => {
  console.log(
    `🚀 Server is running on port ${PORT} (approval_mode=${APPROVAL_MODE})`
  );
});
