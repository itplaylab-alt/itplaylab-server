// ========================================
// 📊 KPI DAILY REPORT MODULE (v1.0)
// ========================================

import { google } from "googleapis";

// ✅ Google Sheets에서 로그 불러오기
async function fetchLogsFromSheet() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const range = "logs!A:F"; // logToSheet() 구조 기준

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return [];

    return rows.slice(1).map((r) => ({
      time: r[0],
      type: r[1],
      ok: r[2] === "true" || r[2] === true,
      latency_ms: Number(r[3] || 0),
      project: r[4] || "unknown",
    }));
  } catch (err) {
    console.error("❌ fetchLogsFromSheet error:", err.message);
    return [];
  }
}

// ✅ 로그를 기반으로 KPI 계산
function analyzeLogs(rows) {
  const okCount = rows.filter((r) => r.ok).length;
  const failCount = rows.length - okCount;
  const latencyValues = rows.map((r) => r.latency_ms).filter((v) => v > 0);
  const avgLatency = latencyValues.length
    ? Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)
    : 0;
  const jsonErrorCount = rows.filter((r) => (r.type || "").includes("json_error")).length;

  return {
    total: rows.length,
    ok: okCount,
    fail: failCount,
    successRate: rows.length ? Math.round((okCount / rows.length) * 100) : 0,
    avgLatency,
    jsonErrorRate: rows.length ? Math.round((jsonErrorCount / rows.length) * 100) : 0,
  };
}

// ✅ KPI Markdown 생성
function buildKpiMarkdown(kpi) {
  return `
# 📊 ItplayLab Daily KPI Report

- 총 처리 건수: ${kpi.total}
- 성공률: ${kpi.successRate}%
- 평균 latency: ${kpi.avgLatency}ms
- JSON 오류율: ${kpi.jsonErrorRate}%
- 실패: ${kpi.fail}건

✅ 시스템 상태: ${
    kpi.successRate >= 90
      ? "안정"
      : kpi.successRate >= 75
      ? "주의"
      : "점검 필요"
  }
📅 생성 시각: ${new Date().toLocaleString("ko-KR")}
`;
}

// ✅ /kpi/daily 엔드포인트
app.get("/kpi/daily", async (req, res) => {
  try {
    const logs = await fetchLogsFromSheet();
    if (logs.length === 0) {
      return res.json({ ok: false, message: "No logs found in sheet" });
    }

    const kpi = analyzeLogs(logs);
    const md = buildKpiMarkdown(kpi);

    res.json({ ok: true, kpi, markdown: md });
  } catch (err) {
    console.error("/kpi/daily error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========================================
// ✅ END OF KPI MODULE
// ========================================
