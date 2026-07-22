#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

RELEASE_BOT_AGENT_ID = "cf440f88-ba64-4173-80c3-371b44916c04"
LOCK_PREFIX = "[MAIN_LOCKED]:"
UNLOCK_PREFIX = "[MAIN_UNLOCKED]:"
HTTP_TIMEOUT_SECONDS = 15
LOCK_KEY_PATTERN = re.compile(r"(?:[A-Z][A-Z0-9]+-[0-9]+|NO-JIRA)", re.ASCII)
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*", re.ASCII)
TIMESTAMP_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z",
    re.ASCII,
)


class ResolverError(Exception):
    pass


@dataclass(frozen=True)
class MarkerEvent:
    kind: str
    created_at: datetime
    created_at_raw: str
    comment_id: str
    line_index: int
    key: str | None = None
    author_type: Any = None
    author_agent_id: Any = None
    author_user_id: Any = None


class RejectRedirectHandler(urlrequest.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urlrequest.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        return None


class PaperclipClient:
    def __init__(self, api_url: str, api_key: str) -> None:
        self.api_url = validate_api_url(api_url)
        self.api_key = api_key
        self.agent_roles: dict[str, str] = {}
        self.opener = urlrequest.build_opener(RejectRedirectHandler())

    def get_comments(self, issue_identifier: str) -> list[Any]:
        issue = urlparse.quote(issue_identifier, safe="")
        payload = self._get_json(f"/api/issues/{issue}/comments", required=True)
        if not isinstance(payload, list):
            raise ResolverError("malformed_comments")
        return payload

    def get_agent_role(self, agent_id: str) -> str:
        if agent_id in self.agent_roles:
            return self.agent_roles[agent_id]

        agent = urlparse.quote(agent_id, safe="")
        payload = self._get_json(f"/api/agents/{agent}", required=True)
        role = payload.get("role") if isinstance(payload, dict) else None
        if not isinstance(role, str) or not role or role != role.strip():
            raise ResolverError("malformed_agent")

        self.agent_roles[agent_id] = role
        return role

    def _get_json(self, path: str, *, required: bool) -> Any:
        request = urlrequest.Request(
            f"{self.api_url}{path}",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        try:
            with self.opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read()
        except (urlerror.URLError, TimeoutError, OSError):
            raise ResolverError("fetch_failed") from None

        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            if required:
                raise ResolverError("malformed_json") from None
            return None


def validate_api_url(value: str) -> str:
    try:
        parsed = urlparse.urlsplit(value)
        _ = parsed.port
    except ValueError:
        raise ResolverError("invalid_api_url") from None
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or any(ord(character) < 33 or ord(character) == 127 for character in value)
    ):
        raise ResolverError("invalid_api_url")
    return value.rstrip("/")


def parse_timestamp(value: Any) -> tuple[datetime, str]:
    if not isinstance(value, str) or TIMESTAMP_PATTERN.fullmatch(value) is None:
        raise ResolverError("malformed_comment")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ResolverError("malformed_comment") from None
    if parsed.tzinfo is None:
        raise ResolverError("malformed_comment")
    return parsed, value


def is_valid_identifier(value: Any) -> bool:
    return isinstance(value, str) and IDENTIFIER_PATTERN.fullmatch(value) is not None


def is_non_empty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def collect_events(comments: list[Any]) -> list[MarkerEvent]:
    events: list[MarkerEvent] = []

    for comment in comments:
        if not isinstance(comment, dict) or "deletedAt" not in comment:
            raise ResolverError("malformed_comment")
        deleted_at = comment["deletedAt"]
        if deleted_at is not None:
            parse_timestamp(deleted_at)
            continue

        comment_id = comment.get("id")
        body = comment.get("body")
        if (
            not is_valid_identifier(comment_id)
            or not isinstance(body, str)
        ):
            raise ResolverError("malformed_comment")
        created_at, created_at_raw = parse_timestamp(comment.get("createdAt"))

        for line_index, line in enumerate(body.splitlines()):
            if line.startswith(LOCK_PREFIX):
                if comment.get("authorType") == "system":
                    continue
                payload = line.removeprefix(LOCK_PREFIX).strip()
                key_match = re.match(
                    rf"^({LOCK_KEY_PATTERN.pattern})(?:\s|$)", payload, flags=re.ASCII
                )
                if key_match is None:
                    raise ResolverError("malformed_lock_marker")
                events.append(
                    MarkerEvent(
                        kind="lock",
                        created_at=created_at,
                        created_at_raw=created_at_raw,
                        comment_id=comment_id,
                        line_index=line_index,
                        key=key_match.group(1),
                    )
                )
            elif line.startswith(UNLOCK_PREFIX):
                events.append(
                    MarkerEvent(
                        kind="unlock",
                        created_at=created_at,
                        created_at_raw=created_at_raw,
                        comment_id=comment_id,
                        line_index=line_index,
                        author_type=comment.get("authorType"),
                        author_agent_id=comment.get("authorAgentId"),
                        author_user_id=comment.get("authorUserId"),
                    )
                )

    return events


def resolve_active_lock(
    events: list[MarkerEvent], client: PaperclipClient
) -> MarkerEvent | None:
    if not events:
        return None

    for timestamp in sorted({event.created_at for event in events}, reverse=True):
        timestamp_events = [event for event in events if event.created_at == timestamp]
        tied_locks = [event for event in timestamp_events if event.kind == "lock"]
        if tied_locks:
            return min(
                tied_locks,
                key=lambda event: (event.comment_id, event.key or "", event.line_index),
            )

        unlocks = [event for event in timestamp_events if event.kind == "unlock"]
        if any(
            event.author_type == "agent"
            and event.author_user_id is None
            and event.author_agent_id == RELEASE_BOT_AGENT_ID
            for event in unlocks
        ):
            return None
        if any(
            event.author_type == "user"
            and event.author_agent_id is None
            and is_non_empty_text(event.author_user_id)
            for event in unlocks
        ):
            return None

        lookup_error: ResolverError | None = None
        for event in unlocks:
            if (
                event.author_type != "agent"
                or event.author_user_id is not None
                or not is_valid_identifier(event.author_agent_id)
            ):
                continue
            try:
                if client.get_agent_role(event.author_agent_id) == "cto":
                    return None
            except ResolverError as exc:
                lookup_error = exc
        if lookup_error is not None:
            raise lookup_error

    return None


def emit_error(reason: str) -> int:
    safe_reason = re.sub(r"[^a-z0-9_]+", "_", reason.lower()).strip("_") or "internal_error"
    print(f"MAIN_LOCK_ERROR reason={safe_reason}")
    return 21


def main() -> int:
    api_url = os.environ.get("PAPERCLIP_API_URL")
    api_key_file = os.environ.get("PAPERCLIP_API_KEY_FILE")
    issue_identifier = os.environ.get("PAPERCLIP_MAIN_LOCK_ISSUE", "GOT-66")
    if not api_url or not api_key_file or not issue_identifier:
        return emit_error("missing_configuration")

    try:
        if os.path.islink(api_key_file) or not os.path.isfile(api_key_file):
            raise ResolverError("credential_file")
        with open(api_key_file, "r", encoding="utf-8") as credential:
            api_key = credential.readline().strip()
        if not api_key:
            raise ResolverError("credential_file")
        client = PaperclipClient(api_url, api_key)
        comments = client.get_comments(issue_identifier)
        active_lock = resolve_active_lock(collect_events(comments), client)
    except ResolverError as exc:
        return emit_error(str(exc))
    except Exception:
        return emit_error("internal_error")

    if active_lock is None:
        print("MAIN_LOCK_CLEAR")
        return 0

    print(
        "MAIN_LOCK_ACTIVE"
        f" comment={active_lock.comment_id}"
        f" createdAt={active_lock.created_at_raw}"
        f" key={active_lock.key}"
    )
    return 20


if __name__ == "__main__":
    sys.exit(main())
