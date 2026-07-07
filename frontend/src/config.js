// Base URL of the vercel_upload API (the Express server in ../vercel_upload).
// It listens on port 3000 and has CORS enabled, so the browser can call it directly.
// Override with a VITE_API_BASE_URL env var if you run it elsewhere.
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
