import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔹 환경변수 불러오기
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL; // ✅ Google Sheet용 URL 추가
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ✅ Google Sheets로 로그 전송 함수
async function logToGoogleSheet(data) {
  try {
    await axios.post(SHEETS_WEBHOOK_URL, data);
    console.log("✅ Google Sheets로 로그 전송 성공");
  } catch (error) {
    console.error("❌ Google Sheets 전송 실패:", error.message);
  }
}

// 🔹 텔레그램 메시지 처리
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text.trim();

    // 🔸 Google Sheet로 대화 내용 전송
    await logToGoogleSheet({
      chat_id: chatId,
      username: message.from.username,
      type: "text",
      input_text: userText,
      output_text: "응답 준비중",
      meta: {},
      source: "telegram",
    });

    // 🔹 /start 명령어 처리
    if (userText === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "안녕하세요! 👋 ItplayLab ChatGPT 봇입니다. 자유롭게 질문해보세요!",
      });
      return res.sendStatus(200);
    }

    // 🔹 일반 메시지 처리
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `당신이 보낸 메시지: ${userText}`,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.sendStatus(500);
  }
});

// 🔹 서버 실행
app.listen(10000, () => {
  console.log("✅ Server is running on port 10000");
});
