import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

it("sorts nested objects including those in arrays, independently of insertion order", () => {
    const a = { z: [{ y: 2, a: 1 }], a: { z: null, a: true } };
    const b = { a: { a: true, z: null }, z: [{ a: 1, y: 2 }] };
    expect(canonicalJson(a)).toBe('{"a":{"a":true,"z":null},"z":[{"a":1,"y":2}]}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const hash = (v: typeof a) => createHash("sha256").update(canonicalJson(v)).digest("hex");
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash({ ...a, z: [{ y: 3, a: 1 }] }));
    expect(Object.keys(a)).toEqual(["z", "a"]);
});

it("sorts integer-like keys lexically and preserves array order and JSON escaping", () => {
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    const value = { text: 'quote"\n', nil: null, flag: false };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
});

it("rejects non-finite numbers instead of conflating them with null", () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => canonicalJson(value)).toThrow();
});
