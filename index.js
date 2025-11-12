// index.js — Hotfix: 테스트 라우트만 우선 가동
// package.json 에 "type":"module" 이어야 합니다.
import express from "express";
import axios from "axios";

const app = express(); // ✅ app 먼저 만들고 라우트 등록

// ────────────────────────────────
// TEST ROUTES (헬스체크 / GAS / 알림)
// ────────────────────────────────
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render → GAS Bridge + Notify + Approval Loop",
    status: "✅ Alive",
    timestamp: new Date().toISOString(),
    approval_mode: String(process.env.APPROVAL_MODE || "true"),
  });
});

app.get("/test/send-log", async (req, res) => {
  try {
    const { GAS_INGEST_URL, INGEST_TOKEN, PROJECT = "itplaylab" } = process.env;
    if (!GAS_INGEST_URL || !INGEST_TOKEN) {
      return res.json({
        ok: true,
        sent_to_gas: false,
        reason: "GAS_INGEST_URL or INGEST_TOKEN not set",
      });
    }
    const payload = {
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
      timestamp: new Date().toISOString(),
    };
    await axios.post(GAS_INGEST_URL, {
      token: INGEST_TOKEN,
      contents: JSON.stringify(payload),
    });
    res.json({ ok: true, sent_to_gas: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send-log-failed" });
  }
});

app.get("/test/notify", async (req, res) => {
  try {
    const { TELEGRAM_TOKEN, TELEGRAM_ADMIN_CHAT_ID } = process.env;
    if (!TELEGRAM_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
      return res.json({
        ok: true,
        sent: false,
        reason: "TELEGRAM_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set",
      });
    }
    const type = String(req.query.type || "success");
    const title = String(req.query.title || "Ping");
    const message = String(req.query.message || "Render Notify Test");
    const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
    const text = `✅ [${type}] ${title}\n${message}\n🕒 ${new Date().toISOString()}`;
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text,
    });
    res.json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "notify-failed" });
  }
});

// ────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Test server running on ${PORT} — health:/test/healthcheck`)
);
