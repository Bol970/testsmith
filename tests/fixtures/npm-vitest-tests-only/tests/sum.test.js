import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "../src/sum.js";

test("adds values", () => assert.equal(sum(2, 3), 5));
