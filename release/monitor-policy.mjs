export const MONITOR_INTERVAL_MS = 60 * 60 * 1000;

function issueDetail(check) {
  if (check.ok && check.latencyMs > 3_000) return `${check.path}: slow response (${check.latencyMs}ms)`;
  if (check.error) return `${check.path}: request failed after ${check.latencyMs}ms (${check.error})`;
  return `${check.path}: HTTP ${check.status || "offline"} after ${check.latencyMs}ms`;
}

export function createMonitorIssueReport(checks) {
  const issueChecks = checks.filter(check => !check.ok || check.latencyMs > 3_000);
  const details = issueChecks.map(issueDetail);
  return {
    subject: `ChessAlive monitoring issue: ${issueChecks.map(check => check.path).join(", ")}`,
    summary: `Production monitoring found ${details.length} issue${details.length === 1 ? "" : "s"}:\n${details.join("\n")}`,
    details,
  };
}

export function nextMonitorIncidentState(active, level) {
  if (level === "green") return { active: false, shouldNotify: false };
  return { active: true, shouldNotify: !active };
}
