// logger.js (ESM 버전)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ESM에서는 __dirname이 없기 때문에 직접 생성
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 환경 변수 또는 기본 경로 세팅
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_FILE = process.env.LOG_FILE || "app.log";
const LOG_PATH = path.join(LOG_DIR, LOG_FILE);

// logs 디렉토리가 없으면 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 한 줄씩 파일로 저장하는 함수
function writeLine(line) {
  fs.appendFile(LOG_PATH, line + "\n", "utf8", (err) => {
    if (err) {
      console.error("[logger] write error:", err);
    }
  });
}

// 이벤트(로그 오브젝트) 구조 만들기
function buildEvent(event = {}) {
  return {
    ts: new Date().toISOString(), // 타임스탬프 자동 포함
    ok: true,                      // 기본 ok:true
    ...event,
  };
}

// 정상 로그 기록용 함수
function logEvent(event) {
  const payload = buildEvent(event);
  const line = JSON.stringify(payload);

  console.log("[LOG]", line);
  writeLine(line);

  return payload;
}

// 에러 로그 기록용 함수
function logError(event) {
  return logEvent({ ok: false, ...event });
}

export { logEvent, logError };
