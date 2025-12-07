// services/telegramBot.js
import { CONFIG } from "../lib/config.js";

/**
 * Telegram Bot API wrapper
 * - tgSend(chatId, text, parseMode)
 * - tgAnswerCallback(callbackQueryId, text, alert)
 */

const BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = CONFIG.TELEGRAM_ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN 환경변수 없음 — Telegram 기능 비활성화");
}

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 공용 fetch 함수
async function callTelegram(method, body = {}) {
  if (!BOT_TOKEN) return { ok: false, disabled: true };

  try {
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("❌ Telegram API Error:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * 메시지 전송
 */
export async function tgSend(chatId, text, parseMode = "HTML") {
  return await callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

/**
 * Callback 응답
 */
export async function tgAnswerCallback(callbackQueryId, text, alert = false) {
  return await callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: alert,
  });
}

/**
 * Admin에게 알림 보내기 (선택적)
 */
export async function sendAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  return await tgSend(ADMIN_CHAT_ID, text);
}
