#!/usr/bin/env node
/**
 * Jev-compatible shim for beebots.
 *
 * Implements the TypeSafe `POST /v1/systemone` contract on top of a local
 * llama.cpp forced-choice endpoint (Jev-mode: read probability mass over a
 * discrete option set). Lets beebots run entirely on self-hosted, EU-resident
 * infrastructure instead of api.typesafe.ai.
 *
 * Wire-up: set TYPESAFE_BASE_URL=http://127.0.0.1:8787 in the engine's env.
 * The SDK still requires a non-empty api key; any string works here.
 *
 * Endpoints:
 *   POST /v1/systemone  -> { model, answers: { <name>: <answer> }, usage }
 *   GET  /health        -> { ok: true, upstream, model }
 *
 * Question types supported: choice, score, noul (matching the SDK's types).
 * Fail-closed: any upstream error returns 5xx, which the beebots Jev client
 * treats as a failure, so the risk layer holds instead of trading blind.
 */

const http = require("node:http");

const PORT = Number(process.env.JEV_SHIM_PORT || 8787);
const BIND = process.env.JEV_SHIM_BIND || "127.0.0.1";
// llama.cpp decision endpoint (Jev-mode server on gpu-02 CT117).
const UPSTREAM = process.env.JEV_UPSTREAM_URL || "http://192.168.178.177:8087/completion";
const MODEL_LABEL = process.env.JEV_SHIM_MODEL_LABEL || "local-qwen3-8b-jev";
// Hard ceiling on upstream calls; the engine's own timeout is shorter.
const UPSTREAM_TIMEOUT_MS = Number(process.env.JEV_SHIM_TIMEOUT_MS || 8000);
const MAX_BODY_BYTES = 1024 * 1024;
const LOG_LEVEL = process.env.JEV_SHIM_LOG_LEVEL || "info";

/** Letters used as option tokens; max 26 options per question. */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const log = (...args) => {
  if (LOG_LEVEL !== "off") console.log(new Date().toISOString(), "[jev-shim]", ...args);
};

/** Render a criteria entry (string | object | array | null) as prompt text. */
function describe(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Render the request `state` (text | object | array | null) compactly. */
function renderState(state) {
  if (state === null || state === undefined) return "";
  if (typeof state === "string") return state;
  try {
    return JSON.stringify(state);
  } catch {
    return String(state);
  }
}

/**
 * Ask the decision model to pick one of `options` and return the normalized
 * probability mass per option index, plus the argmax.
 */
async function forcedChoice(question, options, instructions, state) {
  const letters = LETTERS.slice(0, options.length);
  const lines = options.map((opt, i) => `${letters[i]}) ${describe(opt) || `option ${letters[i]}`}`);
  const prompt = [
    "You are a decision model inside an automated trading system.",
    "Pick exactly one option. Answer with a single letter and nothing else.",
    "",
    instructions ? `Context:\n${instructions}` : "",
    state ? `Situation:\n${state}` : "",
    "",
    "Options:",
    ...lines,
    "",
    "Answer:",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const grammar = `root ::= ${letters.map((l) => `"${l}"`).join(" | ")}`;
  const body = {
    prompt,
    n_predict: 1,
    n_probs: 32,
    temperature: 0,
    grammar,
    cache_prompt: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let payload;
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    payload = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const probs = new Array(options.length).fill(0);
  const top = payload?.completion_probabilities?.[0]?.top_logprobs || [];
  for (const entry of top) {
    const token = String(entry?.token ?? "").trim().toUpperCase();
    const idx = letters.indexOf(token);
    if (idx >= 0 && Number.isFinite(entry.logprob)) {
      probs[idx] += Math.exp(entry.logprob);
    }
  }
  let total = probs.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // The sampled content is authoritative when the distribution is unusable.
    const sampled = String(payload?.content ?? "").trim().toUpperCase();
    const idx = letters.indexOf(sampled);
    if (idx < 0) throw new Error(`no usable distribution (content=${JSON.stringify(payload?.content)})`);
    probs.fill(0);
    probs[idx] = 1;
    total = 1;
  }
  const normalized = probs.map((p) => p / total);
  let best = 0;
  for (let i = 1; i < normalized.length; i++) if (normalized[i] > normalized[best]) best = i;

  const promptTokens = payload?.tokens_evaluated ?? Math.ceil(prompt.length / 4);
  return { letters, normalized, best, promptTokens, completion: String(payload?.content ?? "").trim() };
}

/** Build the answer object for one question. */
async function answerQuestion(name, q, stateText) {
  const type = q?.type;
  if (type === "choice") {
    const labels = Object.keys(q.criteria || {});
    if (labels.length < 1) throw new Error(`${name}: choice needs at least one option`);
    // A single-option menu is a forced move: no market call, the risk layer has
    // already decided. Jev would return that option; so do we.
    if (labels.length === 1) {
      return {
        answer: {
          type: "choice",
          choice: labels[0],
          confidence: 1,
          probabilities: { [labels[0]]: 1 },
        },
        tokens: 0,
      };
    }
    const opts = labels.map((l) => q.criteria[l]);
    const { normalized, best, promptTokens } = await forcedChoice(q, opts, describe(q.instructions), stateText);
    const probabilities = {};
    labels.forEach((label, i) => {
      probabilities[label] = Number(normalized[i].toFixed(6));
    });
    return {
      answer: {
        type: "choice",
        choice: labels[best],
        // Jev-style confidence: the probability mass on the chosen label.
        confidence: Number(normalized[best].toFixed(6)),
        probabilities,
      },
      tokens: promptTokens,
    };
  }

  if (type === "score") {
    const rubric = Array.isArray(q.criteria) ? q.criteria : [];
    if (rubric.length < 2) throw new Error(`${name}: score needs at least two levels`);
    const levels = rubric.map((_, i) => i);
    const { normalized, best, promptTokens } = await forcedChoice(q, levels, describe(q.instructions), stateText);
    const probabilities = {};
    levels.forEach((lvl, i) => {
      probabilities[String(lvl)] = Number(normalized[i].toFixed(6));
    });
    const expected = levels.reduce((acc, lvl, i) => acc + lvl * normalized[i], 0);
    // Jev returns the expected score, which may sit between rubric levels.
    // Rounding here matches how the SDK's consumers (conviction 0..n) use it.
    return {
      answer: {
        type: "score",
        score: Number(expected.toFixed(4)),
        confidence: Number(normalized[best].toFixed(6)),
        legend: Object.fromEntries(levels.map((lvl) => [String(lvl), rubric[lvl] ?? null])),
        probabilities,
      },
      tokens: promptTokens,
    };
  }

  if (type === "noul") {
    const trueDesc = q.criteria?.true ?? "yes";
    const falseDesc = q.criteria?.false ?? "no";
    const { normalized, promptTokens } = await forcedChoice(q, [trueDesc, falseDesc], describe(q.instructions), stateText);
    return { answer: { type: "noul", noul: Number(normalized[0].toFixed(6)) }, tokens: promptTokens };
  }

  throw new Error(`${name}: unsupported question type ${String(type)}`);
}

async function handleSystemOne(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const questions = body?.questions && typeof body.questions === "object" ? body.questions : null;
  if (!questions || Object.keys(questions).length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "questions is required" }));
    return;
  }

  const stateText = renderState(body.state);
  const started = Date.now();
  const answers = {};
  let tokens = 0;
  try {
    for (const [name, q] of Object.entries(questions)) {
      const { answer, tokens: t } = await answerQuestion(name, q, stateText);
      answers[name] = answer;
      tokens += t;
    }
  } catch (err) {
    log("decision failed:", err?.message || err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "decision model unavailable", detail: String(err?.message || err) }));
    return;
  }

  const ms = Date.now() - started;
  log(
    "systemone",
    Object.entries(answers)
      .map(([k, v]) => `${k}=${v.choice ?? v.score ?? v.noul}`)
      .join(" "),
    `${ms}ms`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: MODEL_LABEL,
      answers,
      usage: { input_tokens: tokens, output_tokens: Object.keys(questions).length },
    }),
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, model: MODEL_LABEL }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/systemone") {
    handleSystemOne(req, res).catch((err) => {
      log("handler error:", err?.message || err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
    return;
  }
  // The SDK also probes GET /v1/models against its base URL.
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: MODEL_LABEL, description: "self-hosted Jev-mode decision model", release_date: "2026-01-01" }] }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, BIND, () => {
  log(`listening on http://${BIND}:${PORT} -> ${UPSTREAM}`);
});
