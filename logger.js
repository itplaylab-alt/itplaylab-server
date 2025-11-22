// logger.js
// ItplayLab 공용 로거
// - 콘솔 + 파일(JSONL)로 기록
// - 공통 필드: ts, ok, trace_id, stage, latency_ms, status, message, meta

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_FILE = process.env.LOG_FILE || 'app.log';
const LOG_PATH = path.join(LOG_DIR, LOG_FILE);

// logs 디렉토리 없으면 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLine(line) {
  fs.appendFile(LOG_PATH, line + '\n', 'utf8', (err) => {
    if (err) {
      console.error('[logger] write error:', err);
    }
  });
}

function buildEvent(event = {}) {
  return {
    ts: new Date().toISOString(),
    ok: true,
    ...event
  };
}

// 정상 로그
function logEvent(event) {
  const payload = buildEvent(event);
  const line = JSON.stringify(payload);

  console.log('[LOG]', line);
  writeLine(line);

  return payload;
}

// 에러 로그
function logError(event) {
  return logEvent({ ok: false, ...event });
}

module.exports = {
  logEvent,
  logError
};
