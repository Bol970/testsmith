import type { ServerResponse } from "node:http";
import type { JobPhase, JobStatus, RunnerEvent } from "../../shared/types.js";

const MAX_EVENTS = 2_000;
type EventInput = RunnerEvent extends infer Event
  ? Event extends RunnerEvent
    ? Omit<Event, "id" | "at">
    : never
  : never;

export class EventStream {
  private nextId = 1;
  private readonly events: RunnerEvent[] = [];
  private readonly clients = new Set<ServerResponse>();

  status(phase: JobPhase, message: string): void {
    this.emit({ type: "job_status", phase, message });
  }

  text(value: string): void {
    const text = sanitizeText(value, 8_000);
    if (text) this.emit({ type: "agent_text", text });
  }

  toolStart(toolCallId: string, toolName: string, summary: string): void {
    this.emit({
      type: "tool_start",
      toolCallId: sanitizeText(toolCallId, 120),
      toolName: sanitizeText(toolName, 100),
      summary: sanitizeText(summary, 500)
    });
  }

  toolEnd(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    summary: string,
    durationMs: number
  ): void {
    this.emit({
      type: "tool_end",
      toolCallId: sanitizeText(toolCallId, 120),
      toolName: sanitizeText(toolName, 100),
      isError,
      summary: sanitizeText(summary, 500),
      durationMs
    });
  }

  done(status: JobStatus, message: string): void {
    this.emit({ type: "job_done", status, message: sanitizeText(message, 1_000) });
  }

  error(message: string): void {
    this.emit({ type: "runner_error", message: sanitizeText(message, 1_000) });
  }

  attach(response: ServerResponse, lastEventId: number): void {
    for (const event of this.events) {
      if (event.id > lastEventId) response.write(encodeEvent(event));
    }
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  keepAlive(): void {
    for (const client of this.clients) client.write(": keepalive\n\n");
  }

  private emit(event: EventInput): void {
    const normalized = {
      ...event,
      id: this.nextId++,
      at: new Date().toISOString()
    } as RunnerEvent;
    this.events.push(normalized);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const frame = encodeEvent(normalized);
    for (const client of this.clients) client.write(frame);
  }
}

function encodeEvent(event: RunnerEvent): string {
  return "id: " + String(event.id) + "\nevent: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

export function sanitizeText(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/(?:sk-or-v1-|sk-or-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .slice(0, limit);
}
