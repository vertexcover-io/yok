import { expect, test } from "bun:test";
import { discount } from "./discount";

test("no code leaves the total alone", () => {
  expect(discount(40, undefined)).toBe(40);
});

test("HALF halves the total", () => {
  expect(discount(40, "HALF")).toBe(20);
});

test("any other code takes five off", () => {
  expect(discount(40, "FIVE")).toBe(35);
});

test("another code also takes five off", () => {
  expect(discount(50, "SAVE")).toBe(45);
});

test("a small total ignores a non-HALF code", () => {
  expect(discount(8, "FIVE")).toBe(8);
});

test("no code leaves a small total alone too", () => {
  expect(discount(8, undefined)).toBe(8);
});
