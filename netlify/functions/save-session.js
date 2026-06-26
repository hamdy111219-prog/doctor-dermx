// netlify/functions/save-session.js
//
// Optional: persists a completed case (answers + result + image path) to Supabase
// using the service-role key (server-side only). The app works without this — if the
// Supabase env vars are absent it simply returns { skipped: true }.

const { createClient } = require("@supabase/supabase-js");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ error: "Use POST." }));

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Persistence is optional for the prototype.
  if (!url || !serviceKey) {
    return cors(200, JSON.stringify({ skipped: true, reason: "Supabase not configured." }));
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return cors(400, JSON.stringify({ error: "Body must be valid JSON." }));
  }

  const { image_path, answers, result } = body;
  const mostLikely = result?.most_likely?.diagnosis || null;
  const topProbability = result?.most_likely?.probability ?? null;

  try {
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        image_path: image_path || null,
        answers: answers || [],
        result: result || {},
        most_likely: mostLikely,
        top_probability: topProbability
      })
      .select("id")
      .single();

    if (error) throw error;
    return cors(200, JSON.stringify({ saved: true, id: data.id }));
  } catch (err) {
    return cors(502, JSON.stringify({
      error: "Could not save the session.",
      detail: String(err && err.message ? err.message : err)
    }));
  }
};

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
