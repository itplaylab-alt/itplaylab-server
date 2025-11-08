import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text;

    // 1️⃣ Telegram 응답 보내기
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `당신이 보낸 메시지: ${text}`,
    });

    // 2️⃣ Google Sheet에 로그 전송
    await axios.post(SHEETS_WEBHOOK_URL, {
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        chat_id: chatId,
        username: message.from.username || "",
        type: "text",
        input_text: text,
        output_text: `당신이 보낸 메시지: ${text}`,
        meta: {},
        source: "telegram",
        note: "",
      }),
    });

    console.log("✅ Google Sheet로 전송 성공:", text);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
