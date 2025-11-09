import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===== ENV =====
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ADMIN  = process.env.TELEGRAM_ADMIN_CHAT_ID; // 관리자 채팅 ID
const NOTIFY_LEVEL    = (process.env.NOTIFY_LEVEL || "success,error,approval")
                          .split(",").map(s => s.trim().toLowerCase());
const GAS_INGEST_URL  = process.env.GAS_INGEST_URL;
const INGEST_TOKEN    = process.env.INGEST_TOKEN;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ===== helpers =====
async function sendTelegram(chatId, text, parse_mode = "HTML") {
  if (!chatId) return;
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("sendTelegram error:", e.message);
  }
}

function shouldNotify(type) {
  return NOTIFY_LEVEL.includes(String(type || "").toLowerCase());
}

function fmtMsg(type, data = {}) {
  const label = {
    success: "✅ 완료",
    error: "⚠️ 오류",
    approval: "🕒 승인 요청",
  }[type] || "ℹ️ 안내";

  const lines = [
    `<b>[${label}]</b> ${data.title || data.job_id || ""}`.trim(),
    data.message ? `• ${data.message}` : "",
    data.link ? `🔗 <a href="${data.link}">열기</a>` : "",
    data.detail ? `\n${data.detail}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

async function notify(type, data = {}) {
  if (!shouldNotify(type)) return;
  await sendTelegram(TELEGRAM_ADMIN, fmtMsg(type, data));
}

async function logToGAS(payload) {
  if (!GAS_INGEST_URL) return;
  try {
    await axios.post(GAS_INGEST_URL, {
      token: INGEST_TOKEN,
      contents: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("logToGAS error:", e.message);
  }
}

// ===== health =====
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render → GAS Bridge + Notify",
    status: "Render is alive ✅",
    timestamp: new Date().toISOString(),
  });
});

// ===== test: send log to GAS =====
app.get("/test/send-log", async (req, res) => {
  try {
    await logToGAS({
      timestamp: new Date().toISOString(),
      chat_id: "TEST_RENDER",
      username: "render_system",
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      source: "Render",
      note: "자동 테스트",
    });
    console.log("✅ 테스트 로그 전송 성공!");
    res.json({ ok: true, sent_to_gas: true });
  } catch (error) {
    console.error("❌ 테스트 전송 실패:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== test: notify (success / error / approval) =====
app.get("/test/notify", async (req, res) => {
  try {
    const type = (req.query.type || "success").trim().toLowerCase();
    const msg = {
      job_id: "JOB-" + Date.now(),
      title: req.query.title || "테스트 작업",
      message: req.query.message || `테스트 알림 (${type})`,
      link: req.query.link || "",
    };
    await notify(type, msg);
    res.json({ ok: true, notified: shouldNotify(type), type });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== Telegram webhook (OpenAI는 나중에) =====
app.post("/", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const user   = message.from?.username || "";
    const text   = (message.text || "").trim();

    // 운영용 테스트 명령
    if (text === "/approve") {
      await notify("approval", { title: "콘텐츠 초안 승인 필요", message: "브리프 확인 후 승인해주세요." });
      await sendTelegram(chatId, "승인 요청을 관리자에게 보냈습니다.");
      return res.sendStatus(200);
    }
    if (text === "/ok") {
      await notify("success", { title: "제작 파이프라인", message: "작업 성공적으로 완료" });
      await sendTelegram(chatId, "완료 알림이 전송되었습니다.");
      return res.sendStatus(200);
    }
    if (text === "/fail") {
      await notify("error", { title: "제작 파이프라인", message: "작업 실패. 재시도 예정" });
      await sendTelegram(chatId, "오류 알림이 전송되었습니다.");
      return res.sendStatus(200);
    }

    // 기본 Echo (OpenAI 연동 전)
    const answer = `당신이 보낸 메시지: ${text}`;
    await sendTelegram(chatId, answer);

    await logToGAS({
      timestamp: new Date().toISOString(),
      chat_id: chatId,
      username: user,
      type: "telegram_text",
      input_text: text,
      output_text: answer,
      source: "Render",
      note: "",
    });

    res.sendStatus(200);
  } catch (error) {
    await notify("error", { title: "Webhook 오류", message: error.message });
    console.error("❌ Webhook Error:", error.message);
    res.sendStatus(500);
  }
});

// ===== start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
