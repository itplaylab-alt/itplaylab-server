// lib/opLabels.js  (Node 18+ / ESM)

// 라벨 상수
export const LANES = Object.freeze({
  FAST: "LANE_FAST",
  STANDARD: "LANE_STANDARD",
  SAFE: "LANE_SAFE",
});

export const WHATS = Object.freeze({
  DB_DDL: "DB_DDL",
  DB_DML: "DB_DML",
  APP_CODE: "APP_CODE",
  ENV_CHANGE: "ENV_CHANGE",
  SCHEDULER: "SCHEDULER",
});

export const SCOPES = Object.freeze({
  BASE: "SCOPE_BASE",
  IT2: "SCOPE_IT2",
  IT1: "SCOPE_IT1",
  SHARED: "SCOPE_SHARED",
});

export const RISKS = Object.freeze({
  DESTRUCTIVE: "RISK_DESTRUCTIVE",
  COST: "RISK_COST",
  CONCURRENCY: "RISK_CONCURRENCY",
  IRREVERSIBLE: "RISK_IRREVERSIBLE",
});

export const POLICIES = Object.freeze({
  IDEMPOTENT_REQUIRED: "POLICY_IDEMPOTENT_REQUIRED",
  LOCK_REQUIRED: "POLICY_LOCK_REQUIRED",
  APPROVAL_REQUIRED: "POLICY_APPROVAL_REQUIRED",
});

export function buildLabels({
  lane,
  what,
  scope,
  risk_flags = [],
  policies = [],
  execution_mode = "LIVE_RUN", // FAST_TEST | DRY_RUN | LIVE_RUN
}) {
  return {
    lane,
    what,
    scope,
    risk_flags: Array.from(new Set(risk_flags)),
    policies: Array.from(new Set(policies)),
    execution_mode,
    v: 1,
  };
}

// it2 명령 자동 라벨링 규칙 (v1)
export function labelsForIt2Command(cmd, args = {}) {
  // 기본값
  let lane = LANES.STANDARD;
  let what = WHATS.DB_DML;
  let scope = SCOPES.IT2;
  let risk_flags = [RISKS.CONCURRENCY];
  let policies = [POLICIES.IDEMPOTENT_REQUIRED, POLICIES.LOCK_REQUIRED];
  let execution_mode = args?.dry_run ? "DRY_RUN" : "LIVE_RUN";

  if (cmd === "health.check") {
    lane = LANES.FAST;
    what = WHATS.APP_CODE;
    risk_flags = [];
    policies = [];
    execution_mode = "FAST_TEST";
  }

  if (cmd === "snapshot.run") {
    lane = LANES.STANDARD;
    what = WHATS.DB_DML;
    // 실험 단계라도 동시성/중복이 핵심 위험
    risk_flags = [RISKS.CONCURRENCY];
    policies = [POLICIES.IDEMPOTENT_REQUIRED, POLICIES.LOCK_REQUIRED];
  }

  if (cmd === "score.v1") {
    lane = LANES.STANDARD;
    what = WHATS.DB_DML;
    risk_flags = [RISKS.CONCURRENCY];
    policies = [POLICIES.IDEMPOTENT_REQUIRED, POLICIES.LOCK_REQUIRED];
  }

  if (cmd === "snapshot.backfill") {
    // 대용량/장시간 작업: Safe로 올림
    lane = LANES.SAFE;
    what = WHATS.DB_DML;
    risk_flags = [RISKS.CONCURRENCY];
    policies = [
      POLICIES.IDEMPOTENT_REQUIRED,
      POLICIES.LOCK_REQUIRED,
      POLICIES.APPROVAL_REQUIRED, // 백필은 승인 요구(기본)
    ];
    execution_mode = "LIVE_RUN";
  }

  return buildLabels({ lane, what, scope, risk_flags, policies, execution_mode });
}
