// lib/config.js
import dotenv from "dotenv";
dotenv.config();

/**
 * 공용 환경설정 모듈
 * - index.js / services/* 어디에서든 import 해서 사용
 */

export const CONFIG = {
  PROJECT: process.env.PROJECT || "itplaylab",
  SERVICE_NAME: process.env.SERVICE_NAME || "render-bot",

  // 승인/모델
  APPROVAL_MODE:
    String(process.env.APPROVAL_MODE || "true").toLowerCase() === "true",
  OPENAI_MODEL_RESP: process.env.OPENAI_MODEL_RESP || "gpt-4.1-mini",
  OPENAI_MODEL_FALLBACK: process.env.OPENAI_MODEL_FALLBACK || "gpt-4o-mini",

  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
  NOTIFY_LEVEL: process.env.NOTIFY_LEVEL || "success,error,approval",

  // GAS
  GAS_INGEST_URL: process.env.GAS_INGEST_URL,
  INGEST_TOKEN: process.env.INGEST_TOKEN,

  // Supabase / JobQueue
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  JOBQUEUE_WORKER_SECRET: process.env.JOBQUEUE_WORKER_SECRET,
};
