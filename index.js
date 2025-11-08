import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ── Env (앞뒤 공백 제거)
const TELEGRAM_TOKEN     = (process.env.TELEGRAM_TOKEN     || "").trim();
const OPENAI_API_KEY     = (process.env.OPENAI_API_KEY     || "").trim(); // 지금은 미사용(향후 AI 응답용)
const SHEETS_WEBHOOK_URL = (process.env.SHEETS_WEBHOOK_URL || "").trim();
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const PORT = process.env.PORT || 10000;

// ── Google Sheets 로그 전송
async function logToGoogleSheet(data) {
  if (!SHEETS_WEBHOOK_URL) return; // URL 없으면 스킵
  try {
    await axios.post(SHEETS_WEBHOOK_URL, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 8000,
    });
    console.log("✅ Google Sheets로 로그 전송 성공");
  } catch (error) {
    console.error("❌ Google Sheets 전송 실패:", error?.message || error);
  }
}

// ── Telegram 메시지 전송
async function sendTelegram(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
    }, { timeout: 8000 });
  } catch (error) {
    console.error("❌ Telegram 전송 실패:", error?.message || error);
  }
}

// ── 웹훅 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const message = req?.body?.message;
    if (!message || typeof message.text !== "string") return res.sendStatus(200);

    const chatId   = message.chat.id;
    const username = message.from?.username || message.from?.first_name || "";
    const userText = message.text.trim();

    // 먼저 로그(placeholder)
    await logToGoogleSheet({
      timestamp: new Date().toISOString(),
      chat_id: String(chatId),
      username,
      type: "text",
      input_text: userText,
      output_text: "응답 준비중",
      meta_json: JSON.stringify({}),  // ← 시트 헤더와 일치
      source: "telegram",
      note: "",
    });

    if (userText === "/start") {
      const msg = "안녕하세요! 👋 ItplayLab ChatGPT 봇입니다. 자유롭게 질문해보세요!";
      await sendTelegram(chatId, msg);

      // 실제 응답 로그로 한번 더 기록(선택)
      await logToGoogleSheet({
        timestamp: new Date().toISOString(),
        chat_id: String(chatId),
        username,
        type: "system",
        input_text: userText,
        output_text: msg,
        meta_json: JSON.stringify({ event: "start" }),
        source: "telegram",
        note: "",
      });

      return res.sendStatus(200);
    }

    // 일반 메시지(에코)
    const reply = `당신이 보낸 메시지: ${userText}`;
    await sendTelegram(chatId, reply);

    // placeholder 업데이트용으로 한 줄 더 남기고 싶다면 위 placeholder 대신 여기 한 번만 기록해도 됨
    await logToGoogleSheet({
      timestamp: new Date().toISOString(),
      chat_id: String(chatId),
      username,
      type: "text",
      input_text: userText,
      output_text: reply,
      meta_json: JSON.stringify({}),
      source: "telegram",
      note: "",
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ /webhook 처리 오류:", error?.message || error);
    return res.sendStatus(200); // 텔레그램엔 200 주는 게 재시도 방지됨
  }
});

// ── 헬스체크
app.get("/", (_req, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
