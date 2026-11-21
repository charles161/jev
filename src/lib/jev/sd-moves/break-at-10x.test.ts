import { describe, expect, it } from "vitest";
import { board } from "./__fixtures__/boards";
import { findBreakAt10x } from "./break-at-10x";

describe("Where does this break at 10×?", () => {
  it("names the single database on every read and write path of a 3-node board", () => {
    const b = board().shape("actor", "User").shape("node", "API").shape("database", "Orders DB");
    b.arrow("User", "API", "POST /orders").arrow("API", "Orders DB", "read/write");
    const r = findBreakAt10x(b.els);
    expect(r.status).toBe("found");
    expect(r.findings[0]).toMatchObject({ rule: "single-db", culpritId: b.id("Orders DB") });
    expect(r.findings[0].headline).toContain("Orders DB");
    expect(r.findings[0].fixes.length).toBeGreaterThanOrEqual(1);
    expect(r.findings[0].fixes.length).toBeLessThanOrEqual(3);
    expect(r.findings[0].fixes.join(" ")).toMatch(/cache/i);
  });

  it("a cache and a read replica in front of the database clear the single-DB rule", () => {
    const b = board()
      .shape("actor", "User")
      .shape("lb", "ALB")
      .shape("node", "API")
      .shape("cache", "Redis")
      .shape("database", "Orders DB")
      .shape("database", "Orders read replica");
    b.arrow("User", "ALB").arrow("ALB", "API").arrow("API", "Redis", "get").arrow("API", "Orders DB", "write");
    b.arrow("Orders DB", "Orders read replica", "replicate").arrow("API", "Orders read replica", "read");
    const r = findBreakAt10x(b.els);
    expect(r.status).toBe("clean");
    expect(r.findings).toEqual([]);
    expect(r.checked.length).toBeGreaterThanOrEqual(5);
  });

  it("a service that calls four services synchronously is a fan-out bottleneck", () => {
    const b = board().shape("lb", "LB").shape("node", "Feed API");
    for (const s of ["Users", "Posts", "Ads", "Ranking"]) b.shape("node", `${s} svc`);
    b.shape("cache", "Feed cache").shape("database", "Feed DB").shape("database", "Feed replica");
    b.arrow("LB", "Feed API");
    for (const s of ["Users", "Posts", "Ads", "Ranking"]) b.arrow("Feed API", `${s} svc`, "gRPC");
    b.arrow("Feed API", "Feed cache").arrow("Feed API", "Feed DB").arrow("Feed DB", "Feed replica");
    const r = findBreakAt10x(b.els);
    expect(r.findings[0]).toMatchObject({ rule: "sync-fan-out", culpritId: b.id("Feed API") });
    expect(r.findings[0].headline).toMatch(/4/);
  });

  it("an async (dashed) call does not count toward fan-out", () => {
    const b = board().shape("lb", "LB").shape("node", "API").shape("node", "A").shape("node", "B").shape("node", "C");
    b.arrow("LB", "API").arrow("API", "A").arrow("API", "B").arrow("API", "C", "", { dashed: true });
    expect(findBreakAt10x(b.els).findings.map((f) => f.rule)).not.toContain("sync-fan-out");
  });

  it("a client straight to one service with no load balancer anywhere", () => {
    const b = board().shape("actor", "User").shape("node", "API").shape("cache", "Cache").shape("database", "DB").shape("database", "DB replica");
    b.arrow("User", "API").arrow("API", "Cache").arrow("API", "DB").arrow("DB", "DB replica");
    const r = findBreakAt10x(b.els);
    expect(r.findings[0]).toMatchObject({ rule: "no-lb", culpritId: b.id("API") });
  });

  it("a third party called synchronously on the request path", () => {
    const b = board().shape("actor", "User").shape("lb", "LB").shape("node", "Checkout").shape("external", "Stripe");
    b.arrow("User", "LB").arrow("LB", "Checkout").arrow("Checkout", "Stripe", "charge");
    const r = findBreakAt10x(b.els);
    expect(r.findings[0]).toMatchObject({ rule: "third-party", culpritId: b.id("Stripe") });
  });

  it("a queue drained by one consumer, and a queue nobody drains", () => {
    const b = board().shape("lb", "LB").shape("node", "API").shape("queue", "Kafka").shape("node", "Worker").shape("queue", "Emails");
    b.arrow("LB", "API").arrow("API", "Kafka").arrow("Kafka", "Worker").arrow("API", "Emails");
    const rules = findBreakAt10x(b.els).findings.map((f) => [f.rule, f.culpritId]);
    expect(rules).toContainEqual(["one-consumer", b.id("Kafka")]);
    expect(rules).toContainEqual(["no-consumer", b.id("Emails")]);
  });

  it("a global counter is a hot key, ranked first", () => {
    const b = board().shape("lb", "LB").shape("node", "API").shape("cache", "Global counter");
    b.arrow("LB", "API").arrow("API", "Global counter", "INCR");
    expect(findBreakAt10x(b.els).findings[0]).toMatchObject({ rule: "hot-key", culpritId: b.id("Global counter") });
  });

  it("says the board is empty instead of inventing a bottleneck", () => {
    expect(findBreakAt10x([]).status).toBe("empty");
    expect(findBreakAt10x(board().shape("node", "API").els).status).toBe("empty");
  });
});
