import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE_URL, REQUEST_HANDLER_URL } from "../config.js";

// A single step in the progress checklist.
// state: "pending" | "active" | "done"
function Step({ state, title, subtitle }) {
  return (
    <div className={`step ${state}`}>
      <span className="step-icon">
        {state === "active" && <span className="spinner" />}
        {state === "done" && (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M20 6L9 17l-5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="step-text">
        <span className="step-title">{title}</span>
        <span className="step-subtitle">{subtitle}</span>
      </span>
    </div>
  );
}

export default function Deploy() {
  const [repoURL, setRepoURL] = useState("");
  const [envVars, setEnvVars] = useState([{ key: "", value: "" }]);
  const [id, setId] = useState("");
  const [status, setStatus] = useState("");
  const [started, setStarted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  const updateEnvVar = (index, field, value) => {
    setEnvVars((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  };

  const addEnvVarRow = () => {
    setEnvVars((rows) => [...rows, { key: "", value: "" }]);
  };

  const removeEnvVarRow = (index) => {
    setEnvVars((rows) => rows.filter((_, i) => i !== index));
  };

  // Poll GET /status?id=<id> until the worker reports "deployed".
  useEffect(() => {
    if (!id) return;

    const poll = async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/status?id=${encodeURIComponent(id)}`
        );
        const data = await res.json();
        if (data.status) setStatus(data.status);
        if (data.status === "deployed") {
          clearInterval(pollRef.current);
          setDeploying(false);
        }
      } catch (err) {
        setError("Failed to fetch status. Is the API running on port 3000?");
      }
    };

    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => clearInterval(pollRef.current);
  }, [id]);

  const handleDeploy = async (e) => {
    e.preventDefault();
    setError("");
    setStatus("");
    setId("");

    if (!repoURL.trim()) {
      setError("Please enter a GitHub repository URL.");
      return;
    }

    setStarted(true);
    setDeploying(true);
    try {
      const envVarsObject = Object.fromEntries(
        envVars
          .filter((row) => row.key.trim())
          .map((row) => [row.key.trim(), row.value])
      );

      // The POST blocks while the server clones the repo and uploads it to S3.
      // Once it returns an id, the "upload" step is complete.
      const res = await fetch(`${API_BASE_URL}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoURL: repoURL.trim(), envVars: envVarsObject }),
      });
      const data = await res.json();
      if (data.id) {
        setId(data.id);
        setStatus("uploaded");
      } else {
        setError("The API did not return a deployment id.");
        setDeploying(false);
      }
    } catch (err) {
      setError(
        "Could not reach the deploy API. Make sure vercel_upload is running on " +
          API_BASE_URL +
          "."
      );
      setDeploying(false);
    }
  };

  const isDeployed = status === "deployed";

  // Derive the visual state of each step.
  const uploadState = id ? "done" : error ? "pending" : "active";
  const deployState = isDeployed ? "done" : id ? "active" : "pending";

  return (
    <div className="page deploy">
      <header className="topbar">
        <Link to="/" className="back-link">
          ← Back
        </Link>
        <span className="topbar-title">Deploy</span>
      </header>

      <main className="deploy-content">
        <h1 className="deploy-heading">Deploy a GitHub repository</h1>
        <p className="deploy-sub">
          Paste a public repo URL. It will be cloned, uploaded, built and served.
        </p>

        <form className="deploy-form" onSubmit={handleDeploy}>
          <input
            className="input"
            type="text"
            placeholder="https://github.com/username/repo"
            value={repoURL}
            onChange={(e) => setRepoURL(e.target.value)}
            disabled={deploying}
          />
          <button className="btn btn-primary" type="submit" disabled={deploying}>
            {deploying ? "Deploying…" : "Deploy"}
          </button>
        </form>

        <div className="env-section">
          <span className="env-heading">Environment variables (optional)</span>
          <div className="env-rows">
            {envVars.map((row, index) => (
              <div className="env-row" key={index}>
                <input
                  className="input env-input"
                  type="text"
                  placeholder="KEY"
                  value={row.key}
                  onChange={(e) => updateEnvVar(index, "key", e.target.value)}
                  disabled={deploying}
                />
                <input
                  className="input env-input"
                  type="text"
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => updateEnvVar(index, "value", e.target.value)}
                  disabled={deploying}
                />
                <button
                  type="button"
                  className="env-remove"
                  onClick={() => removeEnvVarRow(index)}
                  disabled={deploying || envVars.length === 1}
                  aria-label="Remove variable"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost env-add"
            onClick={addEnvVarRow}
            disabled={deploying}
          >
            + Add variable
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {started && (
          <div className="result-card">
            {id && (
              <div className="result-row">
                <span className="label">Deployment ID</span>
                <code className="value">{id}</code>
              </div>
            )}

            <div className="steps">
              <Step
                state={uploadState}
                title="Uploading source"
                subtitle="Cloning the repo and pushing files to storage"
              />
              <div className="step-connector" />
              <Step
                state={deployState}
                title="Building & deploying"
                subtitle="Worker builds the project and publishes it"
              />
            </div>

            {isDeployed && (
              <div className="result-row live">
                <span className="label">Live URL</span>
                <a
                  className="value link"
                  href={`${REQUEST_HANDLER_URL}/${id}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {`${REQUEST_HANDLER_URL}/${id}/`}
                </a>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
