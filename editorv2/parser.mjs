export const SERVO_DOOR_PERCENT = 15;
export const SERVO_BUTTON_CONTACT_PERCENT = 85;

const JSON_LINE_RE = /^\s*"([^"]+)"\s*:\s*"([\s\S]*)"\s*,?\s*$/;
const MP3_RE = /^mp3\s*,\s*<<\\?"([^"]+)\\?">>\s*$/i;
const TUPLE_RE = /\{[^{}]*\}/g;

function createDiagnostic(level, message) {
  return { level, message };
}

function parseInteger(value, label, diagnostics) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    diagnostics.push(createDiagnostic("error", `Invalid ${label}: "${value}"`));
    return null;
  }
  return parsed;
}

function escapeMp3Path(path) {
  return String(path).replace(/\\/g, "/").replace(/"/g, '\\"');
}

export function extractEditorInput(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return { name: "", sequenceText: "" };
  }

  const jsonLineMatch = trimmed.match(JSON_LINE_RE);
  if (jsonLineMatch) {
    return {
      name: jsonLineMatch[1],
      sequenceText: jsonLineMatch[2]
    };
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return {
      name: "",
      sequenceText: trimmed.slice(1, -1)
    };
  }

  return {
    name: "",
    sequenceText: trimmed
  };
}

function parseTuple(rawTuple, diagnostics, index) {
  const body = rawTuple.slice(1, -1).trim();
  const parts = body.split(",").map((part) => part.trim());
  const command = parts[0];

  if (command === "servo") {
    if (parts.length < 2 || parts.length > 3) {
      diagnostics.push(
        createDiagnostic("error", `Servo tuple #${index + 1} should have 2 or 3 parts: ${rawTuple}`)
      );
      return null;
    }

    const targetPercent = parseInteger(parts[1], "servo target", diagnostics);
    const durationMs =
      parts.length === 3 ? parseInteger(parts[2], "servo duration", diagnostics) : null;

    if (targetPercent === null || (parts.length === 3 && durationMs === null)) {
      return null;
    }

    if (targetPercent > 100) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          `Servo tuple #${index + 1} targets ${targetPercent}%. The Processing editor stayed inside 0-100.`
        )
      );
    }

    return {
      type: "servo",
      targetPercent,
      durationMs,
      id: `servo-${index}`
    };
  }

  if (command === "wait") {
    if (parts.length !== 2) {
      diagnostics.push(
        createDiagnostic("error", `Wait tuple #${index + 1} should have 2 parts: ${rawTuple}`)
      );
      return null;
    }

    if (parts[1] === "sound" || parts[1] === "servo") {
      return {
        type: "wait",
        mode: parts[1],
        durationMs: null,
        id: `wait-${index}`
      };
    }

    const durationMs = parseInteger(parts[1], "wait duration", diagnostics);
    if (durationMs === null) {
      return null;
    }

    return {
      type: "wait",
      mode: "duration",
      durationMs,
      id: `wait-${index}`
    };
  }

  if (command === "mp3") {
    const match = body.match(MP3_RE);
    if (!match) {
      diagnostics.push(
        createDiagnostic(
          "error",
          `MP3 tuple #${index + 1} should look like {mp3, <<\\"folder/file.mp3\\">>}: ${rawTuple}`
        )
      );
      return null;
    }

    const path = match[1];
    if (!path.endsWith(".mp3")) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          `MP3 tuple #${index + 1} references "${path}". The firmware build currently expects mp3 files.`
        )
      );
    }

    return {
      type: "mp3",
      path,
      id: `mp3-${index}`
    };
  }

  diagnostics.push(
    createDiagnostic("error", `Unknown tuple command in tuple #${index + 1}: ${rawTuple}`)
  );
  return null;
}

export function parseChoreography(input) {
  const source = String(input ?? "").trim();
  const diagnostics = [];
  const elements = [];

  if (!source) {
    return { elements, diagnostics };
  }

  let cursor = 0;
  for (const match of source.matchAll(TUPLE_RE)) {
    const tuple = match[0];
    const prefix = source.slice(cursor, match.index).trim();
    if (prefix && prefix !== ",") {
      diagnostics.push(
        createDiagnostic("error", `Unexpected text before tuple: "${prefix}"`)
      );
    }
    cursor = match.index + tuple.length;

    const parsed = parseTuple(tuple, diagnostics, elements.length);
    if (parsed) {
      elements.push(parsed);
    }
  }

  const suffix = source.slice(cursor).trim();
  if (suffix) {
    diagnostics.push(createDiagnostic("error", `Unexpected trailing text: "${suffix}"`));
  }

  if (!elements.length && source) {
    diagnostics.push(createDiagnostic("error", "No choreography tuples were found."));
  }

  return { elements, diagnostics };
}

export function serializeChoreography(elements, options = {}) {
  const { escapeQuotes = true } = options;
  const quote = escapeQuotes ? '\\"' : '"';

  return elements
    .map((element) => {
      if (element.type === "servo") {
        const durationMs =
          Number.isFinite(element.durationMs) && element.durationMs > 0
            ? `, ${Math.round(element.durationMs)}`
            : "";
        return `{servo, ${Math.round(element.targetPercent)}${durationMs}}`;
      }

      if (element.type === "wait") {
        if (element.mode === "sound" || element.mode === "servo") {
          return `{wait, ${element.mode}}`;
        }
        return `{wait, ${Math.round(element.durationMs ?? 0)}}`;
      }

      if (element.type === "mp3") {
        return `{mp3, <<${quote}${escapeMp3Path(element.path)}${quote}>>}`;
      }

      return "";
    })
    .filter(Boolean)
    .join(", ");
}

export function buildJsonLine(name, elements) {
  const safeName = String(name ?? "").trim() || "unnamed_scenario";
  return `  "${safeName}": "${serializeChoreography(elements, { escapeQuotes: true })}"`;
}

export function defaultSequence() {
  return [
    { type: "servo", targetPercent: 24, durationMs: 820, id: "servo-default-1" },
    { type: "wait", mode: "duration", durationMs: 2054, id: "wait-default-1" },
    { type: "servo", targetPercent: 100, durationMs: null, id: "servo-default-2" },
    { type: "wait", mode: "duration", durationMs: 8, id: "wait-default-2" },
    { type: "mp3", path: "calm/01230.mp3", id: "mp3-default-1" },
    { type: "wait", mode: "duration", durationMs: 582, id: "wait-default-3" },
    { type: "servo", targetPercent: 0, durationMs: 1220, id: "servo-default-3" }
  ];
}
