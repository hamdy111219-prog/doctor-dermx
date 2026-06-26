/* ============================================================
   Differentia — client logic
   Flow: upload -> crop -> interview (adaptive) -> result
   The browser never sees the Claude key; it calls /api/analyze.
   ============================================================ */

const CFG = window.APP_CONFIG || {};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- state ----------------------------------------------------------------
const state = {
  imageBase64: null,     // raw base64 (no data: prefix)
  mediaType: "image/jpeg",
  imagePath: null,       // supabase storage path, if uploaded
  history: [],           // [{ question, answer }]
  current: null,         // current question object from the model
  selected: null         // current selection (string | string[])
};

let cropper = null;
let supa = null;

// optional supabase client
(function initSupabase() {
  const hasKeys =
    CFG.SUPABASE_URL &&
    CFG.SUPABASE_ANON_KEY &&
    !CFG.SUPABASE_URL.includes("your-project-ref") &&
    !CFG.SUPABASE_ANON_KEY.includes("REPLACE_WITH");
  if (hasKeys && window.supabase) {
    supa = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }
})();

// ---- step navigation ------------------------------------------------------
const STEPS = ["upload", "crop", "interview", "result"];
function goStep(step) {
  $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === step));
  const idx = STEPS.indexOf(step);
  $$(".rail li").forEach((li, i) => {
    li.classList.toggle("is-active", i === idx);
    li.classList.toggle("is-done", i < idx);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- veil + toast ---------------------------------------------------------
function showVeil(msg) {
  $("#veilMsg").textContent = msg || "Working…";
  $("#veil").hidden = false;
}
function hideVeil() { $("#veil").hidden = true; }

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}

/* =================== STEP 1: UPLOAD ======================================= */
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

// NOTE: #dropzone is a <label> wrapping #fileInput, so a click/tap opens the
// file picker NATIVELY. We deliberately do NOT call fileInput.click() here —
// doing both fires the picker twice (it reopens after you choose, and breaks
// the camera on mobile).
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  if (!file.type.startsWith("image/")) { toast("That doesn't look like an image."); return; }
  const reader = new FileReader();
  reader.onload = () => startCrop(reader.result);
  reader.readAsDataURL(file);
}

/* =================== STEP 2: CROP ========================================= */
function startCrop(dataUrl) {
  const img = $("#cropTarget");
  img.src = dataUrl;
  goStep("crop");
  if (cropper) cropper.destroy();
  cropper = new Cropper(img, {
    viewMode: 1,
    autoCropArea: 0.85,
    background: false,
    responsive: true
  });
}

$("#backToUpload").addEventListener("click", () => {
  if (cropper) { cropper.destroy(); cropper = null; }
  fileInput.value = "";
  goStep("upload");
});

$("#confirmCrop").addEventListener("click", async () => {
  if (!cropper) return;
  const canvas = cropper.getCroppedCanvas({ maxWidth: 1280, maxHeight: 1280, imageSmoothingQuality: "high" });
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  state.mediaType = "image/jpeg";
  state.imageBase64 = dataUrl.split(",")[1];

  // show thumbnail in the interview
  $("#caseThumb").src = dataUrl;

  // optional: stash the image in Supabase storage
  await maybeUploadImage(dataUrl);

  // begin the interview
  state.history = [];
  goStep("interview");
  await nextTurn();
});

async function maybeUploadImage(dataUrl) {
  if (!supa) return;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `cases/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await supa.storage.from(CFG.SUPABASE_BUCKET || "skin-images")
      .upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    state.imagePath = path;
  } catch (e) {
    // non-fatal for the prototype
    console.warn("Image upload skipped:", e.message);
  }
}

/* =================== STEP 3: INTERVIEW ==================================== */
const REQUEST_TIMEOUT_MS = 35000; // don't spin forever

async function nextTurn() {
  showVeil(state.history.length === 0 ? "Reading the image…" : "Thinking about your answer…");

  const endpoint = CFG.ANALYZE_ENDPOINT || "/api/analyze";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: { data: state.imageBase64, mediaType: state.mediaType },
          history: state.history
        }),
        signal: controller.signal
      });
    } catch (networkErr) {
      if (networkErr.name === "AbortError") {
        throw new Error(
          `No response after ${REQUEST_TIMEOUT_MS / 1000}s. The function may be timing out — ` +
          `check Netlify → Logs → Functions → analyze, and that the function isn't exceeding its time limit.`
        );
      }
      throw new Error(
        `Could not reach ${endpoint}. The request failed before the server replied — usually a wrong ` +
        `endpoint path, a redirect issue, or CORS. Open F12 → Network and inspect the "analyze" request.`
      );
    }

    // Read as text first so we can show non-JSON error pages (e.g. a 404 HTML page).
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `The server replied with status ${res.status} but the body wasn't JSON. ` +
        `That usually means the request hit the HTML page instead of the function ` +
        `(check the /api/analyze redirect in netlify.toml). First 200 chars:\n` +
        text.slice(0, 200)
      );
    }

    if (!res.ok) {
      const detail = data.detail ? `\n${data.detail}` : "";
      throw new Error(`(${res.status}) ${data.error || "Analysis failed."}${detail}`);
    }

    updateLiveDifferential(data);

    if (data.phase === "complete") {
      renderResult(data.result);
      saveSession(data.result);
    } else if (data.next_question) {
      renderQuestion(data);
    } else {
      throw new Error("The model didn't return a question or a result. Raw:\n" + text.slice(0, 300));
    }
  } catch (e) {
    console.error(e);
    showInterviewError(e.message || "Something went wrong.");
  } finally {
    clearTimeout(timer);
    hideVeil();
  }
}

// Render the error visibly in the question card, with a retry button,
// instead of leaving the loading veil up forever.
function showInterviewError(message) {
  state.selected = null; // so the normal "Next" handler short-circuits; retry uses onclick below
  $("#qIndex").textContent = "Something went wrong";
  $("#qHint").textContent = "";
  $("#qcard").innerHTML =
    `<p class="q-text" style="color:var(--rose)">Couldn't get a response</p>` +
    `<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:.8rem;` +
    `color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line-soft);` +
    `border-radius:10px;padding:12px;margin:0;overflow:auto">${escapeHtml(message)}</pre>`;
  const btn = $("#answerBtn");
  btn.disabled = false;
  btn.textContent = "Try again";
  btn.onclick = () => { btn.onclick = null; nextTurn(); };
}

function updateLiveDifferential(data) {
  const conf = typeof data.certainty === "number" ? data.certainty
             : data.result?.most_likely?.probability;
  if (typeof conf === "number") {
    $("#confidenceFill").style.width = Math.round(conf * 100) + "%";
    $("#confidenceVal").textContent = Math.round(conf * 100) + "%";
  }
  const list = data.differential || (data.result?.differentials || []).map(d => ({ diagnosis: d.diagnosis, probability: d.probability }));
  if (list && list.length) {
    const wrap = $("#liveDx");
    wrap.hidden = false;
    $("#liveDxList").innerHTML = list.slice(0, 4).map(d =>
      `<li><b>${escapeHtml(d.diagnosis)}</b><span>${Math.round((d.probability || 0) * 100)}%</span></li>`
    ).join("");
  }
  if (CFG.DEBUG && data.reasoning) {
    const dl = $("#debugLine");
    dl.hidden = false;
    dl.textContent = "reasoning: " + data.reasoning;
  }
}

function renderQuestion(data) {
  const q = data.next_question;
  if (!q) { toast("No question returned."); return; }
  state.current = q;
  state.selected = q.type === "multi_select" ? [] : null;

  $("#qIndex").textContent = `Question ${state.history.length + 1}`;
  $("#qHint").textContent = q.type === "multi_select" ? "Select all that apply" : "";

  const optsHtml = (q.options || []).map((opt) => `
    <button class="opt ${q.type === "multi_select" ? "multi" : ""}" type="button"
            data-value="${escapeAttr(opt)}" aria-pressed="false">
      <span class="tick" aria-hidden="true"></span>
      <span>${escapeHtml(opt)}</span>
    </button>`).join("");

  $("#qcard").innerHTML = `<p class="q-text">${escapeHtml(q.text)}</p><div class="opts">${optsHtml}</div>`;

  $$("#qcard .opt").forEach((btn) => btn.addEventListener("click", () => onPick(btn, q.type)));

  const next = $("#answerBtn");
  next.disabled = true;
  next.textContent = data.meta && (data.meta.questions_asked + 1) >= data.meta.max_questions
    ? "Get readout →" : "Next";
}

function onPick(btn, type) {
  if (type === "multi_select") {
    const pressed = btn.getAttribute("aria-pressed") === "true";
    btn.setAttribute("aria-pressed", String(!pressed));
    state.selected = $$("#qcard .opt[aria-pressed='true']").map((b) => b.dataset.value);
    $("#answerBtn").disabled = state.selected.length === 0;
  } else {
    $$("#qcard .opt").forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    state.selected = btn.dataset.value;
    $("#answerBtn").disabled = false;
  }
}

$("#answerBtn").addEventListener("click", async () => {
  if (state.selected == null || (Array.isArray(state.selected) && !state.selected.length)) return;
  state.history.push({ question: state.current.text, answer: state.selected });
  await nextTurn();
});

/* =================== STEP 4: RESULT ======================================= */
function renderResult(r) {
  if (!r) { toast("No result returned."); return; }
  $("#dxName").textContent = r.most_likely?.diagnosis || "—";
  const conf = (r.most_likely?.confidence || "moderate").toLowerCase();
  const confPill = $("#dxConfidence");
  confPill.textContent = conf + " confidence";
  confPill.setAttribute("data-conf", conf);
  $("#dxProb").textContent = r.most_likely?.probability != null
    ? Math.round(r.most_likely.probability * 100) + "%" : "—";

  $("#managementPlan").textContent = r.management_plan || "—";
  $("#nextStep").textContent = r.recommended_next_step || "—";
  $("#redFlags").textContent = r.red_flags || "None identified from the information given.";

  const items = (r.differentials || []).slice(0, 5);
  $("#dxReadout").innerHTML = items.map((d) => {
    const pct = Math.round((d.probability || 0) * 100);
    return `<li>
      <span class="ro-name">${escapeHtml(d.diagnosis)}</span>
      <span class="ro-pct">${pct}%</span>
      <span class="ro-bar"><span class="ro-fill" data-pct="${pct}"></span></span>
      ${d.rationale ? `<span class="ro-why">${escapeHtml(d.rationale)}</span>` : ""}
    </li>`;
  }).join("");

  goStep("result");
  // animate bars after layout
  requestAnimationFrame(() => {
    $$("#dxReadout .ro-fill").forEach((el) => { el.style.width = el.dataset.pct + "%"; });
  });
}

async function saveSession(result) {
  const el = $("#saveState");
  try {
    const res = await fetch(CFG.SAVE_ENDPOINT || "/api/save-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path: state.imagePath, answers: state.history, result })
    });
    const data = await res.json();
    if (data.saved) el.textContent = "saved · " + data.id.slice(0, 8);
    else el.textContent = data.skipped ? "(not stored — Supabase off)" : "";
  } catch {
    el.textContent = "";
  }
}

$("#restartBtn").addEventListener("click", () => {
  Object.assign(state, { imageBase64: null, imagePath: null, history: [], current: null, selected: null });
  if (cropper) { cropper.destroy(); cropper = null; }
  fileInput.value = "";
  $("#liveDx").hidden = true;
  $("#confidenceFill").style.width = "0%";
  $("#confidenceVal").textContent = "—";
  $("#debugLine").hidden = true;
  goStep("upload");
});

/* =================== utils ================================================ */
function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s = "") { return escapeHtml(s).replace(/"/g, "&quot;"); }
