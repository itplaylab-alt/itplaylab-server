import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 헬스체크
app.get("/", (_, res) => {
  res.send("ItplayLab Telegram Bot (Gemini) is running 🚀");
});

// Gemini 호출 함수
async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const res = await axios.post(url, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "(응답 없음)";
}

// 텔레그램 웹훅
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();

    if (!chatId || !text) return res.sendStatus(200);

    // 간단한 명령 처리
    if (text === "/start") {
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "안녕하세요! 🤖 ItplayLab Gemini 봇입니다. 무엇이든 물어보세요.",
      });
      return res.sendStatus(200);
    }

    const answer = await askGemini(text);

    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: answer,
    });

    res.sendStatus(200);
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
