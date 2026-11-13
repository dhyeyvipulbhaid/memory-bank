import { expect, test } from "bun:test";
import { parseTimeWindow } from "../src/time-window.ts";

const NOW = new Date("2026-11-13T12:00:00.000Z");

test("last week is the previous Monday-Sunday in UTC", () => {
  expect(parseTimeWindow("what did I do last week", NOW)).toEqual({
    startMs: Date.parse("2026-11-02T00:00:00.000Z"),
    endMs: Date.parse("2026-11-09T00:00:00.000Z"),
  });
});

test("yesterday, today, and an explicit date are single UTC days", () => {
  expect(parseTimeWindow("yesterday's note", NOW)).toEqual({
    startMs: Date.parse("2026-11-12T00:00:00.000Z"),
    endMs: Date.parse("2026-11-13T00:00:00.000Z"),
  });
  expect(parseTimeWindow("today", NOW)?.startMs).toBe(Date.parse("2026-11-13T00:00:00.000Z"));
  expect(parseTimeWindow("on 2024-05-02", NOW)).toEqual({
    startMs: Date.parse("2024-05-02T00:00:00.000Z"),
    endMs: Date.parse("2024-05-03T00:00:00.000Z"),
  });
  expect(parseTimeWindow("March 3, 2024", NOW)).toEqual({
    startMs: Date.parse("2024-03-03T00:00:00.000Z"),
    endMs: Date.parse("2024-03-04T00:00:00.000Z"),
  });
});

test("in March uses the latest March that has started", () => {
  expect(parseTimeWindow("in March", NOW)).toEqual({
    startMs: Date.parse("2026-03-01T00:00:00.000Z"),
    endMs: Date.parse("2026-04-01T00:00:00.000Z"),
  });
  expect(parseTimeWindow("in March 2024", NOW)).toEqual({
    startMs: Date.parse("2024-03-01T00:00:00.000Z"),
    endMs: Date.parse("2024-04-01T00:00:00.000Z"),
  });
  const february = new Date("2026-02-01T00:00:00.000Z");
  expect(parseTimeWindow("in March", february)?.startMs).toBe(Date.parse("2025-03-01T00:00:00.000Z"));
});

test("a query with no time cue has no window", () => {
  expect(parseTimeWindow("northwind beacon", NOW)).toBeNull();
});
