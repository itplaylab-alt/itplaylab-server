// src/worker.js
// ItplayLab Worker – /next-job 처리 공정

import { popNextJobForWorker } from "./jobRepo.js";
import { startVideoGeneration } from "./videoFactoryClient.js";
import { logEvent, logError } from "../logger.js";

export async function runWorkerOnce() {
  try {
    const startedAt = Date.now();

    // 1) 대기 Job 하나 가져오기
    const job = await popNextJobForWorker();

    if (!job) {
      logEvent({
        event: "worker.no_job",
        message: "대기 Job 없음",
        latency_ms: Date.now() - startedAt,
      });
      return null;
    }

    logEvent({
      event: "worker.job_fetched",
      trace_id: job.trace_id,
      job_type: job.job_type,
    });

    // 2) 영상 생성 등 처리
    const output = await startVideoGeneration(job);

    // 3) 상태 업데이트 + 로그 + 텔레그램 알림 등
    logEvent({
      event: "worker.job_completed",
      trace_id: job.trace_id,
      output,
      latency_ms: Date.now() - startedAt,
    });

    return output;
  } catch (err) {
    logError({
      event: "worker.error",
      message: err.message,
    });
    return null;
  }
}
