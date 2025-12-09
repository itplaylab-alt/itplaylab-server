// index.js — ItplayLab 최종 정리본 (모듈 분리 버전)
// Node 18+ / ESM

import dotenv from "dotenv";
dotenv.config();
import "dotenv/config";

import express from "express";
import axios from "axios";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { runWorkerOnce } from "./src/worker.js";

// ─────────────────────────────────────────
//  공통 설정
// ─────────────────────────────────────────
import { CONFIG } from "./lib/config.js";
console.log("[DEBUG] ENQUEUE_SECRET =", process.env.JOBQUEUE_ENQUEUE_SECRET);

// 서비스 계층
import { logToSheet } from "./services/gasLogger.js";
import {
  tgSend,
  tgAnswerCallback,
  buildNotifyMessage,
  shouldNotify,
} from "./services/telegramBot.js";

// 리포지토리 계층 (Supabase)
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
// 이미 다른 곳에서 createClient 쓰고 있더라도, 여기서 한 번 더 만들어도 무방함.
// 필요하면 CONFIG.SUPABASE_URL / CONFIG.SUPABASE_SERVICE_ROLE_KEY 로 바꿔써도 됨.
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
// 1) Telegram Webhook 처리
// ─────────────────────────────────────────
const handleTelegramWebhook = async (req, res) => {
  const body = req.body;

  try {
    const chatId = body?.message?.chat?.id ?? null;
    const text = body?.message?.text ?? "";

    if (!chatId || !text) {
      return res.json({ ok: true });
    }

    const traceId = genTraceId();

    if (shouldNotify("success"))
      await tgSend(chatId, `✅ 요청 접수\ntrace_id: ${traceId}`);

    const newJob = await createJobFromPlanQueueRow(text, traceId, chatId);

    // ✅ newJob 자체가 null/undefined 인 상황 방어
    if (!newJob || !newJob.ok) {
      console.error(
        "[tg-webhook] createJobFromPlanQueueRow 반환값 이상:",
        newJob
      );
      await tgSend(chatId, "❌ 요청 처리 실패");
      return res.json({ ok: false });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("tg-webhook error:", e);
    return res.json({ ok: false, error: e.message });
  }
};

// 둘 다 같은 핸들러 사용
app.post("/tg-webhook", handleTelegramWebhook);
app.post("/telegram/webhook", handleTelegramWebhook);

// ─────────────────────────────────────────
// 2) GAS / 외부에서 job 넣는 엔드포인트 (/enqueue-job)
// ─────────────────────────────────────────
app.post("/enqueue-job", async (req, res) => {
  const secret = req.query.secret || "";
  const expected = CONFIG.JOBQUEUE_ENQUEUE_SECRET || "";

  if (!expected || secret !== expected) {
    console.error("[ENQUEUE-JOB] ❌ UNAUTHORIZED_ENQUEUER", {
      expected: expected && expected.slice(0, 4),
      got: secret && secret.slice(0, 4),
    });
    return res
      .status(403)
      .json({ ok: false, error: "UNAUTHORIZED_ENQUEUER" });
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
    console.error("[NEXT-JOB] ❌ UNAUTHORIZED_WORKER", {
      expected: expected && expected.slice(0, 4),
      got: secret && secret.slice(0, 4),
    });
    return res
      .status(403)
      .json({ ok: false, error: "UNAUTHORIZED_WORKER" });
  }

  try {
    // 2. Worker 한 번 실행
    const result = await runWorkerOnce();

    if (!result) {
      return res.json({ ok: false, message: "No job or error" });
    }

    // 3. 성공 응답
    return res.json({ ok: true, result });
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

    await tgSend(
      job.chat_id,
      `🎉 생성 완료!\ntrace_id: ${traceId}\n${url}`
    );

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
