// ======================================================
// 📦 REPORT AUTOMATION MODULE (SAFE VERSION)
// ======================================================

// --- 유틸 ---
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
    .map((h) => `- ${labelStep(h.step)}: ${h.ok ? "✅" : "❌"} (${h.latency_ms || 0}ms / ${h.provider || "-"})`)
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

// --- 등록 함수 ---
export function setupReportRoutes(app) {
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
      console.error("/report/generate error:", e?.message);
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

      await tgSend(targetChat, html, "HTML");

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
      console.error("/report/send error:", e?.message);
      res.status(500).json({ ok: false, error: "report_send_failed" });
    }
  });
}

// ======================================================
// ✅ app 생성 이후에 호출
// ======================================================

// 아래 두 줄이 반드시 이 순서여야 함!
setupReportRoutes(app);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Server is running on port ${PORT} (approval_mode=${APPROVAL_MODE})`)
);
