// src/jobRepo.js
// Google Apps Script Web App(GAS_INGEST_URL)과 통신해서
// CONTENT_LOG 시트의 row를 조회/업데이트하는 래퍼

const GAS_BASE_URL = process.env.GAS_INGEST_URL;

if (!GAS_BASE_URL) {
  console.warn("[jobRepo] GAS_INGEST_URL 환경변수가 설정되지 않았습니다.");
}

/**
 * 공통 GET 호출 (Node 18+ 환경에서 fetch 사용)
 * @param {string} pathAndQuery 예: `/job/by-trace-id?trace_id=trc_xxx`
 */
async function gasGet(pathAndQuery) {
  if (!GAS_BASE_URL) throw new Error("GAS_INGEST_URL not configured");

  const url = `${GAS_BASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[jobRepo] GET ${pathAndQuery} failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

/**
 * 공통 POST 호출
 * @param {string} path 예: `/job/update-video`
 * @param {object} body JSON body
 */
async function gasPost(path, body) {
  if (!GAS_BASE_URL) throw new Error("GAS_INGEST_URL not configured");

  const url = `${GAS_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[jobRepo] POST ${path} failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

/**
 * 특정 trace_id로 CONTENT_LOG에서 row 조회
 * GAS 엔드포인트: /job/by-trace-id?trace_id=...
 * @param {string} traceId ex) "trc_20251121_0001"
 * @returns {Promise<object|null>}  { rowNumber, row, trace_id, ... } 형태(시트 구조에 따라 다름)
 */
export async function findByTraceId(traceId) {
  if (!traceId) throw new Error("traceId is required");

  const q = encodeURIComponent(traceId);
  const data = await gasGet(`/job/by-trace-id?trace_id=${q}`);

  // GAS 쪽에서 { ok, jobRow } 또는 { ok:false, error } 형식으로 내려온다고 가정
  if (!data?.ok) {
    if (data?.error === "NOT_FOUND") return null;
    throw new Error(
      `[jobRepo] findByTraceId failed: ${data?.error || "unknown_error"}`
    );
  }

  return data.jobRow || null;
}

/**
 * 영상 생성 결과를 CONTENT_LOG에 업데이트
 * GAS 엔드포인트: /job/update-video (POST)
 *
 * @param {string} traceId  ex) "trc_20251121_0001"
 * @param {object} fields
 *  - videoStatus   : "PENDING" | "PROCESSING" | "DONE" | "ERROR" 등
 *  - videoPath     : 생성된 영상 파일 경로/URL
 *  - videoLatencyMs: 숫자, 영상 생성에 걸린 시간(ms)
 *  - ytStatus      : 유튜브 업로드 상태
 *  - ytVideoId     : 유튜브 비디오 ID
 *  - kpiGrade      : 성과 등급 (선택)
 *  - errorLog      : 에러 메시지 (선택)
 *
 * @returns {Promise<object>} GAS 응답(JSON)
 */
export async function updateVideoStatus(traceId, fields = {}) {
  if (!traceId) throw new Error("traceId is required");

  const payload = {
    trace_id: traceId,
    // 아래 키 이름은 GAS Code.gs에서 body.videoStatus / body.videoPath ... 로 읽도록 맞춰둔 것
    videoStatus: fields.videoStatus,
    videoPath: fields.videoPath,
    videoLatencyMs: fields.videoLatencyMs,
    ytStatus: fields.ytStatus,
    ytVideoId: fields.ytVideoId,
    kpiGrade: fields.kpiGrade,
    errorLog: fields.errorLog,
  };

  const data = await gasPost("/job/update-video", payload);

  if (!data?.ok) {
    throw new Error(
      `[jobRepo] updateVideoStatus failed: ${data?.error || "unknown_error"}`
    );
  }

  return data;
}
