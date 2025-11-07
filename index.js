// index.js
// ItplayLab 텔레그램 챗봇 (Gemini 연결)
// - /start, /help, /info 명령어 지원
// - 일반 대화: Google Gemini 1.5 Flash로 답변
// - Webhook 엔드포인트: POST /webhook

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(bodyParser.json());

// 🔐 환경 변수
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 10000;

// ✅ 안전장치: 필수 키 확인
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN 이(가) 설정되지 않았습니다.");
}
if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY 이(가) 설정되지 않았습니다.");
}

// ✅ Gemini 클라이언트
let genAI = null;
let geminiModel = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

// ✅ 텔레그램 전송 유틸
const tg = axios.create({
  baseURL: `https://api.telegram.org/bot${TELEGRAM_TOKEN}`,
  timeout: 15000,
});

async function sendMessage(chatId, text, opts = {}) {
  try {
    await tg.post("/sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...opts,
    });
  } catch (err) {
    console.error("sendMessage error:", err?.response?.data || err.message);
  }
}

// ✅ Gemini 호출 유틸
async function askGemini(prompt) {
  if (!geminiModel) {
    return "Gemini API 키가 설정되지 않아 응답할 수 없어요. 관리자에게 문의해 주세요.";
  }
  try {
    const result = await geminiModel.generateContent(prompt);
    return result?.response?.text() || "응답이 비어 있어요. 다시 시도해 주세요.";
  } catch (err) {
    console.error("Gemini error:", err?.response?.data || err.message);
    return "Gemini 응답 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.";
  }
}

// ✅ 서버 헬스체크/확인
app.get("/", (_, res) => {
  res.send("✅ ItplayLab Telegram Bot Server is running 🚀");
});
app.get("/health", (_, res) => {
  res.json({ ok: true, service: "itplaylab-telegram-bot", provider: "Gemini" });
});

// ✅ Webhook 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // 텔레그램 메시지 추출
    const message = update?.message || update?.edited_message;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim();

    // 메시지가 없으면 200 OK만 반환
    if (!chatId || !text) {
      return res.sendStatus(200);
    }

    // 명령어 처리
    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        "안녕하세요! 👋 ItplayLab 봇입니다.\n원하시는 내용을 편하게 말씀해 주세요. 제가 Gemini로 답해 드릴게요."
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/help")) {
      await sendMessage(
        chatId,
        "*도움말*\n" +
          "- 일반 메시지를 보내면 Gemini가 대화로 응답합니다.\n" +
          "- /info : 현재 연결 정보를 보여줍니다.\n" +
          "- /help : 이 도움말을 다시 보여줍니다."
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/info")) {
      await sendMessage(
        chatId,
        `*ItplayLab Bot 정보*\n- 모델: Gemini 1.5 Flash\n- 모드: 대화형(Text)\n- 서버: Render\n- 상태: 온라인 ✅`
      );
      return res.sendStatus(200);
    }

    // 일반 대화 → Gemini
    const prompt = `사용자 메시지: """${text}"""\n친절하고 간결한 한국어로 답해주세요.`;
    const reply = await askGemini(prompt);

    await sendMessage(chatId, reply);
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err.message);
    return res.sendStatus(200); // 텔레그램에는 항상 200 OK
  }
});

// ✅ 서버 시작
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
