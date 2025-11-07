import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 🔑 Render의 환경 변수 TELEGRAM_TOKEN 사용
const TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// ✅ 서버 확인용
app.get("/", (req, res) => {
  res.send("ItplayLab Telegram Bot Server is running 🚀");
});

// ✅ Telegram Webhook 엔드포인트
app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (message && message.text) {
    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "안녕하세요 👋 ItplayLab 봇이 성공적으로 연결되었습니다!",
      });
    } else {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `입력하신 메시지: ${text}`,
      });
    }
  }

  return res.sendStatus(200);
});

// ✅ Render 기본 포트 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
