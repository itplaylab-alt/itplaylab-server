// services/telegramBot.js
import axios from "axios";
import { CONFIG } from "../lib/config.js";

const {
  TELEGRAM_TOKEN,
  TELEGRAM_IT2_BOT_TOKEN, // ✅ it2 전용 봇 토큰
  TELEGRAM_ADMIN_CHAT_ID,
  NOTIFY_LEVEL = "success,error,approval,info",
} = CONFIG;

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

const TELEGRAM_API_IT2 = TELEGRAM_IT2_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_IT2_BOT_TOKEN}`
  : null;

const fmtTsKR = (d = new Date()) =>
  d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

export const shouldNotify = (kind) =>
  String(NOTIFY_LEVEL)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(String(kind).trim().toLowerCase());

export function buildNotifyMessage({ type, title, message }) {
  const ts = fmtTsKR();
  if (type === "success")
    return `✅ <b>${title || "처리 완료"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "error")
    return `❌ <b>${title || "오류 발생"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  if (type === "approval")
    return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n🕒 ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n🕒 ${ts}`;
}

async function sendVia(apiBase, chatId, text, parse_mode = "HTML", extra = {}) {
  if (!apiBase || !chatId) return;
  try {
    return await axios.post(`${apiBase}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode,
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    console.error("Telegram send error:", e?.message || String(e));
  }
}

// ✅ it1 봇 전송
export async function tgSend(chatId, text, parse_mode = "HTML", extra = {}) {
  return sendVia(TELEGRAM_API, chatId, text, parse_mode, extra);
}

// ✅ it2 봇 전송
export async function tg2Send(chatId, text, parse_mode = "HTML", extra = {}) {
  return sendVia(TELEGRAM_API_IT2, chatId, text, parse_mode, extra);
}

export async function tgAnswerCallback(id, text = "", show_alert = false) {
  if (!TELEGRAM_API) return;
  try {
    return await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: id,
      text,
      show_alert,
    });
  } catch (e) {
    console.error("Telegram answerCallbackQuery error:", e?.message || String(e));
  }
}

/** 옵션: 관리자 채널로 바로 보내기 (it1 기준) */
export async function sendAdmin(text) {
  if (!TELEGRAM_ADMIN_CHAT_ID) return;
  return tgSend(TELEGRAM_ADMIN_CHAT_ID, text);
}
