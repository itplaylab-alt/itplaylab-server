// src/worker.js
// 서버에서 /next-job 요청이 올 때 한 번만 Job을 뽑아오고,
// job.type 기준으로 실제 처리 후 DONE/FAILED 로 업데이트하는 로직

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

import { popNextJobForWorker, markJobDone, markJobFailed } from "./jobRepo.js";
import { tgSend, tg2Send } from "../services/telegramBot.js";

const DEFAULT_WORKER_ID = process.env.WORKER_ID || "itplaylab-worker-1";

// ✅ Supabase 클라이언트 (worker에서도 직접 사용)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────
function pickJobNamespace(job) {
  return (
    job?.params?.namespace ??
    job?.params?.meta?.namespace ??
    (job?.type === "it2_cmd" ? "it2" : "it1")
  );
}

function pickJobChatId(job) {
  return (
    job?.params?.meta?.chat_id ??
    job?.params?.meta?.chatId ??
    job?.chat_id ??
    null
  );
}

async function notifyJob(job, text) {
  const chatId = pickJobChatId(job);
  if (!chatId) return;

  const ns = pickJobNamespace(job);
  return ns === "it2" ? tg2Send(chatId, text) : tgSend(chatId, text);
}

const nowISO = () => new Date().toISOString();
const genRunId = () => `it2_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

function kstDateISO(d = new Date()) {
  // KST(UTC+9) 기준 YYYY-MM-DD
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  return kst.toISOString().slice(0, 10);
}

// ✅ auto-decide 호출(후콜) 유틸
async function callAutoDecide(payload) {
  const url = process.env.IT2_AUTO_DECIDE_URL;
  if (!url) {
    console.warn("[auto-decide] IT2_AUTO_DECIDE_URL not set");
    return;
  }

  // Node 18+ fetch 내장 / 하위버전 보완
  let _fetch = globalThis.fetch;
  if (!_fetch) {
    const mod = await import("node-fetch");
    _fetch = mod.default;
  }

  // 10초 타임아웃
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      console.warn("[auto-decide] non-200", res.status, json);
      return;
    }

    // 필요하면 로그
    // console.log("[auto-decide] ok", json);
    console.log(
      "[LOG]",
      JSON.stringify({
        event: "worker.auto_decide_called",
        ok: true,
        trace_id: payload?.trace_id,
      })
    );
  } catch (e) {
    console.warn("[auto-decide] failed", e?.message || String(e));
    console.log(
      "[LOG]",
      JSON.stringify({
        event: "worker.auto_decide_failed",
        ok: false,
        trace_id: payload?.trace_id,
        error: e?.message || String(e),
      })
    );
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────
// ✅ it2 최소 실행 로직 (MVP)
// ─────────────────────────────────────────
async function it2HealthCheck() {
  // 1) risk_snapshot_daily 테이블 조회 가능 여부
  const a = await supabase
    .from("risk_snapshot_daily")
    .select("snapshot_date, portfolio_id")
    .order("snapshot_date", { ascending: false })
    .limit(1);

  if (a.error) {
    return { ok: false, error: "RISK_SNAPSHOT_TABLE_ERROR", detail: a.error.message };
  }

  // 2) self_learning_log 테이블 조회 가능 여부
  const b = await supabase
    .from("self_learning_log")
    .select("event_ts, event_type")
    .order("event_ts", { ascending: false })
    .limit(1);

  if (b.error) {
    return { ok: false, error: "SELF_LEARNING_TABLE_ERROR", detail: b.error.message };
  }

  return {
    ok: true,
    tables: {
      risk_snapshot_daily: true,
      self_learning_log: true,
    },
    latest_snapshot: a.data?.[0] ?? null,
    latest_log: b.data?.[0] ?? null,
  };
}

// ✅ 여기만 나중에 “진짜 리스크 계산”으로 교체하면 됨
function computeDemoRiskSnapshot({ snapshot_date, portfolio_id }) {
  // 데모 값(파이프라인 검증용)
  const risk_score = 0.35 + Math.random() * 0.3; // 0.35~0.65
  return {
    snapshot_date,
    portfolio_id,
    engine_version: "v1",
    run_id: genRunId(),

    risk_score: Number(risk_score.toFixed(4)),
    risk_level: risk_score > 0.55 ? 3 : risk_score > 0.45 ? 2 : 1,

    features: { source: "demo", snapshot_date, portfolio_id },
    positions_summary: { items: [] },

    ok: true,
    latency_ms: null,
    notes: "demo snapshot",
    updated_at: nowISO(),
  };
}

async function it2SnapshotRun({ args, trace_id }) {
  const snapshot_date = args.snapshot_date || kstDateISO();
  const portfolio_id = args.portfolio_id || "default";
  const engine_version = args.engine_version || "v1";
  const dry_run = !!args.dry_run;
  const force = !!args.force;

  // force=false면 기존 스냅샷 있으면 스킵하는 것도 가능
  if (!force && !dry_run) {
    const exists = await supabase
      .from("risk_snapshot_daily")
      .select("snapshot_date")
      .eq("snapshot_date", snapshot_date)
      .eq("portfolio_id", portfolio_id)
      .limit(1);

    if (!exists.error && (exists.data?.length ?? 0) > 0) {
      return { ok: true, skipped: true, reason: "already_exists", snapshot_date, portfolio_id };
    }
  }

  const snap = computeDemoRiskSnapshot({ snapshot_date, portfolio_id });
  snap.engine_version = engine_version;

  // 1) decision 로그
  if (!dry_run) {
    const insDecision = await supabase.from("self_learning_log").insert({
      portfolio_id,
      snapshot_date,
      engine_version,
      trace_id,
      run_id: snap.run_id,
      event_type: "decision",
      input_features: snap.features,
      decision_payload: { rule: "demo_v1", computed: true },
      ok: true,
      latency_ms: null,
      created_at: nowISO(),
    });

    if (insDecision.error) {
      return { ok: false, error: "DECISION_LOG_INSERT_FAIL", detail: insDecision.error.message };
    }
  }

  // 2) 스냅샷 UPSERT
  if (!dry_run) {
    const up = await supabase.from("risk_snapshot_daily").upsert(
      {
        snapshot_date: snap.snapshot_date,
        portfolio_id: snap.portfolio_id,
        engine_version: snap.engine_version,
        run_id: snap.run_id,
        risk_score: snap.risk_score,
        risk_level: snap.risk_level,
        features: snap.features,
        positions_summary: snap.positions_summary,
        notes: snap.notes,
        ok: true,
        updated_at: nowISO(),
      },
      { onConflict: "snapshot_date,portfolio_id" }
    );

    if (up.error) {
      return { ok: false, error: "SNAPSHOT_UPSERT_FAIL", detail: up.error.message };
    }
  }

  // 3) result 로그
  if (!dry_run) {
    const insResult = await supabase.from("self_learning_log").insert({
      portfolio_id,
      snapshot_date,
      engine_version,
      trace_id,
      run_id: snap.run_id,
      event_type: "result",
      outcome_payload: { upserted: true },
      kpi: { risk_score: snap.risk_score, risk_level: snap.risk_level },
      reward: null,
      ok: true,
      latency_ms: null,
      created_at: nowISO(),
    });

    if (insResult.error) {
      return { ok: false, error: "RESULT_LOG_INSERT_FAIL", detail: insResult.error.message };
    }
  }

  return {
    ok: true,
    dry_run,
    force,
    snapshot_date,
    portfolio_id,
    metrics: { risk_score: snap.risk_score, risk_level: snap.risk_level },
  };
}

async function handleIt2Cmd(job) {
  const payload = job.params || {};
  const cmd = payload.cmd;
  const args = payload.args || {};
  const trace_id = job.trace_id;

  if (!cmd) return { ok: false, error: "NO_CMD_IN_PARAMS" };

  if (cmd === "health.check") return await it2HealthCheck();
  if (cmd === "snapshot.run") return await it2SnapshotRun({ args, trace_id });

  if (cmd === "snapshot.backfill") {
    const days = Number(args.days ?? 7);
    const portfolio_id = args.portfolio_id || "default";
    const engine_version = args.engine_version || "v1";
    const dry_run = !!args.dry_run;
    const force = !!args.force;

    const results = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const snapshot_date = kstDateISO(d);

      const r = await it2SnapshotRun({
        args: { snapshot_date, portfolio_id, engine_version, dry_run, force },
        trace_id,
      });

      results.push({ snapshot_date, ok: r.ok, skipped: r.skipped || false });
      if (!r.ok) return { ok: false, error: "BACKFILL_FAILED", detail: r };
    }

    return { ok: true, backfill_days: days, portfolio_id, results };
  }

  if (cmd === "score.v1") {
    const snapshot_date = args.snapshot_date || kstDateISO();
    const portfolio_id = args.portfolio_id || "default";
    const snap = computeDemoRiskSnapshot({ snapshot_date, portfolio_id });
    return {
      ok: true,
      snapshot_date,
      portfolio_id,
      metrics: { risk_score: snap.risk_score, risk_level: snap.risk_level },
    };
  }

  return { ok: false, error: "UNKNOWN_CMD", cmd };
}

// ─────────────────────────────────────────
// Worker 메인
// ─────────────────────────────────────────
export async function runWorkerOnce() {
  const startedAt = Date.now();

  try {
    // 1) 다음 PENDING job 하나 가져오기
    const job = await popNextJobForWorker(DEFAULT_WORKER_ID);

    // 2) Job 없으면 종료
    if (!job) {
      console.log(
        '[LOG] {"event":"worker.no_job","ok":true,"message":"대기 Job 없음","meta":{}}'
      );
      return { has_job: false, job: null };
    }

    console.log(
      "[LOG]",
      JSON.stringify({
        event: "worker.job_found",
        ok: true,
        id: job.id,
        trace_id: job.trace_id,
        type: job.type,
        status: job.status,
      })
    );

    // 3) 실제 작업 처리
    try {
      let result = { ok: true };

      // ✅ type 분기
      if (job.type === "it2_cmd") {
        result = await handleIt2Cmd(job);
      } else if (job.type === "it1_job") {
        // TODO: 실제 it1 실행 로직(n8n 호출 등)로 교체 예정
        // 지금은 STUB
        result = { ok: true, note: "stub_done" };
      } else {
        // 알 수 없는 타입은 실패 처리
        result = { ok: false, error: "UNKNOWN_JOB_TYPE", detail: job.type };
      }

      const latency_ms = Date.now() - startedAt;

      // 결과 로그(표준)
      console.log(
        "[LOG]",
        JSON.stringify({
          event: "worker.job_result",
          ok: !!result.ok,
          id: job.id,
          trace_id: job.trace_id,
          type: job.type,
          latency_ms,
          result,
        })
      );

      if (result.ok) {
        await markJobDone(job.id);

        // ✅ 핵심: it1_job 성공 시 auto-decide 후콜(payload로)
        if (job.type === "it1_job") {
          await callAutoDecide({
            trace_id: job.trace_id,
            job_id: job.id,
            job_type: job.type,
            ok: true,
            latency_ms,
            result,
            error: null,
          });
        }

        await notifyJob(
          job,
          `✅ 작업 완료\ntype: ${job.type}\ntrace_id: ${job.trace_id}\nlatency_ms: ${latency_ms}${
            result?.skipped ? "\n(skipped)" : ""
          }`
        );
      } else {
        await markJobFailed(job.id, result.error || "PROCESS_FAIL");

        // ✅ (권장) it1_job 실패도 auto-decide로 전달하면 retry/fork 판단 가능
        if (job.type === "it1_job") {
          await callAutoDecide({
            trace_id: job.trace_id,
            job_id: job.id,
            job_type: job.type,
            ok: false,
            latency_ms,
            result: null,
            error: { message: result.error || "PROCESS_FAIL", detail: result.detail ?? null },
          });
        }

        await notifyJob(
          job,
          `❌ 작업 실패\ntype: ${job.type}\ntrace_id: ${job.trace_id}\nerror: ${
            result.error || "PROCESS_FAIL"
          }`
        );
      }
    } catch (procErr) {
      const latency_ms = Date.now() - startedAt;

      console.error(
        "[LOG]",
        JSON.stringify({
          event: "worker.process_error",
          ok: false,
          id: job.id,
          trace_id: job.trace_id,
          type: job.type,
          error: procErr?.message || String(procErr),
        })
      );

      await markJobFailed(job.id, procErr?.message || String(procErr));

      // ✅ (권장) it1_job 예외도 auto-decide로 전달
      if (job.type === "it1_job") {
        await callAutoDecide({
          trace_id: job.trace_id,
          job_id: job.id,
          job_type: job.type,
          ok: false,
          latency_ms,
          result: null,
          error: { message: procErr?.message || String(procErr) },
        });
      }

      await notifyJob(
        job,
        `❌ 작업 처리 중 예외\ntrace_id: ${job.trace_id}\n${procErr?.message || String(procErr)}`
      );
    }

    return { has_job: true, job };
  } catch (e) {
    console.error(
      "[LOG]",
      JSON.stringify({
        event: "worker.error",
        ok: false,
        error: e?.message || String(e),
      })
    );
    throw e;
  }
}
