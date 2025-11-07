import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ✅ 환경변수 불러오기
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ✅ 텔레그램 메세지 처리 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text.trim();

    // /start 명령어 처리
    if (userText === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "안녕하세요! 👋 ItplayLab ChatGPT 봇입니다. 자유롭게 질문해보세요!",
      });
      return res.sendStatus(200);
    }

    // ✅ OpenAI ChatGPT API 호출
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-5",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: userText },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = response.data.choices[0].message.content;

    // ✅ 텔레그램에 응답 전송
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: reply,
    });

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Error:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ✅ 서버 시작
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
