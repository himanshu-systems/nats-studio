import { describe, expect, it } from "vitest";
import { subjectsOverlap } from "./ConsumersView";

describe("subjectsOverlap", () => {
  it("matches identical literal subjects", () => {
    expect(subjectsOverlap("orders.new", "orders.new")).toBe(true);
  });

  it("doesn't match unrelated literal subjects", () => {
    expect(subjectsOverlap("orders.new", "shipping.new")).toBe(false);
  });

  it("matches a stream '>' wildcard against any deeper concrete filter", () => {
    expect(subjectsOverlap("orders.>", "orders.new.created")).toBe(true);
  });

  it("matches a stream '*' wildcard against one concrete token", () => {
    expect(subjectsOverlap("orders.*", "orders.new")).toBe(true);
  });

  it("doesn't match '*' against a deeper/shorter path", () => {
    expect(subjectsOverlap("orders.*", "orders.new.created")).toBe(false);
    expect(subjectsOverlap("orders.*", "orders")).toBe(false);
  });

  it("doesn't match when the filter is a completely different top-level token", () => {
    expect(subjectsOverlap("orders.>", "shipping.new")).toBe(false);
  });

  it("matches when both sides use wildcards that align", () => {
    expect(subjectsOverlap("orders.*.created", "orders.priority.*")).toBe(true);
  });

  it("is order-independent (a vs b, b vs a agree)", () => {
    expect(subjectsOverlap("orders.>", "orders.new")).toBe(subjectsOverlap("orders.new", "orders.>"));
  });
});
