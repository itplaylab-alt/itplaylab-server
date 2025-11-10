// index.js (ItplayLab • Safe+NLP)
// - 안정형 텔레그램 전송(tgSafeSend) 적용 → 오류시 사용자에게 ❌ 미노출
// - 자연어 파서(ko/en 혼용) + /brief, /run 슬래시 명령
// - OpenAI JSON 파이프라인(brief/script/assets)
// - /debug/routes, 404 JSON 고정, URL 줄바꿈 방지

import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { profiles } from "./config/profiles.js";

const app = express();

/* ────────────────────────────────────────────────────────────
   공통 미들웨어
──────────────────────────────────────────────────────────── */
app.use((req, _res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers["content-type"] || ""}`);
  next();
});
app.use((req, _res, next) => { req.url = req.url.replace(/%0A|%0D/gi, ""); next(); });
app.use(express.json({
  limit: "1mb",
  type: (req) => /application\/json/i.test(req.headers["content-type"] || ""),
}));
app.use((err, _req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({ ok: false, error: "invalid_json", detail: err.message });
  }
  next();
});

app.post("/debug/echo", (req, res) => res.json({ ok: true, headers: req.headers, body: req.body }));

/* ────────────────────────────────────────────────────────────
   ENV
──────────────────────────────────────────────────────────── */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval")
  .split(",").map(s => s.trim().toLowerCase());

const GAS_INGEST_URL = process.env.GAS_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const PROJECT = process.env.PROJECT || "itplaylab";
const SERVICE_NAME = process.env.SERVICE_NAME || "render-bot";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ────────────────────────────────────────────────────────────
   공통 유틸
──────────────────────────────────────────────────────────── */
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
        output_text: typeof payload.output_text === "string" ? payload.output_text : JSON.stringify(payload.output_text ?? ""),
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

function buildNotifyMessage({ type, title, message }) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  if (type === "success") return `✅ <b>${title || "성공"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "error")   return `❌ <b>${title || "오류"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  if (type === "approval")return `🟡 <b>${title || "승인 요청"}</b>\n${message || ""}\n\n⏱ ${ts}`;
  return `ℹ️ <b>${title || "알림"}</b>\n${message || ""}\n\n⏱ ${ts}`;
}

// 안전 텔레그램 전송: 실패해도 서버 흐름 끊지 않음
async function tgSafeSend(chatId, text, parse_mode = "HTML") {
  try {
    if (!chatId || !text) return;
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      parse_mode,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("⚠️ tgSafeSend error:", err?.response?.data || err?.message || err);
  }
}

/* ────────────────────────────────────────────────────────────
   헬스/테스트
──────────────────────────────────────────────────────────── */
app.get("/test/healthcheck", (_req, res) => {
  res.json({ ok: true, service: "Render → GAS Bridge + Notify", status: "Render is alive ✅", timestamp: new Date().toISOString() });
});

app.get("/test/send-log", async (_req, res) => {
  try {
    await logToSheet({ type: "test_log", input_text: "Render → GAS 연결 테스트", output_text: "✅ Render 서버에서 로그 전송 성공!", project: PROJECT, category: "system" });
    res.json({ ok: true, sent_to_gas: true });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/test/notify", async (req, res) => {
  try {
    const type = String(req.query.type || "success").toLowerCase();
    if (!NOTIFY_LEVEL.includes(type)) return res.json({ ok: true, sent: false, reason: "filtered_by_NOTIFY_LEVEL" });
    const title = String(req.query.title || "테스트");
    const message = String(req.query.message || "알림 테스트");
    await tgSafeSend(TELEGRAM_ADMIN_CHAT_ID, buildNotifyMessage({ type, title, message }));
    await logToSheet({ type: `notify_${type}`, input_text: title, output_text: message, project: PROJECT, category: "notify", note: "notify_test" });
    res.json({ ok: true, sent: true, type });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/test/openai", async (_req, res) => {
  try {
    const r = await oa.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 4 });
    res.json({ ok: true, model: OPENAI_MODEL, sample: r.choices?.[0]?.message?.content || "" });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

/* ────────────────────────────────────────────────────────────
   고급 자연어 파서
──────────────────────────────────────────────────────────── */
const RE = {
  url: /(https?:\/\/|www\.)\S+/gi,
  mention: /@[a-z0-9_]+/gi,
  hashtag: /#[^\s#]+/g,
  brackets: /[\(\[\{（【].*?[\)\]\}）】]/g,
  emojis: /([\u2700-\u27BF]|[\uE000-\uF8FF]|[\uD83C-\uDBFF\uDC00-\uDFFF])/g,
  quotes: /["“”](.+?)["“”]/,
  params: /(profile|steps|notify)\s*=\s*[^\s]+/gi,
  cmdWords: /(브리프|기획안|스크립트|대본|썸네일|메타|제목|설명|해시태그|전체|풀|한번에|원스톱|e2e|end\s*to\s*end|run|generate|create|make|build|produce|script|brief)/gi,
  tailReq: new RegExp(
    [
      "해줘","해주세요","해줘요","해 주세요","해 주라","해줘라","해봐",
      "만들어줘","만들어 줘","만들어주라","만들어","만들기","만들자",
      "뽑아줘","뽑아 줘","돌려줘","돌려 줘","줘","좀","어줘",
      "please","pls","plz","make it","make","create it","create","do it","run it","run"
    ].map(s=>`(?:${s})`).join("|") + "\\s*$", "i"
  ),
  tailJosa: /\s*(을|를|은|는|이|가|에|에서|으로|로|과|와|의|께|에게|한테)\s*$/i,
  multiSpace: /\s{2,}/g,
  trailPunct: /[.,;:!?\u3002\uFF0E\uFF1F\uFF01\uFF0C]+$/g,
};

function cleanNoise(s = "") {
  return String(s)
    .replace(RE.url, " ")
    .replace(RE.mention, " ")
    .replace(RE.hashtag, " ")
    .replace(RE.brackets, " ")
    .replace(RE.emojis, " ")
    .replace(RE.multiSpace, " ")
    .trim();
}
function extractTitleCandidate(text = "") {
  const quoted = (text.match(RE.quotes) || [])[1];
  if (quoted) return quoted.trim();
  let t = text.replace(RE.params, " ").replace(RE.cmdWords, " ")
    .replace(RE.tailReq, " ").replace(RE.tailJosa, " ")
    .replace(RE.trailPunct, "").replace(RE.multiSpace, " ").trim();
  t = t.replace(/^(은|는|이|가)\s+/i, "").trim();
  t = t.replace(/\s*(만|only)\s*$/i, "").trim();
  return t || undefined;
}
function parseIntentKo(textRaw = "") {
  const raw = String(textRaw || "").trim();
  if (!raw) return { intent: "brief", title: undefined, steps: ["brief"], raw };
  const text = cleanNoise(raw);

  let title = extractTitleCandidate(text);
  if (title) {
    for (let i = 0; i < 3; i++) {
      const before = title;
      title = title.replace(RE.tailReq, " ").replace(RE.tailJosa, " ")
        .replace(RE.trailPunct, "").replace(RE.multiSpace, " ").trim();
      if (before === title) break;
    }
    if (title.length < 2) title = undefined;
  }

  const wantBrief  = /(브리프|기획안|brief)/i.test(text);
  const wantScript = /(스크립트|대본|script)/i.test(text);
  const wantAssets = /(썸네일|타이틀|제목|설명|해시태그|메타|assets?)/i.test(text);
  const wantFull   = /(전체|풀|한번에|원스톱|e2e|end\s*to\s*end)/i.test(text);

  let profile = (text.match(/profile\s*=\s*([^\s]+)/i) || [])[1];
  if (!profile) {
    if (/(튜토리얼|설명형|how[-\s]?to|tutorial)/i.test(text)) profile = "shorts_tutorial_v1";
    else if (/(마케팅|프로모션|홍보|광고|promotion|marketing)/i.test(text)) profile = "shorts_marketing_v1";
  }

  let notify;
  if (/notify\s*=\s*false/i.test(text) || /(알림\s*끄|조용히|무음|silent|quiet)/i.test(text)) notify = false;
  if (/notify\s*=\s*true/i.test(text)  || /(알림\s*켜|통지|notify)/i.test(text))  notify = true;

  let stepsKV = (text.match(/steps\s*=\s*([^\s]+)/i) || [])[1];
  let steps;
  if (stepsKV) {
    steps = stepsKV.split(/[,\s/|>]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  } else {
    if (wantFull) steps = ["brief","script","assets"];
    else {
      const arr = [];
      if (wantBrief)  arr.push("brief");
      if (wantScript) arr.push("script");
      if (wantAssets) arr.push("assets");
      steps = arr.length ? arr : ["brief"];
    }
    if (/브리프\s*만|brief\s*only/i.test(text)) steps = ["brief"];
    if (/스크립트\s*만|대본\s*만|script\s*only/i.test(text)) steps = ["script"];
    if (/썸네일\s*만|assets?\s*only/i.test(text)) steps = ["assets"];
  }

  let intent = "run_parts";
  if (wantFull || steps.join(",") === "brief,script,assets") intent = "run_full";
  if (steps.length === 1 && steps[0] === "brief") intent = "brief";

  return { intent, title, steps, profile, notify, raw };
}

/* ────────────────────────────────────────────────────────────
   Telegram Webhook (안전 전송 사용)
──────────────────────────────────────────────────────────── */
app.post("/", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    // 슬래시 명령
    if (text.startsWith("/")) {
      if (text.startsWith("/on")) { await tgSafeSend(chatId, "✅ 요청 수락. (운영모드)"); return res.sendStatus(200); }
      if (text.startsWith("/off")) { await tgSafeSend(chatId, "🟡 대기모드"); return res.sendStatus(200); }

      if (text.startsWith("/brief")) {
        const title = text.replace(/^\/brief\s*/i, "").trim().replace(/^"(.+)"$/, "$1");
        if (!title) { await tgSafeSend(chatId, "❗형식: /brief 제목"); return res.sendStatus(200); }
        await tgSafeSend(chatId, `⏳ 브리프 생성: ${title}`);
        const r = await axios.post(`${req.protocol}://${req.get("host")}/content/brief`, { title, style:"YouTube Shorts" });
        await tgSafeSend(chatId, `✅ 브리프 완료\n<pre>${JSON.stringify(r.data.brief, null, 2)}</pre>`);
        return res.sendStatus(200);
      }

      if (text.startsWith("/run")) {
        const raw = text.replace(/^\/run\s*/i, "");
        const parts = raw.match(/"(.+?)"|[^\s]+/g) || [];
        const title = (parts[0] || "").replace(/^"(.+)"$/, "$1");
        const optsPairs = parts.slice(1).map(s => s.split("=").map(x=>x.trim())).filter(a=>a[0]&&a[1]);
        const opts = Object.fromEntries(optsPairs);
        const steps = (opts.steps ? opts.steps.split(/[,\s]+/).filter(Boolean) : ["brief","script","assets"]);
        const profile = opts.profile || "shorts_marketing_v1";
        const notify = opts.notify ? opts.notify === "true" : false;

        if (!title) { await tgSafeSend(chatId, "❗형식: /run \"제목\" profile=... steps=..."); return res.sendStatus(200); }

        await tgSafeSend(chatId, `⏳ 실행 시작\n• title: ${title}\n• profile: ${profile}\n• steps: ${steps.join(",")}`);
        const r = await axios.post(`${req.protocol}://${req.get("host")}/content/run`, { profile, idea:{ title }, steps, notify });
        const summary = {
          trace_id: r.data.trace_id,
          have: { brief: !!r.data.brief, script: !!r.data.script, assets: !!r.data.assets },
          ms: Object.fromEntries(Object.entries(r.data?.metrics?.steps || {}).map(([k,v]) => [k, v.latency_ms]))
        };
        await tgSafeSend(chatId, `✅ 실행 완료\n<pre>${JSON.stringify(summary, null, 2)}</pre>`);
        return res.sendStatus(200);
      }

      await tgSafeSend(chatId, "ℹ️ 지원 명령: /brief 제목, /run \"제목\" profile=... steps=...");
      return res.sendStatus(200);
    }

    // 자연어 처리
    const intent = parseIntentKo(text);
    if (!intent.title) {
      await tgSafeSend(chatId, "❗제목을 인식하지 못했어요.\n예) \"AI 자동화 콘텐츠 전략\" 브리프 만들어줘");
      await logToSheet({ chat_id: chatId, type:"nlp_parse_fail", input_text:text, output_text:"no_title", project:PROJECT, category:"chat" });
      return res.sendStatus(200);
    }

    await tgSafeSend(
      chatId,
      `🧠 해석 결과\n• intent: ${intent.intent}\n• title: ${intent.title}\n• steps: ${intent.steps.join(",")}\n• profile: ${intent.profile || "-"}\n• notify: ${String(intent.notify ?? "default")}`
    );

    if (intent.intent === "brief") {
      const r = await axios.post(`${req.protocol}://${req.get("host")}/content/brief`, { title: intent.title, style: "YouTube Shorts" });
      await tgSafeSend(chatId, `✅ 브리프 완료\n<pre>${JSON.stringify(r.data.brief, null, 2)}</pre>`);
      return res.sendStatus(200);
    }

    const r = await axios.post(`${req.protocol}://${req.get("host")}/content/run`, {
      profile: intent.profile || "shorts_marketing_v1",
      idea: { title: intent.title },
      steps: intent.steps,
      notify: intent.notify ?? false
    });
    const summary = {
      trace_id: r.data.trace_id,
      have: { brief: !!r.data.brief, script: !!r.data.script, assets: !!r.data.assets },
      ms: Object.fromEntries(Object.entries(r.data?.metrics?.steps || {}).map(([k,v]) => [k, v.latency_ms]))
    };
    await tgSafeSend(chatId, `✅ 실행 완료\n<pre>${JSON.stringify(summary, null, 2)}</pre>`);
    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
    // 사용자 채팅에는 노출하지 않고, 관리자/로그에만 기록
    await logToSheet({
      type: "webhook_error",
      input_text: req.body?.message?.text || "",
      output_text: e?.message || String(e),
      project: PROJECT,
      category: "telegram",
      note: "safe_catch"
    });
    await tgSafeSend(TELEGRAM_ADMIN_CHAT_ID, buildNotifyMessage({
      type: "error",
      title: "Webhook 경고",
      message: e?.message || "unknown"
    }));
    return res.sendStatus(200); // 실패라도 사용자 측에는 오류 미노출
  }
});

/* ────────────────────────────────────────────────────────────
   OpenAI 파이프라인
──────────────────────────────────────────────────────────── */
function requireOpenAI(res) {
  if (!OPENAI_API_KEY) { res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" }); return false; }
  return true;
}

function normalizeIdea(body = {}) {
  const preset = body.profile && profiles[body.profile] ? profiles[body.profile] : {};
  const title = body?.idea?.title ?? body?.title ?? body?.topic ?? undefined;
  return { ...(preset || {}), ...(body.idea || {}), ...(title ? { title } : {}) };
}

app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = { title: req.body?.title ?? req.body?.idea?.title, style: req.body?.style, audience: req.body?.audience };
    if (!idea.title) return res.status(400).json({ ok: false, error: "title required" });

    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 반환하라. 필드는 brief_id, idea_id, goal, key_points[], hook, outline[{sec,beat}], channels[], due_date, owner. 불필요한 텍스트 금지." },
        { role: "user", content: JSON.stringify(idea) },
      ],
      response_format: { type: "json_object" },
    });

    const brief = JSON.parse(cc?.choices?.[0]?.message?.content || "{}");
    await logToSheet({ type: "content_brief", input_text: idea.title, output_text: brief, project: PROJECT, category: "brief", note: `via /content/brief, latency_ms=${Date.now()-t0}` });
    res.json({ ok: true, brief });
  } catch (e) { console.error("openai brief error:", e?.message || e); res.status(500).json({ ok: false, error: "openai_error" }); }
});

app.post("/content/script", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const brief = req.body || {};
    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 반환." },
        { role: "user", content: JSON.stringify(brief) },
      ],
      response_format: { type: "json_object" },
    });
    const script = JSON.parse(cc?.choices?.[0]?.message?.content || "{}");
    await logToSheet({ type: "content_script", input_text: brief.brief_id || "", output_text: script, project: PROJECT, category: "content", note: `via /content/script, latency_ms=${Date.now()-t0}` });
    res.json({ ok: true, script });
  } catch (e) { console.error("openai script error:", e?.message || e); res.status(500).json({ ok: false, error: "openai_error" }); }
});

app.post("/content/assets", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const { brief_id, script } = req.body || {};
    const cc = await oa.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "너는 유튜브 운영자다. 썸네일 프롬프트(thumbnail_prompt)와 제목(titles 3개)/설명(descriptions)/해시태그(hashtags 5개)를 JSON으로만 반환하라." },
        { role: "user", content: JSON.stringify({ brief_id, script }) },
      ],
      response_format: { type: "json_object" },
    });
    const assets = JSON.parse(cc?.choices?.[0]?.message?.content || "{}");
    await logToSheet({ type: "content_assets", input_text: brief_id || "", output_text: assets, project: PROJECT, category: "asset", note: `via /content/assets, latency_ms=${Date.now()-t0}` });
    res.json({ ok: true, assets });
  } catch (e) { console.error("openai assets error:", e?.message || e); res.status(500).json({ ok: false, error: "openai_error" }); }
});

app.get("/debug/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => { if (m.route && m.route.path) routes.push({ methods: Object.keys(m.route.methods).map(x=>x.toUpperCase()), path: m.route.path }); });
  res.json({ ok: true, routes });
});

app.post("/content/run", async (req, res) => {
  const t0 = Date.now();
  const trace_id = `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const idea = normalizeIdea(req.body);
    const { mode = "full", steps = ["brief","script","assets"], gates = {} } = req.body || {};
    if (!idea?.title) return res.status(400).json({ ok: false, error: "idea.title required", trace_id });
    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing", trace_id });

    const result = { trace_id };
    const metrics = { steps: {}, retries: {} };
    const withRetry = async (label, fn, retry = 1) => {
      let lastErr;
      for (let i = 0; i <= retry; i++) {
        const s = Date.now();
        try {
          const out = await fn();
          metrics.steps[label] = { ok: true, latency_ms: Date.now()-s, try: i+1 };
          if (i>0) metrics.retries[label] = i;
          return out;
        } catch (e) {
          lastErr = e;
          metrics.steps[label] = { ok: false, latency_ms: Date.now()-s, try: i+1, error: String(e?.message || e) };
          if (i === retry) throw e;
        }
      }
    };
    const need = (step) => mode === "full" || steps.includes(step);

    if (need("brief")) {
      const cc = await withRetry("brief", async () => {
        const r = await oa.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 반환하라. 필드는 brief_id, idea_id, goal, key_points[], hook, outline[{sec,beat}], channels[], due_date, owner." },
            { role: "user", content: JSON.stringify(idea) },
          ],
          response_format: { type: "json_object" },
        });
        return JSON.parse(r?.choices?.[0]?.message?.content || "{}");
      });
      result.brief = cc;
      if (gates?.min_outline && Array.isArray(cc?.outline) && cc.outline.length < gates.min_outline) {
        return res.status(412).json({ ok: false, error: "gate_outline_failed", trace_id, brief: cc });
      }
    }

    if (need("script")) {
      const scriptInput = result.brief ? { brief_id: result.brief.brief_id, goal: result.brief.goal, outline: result.brief.outline, lang: "ko" } : req.body?.script_input || {};
      const cc = await withRetry("script", async () => {
        const r = await oa.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: "너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 반환." },
            { role: "user", content: JSON.stringify(scriptInput) },
          ],
          response_format: { type: "json_object" },
        });
        return JSON.parse(r?.choices?.[0]?.message?.content || "{}");
      });
      result.script = cc;
      if (gates?.min_shots && Array.isArray(cc?.shots) && cc.shots.length < gates.min_shots) {
        return res.status(412).json({ ok: false, error: "gate_shots_failed", trace_id, script: cc });
      }
    }

    if (need("assets")) {
      const assetsInput = { brief_id: result.brief?.brief_id || idea?.title || "brief_unknown", script: result.script || {} };
      const cc = await withRetry("assets", async () => {
        const r = await oa.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: "너는 유튜브 운영자다. 썸네일 프롬프트(thumbnail_prompt)와 제목(titles 3개)/설명(descriptions)/해시태그(hashtags 5개)를 JSON으로만 반환하라." },
            { role: "user", content: JSON.stringify(assetsInput) },
          ],
          response_format: { type: "json_object" },
        });
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
      note: `via /content/run, total_ms=${Date.now()-t0}`,
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

app.get("/content/run", (_req, res) => res.status(405).json({ ok: false, error: "use POST with JSON body at /content/run" }));

/* ────────────────────────────────────────────────────────────
   404 & START
──────────────────────────────────────────────────────────── */
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", method: req.method, path: req.originalUrl }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
