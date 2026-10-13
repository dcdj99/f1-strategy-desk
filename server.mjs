import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 5173);
const MODEL = "claude-opus-5-5";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Credentials resolve from the environment (ANTHROPIC_API_KEY in .env, or an `ant auth login` profile).
// Created lazily so the server still starts (with built-in radio) when no credentials are set.
let client;
const getClient = () => (client ??= new Anthropic());

const SYSTEM = `You are the race engineer on a light-hearted strategy game shown live at a community build day.
The player re-ran Lewis Hamilton's 2026 Singapore Grand Prix with their own pit strategy. A ghost car ("you")
raced against Ferrari's real strategy ("Ferrari's call"), replayed from real lap data. You get the lap-by-lap result.

Write two things:
1. radio: 8 to 12 team-radio messages that play during the replay, each tied to the lap it should appear on.
   Mostly pit wall to car 44, a few short replies from the car. React to what actually happens in the data:
   pit calls a lap before each stop, VSC laps (cheap stops), tyres dropping off past the cliff, positions gained or lost
   (name the cars), getting stuck behind a slower car or passing one on track (the traffic section), the gap to
   Ferrari's call, the flag. Under 16 words each. Dry F1 humour is welcome, including
   the occasional "we are checking". Do not quote or impersonate real team members; the car is just "car 44".
2. debrief: a headline (under 8 words), a two-sentence verdict that explains with numbers why this strategy beat or
   lost to Ferrari's call, and a one-line roast. If the player beat Ferrari, the roast teases Ferrari; if they lost
   or matched it, the roast teases the player. A DSQ result means they ran only one tyre compound, which is illegal.
Keep everything good-natured and suitable for a room full of strangers.`;

const SCHEMA = {
  type: "object",
  properties: {
    radio: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lap: { type: "integer" },
          from: { type: "string", enum: ["engineer", "driver"] },
          text: { type: "string" },
        },
        required: ["lap", "from", "text"],
        additionalProperties: false,
      },
    },
    debrief: {
      type: "object",
      properties: {
        headline: { type: "string" },
        verdict: { type: "string" },
        roast: { type: "string" },
      },
      required: ["headline", "verdict", "roast"],
      additionalProperties: false,
    },
  },
  required: ["radio", "debrief"],
  additionalProperties: false,
};

async function engineer(summary) {
  const started = Date.now();
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Race data:\n${JSON.stringify(summary)}` }],
  });
  if (response.stop_reason === "refusal") throw new Error("engineer declined the request");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`no text in response (stop_reason ${response.stop_reason})`);
  const out = JSON.parse(text);
  console.log(`engineer: ${out.radio.length} radio calls in ${((Date.now() - started) / 1000).toFixed(1)}s (${response.model})`);
  return out;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/engineer") {
      const summary = await readBody(req);
      try {
        const out = await engineer(summary);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (err) {
        const status = err instanceof Anthropic.AuthenticationError ? 401
          : err instanceof Anthropic.RateLimitError ? 429
          : err instanceof Anthropic.APIError ? 502 : 503;
        console.warn(`engineer unavailable (${status}): ${err.message}`);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (err) {
    if (err.code === "ENOENT") res.writeHead(404).end("not found");
    else { console.error(err); res.writeHead(500).end("server error"); }
  }
});

server.listen(PORT, () => {
  console.log(`Strategy desk on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("No ANTHROPIC_API_KEY set: radio and debrief use the built-in lines. Add it to .env to switch on Opus.");
  }
});
