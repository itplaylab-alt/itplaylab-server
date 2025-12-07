// lib/config.js
import dotenv from "dotenv";
dotenv.config();

/**
 * 공용 환경설정 모듈
 * - index.js / services/* 어디에서든 import 해서 사용
 */

export const CONFIG = {
  PROJECT: process.env.PROJECT || "itplaylab",
  APPROVAL_MODE: process.env.APPROVAL_MODE === "true",
  OPENAI_MODEL_RESP: process.env.OPENAI_MODEL_RESP || "gpt-4o-mini",
  OPENAI_MODEL_FALLBACK: process.env.OPENAI_MODEL_FALLBACK || "gpt-4o-mini",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
  GAS_INGEST_URL: process.env.GAS_INGEST_URL,
  INGEST_TOKEN: process.env.INGEST_TOKEN,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE,
  JOBQUEUE_WORKER_SECRET: process.env.JOBQUEUE_WORKER_SECRET,
};

export function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Missing required env: ${name}`);
    throw new Error(`Missing required env: ${name}`);
  }
  return process.env[name];
}
