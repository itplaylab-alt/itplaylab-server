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
// Supabase 클라이언트 (job_queue용)
// ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────
// 서버 준비
// ─────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb", type: ["application/json"] }));

// /next-job 로그 최소화 옵션
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
// 유틸 함수
// ─────────────────────────────────────────
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();

// ─────────────────────────────────────────
// ✅ it2 전용 텔레그램 sender (별도 봇 토큰)
//   - Render env: TELEGRAM_IT2_BOT_TOKEN 설정 필요
// ─────────────────────────────────────────
const IT2_BOT_TOKEN =
  process.env.TELEGRAM_IT2_BOT_TOKEN || CONFIG.TELEGRAM_IT2_BOT_TOKEN || "";

const tg2Api = (method) => `https://api.telegram.org/bot${IT2_BOT_TOKEN}/${method}`;

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
  kind, // "WORKER" | "ENQUEUER"
  // ⚠️ 운영상 prefix 노출이 민감하면 길이를 2로 줄이거나 알림을 끄면 됨
  expected_prefix: mask4(expected),
  got_prefix: mask4(got),
  hint:
    kind === "WORKER"
      ? "Use JOBQUEUE_WORKER_SECRET"
      : "Use JOBQUEUE_ENQUEUE_SECRET",
});

const notifyAdminAuthFail = async ({ kind, expected, got, path }) => {
  // 옵션: Render env에 ADMIN_CHAT_ID 넣어두면 관리자에게 403 라벨 알림
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

/**
 * 예시:
 *  /it2 health
 *  /it2 snapshot run date=2025-12-12 portfolio=demo force=true
 *  /it2 backfill days=30 portfolio=demo
 *  /it2 score v1 date=2025-12-12 portfolio=demo dry_run=true
 */
function buildIt2CommandPayload(text, { trace_id, chat_id }) {
  const tokens = text.trim().split(/\s+/);
  const group = tokens[1] || ""; // health | snapshot | backfill | score
  const action = tokens[2] || ""; // run | check | v1 ...
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

  // args 정규화
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

  // (선택) 승인 플래그도 받을 수 있게 열어둠 (락/중복방지 이후 승인게이트에서 사용)
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

    // it1: 기존 콘텐츠 파서만
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

    if (!chatId || !text) return res.json({ ok: true });

    const traceId = genTraceId();

    // it2 접수 알림은 it2 봇으로
    await tg2Send(chatId, `✅ it2 요청 접수\ntrace_id: ${traceId}`);

    // it2 봇에서는 "/it2" 없이 보내도 되게끔 자동 prefix
    const normalized = text.trim();
    const it2Text = normalized.startsWith("/it2") ? normalized : `/it2 ${normalized}`;

    const parsed = buildIt2CommandPayload(it2Text, {
      trace_id: traceId,
      chat_id: chatId,
    });

    if (!parsed.ok) {
      await tg2Send(chatId, `❌ it2 명령 오류: ${parsed.error}\n\n${parsed.hint}`);
      return res.json({ ok: false, error: parsed.error });
    }

    // ─────────────────────────────────────────
    // ✅ 라벨 자동 주입 (문서 규격 → 실행 규격)
    //   - job_queue.params.meta.labels 로 저장됨
    // ─────────────────────────────────────────
    const labels = labelsForIt2Command(parsed.payload.cmd, parsed.payload.args);

    parsed.payload.meta = {
      ...(parsed.payload.meta || {}),
      labels,
    };

    const enq = await enqueueJobToQueue({
      type: parsed.jobType,      // "it2_cmd"
      payload: parsed.payload,   // {namespace, cmd, args, meta.labels...}
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

    // (옵션) 관리자 텔레그램 알림
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
  // 1. 시크릿 검사
  const secret = req.query.secret || "";
  const expected = CONFIG.JOBQUEUE_WORKER_SECRET || "";

  if (!expected || secret !== expected) {
    const diag = buildAuthDiag({
      kind: "WORKER",
      expected,
      got: secret,
    });

    console.error("[NEXT-JOB] ❌ UNAUTHORIZED_WORKER", diag);

    // (옵션) 관리자 텔레그램 알림
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
    // 2. Worker 한 번 실행 → 다음 Job 가져오기
    const result = await runWorkerOnce();

    // Job 이 없을 때: ok:true, has_job:false
    if (!result || !result.has_job || !result.job) {
      return res.json({ ok: true, has_job: false });
    }

    // 3. Job 이 있을 때: ok:true, has_job:true, job:{...}
    return res.json({
      ok: true,
      has_job: true,
      job: result.job,
    });
  } catch (e) {
    console.error("[NEXT-JOB] 🧨 error:", e);
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
