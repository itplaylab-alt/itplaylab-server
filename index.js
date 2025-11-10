// index.js (ItplayLab)
// - Chat Completions(JSON) 모드로 OpenAI 호출
// - /debug/routes 추가, 404 JSON 고정
// - URL 개행(%0A/%0D) 방지 미들웨어 추가

import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();

/* ────────────────────────────────────────────────────────────
   0) 요청 로깅 + Content-Type 확인 (가장 위, 미들웨어들보다 먼저)
──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  console.log(
    `[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers["content-type"] || ""}`
  );
  next();
});

/* ────────────────────────────────────────────────────────────
   0-1) URL 개행/공백 정리 (붙여넣기 실수 방지)
──────────────────────────────────────────────────────────── */
app.use((req, _res, next) => {
  // 인코딩된 줄바꿈 제거, 말단 슬래시는 /path/ → /path 허용
  req.url = req.url.replace(/%0A|%0D/gi, "");
  next();
});

/* ────────────────────────────────────────────────────────────
   1) 바디 파서 (JSON) — 용량 제한 및 타입 지정
──────────────────────────────────────────────────────────── */
app.use(
  express.json({
    limit: "1mb",
    // charset이 섞여도 매칭되도록 함수 형태로 허용
    type: (req) => /application\/json/i.test(req.headers["content-type"] || ""),
  })
);

/* JSON 파싱 에러를 400으로 돌려보내기 */
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res
      .status(400)
      .json({ ok: false, error: "invalid_json", detail: err.message });
  }
  next();
});

/* 디버그용 에코 엔드포인트 (본문/헤더 그대로 보기) */
app.post("/debug/echo", (req, res) => {
  console.log("[ECHO]", req.body);
  res.json({ ok: true, headers: req.headers, body: req.body });
});

// ========== ENV ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const GAS_INGEST_URL = process.env.GAS_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const PROJECT = process.env.PROJECT || "itplaylab";
const SERVICE_NAME = process.env.SERVICE_NAME || "render-bot";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// OpenAI Client
const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

// 공통: GAS 로깅
async function logToSheet(payload) {
  const t0 = Date.now();
  try {
    await axios.post(GAS_INGEST_URL, {
      token: INGEST_TOKEN,
      contents: JSON.stringify({
        timestamp: new Date().toISOString(),
        chat_id: String(payload.chat_id ?? "system"),
        username: String(payload.username ?? "render_system"),
        type: String(payload.type ?? "system_log"),
        input_text: String(payload.input_text ?? ""),
        output_text:
          typeof payload.output_text === "string"
            ? payload.output_text
            : JSON.stringify(payload.output_text ?? ""),
        source: String(payload.source ?? "Render"),
        note: String(payload.note ?? ""),
        project: String(payload.project ?? PROJECT),
        category: String(payload.category ?? "system"),
        service: String(SERVICE_NAME),
        latency_ms: payload.latency_ms ?? 0,
      }),
    });
  } catch (e) {
    console.error("❌ GAS log fail:", e?.message);
  } finally {
    payload.latency_ms = Date.now() - t0;
  }
}

// 공통: 텔레그램 전송
async function tgSend(chatId, text, parse_mode = "HTML") {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode,
    disable_web_page_preview: true,
  });
}

// 메시지 포맷
function buildNotifyMessage({ type, title, message }) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  if (type === "success") return `✅ <b>${title || "성공"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "error") return `❌ <b>${title || "오류"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "approval") return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n⏱ ${ts}`;
}

// ========== 헬스체크 ==========
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render → GAS Bridge + Notify",
    status: "Render is alive ✅",
    timestamp: new Date().toISOString(),
  });
});

// ========== GAS 연결 테스트 ==========
app.get("/test/send-log", async (req, res) => {
  try {
    const payload = {
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
    };
    await logToSheet(payload);
    res.json({ ok: true, sent_to_gas: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ========== 알림 전송 테스트 ==========
app.get("/test/notify", async (req, res) => {
  try {
    const type = String(req.query.type || "success").toLowerCase();
    const title = String(req.query.title || "");
    const message = String(req.query.message || "");

    if (!NOTIFY_LEVEL.includes(type)) {
      return res.json({ ok: true, sent: false, reason: "filtered_by_NOTIFY_LEVEL" });
    }

    const text = buildNotifyMessage({ type, title, message });
    await tgSend(TELEGRAM_ADMIN_CHAT_ID, text);

    await logToSheet({
      type: `notify_${type}`,
      input_text: title,
      output_text: message,
      project: PROJECT,
      category: "notify",
      note: "notify_test",
    });

    res.json({ ok: true, sent: true, type });
  } catch (e) {
    console.error("❌ notify error:", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ========== Telegram Webhook ==========
app.post("/", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");

    await logToSheet({
      chat_id: chatId,
      username: message.from?.username || "",
      type: "telegram_text",
      input_text: text,
      output_text: `당신이 보낸 메시지: ${text}`,
      project: PROJECT,
      category: "chat",
      note: "",
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ webhook error:", e?.message);
    if (NOTIFY_LEVEL.includes("error")) {
      try {
        await tgSend(
          TELEGRAM_ADMIN_CHAT_ID,
          buildNotifyMessage({
            type: "error",
            title: "Webhook 처리 오류",
            message: e?.message || "unknown",
          })
        );
      } catch {}
    }
    res.sendStatus(500);
  }
});

// ========== OpenAI 콘텐츠 라인 ==========
function requireOpenAI(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
    return false;
  }
  return true;
}

// 4-0) OpenAI 핑
app.get("/test/openai", async (req, res) => {
  try {
    const r = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4,
    });
    res.json({ ok: true, model: OPENAI_MODEL, sample: r.choices?.[0]?.message?.content || "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 4-1) 브리프 생성 (Chat Completions JSON 모드)
app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = req.body || {};
    if (!idea.title) {
      return res.status(400).json({ ok: false, error: "title required" });
    }

    const messages = [
      {
        role: "system",
        content:
          "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 반환하라. 필드는 brief_id, idea_id, goal, key_points[], hook, outline[{sec,beat}], channels[], due_date, owner. 불필요한 텍스트 금지.",
      },
      { role: "user", content: JSON.stringify(idea) },
    ];

    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: "json_object" },
    });

    const raw = cc?.choices?.[0]?.message?.content || "{}";
    const brief = JSON.parse(raw);

    await logToSheet({
      type: "content_brief",
      input_text: idea.title || "",
      output_text: brief,
      project: PROJECT,
      category: "brief",
      note: `via /content/brief, latency_ms=${Date.now() - t0}`,
    });

    res.json({ ok: true, brief });
  } catch (e) {
    console.error("openai brief error (cc):", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// 4-2) 스크립트 생성 (Chat Completions JSON)
app.post("/content/script", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const brief = req.body || {};

    const messages = [
      {
        role: "system",
        content: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 반환.",
      },
      { role: "user", content: JSON.stringify(brief) },
    ];

    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: "json_object" },
    });

    const raw = cc?.choices?.[0]?.message?.content || "{}";
    const script = JSON.parse(raw);

    await logToSheet({
      type: "content_script",
      input_text: brief.brief_id || "",
      output_text: script,
      project: PROJECT,
      category: "content",
      note: `via /content/script, latency_ms=${Date.now() - t0}`,
    });

    res.json({ ok: true, script });
  } catch (e) {
    console.error("openai script error (cc):", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// 4-3) 썸네일/메타 생성 (Chat Completions JSON)
app.post("/content/assets", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const { brief_id, script } = req.body || {};

    const messages = [
      {
        role: "system",
        content:
          "너는 유튜브 운영자다. 썸네일 프롬프트(thumbnail_prompt)와 제목(titles 3개)/설명(descriptions)/해시태그(hashtags 5개)를 JSON으로만 반환하라.",
      },
      { role: "user", content: JSON.stringify({ brief_id, script }) },
    ];

    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: "json_object" },
    });

    const raw = cc?.choices?.[0]?.message?.content || "{}";
    const assets = JSON.parse(raw);

    await logToSheet({
      type: "content_assets",
      input_text: brief_id || "",
      output_text: assets,
      project: PROJECT,
      category: "asset",
      note: `via /content/assets, latency_ms=${Date.now() - t0}`,
    });

    res.json({ ok: true, assets });
  } catch (e) {
    console.error("openai assets error (cc):", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// ====== 디버그: 등록 라우트 덤프 ======
app.get("/debug/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map((x) => x.toUpperCase());
      routes.push({ methods, path: m.route.path });
    }
  });
  res.json({ ok: true, routes });
});

// ====== 404 JSON 고정 ======
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", method: req.method, path: req.originalUrl });
});

// ========== START ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
