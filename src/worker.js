// src/worker.js
// 서버에서 /next-job 요청이 올 때 한 번만 Job을 뽑아오고,
// (현재는) 간단한 처리 후 DONE/FAILED 로 상태를 업데이트하는 로직

import {
  popNextJobForWorker,
  markJobDone,
  markJobFailed,
} from "./jobRepo.js";

const DEFAULT_WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

export async function runWorkerOnce() {
  try {
    // 1) Supabase job_queue 에서 다음 PENDING job 하나 가져오기
    const job = await popNextJobForWorker(DEFAULT_WORKER_ID);

    // 2) Job 이 없으면 no_job 로그 찍고 종료
    if (!job) {
      console.log(
        '[LOG] {"event":"worker.no_job","ok":true,"message":"대기 Job 없음","meta":{}}'
      );
      return { has_job: false, job: null };
    }

    // 3) Job 을 하나 찾았을 때 로그
    console.log(
      "[LOG]",
      JSON.stringify({
        event: "worker.job_found",
        ok: true,
        id: job.id,
        trace_id: job.trace_id,
        type: job.type,
        status: job.status,
      })
    );

    // 4) 실제 작업 처리 (현재는 STUB)
    try {
      // TODO: 여기에서 job.type 기준으로 실제 작업 실행
      //  - type === 'telegram'  → 영상 생성 트리거
      //  - type === 'test'      → 테스트용 처리 등
      // 지금은 파이프라인 검증을 위해, "성공했다고 가정" 후 바로 DONE 마킹

      await markJobDone(job.id);

      console.log(
        "[LOG]",
        JSON.stringify({
          event: "worker.job_done",
          ok: true,
          id: job.id,
          trace_id: job.trace_id,
          type: job.type,
        })
      );
    } catch (procErr) {
      console.error(
        "[LOG]",
        JSON.stringify({
          event: "worker.process_error",
          ok: false,
          id: job.id,
          trace_id: job.trace_id,
          type: job.type,
          error: procErr?.message || String(procErr),
        })
      );

      // 처리 도중 에러난 경우 FAILED 로 마킹
      await markJobFailed(job.id, procErr?.message || String(procErr));
    }

    // 5) /next-job 응답용으로 job 은 그대로 반환
    return {
      has_job: true,
      job,
    };
  } catch (e) {
    console.error(
      "[LOG]",
      JSON.stringify({
        event: "worker.error",
        ok: false,
        error: e?.message || String(e),
      })
    );
    throw e;
  }
}
