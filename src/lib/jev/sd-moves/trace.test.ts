import { describe, expect, it } from "vitest";
import { board } from "./__fixtures__/boards";
import { traceRequest } from "./trace";

function readWriteBoard() {
  const b = board()
    .shape("actor", "User")
    .shape("lb", "LB")
    .shape("node", "API")
    .shape("cache", "Redis")
    .shape("database", "Postgres")
    .shape("queue", "Kafka")
    .shape("node", "Indexer");
  b.arrow("User", "LB").arrow("LB", "API");
  b.arrow("API", "Redis", "GET hot keys").arrow("Redis", "Postgres", "miss");
  b.arrow("API", "Kafka", "publish write").arrow("Kafka", "Indexer").arrow("Indexer", "Postgres", "INSERT");
  return b;
}

const path = (b: ReturnType<typeof board>, steps: Array<{ fromId: string; toId: string }>) =>
  steps.map((s) => b.els.find((e) => e.id === s.fromId)!.label).concat(steps.length ? [b.els.find((e) => e.id === steps[steps.length - 1].toId)!.label] : []);

describe("Trace request", () => {
  it("the read path goes from the client through the cache to the database, numbered from 1", () => {
    const b = readWriteBoard();
    const r = traceRequest(b.els, { path: "read" });
    expect(path(b, r.steps)).toEqual(["User", "LB", "API", "Redis", "Postgres"]);
    expect(r.steps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(r.startId).toBe(b.id("User"));
  });

  it("the write path takes the publish arrow through the queue and worker", () => {
    const b = readWriteBoard();
    const r = traceRequest(b.els, { path: "write" });
    expect(path(b, r.steps)).toEqual(["User", "LB", "API", "Kafka", "Indexer", "Postgres"]);
  });

  it("starts at a selected node instead of the client", () => {
    const b = readWriteBoard();
    const r = traceRequest(b.els, { path: "write", startId: b.id("API") });
    expect(path(b, r.steps)).toEqual(["API", "Kafka", "Indexer", "Postgres"]);
  });

  it("a selected node with no outgoing arrows (a database) traces from the client instead", () => {
    const b = readWriteBoard();
    const r = traceRequest(b.els, { path: "read", startId: b.id("Postgres") });
    expect(r.startId).toBe(b.id("User"));
    expect(r.steps.length).toBe(4);
  });

  it("never loops on a cycle", () => {
    const b = board().shape("node", "A").shape("node", "B").shape("node", "C");
    b.arrow("A", "B").arrow("B", "C").arrow("C", "A");
    const r = traceRequest(b.els, { path: "read", startId: b.id("A") });
    expect(path(b, r.steps)).toEqual(["A", "B", "C"]);
  });

  it("reports honestly when there is nothing to trace", () => {
    expect(traceRequest([], { path: "read" }).steps).toEqual([]);
    const lonely = board().shape("node", "API");
    const r = traceRequest(lonely.els, { path: "read" });
    expect(r.steps).toEqual([]);
    expect(r.reason).toMatch(/arrow/i);
  });
});
