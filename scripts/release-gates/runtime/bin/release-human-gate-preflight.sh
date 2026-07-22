#!/usr/bin/env bash

set -euo pipefail

candidate_id="${1:?usage: release-human-gate-preflight.sh <candidate-issue-id>}"
api_url="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
api_key_file="${PAPERCLIP_API_KEY_FILE:?PAPERCLIP_API_KEY_FILE is required}"
curl_bin="${CURL_BIN:-curl}"
comment_page_limit=100
comment_page_max=1000

[[ -f "$api_key_file" && ! -L "$api_key_file" ]] || {
  printf 'HUMAN_GATE_ERROR candidate=%s reason=credential_file\n' "$candidate_id" >&2
  exit 21
}
IFS= read -r api_key < "$api_key_file"
[[ -n "$api_key" ]] || {
  printf 'HUMAN_GATE_ERROR candidate=%s reason=credential_file\n' "$candidate_id" >&2
  exit 21
}

fail_closed() {
  printf 'HUMAN_GATE_ERROR candidate=%s reason=%s\n' "$candidate_id" "$1" >&2
  exit 21
}

api_get() {
  "$curl_bin" -fsS \
    -H "Authorization: Bearer $api_key" \
    "$api_url$1"
}

fetch_comment_markers() {
  local issue_id="$1"
  local cursor=""
  local cursor_created_at=""
  local markers='[]'
  local page raw_count page_count first_id first_created_at
  local page_markers next_cursor next_created_at encoded_cursor
  local comments_path
  local page_number=0

  while :; do
    (( page_number += 1 ))
    (( page_number <= comment_page_max )) \
      || fail_closed "comments_page_limit:$issue_id"

    comments_path="/api/issues/$issue_id/comments?order=asc&limit=$comment_page_limit"
    if [[ -n "$cursor" ]]; then
      encoded_cursor=$(jq -nr --arg cursor "$cursor" '$cursor | @uri') \
        || fail_closed "comments_cursor:$issue_id"
      [[ -n "$encoded_cursor" ]] || fail_closed "comments_cursor:$issue_id"
      comments_path+="&after=$encoded_cursor"
    fi

    page=$(api_get "$comments_path") \
      || fail_closed "comments_fetch:$issue_id"
    jq -e --arg issue_id "$issue_id" --argjson limit "$comment_page_limit" '
      type == "array"
      and length <= $limit
      and all(.[];
        type == "object"
        and .issueId == $issue_id
        and (.id | type == "string" and length > 0)
        and (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
        and (.body | type == "string")
      )
      and (
        ([.[] | [.createdAt, .id]]) as $keys
        | ($keys == ($keys | sort))
          and (($keys | unique | length) == ($keys | length))
      )
    ' <<<"$page" >/dev/null 2>&1 \
      || fail_closed "comments_payload:$issue_id"

    raw_count=$(jq -r 'length' <<<"$page")
    (( raw_count > 0 )) || break

    if [[ -n "$cursor" ]]; then
      first_id=$(jq -r '.[0].id' <<<"$page")
      first_created_at=$(jq -r '.[0].createdAt' <<<"$page")

      # Some deployed Paperclip versions echo the anchor as the first row,
      # while newer versions return only rows strictly after it.
      if [[ "$first_id" == "$cursor" ]]; then
        [[ "$first_created_at" == "$cursor_created_at" ]] \
          || fail_closed "comments_cursor:$issue_id"
        page=$(jq -c '.[1:]' <<<"$page")
      fi

      jq -e \
        --arg cursor "$cursor" \
        --arg cursor_created_at "$cursor_created_at" '
        all(.[];
          .createdAt > $cursor_created_at
          or (.createdAt == $cursor_created_at and .id > $cursor)
        )
      ' <<<"$page" >/dev/null 2>&1 \
        || fail_closed "comments_cursor:$issue_id"
    fi

    page_count=$(jq -r 'length' <<<"$page")
    (( page_count > 0 )) || break

    page_markers=$(jq -c '
      [ .[]
        | select(
            .body
            | test("(?m)^\\[HUMAN_DECISION_(REQUIRED|UNBLOCKED)\\]:")
          )
      ]
    ' <<<"$page") || fail_closed "comments_payload:$issue_id"
    markers=$(jq -cn \
      --argjson accumulated "$markers" \
      --argjson current "$page_markers" \
      '$accumulated + $current') \
      || fail_closed "comments_payload:$issue_id"

    next_cursor=$(jq -r '.[-1].id' <<<"$page")
    next_created_at=$(jq -r '.[-1].createdAt' <<<"$page")
    [[ -n "$next_cursor" && "$next_cursor" != "$cursor" ]] \
      || fail_closed "comments_cursor:$issue_id"
    cursor="$next_cursor"
    cursor_created_at="$next_created_at"
  done

  printf '%s\n' "$markers"
}

is_engine_released() {
  local issue_id="$1"
  local required_at="$2"
  local issue="$3"
  local stage_id user_id decision_id activity

  stage_id=$(jq -r '
    (.executionPolicy.stages // []) as $stages
    | (.executionState.completedStageIds // []) as $completed
    | if (($stages | length) == 1
        and $stages[0].type == "approval"
        and ($stages[0].participants | length) == 1
        and $stages[0].participants[0].type == "user"
        and ($stages[0].participants[0].userId != null)
        and (.executionState.lastDecisionOutcome == "approved")
        and (.executionState.lastDecisionId != null)
        and ($completed | index($stages[0].id) != null))
      then $stages[0].id
      else empty
      end
  ' <<<"$issue")
  [[ -n "$stage_id" ]] || return 1

  user_id=$(jq -r '.executionPolicy.stages[0].participants[0].userId' <<<"$issue")
  decision_id=$(jq -r '.executionState.lastDecisionId' <<<"$issue")
  activity=$(api_get "/api/issues/$issue_id/activity" 2>/dev/null) \
    || fail_closed "activity_fetch:$issue_id"
  jq -e --arg issue_id "$issue_id" '
    type == "array"
    and all(.[]; .entityType == "issue" and .entityId == $issue_id)
  ' <<<"$activity" >/dev/null 2>&1 \
    || fail_closed "activity_payload:$issue_id"

  # Comment auto-approval emits its issue.updated audit only after the atomic
  # comment + stage decision, but omits executionState from the activity payload.
  jq -e \
    --arg required_at "$required_at" \
    --arg stage_id "$stage_id" \
    --arg user_id "$user_id" \
    --arg decision_id "$decision_id" '
    any(.[];
      .action == "issue.updated"
      and .actorType == "user"
      and .actorId == $user_id
      and .createdAt > $required_at
      and (
        (
          .details.executionState.lastDecisionId == $decision_id
          and .details.executionState.lastDecisionOutcome == "approved"
          and ((.details.executionState.completedStageIds // []) | index($stage_id) != null)
        )
        or (
          .details.source == "auto_approval_comment"
          and .details.status == "done"
          and .details._previous.status == "in_review"
        )
      )
    )
  ' <<<"$activity" >/dev/null 2>&1
}

verified_release_via() {
  local issue_id="$1"
  local via="$2"
  local required_at="$3"
  local interactions comment

  if interactions=$(api_get "/api/issues/$issue_id/interactions" 2>/dev/null); then
    jq -e --arg issue_id "$issue_id" '
      type == "array"
      and all(.[]; .issueId == $issue_id)
    ' <<<"$interactions" >/dev/null 2>&1 \
      || fail_closed "interactions_payload:$issue_id"

    if jq -e --arg via "$via" --arg required_at "$required_at" '
      any(.[];
        .id == $via
        and .kind == "request_confirmation"
        and .status == "accepted"
        and .resolvedByUserId != null
        and .resolvedAt != null
        and .resolvedAt > $required_at
      )
    ' <<<"$interactions" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if comment=$(api_get "/api/issues/$issue_id/comments/$via" 2>/dev/null); then
    jq -e --arg via "$via" --arg issue_id "$issue_id" '
      type == "object"
      and .id == $via
      and .issueId == $issue_id
    ' <<<"$comment" >/dev/null 2>&1 \
      || fail_closed "comment_payload:$issue_id:$via"

    if jq -e --arg required_at "$required_at" '
      .deletedAt == null
      and .authorType == "user"
      and .authorUserId != null
      and .createdAt > $required_at
    ' <<<"$comment" >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

declare -A seen=()
current_id="$candidate_id"
depth=0

while [[ -n "$current_id" ]]; do
  (( depth += 1 ))
  (( depth <= 100 )) || fail_closed "ancestor_depth_exceeded"
  [[ -z "${seen[$current_id]:-}" ]] || fail_closed "parent_cycle:$current_id"
  seen[$current_id]=1

  issue=$(api_get "/api/issues/$current_id") || fail_closed "issue_fetch:$current_id"
  jq -e --arg current_id "$current_id" \
    '.id == $current_id and .identifier and has("parentId")' \
    <<<"$issue" >/dev/null 2>&1 \
    || fail_closed "issue_payload:$current_id"

  comments=$(fetch_comment_markers "$current_id")

  required=$(jq -c '
    [ .[]
      | select(
          .deletedAt == null
          and .authorType != "system"
          and (.body | test("(?m)^\\[HUMAN_DECISION_REQUIRED\\]:"))
        )
    ]
    | sort_by(.createdAt, .id)
    | last // empty
  ' <<<"$comments")

  if [[ -n "$required" ]]; then
    required_at=$(jq -r '.createdAt' <<<"$required")
    required_comment_id=$(jq -r '.id' <<<"$required")
    released=false
    if is_engine_released "$current_id" "$required_at" "$issue"; then
      released=true
    else
      unblocked=$(jq -c \
        --arg at "$required_at" \
        --arg comment_id "$required_comment_id" '
        [ .[]
          | select(
              .deletedAt == null
              and (.createdAt > $at or (.createdAt == $at and .id > $comment_id))
              and (.body | test("(?m)^\\[HUMAN_DECISION_UNBLOCKED\\]:"))
            )
          | . + {
              via: (
                .body
                | capture("(?m)^\\[HUMAN_DECISION_UNBLOCKED\\]:[^\\n]*(?:^|[[:space:]])via=(?<via>[^[:space:]]+)").via
              )
            }
        ]
        | sort_by(.createdAt, .id)
        | last // empty
      ' <<<"$comments" 2>/dev/null || true)

      if [[ -n "$unblocked" ]]; then
        via=$(jq -r '.via' <<<"$unblocked")
        if [[ -n "$via" && "$via" != "null" ]] \
          && verified_release_via "$current_id" "$via" "$required_at"; then
          released=true
        fi
      fi
    fi

    if [[ "$released" != true ]]; then
      identifier=$(jq -r '.identifier' <<<"$issue")
      printf 'HUMAN_GATE_BLOCKED candidate=%s issue=%s identifier=%s reason=unverified_release\n' \
        "$candidate_id" "$current_id" "$identifier"
      exit 20
    fi
  fi

  current_id=$(jq -r '.parentId // empty' <<<"$issue")
done

printf 'HUMAN_GATE_CLEAR candidate=%s ancestors_checked=%d\n' "$candidate_id" "$depth"
