// index.js
// ItplayLab 텔레그램 AI 챗봇 서버
// - /start, /help, /info 명령어 지원
// - 일반 문장은 OpenAI 모델로 답변
// - Webhook 엔드포인트: POST /webhook

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 🔐 환경변수
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // 필수
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // 필수 (ChatGPT 연결)
const PORT = process.env.PORT || 10000;

// 안전장치
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN이 설정되지 않았습니다.");
}
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY가 설정되지 않았습니다.");
}

// API 엔드포인트들
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

// 텔레그램 메시지 전송
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...options,
    });
  } catch (err) {
    console.error("❌ sendTelegramMessage error:", err?.response?.data || err?.message);
  }
}

// 타이핑 액션 (사용자 경험 업)
async function sendTypingAction(chatId) {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, {
      chat_id: chatId,
      action: "typing",
    });
  } catch (err) {
    // 굳이 throw 필요 없음
  }
}

// OpenAI 호출 (간단 1-turn 답변)
async function generateAIReply(userText, username = "") {
  try {
    const systemPrompt = `
당신은 친절하고 실용적인 한국어 어시스턴트입니다.
- 불필요한 사족은 줄이고, 단계/목록은 깔끔히.
- 코드나 명령은 복사하기 좋게 포맷팅.
- 모르면 모른다고 말하고, 대안 제시.
- 톤은 따뜻하고 명료하게.`;

    const res = await axios.post(
      OPENAI_CHAT_URL,
      {
        model: "gpt-4o-mini", // 가벼운 대화형 모델
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt.trim() },
          {
            role: "user",
            content: `${username ? `사용자(@${username})의 메시지: ` : ""}${userText}`,
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 30000,
      }
    );

    const text = res.data?.choices?.[0]?.message?.content?.trim();
    return text || "음… 지금은 좋은 답을 찾지 못했어요. 조금 뒤 다시 시도해 주세요!";
  } catch (err) {
    console.error("❌ OpenAI error:", err?.response?.data || err?.message);
    return "AI 응답 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.";
  }
}

// 🧪 헬스체크
app.get("/", (_req, res) => {
  res.status(200).send("✅ ItplayLab Telegram Bot Server is running 🚀");
});

// ✅ Webhook 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // 메시지가 아닌 업데이트는 통과
    const message = update?.message || update?.edited_message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text || "";
    const username = message.from?.username || "";

    if (!userText) {
      await sendTelegramMessage(chatId, "텍스트 메시지만 이해할 수 있어요 🙂");
      return res.sendStatus(200);
    }

    // 명령어 처리
    const text = userText.trim();
    if (text.startsWith("/start")) {
      await sendTelegramMessage(
        chatId,
        [
          "안녕하세요 👋 ItplayLab 봇이 성공적으로 연결되었습니다!",
          "",
          "*사용 방법*",
          "• 일반 문장을 보내면 AI가 대답해요.",
          "• /help → 명령어 안내",
          "• /info → 프로젝트 소개",
        ].join("\n")
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/help")) {
      await sendTelegramMessage(
        chatId,
        [
          "*명령어 안내*",
          "• /start - 시작 인사",
          "• /help  - 도움말",
          "• /info  - ItplayLab 봇 소개",
          "",
          "일반 문장은 AI가 자연스럽게 답변합니다 🙂",
        ].join("\n")
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/info")) {
      await sendTelegramMessage(
        chatId,
        [
          "*ItplayLab 텔레그램 AI 봇*",
          "• Render + Node.js + Telegram Webhook",
          "• OpenAI 모델로 자연어 대화 지원",
          "",
          "💡 다음 단계: 키워드 자동응답 / RSS·Notion 연동 / 이미지 생성 등 확장 가능!",
        ].join("\n")
      );
      return res.sendStatus(200);
    }

    // 일반 대화 → AI로 응답
    await sendTypingAction(chatId);
    const answer = await generateAIReply(text, username);
    await sendTelegramMessage(chatId, answer);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ /webhook handler error:", err);
    return res.sendStatus(200);
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
