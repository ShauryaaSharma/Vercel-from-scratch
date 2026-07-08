// Base URL of the vercel_upload API (the Express server in ../vercel_upload).
// It listens on port 3000 and has CORS enabled, so the browser can call it directly.
// Override with a VITE_API_BASE_URL env var if you run it elsewhere.
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

// Domain that deployed sites live under, e.g. "deploys.example.com", so a
// deployment renders at "<id>.deploys.example.com". The request handler
// resolves the deploy id from the subdomain, which only works once this
// domain has a wildcard DNS record pointed at it. Unset until that domain
// exists — set VITE_SITE_DOMAIN once it's configured.
export const SITE_DOMAIN = import.meta.env.VITE_SITE_DOMAIN || "";
