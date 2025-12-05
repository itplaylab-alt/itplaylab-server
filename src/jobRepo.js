// src/jobRepo.js
// Google Apps Script Web App(GAS_WEB_URL)과 통신해서
// CONTENT_LOG / PlanQueue 기반 JobRow를 조회·생성·업데이트하는 레포지토리

import axios from "axios";

const GAS_WEB_URL = process.env.GAS_INGEST_URL;
// 예: https://script.google.com/macros/s/xxxx/exec

if (!GAS_WEB_URL) {
  console.warn("[jobRepo] ⚠️ GAS_INGEST_URL 환경변수가 없습니다!");
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
  try {
    const url = `${GAS_WEB_URL}?action=jobByTraceId&trace_id=${traceId}`;
    const res = await axios.get(url);

    if (!res.data || !res.data.success) {
      console.log("[jobRepo] findByTraceId 실패:", res.data);
      return null;
    }

    return res.data.job;
  } catch (err) {
    console.error("[jobRepo] findByTraceId 오류:", err.message);
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

    if (!res.data || !res.data.ok) {
      console.log("[jobRepo] createJob 실패:", res.data);
      return null;
    }

    console.log("[jobRepo][CREATE] ✅ Job 생성 완료:", res.data.job || body);

    return res.data.job || body;
  } catch (err) {
    console.error("[jobRepo] createJob 오류:", err.message);
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
  try {
    const body = {
      action: "update",
      trace_id: traceId,
      ...updates,
    };

    const res = await axios.post(GAS_WEB_URL, body, {
      headers: { "Content-Type": "application/json" },
    });

    if (!res.data || !res.data.ok) {
      console.log("[jobRepo] 업데이트 실패:", res.data);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[jobRepo] updateVideoStatus 오류:", err.message);
    return false;
  }
}

/* ============================================================================
 * Worker용 JobQueue POP (임시 버전)
 * ========================================================================== */

/**
 * Render Background Worker가 /next-job 으로 요청할 때
 * '대기 중인 다음 Job 1건' 을 가져오는 함수 (임시 구현)
 *
 * @param {object} meta - worker_id 등 메타정보 (현재는 사용하지 않음)
 * @returns {object|null} job - 대기 Job이 없으면 null
 */
export async function popNextJobForWorker(meta = {}) {
  // TODO: 나중에 GAS WebApp 쪽에
  //   action=popNextJobForWorker 같은 엔드포인트를 만들고,
  //   실제로 JobQueue에서 1건을 pop 해서 반환하도록 구현하면 됨.
  //
  // 현재는 "대기 Job 없음"만 표현하기 위해 null을 반환하는 스텁이다.
  return null;
}
