#!/usr/bin/env bash
# rack3d 커밋 전 기계적 검증 훅 (PreToolUse: Bash)
#
# 목적: 답이 정해진 검사는 사람/LLM 이 아니라 코드가 한다.
#   - 리뷰·QA 서브에이전트가 매번 토큰을 써서 판단하던 것을 여기로 옮겼다(2026-08-22).
#   - 훅은 100% 일관되고 토큰을 쓰지 않는다. 리뷰 에이전트는 여기서 못 잡는 것에 집중한다.
#
# 동작: Bash 도구 호출 중 `git commit` 을 가로채 staged 내용만 검사한다.
#   통과 → 조용히 exit 0 (커밋 진행)
#   실패 → stderr 에 사유를 적고 exit 2 (커밋 차단, 사유가 에이전트에게 전달됨)
#
# 비상 해제: RACK3D_SKIP_COMMIT_CHECKS=1 git commit ...
#   (훅 오작동으로 작업이 멈추는 것을 막기 위한 탈출구. 남용하지 말 것)

set -uo pipefail

# ── 0. 입력 파싱 ───────────────────────────────────────────────────────────────
# 실패하면 커밋을 막지 않는다(fail-open). 훅 자신의 버그로 작업이 멈추면 안 된다.
payload="$(cat)" || exit 0
command_line="$(printf '%s' "$payload" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")' 2>/dev/null)" || exit 0

# `git commit` 호출이 아니면 아무것도 하지 않는다.
# (`git commit` 이 커밋 메시지 본문에 우연히 들어가 훅이 돌더라도 검사만 하고 지나가므로 무해하다)
printf '%s' "$command_line" | grep -qE '(^|[;&|]|\s)git(\s+-[^;&|]*)*\s+commit(\s|$)' || exit 0

[ "${RACK3D_SKIP_COMMIT_CHECKS:-0}" = "1" ] && exit 0

project_dir="${CLAUDE_PROJECT_DIR:-}"
[ -z "$project_dir" ] && project_dir="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$project_dir" ] && exit 0
cd "$project_dir" || exit 0

# ── 1. staged 목록 ─────────────────────────────────────────────────────────────
staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)"
# staged 가 비었으면 git 이 알아서 에러를 낸다. 훅이 끼어들 이유가 없다.
[ -z "$staged" ] && exit 0

failures=()

# ── 2. 커밋되면 안 되는 경로 ───────────────────────────────────────────────────
# 근거: 2026-08-21 QA 가 배포 이미지에서 `.DS_Store` 공개 서빙과
#       빌더 레이어에 남은 `.env`(API 키)를 발견했다.
forbidden="$(printf '%s\n' "$staged" | grep -E '(^|/)\.DS_Store$|(^|/)\.env$|(^|/)\.env\.[^/]*$|^node_modules/|^dist/' | grep -vE '(^|/)\.env\.example$' || true)"
if [ -n "$forbidden" ]; then
  failures+=("커밋 금지 경로가 staged 되어 있다:
$(printf '%s\n' "$forbidden" | sed 's/^/    /')
  → git restore --staged <파일> 로 빼라. .env 는 시크릿, .DS_Store 는 배포 이미지에 섞인다.")
fi

# ── 3. 대용량 파일 ─────────────────────────────────────────────────────────────
# 근거: 2026-08-21 미사용 GLB 42.7MB 가 배포 이미지에 실려 있었다(전체 59MB 중).
#       큰 바이너리는 git 히스토리에 영구히 남으므로 의도적 결정이어야 한다.
max_bytes=5242880   # 5MB
big=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  blob="$(git rev-parse ":$f" 2>/dev/null)" || continue
  size="$(git cat-file -s "$blob" 2>/dev/null)" || continue
  if [ "$size" -gt "$max_bytes" ]; then
    big="${big}    ${f} ($((size / 1048576))MB)"$'\n'
  fi
done <<< "$staged"
if [ -n "$big" ]; then
  failures+=("5MB 를 넘는 파일이 staged 되어 있다:
$(printf '%s' "$big")  → 정말 필요한가? 히스토리에서 지우기 어렵다. 의도한 것이면:
     RACK3D_SKIP_COMMIT_CHECKS=1 git commit ...")
fi

# ── 4. 시크릿 스캔 (추가된 줄만) ───────────────────────────────────────────────
# 오탐을 피하려고 범용 휴리스틱(api_key= 같은 것) 대신 알려진 키 접두사만 본다.
added="$(git diff --cached -U0 --diff-filter=ACMR 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
if [ -n "$added" ]; then
  secret_hits="$(printf '%s\n' "$added" | grep -nE \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e 'tsk_[A-Za-z0-9]{20,}' \
    -e 'sk-ant-[A-Za-z0-9_-]{20,}' \
    -e 'sk-[A-Za-z0-9]{32,}' \
    -e 'gh[pousr]_[A-Za-z0-9]{36}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'AIza[0-9A-Za-z_-]{35}' \
    -e 'xox[baprs]-[A-Za-z0-9-]{12,}' \
    || true)"
  if [ -n "$secret_hits" ]; then
    # 값 자체를 로그에 남기지 않는다 — 앞 24자만 보여준다.
    failures+=("시크릿으로 보이는 문자열이 추가됐다:
$(printf '%s\n' "$secret_hits" | cut -c1-24 | sed 's/$/…/' | sed 's/^/    /')
  → 키는 코드에 넣지 않는다. .env(gitignore 대상)나 시크릿 매니저를 써라.")
  fi
fi

# ── 5. 타입체크·린트 (관련 파일이 staged 됐을 때만) ────────────────────────────
# `npm run build` 의 앞단(`tsc -b`)과 `npm run lint` 를 그대로 돌린다.
# vite build 는 넣지 않는다 — 느리고 rolldown 네이티브 바인딩이 아키텍처를 탄다.
needs_js="$(printf '%s\n' "$staged" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$|^tsconfig|^package\.json$|^eslint\.config\.js$' || true)"
if [ -n "$needs_js" ]; then
  if [ ! -x ./node_modules/.bin/tsc ] || [ ! -x ./node_modules/.bin/eslint ]; then
    # 의존성이 없으면 막지 않는다(fresh clone 등). 대신 알린다.
    echo "[pre-commit] node_modules 가 없어 타입체크·린트를 건너뛴다. npm ci 후 다시 확인할 것." >&2
  else
    tsc_out="$(mktemp)"; eslint_out="$(mktemp)"
    ./node_modules/.bin/tsc -b >"$tsc_out" 2>&1 & tsc_pid=$!
    ./node_modules/.bin/eslint . >"$eslint_out" 2>&1 & eslint_pid=$!
    wait "$tsc_pid"; tsc_rc=$?
    wait "$eslint_pid"; eslint_rc=$?
    [ "$tsc_rc" -ne 0 ] && failures+=("타입체크 실패 (tsc -b):
$(sed 's/^/    /' "$tsc_out" | head -40)")
    [ "$eslint_rc" -ne 0 ] && failures+=("린트 실패 (eslint .):
$(sed 's/^/    /' "$eslint_out" | head -40)")
    rm -f "$tsc_out" "$eslint_out"
  fi
fi

# ── 6. 결과 ────────────────────────────────────────────────────────────────────
if [ "${#failures[@]}" -gt 0 ]; then
  {
    echo "커밋 전 기계적 검증 실패 — 커밋을 진행하지 않았다."
    echo
    for f in "${failures[@]}"; do
      echo "■ $f"
      echo
    done
    echo "고친 뒤 다시 커밋하라. 훅이 잘못 잡은 것이라면 RACK3D_SKIP_COMMIT_CHECKS=1 로 우회할 수 있으나,"
    echo "그 경우 왜 우회했는지 사용자에게 알릴 것."
  } >&2
  exit 2
fi

exit 0
