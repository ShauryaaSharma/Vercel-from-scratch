import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

// ---- GitHub mark ----
function GithubIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.997.108-.775.42-1.305.762-1.605-2.665-.303-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.233 1.91 1.233 3.22 0 4.61-2.806 5.624-5.478 5.92.43.372.814 1.102.814 2.222 0 1.606-.015 2.898-.015 3.293 0 .32.216.694.825.576C20.565 22.296 24 17.797 24 12.5 24 5.87 18.627.5 12 .5z" />
    </svg>
  );
}

// ---- Reveal-on-scroll wrapper ----
function useInView(options) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.unobserve(el);
        }
      },
      options
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, inView];
}

function Reveal({ children, className = "", delay = 0 }) {
  const [ref, inView] = useInView({ threshold: 0.15 });
  return (
    <div
      ref={ref}
      className={`reveal ${inView ? "in" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

const STEPS = [
  {
    num: "01",
    title: "Upload Service",
    tag: "Express · :3000",
    desc: "Clones your GitHub repo, walks every file, and uploads them to S3 under output/<id>. Then it pushes the id onto a Redis queue and marks the status as uploaded.",
  },
  {
    num: "02",
    title: "Redis",
    tag: "queue + status",
    desc: "A Redis list (build-queue) hands jobs from the upload service to the worker. A status hash tracks each deployment as it moves from uploaded to deployed.",
  },
  {
    num: "03",
    title: "Deploy Worker",
    tag: "brPop · builds",
    desc: "Blocks on the queue waiting for a job. Pulls the source from S3, runs the build, and uploads the compiled output to dist/<id> — then flips the status to deployed.",
  },
  {
    num: "04",
    title: "Request Handler",
    tag: "Express · :3001",
    desc: "Serves the finished site straight from S3. The subdomain <id>.localhost:3001 maps to dist/<id>/index.html so every deployment gets its own URL.",
  },
];

function Pipeline() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 3200);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <div
      className="pipeline"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="pipeline-track">
        {STEPS.map((s, i) => (
          <div className="pipeline-node-wrap" key={s.num}>
            <button
              className={`pipeline-node ${i === active ? "active" : ""} ${
                i < active ? "passed" : ""
              }`}
              onClick={() => setActive(i)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="node-num">{s.num}</span>
              <span className="node-title">{s.title}</span>
              <span className="node-tag">{s.tag}</span>
            </button>
            {i < STEPS.length - 1 && (
              <div className="pipeline-link">
                <span className="pipeline-dot" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="pipeline-detail" key={active}>
        <p>{STEPS[active].desc}</p>
      </div>
    </div>
  );
}

export default function Landing() {
  const [showCue, setShowCue] = useState(true);

  useEffect(() => {
    const onScroll = () => setShowCue(window.scrollY < 80);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToHow = () => {
    document
      .getElementById("how-it-works")
      ?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <>
      {/* ---------- HERO (unchanged) ---------- */}
      <div className="page landing">
        <div className="glow" />

        <main className="landing-content">
          <span className="badge">Built from scratch</span>

          <h1 className="title">
            Vercel<span className="accent">, from scratch</span>
          </h1>

          <p className="subtitle">
            A tiny deployment platform: paste a GitHub repo, it gets cloned,
            uploaded, built by a worker, and served — powered by an S3 store and
            a Redis job queue.
          </p>

          <div className="cta-row">
            <Link to="/deploy" className="btn btn-primary">
              Deploy a repo →
            </Link>
            <a
              className="btn btn-ghost"
              href="https://github.com/ShauryaaSharma/Vercel-from-scratch"
              target="_blank"
              rel="noreferrer"
            >
              View the project repo
            </a>
          </div>

          <footer className="credit">
            <span>Built by Shaurya</span>
            <span className="dot">•</span>
            <a
              href="https://github.com/ShauryaaSharma"
              target="_blank"
              rel="noreferrer"
            >
              github.com/ShauryaaSharma
            </a>
          </footer>
        </main>

        <button
          className={`scroll-cue ${showCue ? "" : "hidden"}`}
          onClick={scrollToHow}
          aria-label="How it works"
        >
          <span className="scroll-cue-text">How it works?</span>
          <span className="scroll-cue-arrow">↓</span>
        </button>
      </div>

      {/* ---------- HOW IT WORKS ---------- */}
      <section className="section" id="how-it-works">
        <Reveal className="section-head">
          <span className="eyebrow">How it works</span>
          <h2 className="section-title">Four services, one pipeline</h2>
          <p className="section-lead">
            Every deployment flows through the same path. Hover a stage to see
            what it does — it also cycles on its own.
          </p>
        </Reveal>

        <Reveal delay={80}>
          <Pipeline />
        </Reveal>
      </section>

      {/* ---------- THE BACKBONE ---------- */}
      <section className="section">
        <Reveal className="section-head">
          <span className="eyebrow">The backbone</span>
          <h2 className="section-title">Shared infrastructure</h2>
          <p className="section-lead">
            Two pieces glue the services together. Everything talks to the same
            S3 bucket and the same Redis instance.
          </p>
        </Reveal>

        <div className="infra-grid">
          <Reveal className="infra-card" delay={0}>
            <div className="infra-icon">⛃</div>
            <h3>Redis</h3>
            <p>
              A <code>build-queue</code> list moves jobs from upload → worker,
              and a <code>status</code> hash records each deployment's progress
              so the UI can poll it.
            </p>
            <div className="chip-row">
              <span className="chip">lPush / brPop</span>
              <span className="chip">hSet / hGet</span>
            </div>
          </Reveal>

          <Reveal className="infra-card" delay={100}>
            <div className="infra-icon">☁</div>
            <h3>S3 Storage</h3>
            <p>
              Source files land in <code>output/&lt;id&gt;</code>. The worker
              writes the built site to <code>dist/&lt;id&gt;</code>, which the
              request handler serves per-subdomain.
            </p>
            <div className="chip-row">
              <span className="chip">output/&lt;id&gt;</span>
              <span className="chip">dist/&lt;id&gt;</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- LINKS ---------- */}
      <section className="section links-section">
        <Reveal className="section-head">
          <span className="eyebrow">Made by Shaurya</span>
          <h2 className="section-title">Explore & connect</h2>
        </Reveal>

        <Reveal className="link-cards" delay={60}>
          <a
            className="link-card"
            href="https://github.com/ShauryaaSharma/Vercel-from-scratch"
            target="_blank"
            rel="noreferrer"
          >
            <GithubIcon size={22} />
            <span className="link-card-text">
              <span className="link-card-title">Project repo</span>
              <span className="link-card-sub">Vercel-from-scratch</span>
            </span>
            <span className="link-arrow">↗</span>
          </a>

          <a
            className="link-card"
            href="https://github.com/ShauryaaSharma"
            target="_blank"
            rel="noreferrer"
          >
            <GithubIcon size={22} />
            <span className="link-card-text">
              <span className="link-card-title">GitHub profile</span>
              <span className="link-card-sub">github.com/ShauryaaSharma</span>
            </span>
            <span className="link-arrow">↗</span>
          </a>

          <a
            className="link-card"
            href="https://shauryasharma.vercel.app"
            target="_blank"
            rel="noreferrer"
          >
            <span className="link-emoji">🌐</span>
            <span className="link-card-text">
              <span className="link-card-title">Portfolio</span>
              <span className="link-card-sub">shauryasharma.vercel.app</span>
            </span>
            <span className="link-arrow">↗</span>
          </a>
        </Reveal>

        <Reveal className="page-footer" delay={120}>
          <span>Built by Shaurya</span>
          <span className="dot">•</span>
          <a
            href="https://shauryasharma.vercel.app"
            target="_blank"
            rel="noreferrer"
          >
            shauryasharma.vercel.app
          </a>
        </Reveal>
      </section>
    </>
  );
}
