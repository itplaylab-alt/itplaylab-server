// src/worker.js (NEW) - DB 접근 0, API 계약 기반 Worker
import crypto from "crypto";
import { tgSend, tg2Send } from "../services/telegramBot.js";

const NEXT_JOB_URL = process.env.NEXT_JOB_URL;
const EVENT_LOG_URL = process.env.EVENT_LOG_URL;
const JOBQUEUE_WORKER_SECRET = process.env.JOBQUEUE_WORKER_SECRET;
const EVENT_LOG_SECRET = process.env.EVENT_LOG_SECRET;
const WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

const IT2_AUTO_DECIDE_URL = process.env.IT2_AUTO_DECIDE_URL; // 선택

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 20000);
const NEXTJOB_TIMEOUT_MS = Number(process.env.NEXTJOB_TIMEOUT_MS || 15000);
const EVENT_TIMEOUT_MS = Number(process.env.EVENT_TIMEOUT_MS || 15000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms, ratio = 0.15) {
  const d = ms * ratio;
  return Math.max(0, Math.floor(ms - d + Math.random() * (2 * d)));
}

async function timedFetch(url, options, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function idem(jobId, eventType, attempt, extra = "") {
  return `${jobId}:${eventType}:${attempt}${extra ? ":" + extra : ""}`;
}

// ----------------------
// Telegram notify (기존 유지)
// ----------------------
function pickJobNamespace(job) {
  return (
    job?.params?.namespace ??
    job?.params?.meta?.namespace ??
    (job?.type === "it2_cmd" ? "it2" : "it1")
  );
}
function pickJobChatId(job) {
  return job?.params?.meta?.chat_id ?? job?.params?.meta?.chatId ?? job?.chat_id ?? null;
}
async function notifyJob(job, text) {
  const chatId = pickJobChatId(job);
  if (!chatId) return;
  const ns = pickJobNamespace(job);
  return ns === "it2" ? tg2Send(chatId, text) : tgSend(chatId, text);
}

// ----------------------
// API calls
// ----------------------
async function nextJob() {
  const res = await timedFetch(
    NEXT_JOB_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${JOBQUEUE_WORKER_SECRET}`,
      },
      body: JSON.stringify({ worker_id: WORKER_ID, capabilities: ["it1","it2"], prefetch: 1 }),
    },
    NEXTJOB_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`POST /next-job failed: ${res.status} ${await res.text().catch(()=> "")}`);
  return res.json();
}

async function postEvent(evt) {
  const res = await timedFetch(
    EVENT_LOG_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${EVENT_LOG_SECRET}`,
      },
      body: JSON.stringify(evt),
    },
    EVENT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`POST /event failed: ${res.status} ${await res.text().catch(()=> "")}`);
  return res.json().catch(() => ({ ok: true }));
}

// ----------------------
// it2 호출(Worker가 계산하지 말고 HTTP로만)
// ----------------------
async function callAutoDecide(payload) {
  if (!IT2_AUTO_DECIDE_URL) return { ok: true, skipped: true, reason: "IT2_AUTO_DECIDE_URL not set" };

  const res = await timedFetch(
    IT2_AUTO_DECIDE_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    10000
  );

  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: "IT2_HTTP_FAIL", detail: { status: res.status, json } };
  return { ok: true, data: json };
}

// ----------------------
// 실제 실행부 (여기만 너의 실제 로직으로 교체)
// ----------------------
async function runIt1(job) {
  // TODO: n8n / PowerShell / Render 등 실제 실행
  await sleep(1500 + Math.floor(Math.random() * 1500));
  return { ok: true, note: "stub_done", out: { job_id: job.id } };
}

async function runJob(jobEnvelope) {
  const job = jobEnvelope.job;
  const attempt = jobEnvelope.attempt ?? job.attempt ?? 1;
  const trace_id = job.payload?.trace_id ?? job.trace_id ?? `tr_${job.id}`;

  const baseEvt = {
    trace_id,
    job_id: job.id,
    job_type: job.type,
    worker_id: WORKER_ID,
    attempt,
  };

  const startedAt = Date.now();
  let hbSeq = 0;
  let hbTimer = null;

  try {
    await postEvent({
      ...baseEvt,
      event_type: "job.started",
      ts: new Date().toISOString(),
      idempotency_key: idem(job.id, "job.started", attempt),
      data: { status: "running" },
    });

    hbTimer = setInterval(() => {
      hbSeq += 1;
      postEvent({
        ...baseEvt,
        event_type: "job.heartbeat",
        ts: new Date().toISOString(),
        idempotency_key: idem(job.id, "job.heartbeat", attempt, String(hbSeq)),
        data: { stage: "running", elapsed_ms: Date.now() - startedAt },
      }).catch(() => {});
    }, HEARTBEAT_MS);

    let result;

    if (job.type === "it1_job" || job.type === "it1.render") {
      result = await runIt1(job);
      // 필요하면 it2 후콜
      await callAutoDecide({
        trace_id,
        job_id: job.id,
        job_type: job.type,
        ok: !!result?.ok,
        result,
      }).catch(() => {});
    } else if (job.type === "it2_cmd") {
      // it2_cmd도 Worker에서 DB 계산하지 말고 it2로 넘겨라
      const payload = job.params || job.payload || {};
      result = await callAutoDecide({ trace_id, job_id: job.id, job_type: job.type, cmd: payload.cmd, args: payload.args });
    } else {
      result = { ok: false, error: "UNKNOWN_JOB_TYPE", detail: job.type };
    }

    const latency_ms = Date.now() - startedAt;

    if (result?.ok) {
      await postEvent({
        ...baseEvt,
        event_type: "job.succeeded",
        ts: new Date().toISOString(),
        idempotency_key: idem(job.id, "job.succeeded", attempt),
        data: { output: result, latency_ms },
      });

      await notifyJob(job, `✅ 작업 완료\ntype: ${job.type}\ntrace_id: ${trace_id}\nlatency_ms: ${latency_ms}`);
    } else {
      await postEvent({
        ...baseEvt,
        event_type: "job.failed",
        ts: new Date().toISOString(),
        idempotency_key: idem(job.id, "job.failed", attempt),
        data: {
          error: { code: "PROCESS_FAIL", message: result?.error || "PROCESS_FAIL", detail: result?.detail ?? null },
          retryable: true,
          latency_ms,
        },
      });

      await notifyJob(job, `❌ 작업 실패\ntype: ${job.type}\ntrace_id: ${trace_id}\nerror: ${result?.error || "PROCESS_FAIL"}`);
    }

  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

// ----------------------
// Worker loop (Step 7 핵심)
// ----------------------
export async function runWorkerLoop() {
  if (!NEXT_JOB_URL || !EVENT_LOG_URL || !JOBQUEUE_WORKER_SECRET || !EVENT_LOG_SECRET) {
    throw new Error("Missing env: NEXT_JOB_URL, EVENT_LOG_URL, JOBQUEUE_WORKER_SECRET, EVENT_LOG_SECRET");
  }

  while (true) {
    const envelope = await nextJob();

    if (!envelope.job) {
      const wait = envelope.backoff_ms ?? 1000;
      await sleep(jitter(wait, 0.15));
      continue;
    }

    await runJob(envelope);
    await sleep(jitter(80, 0.5));
  }
}
