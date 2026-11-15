import { describe, expect, it } from "vitest";
import { formatWorkoutWeight, parseWorkoutNumber } from "./workout-editor-numbers";

describe("workout editor numbers", () => {
  it.each([
    ["50", 50], ["50.5", 50.5], ["50,5", 50.5], ["0", 0],
  ])("accepts whole and half-kilogram weight %s", (draft, expected) => {
    expect(parseWorkoutNumber("weight", draft)).toBe(expected);
  });

  it.each(["50.1", "50,25", "-0.5", "", "1,2.3", "Infinity"])(
    "rejects invalid weight precision without rounding: %s",
    (draft) => expect(parseWorkoutNumber("weight", draft)).toBeNull(),
  );

  it.each([["0", 0], ["12", 12]])("accepts integer repetitions %s", (draft, expected) => {
    expect(parseWorkoutNumber("reps", draft)).toBe(expected);
  });

  it.each(["1.0", "1,5", "-1", "", "10001"])("rejects invalid repetitions %s", (draft) => {
    expect(parseWorkoutNumber("reps", draft)).toBeNull();
  });

  it("formats database numbers without unnecessary precision using a decimal comma", () => {
    expect(formatWorkoutWeight(50)).toBe("50");
    expect(formatWorkoutWeight(50.5)).toBe("50,5");
    expect(formatWorkoutWeight(40.3)).toBe("40,3");
  });
});
