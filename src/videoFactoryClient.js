import axios from "axios";
import { updateVideoStatus } from "./jobRepo.js";

const VIDEO_FACTORY_ENDPOINT =
  process.env.VIDEO_FACTORY_ENDPOINT ||
  "https://example.com/video-factory";

export async function startVideoGeneration(traceId) {
  if (!traceId) throw new Error("Missing traceId in startVideoGeneration");

  console.log(`[VideoFactory] Starting video generation for ${traceId}`);

  // video_queued 상태 업데이트
  await updateVideoStatus(traceId, "video_queued");

  try {
    const resp = await axios.post(VIDEO_FACTORY_ENDPOINT, {
      trace_id: traceId,
    });

    console.log("VideoFactory Response:", resp.data);

    // video_generating 상태 업데이트
    await updateVideoStatus(traceId, "video_generating");
  } catch (err) {
    console.error("VideoFactory Request Error:", err.message);

    await updateVideoStatus(traceId, "video_failed", {
      video_error_message: err.message,
    });

    throw err;
  }
}
