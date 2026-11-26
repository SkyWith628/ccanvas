# Team workflow

이 저장소는 "리드 + 서브에이전트" 방식으로 작업한다.

## 역할
- **메인 세션(리드)**: Sonnet. 계획, 코드 수정, 통합을 직접 한다.
- **advisor**: Opus (`.claude/settings.json`의 `advisorModel`). 코드를 쓰지 않고 조언만 한다.
- **서브에이전트** (`.claude/agents/`)
  - `search` (Haiku): 계획 전에 저장소 구조 파악
  - `grep` (Haiku): 이름 변경, 시그니처 변경, 삭제 전에 사용처 찾기
  - `audit` (Haiku, worktree 격리): 완료 전에 테스트, 타입체크, 린트 실행
  - `review` (Opus): audit 통과 후 독립 리뷰

## 작업 순서
1. 작업이 사소하지 않으면 `search`로 관련 모듈부터 파악한다. 서로 독립적인 탐색은 병렬로 맡긴다.
2. 접근 방식을 정하기 전에 advisor에게 확인한다.
3. 시그니처를 바꾸거나 코드를 지우기 전에 `grep`으로 사용처를 전부 확인한다.
4. 같은 에러가 두 번 나면 바로 재시도하지 말고 advisor에게 묻는다.
5. 끝나면 커밋하고 `audit`를 돌린다. audit의 worktree는 마지막 커밋 기준이다.
6. audit가 통과하면 `review`를 돌리고, 지적된 문제를 고친다.
7. 완료를 보고하기 전에 advisor에게 한 번 더 확인하고, 마지막 줄에 `DONE: <한 줄 요약>`을 쓴다.

## 규칙
- 내 팀 worktree 밖의 파일은 건드리지 않는다.
- 다른 팀 브랜치에 push하지 않는다.
