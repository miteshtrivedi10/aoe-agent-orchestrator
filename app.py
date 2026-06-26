import json, logging, os, pty, select, signal, subprocess, threading, time, uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request


app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
LOG = logging.getLogger("hermes-cloud")

LOG_RING = []
LOG_RING_MAX = 500


class RingHandler(logging.Handler):
    def emit(self, record):
        msg = self.format(record)
        LOG_RING.append(msg)
        if len(LOG_RING) > LOG_RING_MAX:
            LOG_RING[:100] = []


_rh = RingHandler()
_rh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
logging.getLogger().addHandler(_rh)

SESSIONS_FILE = Path("/data/sessions.json")
REPOS_DIR = Path("/data/repos")
SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
REPOS_DIR.mkdir(parents=True, exist_ok=True)


def _log_prefix(session_id="?"):
    return f"[{session_id}]"


def _load():
    if SESSIONS_FILE.exists():
        try: return json.loads(SESSIONS_FILE.read_text())
        except Exception: return []
    return []


def _save(sessions):
    SESSIONS_FILE.write_text(json.dumps(sessions, indent=2, default=str))


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _update_status(sessions):
    for s in sessions:
        pid = s.get("pid", 0)
        alive = _alive(pid) if pid else False
        if alive:
            s["status"] = "running"
        else:
            if s.get("status") == "running":
                LOG.info("_update_status pid=%d DEAD, marking stopped", pid)
                s["status"] = "stopped"
                s["stopped_at"] = datetime.now(timezone.utc).isoformat()
    return sessions


def _clone_url(raw):
    token = os.environ.get("GITHUB_TOKEN", "")
    if token and raw.startswith("https://"):
        return f"https://x-access-token:{token}@{raw[8:]}"
    return raw


def _repo_name(raw):
    return raw.rstrip("/").rstrip(".git").split("/")[-1]


def _pipe_reader(stream, logfn, prefix, label):
    for line in iter(stream.readline, b""):
        try:
            logfn("%s %s", _log_prefix(label), line.decode(errors="replace").rstrip())
        except Exception:
            pass
    stream.close()


def _relay_pty(master_fd, label, shared_buf=None):
    buf = b""
    while True:
        try:
            r, _, _ = select.select([master_fd], [], [], 1.0)
            if r:
                data = os.read(master_fd, 4096)
                if not data:
                    LOG.info("_relay_pty %s PTY EOF", _log_prefix(label))
                    break
                LOG.info("_relay_pty %s raw-chunk len=%d preview=%s",
                         _log_prefix(label), len(data),
                         data[:200].decode(errors="replace"))
                buf += data
                if shared_buf is not None:
                    shared_buf.append(data)
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    LOG.info("_relay_pty-line %s %s", _log_prefix(label),
                             line.decode(errors="replace").rstrip())
        except (OSError, ValueError) as exc:
            LOG.info("_relay_pty %s done: %s", _log_prefix(label), exc)
            break
    if buf:
        LOG.info("_relay_pty-tail %s %s", _log_prefix(label),
                 buf.decode(errors="replace").rstrip())


def _strip_ansi(text):
    import re
    return re.sub(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|'
                  r'\x1b[>=]|\x1b\[\?[0-9;]*[a-zA-Z]|'
                  r'\x1b[NOc78DMEHABCDGJKLMPRSTZ]|'
                  r'\x1b\[[0-9;]*[HfJKMmr]|'
                  r'\x1b[()][AB012]', '', text)


def _wait_for_prompt(shared_buf, label, timeout=30):
    start = time.time()
    seen_offset = 0
    while time.time() - start < timeout:
        full = b"".join(shared_buf)
        new_data = full[seen_offset:]
        if new_data:
            decoded_raw = new_data.decode(errors="replace")
            decoded = _strip_ansi(decoded_raw)
            prompts = ["kilo>", "│ > ", "❯ ", "❯", "> ", "/remote",
                       "How can I help", "Type your message",
                       "kilo CLI", "connected"]
            matched = [p for p in prompts if p in decoded]
            if matched:
                LOG.info("_wait_for_prompt %s prompt detected after %.1fs matched=%s",
                         _log_prefix(label), time.time() - start, matched)
                return True
            seen_offset = len(full)
        time.sleep(0.5)
    LOG.warning("_wait_for_prompt %s timeout after %ds", _log_prefix(label), timeout)
    return False


def _send_pty_command(master_fd, cmd, label, desc="cmd"):
    LOG.info("_send_pty_command %s sending: %s", _log_prefix(label), cmd)
    try:
        written = os.write(master_fd, (cmd + "\n").encode())
        LOG.info("_send_pty_command %s %s sent (%d bytes)", _log_prefix(label), desc, written)
        return True
    except OSError as e:
        LOG.error("_send_pty_command %s %s WRITE FAILED: %s", _log_prefix(label), desc, e)
        return False


def _start_kilo_session(work_dir, label):
    work_dir = Path(work_dir)
    LOG.info("_start_kilo_session %s work_dir=%s", _log_prefix(label), work_dir)

    env = os.environ.copy()
    env["KILO_REMOTE"] = "1"

    master_fd, slave_fd = os.openpty()
    kilo_proc = subprocess.Popen(
        ["kilo"],
        cwd=str(work_dir), stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        preexec_fn=os.setsid,
        env=env,
    )
    os.close(slave_fd)
    LOG.info("_start_kilo_session %s kilo pid=%d", _log_prefix(label), kilo_proc.pid)

    pty_shared_buf = []

    threading.Thread(
        target=_relay_pty, args=(master_fd, label, pty_shared_buf), daemon=True
    ).start()

    LOG.info("_start_kilo_session %s waiting for prompt...", _log_prefix(label))
    _wait_for_prompt(pty_shared_buf, label, timeout=30)

    time.sleep(2)

    # Register session with Kilo Gateway relay via /remote
    LOG.info("_start_kilo_session %s sending /remote to register with Gateway", _log_prefix(label))
    for attempt in range(3):
        _send_pty_command(master_fd, "/remote", label, desc=f"/remote attempt {attempt+1}")
        time.sleep(2)

    time.sleep(2)

    # Send the one-time project prompt
    prompt = "based on readme explain project in 2 lines"
    LOG.info("_start_kilo_session %s sending initial prompt", _log_prefix(label))
    _send_pty_command(master_fd, prompt, label, desc="initial-prompt")

    def _monitor_exit():
        kilo_proc.wait()
        exit_code = kilo_proc.returncode
        LOG.info("_monitor_exit %s kilo exited code=%d", _log_prefix(label), exit_code)
        all_sessions = _load()
        for s in all_sessions:
            if s.get("pid") == kilo_proc.pid and s.get("status") == "running":
                s["status"] = "stopped"
                s["stopped_at"] = datetime.now(timezone.utc).isoformat()
                s["exit_code"] = exit_code
        _save(all_sessions)
    threading.Thread(target=_monitor_exit, daemon=True).start()

    return kilo_proc.pid


def _checkout_repo(repo_url, branch, session_id):
    repo = _repo_name(repo_url)
    ws = REPOS_DIR / f"{repo}__{session_id}"
    label = session_id

    LOG.info("_checkout_repo %s url=%s branch=%s dir=%s", _log_prefix(label), repo_url, branch, ws)

    clone_url = _clone_url(repo_url)
    result = subprocess.run(
        ["git", "clone", clone_url, str(ws)],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        LOG.error("_checkout_repo %s clone failed (exit=%d)", _log_prefix(label), result.returncode)
        raise RuntimeError("clone failed — check repo URL and access permissions")

    if branch:
        # Try checkout existing branch, then create locally
        r = subprocess.run(
            ["git", "-C", str(ws), "checkout", branch],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            LOG.info("_checkout_repo %s branch '%s' not found, creating from default", _log_prefix(label), branch)
            subprocess.run(
                ["git", "-C", str(ws), "checkout", "-b", branch],
                capture_output=True, text=True, timeout=30,
            )
    else:
        branch = f"hermes-{session_id}"
        LOG.info("_checkout_repo %s no branch given, creating %s", _log_prefix(label), branch)
        subprocess.run(
            ["git", "-C", str(ws), "checkout", "-b", branch],
            capture_output=True, text=True, timeout=30,
        )

    files = list(ws.iterdir())
    LOG.info("_checkout_repo %s entries: %s", _log_prefix(label), [f.name for f in files[:10]])
    return str(ws), branch


# ── Routes ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    result = {
        "kilo_version": "unknown",
        "kilo_which": None,
        "daemon_running": False,
        "auth_exists": False,
        "repos_dir_exists": REPOS_DIR.exists(),
        "session_count": len(_load()),
    }
    try:
        r = subprocess.run(["which", "kilo"], capture_output=True, text=True, timeout=5)
        result["kilo_which"] = r.stdout.strip()
    except Exception:
        pass
    try:
        r = subprocess.run(["kilo", "--version"], capture_output=True, text=True, timeout=5)
        result["kilo_version"] = r.stdout.strip()[:100] or r.stderr.strip()[:100]
    except Exception:
        pass
    auth_path = Path("/data/kilo/auth.json")
    if auth_path.exists():
        result["auth_exists"] = True
    return jsonify(result)


@app.route("/api/logs")
def api_logs():
    n = request.args.get("n", 200, type=int)
    lines = LOG_RING[-n:]
    return jsonify({"count": len(lines), "lines": lines})


@app.route("/api/sessions")
def api_sessions():
    raw = _load()
    sessions = _update_status(raw)
    _save(sessions)
    return jsonify(sessions)


@app.route("/api/spin-up", methods=["POST"])
def api_spin_up():
    data = request.get_json(silent=True) or {}
    repo_url = (data.get("repo_url") or "").strip()
    branch = (data.get("branch") or "").strip() or None

    if not repo_url:
        return jsonify({"error": "repo_url required"}), 400

    session_id = str(_uuid.uuid4())[:8]
    repo = _repo_name(repo_url)
    label = session_id
    LOG.info("spin-up session=%s repo=%s branch=%s", label, repo, branch)

    try:
        work_dir, resolved_branch = _checkout_repo(repo_url, branch, session_id)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500

    kilo_pid = _start_kilo_session(work_dir, label)

    session = {
        "id": session_id,
        "repo_url": repo_url,
        "repo_name": repo,
        "branch": resolved_branch,
        "work_dir": work_dir,
        "pid": kilo_pid,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    sessions = _update_status(_load())
    sessions.append(session)
    _save(sessions)
    LOG.info("spin-up %s created id=%s pid=%d branch=%s", _log_prefix(label),
             session_id, kilo_pid, resolved_branch)
    return jsonify(session), 201


@app.route("/api/kill/<session_id>", methods=["POST"])
def api_kill(session_id):
    sessions = _update_status(_load())
    for s in sessions:
        if s["id"] != session_id:
            continue
        pid = s.get("pid", 0)
        if pid and _alive(pid):
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try: os.kill(pid, signal.SIGTERM)
                except OSError: pass
        s["status"] = "killed"
        s["stopped_at"] = datetime.now(timezone.utc).isoformat()
        _save(sessions)
        return jsonify({"status": "killed", "session_id": session_id})
    return jsonify({"error": "session not found"}), 404


# ── Device Auth (interactive kilo auth login) ───────────────────────

_device_auth = {
    "status": "idle",
    "url": None,
    "code": None,
    "message": None,
    "process": None,
    "master_fd": None,
    "started_at": None,
}


def _run_device_auth():
    global _device_auth
    _device_auth["status"] = "pending"
    _device_auth["url"] = None
    _device_auth["code"] = None
    _device_auth["message"] = "Starting Kilo authentication..."
    _device_auth["started_at"] = time.time()

    try:
        master_fd, slave_fd = os.openpty()
        _device_auth["master_fd"] = master_fd

        proc = subprocess.Popen(
            ["kilo", "auth", "login", "-p", "kilo"],
            stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            preexec_fn=os.setsid,
        )
        _device_auth["process"] = proc
        os.close(slave_fd)

        LOG.info("_run_device_auth started pid=%d", proc.pid)

        buf = b""
        deadline = time.time() + 300
        while time.time() < deadline:
            if _device_auth["status"] == "cancelled":
                proc.terminate()
                break
            r, _, _ = select.select([master_fd], [], [], 1.0)
            if r:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    decoded = line.decode(errors="replace").strip()
                    if decoded:
                        LOG.info("_run_device_auth output: %s", decoded[:200])
                    if "app.kilo.ai/device-auth" in decoded:
                        import re
                        urls = re.findall(r'https://app\.kilo\.ai/\S+', decoded)
                        if urls:
                            _device_auth["url"] = urls[0].rstrip("│").strip()
                            _device_auth["message"] = "Open the URL below and enter the code"
                            LOG.info("_run_device_auth URL: %s", _device_auth["url"])
                    if "enter code" in decoded.lower() or "code:" in decoded.lower():
                        import re
                        codes = re.findall(r'[A-Z0-9]{4}-[A-Z0-9]{4}', decoded)
                        if codes:
                            _device_auth["code"] = codes[0]
                            LOG.info("_run_device_auth code: %s", _device_auth["code"])
                    if _device_auth["url"] and not _device_auth["code"]:
                        import re
                        codes = re.findall(r'code=([A-Z0-9]{4}-[A-Z0-9]{4})', _device_auth["url"])
                        if codes:
                            _device_auth["code"] = codes[0]
                    if "login successful" in decoded.lower() or "done" in decoded.lower():
                        _device_auth["status"] = "success"
                        _device_auth["message"] = "Login successful!"
                        LOG.info("_run_device_auth SUCCESS")
                    if "denied" in decoded.lower() or "expired" in decoded.lower():
                        _device_auth["status"] = "failed"
                        _device_auth["message"] = f"Login failed: {decoded}"
                        LOG.warning("_run_device_auth FAILED: %s", decoded)
            if proc.poll() is not None:
                if _device_auth["status"] not in ("success", "failed", "cancelled"):
                    if proc.returncode == 0:
                        _device_auth["status"] = "success"
                        _device_auth["message"] = "Login successful!"
                    else:
                        _device_auth["status"] = "failed"
                        _device_auth["message"] = f"Login failed (exit {proc.returncode})"
                break

        try:
            os.close(master_fd)
        except OSError:
            pass
        _device_auth["master_fd"] = None
        _device_auth["process"] = None

        # If login was successful, enable Gateway relay
        if _device_auth["status"] == "success":
            LOG.info("_run_device_auth starting kilo daemon and enabling Gateway relay")
            daemon_log = Path("/data/kilo/daemon.log")
            # Clean up any stale daemon first
            try:
                subprocess.run(["kilo", "daemon", "stop"], timeout=10,
                               capture_output=True)
            except Exception:
                pass
            time.sleep(1)
            # Start the daemon (--foreground so Popen keeps it alive)
            try:
                subprocess.Popen(
                    ["kilo", "daemon", "start", "--foreground"],
                    stdout=daemon_log.open("ab"), stderr=subprocess.STDOUT,
                )
            except Exception as exc:
                LOG.warning("_run_device_auth daemon start: %s", exc)
            time.sleep(5)
            # Verify daemon is running
            try:
                dr = subprocess.run(["kilo", "daemon", "status"],
                                    capture_output=True, text=True, timeout=10)
                LOG.info("_run_device_auth daemon status exit=%d out=%s err=%s",
                         dr.returncode, dr.stdout.strip()[:200], dr.stderr.strip()[:200])
            except Exception as exc:
                LOG.warning("_run_device_auth daemon status: %s", exc)
            # Enable gateway relay
            try:
                r = subprocess.run(
                    ["kilo", "remote"],
                    capture_output=True, text=True, timeout=15,
                    env={**os.environ, "KILO_REMOTE": "1"},
                )
                LOG.info("_run_device_auth kilo remote exit=%d out=%s err=%s",
                         r.returncode, r.stdout.strip()[:200], r.stderr.strip()[:200])
                _device_auth["message"] = "Login successful! Gateway relay enabled."
            except Exception as exc:
                LOG.warning("_run_device_auth kilo remote failed: %s", exc)

        if _device_auth["status"] == "pending":
            _device_auth["status"] = "failed"
            _device_auth["message"] = "Login timed out (5 minutes)"
    except Exception as exc:
        LOG.error("_run_device_auth exception: %s", exc)
        _device_auth["status"] = "failed"
        _device_auth["message"] = f"Error: {exc}"


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    if _device_auth["status"] == "pending":
        return jsonify({
            "status": "pending",
            "url": _device_auth["url"],
            "code": _device_auth["code"],
            "message": _device_auth["message"],
        })
    _device_auth["status"] = "idle"
    _device_auth["url"] = None
    _device_auth["code"] = None
    _device_auth["message"] = None
    threading.Thread(target=_run_device_auth, daemon=True).start()
    for _ in range(20):
        if _device_auth["url"]:
            break
        time.sleep(0.5)
    return jsonify({
        "status": _device_auth["status"],
        "url": _device_auth["url"],
        "code": _device_auth["code"],
        "message": _device_auth["message"],
    })


@app.route("/api/auth/status")
def api_auth_status():
    return jsonify({
        "status": _device_auth["status"],
        "url": _device_auth["url"],
        "code": _device_auth["code"],
        "message": _device_auth["message"],
    })


@app.route("/api/auth/cancel", methods=["POST"])
def api_auth_cancel():
    _device_auth["status"] = "cancelled"
    _device_auth["message"] = "Login cancelled"
    if _device_auth["process"]:
        try:
            _device_auth["process"].terminate()
        except Exception:
            pass
    if _device_auth["master_fd"]:
        try:
            os.close(_device_auth["master_fd"])
        except OSError:
            pass
    _device_auth["process"] = None
    _device_auth["master_fd"] = None
    return jsonify({"status": "cancelled"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    app.run(host="0.0.0.0", port=port, debug=False)
