// src/videoFactoryClient.js

import { updateVideoStatus } from "./jobRepo.js";
import { logEvent, logError } from "../logger.js";

/**
 * mock 영상 생성 시작 함수
 * - VIDEO_STATUS를 "video_queued" → 3초 후 "video_done"으로 변경
 * - 실패 시 "video_failed" + video_error_message 기록
 */
export async function startVideoGeneration(traceId) {
  const t0 = Date.now();
  if (!traceId) {
    throw new Error("Missing traceId in startVideoGeneration");
  }

  try {
    console.log(`[VideoFactory] Starting video generation for ${traceId}`);

    // 1) video_queued 상태 업데이트
    await updateVideoStatus(traceId, "video_queued");

    logEvent({
      trace_id: traceId,
      stage: "video_factory.queue_update",
      status: "video_queued",
      latency_ms: Date.now() - t0,
      message: "VIDEO_STATUS set to video_queued",
    });

    // 2) mock: 3초 후 완료 처리
    setTimeout(async () => {
      const innerStart = Date.now();
      try {
        // 완료 상태 (이름은 시트에서 쓰는 값에 맞게 조정해도 됨)
        await updateVideoStatus(traceId, "video_done");

        logEvent({
          trace_id: traceId,
          stage: "video_factory.complete",
          status: "video_done",
          latency_ms: Date.now() - innerStart,
          message: "mock video generation done",
        });
      } catch (err) {
        // 완료 단계에서 실패한 경우
        const msg = err?.message ?? String(err);

        await updateVideoStatus(traceId, "video_failed", {
          video_error_message: msg,
        });

        logError({
          trace_id: traceId,
          stage: "video_factory.error",
          status: "video_failed",
          latency_ms: Date.now() - innerStart,
          message: "error in mock completion step",
          meta: { error: msg },
        });
      }
    }, 3000);
  } catch (err) {
    // start 단계에서 실패한 경우
    const msg = err?.message ?? String(err);

    await updateVideoStatus(traceId, "video_failed", {
      video_error_message: msg,
    });

    logError({
      trace_id: traceId,
      stage: "video_factory.start",
      status: "video_failed",
      latency_ms: Date.now() - t0,
      message: "startVideoGeneration failed",
      meta: { error: msg },
    });

    // 기존 흐름 유지: 호출한 쪽(dev 라우트)이 에러를 잡아서 ok:false 응답하도록
    throw err;
  }
}
