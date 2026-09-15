// The wasm module itself, loaded via `initSync` under Node (docs/DESIGN.md
// §10): schema present, a put_node -> query round trip through `call`, and
// R5 (release payload is byte-identical whether a request is ungranted or
// granted-but-non-matching — omission is indistinguishable from absence).
//
// Requires `npm run build:wasm` to have produced pkg/lattice_wasm.js and
// pkg/lattice_wasm_bg.wasm first (this suite loads the build output, it
// doesn't build it).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDir = path.dirname(fileURLToPath(import.meta.url)); // web/test
const rootDir = path.dirname(path.dirname(testDir)); // repo root
const pkgDir = path.join(rootDir, "pkg");

let Lattice;

beforeAll(async () => {
  if (!existsSync(path.join(pkgDir, "lattice_wasm_bg.wasm"))) {
    throw new Error("pkg/lattice_wasm_bg.wasm is missing — run `npm run build:wasm` first");
  }
  const mod = await import(path.join(pkgDir, "lattice_wasm.js"));
  const wasmBytes = readFileSync(path.join(pkgDir, "lattice_wasm_bg.wasm"));
  mod.initSync({ module: wasmBytes });
  Lattice = mod.Lattice;
});

function call(lattice, op, args) {
  return JSON.parse(lattice.call(op, JSON.stringify(args ?? {})));
}

function expectOk(result) {
  if (result.error) {
    throw new Error(`unexpected error from call: ${JSON.stringify(result.error)}`);
  }
  return result.ok;
}

describe("Lattice (wasm)", () => {
  it("exposes the schema statically, before any open/load", () => {
    const lattice = new Lattice();
    const schema = JSON.parse(lattice.schemaJson());
    expect(schema.version).toBe(1);
    expect(schema.compartments).toEqual(
      expect.arrayContaining(["identity", "preferences", "system"]),
    );
    expect(schema.types.some((t) => t.name === "preferences.food.cuisine")).toBe(true);
  });

  it("starts with nothing pending and no compartments loaded", () => {
    const lattice = new Lattice();
    expect(JSON.parse(lattice.pendingCompartments())).toEqual([]);
  });

  it("round-trips put_node -> query", () => {
    const lattice = new Lattice();
    // preferences.food.cuisine nests under preferences.food (DESIGN §2): a
    // nested type's node must point `parent` at a node of exactly that type.
    const food = expectOk(
      call(lattice, "put_node", {
        type: "preferences.food",
        fields: { name: "Food" },
        author: { kind: "you" },
      }),
    );
    const put = expectOk(
      call(lattice, "put_node", {
        type: "preferences.food.cuisine",
        parent: food.id,
        fields: { name: "Japanese", strength: 0.8 },
        author: { kind: "you" },
      }),
    );
    expect(put.id).toMatch(/^n_/);
    expect(put.status).toBe("accepted");

    // Writing put records in `preferences`; takeFrame should hand back
    // exactly that plaintext, ready for the worker to encrypt.
    expect(JSON.parse(lattice.pendingCompartments())).toEqual(["preferences"]);

    const found = expectOk(call(lattice, "query", { path: "preferences/food/cuisine" }));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(put.id);
    expect(found[0].fields.name).toBe("Japanese");
  });

  it("rejects a node whose type isn't in the schema (R1: closed schema)", () => {
    const lattice = new Lattice();
    const result = call(lattice, "put_node", {
      type: "preferences.made_up_type",
      fields: { name: "x" },
      author: { kind: "you" },
    });
    expect(result.ok).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it("takeFrame/loadFrame round trip through a fresh instance", () => {
    const writer = new Lattice();
    const food = expectOk(
      call(writer, "put_node", {
        type: "preferences.food",
        fields: { name: "Food" },
        author: { kind: "you" },
      }),
    );
    expectOk(
      call(writer, "put_node", {
        type: "preferences.food.cuisine",
        parent: food.id,
        fields: { name: "Thai", strength: 0.5 },
        author: { kind: "you" },
      }),
    );
    const plaintext = writer.takeFrame("preferences");
    expect(plaintext.length).toBeGreaterThan(0);
    // Taking again with nothing new pending yields an empty frame.
    expect(writer.takeFrame("preferences").length).toBe(0);

    const reader = new Lattice();
    reader.loadFrame("preferences", plaintext);
    reader.finishOpen();
    const found = expectOk(call(reader, "query", { path: "preferences/food/cuisine" }));
    expect(found).toHaveLength(1);
    expect(found[0].fields.name).toBe("Thai");
  });

  it("R5: an ungranted request and a granted-but-non-matching request release byte-identical payloads", () => {
    const lattice = new Lattice();
    expectOk(
      call(lattice, "put_node", {
        type: "preferences.food",
        fields: { name: "Food" },
        author: { kind: "you" },
      }),
    );

    const request = {
      id: "r_shared",
      agent_id: "agent-none",
      agent_fingerprint: "fp-none",
      purpose: "p",
      asks: ["preferences.food.name"],
      channel: "private",
    };

    const evalNoGrant = expectOk(call(lattice, "evaluate", { request }));
    expect(evalNoGrant.auto).toEqual([]);
    expect(evalNoGrant.ask).toEqual([]);

    expectOk(
      call(lattice, "set_grant", {
        agent_id: "agent-none",
        agent_fingerprint: "fp-none",
        rules: [{ selector: "health.condition.name", mode: "auto" }],
      }),
    );
    const evalGrantedNoMatch = expectOk(call(lattice, "evaluate", { request }));
    expect(evalGrantedNoMatch.auto).toEqual([]);
    expect(evalGrantedNoMatch.ask).toEqual([]);

    const releaseA = expectOk(
      call(lattice, "release", { request, facts: evalNoGrant.auto, kind: "on_demand" }),
    );
    const releaseB = expectOk(
      call(lattice, "release", { request, facts: evalGrantedNoMatch.auto, kind: "on_demand" }),
    );
    expect(releaseA.payload).toEqual(releaseB.payload);
  });

  it("never panics on a malformed args payload for a real op", () => {
    const lattice = new Lattice();
    const result = call(lattice, "put_node", { type: "preferences.food" }); // missing required fields/author
    expect(result.error).toBeDefined();
    expect(result.error.code).toBeTruthy();
  });

  it("reports an unknown op as a typed error, not a throw", () => {
    const lattice = new Lattice();
    const result = call(lattice, "not_a_real_op", {});
    expect(result.error).toBeDefined();
  });
});
