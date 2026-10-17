// JSON values only. Array order is significant; object keys use UTF-16 lexical order.
// Serialize each sorted member explicitly: JSON.stringify would reorder integer keys.
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value !== "object" ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new TypeError("Canonical JSON requires JSON values");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    ).join(",")}}`;
}
