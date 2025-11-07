// ItplayLab Telegram ↔ Jaemini Talk 전용 서버
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 🔐 환경변수
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;      // 필수
const JAEMINI_API_URL = process.env.JAEMINI_API_URL;     // 필수 (예: https://api.jaeminai.com/v1/talk)
const JAEMINI_API_KEY = process.env.JAEMINI_API_KEY;     // 필수
const PORT = process.env.PORT || 10000;

// ✅ 안전장치: 환경변수 체크
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN 이(가) 설정되지 않았습니다.");
}
if (!JAEMINI_API_URL) {
  console.error("❌ JAEMINI_API_URL 이(가) 설정되지 않았습니다.");
}
if (!JAEMINI_API_KEY) {
  console.error("❌ JAEMINI_API_KEY 이(가) 설정되지 않았습니다.");
}

// 헬스체크
app.get("/", (_req, res) => {
  res.send(`ItplayLab (Jaemini Talk) server is running on port ${PORT}`);
});

// 텔레그램 Webhook 엔드포인트
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const message = update?.message || update?.edited_message;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim();

    // 텔레그램에서 chatId가 없으면 바로 OK
    if (!chatId) return res.sendStatus(200);

    // /start 처리
    if (!text || /^\/start/i.test(text)) {
      await sendTelegram(chatId, "안녕하세요 👋 재미나이 토크봇이 연결되었습니다!\n그냥 메시지를 보내면 답해 드릴게요.");
      return res.sendStatus(200);
    }

    // 재미나이 호출
    const answer = await askJaemini(text, chatId);

    // 결과 전달
    await sendTelegram(chatId, answer || "음… 지금은 답을 만들기 어려워요. 잠시 후 다시 시도해주세요!");
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ /webhook 처리 중 오류:", err?.response?.data || err.message);
    return res.sendStatus(200); // 텔레그램에는 200을 돌려야 재시도 폭탄을 막을 수 있어요
  }
});

/**
 * 재미나이 API 호출
 * 다양한 필드명을 시도해서(서비스별 스펙 차이 대비) 최대한 견고하게.
 */
async function askJaemini(userText, chatId) {
  const headers = {
    "Authorization": `Bearer ${JAEMINI_API_KEY}`,
    "Content-Type": "application/json",
  };

  // 자주 쓰이는 페이로드 모음 (서비스 스펙 차이 대비)
  const candidates = [
    { prompt: userText, user_id: String(chatId) },
    { query: userText, userId: String(chatId) },
    { text: userText },
  ];

  for (const payload of candidates) {
    try {
      const { data } = await axios.post(JAEMINI_API_URL, payload, { headers });

      // 결과 필드 후보들 (answer, result, output.text …)
      const answer =
        data?.answer ??
        data?.result ??
        data?.output?.text ??
        data?.message ??
        data?.reply;

      if (answer && typeof answer === "string") {
        return answer;
      }

      // 배열/객체로 올 때도 대비
      if (Array.isArray(data?.output) && data.output.length) {
        const merged = data.output
          .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
          .join("\n");
        if (merged) return merged;
      }
      if (typeof data === "object") {
        // 마지막 방어: 적당히 문자열화
        const compact = JSON.stringify(data);
        if (compact && compact !== "{}") return compact;
      }
    } catch (err) {
      // 다음 페이로드 형태로 재시도
      console.warn("⚠️ Jaemini 호출 실패, 다른 페이로드로 재시도:", err?.response?.data || err.message);
    }
  }

  // 모든 시도가 실패
  return "재미나이 API 응답을 받지 못했어요. 설정을 확인해 주세요.";
}

/** 텔레그램 전송 */
async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });
}

// 서버 시작
app.listen(PORT, () => {
  console.log(`✅ ItplayLab Jaemini Talk server is running on port ${PORT}`);
});


