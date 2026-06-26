// public/config.example.js
//
// 1) Copy this file to public/config.js
// 2) Fill in your Supabase project URL and the PUBLIC anon key
//    (Supabase -> Project Settings -> API). The anon key is safe to expose;
//    it is protected by Row Level Security.
//
// Leaving the placeholders as-is is fine — the app will run without Supabase
// (it just won't store images or sessions).

window.APP_CONFIG = {
  // Supabase (optional)
  SUPABASE_URL: "https://rjrckwzxoewywdwcxxwm.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_7VJnVCPALwNyaVbGcaOXHw_xol8AXt6",
  SUPABASE_BUCKET: "skin-images",

  // API endpoints (served by Netlify Functions via netlify.toml redirects)
  ANALYZE_ENDPOINT: "/api/analyze",
  SAVE_ENDPOINT: "/api/save-session",

  // Show Claude's internal reasoning + probabilities live (handy while building)
  DEBUG: true
};
