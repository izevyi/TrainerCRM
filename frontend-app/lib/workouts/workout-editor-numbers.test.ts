import { describe, expect, it } from "vitest";
import { formatWorkoutWeight, parseWorkoutNumber, stepWorkoutNumber } from "./workout-editor-numbers";

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

  it("steps weight in half-kilograms and reps in whole numbers", () => {
    expect(stepWorkoutNumber("weight", "47,5", 1)).toBe("48");
    expect(stepWorkoutNumber("weight", "48", -1)).toBe("47,5");
    expect(stepWorkoutNumber("reps", "9", 1)).toBe("10");
    expect(stepWorkoutNumber("reps", "10", -1)).toBe("9");
  });

  it("respects limits without wrapping or creating invalid numbers", () => {
    expect(stepWorkoutNumber("weight", "0", -1)).toBeNull();
    expect(stepWorkoutNumber("weight", "1000", 1)).toBeNull();
    expect(stepWorkoutNumber("reps", "0", -1)).toBeNull();
    expect(stepWorkoutNumber("reps", "10000", 1)).toBeNull();
    expect(stepWorkoutNumber("weight", "999,5", 1)).toBe("1000");
    expect(stepWorkoutNumber("reps", "9999", 1)).toBe("10000");
  });

  it("disables stepping invalid drafts instead of silently rounding them", () => {
    expect(stepWorkoutNumber("weight", "47,3", 1)).toBeNull();
    expect(stepWorkoutNumber("weight", "", -1)).toBeNull();
    expect(stepWorkoutNumber("reps", "1,5", 1)).toBeNull();
  });
});
