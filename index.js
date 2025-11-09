import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ✅ 환경변수 로드
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GAS_INGEST_URL = process.env.GAS_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ✅ 헬스체크 (Render 서버 확인용)
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render → GAS Bridge",
    status: "Render is alive ✅",
    timestamp: new Date().toISOString(),
  });
});

// ✅ 테스트용 로그 전송 (Render → GAS 직접 테스트)
app.get("/test/send-log", async (req, res) => {
  try {
    const testPayload = {
      token: INGEST_TOKEN,
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        chat_id: "TEST_RENDER",
        username: "render_system",
        type: "test_log",
        input_text: "Render → GAS 연결 테스트",
        output_text: "✅ Render 서버에서 로그 전송 성공!",
        source: "Render",
        note: "자동 테스트",
      }),
    };

    await axios.post(GAS_INGEST_URL, testPayload);
    console.log("✅ 테스트 로그 전송 성공!");
    res.json({ ok: true, sent_to_gas: true });
  } catch (error) {
    console.error("❌ 테스트 전송 실패:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ✅ Telegram 메시지 수신 (Webhook 엔드포인트)
app.post("/", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    // 1️⃣ Telegram 회신
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `당신이 보낸 메시지: ${text}`,
    });

    // 2️⃣ Google Sheets 로그 전송 (GAS 웹앱)
    await axios.post(GAS_INGEST_URL, {
      token: INGEST_TOKEN,
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        chat_id: chatId,
        username: message.from.username || "",
        type: "telegram_text",
        input_text: text,
        output_text: `당신이 보낸 메시지: ${text}`,
        source: "Render",
        note: "",
      }),
    });

    console.log("✅ GAS로 로그 전송 성공:", text);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.sendStatus(500);
  }
});

// ✅ 서버 시작
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
