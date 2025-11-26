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
      row: payload.row,           // { trace_id, job_type, input, created_at ... }
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

    console.log(
      "[jobRepo][CREATE] ✅ Job 생성 완료:",
      res.data.job || body
    );

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
