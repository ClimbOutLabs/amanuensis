#!/usr/bin/env python3

"""Materialize skill directories into TFY_SKILLS_DIR (default /opt/tfy/skills).

Reads `.tfy-requested-skills.json` (uploaded by the host), installs each entry under
TFY_SKILLS_DIR, then deletes the requested file. Empty `"skills": []` clears installs.
On-disk state skips unchanged skills and removes ones no longer requested.

Git: each skill is a blob-filtered sparse `git` clone of only the requested subdir at
a resolved object id (keyed by name). Mount `ref` (branch, tag, or full object id) is
resolved here via `git ls-remote` — the host never spawns git. Sparse clone is used
instead of a full-repo tarball so cost tracks subdir size, not monorepo size.

Registry: download a presigned tar of the skill artifact and extract it under the
skill name. State records installed FQNs for skip/remove.

Requested file example:
  {
    "skills": [
      {
        "type": "git",
        "name": "echo",
        "url": "https://github.com/acme/skills.git",
        "path": "echo",
        "ref": "main"
      },
      {
        "type": "registry",
        "name": "echo",
        "fqn": "agent-skill:acme/team-a/echo:3",
        "presigned_url": "https://..."
      }
    ]
  }

State file example (git `ref` is the resolved object id used for skip/reinstall, not the
requested pin like `"main"`):
  {
    "downloaded_git_skills": [
      {
        "name": "echo",
        "ref": "f1d2d2f924e986ac86fdf7b36c94bcdf32beec15",
        "path": "echo"
      }
    ],
    "downloaded_registry_skills": [
      {
        "fqn": "agent-skill:acme/team-a/echo:3",
        "name": "echo"
      }
    ]
  }

Git skill fields (requested file):
  - name: install directory name under TFY_SKILLS_DIR
  - url: https://github.com/... or https://gitlab.com/...
  - path: subdir in the repo (empty = repo root)
  - ref: branch, tag, or full object id (resolved to an oid before fetch; state stores that oid)

Registry skill fields (requested file):
  - name: install directory name under TFY_SKILLS_DIR
  - fqn: version-pinned registry FQN
  - presigned_url: temporary download URL for the skill tar

Env:
  - TFY_SKILLS_DIR: skills directory (default /opt/tfy/skills).
"""

from __future__ import annotations

import errno
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar
from abc import ABC, abstractmethod

DEFAULT_SKILLS_DIR = "/opt/tfy/skills"
STATE_FILE_NAME = ".tfy-skill-downloader-state.json"
REQUESTED_FILE_NAME = ".tfy-requested-skills.json"
# Per-git-invocation wall-clock cap so a hung/slow fetch can't stall sandbox init indefinitely.
GIT_CLONE_TIMEOUT_SECONDS = 120
# Per-registry-download wall-clock cap so a hung/slow download can't stall sandbox init indefinitely.
REGISTRY_DOWNLOAD_TIMEOUT_SECONDS = 120
# Cap registry download bytes and post-extract installed size (same bound as git installs).
REGISTRY_SKILL_MAX_BYTES = 100 * 1024 * 1024  # 100MB
# Cap the installed skill size so a huge repo-root skill can't fill the persistent skills dir. The
# sparse clone already bounds a subdir skill to its subdir; this also guards the whole-repo (root
# subdir) case where checkout hydrates every file.
GIT_SKILL_MAX_BYTES = 100 * 1024 * 1024  # 100MB installed
# Resolved object id used for fetch + skip state (sha1 / sha256).
OBJECT_ID_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
# Mount ref (branch/tag/SHA) charset — must match host AgentSpec SkillMount.ref validation.
# Validated before the value is passed to `git ls-remote` / used as a fetch arg fallback.
GIT_REF_RE = re.compile(r"^[A-Za-z0-9._\-/]+$")
SKILLS_ROOT = Path(os.environ.get("TFY_SKILLS_DIR", DEFAULT_SKILLS_DIR))
STATE_PATH = SKILLS_ROOT / STATE_FILE_NAME


class GitSkillError(Exception):
    """Recoverable per-repo/per-skill git failure. Raised (not sys.exit) so a single bad repo or
    subdirectory doesn't abort the remaining repository groups (best-effort failure isolation)."""


def skill_dir(name: str) -> Path | None:
    """Map skill name → path under SKILLS_ROOT, or None if unsafe (incl. state/requested filenames)."""
    if not name or name in (".", "..") or "/" in name or "\\" in name or name in (
        STATE_FILE_NAME,
        REQUESTED_FILE_NAME,
    ):
        return None
    return SKILLS_ROOT / name


class ValidationError(ValueError):
    """A requested or recorded entry does not have the expected shape."""


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be an object")
    return value


def _string(data: dict[str, Any], key: str, label: str, default: str | None = None) -> str:
    """Read a string field; unknown keys are ignored, a missing one takes `default` or is an error."""
    if key not in data:
        if default is None:
            raise ValidationError(f"{label}: field {key!r} is required")
        return default
    value = data[key]
    if not isinstance(value, str):
        raise ValidationError(f"{label}: field {key!r} must be a string")
    return value


def _non_empty_string(data: dict[str, Any], key: str, label: str) -> str:
    value = _string(data, key, label)
    if not value:
        raise ValidationError(f"{label}: field {key!r} must not be empty")
    return value


@dataclass
class GitSkill:
    """A git skill to materialize: `name`, `url`, `path`, and mount `ref` (branch, tag, or object id).
    This script resolves `ref` via `git ls-remote` in the sandbox, then sparse-fetches the resolved
    object id. The url and ref are format-validated here (defense in depth) so an unexpected value
    can't be interpreted as a git option or reach a non-public host."""

    name: str
    url: str
    path: str
    # Branch, tag, or full object id from the agent_spec mount (resolved in-sandbox before fetch).
    ref: str

    @classmethod
    def validated(cls, *, name: str, url: str, path: str, ref: str) -> GitSkill:
        # Only the two public hosts the gateway supports. Anchoring on the "https://<host>/" prefix
        # blocks non-https schemes (file://, ext::, ssh) and any other host, so this URL can't be
        # turned into an SSRF/local-file/command vector once it reaches `git`.
        if not (url.startswith("https://github.com/") or url.startswith("https://gitlab.com/")):
            raise ValidationError(f"git skill url must be a github.com/gitlab.com https URL: {url!r}")
        if not ref or ".." in ref.split("/") or not GIT_REF_RE.match(ref):
            raise ValidationError(f"git skill ref is invalid: {ref!r}")
        if ref.replace("/", "") == "":
            raise ValidationError(f"git skill ref must not consist only of slashes: {ref!r}")
        # Relative subpath within the repo. Reject absolute paths and ".." segments so it can't
        # escape the repo root. Leading/trailing slashes are stripped (repo root == ""). A leading
        # "-" is safe because subdirs are fed to `git sparse-checkout set` via stdin, never as args.
        if path.startswith("/"):
            raise ValidationError(f"git skill path must be relative: {path!r}")
        stripped = path.strip("/")
        if stripped and ".." in stripped.split("/"):
            raise ValidationError(f"git skill path must not contain '..': {path!r}")
        return cls(name=name, url=url, path=stripped, ref=ref)


@dataclass
class DownloadedGitSkill:
    """A git skill recorded on disk: its dir name, the object id it was installed at, and the repo
    path it was installed from. The ref lets a later run skip re-downloading when the requested
    pin is unchanged; the path is part of the identity so that changing the path at the same
    pin still triggers a re-download instead of serving the previously-installed layout."""

    name: str
    # Installed object id; empty = unknown → reinstall. Name still tracked for cleanup.
    ref: str = ""
    # Installed repo path ("" = root); mismatch vs requested forces reinstall.
    path: str = ""

    @classmethod
    def parse(cls, value: Any) -> DownloadedGitSkill:
        data = _object(value, "downloaded git skill")
        label = "downloaded git skill"
        return cls(
            name=_string(data, "name", label),
            ref=_string(data, "ref", label, default=""),
            path=_string(data, "path", label, default=""),
        )


@dataclass
class DownloadedRegistrySkill:
    """A registry skill recorded on disk: its FQN and name."""

    fqn: str
    name: str

    @classmethod
    def parse(cls, value: Any) -> DownloadedRegistrySkill:
        data = _object(value, "downloaded registry skill")
        label = "downloaded registry skill"
        return cls(fqn=_string(data, "fqn", label), name=_string(data, "name", label))


def _list(data: dict[str, Any], key: str, label: str) -> list[Any]:
    value = data.get(key, [])
    if not isinstance(value, list):
        raise ValidationError(f"{label}: field {key!r} must be a list")
    return value


@dataclass
class SkillDownloaderState:
    # Keep git and registry installs in separate lists (do not merge into one discriminated
    # array). Each SkillSource already reads/writes only its own rows, and the persisted
    # identities differ: git skip/reinstall keys on name + resolved object id + path;
    # registry keys on fqn + name. A shared list would add type filters with no load-path win.
    downloaded_git_skills: list[DownloadedGitSkill] = field(default_factory=list)
    downloaded_registry_skills: list[DownloadedRegistrySkill] = field(default_factory=list)

    @classmethod
    def parse_json(cls, text: str) -> SkillDownloaderState:
        data = _object(json.loads(text), "state")
        return cls(
            downloaded_git_skills=[
                DownloadedGitSkill.parse(entry) for entry in _list(data, "downloaded_git_skills", "state")
            ],
            downloaded_registry_skills=[
                DownloadedRegistrySkill.parse(entry)
                for entry in _list(data, "downloaded_registry_skills", "state")
            ],
        )


@dataclass
class RequestedGitSkill:
    type: ClassVar[str] = "git"

    name: str
    url: str
    path: str
    ref: str

    @classmethod
    def parse(cls, data: dict[str, Any]) -> RequestedGitSkill:
        label = "git skill"
        return cls(
            name=_string(data, "name", label),
            url=_string(data, "url", label),
            path=_string(data, "path", label, default=""),
            ref=_string(data, "ref", label),
        )

    def resolve(self) -> GitSkill:
        try:
            return GitSkill.validated(name=self.name, url=self.url, path=self.path, ref=self.ref)
        except ValidationError as e:
            sys.exit(f"Invalid git entry in {REQUESTED_FILE_NAME}: {e}")


@dataclass
class RequestedRegistrySkill:
    type: ClassVar[str] = "registry"

    name: str
    fqn: str
    presigned_url: str

    @classmethod
    def parse(cls, data: dict[str, Any]) -> RequestedRegistrySkill:
        label = "registry skill"
        return cls(
            name=_string(data, "name", label),
            fqn=_non_empty_string(data, "fqn", label),
            presigned_url=_non_empty_string(data, "presigned_url", label),
        )

    def resolve(self) -> RequestedRegistrySkill:
        if skill_dir(self.name) is None:
            sys.exit(f"Invalid registry skill name: {self.name!r}")
        return self


RequestedSkill = RequestedGitSkill | RequestedRegistrySkill
REQUESTED_SKILL_TYPES: dict[str, type[RequestedGitSkill] | type[RequestedRegistrySkill]] = {
    RequestedGitSkill.type: RequestedGitSkill,
    RequestedRegistrySkill.type: RequestedRegistrySkill,
}


def parse_requested_skills(text: str) -> list[RequestedSkill]:
    """Each entry is chosen by its `type`; unknown keys are ignored and a missing list means none."""
    data = _object(json.loads(text), "requested skills")
    skills: list[RequestedSkill] = []
    for index, value in enumerate(_list(data, "skills", "requested skills")):
        entry = _object(value, f"skills[{index}]")
        skill_type = entry.get("type")
        parser = REQUESTED_SKILL_TYPES.get(skill_type) if isinstance(skill_type, str) else None
        if parser is None:
            raise ValidationError(f"skills[{index}]: unknown skill type {skill_type!r}")
        skills.append(parser.parse(entry))
    return skills


def load_state() -> SkillDownloaderState:
    if not STATE_PATH.is_file():
        return SkillDownloaderState()
    try:
        return SkillDownloaderState.parse_json(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # ValueError covers bad JSON, a bad shape and UnicodeDecodeError from corrupt state in the
        # agent-writable skills dir.
        return SkillDownloaderState()


def save_state(state: SkillDownloaderState) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    tmp.write_text(json.dumps(asdict(state), indent=2), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def _rmtree(path: Path, ignore_errors: bool = True) -> None:
    try:
        shutil.rmtree(path, ignore_errors=ignore_errors)
    except OSError:
        pass


def _format_os_error(e: BaseException) -> str:
    """Prefer a clear sandbox-disk-full message when errno is ENOSPC."""
    if isinstance(e, OSError) and e.errno == errno.ENOSPC:
        return f"sandbox disk full: {e}"
    return str(e)


def _delete_skill_dir_by_name(name: str, label: str) -> None:
    """Remove a no-longer-requested skill directory; abort the whole run if removal
    fails so we never silently leave a stale skill on disk. skill_dir() returns None for a
    corrupt/tampered name, so rmtree never runs on an out-of-tree path."""
    dir_ = skill_dir(name)
    if dir_ is None or not dir_.is_dir():
        return
    try:
        shutil.rmtree(dir_)
    except OSError as e:
        sys.exit(f"Could not remove skill directory {dir_} ({label}): {e}")



def _installed_size_bytes(path: Path) -> int:
    """Total size of regular files under `path`, excluding `.git`, without following symlinks."""
    total = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        if ".git" in dirs:
            dirs.remove(".git")
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                continue
    return total


def _delete_requested_file() -> None:
    path = SKILLS_ROOT / REQUESTED_FILE_NAME
    try:
        if path.is_file():
            path.unlink()
    except OSError as e:
        print(f"WARNING: could not delete {REQUESTED_FILE_NAME}: {e}", file=sys.stderr)



class SkillSource(ABC):
    """One install source (git clone, registry tar, …). Helpers live on subclasses."""

    type: ClassVar[str]

    @abstractmethod
    def reconcile(self, skills: list[Any], state: SkillDownloaderState) -> list[str]:
        """Remove installs no longer requested. Returns removed ids/names."""

    @abstractmethod
    def download(self, skills: list[Any], state: SkillDownloaderState) -> tuple[int, int]:
        """Install/skip requested skills. If already present, skip. Returns (installed, skipped)."""


class RegistrySkillSource(SkillSource):
    type = "registry"

    def reconcile(self, skills: list[Any], state: SkillDownloaderState) -> list[str]:
        requested_fqns = {s.fqn for s in skills}
        removed: list[str] = []
        for entry in list(state.downloaded_registry_skills):
            if entry.fqn in requested_fqns:
                continue
            _delete_skill_dir_by_name(entry.name, label=f"stale registry fqn {entry.fqn}")
            removed.append(entry.fqn)
        state.downloaded_registry_skills = [e for e in state.downloaded_registry_skills if e.fqn in requested_fqns]
        return removed

    def download(self, skills: list[Any], state: SkillDownloaderState) -> tuple[int, int]:
        installed = 0
        skipped = 0
        for skill in skills:
            if self._already_installed(state, skill):
                skipped += 1
                continue
            try:
                self._install_tar(skill)
                self._mark_downloaded(state, skill)
                installed += 1
            except RuntimeError as e:
                print(f"WARNING: {e}", file=sys.stderr)
        return installed, skipped

    def _already_installed(self, state: SkillDownloaderState, skill: RequestedRegistrySkill) -> bool:
        dir_ = skill_dir(skill.name)
        if dir_ is None or not dir_.is_dir():
            return False
        return any(e.fqn == skill.fqn and e.name == skill.name for e in state.downloaded_registry_skills)

    def _mark_downloaded(self, state: SkillDownloaderState, skill: RequestedRegistrySkill) -> None:
        for entry in state.downloaded_registry_skills:
            if entry.fqn == skill.fqn:
                if entry.name != skill.name:
                    _delete_skill_dir_by_name(
                        entry.name, label=f"renamed registry fqn {entry.fqn}"
                    )
                    entry.name = skill.name
                return
        state.downloaded_registry_skills.append(DownloadedRegistrySkill(fqn=skill.fqn, name=skill.name))

    def _install_tar(self, skill: RequestedRegistrySkill) -> None:
        """Stage extract under SKILLS_ROOT, then swap over the prior dir."""
        dir_ = skill_dir(skill.name)
        if dir_ is None:
            raise RuntimeError(f"invalid skill name {skill.name!r}")
        try:
            with urllib.request.urlopen(
                skill.presigned_url, timeout=REGISTRY_DOWNLOAD_TIMEOUT_SECONDS
            ) as resp:
                data = resp.read(REGISTRY_SKILL_MAX_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(f"download failed for {skill.fqn}: {_format_os_error(e)}") from e
        if len(data) > REGISTRY_SKILL_MAX_BYTES:
            raise RuntimeError(f"tar for {skill.fqn} exceeds {REGISTRY_SKILL_MAX_BYTES} bytes")

        staging = dir_.with_name(f".{dir_.name}.new-{os.getpid()}")
        _rmtree(staging)
        try:
            staging.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".registry-skill-tar-",
                dir=os.fspath(SKILLS_ROOT),
                ignore_cleanup_errors=True,
            ) as tmp:
                tar_path = Path(tmp) / "skill.tar"
                tar_path.write_bytes(data)
                with tarfile.open(tar_path, mode="r:*") as tar:
                    # The download cap only limits compressed bytes. Member `.size` is the
                    # uncompressed file length from the tar headers — sum it and refuse before
                    # extractall so a small archive cannot expand past REGISTRY_SKILL_MAX_BYTES on disk.
                    claimed = sum(m.size for m in tar.getmembers() if m.isreg())
                    if claimed > REGISTRY_SKILL_MAX_BYTES:
                        raise RuntimeError(
                            f"extracted skill {skill.fqn} exceeds {REGISTRY_SKILL_MAX_BYTES} bytes"
                        )
                    # Registry skill tars are system-generated (not user-uploaded), so extractall is fine.
                    # filter= is 3.12+; local TFY provider often runs host 3.10/3.11.
                    if sys.version_info >= (3, 12):
                        tar.extractall(path=staging, filter="data")
                    else:
                        tar.extractall(path=staging)
            if dir_.exists():
                shutil.rmtree(dir_)
            os.replace(staging, dir_)
        except RuntimeError:
            _rmtree(staging)
            raise
        except (tarfile.TarError, OSError) as e:
            _rmtree(staging)
            raise RuntimeError(f"extract failed for {skill.fqn}: {_format_os_error(e)}") from e


class GitSkillSource(SkillSource):
    type = "git"

    def reconcile(self, skills: list[Any], state: SkillDownloaderState) -> list[str]:
        requested_names = {g.name for g in skills}
        removed: list[str] = []
        for entry in state.downloaded_git_skills:
            if entry.name in requested_names:
                continue
            # Fail closed: a failed delete aborts the run rather than leaving a stale skill on disk.
            _delete_skill_dir_by_name(entry.name, entry.name)
            removed.append(entry.name)
        state.downloaded_git_skills = [
            e for e in state.downloaded_git_skills if e.name in requested_names
        ]
        return removed

    def download(self, skills: list[Any], state: SkillDownloaderState) -> tuple[int, int]:
        """Install requested git skills at resolved object ids; skip unchanged pins.

        Failures are isolated per repo/skill (stderr warnings). Returns (installed, skipped);
        caller exits non-zero if any requested skill is missing.
        """
        SKILLS_ROOT.mkdir(parents=True, exist_ok=True)

        pending: list[tuple[GitSkill, str]] = []
        installed = 0
        skipped = 0
        for skill in skills:
            try:
                object_id = self._resolve_object_id(skill.url, skill.ref, SKILLS_ROOT)
            except GitSkillError as e:
                print(f"WARNING: {e} (skill: {skill.name})", file=sys.stderr)
                continue
            if self._already_installed(state, skill, object_id):
                skipped += 1
            else:
                pending.append((skill, object_id))

        skills_by_repo: dict[tuple[str, str], list[tuple[GitSkill, str]]] = {}
        for skill, object_id in pending:
            skills_by_repo.setdefault((skill.url, object_id), []).append((skill, object_id))

        for (url, object_id), group in skills_by_repo.items():
            try:
                with tempfile.TemporaryDirectory(
                    prefix=".git-skill-dl-",
                    dir=os.fspath(SKILLS_ROOT),
                    ignore_cleanup_errors=True,
                ) as tmp_str:
                    repo_root = self._fetch_repo(
                        url,
                        object_id,
                        [s.path for s, _ in group],
                        Path(tmp_str),
                    )
                    for skill, oid in group:
                        try:
                            self._install_skill(repo_root, skill)
                            self._mark_downloaded(state, skill, oid)
                            installed += 1
                        except GitSkillError as e:
                            print(f"WARNING: {e}", file=sys.stderr)
            except GitSkillError as e:
                # Don't abort-on-first: report every failing group; keep prior installs on disk.
                names = ", ".join(s.name for s, _ in group)
                print(f"WARNING: {e} (skills: {names})", file=sys.stderr)
        return installed, skipped

    def _run_git(
        self, args: list[str], cwd: Path, input_text: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        """Run a git subcommand non-interactively and fail-closed on error."""
        env = {
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GCM_INTERACTIVE": "never",
        }
        try:
            proc = subprocess.run(
                ["git", *args],
                cwd=os.fspath(cwd),
                env=env,
                input=input_text,
                capture_output=True,
                text=True,
                timeout=GIT_CLONE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise GitSkillError(f"git {args[0]} timed out after {GIT_CLONE_TIMEOUT_SECONDS}s")
        except OSError as e:
            raise GitSkillError(f"could not run git (is it installed in the sandbox?): {e}")
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()[-500:]
            raise GitSkillError(f"git {args[0]} failed (exit {proc.returncode}): {detail}")
        return proc

    def _parse_ls_remote_object_id(self, stdout: str) -> str | None:
        """Prefer a peeled `ref^{}` line (annotated tags), else the first object id."""
        first: str | None = None
        for line in stdout.splitlines():
            trimmed = line.strip()
            if not trimmed:
                continue
            parts = trimmed.split(None, 1)
            sha = parts[0]
            name = parts[1] if len(parts) > 1 else ""
            if name.endswith("^{}"):
                return sha
            if first is None:
                first = sha
        return first

    def _resolve_object_id(self, url: str, ref: str, cwd: Path) -> str:
        """Resolve a mount ref (branch/tag/SHA) to an object id inside the sandbox."""
        if OBJECT_ID_RE.match(ref):
            return ref
        proc = self._run_git(["ls-remote", url, ref], cwd=cwd)
        oid = self._parse_ls_remote_object_id(proc.stdout or "")
        if oid is None:
            raise GitSkillError(f"git ls-remote returned no commit for {url} ref {ref}")
        return oid

    def _fetch_repo(
        self, url: str, object_id: str, paths: list[str], parent_dir: Path
    ) -> Path:
        """Object-id-pinned, shallow, blob-filtered sparse checkout of `paths`."""
        repo = parent_dir / "repo"
        self._run_git(["init", "-q", os.fspath(repo)], cwd=parent_dir)
        self._run_git(["remote", "add", "origin", url], cwd=repo)

        cone_dirs = [s for s in dict.fromkeys(paths) if s]
        want_full_tree = any(s == "" for s in paths)
        if not want_full_tree and cone_dirs:
            self._run_git(["sparse-checkout", "init", "--cone"], cwd=repo)
            self._run_git(
                ["sparse-checkout", "set", "--stdin"],
                cwd=repo,
                input_text="".join(f"{d}\n" for d in cone_dirs),
            )

        fetch_args = ["-c", "protocol.file.allow=never", "fetch", "-q", "--depth", "1"]
        if not want_full_tree:
            fetch_args.append("--filter=blob:none")
        fetch_args += ["origin", object_id]
        self._run_git(fetch_args, cwd=repo)

        self._run_git(
            ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"],
            cwd=repo,
        )
        return repo

    def _install_skill(self, repo_root: Path, skill: GitSkill) -> None:
        dest = skill_dir(skill.name)
        if dest is None:
            raise GitSkillError(f"Git skill: unsafe directory name {skill.name!r}")
        repo_root_resolved = repo_root.resolve()
        src = (repo_root / skill.path).resolve() if skill.path else repo_root_resolved
        if src != repo_root_resolved and not src.is_relative_to(repo_root_resolved):
            raise GitSkillError(
                f"Git skill {skill.name}: path '{skill.path}' escapes the repository"
            )
        if not src.is_dir():
            raise GitSkillError(
                f"Git skill {skill.name}: path '{skill.path}' not found in repository"
            )
        if _installed_size_bytes(src) > GIT_SKILL_MAX_BYTES:
            raise GitSkillError(
                f"Git skill {skill.name}: content exceeds {GIT_SKILL_MAX_BYTES} bytes"
            )
        staging = dest.with_name(f".{dest.name}.new-{os.getpid()}")
        _rmtree(staging)
        try:
            shutil.copytree(src, staging, symlinks=True, ignore=shutil.ignore_patterns(".git"))
        except (OSError, shutil.Error) as e:
            _rmtree(staging)
            raise GitSkillError(f"Failed to stage git skill {skill.name}: {_format_os_error(e)}")
        try:
            if dest.exists():
                shutil.rmtree(dest)
            os.replace(staging, dest)
        except OSError as e:
            _rmtree(staging)
            raise GitSkillError(f"Failed to install git skill {skill.name}: {_format_os_error(e)}")

    def _mark_downloaded(
        self, state: SkillDownloaderState, skill: GitSkill, object_id: str
    ) -> None:
        for entry in state.downloaded_git_skills:
            if entry.name == skill.name:
                entry.ref = object_id
                entry.path = skill.path
                return
        state.downloaded_git_skills.append(
            DownloadedGitSkill(name=skill.name, ref=object_id, path=skill.path)
        )

    def _already_installed(
        self, state: SkillDownloaderState, skill: GitSkill, object_id: str
    ) -> bool:
        dir_ = skill_dir(skill.name)
        if dir_ is None or not dir_.is_dir():
            return False
        return any(
            e.name == skill.name and e.ref == object_id and e.path == skill.path
            for e in state.downloaded_git_skills
        )



# Add a third skill type:
# 1. RequestedFooSkill + parse() + resolve(), union member (RequestedSkill) and REQUESTED_SKILL_TYPES entry
# 2. FooSkillSource with reconcile / download
# 3. Append FooSkillSource() to SKILL_SOURCES (order = install order)
# 4. Wire type: 'foo' on the host (SkillMounter)
# Registry first: presigned URLs expire; git sparse clones can take much longer.
SKILL_SOURCES: tuple[SkillSource, ...] = (RegistrySkillSource(), GitSkillSource())
SKILL_SOURCE_ORDER: tuple[str, ...] = tuple(source.type for source in SKILL_SOURCES)


def load_requested_skills() -> dict[str, list[Any]]:
    """Read requested file into per-source buckets. Missing → empty (clean up all sources)."""
    buckets: dict[str, list[Any]] = {skill_type: [] for skill_type in SKILL_SOURCE_ORDER}
    path = SKILLS_ROOT / REQUESTED_FILE_NAME
    if not path.is_file():
        return buckets
    try:
        requested = parse_requested_skills(path.read_text(encoding="utf-8"))
    except OSError as e:
        sys.exit(f"Could not read {REQUESTED_FILE_NAME}: {e}")
    except ValueError as e:
        sys.exit(f"Invalid {REQUESTED_FILE_NAME}: {e}")

    for item in requested:
        buckets[item.type].append(item.resolve())
    return buckets


def run_skill_download() -> None:
    loaded = load_requested_skills()
    state = load_state()
    removed_by_source = {source.type: source.reconcile(loaded[source.type], state) for source in SKILL_SOURCES}

    if not any(loaded.values()):
        bits = [
            f"Removed {len(removed_by_source[skill_type])} {skill_type} skill(s)"
            for skill_type in SKILL_SOURCE_ORDER
            if removed_by_source[skill_type]
        ]
        if bits:
            print(f"{'; '.join(bits)}. (requested empty.)")
        save_state(state)
        _delete_requested_file()
        return

    counts_by_source = {
        source.type: (
            source.download(loaded[source.type], state) if loaded[source.type] else (0, 0)
        )
        for source in SKILL_SOURCES
    }
    save_state(state)
    _delete_requested_file()

    suffix_parts = [
        f"Removed {len(removed_by_source[skill_type])} stale {skill_type} skill(s)"
        for skill_type in SKILL_SOURCE_ORDER
        if removed_by_source[skill_type]
    ]
    suffix = f" {' '.join(suffix_parts)}." if suffix_parts else ""

    failed_parts = [
        f"{len(loaded[skill_type]) - sum(counts_by_source[skill_type])}/{len(loaded[skill_type])} {skill_type}"
        for skill_type in SKILL_SOURCE_ORDER
        if loaded[skill_type] and sum(counts_by_source[skill_type]) < len(loaded[skill_type])
    ]
    if failed_parts:
        sys.exit(
            f"Failed to install {' and '.join(failed_parts)} skill(s); see warnings above.{suffix}"
        )

    ensured = []
    for skill_type in SKILL_SOURCE_ORDER:
        if not loaded[skill_type]:
            continue
        installed, skipped = counts_by_source[skill_type]
        ensured.append(f"{installed} installed/{skipped} skipped {skill_type}")
    print(f"Ensured {' and '.join(ensured)} skill(s).{suffix}")


def main() -> None:
    run_skill_download()


if __name__ == "__main__":
    main()
