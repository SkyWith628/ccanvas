# 팀 프리셋 (ccanvas + Claude Code)

인스타에서 본 두 화면을 합친 구성이다.

- **바깥층 (ccanvas)**: 팀마다 캔버스 하나에 4개 세션. lead, build-1, build-2, reviewer.
- **안쪽층 (Claude Code)**: 각 세션은 Sonnet 메인과 Opus advisor로 돌고, 탐색과 검증은 Haiku 서브에이전트에 맡긴다.

```
TEAM A 캔버스 (폴더 = ../myapp-team-a worktree)
┌──────────────── team brief (노트) ────────────────┐
│ lead      Sonnet + Opus advisor  계획, 분배, 통합 │ build-1   Sonnet  배정된 파일만 │
│ build-2   Sonnet                 배정된 파일만    │ reviewer  Opus    읽기 전용 리뷰 │
└───────────────────────────────────────────────────┘
각 세션 안에서 쓰는 서브에이전트
  search (Haiku)  · grep (Haiku)  · audit (Haiku, worktree 격리)  · review (Opus)
```

## 들어 있는 파일

| 파일 | 역할 |
|---|---|
| `project/.claude/settings.json` | 메인 모델 `sonnet`, `advisorModel: "opus"`, `worktree.baseRef: "head"` |
| `project/.claude/agents/search.md` | Haiku, 읽기 전용. 저장소 구조 파악 |
| `project/.claude/agents/grep.md` | Haiku, 읽기 전용. 사용처 전부 찾기 |
| `project/.claude/agents/audit.md` | Haiku, `isolation: worktree`. 테스트, 타입체크, 린트 실행 |
| `project/.claude/agents/review.md` | Opus, 읽기 전용. diff 리뷰 |
| `project/CLAUDE.md` | 작업 순서. search → advisor → grep → 구현 → 커밋 → audit → review → `DONE:` |
| `ccanvas/team-preset.json` | ccanvas 템플릿. 노트 1개와 에이전트 4개 |
| `ccanvas/import-in-devtools.js` | 위 템플릿을 ccanvas에 넣는 스크립트 |
| `scripts/new-team.sh` | 팀용 git worktree와 `team/<이름>` 브랜치 생성 |

## 설정 순서

### 1. 저장소에 프리셋 넣기 (한 번만)

```bash
cp -r presets/team-preset/project/. ~/code/myapp/
```

```bash
cd ~/code/myapp && git add CLAUDE.md .claude && git commit -m "Add team preset"
```

먼저 커밋해야 한다. 커밋하지 않으면 다음 단계에서 만드는 worktree에 이 파일들이 들어가지 않는다.
이미 `CLAUDE.md`나 `.claude/settings.json`이 있으면 덮어쓰지 말고 내용을 합친다.

### 2. 팀마다 worktree 만들기

```bash
~/ccanvas/presets/team-preset/scripts/new-team.sh team-a
```

```bash
~/ccanvas/presets/team-preset/scripts/new-team.sh team-b
```

`../myapp-team-a`, `../myapp-team-b` 폴더가 생기고, 각각 `team/team-a`, `team/team-b` 브랜치를 쓴다.
팀끼리 파일이 겹쳐도 서로 덮어쓰지 않는다.

### 3. ccanvas에 템플릿 넣기 (한 번만)

이 포크의 ccanvas에는 하단 커맨드 바의 **Presets** 버튼이 있어서, 누르면 같은 4인 팀(lead, build-1, build-2, reviewer)이 TEAM 프레임으로 바로 생깁니다. 아래 템플릿은 역할 프롬프트를 한국어로 바꾸거나 노트 위젯을 함께 쓰고 싶을 때만 필요합니다.

방법 A (개발 모드나 웹 모드에서 실행 중일 때):

1. 개발자 도구 Console을 연다.
2. `ccanvas/import-in-devtools.js` 내용을 붙여 넣고 Enter를 누른다.
3. 앱을 새로고침한다.

방법 B (배포 앱, 직접 만들기):

1. 빈 캔버스에 `⌘/Ctrl+Shift+T`로 에이전트 4개를 만든다.
2. 마법사에서 아래 표대로 이름, 모델, 첫 프롬프트를 넣는다. 프롬프트 문구는 `team-preset.json`에 있다.
3. 명령 팔레트(`⌘K`)에서 현재 레이아웃을 템플릿으로 저장한다.

| 이름 | 모델 | 역할 |
|---|---|---|
| lead | sonnet | 계획을 세우고 `@build-1: …` / `@build-2: …` 형식으로 작업을 나눔 |
| build-1 | sonnet | 배정된 파일만 구현하고 커밋, 끝나면 `DONE:` |
| build-2 | sonnet | 위와 같음 |
| reviewer | opus | 수정 없이 audit와 diff 리뷰만 |

### 4. 팀 띄우기

1. ccanvas에서 새 캔버스를 만들고 폴더로 `../myapp-team-a`를 고른다.
2. `⌘K`에서 템플릿 **Team (lead + 2 builders + reviewer)**를 적용한다.
3. 각 에이전트 입력창에 역할 프롬프트가 입력된 채로 나타난다. 자동으로 전송되지 않으니 Enter를 눌러 시작한다.
4. 맨 위 노트에 목표와 build-1, build-2의 담당 파일을 적는다.
5. team-b도 새 탭에서 같은 방식으로 띄운다.

## 운영 방법

1. **lead에게 목표를 준다.**
   lead는 search로 저장소를 파악하고, advisor에게 확인한 뒤, `@build-1: …` `@build-2: …` 형식으로 작업을 나눈다.
2. **lead의 지시를 builder에게 전달한다.**
   상단 **Agents**(Roster)의 입력창으로 보낸다.
   기본 ccanvas는 에이전트끼리 자동으로 전달하지 않는다. 자동 전달은 커스텀 설계 3단계인 flow 재활성화가 필요하다.
3. **builder가 `DONE:`을 출력하면** reviewer에게 리뷰를 요청한다.
4. **reviewer가 통과시키면** lead에게 통합과 최종 확인을 맡긴다.
5. **팀 작업이 끝나면 병합한다.**

```bash
git merge team/team-a
```

## 알아둘 점

- **advisor는 이 저장소의 모든 세션에 적용된다.**
  `advisorModel`이 프로젝트 설정에 들어 있어서 lead뿐 아니라 build, reviewer, 서브에이전트도 advisor를 쓸 수 있다.
  비용을 아끼려고 lead에만 advisor를 붙이려면:
  1. `settings.json`에서 `advisorModel` 줄을 지운다.
  2. ccanvas에서 lead의 모델 칸에 `sonnet --advisor opus`라고 적는다.

  ccanvas는 모델 칸 값을 `--model` 뒤에 그대로 붙여 실행하기 때문에 이렇게 하면 lead만 `claude --model sonnet --advisor opus`로 뜬다. 다만 이건 의도된 사용법이 아니라 꼼수다.
  세션 안에서 `/advisor`로 바꾸면 사용자 설정에 저장돼 다른 프로젝트에도 영향을 주니 피한다.
- **advisor 사용 조건이 있다.**
  - Anthropic API나 구독 요금제에서만 작동하고 Bedrock에서는 안 된다.
  - `DISABLE_TELEMETRY`처럼 기능 플래그 조회를 끄는 설정이 있으면 작동하지 않는다.
- **audit는 마지막 커밋 기준이다.**
  `worktree.baseRef: "head"` 설정 때문에 audit의 worktree는 현재 브랜치의 마지막 커밋에서 갈라진다. 커밋하지 않은 변경은 검사되지 않으니, audit 전에 커밋하라고 CLAUDE.md에 적어 두었다.
- **builder 둘은 같은 폴더를 쓴다.**
  담당 파일이 겹치면 서로 덮어쓴다. lead가 파일을 겹치지 않게 나누는 게 전제다. 겹칠 수밖에 없는 작업이면 builder 하나만 쓰거나 팀을 나눈다.
- **Haiku 5.5는 Claude Code v2.1.293 이상이 필요하다.**
  `/tasks`에서 서브에이전트가 실제로 어떤 모델로 도는지 확인할 수 있다.
- **JEV fork layer(서드파티)는 넣지 않았다.**
  advisor와 audit/review가 같은 역할(재시도, 정지, 완료 검증)을 공식 기능으로 대신한다.
