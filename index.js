// index.js — ITPlayLab 통합본 Hotfix (오류 최소 수정판)
// 핵심: 승인 루프 + 한글 알림 + GAS 로깅 + 대시보드 + 리비전 3회 제한 + 온디맨드 리포트
// 안정성 우선(중괄호/문자열/머지아티팩트 정리), Responses→Fallback 자동전환 포함
// 설치: npm i express axios openai ajv ajv-formats

import express from "express";
import axios from "axios";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

/* ────────────────────────────────────────────────────────────
   0) 요청 로깅 + Content-Type 확인
──────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url} ct=${req.headers["content-type"] || ""}`);
  next();
});

/* ────────────────────────────────────────────────────────────
   1) 바디 파서 (JSON)
──────────────────────────────────────────────────────────── */
app.use(express.json({ limit: "1mb", type: ["application/json"] }));

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({ ok: false, error: "invalid_json", detail: err.message });
  }
  next();
});

// 디버그 에코
app.post("/debug/echo", (req, res) => res.json({ ok: true, headers: req.headers, body: req.body }));

// ========== ENV ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const NOTIFY_LEVEL = (process.env.NOTIFY_LEVEL || "success,error,approval").split(",").map(s=>s.trim().toLowerCase());

const GAS_INGEST_URL = process.env.GAS_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 권장: Responses 모델과 Fallback 모델 분리
const OPENAI_MODEL_RESP = process.env.OPENAI_MODEL_RESP || "gpt-4.1-mini";
const OPENAI_MODEL_FALLBACK = process.env.OPENAI_MODEL_FALLBACK || "gpt-4o-mini";
const OPENAI_MODEL = process.env.OPENAI_MODEL || OPENAI_MODEL_RESP;

const PROJECT = process.env.PROJECT || "itplaylab";
const SERVICE_NAME = process.env.SERVICE_NAME || "render-bot";
const APPROVAL_MODE = String(process.env.APPROVAL_MODE || "true").toLowerCase() === "true";
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS || 3);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// OpenAI
const oa = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Optional AJV Loader (미설치여도 서버 기동)
let _ajv = null;
async function ensureAjv() {
  try {
    if (_ajv) return _ajv;
    const ajvMod = await import("ajv").catch(()=>null);
    if (!ajvMod?.default) return null;
    const addFormatsMod = await import("ajv-formats").catch(()=>null);
    const Ajv = ajvMod.default;
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (addFormatsMod?.default) addFormatsMod.default(ajv);
    _ajv = ajv;
    return _ajv;
  } catch(e) { console.warn("[AJV] dynamic load failed:", e.message); return null; }
}

// ========== 공통 유틸 ==========
const genTraceId = () => `trc_${crypto.randomBytes(4).toString("hex")}`;
const nowISO = () => new Date().toISOString();
const fmtTsKR = (d=new Date()) => d.toLocaleString("ko-KR", { timeZone:"Asia/Seoul", hour12:false });
const fmtTrace = (id) => `trace_id: <code>${id}</code>`;
const fmtTitle = (t) => `제목: <b>${t}</b>`;

const STEP_LABELS = { brief:"브리프", script:"스크립트", assets:"에셋/메타" };
const labelStep = (s) => STEP_LABELS[s] || s;

const DEFAULT_CHECKLIST = [
  { key:"accuracy", label:"내용 정확성" },
  { key:"brand", label:"브랜드 톤/보이스" },
  { key:"policy", label:"정책/저작권 준수" },
  { key:"length", label:"길이/템포" },
  { key:"thumbnail", label:"썸네일 적합성" },
];
const labelOf = (key) => DEFAULT_CHECKLIST.find(i=>i.key===key)?.label || key;
function parseChecks(text){
  const m = text.match(/checks\s*=\s*(\[[^\]]+\]|[^\s]+)/i); if(!m) return [];
  const raw = m[1].startsWith("[")? m[1].slice(1,-1): m[1];
  return raw.split(",").map(s=>s.trim()).filter(Boolean);
}
function approverName(from){
  const p=[]; if(from?.first_name)p.push(from.first_name); if(from?.last_name)p.push(from.last_name);
  return p.join(" ") || from?.username || `user_${from?.id||"unknown"}`;
}

// GAS 로깅
async function logToSheet(payload){
  const t0 = Date.now();
  if(!GAS_INGEST_URL) return { ok:false, skipped:true };
  try {
    await axios.post(GAS_INGEST_URL, { token: INGEST_TOKEN, contents: JSON.stringify({
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
      trace_id: payload.trace_id || "",
      step: payload.step || "",
      ok: typeof payload.ok === "boolean" ? payload.ok : "",
      error: payload.error || "",
      provider: payload.provider || "",
      revision_count: typeof payload.revision_count === "number" ? payload.revision_count : "",
    }) });
    return { ok:true, latency_ms: Date.now() - t0 };
  } catch(e){ console.error("❌ GAS log fail:", e?.message); return { ok:false, error:e?.message, latency_ms: Date.now()-t0 }; }
}

// 텔레그램 전송/콜백
async function tgSend(chatId, text, parse_mode="HTML", extra={}){
  if(!TELEGRAM_TOKEN || !chatId) return;
  try { return await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode, disable_web_page_preview:true, ...extra }); }
  catch(e){ console.error("Telegram send error:", e?.message); }
}
async function tgAnswerCallback(id, text="", show_alert=false){
  try { return await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id:id, text, show_alert }); }
  catch(e){ console.error("Telegram answerCallbackQuery error:", e?.message); }
}

const shouldNotify = (kind) => NOTIFY_LEVEL.includes(kind);
function buildNotifyMessage({ type, title, message }){
  const ts = fmtTsKR();
  if(type==="success") return `✅ <b>${title||"처리 완료"}</b>\n${message||""}\n\n🕒 ${ts}`;
  if(type==="error")   return `❌ <b>${title||"오류 발생"}</b>\n${message||""}\n\n🕒 ${ts}`;
  if(type==="approval")return `🟡 <b>${title||"승인 요청"}</b>\n${message||""}\n\n🕒 ${ts}`;
  return `ℹ️ <b>${title||"알림"}</b>\n${message||""}\n\n🕒 ${ts}`;
}
function requireOpenAI(res){
  if(!OPENAI_API_KEY){ res.status(500).json({ ok:false, error:"OPENAI_API_KEY missing" }); return false; }
  return true;
}

// ========== 헬스체크 ==========
app.get("/test/healthcheck", (req,res)=> res.json({
  ok:true, service:"Render → GAS Bridge + Notify + Approval Loop",
  status:"Render is alive ✅", timestamp:new Date().toISOString(),
  approval_mode:APPROVAL_MODE
}));
app.get("/test/send-log", async (req,res)=>{
  try{
    const r = await logToSheet({ type:"test_log", input_text:"Render → GAS 연결 테스트", output_text:"✅ Render 서버에서 로그 전송 성공!", project:PROJECT, category:"system" });
    res.json({ ok:true, sent_to_gas:true, ...r });
  }catch(e){ res.status(500).json({ ok:false, error:e?.message }); }
});
app.get("/test/notify", async (req,res)=>{
  try{
    const type=String(req.query.type||"success").toLowerCase();
    const title=String(req.query.title||"");
    const message=String(req.query.message||"");
    if(!shouldNotify(type)) return res.json({ ok:true, sent:false, reason:"filtered_by_NOTIFY_LEVEL" });
    const text=buildNotifyMessage({type,title,message});
    await tgSend(TELEGRAM_ADMIN_CHAT_ID, text);
    await logToSheet({ type:`notify_${type}`, input_text:title, output_text:message, project:PROJECT, category:"notify", note:"notify_test" });
    res.json({ ok:true, sent:true, type });
  }catch(e){ console.error("❌ notify error:", e?.message); res.status(500).json({ ok:false, error:e?.message }); }
});

// ========== 대시보드 ==========
function getTraceSnapshot(t){
  return { trace_id:t.id, title:t.title, status:t.status, current_step:t.steps[t.currentIndex]||null, current_index:t.currentIndex, steps:t.steps, revisionCount:t.revisionCount||0, createdAt:t.createdAt };
}
function groupActive(limitPerBucket=20){
  const buckets={ running:[], paused:[], manual_review:[], completed:[], rejected:[] };
  for(const t of traces.values()){
    const snap=getTraceSnapshot(t);
    if(buckets[snap.status]) buckets[snap.status].push(snap);
    else buckets.paused.push(snap);
  }
  for(const k of Object.keys(buckets)){
    buckets[k].sort((a,b)=>(a.createdAt||"").localeCompare(b.createdAt)).reverse();
    buckets[k]=buckets[k].slice(0,limitPerBucket);
  }
  const counts=Object.fromEntries(Object.entries(buckets).map(([k,v])=>[k,v.length]));
  const total=Array.from(traces.keys()).length;
  return { total, counts, buckets };
}
app.get("/dashboard/active", (req,res)=>{
  const limit=Math.max(1, Math.min(100, Number(req.query.limit||20)));
  res.json({ ok:true, ...groupActive(limit) });
});

// ========== OpenAI 공용 호출자 (Responses → Fallback) ==========
async function callOpenAIJson({ system, user, schema, schemaName="itplaylab_schema" }){
  const started=Date.now(); let provider="responses"; let txt=""; let parsed=null;
  try{
    const resp = await oa.responses.create({
      model: OPENAI_MODEL || OPENAI_MODEL_RESP,
      messages:[ {role:"system", content:system}, {role:"user", content:user} ],
      response_format:{ type:"json_schema", json_schema:{ name:schemaName, strict:true, schema } },
      temperature:0.2,
    });
    txt = resp?.output_text || resp?.output?.[0]?.content?.[0]?.text || "";
    parsed = txt ? JSON.parse(txt) : null;
  }catch(e){
    provider="chat.completions";
    try{
      const schemaHint = `다음 JSON 스키마에 맞춰 정확히 JSON만 출력하세요. 추가 설명 금지.\n${JSON.stringify(schema)}`;
      const comp = await oa.chat.completions.create({
        model: OPENAI_MODEL_FALLBACK,
        response_format:{ type:"json_object" },
        messages:[ {role:"system", content:`${system}\n\n${schemaHint}`}, {role:"user", content:user} ],
        temperature:0.2,
      });
      txt = comp?.choices?.[0]?.message?.content || "";
      parsed = txt ? JSON.parse(txt) : null;
    }catch(e2){
      return { ok:false, error:`openai_call_failed: ${e2?.message||e?.message}`, provider, latency_ms:Date.now()-started };
    }
  }
  const validator = await ensureAjv();
  if(!validator) return { ok:!!parsed, data:parsed, provider, latency_ms:Date.now()-started, errors:[], raw_text:txt };
  const validate = validator.compile(schema);
  const valid = !!parsed && validate(parsed);
  return { ok:!!valid, data:parsed, provider, latency_ms:Date.now()-started, errors: valid?[]:validate.errors, raw_text:txt };
}

// ========== 스키마 ==========
const SCHEMA_BRIEF = {
  type:"object", additionalProperties:false,
  properties:{
    brief_id:{type:"string"}, idea_id:{type:"string"}, goal:{type:"string"},
    key_points:{type:"array", items:{type:"string"}}, hook:{type:"string"},
    outline:{ type:"array", items:{ type:"object", properties:{ sec:{type:"number"}, beat:{type:"string"} }, required:["sec","beat"] } },
    channels:{type:"array", items:{type:"string"}}, due_date:{type:"string"}, owner:{type:"string"}
  },
  required:["brief_id","goal","outline"]
};
const SCHEMA_SCRIPT = {
  type:"object", additionalProperties:false,
  properties:{
    brief_id:{type:"string"}, lang:{type:"string"},
    shots:{ type:"array", items:{ type:"object",
      properties:{ t_start:{type:"number"}, t_end:{type:"number"}, narration:{type:"string"}, overlay_text:{type:"string"}, asset_hint:{type:"string"} },
      required:["t_start","t_end","narration"]
    } }
  },
  required:["brief_id","shots"]
};
const SCHEMA_ASSETS = {
  type:"object", additionalProperties:false,
  properties:{
    brief_id:{type:"string"}, thumbnail_prompt:{type:"string"},
    titles:{type:"array", items:{type:"string"}}, descriptions:{type:"array", items:{type:"string"}}, hashtags:{type:"array", items:{type:"string"}}
  },
  required:["brief_id","thumbnail_prompt","titles"]
};

// ========== OpenAI 작업자 ==========
async function aiBrief(idea){ return await callOpenAIJson({ system:"너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 JSON으로만 작성하라.", user: JSON.stringify(idea), schema: SCHEMA_BRIEF, schemaName:"content_brief" }); }
async function aiScript(brief){ return await callOpenAIJson({ system:"너는 숏폼 스크립트라이터다. 총 60초, 샷당 3~6초, 문장은 짧고 명확하게. JSON만 출력.", user: JSON.stringify(brief), schema: SCHEMA_SCRIPT, schemaName:"content_script" }); }
async function aiAssets({ brief_id, script }){ return await callOpenAIJson({ system:"너는 유튜브 운영자다. 썸네일 프롬프트와 제목/설명을 생성하라. 제목 3안, 해시태그 5개. JSON만 출력.", user: JSON.stringify({ brief_id, script }), schema: SCHEMA_ASSETS, schemaName:"content_assets" }); }

// ========== 상태 저장소 ==========
const traces = new Map();

// ========== 공정 실행기 ==========
async function executeStep(trace, stepName){
  const startedAt = nowISO(); let latency_ms=0; let provider="";
  try{
    let r;
    if(stepName==="brief"){ r=await aiBrief({ title:trace.title, profile:trace.profile }); trace.lastOutput.brief=r.data; }
    else if(stepName==="script"){ r=await aiScript(trace.lastOutput.brief); trace.lastOutput.script=r.data; }
    else if(stepName==="assets"){ r=await aiAssets({ brief_id: trace.lastOutput.brief?.brief_id, script: trace.lastOutput.script }); trace.lastOutput.assets=r.data; }
    else { throw new Error(`unknown step: ${stepName}`); }

    latency_ms=r.latency_ms; provider=r.provider;
    if(!r.ok){ const reason = r.errors?.[0]?.message || r.error || "schema_validation_failed"; throw new Error(reason); }

    trace.history.push({ step:stepName, ok:true, latency_ms, provider, startedAt, finishedAt:nowISO() });
    await logToSheet({ type:`content_${stepName}`, input_text:trace.title, output_text:trace.lastOutput[stepName], project:PROJECT, category:stepName, note:`trace=${trace.id}`, latency_ms, trace_id:trace.id, step:stepName, ok:true, provider });

    if(shouldNotify("success")){
      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `단계: <b>${labelStep(stepName)}</b>`, `지연시간: <code>${latency_ms}ms</code>`, `엔진: <code>${provider}</code>` ].join("\n");
      await tgSend(trace.chatId, buildNotifyMessage({ type:"success", title:`${labelStep(stepName)} 완료`, message:msg }));
    }
    return { ok:true, latency_ms };
  }catch(e){
    const error=e?.message||String(e);
    trace.history.push({ step:stepName, ok:false, latency_ms, provider, error, startedAt, finishedAt:nowISO() });
    await logToSheet({ type:`content_${stepName}`, input_text:trace.title, output_text:{ error }, project:PROJECT, category:stepName, note:`trace=${trace.id}`, latency_ms, trace_id:trace.id, step:stepName, ok:false, error, provider });
    if(shouldNotify("error")){
      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `단계: <b>${labelStep(stepName)}</b>`, `사유: <code>${error}</code>`, provider?`엔진: <code>${provider}</code>`:"" ].filter(Boolean).join("\n");
      await tgSend(trace.chatId, buildNotifyMessage({ type:"error", title:`${labelStep(stepName)} 실패`, message:msg }));
    }
    throw e;
  }
}
const getNextStep = (trace) => (trace.currentIndex + 1 < trace.steps.length ? trace.steps[trace.currentIndex + 1] : null);

// 리비전(3회 제한)
function buildRevisionPrompts(stepName, trace, reason="", checks=[]){
  const previous = trace.lastOutput?.[stepName] || {};
  const feedback = { reason, checks, title:trace.title, profile:trace.profile };
  if(stepName==="brief")  return { system:"너는 콘텐츠 프로듀서다. 이전 브리프를 피드백에 맞게 최소 수정. JSON만 출력.", user: JSON.stringify({ mode:"revision", step:stepName, previous, feedback }), schema:SCHEMA_BRIEF,  schemaName:"content_brief_revision" };
  if(stepName==="script") return { system:"너는 숏폼 스크립트라이터다. 총60초 원칙 유지하며 피드백 반영. JSON만 출력.", user: JSON.stringify({ mode:"revision", step:stepName, previous, brief:trace.lastOutput?.brief,  feedback }), schema:SCHEMA_SCRIPT, schemaName:"content_script_revision" };
  if(stepName==="assets") return { system:"너는 유튜브 운영자다. 메타를 피드백에 맞게 개선. JSON만 출력.", user: JSON.stringify({ mode:"revision", step:stepName, previous, script:trace.lastOutput?.script, feedback }), schema:SCHEMA_ASSETS, schemaName:"content_assets_revision" };
  throw new Error(`unknown step for revision: ${stepName}`);
}
async function redoCurrentStepWithRevision(trace, { reason="", checks=[], by="inline" }={}){
  const stepName = trace.steps[trace.currentIndex];
  if(trace.revisionCount >= MAX_REVISIONS){
    trace.status = "manual_review";
    const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `⚠️ 리비전 한도(${MAX_REVISIONS}) 초과 — 수동 검토로 전환합니다.` ].join("\n");
    await tgSend(trace.chatId, buildNotifyMessage({ type:"error", title:"리비전 한도 초과", message:msg }));
    await logToSheet({ type:"revision_limit_reached", input_text:trace.title, output_text:{ last_output: trace.lastOutput?.[stepName]||{}, reason, checks }, project:PROJECT, category:"revision", note:`trace=${trace.id}`, trace_id:trace.id, step:stepName, ok:false, error:"revision_limit_reached", revision_count:trace.revisionCount });
    return;
  }
  trace.revisionCount += 1;
  const startedAt = nowISO();
  const r = await callOpenAIJson(buildRevisionPrompts(stepName, trace, reason, checks));
  const latency_ms = r.latency_ms; if(!r.ok) throw new Error(r.errors?.[0]?.message||r.error||"revision_failed");
  trace.lastOutput[stepName] = r.data;
  trace.history.push({ step:`${stepName}_revision_${trace.revisionCount}`, ok:true, latency_ms, provider:r.provider, startedAt, finishedAt:nowISO(), reason, by });
  await logToSheet({ type:`revision_${stepName}`, input_text:trace.title, output_text:r.data, project:PROJECT, category:"revision", note:`trace=${trace.id}`, latency_ms, trace_id:trace.id, step:stepName, ok:true, provider:r.provider, error:"", revision_count:trace.revisionCount });
  if(shouldNotify("success")){
    const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `수정 단계: <b>${labelStep(stepName)}</b>`, `수정 회차: <b>${trace.revisionCount}</b> / ${MAX_REVISIONS}`, `지연시간: <code>${latency_ms}ms</code>`, `엔진: <code>${r.provider}</code>` ].join("\n");
    await tgSend(trace.chatId, buildNotifyMessage({ type:"success", title:`${labelStep(stepName)} 수정 완료`, message:msg }));
  }
  await pauseForApproval(trace);
}

async function pauseForApproval(trace){
  const next = getNextStep(trace);
  if(!next){
    trace.status="completed";
    if(shouldNotify("success")){
      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `진행 상태: <b>모든 단계 완료</b>` ].join("\n");
      await tgSend(trace.chatId, buildNotifyMessage({ type:"success", title:"출고 완료", message:msg }));
    }
    return;
  }
  trace.status="paused";
  if(shouldNotify("approval")){
    const nextK = labelStep(next);
    const checklistLine = DEFAULT_CHECKLIST.map(i=>`- ${i.label} (${i.key})`).join("\n");
    const revLine = trace.revisionCount>0 ? `수정 회차: <b>${trace.revisionCount}</b> / ${MAX_REVISIONS}` : `수정 회차: 0 / ${MAX_REVISIONS}`;
    const msg=[
      fmtTitle(trace.title),
      fmtTrace(trace.id),
      revLine,
      `다음 단계: <b>${nextK}</b>`,
      "",
      "검수 체크리스트:",
      checklistLine,
      "",
      "버튼 또는 명령 사용:",
      `<code>/approve ${trace.id} step=${next} checks=accuracy,policy</code>`,
      `<code>/reject ${trace.id} reason="톤 수정 필요" checks=brand,length</code>`,
      `상태: <code>/status ${trace.id}</code>`
    ].join("\n");
    await tgSend(trace.chatId, buildNotifyMessage({ type:"approval", title:"다음 단계 승인 대기", message:msg }));
  }
}

async function runFromCurrent(trace){
  trace.status="running";
  const stepName = trace.steps[trace.currentIndex];
  await executeStep(trace, stepName);
  if(APPROVAL_MODE){
    await pauseForApproval(trace);
  }else{
    trace.currentIndex += 1;
    if(trace.currentIndex < trace.steps.length) await runFromCurrent(trace);
    else{
      trace.status="completed";
      if(shouldNotify("success")){
        const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `진행 상태: <b>모든 단계 완료</b>` ].join("\n");
        await tgSend(trace.chatId, buildNotifyMessage({ type:"success", title:"출고 완료", message:msg }));
      }
    }
  }
}

// ========== 파서 ==========
function parseFreeText(text){
  const lower=text.toLowerCase(); let steps=["brief","script","assets"];
  if(lower.includes("브리프")) steps=["brief"];
  if(lower.includes("스크립트")) steps=["script"];
  if(lower.includes("에셋")||lower.includes("메타")) steps=["assets"];
  const title = text.replace(/(브리프|스크립트|에셋|만들어줘|전체|전부|메타|전략)/g, "").trim()||"무제";
  const profileMatch = text.match(/profile=([\w-]+)/i);
  const profile = profileMatch?profileMatch[1]:"-";
  return { title, steps, profile };
}
function parseTelegramCommand(text){
  const [cmd, idOrText, ...rest] = text.trim().split(/\s+/);
  const trace_id = idOrText && idOrText.startsWith("trc_") ? idOrText : undefined;
  const argsText = rest.join(" ");
  const stepMatch = argsText.match(/step=([a-z]+)/i);
  const reasonMatch = argsText.match(/reason=("([^"]+)"|([^\s]+))/i);
  const reason = reasonMatch ? (reasonMatch[2]||reasonMatch[3]) : undefined;
  const step = stepMatch ? stepMatch[1] : undefined;
  return { cmd, trace_id, step, reason };
}

// ========== REST 단일 스텝 ==========
app.post("/content/brief", async (req,res)=>{
  if(!requireOpenAI(res))return;
  const t0=Date.now();
  try{
    const idea=req.body||{};
    if(!idea.title) return res.status(400).json({ ok:false, error:"title required" });
    const r=await aiBrief(idea);
    await logToSheet({ type:"content_brief", input_text:idea.title, output_text:r.data, project:PROJECT, category:"brief", note:"via /content/brief", latency_ms:r.latency_ms, ok:r.ok, provider:r.provider });
    res.json({ ok:r.ok, latency_ms:Date.now()-t0, brief:r.data });
  }catch(e){ console.error("openai brief error:", e?.message||e); res.status(500).json({ ok:false, error:"openai_error" }); }
});
app.post("/content/script", async (req,res)=>{
  if(!requireOpenAI(res))return;
  const t0=Date.now();
  try{
    const brief=req.body||{};
    const r=await aiScript(brief);
    await logToSheet({ type:"content_script", input_text:brief.brief_id||"", output_text:r.data, project:PROJECT, category:"content", note:"via /content/script", latency_ms:r.latency_ms, ok:r.ok, provider:r.provider });
    res.json({ ok:r.ok, latency_ms:Date.now()-t0, script:r.data });
  }catch(e){ console.error("openai script error:", e?.message||e); res.status(500).json({ ok:false, error:"openai_error" }); }
});
app.post("/content/assets", async (req,res)=>{
  if(!requireOpenAI(res))return;
  const t0=Date.now();
  try{
    const { brief_id, script } = req.body||{};
    const r=await aiAssets({ brief_id, script });
    await logToSheet({ type:"content_assets", input_text:brief_id||"", output_text:r.data, project:PROJECT, category:"asset", note:"via /content/assets", latency_ms:r.latency_ms, ok:r.ok, provider:r.provider });
    res.json({ ok:r.ok, latency_ms:Date.now()-t0, assets:r.data });
  }catch(e){ console.error("openai assets error:", e?.message||e); res.status(500).json({ ok:false, error:"openai_error" }); }
});

// ========== /content/run ==========
app.post("/content/run", async (req,res)=>{
  if(!requireOpenAI(res))return;
  const started=Date.now();
  const { title, steps=["brief","script","assets"], profile="-", chatId=TELEGRAM_ADMIN_CHAT_ID } = req.body||{};
  if(!title) return res.status(400).json({ ok:false, error:"title required" });

  const trace_id = genTraceId();
  const trace = { id:trace_id, createdAt:nowISO(), chatId, title, profile, steps, currentIndex:0, approvalMode:APPROVAL_MODE, history:[], lastOutput:{}, status:"initialized", revisionCount:0 };
  traces.set(trace_id, trace);

  try{
    await runFromCurrent(trace);
    res.json({ ok:true, latency_ms:Date.now()-started, trace_id, step:trace.steps[trace.currentIndex], status:trace.status });
  }catch(e){
    res.status(500).json({ ok:false, latency_ms:Date.now()-started, trace_id, step:trace.steps[trace.currentIndex], error:String(e?.message||e) });
  }
});

// ========== 승인 컨트롤러 ==========
app.post("/approve", async (req,res)=>{
  const { trace_id, step, checks=[], by="api" } = req.body||{};
  const trace = traces.get(trace_id);
  if(!trace) return res.status(404).json({ ok:false, error:"trace not found", trace_id });

  const expectedNext = getNextStep(trace);
  if(step && expectedNext && step!==expectedNext){
    return res.status(400).json({ ok:false, error:`unexpected step. expected: ${expectedNext}`, trace_id });
  }

  if(trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;

  await logToSheet({ type:"approval_approve", input_text:trace.title, output_text:{ by, checks }, project:PROJECT, category:"approval", note:`trace=${trace.id}`, trace_id, step:trace.steps[trace.currentIndex], ok:true });

  try{
    await runFromCurrent(trace);
    return res.json({ ok:true, trace_id, status:trace.status, step:trace.steps[trace.currentIndex] });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e), trace_id });
  }
});

app.post("/reject", async (req,res)=>{
  const { trace_id, reason="", checks=[], by="api" } = req.body||{};
  const trace = traces.get(trace_id);
  if(!trace) return res.status(404).json({ ok:false, error:"trace not found", trace_id });
  trace.status="rejected"; trace.rejectReason=reason;

  await logToSheet({ type:"approval_reject", input_text:trace.title, output_text:{ by, reason, checks }, project:PROJECT, category:"approval", note:`trace=${trace.id}`, trace_id, step:trace.steps[trace.currentIndex], ok:false, error:`REJECTED: ${reason}` });

  if(shouldNotify("approval")){
    const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `진행 상태: <b>반려</b>`, `반려자: <b>${by}</b>`, `사유: <code>${reason||"-"}</code>`, checks.length?`체크: ${checks.map(k=>labelOf(k)).join(", ")}`:"체크: -" ].join("\n");
    await tgSend(trace.chatId, buildNotifyMessage({ type:"error", title:"반려 처리됨", message:msg }));
  }
  res.json({ ok:true, trace_id, status:trace.status });
});

app.get("/status/:trace_id", (req,res)=>{
  const trace = traces.get(req.params.trace_id);
  if(!trace) return res.status(404).json({ ok:false, error:"trace not found", trace_id:req.params.trace_id });
  res.json({ ok:true, latency_ms:0, trace_id:trace.id, status:trace.status, current_index:trace.currentIndex, steps:trace.steps, history:trace.history, last_output_keys:Object.keys(trace.lastOutput||{}) });
});

// 요약 리포트(요청 시)
function buildSummaryReport(trace){
  const success=trace.history.filter(h=>h.ok).length;
  const fail=trace.history.filter(h=>!h.ok).length;
  const vals=trace.history.map(h=>Number(h.latency_ms||0)).filter(v=>v>0);
  const avgLatency=vals.length? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):0;
  const stepsMark = trace.steps.map((s,idx)=> idx<trace.currentIndex?`✔ ${labelStep(s)}`:(idx===trace.currentIndex?`⏳ ${labelStep(s)}`:`… ${labelStep(s)}`)).join(" → ");
  const outKeys = Object.keys(trace.lastOutput||{});
  return [
    fmtTitle(trace.title),
    fmtTrace(trace.id),
    `상태: <b>${trace.status}</b> (수정 회차: ${trace.revisionCount}/${MAX_REVISIONS})`,
    `진행: ${stepsMark}`,
    `성공/실패: ${success}/${fail}`,
    `평균 지연: ${avgLatency}ms`,
    `산출물: ${outKeys.length? outKeys.join(', '): '-'}`
  ].join("\n");
}

// ========== Telegram Webhook ==========
app.post("/telegram/webhook", async (req,res)=>{
  try{
    const message = req.body?.message;
    const cq = req.body?.callback_query;
    if(cq){ await tgAnswerCallback(cq.id, "확인"); return res.json({ ok:true }); }
    if(!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text.trim();

    // 승인
    if(text.startsWith("/approve") || text.startsWith("/승인")){
      const { trace_id, step } = parseTelegramCommand(text);
      const checks = parseChecks(text);
      const trace = trace_id && traces.get(trace_id);
      if(!trace){ await tgSend(chatId, `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`); return res.json({ ok:true }); }
      const expectedNext = getNextStep(trace);
      if(step && expectedNext && step!==expectedNext){ await tgSend(chatId, `예상 단계와 다릅니다. expected: ${expectedNext}`); return res.json({ ok:true }); }
      if(trace.currentIndex + 1 < trace.steps.length) trace.currentIndex += 1;

      const approvedBy = approverName(message.from);
      await logToSheet({ type:"approval_approve", input_text:trace.title, output_text:{ by:approvedBy, checks }, project:PROJECT, category:"approval", note:`trace=${trace.id}`, trace_id:trace.id, step:trace.steps[trace.currentIndex], ok:true });
      await runFromCurrent(trace);

      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `승인자: <b>${approvedBy}</b>`, checks.length?`체크: ${checks.map(k=>labelOf(k)).join(", ")}`:"체크: -", `상태: <b>${trace.status}</b>` ].join("\n");
      await tgSend(chatId, buildNotifyMessage({ type:"success", title:"승인 처리됨", message:msg }));
      return res.json({ ok:true });
    }

    // 반려
    if(text.startsWith("/reject") || text.startsWith("/반려")){
      const { trace_id, reason="" } = parseTelegramCommand(text);
      const checks = parseChecks(text);
      const trace = trace_id && traces.get(trace_id);
      if(!trace){ await tgSend(chatId, `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`); return res.json({ ok:true }); }
      trace.status="rejected"; trace.rejectReason=reason;
      const rejectedBy = approverName(message.from);

      await logToSheet({ type:"approval_reject", input_text:trace.title, output_text:{ by:rejectedBy, reason, checks }, project:PROJECT, category:"approval", note:`trace=${trace.id}`, trace_id:trace.id, step:trace.steps[trace.currentIndex], ok:false, error:`REJECTED: ${reason}` });

      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `진행 상태: <b>반려</b>`, `반려자: <b>${rejectedBy}</b>`, `사유: <code>${reason||"-"}</code>`, checks.length?`체크: ${checks.map(k=>labelOf(k)).join(", ")}`:"체크: -" ].join("\n");
      await tgSend(chatId, buildNotifyMessage({ type:"error", title:"반려 처리됨", message:msg }));
      return res.json({ ok:true });
    }

    // 상태
    if(text.startsWith("/status") || text.startsWith("/상태")){
      const { trace_id } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);
      if(!trace){ await tgSend(chatId, `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`); return res.json({ ok:true }); }
      const hist = trace.history.map(h=>`${labelStep(h.step)}:${h.ok?"✅":"❌"}(${h.latency_ms??0}ms/${h.provider||"-"})`).join(" → ");
      const msg=[ fmtTitle(trace.title), fmtTrace(trace.id), `진행 기록: ${hist || "-"}`, `현재 위치: index ${trace.currentIndex}/${trace.steps.length}`, `상태: <b>${trace.status}</b>` ].join("\n");
      await tgSend(chatId, msg, "HTML");
      return res.json({ ok:true });
    }

    // 리포트 (요청 시)
    if(text.startsWith("/report") || text.startsWith("/리포트")){
      const { trace_id } = parseTelegramCommand(text);
      const trace = trace_id && traces.get(trace_id);
      if(!trace){ await tgSend(chatId, `해당 작업을 찾을 수 없습니다.\n${fmtTrace(trace_id)}`); return res.json({ ok:true }); }
      await tgSend(chatId, buildSummaryReport(trace), "HTML");
      return res.json({ ok:true });
    }

    // 자연어 요청 → 통합 실행
    if(!text.startsWith("/")){
      const { title, steps, profile } = parseFreeText(text);
      const trace_id = genTraceId();
      const trace = { id:trace_id, createdAt:nowISO(), chatId, title, profile, steps, currentIndex:0, approvalMode:APPROVAL_MODE, history:[], lastOutput:{}, status:"initialized", revisionCount:0 };
      traces.set(trace_id, trace);
      await tgSend(chatId, buildNotifyMessage({ type:"success", title:"요청 접수", message:`${fmtTrace(trace_id)}` }));
      try{ await runFromCurrent(trace); }catch(e){}
      await logToSheet({ type:"telegram_text", input_text:text, output_text:{ title, steps, profile, chatId }, project:PROJECT, category:"chat", note:`trace=${trace_id}`, trace_id });
      return res.json({ ok:true });
    }

    // 기타
    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");
    return res.json({ ok:true });
  }catch(e){
    console.error("❌ /telegram/webhook error:", e?.message);
    if(shouldNotify("error")){
      try{ await tgSend(TELEGRAM_ADMIN_CHAT_ID, buildNotifyMessage({ type:"error", title:"Webhook 처리 오류", message:e?.message||"unknown" })); }catch{}
    }
    return res.sendStatus(500);
  }
});

// 기본 루트 웹훅(에코)
app.post("/", async (req,res)=>{
  try{
    const message=req.body?.message;
    if(!message||!message.text) return res.sendStatus(200);
    const chatId=message.chat.id; const text=message.text;
    await tgSend(chatId, `당신이 보낸 메시지: ${text}`, "HTML");
    await logToSheet({ chat_id:chatId, username:message.from?.username||"", type:"telegram_text", input_text:text, output_text:`당신이 보낸 메시지: ${text}`, project:PROJECT, category:"chat", note:"root webhook" });
    res.sendStatus(200);
  }catch(e){
    console.error("❌ webhook error:", e?.message);
    if(shouldNotify("error")){
      try{ await tgSend(TELEGRAM_ADMIN_CHAT_ID, buildNotifyMessage({ type:"error", title:"Webhook 처리 오류", message:e?.message||"unknown" })); }catch{}
    }
    res.sendStatus(500);
  }
});

// ========== START ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT} (approval_mode=${APPROVAL_MODE})`));
