// index.js — ItplayLab 최종 정리본 (모듈 분리 버전)
// Node 18+ / ESM

import dotenv from "dotenv";
dotenv.config();
import "dotenv/config";

import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { runWorkerOnce } from "./src/worker.js";

// ✅ 라벨 주입 (it2)
import { labelsForIt2Command } from "./lib/opLabels.js";

// ─────────────────────────────────────────
//  공통 설정
// ─────────────────────────────────────────
import { CONFIG } from "./lib/config.js";
console.log("[DEBUG] ENQUEUE_SECRET =", process.env.JOBQUEUE_ENQUEUE_SECRET);

// 서비스 계층 (it1 bot)
import { logToSheet } from "./services/gasLogger.js";
import {
  tgSend,
  tgAnswerCallback,
  buildNotifyMessage,
  shouldNotify,
} from "./services/telegramBot.js";

// 리포지토리 계층 (Supabase + GAS)
import {
  findByTraceId,
  updateVideoStatus,
  createJobFromPlanQueueRow,
} from "./src/jobRepo.js";

// 비디오 생성기
import { startVideoGeneration } from "./src/videoFactoryClient.js";

// ─────────────────────────────────────────
// Supabase 클라이언트 (job_queue/event_log용)
// ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────
// ✅ event_log 원장 고정: 단일 insert 유틸
//   - 실패해도 본 흐름을 깨지 않도록 try/catch로 감쌈
// ─────────────────────────────────────────
async function logEvent({
  trace_id,
  job_id = null,
  stage,
  ok = null,
  latency_ms = null,
  message = null,
  payload = null,
}) {
  try {
    const { error } = await supabase.from("event_log").insert([
      {
        trace_id,
        job_id,
        stage,
        ok,
        latency_ms,
        message,
        payload,
      },
    ]);
    if (error) console.warn("[event_log] insert failed:", error.message);
  } catch (e) {
    console.warn("[event_log] exception:", e?.message || e);
  }
}

// ─────────────────────────────────────────
// 서버 준비
// ─────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb", type: ["application/json"] }));

// /next-job 로그 최소화 옵션 (요청 로그는 여기서만 처리하도록 단일화)
let lastJobLogAt = 0;
app.use((req, res, next) => {
  if (req.path === "/next-job") {
    const now = Date.now();
    if (now - lastJobLogAt > 30000) {
      console.log(
        `[JOBQUEUE] ${new Date().toISOString()} ${req.method} ${req.url}`
      );
      lastJobLogAt = now;
    }
    return next();
  }

  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────
// ✅ Step3: it2 auto-decide 엔드포인트 (Worker 후콜 수신)
//   - Worker가 POST로 결과를 보내면 it2가 판단 후 it1_job을 추가로 enqueue
//   - 중복 방지: job_queue.auto_decided_at IS NULL 조건으로 1회만 처리
// ─────────────────────────────────────────
app.post("/it2/auto-decide", async (req, res) => {
  const secret = req.query.secret || req.headers["x-it2-secret"] || "";
  const expected = CONFIG.JOBQUEUE_ENQUEUE_SECRET || "";

  if (!expected || secret !== expected) {
    const trace = req.body?.trace_id;
    const jobId = req.body?.job_id ?? null;

    if (trace) {
      await logEvent({
        trace_id: trace,
        job_id: jobId,
        stage: "it2_unauthorized",
        ok: false,
        message: "UNAUTHORIZED_AUTO_DECIDE",
        payload: { actor: "api", path: req.originalUrl || req.url },
      });
    }

    return res.status(403).json({
      ok: false,
      error: "UNAUTHORIZED_AUTO_DECIDE",
    });
  }

  const {
    trace_id,
    job_id,
    job_type,
    ok,
    latency_ms,
    result,
    error,
  } = req.body || {};

  if (!trace_id || !job_id || !job_type) {
    return res.status(400).json({
      ok: false,
      error: "BAD_REQUEST",
      detail: "trace_id, job_id, job_type required",
    });
  }

  const now = new Date().toISOString();
  const t0 = Date.now();

  // ✅ (1) 입구 로그: 요청 수신
  await logEvent({
    trace_id,
    job_id,
    stage: "it2_received",
    ok: true,
    latency_ms: typeof latency_ms === "number" ? latency_ms : null,
    message: "auto-decide received",
    payload: {
      actor: "it2",
      job_type,
      ok,
      has_result: !!result,
      has_error: !!error,
    },
  });

  try {
    // 1) idempotency lock: 같은 job_id에 대해 auto-decide 1회만
    const { data: locked, error: lockErr } = await supabase
      .from("job_queue")
      .update({ auto_decided_at: now })
      .eq("id", job_id)
      .is("auto_decided_at", null)
      .select("id, auto_decide_count")
      .maybeSingle();

    if (lockErr) {
      console.error("[it2.auto-decide] lockErr:", lockErr);

      await logEvent({
        trace_id,
        job_id,
        stage: "it2_error",
        ok: false,
        latency_ms: Date.now() - t0,
        message: "LOCK_FAILED",
        payload: { actor: "it2", detail: lockErr.message },
      });

      return res
        .status(500)
        .json({ ok: false, error: "LOCK_FAILED", detail: lockErr.message });
    }

    if (!locked) {
      console.log(
        "[LOG]",
        JSON.stringify({
          event: "it2.auto_decide_dedup",
          ok: true,
          trace_id,
          job_id,
        })
      );

      await logEvent({
        trace_id,
        job_id,
        stage: "it2_skip",
        ok: true,
        latency_ms: Date.now() - t0,
        message: "DEDUP",
        payload: { actor: "it2", reason: "auto_decided_at already set" },
      });

      return res.json({ ok: true, decision: "DEDUP", enqueued: 0 });
    }

    // 2) auto_decide_count 증가
    const currentCount = Number(locked.auto_decide_count ?? 0);
    const nextCount = currentCount + 1;

    const { error: cntErr } = await supabase
      .from("job_queue")
      .update({ auto_decide_count: nextCount })
      .eq("id", job_id);

    if (cntErr) {
      console.error("[it2.auto-decide] cntErr:", cntErr);

      await logEvent({
        trace_id,
        job_id,
        stage: "it2_warn",
        ok: true,
        latency_ms: Date.now() - t0,
        message: "AUTO_DECIDE_COUNT_UPDATE_FAILED",
        payload: { actor: "it2", detail: cntErr.message },
      });
    }

    // 3) decision rule (MVP)
    const retryMax = Number(process.env.AUTO_DECIDE_RETRY_MAX ?? 2);

    let decision = "NOOP";
    let enqueued = 0;

    if (ok === false && nextCount <= retryMax) {
      decision = "RETRY";

      const params = {
        namespace: "it1",
        meta: { source: "auto-decide", parent_job_id: job_id },
        cmd: "content.create",
        args: { retry_of: trace_id, attempt: nextCount },
      };

      const { data: insData, error: insErr } = await supabase
        .from("job_queue")
        .insert({
          type: "it1_job",
          status: "PENDING",
          trace_id,
          params,
          locked_at: null,
          locked_by: null,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .maybeSingle();

      if (insErr) {
        console.error("[it2.auto-decide] enqueue retry fail:", insErr);

        await logEvent({
          trace_id,
          job_id,
          stage: "it2_error",
          ok: false,
          latency_ms: Date.now() - t0,
          message: "ENQUEUE_FAIL",
          payload: { actor: "it2", detail: insErr.message },
        });

        return res
          .status(500)
          .json({ ok: false, error: "ENQUEUE_FAIL", detail: insErr.message });
      }

      enqueued = 1;

      await logEvent({
        trace_id,
        job_id,
        stage: "it2_enqueue",
        ok: true,
        latency_ms: Date.now() - t0,
        message: "ENQUEUED_IT1_RETRY",
        payload: { actor: "it2", enqueued_job_id: insData?.id ?? null, attempt: nextCount },
      });
    }

    console.log(
      "[LOG]",
      JSON.stringify({
        event: "it2.auto_decide_done",
        ok: true,
        trace_id,
        job_id,
        job_type,
        decision,
        enqueued,
        latency_ms,
      })
    );

    await logEvent({
      trace_id,
      job_id,
      stage: "it2_decide",
      ok: true,
      latency_ms: Date.now() - t0,
      message: decision,
      payload: {
        actor: "it2",
        decision,
        enqueued,
        auto_decide_count: nextCount,
        retry_max: retryMax,
        it1_ok: ok,
      },
    });

    return res.json({ ok: true, decision, enqueued });
  } catch (e) {
    console.error("[it2.auto-decide] exception:", e);

    await logEvent({
      trace_id,
      job_id,
      stage: "it2_error",
      ok: false,
      latency_ms: Date.now() - t0,
      message: "AUTO_DECIDE_EXCEPTION",
      payload: { actor: "it2", detail: e?.message || String(e) },
    });

    return res.status(500).json({
      ok: false,
      error: "AUTO_DECIDE_EXCEPTION",
      detail: e?.message || String(e),
    });
  }
});

// ─────────────────────────────────────────
// 유틸 함수
// ─────────────────────────────────────────
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();

// ─────────────────────────────────────────
// ✅ it2 전용 텔레그램 sender (별도 봇 토큰)
// ─────────────────────────────────────────
const IT2_BOT_TOKEN =
  process.env.TELEGRAM_IT2_BOT_TOKEN || CONFIG.TELEGRAM_IT2_BOT_TOKEN || "";

const tg2Api = (method) =>
  `https://api.telegram.org/bot${IT2_BOT_TOKEN}/${method}`;

async function tg2Send(chatId, text, extra = {}) {
  if (!IT2_BOT_TOKEN) throw new Error("NO_TELEGRAM_IT2_BOT_TOKEN");
  const resp = await fetch(tg2Api("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.description || "TELEGRAM_IT2_SEND_FAILED");
  return json;
}

// ─────────────────────────────────────────
// ✅ 403 진단 라벨 유틸 (expected/got prefix)
// ─────────────────────────────────────────
const mask4 = (v = "") => (v ? String(v).slice(0, 4) : "");
const buildAuthDiag = ({ kind, expected, got }) => ({
  kind,
  expected_prefix: mask4(expected),
  got_prefix: mask4(got),
  hint:
    kind === "WORKER"
      ? "Use JOBQUEUE_WORKER_SECRET"
      : "Use JOBQUEUE_ENQUEUE_SECRET",
});

const notifyAdminAuthFail = async ({ kind, expected, got, path }) => {
  const adminChatId = process.env.ADMIN_CHAT_ID || CONFIG.ADMIN_CHAT_ID || null;
  if (!adminChatId) return;

  const diag = buildAuthDiag({ kind, expected, got });
  try {
    await tgSend(
      adminChatId,
      `🚨 403 AUTH FAIL\npath: ${path}\nkind: ${diag.kind}\nexpected_prefix: ${diag.expected_prefix}\ngot_prefix: ${diag.got_prefix}\nhint: ${diag.hint}`
    );
  } catch (e) {
    console.error("[AUTH-DIAG] admin notify failed:", e?.message || e);
  }
};

// ─────────────────────────────────────────
// ✅ ItplayLab2 (it2) 명령 파싱 유틸 (Telegram text → job payload)
// ─────────────────────────────────────────
function parseKeyValues(parts) {
  const args = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!k) continue;
    args[k] = v === undefined ? true : v;
  }
  return args;
}

function buildIt2CommandPayload(text, { trace_id, chat_id }) {
  const tokens = text.trim().split(/\s+/);
  const group = tokens[1] || "";
  const action = tokens[2] || "";
  const kv = parseKeyValues(tokens.slice(3));

  let cmd = null;

  if (group === "health") cmd = "health.check";
  else if (group === "snapshot" && action === "run") cmd = "snapshot.run";
  else if (group === "backfill") cmd = "snapshot.backfill";
  else if (group === "score") cmd = "score.v1";

  if (!cmd) {
    return {
      ok: false,
      error: "UNKNOWN_IT2_COMMAND",
      hint:
        "사용 예)\n" +
        "/it2 health\n" +
        "/it2 snapshot run date=YYYY-MM-DD portfolio=demo\n" +
        "/it2 backfill days=30 portfolio=demo\n" +
        "/it2 score v1 date=YYYY-MM-DD portfolio=demo dry_run=true",
    };
  }

  const args = {};

  if (kv.date) args.snapshot_date = String(kv.date);
  if (kv.portfolio) args.portfolio_id = String(kv.portfolio);

  if (kv.engine_version) args.engine_version = String(kv.engine_version);
  else args.engine_version = "v1";

  if (kv.days !== undefined) args.days = Number(kv.days);
  if (kv.concurrency !== undefined) args.concurrency = Number(kv.concurrency);

  if (kv.force !== undefined)
    args.force = String(kv.force) === "true" || kv.force === true;
  else args.force = false;

  if (kv.dry_run !== undefined)
    args.dry_run = String(kv.dry_run) === "true" || kv.dry_run === true;
  else args.dry_run = false;

  if (kv.approved !== undefined)
    args.approved = String(kv.approved) === "true" || kv.approved === true;

  return {
    ok: true,
    jobType: "it2_cmd",
    payload: {
      namespace: "it2",
      cmd,
      requested_by: "telegram",
      trace_id,
      chat_id,
      args,
    },
  };
}

// ─────────────────────────────────────────
// ✅ Supabase job_queue에 직접 enqueue 하는 함수
// ─────────────────────────────────────────
async function enqueueJobToQueue({ type, payload, chat_id, trace_id }) {
  const now = nowISO();

  const { data, error } = await supabase
    .from("job_queue")
    .insert({
      status: "PENDING",
      type,
      params: payload,
      chat_id,
      trace_id,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) {
    console.error("[ENQUEUE] DB_ERROR", error);
    return { ok: false, error: "DB_ERROR", detail: error };
  }
  return { ok: true, job: data };
}

// ─────────────────────────────────────────
// 1) Telegram Webhook 처리 (it1 전용 / it2 전용 분리)
// ─────────────────────────────────────────
const handleTelegramWebhookIt1 = async (req, res) => {
  const body = req.body;

  try {
    const chatId = body?.message?.chat?.id ?? null;
    const text = body?.message?.text ?? "";

    if (!chatId || !text) return res.json({ ok: true });

    const traceId = genTraceId();

    if (shouldNotify("success")) {
      await tgSend(chatId, `✅ 요청 접수\ntrace_id: ${traceId}`);
    }

    const newJob = await createJobFromPlanQueueRow(text, traceId, chatId);

    if (!newJob || !newJob.ok) {
      console.error("[tg-it1] createJobFromPlanQueueRow 반환값 이상:", newJob);
      await tgSend(chatId, "❌ 요청 처리 실패");
      return res.json({ ok: false });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("tg-it1 webhook error:", e);
    return res.json({ ok: false, error: e.message });
  }
};

const handleTelegramWebhookIt2 = async (req, res) => {
  const body = req.body;

  try {
    const chatId = body?.message?.chat?.id ?? null;
    const text = body?.message?.text ?? "";

    console.log("[IT2_WEBHOOK]", {
      hasMessage: !!body?.message,
      chatId,
      text,
      keys: Object.keys(body || {}),
    });

    if (!chatId || !text) return res.json({ ok: true });

    const traceId = genTraceId();

    await tg2Send(chatId, `✅ it2 요청 접수\ntrace_id: ${traceId}`);

    const normalized = text.trim();
    const it2Text = normalized.startsWith("/it2")
      ? normalized
      : `/it2 ${normalized}`;

    const parsed = buildIt2CommandPayload(it2Text, {
      trace_id: traceId,
      chat_id: chatId,
    });

    if (!parsed.ok) {
      await tg2Send(chatId, `❌ it2 명령 오류: ${parsed.error}\n\n${parsed.hint}`);
      return res.json({ ok: false, error: parsed.error });
    }

    const labels = labelsForIt2Command(parsed.payload.cmd, parsed.payload.args);

    parsed.payload.meta = {
      ...(parsed.payload.meta || {}),
      labels,
    };

    const enq = await enqueueJobToQueue({
      type: parsed.jobType,
      payload: parsed.payload,
      chat_id: chatId,
      trace_id: traceId,
    });

    if (!enq.ok) {
      await tg2Send(chatId, `❌ it2 요청 enqueue 실패\ntrace_id: ${traceId}`);
      return res.json({ ok: false, error: "ENQUEUE_FAILED" });
    }

    await tg2Send(
      chatId,
      `🧠 it2 작업 접수 완료\ncmd: ${parsed.payload.cmd}\ntrace_id: ${traceId}`
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("tg-it2 webhook error:", e);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await tg2Send(chatId, `❌ it2 처리 오류\n${e.message}`);
    } catch {}
    return res.json({ ok: false, error: e.message });
  }
};

// ✅ 엔드포인트 분리
app.post("/tg-webhook-it1", handleTelegramWebhookIt1);
app.post("/telegram/webhook-it1", handleTelegramWebhookIt1);

app.post("/tg-webhook-it2", handleTelegramWebhookIt2);
app.post("/telegram/webhook-it2", handleTelegramWebhookIt2);

// ✅ 하위호환: 기존 엔드포인트는 it1로 연결
app.post("/tg-webhook", handleTelegramWebhookIt1);
app.post("/telegram/webhook", handleTelegramWebhookIt1);

// ─────────────────────────────────────────
// 2) GAS / 외부에서 job 넣는 엔드포인트 (/enqueue-job)
// ─────────────────────────────────────────
app.post("/enqueue-job", async (req, res) => {
  const secret = req.query.secret || "";
  const expected = CONFIG.JOBQUEUE_ENQUEUE_SECRET || "";

  if (!expected || secret !== expected) {
    const diag = buildAuthDiag({
      kind: "ENQUEUER",
      expected,
      got: secret,
    });

    console.error("[ENQUEUE-JOB] ❌ UNAUTHORIZED_ENQUEUER", diag);

    await notifyAdminAuthFail({
      kind: "ENQUEUER",
      expected,
      got: secret,
      path: req.originalUrl || req.url,
    });

    return res.status(403).json({
      ok: false,
      error: "UNAUTHORIZED_ENQUEUER",
      ...diag,
    });
  }

  try {
    const { type = "test", payload = {}, chat_id = null, trace_id } =
      req.body || {};

    const now = nowISO();
    const finalTraceId = trace_id || genTraceId();

    const { data, error } = await supabase
      .from("job_queue")
      .insert({
        status: "PENDING",
        type,
        params: payload,
        chat_id,
        trace_id: finalTraceId,
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (error) {
      console.error("[ENQUEUE-JOB] DB_ERROR", error);
      return res.status(500).json({ ok: false, error: "DB_ERROR" });
    }

    // ✅ event_log: job.enqueued (입고 기록)
    await logEvent({
      trace_id: data.trace_id,
      job_id: data.id,
      stage: "job.enqueued",
      ok: true,
      message: "ENQUEUED",
      payload: {
        actor: "api",
        type: data.type,
        status: data.status,
        chat_id: data.chat_id ?? null,
      },
    });

    return res.json({ ok: true, job: data });
  } catch (e) {
    console.error("[ENQUEUE-JOB] INTERNAL_ERROR", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "INTERNAL_ERROR" });
  }
});

// ─────────────────────────────────────────
// 3) Worker 전용 엔드포인트 (/next-job)
// ─────────────────────────────────────────
app.post("/next-job", async (req, res) => {
  const secret = req.query.secret || "";
  const expected = CONFIG.JOBQUEUE_WORKER_SECRET || "";

  if (!expected || secret !== expected) {
    const diag = buildAuthDiag({
      kind: "WORKER",
      expected,
      got: secret,
    });

    console.error("[NEXT-JOB] ❌ UNAUTHORIZED_WORKER", diag);

    await notifyAdminAuthFail({
      kind: "WORKER",
      expected,
      got: secret,
      path: req.originalUrl || req.url,
    });

    return res.status(403).json({
      ok: false,
      error: "UNAUTHORIZED_WORKER",
      ...diag,
    });
  }

  try {
    const t0 = Date.now();
    const result = await runWorkerOnce();
    const latency = Date.now() - t0;

    if (!result || !result.has_job || !result.job) {
      return res.json({ ok: true, has_job: false });
    }

    const job = result.job;

    // ⚠️ Step 6: job.claimed는 여기서 기록하지 않음
    // (runWorkerOnce 내부로 이동)

    return res.json({
      ok: true,
      has_job: true,
      job,
    });
  } catch (e) {
    console.error("[NEXT-JOB] 🧨 error:", e);

    // (선택) API 레벨 에러 로그 (운영 stage 아님)
    await logEvent({
      trace_id: "no-trace",
      job_id: null,
      stage: "system.next_job_error",
      ok: false,
      message: e?.message || "INTERNAL_ERROR",
      payload: { actor: "api" },
    });

    return res
      .status(500)
      .json({ ok: false, error: e?.message || "INTERNAL_ERROR" });
  }
});

// ─────────────────────────────────────────
// 4) 비디오 생성 완료 Webhook (VideoFactory)
// ─────────────────────────────────────────
app.post("/video/result", async (req, res) => {
  const body = req.body;

  try {
    const traceId = body.trace_id;
    const url = body.url;
    const thumbnail = body.thumbnail;
    const error = body.error;

    if (!traceId) return res.json({ ok: false, error: "NO_TRACE_ID" });

    const job = await findByTraceId(traceId);
    if (!job) return res.json({ ok: false, error: "TRACE_NOT_FOUND" });

    if (error) {
      await updateVideoStatus(traceId, { step: "error", error });
      await tgSend(job.chat_id, `❌ 오류 발생\ntrace_id: ${traceId}\n${error}`);
      return res.json({ ok: true });
    }

    await updateVideoStatus(traceId, {
      step: "done",
      output_url: url,
      thumbnail,
    });

    await tgSend(job.chat_id, `🎉 생성 완료!\ntrace_id: ${traceId}\n${url}`);

    res.json({ ok: true });
  } catch (e) {
    console.error("video/result error:", e);
    res.json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 ItplayLab server running on port ${PORT}`);
});
