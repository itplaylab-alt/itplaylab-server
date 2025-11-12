// ========================================
// 📊 ItplayLab KPI DAILY REPORT MODULE (SAFE VERSION)
// ========================================

// ✅ KPI 라우트 등록 함수
async function setupKpiRoutes(app) {
  // 동적 import (googleapis 없을 때 안전하게 처리)
  async function fetchLogsFromSheet() {
    try {
      let googleMod;
      try {
        googleMod = await import("googleapis");
      } catch {
        throw new Error("googleapis_not_installed");
      }
      const { google } = googleMod;

      const keyRaw = process.env.GOOGLE_SERVICE_KEY;
      const sheetId = process.env.GOOGLE_SHEET_ID;
      if (!keyRaw || !sheetId) throw new Error("gcp_env_missing");

      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(keyRaw),
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });

      const sheets = google.sheets({ version: "v4", auth });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "logs!A:F",
      });

      const rows = res.data.values || [];
      if (rows.length <= 1) return [];

      return rows.slice(1).map((r) => ({
        time: r[0],
        type: r[1] || "",
        ok: r[2] === "true" || r[2] === true,
        latency_ms: Number(r[3] || 0),
        project: r[4] || "unknown",
      }));
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  // ✅ KPI 계산
  function analyzeLogs(rows) {
    const okCount = rows.filter((r) => r.ok).length;
    const failCount = rows.length - okCount;
    const lat = rows.map((r) => r.latency_ms).filter((v) => v > 0);
    const avgLatency = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
    const jsonErr = rows.filter((r) => (r.type || "").includes("json_error")).length;

    return {
      total: rows.length,
      ok: okCount,
      fail: failCount,
      successRate: rows.length ? Math.round((okCount / rows.length) * 100) : 0,
      avgLatency,
      jsonErrorRate: rows.length ? Math.round((jsonErr / rows.length) * 100) : 0,
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

📅 생성 시각: ${new Date().toLocaleString("ko-KR")}
`;
  }

  // ✅ GET /kpi/daily
  app.get("/kpi/daily", async (req, res) => {
    const data = await fetchLogsFromSheet();

    if (data?.error === "googleapis_not_installed") {
      return res.status(500).json({ ok: false, error: "googleapis_not_installed" });
    }
    if (data?.error === "gcp_env_missing") {
      return res.status(500).json({ ok: false, error: "GOOGLE_SERVICE_KEY or GOOGLE_SHEET_ID missing" });
    }
    if (Array.isArray(data) && data.length === 0) {
      return res.json({ ok: false, message: "No logs found in sheet" });
    }
    if (!Array.isArray(data)) {
      return res.status(500).json({ ok: false, error: data?.error || "unknown_error" });
    }

    const kpi = analyzeLogs(data);
    const md = buildKpiMarkdown(kpi);
    res.json({ ok: true, kpi, markdown: md });
  });
}

// ✅ 반드시 app이 생성된 이후 호출
setupKpiRoutes(app);
