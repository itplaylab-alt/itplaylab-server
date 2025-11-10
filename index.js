// index.js (ItplayLab)
// - Chat Completions(JSON) 모드로 OpenAI 호출
// - /debug/routes 추가, 404 JSON 고정
// - URL 개행(%0A/%0D) 방지 미들웨어 추가

import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { profiles } from "./config/profiles.js";

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
  req.url = req.url.replace(/%0A|%0D/gi, "");
  next();
});

/* ────────────────────────────────────────────────────────────
   1) 바디 파서 (JSON)
──────────────────────────────────────────────────────────── */
app.use(
  express.json({
    limit: "1mb",
    type: (req) => /application\/json/i.test(req.headers["content-type"] || ""),
  })
);

/* JSON 파싱 에러를 400으로 */
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({ ok: false, error: "invalid_json", detail: err.message });
  }
  next();
});

/* 디버그 에코 */
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
app.get("/test/send-log", async (_req, res) => {
  try {
    await logToSheet({
      type: "test_log",
      input_text: "Render → GAS 연결 테스트",
      output_text: "✅ Render 서버에서 로그 전송 성공!",
      project: PROJECT,
      category: "system",
    });
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
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ webhook error:", e?.message);
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

// OpenAI 핑
app.get("/test/openai", async (_req, res) => {
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

/* ────────────────────────────────────────────────────────────
   입력 정규화 유틸 (topic/title/idea.title + profile 병합)
──────────────────────────────────────────────────────────── */
function normalizeIdea(body = {}) {
  // profile 프리셋 병합
  const preset = body.profile && profiles[body.profile] ? profiles[body.profile] : {};
  // title 우선순위: idea.title > title > topic
  const title =
    body?.idea?.title ??
    body?.title ??
    body?.topic ??
    undefined;

  const ideaMerged = {
    ...(preset || {}),
    ...(body.idea || {}),
    ...(title ? { title } : {}),
  };
  return ideaMerged;
}

// 4-1) 브리프 생성
app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = {
      // /content/brief 는 top-level title 또는 idea.title 모두 허용
      title: req.body?.title ?? req.body?.idea?.title,
      style: req.body?.style,
      audience: req.body?.audience,
    };
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
    console.error("openai brief error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// 4-2) 스크립트 생성
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
    console.error("openai script error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// 4-3) 썸네일/메타 생성
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
    console.error("openai assets error:", e?.message || e);
    res.status(500).json({ ok: false, error: "openai_error" });
  }
});

// ====== 디버그: 등록 라우트 덤프 ======
app.get("/debug/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map((x) => x.toUpperCase());
      routes.push({ methods, path: m.route.path });
    }
  });
  res.json({ ok: true, routes });
});

// ====== 오케스트레이터: 전체 자동/선택 실행 ======
app.post("/content/run", async (req, res) => {
  const t0 = Date.now();
  const trace_id = `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // ▶ 입력 정규화 + profile 병합
    const idea = normalizeIdea(req.body);
    const { mode = "full", steps = ["brief", "script", "assets"], gates = {} } = req.body || {};
    if (!idea || !idea.title) {
      return res.status(400).json({ ok: false, error: "idea.title required", trace_id });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing", trace_id });
    }

    const result = { trace_id };
    const metrics = { steps: {}, retries: {} };

    const withRetry = async (label, fn, retry = 1) => {
      let lastErr;
      for (let i = 0; i <= retry; i++) {
        const s = Date.now();
        try {
          const out = await fn();
          metrics.steps[label] = { ok: true, latency_ms: Date.now() - s, try: i + 1 };
          if (i > 0) metrics.retries[label] = i;
          return out;
        } catch (e) {
          lastErr = e;
          metrics.steps[label] = { ok: false, latency_ms: Date.now() - s, try: i + 1, error: String(e?.message || e) };
          if (i === retry) throw e;
        }
      }
    };

    const need = (step) => mode === "full" || steps.includes(step);

    // 1) BRIEF
    if (need("brief")) {
      const messages = [
        { role: "system", content: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 반환하라. 필드는 brief_id, idea_id, goal, key_points[], hook, outline[{sec,beat}], channels[], due_date, owner." },
        { role: "user", content: JSON.stringify(idea) },
      ];
      const cc = await withRetry("brief", async () => {
        const r = await oa.chat.completions.create({ model: OPENAI_MODEL, messages, response_format: { type: "json_object" } });
        return JSON.parse(r?.choices?.[0]?.message?.content || "{}");
      });
      result.brief = cc;
      if (gates?.min_outline && Array.isArray(cc?.outline) && cc.outline.length < gates.min_outline) {
        return res.status(412).json({ ok: false, error: "gate_outline_failed", trace_id, brief: cc });
      }
    }

    // 2) SCRIPT
    if (need("script")) {
      const scriptInput = result.brief ? { brief_id: result.brief.brief_id, goal: result.brief.goal, outline: result.brief.outline, lang: "ko" } : req.body?.script_input || {};
      const messages = [
        { role: "system", content: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 반환." },
        { role: "user", content: JSON.stringify(scriptInput) },
      ];
      const cc = await withRetry("script", async () => {
        const r = await oa.chat.completions.create({ model: OPENAI_MODEL, messages, response_format: { type: "json_object" } });
        return JSON.parse(r?.choices?.[0]?.message?.content || "{}");
      });
      result.script = cc;
      if (gates?.min_shots && Array.isArray(cc?.shots) && cc.shots.length < gates.min_shots) {
        return res.status(412).json({ ok: false, error: "gate_shots_failed", trace_id, script: cc });
      }
    }

    // 3) ASSETS
    if (need("assets")) {
      const assetsInput = { brief_id: result.brief?.brief_id || idea?.title || "brief_unknown", script: result.script || {} };
      const messages = [
        { role: "system", content: "너는 유튜브 운영자다. 썸네일 프롬프트(thumbnail_prompt)와 제목(titles 3개)/설명(descriptions)/해시태그(hashtags 5개)를 JSON으로만 반환하라." },
        { role: "user", content: JSON.stringify(assetsInput) },
      ];
      const cc = await withRetry("assets", async () => {
        const r = await oa.chat.completions.create({ model: OPENAI_MODEL, messages, response_format: { type: "json_object" } });
        return JSON.parse(r?.choices?.[0]?.message?.content || "{}");
      });
      result.assets = cc;
    }

    await logToSheet({
      type: "content_run",
      input_text: idea?.title || "",
      output_text: { trace_id, mode, steps, gates, result },
      project: PROJECT,
      category: "pipeline",
      note: `via /content/run, total_ms=${Date.now() - t0}`,
    });

    res.json({ ok: true, trace_id, metrics, ...result });
  } catch (e) {
    console.error("/content/run error:", e?.message || e);
    try {
      await logToSheet({ type: "content_run_error", input_text: req.body?.idea?.title || req.body?.title || "", output_text: String(e?.message || e), project: PROJECT, category: "pipeline", note: "run_failed" });
    } catch {}
    res.status(500).json({ ok: false, error: "run_error", trace_id: `trc_${Date.now()}` });
  }
});

// 브라우저 실수 방지용 안내
app.get("/content/run", (_req, res) =>
  res.status(405).json({ ok: false, error: "use POST with JSON body at /content/run" })
);

// ====== 404 JSON 고정 ======
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", method: req.method, path: req.originalUrl });
});

// ========== START ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
