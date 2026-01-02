// src/worker.js (FINAL) - DB 접근 0, API 계약 기반 Worker
// Node 18+ / ESM
// ✅ /next-job: claim된 job 1개 받기
// ✅ /event: event_log 기록 전담 (idempotency_key 필수)
// ✅ Worker는 DB 직접 접근 ❌
// ✅ backoff_ms 준수 + jitter
// ✅ heartbeat + graceful shutdown
//
// Env (필수)
// - NEXT_JOB_URL
// - EVENT_LOG_URL
// - JOBQUEUE_WORKER_SECRET
// - EVENT_LOG_SECRET
//
// Env (선택)
// - WORKER_ID
// - HEARTBEAT_MS (default 20000)
// - NEXTJOB_TIMEOUT_MS (default 15000)
// - EVENT_TIMEOUT_MS (default 15000)
// - WORKER_CAPABILITIES (csv, default "it1,it2")  ex) "it1,video"
// - WORKER_NAMESPACE_ALLOW (csv)
// - WORKER_TYPE_ALLOW (csv)
// - WORKER_LABEL_ALLOW (csv)
// - WORKER_LABEL_DENY (csv)
// - IT2_AUTO_DECIDE_URL (it1 결과 후콜용)
// - IT2_CMD_URL (it2_cmd 실행용: 별도 서비스/엔드포인트)
// - LOOP_ERROR_BACKOFF_MS (default 3000)
// - LOOP_ERROR_BACKOFF_MAX_MS (default 30000)

import { tgSend, tg2Send } from "../services/telegramBot.js";

// ----------------------
// env
// ----------------------
const NEXT_JOB_URL = process.env.NEXT_JOB_URL;
const EVENT_LOG_URL = process.env.EVENT_LOG_URL;
const JOBQUEUE_WORKER_SECRET = process.env.JOBQUEUE_WORKER_SECRET;
const EVENT_LOG_SECRET = process.env.EVENT_LOG_SECRET;

const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(16).slice(2, 8)}`;

const IT2_AUTO_DECIDE_URL = process.env.IT2_AUTO_DECIDE_URL || ""; // it1 결과 후콜(선택)
const IT2_CMD_URL = process.env.IT2_CMD_URL || ""; // it2_cmd 실행(선택)

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 20000);
const NEXTJOB_TIMEOUT_MS = Number(process.env.NEXTJOB_TIMEOUT_MS || 15000);
const EVENT_TIMEOUT_MS = Number(process.env.EVENT_TIMEOUT_MS || 15000);

const LOOP_ERROR_BACKOFF_MS = Number(process.env.LOOP_ERROR_BACKOFF_MS || 3000);
const LOOP_ERROR_BACKOFF_MAX_MS = Number(process.env.LOOP_ERROR_BACKOFF_MAX_MS || 30000);

// Worker matching filters (env -> request body)
const WORKER_CAPABILITIES = (process.env.WORKER_CAPABILITIES || "it1,it2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WORKER_NAMESPACE_ALLOW = (process.env.WORKER_NAMESPACE_ALLOW || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WORKER_TYPE_ALLOW = (process.env.WORKER_TYPE_ALLOW || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WORKER_LABEL_ALLOW = (process.env.WORKER_LABEL_ALLOW || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WORKER_LABEL_DENY = (process.env.WORKER_LABEL_DENY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ----------------------
// utils
// ----------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
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

function nowISO() {
  return new Date().toISOString();
}

function pickTraceId(job) {
  // job_queue 기준: trace_id 컬럼 + params.trace_id도 존재 가능
  return (
    job?.trace_id ||
    job?.params?.trace_id ||
    job?.params?.meta?.trace_id ||
    (job?.id ? `tr_${job.id}` : "no-trace")
  );
}

// ----------------------
// Telegram notify (기존 유지)
// ----------------------
function pickJobNamespace(job) {
  return job?.params?.namespace ?? job?.params?.meta?.namespace ?? (job?.type === "it2_cmd" ? "it2" : "it1");
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
  const body = {
    worker_id: WORKER_ID,
    capabilities: WORKER_CAPABILITIES,
    prefetch: 1,
  };

  // 선택 필터(서버 /next-job 스펙과 동일)
  if (WORKER_NAMESPACE_ALLOW.length) body.namespace_allow = WORKER_NAMESPACE_ALLOW;
  if (WORKER_TYPE_ALLOW.length) body.type_allow = WORKER_TYPE_ALLOW;
  if (WORKER_LABEL_ALLOW.length) body.label_allow = WORKER_LABEL_ALLOW;
  if (WORKER_LABEL_DENY.length) body.label_deny = WORKER_LABEL_DENY;

  const res = await timedFetch(
    NEXT_JOB_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${JOBQUEUE_WORKER_SECRET}`,
      },
      body: JSON.stringify(body),
    },
    NEXTJOB_TIMEOUT_MS
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /next-job failed: ${res.status} ${txt}`);
  }

  // 기대 응답: { job, server_ts, backoff_ms, attempt }
  return res.json();
}

async function postEvent(evt) {
  const res = await timedFetch(
    EVENT_LOG_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${EVENT_LOG_SECRET}`,
      },
      body: JSON.stringify(evt),
    },
    EVENT_TIMEOUT_MS
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /event failed: ${res.status} ${txt}`);
  }
  return res.json().catch(() => ({ ok: true }));
}

// ----------------------
// it2 calls
// ----------------------

// it1 결과 후콜(선택): /it2/auto-decide 같은 엔드포인트로 “결과 요약” 전달
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

// it2_cmd 실행(선택): it2_cmd는 “auto-decide”가 아니라 “명령 실행”이므로 별도 URL이 정석
async function callIt2Cmd(payload) {
  if (!IT2_CMD_URL) return { ok: false, error: "IT2_CMD_URL_NOT_SET" };

  const res = await timedFetch(
    IT2_CMD_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    15000
  );

  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: "IT2_CMD_HTTP_FAIL", detail: { status: res.status, json } };
  return { ok: true, data: json };
}

// ----------------------
// 실제 실행부 (여기만 너의 실제 로직으로 교체)
// ----------------------
async function runIt1(job) {
  // TODO: n8n / PowerShell / VPS / Render 등 실제 실행
  // 지금은 STUB
  await sleep(800 + Math.floor(Math.random() * 1200));
  return { ok: true, note: "stub_done", out: { job_id: job.id } };
}

// ----------------------
// job runner
// ----------------------
async function runJob(envelope) {
  const job = envelope.job;
  const attempt = envelope.attempt ?? job?.attempt ?? 1;
  const trace_id = pickTraceId(job);

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

  // heartbeat는 “fire-and-forget”로 보내되, 예외는 삼켜서 루프를 깨지 않게
  const startHeartbeat = () => {
    hbTimer = setInterval(() => {
      hbSeq += 1;
      postEvent({
        ...baseEvt,
        event_type: "job.heartbeat",
        ts: nowISO(),
        idempotency_key: idem(job.id, "job.heartbeat", attempt, String(hbSeq)),
        data: { ok: true, stage: "running", elapsed_ms: Date.now() - startedAt },
      }).catch(() => {});
    }, HEARTBEAT_MS);
  };

  try {
    // started
    await postEvent({
      ...baseEvt,
      event_type: "job.started",
      ts: nowISO(),
      idempotency_key: idem(job.id, "job.started", attempt),
      data: { ok: true, status: "running" },
    });

    startHeartbeat();

    let result;

    if (job.type === "it1_job" || job.type === "it1.render") {
      result = await runIt1(job);

      // it1 결과는 auto-decide로 후콜(선택)
      // (여기서 retry/fork 판단은 it2가 맡음)
      callAutoDecide({
        trace_id,
        job_id: job.id,
        job_type: job.type,
        ok: !!result?.ok,
        latency_ms: Date.now() - startedAt,
        result: result ?? null,
        error: result?.ok ? null : { message: result?.error || "IT1_FAIL", detail: result?.detail ?? null },
      }).catch(() => {});
    } else if (job.type === "it2_cmd") {
      // it2_cmd는 Worker가 계산하지 않는다(= DB 접근 0 유지)
      // 별도 it2 실행 엔드포인트로 전달
      const payload = job.params || {};
      result = await callIt2Cmd({
        trace_id,
        job_id: job.id,
        job_type: job.type,
        cmd: payload.cmd,
        args: payload.args || {},
        meta: payload.meta || {},
      });
    } else {
      result = { ok: false, error: "UNKNOWN_JOB_TYPE", detail: job.type };
    }

    const latency_ms = Date.now() - startedAt;

    if (result?.ok) {
      await postEvent({
        ...baseEvt,
        event_type: "job.succeeded",
        ts: nowISO(),
        idempotency_key: idem(job.id, "job.succeeded", attempt),
        data: { ok: true, output: result, latency_ms },
      });

      await notifyJob(job, `✅ 작업 완료\ntype: ${job.type}\ntrace_id: ${trace_id}\nlatency_ms: ${latency_ms}`);
    } else {
      await postEvent({
        ...baseEvt,
        event_type: "job.failed",
        ts: nowISO(),
        idempotency_key: idem(job.id, "job.failed", attempt),
        data: {
          ok: false,
          error: { code: "PROCESS_FAIL", message: result?.error || "PROCESS_FAIL", detail: result?.detail ?? result?.data ?? null },
          retryable: true,
          latency_ms,
        },
      });

      await notifyJob(job, `❌ 작업 실패\ntype: ${job.type}\ntrace_id: ${trace_id}\nerror: ${result?.error || "PROCESS_FAIL"}`);
    }
  } catch (e) {
    const latency_ms = Date.now() - startedAt;

    // 예외도 failed로 보고
    try {
      await postEvent({
        ...baseEvt,
        event_type: "job.failed",
        ts: nowISO(),
        idempotency_key: idem(job.id, "job.failed", attempt, "exception"),
        data: {
          ok: false,
          error: { code: "EXCEPTION", message: e?.message || String(e) },
          retryable: true,
          latency_ms,
        },
      });
    } catch {}

    await notifyJob(job, `❌ 작업 예외\ntype: ${job.type}\ntrace_id: ${trace_id}\n${e?.message || String(e)}`);
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

// ----------------------
// Worker loop (Step 7 핵심)
// ----------------------
let STOP = false;

function setupSignals() {
  const stop = () => {
    STOP = true;
    console.log(`[WORKER] stop requested. worker_id=${WORKER_ID}`);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export async function runWorkerLoop() {
  if (!NEXT_JOB_URL || !EVENT_LOG_URL || !JOBQUEUE_WORKER_SECRET || !EVENT_LOG_SECRET) {
    throw new Error("Missing env: NEXT_JOB_URL, EVENT_LOG_URL, JOBQUEUE_WORKER_SECRET, EVENT_LOG_SECRET");
  }

  setupSignals();

  console.log(
    `[WORKER] started worker_id=${WORKER_ID} caps=${JSON.stringify(WORKER_CAPABILITIES)} ` +
      `ns_allow=${JSON.stringify(WORKER_NAMESPACE_ALLOW)} type_allow=${JSON.stringify(WORKER_TYPE_ALLOW)} ` +
      `label_allow=${JSON.stringify(WORKER_LABEL_ALLOW)} label_deny=${JSON.stringify(WORKER_LABEL_DENY)}`
  );

  let errBackoff = LOOP_ERROR_BACKOFF_MS;

  while (!STOP) {
    try {
      const envelope = await nextJob();
      console.log('[DEBUG] next-job envelope:', JSON.stringify(envelope, null, 2));


      // 서버가 내려준 backoff 우선
      if (!envelope?.job) {
        const wait = Number(envelope?.backoff_ms ?? 1000);
        const s = jitter(wait, 0.15);
        console.log(`[WORKER] no job. backoff_ms=${wait} -> sleep ${s}ms`);
        await sleep(s);
        errBackoff = LOOP_ERROR_BACKOFF_MS; // 정상 루프면 에러 backoff 리셋
        continue;
      }

      console.log(`[WORKER] got job id=${envelope.job.id} type=${envelope.job.type} attempt=${envelope.attempt ?? 1}`);

      await runJob(envelope);

      // job 처리 직후 짧은 휴식(바로 연속 호출 방지)
      await sleep(jitter(80, 0.5));
      errBackoff = LOOP_ERROR_BACKOFF_MS;
    } catch (e) {
      // 네트워크/서버 오류 backoff (지수 증가)
      const wait = Math.min(errBackoff, LOOP_ERROR_BACKOFF_MAX_MS);
      const s = jitter(wait, 0.2);
      console.warn(`[WORKER] loop error: ${e?.message || String(e)} -> sleep ${s}ms`);
      await sleep(s);
      errBackoff = Math.min(errBackoff * 2, LOOP_ERROR_BACKOFF_MAX_MS);
    }
  }

  console.log(`[WORKER] stopped worker_id=${WORKER_ID}`);
}

// (옵션) 이 파일을 직접 실행할 때 자동 시작
if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerLoop().catch((e) => {
    console.error("[WORKER] fatal:", e?.message || e);
    process.exit(1);
  });
}
