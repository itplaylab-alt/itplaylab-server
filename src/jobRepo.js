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

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  logEvent({
    event: "jobRepo_init_supabase_ok",
    ok: true,
  });
} else {
  logError({
    event: "jobRepo_init_supabase_missing_env",
    error_message: "SUPABASE_URL 또는 SUPABASE_SERVICE_KEY 가 없습니다.",
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
 * 업데이트
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
 * ========================================================================== */

/**
 * Supabase job_queue 에서
 *   - status = 'PENDING'
 *   - locked_at IS NULL
 * 인 Job 하나를 골라
 *   - status = 'RUNNING'
 *   - locked_at / locked_by / updated_at 갱신하고
 * 그 레코드를 반환한다.
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

    const { data, error } = await supabase
      .from("job_queue")
      .update({
        status: "RUNNING",
        locked_at: now,
        locked_by: workerId,
        updated_at: now,
      })
      .eq("status", "PENDING")
      .is("locked_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .select()
      .single();

    // 1) 에러인데 "0 rows" 케이스 (대기 Job 없음)
    if (error) {
      if (
        error.code === "PGRST116" ||
        (error.details && error.details.includes("0 rows"))
      ) {
        logEvent({
          event: "jobRepo_popNextJobForWorker_no_job",
          ok: true,
          worker_id: workerId,
          note: "대기 Job 없음",
        });
        return null;
      }

      // 2) 진짜 에러
      logError({
        event: "jobRepo_popNextJobForWorker_error",
        worker_id: workerId,
        error_message: error.message || String(error),
      });
      return null;
    }

    // 3) data 자체가 비어 있는 경우
    if (!data) {
      logEvent({
        event: "jobRepo_popNextJobForWorker_no_data",
        ok: true,
        worker_id: workerId,
        note: "select 결과가 비어 있음",
      });
      return null;
    }

    // 4) 정상적으로 Job 하나 가져온 경우 로그
    logEvent({
      event: "jobRepo_popNextJobForWorker_ok",
      ok: true,
      worker_id: workerId,
      id: data.id,
      trace_id: data.trace_id,
      type: data.type,
    });

    return data;
  } catch (e) {
    logError({
      event: "jobRepo_popNextJobForWorker_exception",
      worker_id: workerId,
      error_message: e?.message || String(e),
    });
    return null;
  }
}
