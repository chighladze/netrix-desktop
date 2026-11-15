"""Opt-in interoperability test with an isolated AsyncSSH SFTP server.

Install AsyncSSH separately (not an app dependency), then run with --backend.
All server files, trust entries, and SQLite data live in a disposable directory.
The script stops only the backend process and servers which it creates.
"""
import argparse
import asyncio
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import asyncssh


def run_suite(base, token, remote, ssh_port, reject_port, controls):
    def request(method, path, body=None, expected=200, raw=False, timeout=30):
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        headers = {"X-API-Token": token, "Content-Type": "application/octet-stream" if isinstance(body, bytes) else "application/json"}
        req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                assert response.status == expected, (path, response.status)
                result = response.read()
                return result if raw else json.loads(result) if result else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode()
            assert error.code == expected, (path, error.code, detail)
            return json.loads(detail)

    request("POST", "/security/unlock", {"master_password": "isolated-smoke-vault-password"})
    host = request("POST", "/hosts", {"name": "isolated-sftp", "hostname": "127.0.0.1", "port": ssh_port, "username": "smoke", "password": "isolated-sftp-password", "connection_type": "ssh"}, 201)
    prefix = f'/sftp/hosts/{host["id"]}'
    unsupported = request("POST", "/hosts", {"name": "no-sftp", "hostname": "127.0.0.1", "port": reject_port, "username": "smoke", "password": "isolated-sftp-password", "connection_type": "ssh"}, 201)
    result = request("POST", f'/sftp/hosts/{unsupported["id"]}/probe', {})
    assert result["status"] == "unsupported", result
    print("PASS: explicit SSH subsystem rejection is classified as unsupported", flush=True)

    def job(kind, path, size=None, overwrite=False):
        body = {"kind": kind, "path": path, "bytes_total": size, "overwrite": overwrite}
        if overwrite:
            body["confirmation"] = "OVERWRITE"
        return request("POST", prefix + "/transfers", body, 201)

    def upload(path, data, overwrite=False, expected=200):
        transfer = job("upload", path, len(data), overwrite)
        query = urllib.parse.urlencode({"path": path, "transfer_id": transfer["id"]})
        response = request("POST", prefix + "/upload?" + query, data, expected)
        return transfer, response

    def wait_job(transfer, statuses):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            result = request("GET", f'/sftp/transfers/{transfer["id"]}')
            if result["status"] in statuses:
                return result
            time.sleep(0.05)
        raise AssertionError(("Transfer did not reach expected state", result))

    assert request("GET", prefix + "/list?path=.")["entries"] == []
    connections = controls["connections"]
    request("POST", "/vault/lock", {})
    request("GET", prefix + "/list?path=.", expected=401)
    assert controls["connections"] == connections
    request("POST", "/vault/unlock", {"master_password": "isolated-smoke-vault-password"})
    assert request("GET", prefix + "/list?path=.")["entries"] == []
    assert controls["connections"] == connections, "Unlock should preserve safe reuse of the authenticated transport"
    print("PASS: nonempty saved Vault password authenticates; locked Vault blocks even a cached connection", flush=True)
    payload = secrets.token_bytes(2 * 1024 * 1024 + 123)
    transfer, _ = upload("/report.bin", payload)
    assert wait_job(transfer, {"completed"})["bytes_done"] == len(payload)
    assert (remote / "report.bin").read_bytes() == payload
    downloaded = request("GET", prefix + "/download?path=/report.bin", raw=True)
    assert downloaded == payload
    assert controls["connections"] == connections, "Sequential operations should reuse one isolated SSH connection"
    print("PASS: real SSH, reused SFTP connection, pipelined upload/download byte equality", flush=True)

    # Append after the initial FSTAT, while the first READ is in flight.
    # A live log download should finish at its original boundary, even when its
    # metadata has changed by the final FSTAT.
    log_contents = b"existing log line\n" * 8192
    log_path = remote / "app.log"
    log_path.write_bytes(log_contents)
    controls["append_on_read"] = log_path
    transfer = job("download", "/app.log")
    downloaded = request("GET", prefix + "/download?" + urllib.parse.urlencode({"path": "/app.log", "transfer_id": transfer["id"]}), raw=True)
    result = wait_job(transfer, {"completed", "failed"})
    assert result["status"] == "completed", result
    assert downloaded == log_contents
    assert log_path.stat().st_size > len(downloaded)
    assert result["bytes_done"] == result["bytes_total"] == len(log_contents)
    assert "later data is not included" in result["warning"], result
    print("PASS: growing log saves exactly its original bytes and returns a growth notice", flush=True)

    # Profiles sharing an endpoint still have independent disconnect lifetimes.
    other = request("POST", "/hosts", {"name": "isolated-sftp-other", "hostname": "127.0.0.1", "port": ssh_port, "username": "smoke", "password": "isolated-sftp-password"}, 201)
    other_prefix = f'/sftp/hosts/{other["id"]}'
    request("GET", other_prefix + "/list?path=.")
    assert controls["connections"] == connections + 1
    request("POST", prefix + "/disconnect", {}, 204)
    request("GET", other_prefix + "/list?path=.")
    assert controls["connections"] == connections + 1, "Disconnecting one profile must preserve the other's idle transport"
    request("GET", prefix + "/list?path=.")
    assert controls["connections"] == connections + 2
    controls["pause_list"] = True
    controls["list_started"].clear()
    with concurrent.futures.ThreadPoolExecutor() as executor:
        listing = executor.submit(request, "GET", prefix + "/list?path=.")
        try:
            assert controls["list_started"].wait(5), "Listing did not reach the gated server"
            request("POST", prefix + "/disconnect", {}, 204)
        finally:
            controls["pause_list"] = False
        listing.result(timeout=5)
    before = controls["connections"]
    request("GET", prefix + "/list?path=.")
    assert controls["connections"] == before + 1, "A lease finishing after disconnect must never repopulate the pool"
    print("PASS: per-profile disconnect preserves other hosts and invalidates in-flight leases", flush=True)

    upload("/report.bin", b"forbidden replacement", expected=400)
    assert (remote / "report.bin").read_bytes() == payload
    transfer, _ = upload("/report.bin", b"replacement", overwrite=True)
    assert wait_job(transfer, {"completed"})["bytes_done"] == 11
    assert (remote / "report.bin").read_bytes() == b"replacement"
    print("PASS: explicit overwrite and atomic replacement", flush=True)

    controls["fail_close"] = True
    transfer, _ = upload("/report.bin", b"must not commit", overwrite=True, expected=400)
    assert wait_job(transfer, {"failed"})["error"]
    assert (remote / "report.bin").read_bytes() == b"replacement"
    assert not list(remote.glob(".netrix-*.part"))
    print("PASS: server CLOSE failure preserves destination and removes temporary upload", flush=True)

    request("POST", prefix + "/operations", {"action": "mkdir", "path": "/folder"}, 204)
    name = "/folder/ spaced-\u2713.bin "
    upload(name, b"unicode")
    assert request("GET", prefix + "/download?" + urllib.parse.urlencode({"path": name}), raw=True) == b"unicode"
    request("POST", prefix + "/operations", {"action": "rename", "path": name, "destination": "/folder/renamed.bin"}, 204)
    request("POST", prefix + "/operations", {"action": "chmod", "path": "/folder/renamed.bin", "permissions": "600"}, 204)
    request("POST", prefix + "/operations", {"action": "delete", "path": "/folder", "confirmation": "/folder"}, 400)
    assert (remote / "folder/renamed.bin").exists(), "Non-empty directories must be protected"
    request("POST", prefix + "/operations", {"action": "delete", "path": "/folder/renamed.bin", "confirmation": "/folder/renamed.bin"}, 204)
    request("POST", prefix + "/operations", {"action": "delete", "path": "/folder", "confirmation": "/folder"}, 204)
    print("PASS: Unicode/space paths, mkdir, rename, chmod, empty-directory deletion", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        controls["write_delay"] = 0.03
        data = secrets.token_bytes(4 * 1024 * 1024)
        transfer = job("upload", "/report.bin", len(data), True)
        query = urllib.parse.urlencode({"path": "/report.bin", "transfer_id": transfer["id"]})
        pending = executor.submit(request, "POST", prefix + "/upload?" + query, data, 400)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            current = request("GET", f'/sftp/transfers/{transfer["id"]}')
            if current["bytes_done"] > 0:
                break
            time.sleep(0.03)
        assert 0 < current["bytes_done"] < len(data)
        request("POST", f'/sftp/transfers/{transfer["id"]}/cancel', {})
        pending.result(timeout=20)
        cancelled = wait_job(transfer, {"cancelled"})
        assert cancelled["bytes_done"] < len(data)
        controls["write_delay"] = 0
        assert (remote / "report.bin").read_bytes() == b"replacement"
        assert not list(remote.glob(".netrix-*.part")), cancelled
    print("PASS: cancellation stops remote writes, preserves destination and cleans temporary file", flush=True)

    (remote / "large.bin").write_bytes(secrets.token_bytes(4 * 1024 * 1024))
    controls["read_delay"] = 0.02
    transfer = job("download", "/large.bin")
    req = urllib.request.Request(base + prefix + "/download?" + urllib.parse.urlencode({"path": "/large.bin", "transfer_id": transfer["id"]}), headers={"X-API-Token": token})
    with urllib.request.urlopen(req, timeout=15) as response:
        assert response.read(32768)
    wait_job(transfer, {"cancelled", "failed"})
    controls["read_delay"] = 0
    print("PASS: closing download consumer stops its backend job", flush=True)

    # Prove the deadline covers authentication, not just the TCP connection.
    request("POST", prefix + "/disconnect", expected=204)
    controls["stall_auth"] = True
    before = time.monotonic()
    result = request("GET", prefix + "/list?path=.", expected=400, timeout=26)
    assert "timed out" in result["detail"]
    assert time.monotonic() - before < 25
    controls["stall_auth"] = False
    print("PASS: stalled SSH authentication is bounded by the setup deadline", flush=True)

    controls["stall_auth"] = True
    before_connections = controls["connections"]
    with concurrent.futures.ThreadPoolExecutor() as executor:
        pending = executor.submit(request, "GET", prefix + "/list?path=.", expected=400)
        try:
            deadline = time.monotonic() + 5
            while controls["connections"] == before_connections and time.monotonic() < deadline:
                time.sleep(0.01)
            assert controls["connections"] > before_connections
            before = time.monotonic()
            request("POST", prefix + "/disconnect", {}, 204)
            result = pending.result(timeout=5)
            assert "disconnected" in result["detail"], result
            assert time.monotonic() - before < 5
        finally:
            controls["stall_auth"] = False
    print("PASS: disconnect cancels pending SSH setup without waiting for its timeout", flush=True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", type=Path, required=True)
    args = parser.parse_args()
    backend = args.backend.resolve(strict=True)
    validation = Path(__file__).resolve().parents[1] / "backend-rs/target/validation"
    validation.mkdir(parents=True, exist_ok=True)
    import threading
    controls = {"connections": 0, "fail_close": False, "write_delay": 0, "read_delay": 0, "stall_auth": False, "pause_list": False, "list_started": threading.Event()}
    active_connections = []

    class SSHServer(asyncssh.SSHServer):
        def connection_made(self, connection):
            controls["connections"] += 1
            active_connections.append(connection)

        async def begin_auth(self, username):
            if controls["stall_auth"]:
                await asyncio.sleep(60)
            return True

        def password_auth_supported(self):
            return True

        def validate_password(self, username, password):
            return username == "smoke" and password == "isolated-sftp-password"

    class SFTPServer(asyncssh.SFTPServer):
        async def scandir(self, path):
            controls["list_started"].set()
            while controls["pause_list"]:
                await asyncio.sleep(0.01)
            async for entry in super().scandir(path):
                yield entry

        async def write(self, file_obj, offset, data):
            await asyncio.sleep(controls["write_delay"])
            return super().write(file_obj, offset, data)

        async def read(self, file_obj, offset, size):
            await asyncio.sleep(controls["read_delay"])
            growing = controls.get("append_on_read")
            if growing and offset == 0 and Path(os.fsdecode(file_obj.name)) == growing:
                controls.pop("append_on_read")
                with growing.open("ab") as log:
                    log.write(b"new line after download began\n")
                now = time.time() + 2
                os.utime(growing, (now, now))
            return super().read(file_obj, offset, size)

        def close(self, file_obj):
            super().close(file_obj)
            if controls["fail_close"]:
                controls["fail_close"] = False
                raise asyncssh.SFTPFailure("Injected disk failure on CLOSE")

    class RejectSession(asyncssh.SSHServerSession):
        def subsystem_requested(self, subsystem):
            return False

    with tempfile.TemporaryDirectory(prefix="sftp-smoke-", dir=validation) as temporary:
        root = Path(temporary).resolve()
        assert root.is_relative_to(validation.resolve())
        remote = root / "remote"
        remote.mkdir()
        server = await asyncssh.create_server(SSHServer, "127.0.0.1", 0, server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            sftp_factory=lambda channel: SFTPServer(channel, chroot=os.fsencode(remote)), encoding=None)
        reject_server = await asyncssh.create_server(SSHServer, "127.0.0.1", 0, server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            session_factory=RejectSession, encoding=None)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            backend_port = reservation.getsockname()[1]
        token = secrets.token_hex(32)
        env = {**os.environ, "NETRIX_DATA_DIR": str(root / "data")}
        env.pop("NETRIX_DEV", None)
        env.pop("SSH_KNOWN_HOSTS_POLICY", None)
        with (root / "process.log").open("wb") as output:
            process = subprocess.Popen([str(backend), str(backend_port)], stdin=subprocess.PIPE, stdout=output, stderr=output, env=env)
            try:
                process.stdin.write((token + "\n").encode())
                process.stdin.flush()
                process.stdin.close()
                base = f"http://127.0.0.1:{backend_port}"
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError("Isolated backend failed to start")
                    try:
                        await asyncio.to_thread(urllib.request.urlopen, urllib.request.Request(base + "/health", headers={"X-API-Token": token}), timeout=0.2)
                        break
                    except (OSError, urllib.error.URLError):
                        await asyncio.sleep(0.1)
                await asyncio.to_thread(run_suite, base, token, remote, server.get_port(), reject_server.get_port(), controls)
            except BaseException:
                log = root / "data/backend.log"
                if log.exists():
                    print(log.read_text(errors="replace")[-5000:])
                raise
            finally:
                if process.poll() is None:
                    process.kill()
                await asyncio.to_thread(process.wait, timeout=10)
                server.close()
                reject_server.close()
                # Python 3.12 listener shutdown waits for accepted transports.
                # Abort our fixtures first, including the stalled-auth case,
                # instead of waiting on a listener with live connections.
                for connection in active_connections:
                    connection.abort()
                await asyncio.wait_for(asyncio.gather(
                    server.wait_closed(), reject_server.wait_closed(),
                    *(connection.wait_closed() for connection in active_connections),
                ), timeout=10)
                await asyncio.sleep(0.1)
    print("All isolated SFTP interoperability checks passed; temporary data removed.", flush=True)


if __name__ == "__main__":
    if os.name == "nt":
        # This fixture uses TCP and synchronous Popen, not asyncio pipes.
        # Proactor's connection-lost callback can fail on the deliberately
        # reset sockets, leaving Server.wait_closed() waiting indefinitely.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
