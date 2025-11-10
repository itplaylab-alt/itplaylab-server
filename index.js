// index.js (ItplayLab • Advanced NLP ver.)
// - Chat Completions(JSON) 모드로 OpenAI 호출
// - /debug/routes 추가, 404 JSON 고정
// - URL 개행(%0A/%0D) 방지 미들웨어 추가
// - 텔레그램: 자연어 파서 + 슬래시 명령(/brief, /run) 지원
// - 고급형 정규식 파서: 한/영 혼용 명령어, 말끝/조사/불용어/이모지/URL/해시태그/괄호주석 제거

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

/* ────────────────────────────────────────────────────────────
   고급형 자연어 파서 유틸
   - 불용어/이모지/URL/멘션/해시태그/괄호주석 제거
   - 요청형 어미·조사 꼬리 제거, 한/영 혼용 명령어 인식
──────────────────────────────────────────────────────────── */
const RE = {
  url: /(https?:\/\/|www\.)\S+/gi,
  mention: /@[a-z0-9_]+/gi,
  hashtag: /#[^\s#]+/g,
  brackets: /[\(\[\{（【].*?[\)\]\}）】]/g,        // (주석), [참고] 등
  emojis: /([\u2700-\u27BF]|[\uE000-\uF8FF]|[\uD83C-\uDBFF\uDC00-\uDFFF])/g,
  quotes: /["“”](.+?)["“”]/,                      // 인용된 제목
  params: /(profile|steps|notify)\s*=\s*[^\s]+/gi,
  // 문장 내 명령 단어 (양끝/중간)
  cmdWords: /(브리프|기획안|스크립트|대본|썸네일|메타|제목|설명|해시태그|전체|풀|한번에|원스톱|e2e|end\s*to\s*end|run|generate|create|make|build|produce|script|brief)/gi,
  // 요청형 어미(결합형 포함)
  tailReq: new RegExp(
    [
      "해줘", "해주세요", "해줘요", "해 주세요", "해 주라", "해줘라", "해봐",
      "만들어줘", "만들어 줘", "만들어주라", "만들어", "만들기", "만들자",
      "뽑아줘", "뽑아 줘", "돌려줘", "돌려 줘", "줘", "좀", "어줘",
      "please", "pls", "plz", "make it", "make", "create it", "create", "do it", "run it", "run"
    ].map(s => `(?:${s})`).join("|") + "\\s*$", "i"
  ),
  // 조사/어미 꼬리
  tailJosa: /\s*(을|를|은|는|이|가|에|에서|으로|로|과|와|의|께|에게|한테)\s*$/i,
  // 중복 스페이스/구두점
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
  // 1) 따옴표 안 우선
  const quoted = (text.match(RE.quotes) || [])[1];
  if (quoted) return quoted.trim();

  // 2) 명령어/파라미터/불용어 제거하고 남은 본문에서 추출
  let t = text
    .replace(RE.params, " ")
    .replace(RE.cmdWords, " ")
    .replace(RE.tailReq, " ")
    .replace(RE.tailJosa, " ")
    .replace(RE.trailPunct, "")
    .replace(RE.multiSpace, " ")
    .trim();

  // 문장 시작부 ‘~은/는’ 제거
  t = t.replace(/^(은|는|이|가)\s+/i, "").trim();
  // ‘~만’ 종결 제거
  t = t.replace(/\s*(만|only)\s*$/i, "").trim();

  return t || undefined;
}

/* ────────────────────────────────────────────────────────────
   고급형 자연어 → 명령 파서 (ko/en 혼용)
──────────────────────────────────────────────────────────── */
function parseIntentKo(textRaw = "") {
  const raw = String(textRaw || "").trim();
  if (!raw) return { intent: "brief", title: undefined, steps: ["brief"], raw };

  // 0) 전처리 (노이즈 제거)
  const text = cleanNoise(raw);

  // 1) title 후보 추출 + 꼬리 정리
  let title = extractTitleCandidate(text);
  if (title) {
    // 요청형 어미/조사/구두점 추가 정리 (여러 번)
    for (let i = 0; i < 3; i++) {
      const before = title;
      title = title
        .replace(RE.tailReq, " ")
        .replace(RE.tailJosa, " ")
        .replace(RE.trailPunct, "")
        .replace(RE.multiSpace, " ")
        .trim();
      if (before === title) break;
    }
    if (title.length < 2) title = undefined;
  }

  // 2) intent/steps 판단
  const wantBrief   = /(브리프|기획안|brief)/i.test(text);
  const wantScript  = /(스크립트|대본|script)/i.test(text);
  const wantAssets  = /(썸네일|타이틀|제목|설명|해시태그|메타|assets?)/i.test(text);
  const wantFull    = /(전체|풀|한번에|원스톱|e2e|end\s*to\s*end)/i.test(text);

  // 3) profile 매핑
  let profile = (text.match(/profile\s*=\s*([^\s]+)/i) || [])[1];
  if (!profile) {
    if (/(튜토리얼|설명형|how[-\s]?to|tutorial)/i.test(text)) profile = "shorts_tutorial_v1";
    else if (/(마케팅|프로모션|홍보|광고|promotion|marketing)/i.test(text)) profile = "shorts_marketing_v1";
  }

  // 4) notify 토글
  let notify;
  if (/notify\s*=\s*false/i.test(text) || /(알림\s*끄|조용히|무음|silent|quiet)/i.test(text)) notify = false;
  if (/notify\s*=\s*true/i.test(text)  || /(알림\s*켜|통지|notify)/i.test(text)) notify = true;

  // 5) steps 파라미터 직접 지정 (steps=brief,script)
  let stepsKV = (text.match(/steps\s*=\s*([^\s]+)/i) || [])[1];
  let steps;
  if (stepsKV) {
    steps = stepsKV.split(/[,\s/|>]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  } else {
    if (wantFull) steps = ["brief", "script", "assets"];
    else {
      const arr = [];
      if (wantBrief)  arr.push("brief");
      if (wantScript) arr.push("script");
      if (wantAssets) arr.push("assets");
      steps = arr.length ? arr : ["brief"]; // 기본: 브리프
    }
    // ‘~만’ 패턴: brief만/스크립트만/썸네일만
    if (/브리프\s*만|brief\s*only/i.test(text)) steps = ["brief"];
    if (/스크립트\s*만|대본\s*만|script\s*only/i.test(text)) steps = ["script"];
    if (/썸네일\s*만|assets?\s*only/i.test(text)) steps = ["assets"];
  }

  let intent = "run_parts";
  if (wantFull || steps.join(",") === "brief,script,assets") intent = "run_full";
  if (steps.length === 1 && steps[0] === "brief") intent = "brief";

  return { intent, title, steps, profile, notify, raw };
}

// ========== Telegram Webhook ==========
app.post("/", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    // 1) 슬래시 명령 우선 처리 (/brief, /run, /on, /off)
    if (text.startsWith("/")) {
      if (text.startsWith("/on")) {
        await tgSend(chatId, "✅ 요청 수락. (환경변수 BOT_ACTIVE=on 권장)");
        return res.sendStatus(200);
      }
      if (text.startsWith("/off")) {
        await tgSend(chatId, "🟡 대기모드 안내: (환경변수 BOT_ACTIVE=off 권장)");
        return res.sendStatus(200);
      }

      // /brief 제목
      if (text.startsWith("/brief")) {
        const title = text.replace(/^\/brief\s*/i, "").trim().replace(/^"(.+)"$/, "$1");
        if (!title) { await tgSend(chatId, "❗형식: /brief 제목"); return res.sendStatus(200); }
        await tgSend(chatId, `⏳ 브리프 생성: ${title}`);
        const r = await axios.post(`${req.protocol}://${req.get("host")}/content/brief`, { title, style:"YouTube Shorts" });
        await tgSend(chatId, `✅ 브리프 완료\n<pre>${JSON.stringify(r.data.brief, null, 2)}</pre>`, "HTML");
        return res.sendStatus(200);
      }

      // /run "제목" profile=... steps=...
      if (text.startsWith("/run")) {
        const raw = text.replace(/^\/run\s*/i, "");
        const parts = raw.match(/"(.+?)"|[^\s]+/g) || [];
        const title = (parts[0] || "").replace(/^"(.+)"$/, "$1");
        const optsPairs = parts.slice(1).map(s => s.split("=").map(x=>x.trim())).filter(a=>a[0]&&a[1]);
        const opts = Object.fromEntries(optsPairs);
        const steps = (opts.steps ? opts.steps.split(/[,\s]+/).filter(Boolean) : ["brief","script","assets"]);
        const profile = opts.profile || "shorts_marketing_v1";
        const notify = opts.notify ? opts.notify === "true" : false;

        if (!title) { await tgSend(chatId, "❗형식: /run \"제목\" profile=... steps=..."); return res.sendStatus(200); }

        await tgSend(chatId, `⏳ 실행 시작\n• title: ${title}\n• profile: ${profile}\n• steps: ${steps.join(",")}`);
        const r = await axios.post(`${req.protocol}://${req.get("host")}/content/run`, {
          profile, idea:{ title }, steps, notify
        });
        const summary = {
          trace_id: r.data.trace_id,
          have: { brief: !!r.data.brief, script: !!r.data.script, assets: !!r.data.assets },
          ms: Object.fromEntries(Object.entries(r.data?.metrics?.steps || {}).map(([k,v]) => [k, v.latency_ms]))
        };
        await tgSend(chatId, `✅ 실행 완료\n<pre>${JSON.stringify(summary, null, 2)}</pre>`, "HTML");
        return res.sendStatus(200);
      }

      // 알 수 없는 슬래시 명령
      await tgSend(chatId, "ℹ️ 지원 명령: /brief 제목, /run \"제목\" profile=... steps=...");
      return res.sendStatus(200);
    }

    // 2) 자연어 명령 처리 (슬래시 없이 온 일반 문장)
    const intent = parseIntentKo(text);
    if (!intent.title) {
      await tgSend(chatId, "❗제목을 인식하지 못했어요.\n예) \"AI 자동화 콘텐츠 전략\" 브리프 만들어줘");
      await logToSheet({ chat_id: chatId, type:"nlp_parse_fail", input_text:text, output_text:"no_title", project:PROJECT, category:"chat" });
      return res.sendStatus(200);
    }

    await tgSend(
      chatId,
      `🧠 해석 결과\n• intent: ${intent.intent}\n• title: ${intent.title}\n• steps: ${intent.steps.join(",")}\n• profile: ${intent.profile || "-"}\n• notify: ${String(intent.notify ?? "default")}`
    );

    if (intent.intent === "brief") {
      const r = await axios.post(`${req.protocol}://${req.get("host")}/content/brief`, {
        title: intent.title, style: "YouTube Shorts"
      });
      await tgSend(chatId, `✅ 브리프 완료\n<pre>${JSON.stringify(r.data.brief, null, 2)}</pre>`, "HTML");
      return res.sendStatus(200);
    }

    const runBody = {
      profile: intent.profile || "shorts_marketing_v1",
      idea: { title: intent.title },
      steps: intent.steps,
      notify: intent.notify ?? false
    };
    const r = await axios.post(`${req.protocol}://${req.get("host")}/content/run`, runBody);
    const summary = {
      trace_id: r.data.trace_id,
      have: { brief: !!r.data.brief, script: !!r.data.script, assets: !!r.data.assets },
      ms: Object.fromEntries(Object.entries(r.data?.metrics?.steps || {}).map(([k,v]) => [k, v.latency_ms]))
    };
    await tgSend(chatId, `✅ 실행 완료\n<pre>${JSON.stringify(summary, null, 2)}</pre>`, "HTML");
    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ webhook error:", e?.message);
    try {
      await tgSend(TELEGRAM_ADMIN_CHAT_ID, buildNotifyMessage({ type:"error", title:"Webhook 처리 오류", message: e?.message || "unknown"}));
    } catch {}
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
  const preset = body.profile && profiles[body.profile] ? profiles[body.profile] : {};
  const title = body?.idea?.title ?? body?.title ?? body?.topic ?? undefined;
  const ideaMerged = { ...(preset || {}), ...(body.idea || {}), ...(title ? { title } : {}) };
  return ideaMerged;
}

// 4-1) 브리프 생성
app.post("/content/brief", async (req, res) => {
  if (!requireOpenAI(res)) return;
  const t0 = Date.now();
  try {
    const idea = {
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
