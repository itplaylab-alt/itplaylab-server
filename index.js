// index.js — ItplayLab 최종 정리본 (모듈 분리 버전)
// Node 18+ / ESM

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import crypto from "crypto";
import { runWorkerOnce } from "./src/worker.js";

// ─────────────────────────────────────────
//  공통 설정
// ─────────────────────────────────────────
import { CONFIG } from "./lib/config.js";

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
// 2) Worker 전용 엔드포인트 (/next-job)
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
// 3) 비디오 생성 완료 Webhook (VideoFactory)
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
