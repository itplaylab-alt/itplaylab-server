import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 10000;

// 환경 변수
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 기본 설정
app.use(bodyParser.json());

// ✅ Gemini API 초기화
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ✅ 텔레그램 Webhook 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const userMessage = message.text;

    // Gemini 응답 생성
    const result = await model.generateContent(userMessage);
    const replyText = result.response.text();

    // 텔레그램으로 응답 전송
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: replyText,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

// ✅ Gemini 연결 테스트용 엔드포인트
app.get("/test-gemini", async (req, res) => {
  try {
    const testResult = await model.generateContent("Hello from Gemini test");
    res.send(testResult.response.text());
  } catch (error) {
    res.status(500).send("Gemini 연결 오류: " + error.message);
  }
});

// ✅ 서버 시작
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
