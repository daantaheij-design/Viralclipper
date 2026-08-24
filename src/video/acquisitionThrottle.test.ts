import { test } from "node:test";
import assert from "node:assert/strict";
import { AcquisitionCircuitBreaker } from "./acquisitionThrottle";

test("AcquisitionCircuitBreaker: opens after `threshold` consecutive blocks", () => {
  const breaker = new AcquisitionCircuitBreaker(3);
  assert.equal(breaker.recordBlocked(), false);
  assert.equal(breaker.recordBlocked(), false);
  assert.equal(breaker.recordBlocked(), true);
  assert.equal(breaker.isOpen, true);
});

test("AcquisitionCircuitBreaker: a non-blocked result resets the streak", () => {
  const breaker = new AcquisitionCircuitBreaker(3);
  breaker.recordBlocked();
  breaker.recordBlocked();
  breaker.recordNotBlocked();
  assert.equal(breaker.recordBlocked(), false); // streak of 1, not 3 — would have tripped without the reset
  assert.equal(breaker.isOpen, false);
});
