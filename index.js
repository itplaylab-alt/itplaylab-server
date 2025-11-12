// === TEST ROUTES (임시 확인용) ===
app.get("/test/healthcheck", (req, res) => {
  res.json({
    ok: true,
    service: "Render 서버 정상 동작 중",
    status: "✅ Alive",
    timestamp: new Date().toISOString(),
  });
});

app.get("/test/send-log", (req, res) => {
  res.json({
    ok: true,
    message: "Render → GAS 로그 테스트용 엔드포인트입니다 (아직 연결 없음)",
  });
});

app.get("/test/notify", (req, res) => {
  res.json({
    ok: true,
    message: "Telegram 알림 테스트용 엔드포인트입니다 (아직 메시지 전송 안 함)",
  });
});
