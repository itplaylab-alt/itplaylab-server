// src/worker.js
// 서버에서 /next-job 요청이 올 때 한 번만 Job을 뽑아오는 로직

import { popNextJobForWorker } from "./jobRepo.js";

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

    // 아직 여기서는 비디오 생성 같은 건 안 하고,
    // worker_mock.js 가 Job 을 받아서 테스트용으로 처리할 수 있게 그대로 넘겨준다.
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
