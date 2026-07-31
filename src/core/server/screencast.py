import json
import os
import subprocess
import threading
import time
from pathlib import Path

RECORDINGS_DIR = os.path.join(os.path.expanduser("~"), ".echo", "recordings")
TOKENS_FILE = os.path.join(os.path.expanduser("~"), ".echo", "screencast-tokens.json")

SOURCE_TYPES = {"screen": 1, "window": 2}

_tokens_lock = threading.Lock()


def _load_restore_token(target: str) -> str | None:
    with _tokens_lock:
        try:
            with open(TOKENS_FILE, "r") as f:
                return json.load(f).get(target)
        except Exception:
            return None


def _save_restore_token(target: str, token: str) -> None:
    with _tokens_lock:
        try:
            data = {}
            if os.path.exists(TOKENS_FILE):
                with open(TOKENS_FILE, "r") as f:
                    data = json.load(f)
            data[target] = token
            os.makedirs(os.path.dirname(TOKENS_FILE), exist_ok=True)
            with open(TOKENS_FILE, "w") as f:
                json.dump(data, f)
        except Exception:
            pass  # best-effort cache — worst case the picker shows again next time

try:
    import dbus
    import dbus.mainloop.glib
    from gi.repository import GLib

    _available = True
    _import_error = None
except Exception as e:
    _available = False
    _import_error = str(e)

_loop_started = False
_bus = None
_state_lock = threading.Lock()
_active = None

_token_counter = 0
_token_lock = threading.Lock()


def is_available() -> bool:
    return _available


def _ensure_loop() -> None:
    global _loop_started, _bus
    if _loop_started:
        return
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    _bus = dbus.SessionBus()
    loop = GLib.MainLoop()
    threading.Thread(target=loop.run, daemon=True).start()
    _loop_started = True


def _new_token() -> str:
    global _token_counter
    with _token_lock:
        _token_counter += 1
        return f"echo{int(time.time() * 1000)}{_token_counter}"


def _request_path(unique_name: str, tok: str) -> str:
    sender = unique_name.lstrip(":").replace(".", "_")
    return f"/org/freedesktop/portal/desktop/request/{sender}/{tok}"


def _wait_for_response(bus, request_path: str, timeout: float = 120.0) -> dict:
    result: dict = {}
    event = threading.Event()

    def handler(response, results):
        result["response"] = int(response)
        result["results"] = results
        event.set()

    sig = bus.add_signal_receiver(
        handler,
        signal_name="Response",
        dbus_interface="org.freedesktop.portal.Request",
        path=request_path,
    )
    try:
        if not event.wait(timeout):
            raise TimeoutError("screen-share picker timed out (was it dismissed?)")
    finally:
        sig.remove()

    if result["response"] != 0:
        reason = (
            "screen-share request was cancelled"
            if result["response"] == 1
            else f"portal request failed ({result['response']})"
        )
        raise RuntimeError(reason)
    return result["results"]


def start_recording(target: str) -> dict:
    if not _available:
        raise RuntimeError(f"screen recording unavailable: {_import_error}")
    if target not in SOURCE_TYPES:
        raise ValueError(f"invalid target: {target}")

    with _state_lock:
        global _active
        if _active is not None:
            raise RuntimeError("a recording is already in progress")

        _ensure_loop()
        bus = _bus
        session_handle = None
        try:
            Path(RECORDINGS_DIR).mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
            output_path = os.path.join(RECORDINGS_DIR, f"{target}-{stamp}.mp4")

            portal = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
            screencast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")
            unique_name = bus.get_unique_name()

            session_token = _new_token()
            create_token = _new_token()
            req_path = _request_path(unique_name, create_token)
            screencast.CreateSession(
                {"handle_token": create_token, "session_handle_token": session_token}
            )
            results = _wait_for_response(bus, req_path)
            session_handle = str(results["session_handle"])

            select_token = _new_token()
            req_path = _request_path(unique_name, select_token)
            select_options = {
                "handle_token": select_token,
                "types": dbus.UInt32(SOURCE_TYPES[target]),
                "multiple": False,
                "cursor_mode": dbus.UInt32(2),
                # persist_mode=2: remember the granted source until revoked, so a saved
                # restore_token can skip the picker entirely on the next recording of
                # the same target instead of prompting every single time.
                "persist_mode": dbus.UInt32(2),
            }
            saved_token = _load_restore_token(target)
            if saved_token:
                select_options["restore_token"] = saved_token
            screencast.SelectSources(session_handle, select_options)
            _wait_for_response(bus, req_path)

            start_token = _new_token()
            req_path = _request_path(unique_name, start_token)
            screencast.Start(session_handle, "", {"handle_token": start_token})
            results = _wait_for_response(bus, req_path)
            streams = results.get("streams")
            if not streams:
                raise RuntimeError("no screen/window was selected in the picker")
            node_id = int(streams[0][0])

            new_token = results.get("restore_token")
            if new_token:
                _save_restore_token(target, str(new_token))

            fd_obj = screencast.OpenPipeWireRemote(session_handle, {})
            fd = fd_obj.take()

            try:
                process = subprocess.Popen(
                    [
                        "gst-launch-1.0",
                        "-e",
                        "pipewiresrc",
                        f"fd={fd}",
                        f"path={node_id}",
                        "!",
                        "videoconvert",
                        "!",
                        "queue",
                        "!",
                        "x264enc",
                        "tune=zerolatency",
                        "speed-preset=ultrafast",
                        "bitrate=4000",
                        "!",
                        "mp4mux",
                        "!",
                        "filesink",
                        f"location={output_path}",
                    ],
                    pass_fds=(fd,),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
            finally:
                os.close(fd)

            _active = {
                "process": process,
                "session_handle": session_handle,
                "output_path": output_path,
                "started_at": time.time(),
            }
            return {"target": target, "output_path": output_path}
        except Exception:
            if session_handle is not None:
                try:
                    session_obj = bus.get_object("org.freedesktop.portal.Desktop", session_handle)
                    dbus.Interface(session_obj, "org.freedesktop.portal.Session").Close()
                except Exception:
                    pass
            raise


def stop_recording() -> dict:
    global _active
    with _state_lock:
        if _active is None:
            raise RuntimeError("no recording is currently running")
        state = _active
        _active = None

    process = state["process"]
    if process.poll() is None:
        process.send_signal(2)  # SIGINT -> gst-launch -e finalizes the mp4 on EOS
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    try:
        session_obj = _bus.get_object("org.freedesktop.portal.Desktop", state["session_handle"])
        dbus.Interface(session_obj, "org.freedesktop.portal.Session").Close()
    except Exception:
        pass

    return {
        "output_path": state["output_path"],
        "seconds": round(time.time() - state["started_at"]),
    }
