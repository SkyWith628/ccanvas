// ccanvas 창의 개발자 도구(Console)에 붙여 넣고 Enter를 누른 뒤 앱을 새로고침하세요.
// 같은 id의 템플릿이 있으면 교체하고, 다른 템플릿은 그대로 둡니다.
(() => {
  const KEY = 'ccanvas:templates:v1'
  const preset = [{"id": "team-4-preset", "name": "Team (lead + 2 builders + reviewer)", "widgets": [{"kind": "note", "dx": 0, "dy": 0, "w": 1140, "h": 140, "title": "team brief", "note": "# TEAM ?\n\n- 목표: \n- 브랜치/worktree: \n- 담당 파일 분배 (builder끼리 겹치지 않게):\n  - build-1: \n  - build-2: \n"}, {"kind": "agent", "dx": 0, "dy": 160, "w": 560, "h": 380, "title": "lead", "model": "sonnet", "cli": "claude", "agentPrompt": "CLAUDE.md의 Team workflow를 읽어라. 너는 이 팀의 lead다. 이 캔버스 폴더가 팀 worktree다. 아직 작업하지 말고 첫 지시를 기다려라. 지시가 오면 search로 파악하고, advisor와 상의해 계획을 세운 뒤, build-1과 build-2에 넘길 작업을 담당 파일이 겹치지 않게 나눠서 '@build-1: ...' '@build-2: ...' 형식으로 출력해라."}, {"kind": "agent", "dx": 580, "dy": 160, "w": 560, "h": 380, "title": "build-1", "model": "sonnet", "cli": "claude", "agentPrompt": "CLAUDE.md의 Team workflow를 읽어라. 너는 build-1이다. lead가 배정한 파일만 수정한다. 지금은 대기하고, 지시가 오면 grep으로 영향 범위를 확인한 뒤 구현하고 커밋해라. 끝나면 'DONE: 요약'을 출력해라."}, {"kind": "agent", "dx": 0, "dy": 560, "w": 560, "h": 380, "title": "build-2", "model": "sonnet", "cli": "claude", "agentPrompt": "CLAUDE.md의 Team workflow를 읽어라. 너는 build-2다. lead가 배정한 파일만 수정한다. 지금은 대기하고, 지시가 오면 grep으로 영향 범위를 확인한 뒤 구현하고 커밋해라. 끝나면 'DONE: 요약'을 출력해라."}, {"kind": "agent", "dx": 580, "dy": 560, "w": 560, "h": 380, "title": "reviewer", "model": "opus", "cli": "claude", "agentPrompt": "CLAUDE.md의 Team workflow를 읽어라. 너는 reviewer다. 파일을 수정하지 않는다. 지금은 대기하고, 리뷰 요청이 오면 audit로 테스트를 돌리고 git diff를 검토해서 실제 버그만 file:line과 재현 입력으로 보고해라."}]}]
  let cur = []
  try { cur = JSON.parse(localStorage.getItem(KEY) || '[]') } catch {}
  const ids = new Set(preset.map((t) => t.id))
  localStorage.setItem(KEY, JSON.stringify([...cur.filter((t) => !ids.has(t.id)), ...preset]))
  console.log('team preset imported; reload the app')
})()
