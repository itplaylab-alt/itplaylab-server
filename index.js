import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || "";
const JAEMINI_API_URL = process.env.JAEMINI_API_URL || "";
const JAEMINI_API_KEY = process.env.JAEMINI_API_KEY || "";

const PORT = process.env.PORT || 10000;

/** ---------------- LLM callers ---------------- **/
async function askOpenAI(text) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    { model: "gpt-4o-mini", messages: [{ role: "user", content: text }] },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return res.data?.choices?.[0]?.message?.content?.trim() || "(no response)";
}

async function askGemini(text) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const payload = { contents: [{ parts: [{ text }] }], generationConfig: { temperature: 0.7 } };
  const res = await axios.post(url, payload);
  const out = res.data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "(no response)";
  return out.trim();
}

async function askJaemini(text) {
  if (!JAEMINI_API_KEY || !JAEMINI_API_URL) throw new Error("JAEMINI config missing");
  // ⚠️ 실제 재미나이 API 스펙에 맞게 payload/headers/응답파싱을 조정하세요.
  const res = await axios.post(
    JAEMINI_API_URL,
    { messages: [{ role: "user", content: text }] },
    { headers: { Authorization: `Bearer ${JAEMINI_API_KEY}`, "Content-Type": "application/json" } }
  );
  return (
    res.data?.choices?.[0]?.message?.content ||
    res.data?.output ||
    JSON.stringify(res.data)
  );
}

/** ---------------- Engine routing & fallback ---------------- **/
const userEngine = new Map(); // chatId -> "openai"|"gemini"|"jaemini"
const available = () => [
  ...(OPENAI_API_KEY ? ["openai"] : []),
  ...(GEMINI_API_KEY ? ["gemini"] : []),
  ...(JAEMINI_API_KEY && JAEMINI_API_URL ? ["jaemini"] : []),
];
const defaultEngine = () => available()[0] || "none";

async function askLLM(engine, text) {
  if (engine === "openai") return askOpenAI(text);
  if (engine === "gemini") return askGemini(text);
  if (engine === "jaemini") return askJaemini(text);
  throw new Error("No engine configured");
}

async function askWithFallback(selected, text) {
  const engines = available();
  if (!engines.length) return "❗ 대화 엔진이 설정되지 않았습니다.";
  const start = Math.max(0, engines.indexOf(selected));
  for (let i = 0; i < engines.length; i++) {
    const eng = engines[(start + i) % engines.length];
    try { return await askLLM(eng, text); }
    catch (e) { console.error(`[${eng}] error:`, e?.response?.data || e.message); }
  }
  return "❗ 모든 엔진 호출에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

/** ---------------- Telegram handlers ---------------- **/
async function sendMsg(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text });
}

app.get("/", (_, res) => res.send("✅ ItplayLab Telegram Bot (Multi-engine) is running"));

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    if (!chatId) return res.sendStatus(200);

    if (text.startsWith("/start")) {
      const eng = defaultEngine();
      userEngine.set(chatId, eng);
      await sendMsg(chatId,
        `안녕하세요 👋 멀티엔진 봇입니다.\n` +
        `사용 가능 엔진: ${available().join(", ") || "없음"}\n\n` +
        `/engine status | /engine openai | /engine gemini | /engine jaemini`
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/engine")) {
      const sub = text.split(/\s+/)[1]?.toLowerCase();
      if (!sub || sub === "status") {
        const eng = userEngine.get(chatId) || defaultEngine();
        await sendMsg(chatId, `현재 엔진: ${eng}`);
      } else {
        const avail = available();
        if (!avail.includes(sub)) {
          await sendMsg(chatId, `사용 불가 엔진입니다. 사용 가능: ${avail.join(", ") || "없음"}`);
        } else {
          userEngine.set(chatId, sub);
          await sendMsg(chatId, `엔진이 '${sub}'로 변경되었습니다.`);
        }
      }
      return res.sendStatus(200);
    }

    // 일반 대화 → 선택 엔진으로 호출, 실패 시 폴백
    const eng = userEngine.get(chatId) || defaultEngine();
    const reply = await askWithFallback(eng, text);
    await sendMsg(chatId, reply);
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e?.response?.data || e.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));

