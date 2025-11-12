// ================================
// 📦 REPORT AUTOMATION MODULE FINAL
// ================================

// --- 유틸 함수 ---
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildReportMarkdown(trace) {
  const success = trace.history.filter((h) => h.ok).length;
  const fail = trace.history.filter((h) => !h.ok).length;
  const vals = trace.history.map((h) => Number(h.latency_ms || 0)).filter((v) => v > 0);
  const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  const stepsLine = trace.steps
    .map((s, i) => `${i < trace.currentIndex ? "✔" : "•"} ${labelStep(s)}`)
    .join(" → ");

  const hist = trace.history
    .map(
      (h) =>
        `- ${labelStep(h.step)}: ${h.ok ? "✅" : "❌"} (${h.latency_ms || 0}ms / ${h.provider || "-"})`
    )
    .join("\n");

  const out = Object.keys(trace.lastOutput || {}).join(", ") || "-";

  let md = "# 🎬 ItplayLab 콘텐츠 자동화 리포트\n";
  md += `**제목:** ${escapeHtml(trace.title)}  \n`;
  md += `**Trace ID:** ${trace.id}  \n`;
  md += `**상태:** ${trace.status}  \n`;
  md += `**리비전:** ${trace.revisionCount}/${MAX_REVISIONS}  \n`;
  md += `**생성 시각:** ${trace.createdAt}\n\n`;
  md += `---\n\n## 📊 진행 요약\n${stepsLine}\n\n`;
  md += `- 성공: ${success} / 실패: ${fail}\n`;
  md += `- 평균 지연시간: ${avg}ms\n\n`;
  md += `## 🧱 단계 기록\n${hist}\n\n`;
  md += `## 📦 산출물\n${out}\n`;
  return md;
}

// --- 라우트 추가 함수 ---
function setupReportRoutes(app) {
  // /report/generate
  app.post("/report/generate", async (req, res) => {
    try {
      const trace_id = req.body?.trace_id || "";
      const trace = traces.get(trace_id);
      if (!trace)
        return res.status(404).json({ ok: false, error: "trace not found", trace_id });

      const md = buildReportMarkdown(trace);
      await logToSheet({
        type: "report_generated",
        input_text: trace.title,
        output_text: md,
        project: PROJECT,
        category: "report",
        trace_id,
        ok: true,
      });

      res.json({ ok: true, trace_id, report: md });
    } catch (e) {
      console.error("/report/generate error", e?.message);
      res.status(500).json({ ok: false, error: "report_generate_failed" });
    }
  });

  // /report/send
  app.post("/report/send", async (req, res) => {
    try {
      const trace_id = req.body?.trace_id || "";
      const chat_id = req.body?.chat_id;
      const trace = traces.get(trace_id);
      if (!trace)
        return res.status(404).json({ ok: false, error: "trace not found", trace_id });

      const md = buildReportMarkdown(trace);
      const html = "<pre>" + escapeHtml(md) + "</pre>";
      const targetChat = chat_id || trace.chatId || TELEGRAM_ADMIN_CHAT_ID;

      await withTraceLock(trace, async () => {
        await tgSend(targetChat, html, "HTML");
      });

      await logToSheet({
        type: "report_sent",
        input_text: trace.title,
        output_text: { len: md.length },
        project: PROJECT,
        category: "report",
        trace_id,
        ok: true,
      });

      res.json({ ok: true, sent: true, trace_id });
    } catch (e) {
      console.error("/report/send error", e?.message);
      res.status(500).json({ ok: false, error: "report_send_failed" });
    }
  });
}

// ================================
// ✅ Express app 생성 및 서버 구동
// ================================
import express from "express";
const app = express();

// 미들웨어 등 다른 설정이 있다면 여기에 추가
app.use(express.json());

// 리포트 라우트 등록 (app 선언 이후)
setupReportRoutes(app);

// 서버 시작
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
// ===============================
// 📊 KPI DAILY REPORT MODULE
// ===============================
import { google } from "googleapis";

async function fetchLogsFromSheet() {
  // Sheets API 인증 (서비스계정 키 필요)
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = "logs!A:F"; // logToSheet() 구조에 맞게 조정

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = res.data.values || [];
  return rows.slice(1).map((r) => ({
    time: r[0],
    type: r[1],
    ok: r[2] === "true",
    latency_ms: Number(r[3] || 0),
    project: r[4],
  }));
}

function analyzeLogs(rows) {
  const okCount = rows.filter((r) => r.ok).length;
  const failCount = rows.length - okCount;
  const latency = rows.map((r) => r.latency_ms).filter((v) => v > 0);
  const avgLatency = latency.length
    ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length)
    : 0;
  const jsonErrorCount = rows.filter((r) => r.type.includes("json_error")).length;

  return {
    total: rows.length,
    ok: okCount,
    fail: failCount,
    successRate: rows.length ? Math.round((okCount / rows.length) * 100) : 0,
    avgLatency,
    jsonErrorRate: rows.length ? Math.round((jsonErrorCount / rows.length) * 100) : 0,
  };
}

app.get("/kpi/daily", async (req, res) => {
  try {
    const logs = await fetchLogsFromSheet();
    const kpi = analyzeLogs(logs);
    const md = `
# 📊 ItplayLab Daily KPI

- 총 처리 건수: ${kpi.total}
- 성공률: ${kpi.successRate}%
- 평균 latency: ${kpi.avgLatency}ms
- JSON 오류율: ${kpi.jsonErrorRate}%
- 실패: ${kpi.fail}건
`;

    res.json({ ok: true, kpi, markdown: md });
  } catch (err) {
    console.error("/kpi/daily error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
