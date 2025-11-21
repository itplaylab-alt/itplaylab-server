// jobRepo.js
// Google Apps Script Web App(GAS_INGEST_URL)와 통신해서
// CONTENT_LOG 시트의 JobRow를 조회/업데이트하는 래퍼

const GAS_BASE_URL = process.env.GAS_INGEST_URL;

if (!GAS_BASE_URL) {
  console.warn("[jobRepo] GAS_INGEST_URL 환경변수가 설정되지 않았습니다.");
}

// Node 18 이상이면 fetch 내장, 그 이하면 node-fetch 설치 후 global.fetch 세팅 필요
async function gasGet(pathAndQuery) {
  const url = `${GAS_BASE_URL}${pathAndQuery}`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function gasPost(path, body) {
  const res = await fetch(`${GAS_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json;
}

// -------------------------------
// 주요 메소드 2개
// -------------------------------

// 1) trace_id로 row 조회
export async function findByTraceId(traceId) {
  return await gasGet(`/job/by-trace-id?trace_id=${traceId}`);
}

// 2) VIDEO_STATUS, VIDEO_PATH 등 업데이트
export async function updateVideoStatus(traceId, payload) {
  return await gasPost("/job/update-video", {
    trace_id: traceId,
    ...payload, // { videoStatus, videoPath, videoLatencyMs, errorLog }
  });
}
