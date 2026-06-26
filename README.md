# Differentia — dermatology reasoning prototype

An educational, web-based prototype that takes a photo of a skin finding, lets you crop it,
then runs an **adaptive interview** (Claude decides how many multiple-choice / yes-no questions
to ask based on its diagnostic certainty) and produces a **most-likely diagnosis + management
plan** plus a **ranked differential with probabilities**.

> ⚠️ **Not a medical device.** This is for demonstration and learning only. It does not diagnose
> and must not be used for decisions about real patients. Permissive prototype defaults (open
> storage policies, no auth) must be locked down before any real use.

---

## How it works

```
Browser (public/)                 Netlify Functions               Claude API
─────────────────                 ─────────────────               ──────────
upload + crop  ───base64───▶  /api/analyze (analyze.js) ──image+history──▶ Sonnet
                                   │  returns JSON:
   render question  ◀────────────  │   { phase:"questioning", next_question, differential }
   user answers ───history────▶  /api/analyze  (loops)
                                   │   …until…
   render readout  ◀────────────  │   { phase:"complete", result }
                              /api/save-session ──────▶ Supabase (optional)
```

- The **Claude API key lives only in the Netlify function** (`ANTHROPIC_API_KEY`). The browser
  never sees it.
- **Adaptive questioning** lives in the system prompt in `netlify/functions/analyze.js`: Claude
  asks the single most informative next question and stops when its top diagnosis passes a
  confidence threshold, when extra questions stop changing the differential, or when it hits the
  question ceiling. Tune `MIN_QUESTIONS` / `MAX_QUESTIONS` at the top of that file.
- **Supabase is optional.** Without it the diagnostic loop still works; you just won't store the
  image or the case record.

---

## Stack

| Piece            | Role                                                        |
|------------------|-------------------------------------------------------------|
| GitHub           | Source of truth; Netlify deploys from it                     |
| Netlify          | Static hosting (`public/`) + serverless functions           |
| Claude API (Sonnet) | The reasoning engine (`claude-sonnet-4-6`)               |
| Supabase         | (optional) image storage + session records                  |

No build step — the frontend is plain HTML/CSS/JS with Cropper.js and the Supabase client
loaded from a CDN.

---

## Setup

### 1. Get the code into GitHub
```bash
git init
git add .
git commit -m "Differentia prototype"
git remote add origin https://github.com/<you>/derma-prototype.git
git push -u origin main
```

### 2. Anthropic key
Create a key at the Anthropic console. You'll paste it into Netlify in step 4.

### 3. (Optional) Supabase
1. Create a project at supabase.com.
2. Open **SQL Editor** and run the contents of `supabase/schema.sql`.
3. From **Project Settings → API**, copy the **Project URL**, the **anon public** key, and the
   **service_role** key.
4. Put the public ones in the browser config:
   ```bash
   cp public/config.example.js public/config.js
   ```
   then edit `public/config.js` with your `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

### 4. Deploy on Netlify
1. **Add new site → Import from Git**, pick the repo. Netlify reads `netlify.toml` (publish dir
   `public`, functions dir `netlify/functions`).
2. In **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` — **required**
   - `SUPABASE_URL` — optional
   - `SUPABASE_SERVICE_ROLE_KEY` — optional
3. Deploy. Open the site, upload a photo, and run a case.

### 5. Run locally (optional)
```bash
npm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY (+ Supabase if used)
cp public/config.example.js public/config.js
npx netlify dev               # serves the site AND the functions on localhost
```

---

## Cost note

With Sonnet, one case is a few cents at most: the cropped image is roughly one to a few thousand
input tokens (and is prompt-cached across the turns of a session), each question/answer round-trip
is small, and the final readout is the largest single output. Expect well under $0.10 per completed
case in typical use.

## Customizing the reasoning

Everything clinical lives in the `SYSTEM_PROMPT` in `netlify/functions/analyze.js`:
- change the stopping thresholds, the JSON schema, the tone of the management plan;
- restrict to a body region or a teaching set of conditions;
- add fields (e.g. ICD-style codes, severity grade) to the result object and render them in
  `renderResult()` in `public/app.js`.

## File map
```
.
├── netlify/functions/analyze.js       # Claude call + adaptive questioning (the brain)
├── netlify/functions/save-session.js  # optional Supabase persistence
├── public/index.html                  # 4-step UI
├── public/styles.css                  # styling
├── public/app.js                      # upload, crop, interview loop, results
├── public/config.example.js           # -> copy to config.js (Supabase public keys)
├── supabase/schema.sql                # table + storage bucket + prototype policies
├── netlify.toml                       # publish/functions/redirects
├── package.json                       # function dependencies
└── .env.example                       # server-side secrets template
```
