// src/jobRepo.js
// Google Apps Script Web App(GAS_WEB_URL)과 통신해서
// CONTENT_LOG / PlanQueue 기반 JobRow를 조회·생성·업데이트하는 레포지토리
// + Supabase job_queue 에서 Worker용 Job POP

import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { logEvent, logError } from "../logger.js";

// ───────────────────────────────────
// Supabase (job_queue용) 초기화
// ───────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 전역 supabase 인스턴스 (중복 선언 금지!)
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  logEvent({
    event: "jobRepo_init_supabase_ok",
    ok: true,
  });
} else {
  logError({
    event: "jobRepo_init_supabase_missing_env",
    ok: false,
    message: "SUPABASE_URL 또는 SUPABASE_SERVICE_KEY 없음",
  });
}

// ─────────────────────────────────────
// GAS WebApp (기존 로직)
// ─────────────────────────────────────
const GAS_WEB_URL = process.env.GAS_INGEST_URL;
// 예: https://script.google.com/macros/s/xxxx/exec

if (!GAS_WEB_URL) {
  logEvent({
    event: "jobRepo_init_no_gas_url",
    ok: false,
    message: "GAS_INGEST_URL 환경변수가 없습니다!",
  });
}

/* ============================================================================
 * 조회
 * ========================================================================== */

/**
 * 특정 trace_id로 JobRow 조회
 * @param {string} traceId
 * @returns {object|null}
 */
export async function findByTraceId(traceId) {
  const startedAt = Date.now();

  try {
    const url = `${GAS_WEB_URL}?action=jobByTraceId&trace_id=${encodeURIComponent(
      traceId
    )}`;
    const res = await axios.get(url);

    const latency = Date.now() - startedAt;

    if (!res.data || !res.data.success) {
      logEvent({
        event: "jobRepo_findByTraceId_fail",
        ok: false,
        latency_ms: latency,
        trace_id: traceId,
        response: res.data ?? null,
      });
      return null;
    }

    logEvent({
      event: "jobRepo_findByTraceId_ok",
      ok: true,
      latency_ms: latency,
      trace_id: traceId,
    });

    return res.data.job;
  } catch (err) {
    const latency = Date.now() - startedAt;

    logError({
      event: "jobRepo_findByTraceId_error",
      latency_ms: latency,
      trace_id: traceId,
      error_message: err?.message,
    });

    return null;
  }
}

/* ============================================================================
 * 생성 (✅ PlanQueue → JobRow 생성)
 * ========================================================================== */

/**
 * PlanQueue row 기반으로 Job 생성
 * @param {object} payload  // { row_index, row: { trace_id, job_type, input, created_at, ... } }
 * @returns {object|null}
 */
export async function createJobFromPlanQueueRow(payload = {}) {
  const startedAt = Date.now();

  try {
    const body = {
      action: "create",
      source: "autopilot_v1",
      row_index: payload.row_index,
      row: payload.row, // { trace_id, job_type, input, created_at ... }
      // ✅ 기본 status 지정 (GAS에서 없으면 plan_pending 으로 시작)
      default_status: payload.default_status || "plan_pending",
    };

    const res = await axios.post(GAS_WEB_URL, body, {
      headers: { "Content-Type": "application/json" },
    });

    const latency = Date.now() - startedAt;

    if (!res.data || !res.data.ok) {
      logEvent({
        event: "jobRepo_createJob_fail",
        ok: false,
        latency_ms: latency,
        row_index: payload.row_index,
        trace_id: payload.row?.trace_id,
        response: res.data ?? null,
      });
      return null;
    }

    const job = res.data.job || body;

    logEvent({
      event: "jobRepo_createJob_ok",
      ok: true,
      latency_ms: latency,
      row_index: payload.row_index,
      trace_id: job?.trace_id ?? payload.row?.trace_id,
    });

    return job;
  } catch (err) {
    const latency = Date.now() - startedAt;

    logError({
      event: "jobRepo_createJob_error",
      latency_ms: latency,
      row_index: payload.row_index,
      trace_id: payload.row?.trace_id,
      error_message: err?.message,
    });

    return null;
  }
}

/* ============================================================================
 * 업데이트 (GAS JobRow)
 * ========================================================================== */

/**
 * JobRow의 status / step / checks 등을 업데이트
 * @param {string} traceId
 * @param {object} updates - { status, step, checks, reason }
 * @returns {boolean}
 */
export async function updateVideoStatus(traceId, updates = {}) {
  const startedAt = Date.now();

  try {
    const body = {
      action: "update",
      trace_id: traceId,
      ...updates,
    };

    const res = await axios.post(GAS_WEB_URL, body, {
      headers: { "Content-Type": "application/json" },
    });

    const latency = Date.now() - startedAt;

    if (!res.data || !res.data.ok) {
      logEvent({
        event: "jobRepo_updateVideoStatus_fail",
        ok: false,
        latency_ms: latency,
        trace_id: traceId,
        updates,
        response: res.data ?? null,
      });
      return false;
    }

    logEvent({
      event: "jobRepo_updateVideoStatus_ok",
      ok: true,
      latency_ms: latency,
      trace_id: traceId,
      updates,
    });

    return true;
  } catch (err) {
    const latency = Date.now() - startedAt;

    logError({
      event: "jobRepo_updateVideoStatus_error",
      latency_ms: latency,
      trace_id: traceId,
      updates,
      error_message: err?.message,
    });

    return false;
  }
}

/* ============================================================================
 * Worker용 JobQueue POP (Supabase job_queue)
 * ========================================================================= */

/**
 * Supabase job_queue 에서
 *   - status = 'PENDING'
 *   - locked_at IS NULL
 * 인 Job 하나를 조회한 뒤,
 *   - status = 'RUNNING'
 *   - locked_at / locked_by / updated_at 를 갱신하고
 * 해당 레코드를 반환한다.
 *
 * @param {string} workerId - 이 Job을 가져간 워커 ID (locked_by 에 기록)
 * @returns {object|null}   - Job 레코드 1건, 없으면 null
 */
export async function popNextJobForWorker(
  workerId = "itplaylab-worker-1"
) {
  // Supabase 클라이언트가 초기화 안 되었을 때 방어 로직
  if (!supabase) {
    logError({
      event: "jobRepo_popNextJobForWorker_no_supabase",
      worker_id: workerId,
      error_message: "Supabase 클라이언트가 초기화되지 않았습니다.",
    });
    return null;
  }

  try {
    const now = new Date().toISOString();

    // ────────────────────────────────────
    // 0) 디버그용: PENDING + unlocked 개수 로깅
    // ────────────────────────────────────
    const {
      count: pendingCount,
      error: countError,
    } = await supabase
      .from("job_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "PENDING")
      .is("locked_at", null);

    if (countError) {
      logError({
        event: "jobRepo_popNextJobForWorker_count_error",
        worker_id: workerId,
        error_message: countError.message || String(countError),
      });
    } else {
      logEvent({
        event: "jobRepo_popNextJobForWorker_pending_count",
        ok: true,
        worker_id: workerId,
        pending_count: pendingCount ?? 0,
      });
    }

    // ────────────────────────────────────
    // 1) 가장 오래된 PENDING + unlocked Job 1건 조회
    // ────────────────────────────────────
    const {
      data: candidate,
      error: selectError,
    } = await supabase
      .from("job_queue")
      .select("*")
      .eq("status", "PENDING")
      .is("locked_at", null)
      .order("created_at", { ascending: true, nullsFirst: true })
      .limit(1)
      .maybeSingle(); // supabase-js v2 기준

    if (selectError) {
      logError({
        event: "jobRepo_popNextJobForWorker_select_error",
        worker_id: workerId,
        error_message: selectError.message || String(selectError),
      });
      return null;
    }

    // 조회된 후보 Job 이 없는 경우 (대기 Job 없음)
    if (!candidate) {
      logEvent({
        event: "jobRepo_popNextJobForWorker_no_job",
        ok: true,
        worker_id: workerId,
        note: "대기 Job 없음 (PENDING + locked_at IS NULL 조건 불일치)",
      });
      return null;
    }

    logEvent({
      event: "jobRepo_popNextJobForWorker_candidate_found",
      ok: true,
      worker_id: workerId,
      id: candidate.id,
      status: candidate.status,
      locked_at: candidate.locked_at,
      created_at: candidate.created_at,
      type: candidate.type,
    });

    // ────────────────────────────────────
    // 2) 해당 Job 을 RUNNING 으로 락 (경쟁 상황 방지 조건 포함)
    // ────────────────────────────────────
    const {
      data: locked,
      error: lockError,
    } = await supabase
      .from("job_queue")
      .update({
        status: "RUNNING",
        locked_at: now,
        locked_by: workerId,
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "PENDING") // 여전히 PENDING인지 확인
      .is("locked_at", null) // 여전히 unlock 상태인지 확인
      .select()
      .maybeSingle();

    if (lockError) {
      logError({
        event: "jobRepo_popNextJobForWorker_lock_error",
        worker_id: workerId,
        error_message: lockError.message || String(lockError),
        id: candidate.id,
      });
      return null;
    }

    // 업데이트 결과가 없으면: 다른 Worker 가 선점한 상황
    if (!locked) {
      logEvent({
        event: "jobRepo_popNextJobForWorker_lock_lost",
        ok: true,
        worker_id: workerId,
        id: candidate.id,
        note: "다른 worker 가 먼저 Job 을 락함",
      });
      return null;
    }

    // 정상적으로 Job 하나 가져온 경우 로그
    logEvent({
      event: "jobRepo_popNextJobForWorker_ok",
      ok: true,
      worker_id: workerId,
      id: locked.id,
      trace_id: locked.trace_id,
      type: locked.type,
    });

    return locked;
  } catch (e) {
    logError({
      event: "jobRepo_popNextJobForWorker_exception",
      worker_id: workerId,
      error_message: e?.message || String(e),
    });
    return null;
  }
}

/* ============================================================================
 * JobQueue 상태 업데이트 (Supabase job_queue)
 * ========================================================================= */

/**
 * job_queue 의 단일 Job 상태를 업데이트하는 공통 함수
 *
 * @param {string} jobId      - job_queue.id
 * @param {object} updates    - { status, locked_at, locked_by, fail_reason, ... }
 * @returns {object|null}     - 업데이트된 레코드, 실패 시 null
 */
export async function updateJobQueueStatus(jobId, updates = {}) {
  if (!supabase) {
    logError({
      event: "jobRepo_updateJobQueueStatus_no_supabase",
      job_id: jobId,
      error_message: "Supabase 클라이언트가 초기화되지 않았습니다.",
    });
    return null;
  }

  try {
    const now = new Date().toISOString();

    const payload = {
      updated_at: now,
      ...updates,
    };

    const { data, error } = await supabase
      .from("job_queue")
      .update(payload)
      .eq("id", jobId)
      .select()
      .maybeSingle();

    if (error) {
      logError({
        event: "jobRepo_updateJobQueueStatus_error",
        job_id: jobId,
        updates: payload,
        error_message: error.message || String(error),
      });
      return null;
    }

    if (!data) {
      logEvent({
        event: "jobRepo_updateJobQueueStatus_no_row",
        ok: false,
        job_id: jobId,
        updates: payload,
        note: "업데이트 대상 row 없음",
      });
      return null;
    }

    logEvent({
      event: "jobRepo_updateJobQueueStatus_ok",
      ok: true,
      job_id: jobId,
      status: data.status,
    });

    return data;
  } catch (e) {
    logError({
      event: "jobRepo_updateJobQueueStatus_exception",
      job_id: jobId,
      updates,
      error_message: e?.message || String(e),
    });
    return null;
  }
}

/**
 * Job 정상 완료 → DONE 으로 마킹
 *
 * @param {string} jobId
 * @param {object} extraUpdates - 필요 시 추가 필드(e.g. result_url 등)
 * @returns {object|null}
 */
export async function markJobDone(jobId, extraUpdates = {}) {
  return await updateJobQueueStatus(jobId, {
    status: "DONE",
    locked_at: null,
    locked_by: null,
    ...extraUpdates,
  });
}

/**
 * Job 실패 → FAILED 로 마킹
 *
 * @param {string} jobId
 * @param {string} [reason]       - 실패 이유(텍스트)
 * @param {object} extraUpdates   - 필요 시 추가 필드(e.g. error_code 등)
 * @returns {object|null}
 */
export async function markJobFailed(jobId, reason = null, extraUpdates = {}) {
  return await updateJobQueueStatus(jobId, {
    status: "FAILED",
    locked_at: null,
    locked_by: null,
    fail_reason: reason,
    ...extraUpdates,
  });
}

// ─────────────────────────────────────
// 명시적 export 묶음 (ESM named export 확실히 보이도록)
// ─────────────────────────────────────
export {
  // GAS 관련
  findByTraceId,
  createJobFromPlanQueueRow,
  updateVideoStatus,
  // JobQueue 관련
  popNextJobForWorker,
  updateJobQueueStatus,
  markJobDone,
  markJobFailed,
};
