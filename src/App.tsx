import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { JobMode, JobPhase, JobResult, RunnerEvent } from "../shared/types.js";
import {
  type ActiveJob,
  consumeJobEvents,
  downloadArtifact,
  fetchJobResult,
  startJob,
  stopJob
} from "./api.js";

const STORAGE_KEY = "testsmith-active-job-v1";
const phaseOrder: JobPhase[] = [
  "sandbox",
  "clone",
  "install",
  "baseline",
  "agent",
  "final_test",
  "artifacts",
  "done"
];

const phaseLabels: Record<JobPhase, string> = {
  sandbox: "Песочница",
  clone: "Репозиторий",
  install: "Зависимости",
  baseline: "Baseline",
  agent: "Pi-агент",
  final_test: "Проверка",
  artifacts: "Артефакты",
  done: "Готово"
};

const statusLabels: Record<string, string> = {
  passed: "Проверка пройдена",
  degraded: "Готово с ограничениями",
  policy_violation: "Нарушена политика изменений",
  failed: "Задание не выполнено",
  timeout: "Превышен лимит времени"
};

function readSavedJob(): ActiveJob | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const job = JSON.parse(value) as ActiveJob;
    if (Date.parse(job.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

function shortRepository(value: string): string {
  return value.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + " с" : Math.floor(seconds / 60) + " мин " + (seconds % 60) + " с";
}

export default function App() {
  const [repositoryUrl, setRepositoryUrl] = useState("https://github.com/lukeed/clsx");
  const [task, setTask] = useState("Добавь тесты для граничных случаев и проверь, что публичный API сохраняет обратную совместимость.");
  const [mode, setMode] = useState<JobMode>("tests_only");
  const [accessCode, setAccessCode] = useState("");
  const [job, setJob] = useState<ActiveJob | null>(() => readSavedJob());
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<"report" | "diff" | "logs">("report");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(Date.now());

  const currentPhase = useMemo<JobPhase>(() => {
    const phaseEvent = [...events].reverse().find((event) => event.type === "job_status");
    return phaseEvent?.type === "job_status" ? phaseEvent.phase : job ? "sandbox" : "sandbox";
  }, [events, job]);

  const connect = useCallback(async (activeJob: ActiveJob) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let lastEventId = 0;
    let attempts = 0;
    let done = false;

    while (!controller.signal.aborted && !done && attempts < 8) {
      try {
        lastEventId = await consumeJobEvents(
          activeJob,
          (event) => {
            setEvents((current) => {
              if (current.some((item) => item.id === event.id)) return current;
              return [...current, event].slice(-300);
            });
            if (event.type === "job_done") done = true;
          },
          controller.signal,
          lastEventId
        );
        attempts = 0;
      } catch (streamError) {
        if (controller.signal.aborted) return;
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempts, 8000)));
        if (streamError instanceof Error && attempts === 8) setError(streamError.message);
      }
    }

    if (done && !controller.signal.aborted) {
      try {
        setResult(await fetchJobResult(activeJob));
      } catch (resultError) {
        setError(resultError instanceof Error ? resultError.message : "Не удалось получить результат");
      }
    }
  }, []);

  useEffect(() => {
    if (!job) return;
    startedRef.current = Date.now();
    void connect(job);
    return () => abortRef.current?.abort();
  }, [connect, job]);

  useEffect(() => {
    if (!job || result) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedRef.current), 1000);
    return () => window.clearInterval(timer);
  }, [job, result]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    setEvents([]);
    setResult(null);
    startedRef.current = Date.now();
    try {
      const nextJob = await startJob({ repositoryUrl, task, mode, accessCode });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextJob));
      setJob(nextJob);
      setAccessCode("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось запустить задание");
    } finally {
      setSubmitting(false);
    }
  }

  async function stop() {
    if (!job) return;
    abortRef.current?.abort();
    try {
      await stopJob(job);
    } catch {
      // A stopped or expired sandbox is already the desired state.
    }
    sessionStorage.removeItem(STORAGE_KEY);
    setJob(null);
    setResult(null);
    setEvents([]);
  }

  async function download() {
    if (!job) return;
    try {
      await downloadArtifact(job);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Не удалось скачать ZIP");
    }
  }

  function restart() {
    abortRef.current?.abort();
    sessionStorage.removeItem(STORAGE_KEY);
    setJob(null);
    setResult(null);
    setEvents([]);
    setError("");
    setElapsed(0);
  }

  return (
    <div className="app-shell">
      <MatrixRain />
      <div className="screen-vignette" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />
      <header className="site-header">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); restart(); }}>
          <span className="brand-mark">TS</span>
          <span className="brand-copy"><b>TESTSMITH</b><small>AGENT TESTING SYSTEM</small></span>
        </a>
        <div className="header-note">
          <span className="live-dot" />
          <span>SYSTEM ONLINE</span>
          <i>PI / E2B / OPENROUTER</i>
        </div>
      </header>

      <main>
        {!job && (
          <section className="hero-grid">
            <div className="hero-copy">
              <div className="system-index" aria-hidden="true">01</div>
              <p className="eyebrow">Автономный протокол тестирования</p>
              <h1>Испытай код.<br /><span>Увидь истину.</span></h1>
              <p className="lead">
                Передайте публичный JS/TS-репозиторий в изолированную среду. Pi войдёт в код,
                найдёт слабые места и вернёт проверяемый patch — без push и доступа к вашей инфраструктуре.
              </p>
              <div className="hero-terminal" aria-hidden="true">
                <span><i>&gt;</i> INITIALIZING TEST PROTOCOL</span>
                <span><i>&gt;</i> SANDBOX ISOLATION <b>[SECURE]</b></span>
                <span><i>&gt;</i> AWAITING REPOSITORY_</span>
              </div>
              <div className="trust-row">
                <div><b>01 / ISOLATE</b><span>Изолированный E2B</span></div>
                <div><b>02 / OBSERVE</b><span>Живой ход работы</span></div>
                <div><b>03 / VERIFY</b><span>Patch и логи</span></div>
              </div>
            </div>

            <form className="forge-form" onSubmit={submit}>
              <div className="form-head">
                <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
                <span>TESTSMITH://NEW_JOB</span>
                <small>SECURE SESSION · 15 MIN</small>
              </div>
              <label>
                <span>GitHub-репозиторий</span>
                <input
                  type="url"
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                  placeholder="https://github.com/owner/repository"
                  required
                />
              </label>
              <label>
                <span>Что проверить</span>
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  minLength={3}
                  maxLength={2000}
                  rows={5}
                  required
                />
                <small className="counter">{task.length}/2000</small>
              </label>
              <fieldset>
                <legend>Режим работы</legend>
                <label className={"mode-card " + (mode === "tests_only" ? "selected" : "")}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "tests_only"}
                    onChange={() => setMode("tests_only")}
                  />
                  <span><b>Только тесты</b><small>Production-код защищён политикой</small></span>
                </label>
                <label className={"mode-card " + (mode === "tests_and_fix" ? "selected" : "")}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "tests_and_fix"}
                    onChange={() => setMode("tests_and_fix")}
                  />
                  <span><b>Тесты + исправление</b><small>Можно устранить найденный дефект</small></span>
                </label>
              </fieldset>
              <label>
                <span>Код доступа</span>
                <input
                  type="password"
                  value={accessCode}
                  onChange={(event) => setAccessCode(event.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
              {error && <div className="error-banner">{error}</div>}
              <button className="primary-button" disabled={submitting}>
                <span>{submitting ? "Создаю песочницу…" : "Запустить TestSmith"}</span>
                <i>{submitting ? "···" : "ENTER ↵"}</i>
              </button>
            </form>
          </section>
        )}

        {job && (
          <section className="workspace">
            <div className="workspace-head">
              <div>
                <p className="eyebrow">Активное задание</p>
                <h2>{shortRepository(job.repositoryUrl)}</h2>
                <p>{job.task}</p>
              </div>
              <div className="workspace-actions">
                <div className="timer">{formatDuration(elapsed)}</div>
                {!result && <button className="ghost-button danger" onClick={stop}>Остановить</button>}
                {result && <button className="ghost-button" onClick={restart}>Новое задание</button>}
              </div>
            </div>

            <div className="phase-track">
              {phaseOrder.map((phase, index) => {
                const current = phaseOrder.indexOf(currentPhase);
                const state = index < current ? "complete" : index === current ? "active" : "";
                return (
                  <div className={"phase-item " + state} key={phase}>
                    <i>{index < current ? "✓" : String(index + 1).padStart(2, "0")}</i>
                    <span>{phaseLabels[phase]}</span>
                  </div>
                );
              })}
            </div>

            {!result && (
              <div className="activity-layout">
                <div className="activity-panel">
                  <div className="panel-title"><span>RUNNER://LIVE_FEED</span><small>{events.length} EVENTS</small></div>
                  <div className="timeline">
                    {events.length === 0 && <div className="waiting"><i /><span>Подключаюсь к runner’у…</span></div>}
                    {events.map((event) => <EventCard event={event} key={event.id} />)}
                  </div>
                </div>
                <aside className="safety-card">
                  <p>SECURITY PROTOCOL</p>
                  <ul>
                    <li>Только default branch</li>
                    <li>Git remote удаляется</li>
                    <li>Секреты не видны shell</li>
                    <li>Sandbox уничтожается</li>
                  </ul>
                  <div className="job-id">JOB {job.jobId.slice(0, 8).toUpperCase()}</div>
                </aside>
              </div>
            )}

            {result && (
              <div className="result-card">
                <div className={"result-banner status-" + result.status}>
                  <div>
                    <small>Результат TestSmith</small>
                    <h3>{statusLabels[result.status] || result.status}</h3>
                    <p>{result.summary}</p>
                  </div>
                  <button className="primary-button compact" onClick={download}>Скачать ZIP ↓</button>
                </div>

                <div className="metrics">
                  <Metric label="Baseline" value={result.baseline.state} detail={formatDuration(result.baseline.durationMs)} />
                  <Metric label="Final test" value={result.finalTest.state} detail={formatDuration(result.finalTest.durationMs)} />
                  <Metric label="Изменено" value={String(result.changedFiles.length)} detail="файлов" />
                  <Metric label="Package manager" value={result.packageManager} detail={result.commitSha?.slice(0, 8) || "без SHA"} />
                </div>

                <div className="tabs">
                  <button className={activeTab === "report" ? "active" : ""} onClick={() => setActiveTab("report")}>Отчёт</button>
                  <button className={activeTab === "diff" ? "active" : ""} onClick={() => setActiveTab("diff")}>Changes.patch</button>
                  <button className={activeTab === "logs" ? "active" : ""} onClick={() => setActiveTab("logs")}>Логи тестов</button>
                </div>

                <div className="tab-body">
                  {activeTab === "report" && (
                    <article className="markdown">
                      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{result.reportMarkdown}</ReactMarkdown>
                    </article>
                  )}
                  {activeTab === "diff" && <DiffView patch={result.patch} />}
                  {activeTab === "logs" && (
                    <div className="logs-grid">
                      <LogBlock title="Baseline" text={result.baselineLog} />
                      <LogBlock title="Final test" text={result.finalTestLog} />
                    </div>
                  )}
                </div>
              </div>
            )}
            {error && <div className="error-banner floating">{error}</div>}
          </section>
        )}
      </main>

      <footer>
        <span>TESTSMITH // SYS.2026</span>
        <span>ONE JOB · ONE MICRO-VM · ONE VERIFIABLE ARTIFACT</span>
      </footer>
    </div>
  );
}

const matrixColumns = [
  "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘ0Z1", "010011101001011", "ﾇﾌｱｸｴｶｷﾑﾕﾗｾﾈｽ", "TS101PI010E2B",
  "ｺﾎﾃﾏｹﾒｴｶｷﾑﾕﾗ", "1011010011010", "ｻﾜﾂｵﾘﾇﾌｱｸｴｶ", "001TEST11001",
  "ﾐﾋｰｳｼﾅﾓﾆｻﾜﾂ", "111001010011", "ｷﾑﾕﾗｾﾈｽﾀﾇﾍ", "PI01E2B10TS",
  "ﾌｱｸｴｶｷﾑﾕﾗｾ", "010110100101", "ﾓﾆｻﾜﾂｵﾘﾇﾌｱ", "110VERIFY001",
  "ｳｼﾅﾓﾆｻﾜﾂｵﾘ", "010011001011", "ﾗｾﾈｽﾀﾇﾍﾎﾏｹ", "E2B110PI001",
  "ｴｶｷﾑﾕﾗｾﾈｽﾀ", "101001110100", "ﾜﾂｵﾘﾇﾌｱｸｴｶ", "001AGENT101"
];

function MatrixRain() {
  return (
    <div className="matrix-rain" aria-hidden="true">
      {matrixColumns.map((glyphs, index) => (
        <span
          key={index}
          style={{
            left: `${1 + index * 4.2}%`,
            animationDelay: `${-((index * 1.73) % 12)}s`,
            animationDuration: `${10 + (index % 7) * 1.35}s`
          }}
        >
          {glyphs}
        </span>
      ))}
    </div>
  );
}

function EventCard({ event }: { event: RunnerEvent }) {
  if (event.type === "job_status") {
    return <div className="event status-event"><i>◆</i><span><b>{phaseLabels[event.phase]}</b>{event.message}</span></div>;
  }
  if (event.type === "agent_text") {
    return <div className="event text-event"><i>π</i><span>{event.text}</span></div>;
  }
  if (event.type === "tool_start") {
    return <div className="event tool-event running"><i>⌁</i><span><b>{event.toolName}</b>{event.summary}</span><em /></div>;
  }
  if (event.type === "tool_end") {
    return (
      <div className={"event tool-event " + (event.isError ? "failed" : "complete")}>
        <i>{event.isError ? "×" : "✓"}</i>
        <span><b>{event.toolName}</b>{event.summary}</span>
        <small>{formatDuration(event.durationMs)}</small>
      </div>
    );
  }
  if (event.type === "runner_error") {
    return <div className="event error-event"><i>!</i><span>{event.message}</span></div>;
  }
  return <div className="event status-event"><i>✓</i><span><b>Завершено</b>{event.message}</span></div>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><small>{label}</small><b>{value}</b><span>{detail}</span></div>;
}

function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) return <div className="empty-state">Изменений в рабочем дереве нет.</div>;
  return (
    <pre className="diff-view">
      {patch.split("\n").map((line, index) => {
        const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" :
          line.startsWith("-") && !line.startsWith("---") ? "remove" :
          line.startsWith("@@") ? "range" : "";
        return <code className={kind} key={index}>{line + "\n"}</code>;
      })}
    </pre>
  );
}

function LogBlock({ title, text }: { title: string; text: string }) {
  return <section className="log-block"><h4>{title}</h4><pre>{text || "Лог отсутствует"}</pre></section>;
}
