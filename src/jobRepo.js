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
