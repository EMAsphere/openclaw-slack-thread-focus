import type { ProgressCard, ProgressTransport } from "./progress-slack.js";
import type { FocusDecision, PluginLogger, ThreadReference } from "./types.js";

export type ProgressEvent = {
  runId: string; seq: number; stream: string; ts: number;
  sessionKey?: string; agentId?: string; data: Record<string, unknown>;
};
type Route = { reference: ThreadReference; sessionKey: string; expires: number; armed: boolean };
type Step = { text: string; status: "pending" | "active" | "done" | "error" };
type Run = {
  route: Route; seq: number; started: number; tools: Map<string, Step>; plan: Step[];
  status: "active" | "done" | "error" | "stopped"; messageTs?: string;
  dirty: boolean; disabled: boolean; busy: boolean; lastWrite: number;
  timer?: ReturnType<typeof setTimeout>;
};
const ROUTE_TTL = 10 * 60_000;
const RUN_TTL = 6 * 60 * 60_000;
const LIMIT = 256;
const UPDATE_INTERVAL = 1500;

function text(value: unknown, limit = 160): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").slice(0, limit) : "";
}

function status(value: unknown): Step["status"] {
  if (value === "completed") return "done";
  if (value === "in_progress") return "active";
  return "pending";
}

/** Correlates only recently received Slack turns, never guesses destinations from events. */
export class ProgressCards {
  private readonly routes = new Map<string, Route>();
  private readonly runs = new Map<string, Run>();
  private readonly finished = new Map<string, number>();

  constructor(
    private readonly transport: ProgressTransport,
    private readonly checkFocus: (reference: ThreadReference) => Promise<FocusDecision>,
    private readonly logger: PluginLogger,
    private readonly accountId: string,
    private readonly now: () => number = Date.now,
  ) {}

  rememberInbound(sessionKey: string | undefined, reference: ThreadReference): void {
    this.prune();
    // One configured token owns one account. Ignore other accounts even when channel ids collide.
    if (!sessionKey || reference.accountId !== this.accountId ||
      !/^[CGD][A-Z0-9]+$/.test(reference.channelId) || !/^\d+\.\d+$/.test(reference.threadTs)) return;
    const key = sessionKey.toLowerCase();
    if (this.routes.size >= LIMIT && !this.routes.has(key)) return;
    this.routes.set(key, { reference: { ...reference }, sessionKey: key, expires: this.now() + ROUTE_TTL, armed: false });
    this.logger.info?.(`slack-thread-focus: progress received ${key}`);
  }

  authorizeReply(sessionKey: string | undefined, trigger: string | undefined): void {
    const route = sessionKey ? this.routes.get(sessionKey.toLowerCase()) : undefined;
    if (route) route.armed = trigger === "user";
    if (route || sessionKey?.includes(":slack:")) {
      this.logger.info?.(`slack-thread-focus: progress reply ${sessionKey} trigger=${trigger ?? "unknown"} route=${route ? "found" : "missing"}`);
    }
  }

  handle(event: ProgressEvent): void {
    this.prune();
    if (this.finished.has(event.runId)) return;
    let run = this.runs.get(event.runId);
    if (!run) {
      const key = event.sessionKey?.toLowerCase();
      const route = key ? this.routes.get(key) : undefined;
      if (!route?.armed || this.runs.size >= LIMIT ||
        (event.agentId && event.agentId !== route.reference.agentId)) return;
      // A terminal event alone must not consume a route intended for the next turn.
      if (event.stream === "lifecycle" && event.data.phase !== "start") return;
      this.routes.delete(route.sessionKey);
      run = { route, seq: -1, started: this.now(), tools: new Map(), plan: [],
        status: "active", dirty: false, disabled: false, busy: false, lastWrite: -Infinity };
      this.runs.set(event.runId, run);
      this.logger.info?.(`slack-thread-focus: progress tracking run ${event.runId}`);
    }
    if (event.sessionKey && event.sessionKey.toLowerCase() !== run.route.sessionKey) return;
    if (event.seq <= run.seq || run.status !== "active" || run.disabled) return;
    run.seq = event.seq;
    if (event.stream === "tool") {
      const id = text(event.data.toolCallId ?? event.data.itemId, 256);
      const name = text(event.data.name, 80);
      if (!id || !name || !["start", "result"].includes(String(event.data.phase))) return;
      const old = run.tools.get(id);
      // Some harnesses reuse sequence ranges; a late start must not undo a result.
      if (old && old.status !== "active" && event.data.phase === "start") return;
      run.tools.set(id, { text: name, status: event.data.phase === "start" ? "active"
        : event.data.isError === true || event.data.status === "failed" ? "error" : "done" });
      if (run.tools.size > 32) run.tools.delete(run.tools.keys().next().value!);
    } else if (event.stream === "plan") {
      if (!Array.isArray(event.data.steps)) return;
      run.plan = event.data.steps.slice(0, 8).flatMap((value: unknown) => {
        if (!value || typeof value !== "object") return [];
        const step = value as Record<string, unknown>;
        const label = text(step.step);
        return label ? [{ text: label, status: status(step.status) }] : [];
      });
    } else if (event.stream === "lifecycle") {
      if (event.data.phase !== "end" && event.data.phase !== "error") return;
      run.status = event.data.aborted === true ? "stopped"
        : event.data.phase === "error" ? "error" : "done";
    } else return;
    run.dirty = true;
    this.schedule(event.runId, run);
  }

  cleanup(scope: { runId?: string; sessionKey?: string } = {}): void {
    for (const [id, run] of this.runs) {
      if (scope.runId && id !== scope.runId) continue;
      if (scope.sessionKey && run.route.sessionKey !== scope.sessionKey.toLowerCase()) continue;
      run.disabled = true;
      if (run.timer) clearTimeout(run.timer);
      this.runs.delete(id);
    }
    if (scope.sessionKey) this.routes.delete(scope.sessionKey.toLowerCase());
    else if (!scope.runId) { this.routes.clear(); this.finished.clear(); }
  }

  private prune(): void {
    for (const [key, route] of this.routes) if (route.expires <= this.now()) this.routes.delete(key);
    for (const [id, expires] of this.finished) if (expires <= this.now()) this.finished.delete(id);
    for (const [id, run] of this.runs) if (run.started + RUN_TTL <= this.now()) this.cleanup({ runId: id });
  }

  private schedule(id: string, run: Run): void {
    if (run.busy || run.timer || run.disabled) return;
    const delay = Math.max(0, run.lastWrite + UPDATE_INTERVAL - this.now());
    run.timer = setTimeout(() => {
      delete run.timer;
      void this.flush(id, run);
    }, delay);
    run.timer.unref();
  }

  private async flush(id: string, run: Run): Promise<void> {
    if (run.disabled) return;
    run.busy = true;
    run.dirty = false;
    try {
      if (run.tools.size || run.plan.length) {
        const focus = await this.checkFocus(run.route.reference);
        if (run.disabled) return;
        if (focus.muted) {
          run.disabled = true;
          if (run.messageTs) await this.transport.remove(run.route.reference, run.messageTs);
        } else if (focus.source === "slack" || focus.source === "mention") {
          const card = renderCard(run);
          run.lastWrite = this.now();
          if (run.messageTs) await this.transport.update(run.route.reference, run.messageTs, card);
          else {
            run.messageTs = await this.transport.post(run.route.reference, card);
            this.logger.info?.(`slack-thread-focus: progress card posted for run ${id}`);
          }
        }
      }
    } catch (error) {
      run.disabled = true;
      this.logger.warn?.(`slack-thread-focus: progress stopped for run ${id} (${String(error)})`);
    } finally {
      run.busy = false;
      if (run.disabled || (run.status !== "active" && !run.dirty)) {
        this.runs.delete(id);
        this.finished.set(id, this.now() + RUN_TTL);
        if (this.finished.size > LIMIT) this.finished.delete(this.finished.keys().next().value!);
      } else if (run.dirty) this.schedule(id, run);
    }
  }
}

function renderCard(run: Run): ProgressCard {
  const labels = { active: "En cours", done: "Terminé", error: "Échec", stopped: "Interrompu" };
  const icons = { pending: "○", active: "⏳", done: "✓", error: "✗" };
  const heading = `Progression de la tâche · ${labels[run.status]}`;
  const steps = run.plan.length ? run.plan : [...run.tools.values()].slice(-8);
  const lines = steps.map((step) => `${icons[step.status]} ${step.text}`);
  const active = [...run.tools.values()].filter((step) => step.status === "active");
  if (run.plan.length && active.length) lines.push(`Outil en cours : ${active.map((s) => s.text).join(", ")}`);
  return {
    text: heading,
    blocks: [
      { type: "header", text: { type: "plain_text", text: heading, emoji: true } },
      { type: "section", text: { type: "plain_text", text: lines.join("\n").slice(0, 2800), emoji: true } },
    ],
  };
}
