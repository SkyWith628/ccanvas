#!/usr/bin/env bash
# 팀 하나를 위한 git worktree를 만든다.
# 사용법: 저장소 안에서  ./new-team.sh <팀이름> [기준 브랜치, 기본: 현재 HEAD]
# 결과:  ../<저장소이름>-<팀이름>  폴더, 브랜치 team/<팀이름>
set -euo pipefail

team="${1:-}"
base="${2:-HEAD}"
if [[ -z "$team" || ! "$team" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "usage: $0 <team-name> [base-ref]   (team-name: letters, digits, . _ -)" >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
repo="$(basename "$root")"
dir="$(dirname "$root")/${repo}-${team}"
branch="team/${team}"

if [[ -e "$dir" ]]; then
  echo "already exists: $dir" >&2
  exit 1
fi

# 팀 설정이 커밋돼 있어야 worktree에도 들어간다
missing=()
for f in CLAUDE.md .claude/settings.json .claude/agents; do
  git -C "$root" cat-file -e "${base}:${f}" 2>/dev/null || missing+=("$f")
done
if (( ${#missing[@]} )); then
  echo "warning: not committed at ${base}: ${missing[*]}" >&2
  echo "         commit the team preset files first, or this team runs without them." >&2
fi

git -C "$root" worktree add -b "$branch" "$dir" "$base"
echo
echo "team '${team}' ready:"
echo "  folder: $dir"
echo "  branch: $branch"
echo "next: in ccanvas, open a new canvas bound to this folder and apply the Team preset."
