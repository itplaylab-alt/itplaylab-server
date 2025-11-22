// logger.js (ESM 버전)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname 대체 (ESM에는 기본 제공 안 돼서 직접 계산)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_FILE = process.env.LOG_FILE || "app.log";
const LOG_PATH = path.join(LOG_DIR, LOG_FILE);

// logs 디렉토리 없으면 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLine(line) {
  fs.appendFile(LOG_PATH, line + "\n", "utf8", (err) => {
    if (err) {
      console.error("[logger] write error:", err);
    }
  });
}

function buildEvent(event = {}) {
  return {
    ts: new Date().toISOString(),
    ok: true,
    ...event,
  };
}

// 정상 로그
function logEvent(event) {
  const payload = buildEvent(event);
  const line = JSON.stringify(payload);

  console.log("[LOG]", line);
  writeLine(line);

  return payload;
}

// 에러 로그
function logError(event) {
  return logEvent({ ok: false, ...event });
}

export { logEvent, logError };
