// netlify/functions/analyze.js
//
// The diagnostic brain of the prototype. Runs server-side so the Claude API
// key is never exposed to the browser. Called once per turn:
//   - First call  (empty history)         -> returns the first question
//   - Middle calls (history with answers)  -> returns the next question
//   - Final call   (enough certainty/cap)  -> returns the result + differential
//
// The number of questions is decided by Claude based on diagnostic certainty,
// bounded by MIN_QUESTIONS / MAX_QUESTIONS below.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const MIN_QUESTIONS = 3;   // don't finalize before this many (unless image alone is near-certain)
const MAX_QUESTIONS = 7;   // hard ceiling; force a result at this point

const SYSTEM_PROMPT = `You are the reasoning engine inside an EDUCATIONAL dermatology
differential-diagnosis PROTOTYPE. This tool is explicitly NOT used on real patients and is
for demonstration and learning only. You reason like a careful dermatologist taking a focused
history, but you never claim certainty you don't have.

You are given a cropped photo of a skin finding plus a transcript of multiple-choice answers the
user has given so far. On EACH turn you do one of two things: ask ONE more question, or finalize.

ADAPTIVE STOPPING RULES (you decide the number of questions):
- Ask the single MOST INFORMATIVE next question — the one that best separates your current
  top candidates. Do not ask things the image or prior answers already settled.
- Keep going while the questions are still meaningfully changing the differential.
- FINALIZE when any of these is true:
    * your top diagnosis probability is >= 0.85, OR
    * the next question would barely change the differential (low information gain), OR
    * you have already asked the maximum number of questions allowed this turn.
- Do not finalize before the minimum number of questions UNLESS the image alone makes one
  diagnosis overwhelmingly likely (>= 0.90).

QUESTION DESIGN:
- type is one of: "yes_no", "single_select", "multi_select".
- Provide concrete, mutually-exclusive options a layperson can answer. 2-5 options.
- For yes_no, options must be exactly ["Yes","No"] (you may add ["Not sure"] if useful).
- Phrase plainly, no jargon. One clinical concept per question (onset, symptoms, distribution,
  triggers, spread, prior episodes, exposures, associated systemic features, etc.).

OUTPUT FORMAT — respond with a SINGLE JSON object and NOTHING else (no prose, no markdown fences):

When asking a question:
{
  "phase": "questioning",
  "reasoning": "<one short internal sentence, shown only in debug>",
  "certainty": <0..1 probability of your current top diagnosis>,
  "differential": [ {"diagnosis": "<name>", "probability": <0..1>}, ... up to 5, roughly summing to 1 ],
  "next_question": {
    "id": "<short id like q3>",
    "text": "<the question>",
    "type": "yes_no" | "single_select" | "multi_select",
    "options": ["...", "..."]
  }
}

When finalizing:
{
  "phase": "complete",
  "result": {
    "most_likely": {
      "diagnosis": "<name>",
      "probability": <0..1>,
      "confidence": "low" | "moderate" | "high"
    },
    "management_plan": "<plain-language, patient-facing educational plan: general self-care, what to use, what to avoid, and when to seek in-person care. 3-6 short sentences.>",
    "recommended_next_step": "<the single highest-yield real-world step, e.g. 'KOH scraping to confirm/exclude tinea' or 'in-person dermatology review'>",
    "differentials": [
      {"diagnosis": "<name>", "probability": <0..1>, "rationale": "<why it's on the list / what would confirm it>"},
      ... include the most_likely first, then the others, up to 5, probabilities roughly summing to 1
    ],
    "red_flags": "<features that would make this urgent / need immediate in-person care>"
  }
}

Probabilities are estimates for an educational exercise, not validated risk scores. Be honest about
uncertainty (use 'low'/'moderate' confidence freely). Never identify or guess the identity of any
person in the image.`;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return cors(204, "");
  }
  if (event.httpMethod !== "POST") {
    return cors(405, JSON.stringify({ error: "Use POST." }));
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return cors(500, JSON.stringify({
      error: "Server is missing ANTHROPIC_API_KEY. Set it in your Netlify environment variables."
    }));
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return cors(400, JSON.stringify({ error: "Body must be valid JSON." }));
  }

  const { image, history } = body;
  const answers = Array.isArray(history) ? history : [];

  if (!image || !image.data || !image.mediaType) {
    return cors(400, JSON.stringify({
      error: "Missing image. Expected { image: { data: <base64>, mediaType: 'image/jpeg' } }."
    }));
  }

  const questionsAsked = answers.length;
  const forceFinalize = questionsAsked >= MAX_QUESTIONS;

  // Build a compact transcript of what we know so far.
  const transcript = answers.length
    ? answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${formatAnswer(a.answer)}`).join("\n")
    : "(no questions answered yet)";

  const instruction = [
    `Questions answered so far: ${questionsAsked}.`,
    `Minimum questions before finalizing: ${MIN_QUESTIONS}. Maximum allowed: ${MAX_QUESTIONS}.`,
    forceFinalize
      ? `You have reached the maximum. You MUST finalize now (phase "complete").`
      : `Decide: ask ONE more question, or finalize if your stopping rules are met.`,
    "",
    "Transcript:",
    transcript,
    "",
    "Respond with the JSON object only."
  ].join("\n");

  const client = new Anthropic({ apiKey });

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1600,
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.data },
              // cache the image across the session's turns to cut input cost
              cache_control: { type: "ephemeral" }
            },
            { type: "text", text: instruction }
          ]
        }
      ]
    });

    const raw = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = safeParseJson(raw);
    if (!parsed) {
      return cors(502, JSON.stringify({
        error: "Could not parse the model response as JSON.",
        raw
      }));
    }

    // Light server-side guard rails.
    if (forceFinalize && parsed.phase !== "complete") {
      parsed.phase = "complete";
    }

    return cors(200, JSON.stringify({
      ...parsed,
      meta: {
        questions_asked: questionsAsked,
        max_questions: MAX_QUESTIONS,
        model: MODEL,
        usage: msg.usage || null
      }
    }));
  } catch (err) {
    return cors(502, JSON.stringify({
      error: "The analysis service failed. Check the function logs.",
      detail: String(err && err.message ? err.message : err)
    }));
  }
};

function formatAnswer(answer) {
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

// Strip accidental ```json fences / leading prose and parse the first JSON object.
function safeParseJson(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body
  };
}
