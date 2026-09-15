import { expect, it } from "vitest";
import { acquireSharedRuntime } from "../src/shared-runtime.js";

it("shares state until the last registry is released, with idempotent cleanup", () => {
  const first = acquireSharedRuntime("leases", () => ({ active: true }));
  const second = acquireSharedRuntime("leases", () => ({ active: false }));
  expect(second.value).toBe(first.value);
  expect(first.release()).toBe(false);
  expect(first.release()).toBe(false);
  expect(second.release()).toBe(true);
  const reloaded = acquireSharedRuntime("leases", () => ({ active: false }));
  expect(reloaded.value).not.toBe(first.value);
  reloaded.release();
});

it("isolates different runtime identities", () => {
  const first = acquireSharedRuntime("identity-a", () => ({}));
  const second = acquireSharedRuntime("identity-b", () => ({}));
  expect(second.value).not.toBe(first.value);
  first.release();
  second.release();
});
