import test from "node:test";
import assert from "node:assert/strict";
import { contextOptions, selectContext } from "../dist/contexts.js";

const personal = { contextType: "CONSUMER", organizationId: null };
const organization = { contextType: "ORGANIZATION", organizationId: 7, organizationName: "Boutique Paris" };
const platform = { contextType: "PLATFORM", organizationId: 81, organizationName: "LookAndTry Platform" };
const options = () => contextOptions({ currentContext: personal, availableContexts: [organization, platform] });

test("context discovery includes the verified personal context and names each available membership", () => {
  const actual = options();
  assert.deepEqual(actual.map(o => o.label), ["Personnel", "Organisation Boutique Paris", "Administration plateforme"]);
  assert.deepEqual(actual[2].context, { contextType: "PLATFORM", organizationId: 81 });
  assert.equal(contextOptions({ currentContext: personal, availableContexts: [personal, organization, organization] }).length, 2);
});

test("one available context is selected automatically without prompting", async () => {
  const actual = await selectContext(contextOptions({ currentContext: personal, availableContexts: [] }), {}, async () => { throw new Error("Must not prompt"); });
  assert.deepEqual(actual, personal);
});

test("several contexts prompt with names and return only an offered context", async () => {
  const actual = await selectContext(options(), {}, async choices => {
    assert.equal(choices[2].label, "Administration plateforme"); return 2;
  });
  assert.deepEqual(actual, { contextType: "PLATFORM", organizationId: 81 });
  await assert.rejects(selectContext(options(), {}, async () => 9), /Invalid context selection/);
});

test("platform selector resolves its system organization ID from the offered contexts", async () => {
  const actual = await selectContext(options(), { contextType: "PLATFORM" }, async () => { throw new Error("Must not prompt"); });
  assert.deepEqual(actual, { contextType: "PLATFORM", organizationId: 81 });
  await assert.rejects(selectContext(options(), { contextType: "PLATFORM", organizationId: 1 }), /No accessible context/);
});

test("noninteractive ambiguous login requires an explicit offered context and never chooses a default", async () => {
  await assert.rejects(selectContext(options()), /Several contexts are available/);
});

test("malformed context contracts are rejected rather than guessed", () => {
  assert.throws(() => contextOptions({ currentContext: personal, availableContexts: [{ ...platform, organizationId: null }] }));
  assert.throws(() => contextOptions({ currentContext: personal }));
});
