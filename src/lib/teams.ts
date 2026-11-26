// Teams: a team is a titled frame on the canvas; its members are the agent
// widgets that sit fully inside that frame. This module is the shared contract
// for the team dashboard features (command bar, @-mentions, pause/resume,
// team presets, frame fan-out in flows). Non-reactive helpers only — UI reads
// the store and the agent status store itself.

import type { CanvasElement, FrameElement, WidgetElement, Workspace } from './types'
import { useStore } from '../store/workspace'
import { useSettings } from './settings'
import { newId } from './id'
import { broadcast, sendPrompt, useAgents, type AgentStatus } from './agents'

export type Team = { frame: FrameElement; members: WidgetElement[] }

export function isAgentWidget(el: CanvasElement | undefined): el is WidgetElement {
  return !!el && el.type === 'widget' && el.kind === 'agent'
}

/** Agents whose box lies entirely inside the frame. */
export function agentsInFrame(ws: Workspace, frame: FrameElement): WidgetElement[] {
  return ws.elements.filter(
    (e): e is WidgetElement =>
      isAgentWidget(e) &&
      e.x >= frame.x &&
      e.y >= frame.y &&
      e.x + e.w <= frame.x + frame.w &&
      e.y + e.h <= frame.y + frame.h,
  )
}

/** Titled frames (label boxes made by labelAgent are excluded) with their members. */
export function teamsOf(ws: Workspace): Team[] {
  return ws.elements
    .filter((e): e is FrameElement => e.type === 'frame' && !e.labelFor && !!e.title.trim())
    .map((frame) => ({ frame, members: agentsInFrame(ws, frame) }))
}

/** Normalise a name for @-mention matching: "TEAM A" → "team-a". */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export type MentionTarget =
  | { kind: 'team'; name: string; ids: string[] }
  | { kind: 'agent'; name: string; ids: string[] }

/** Every addressable target in a workspace: teams first, then single agents. */
export function mentionTargets(ws: Workspace): MentionTarget[] {
  const teams: MentionTarget[] = teamsOf(ws).map((t) => ({
    kind: 'team',
    name: t.frame.title.trim(),
    ids: t.members.map((m) => m.id),
  }))
  const agents: MentionTarget[] = ws.elements.filter(isAgentWidget).map((a) => ({
    kind: 'agent',
    name: a.title || 'agent',
    ids: [a.id],
  }))
  return [...teams, ...agents]
}

export type ParsedCommand = {
  /** agent ids the text goes to (deduplicated, in mention order) */
  ids: string[]
  /** the mentions that resolved, as written */
  resolved: string[]
  /** mentions that matched nothing */
  unknown: string[]
  /** the message with the leading mentions removed */
  text: string
}

/**
 * Parse "@team-a @reviewer fix the login bug". Leading @tokens are targets;
 * a token matches a team or agent whose slug equals it (team wins on a tie).
 * With no leading mention, `ids` is empty and the caller picks a default.
 */
export function parseCommand(ws: Workspace, input: string): ParsedCommand {
  const targets = mentionTargets(ws)
  const ids: string[] = []
  const resolved: string[] = []
  const unknown: string[] = []
  let rest = input.trimStart()
  for (;;) {
    const m = /^@([^\s@]+)\s*/u.exec(rest)
    if (!m) break
    rest = rest.slice(m[0].length)
    const key = slug(m[1])
    const hit = targets.find((t) => slug(t.name) === key)
    if (!hit) {
      unknown.push(m[1])
      continue
    }
    resolved.push(m[1])
    for (const id of hit.ids) if (!ids.includes(id)) ids.push(id)
  }
  return { ids, resolved, unknown, text: rest.trim() }
}

/** Send a prompt to each agent; returns how many were live and received it. */
export function sendToAgents(ids: string[], text: string): number {
  let n = 0
  for (const id of ids) if (sendPrompt(id, text)) n++
  return n
}

/** Ids of agents in a workspace that are currently working or waiting. */
export function busyAgents(ws: Workspace): string[] {
  const status = useAgents.getState().status
  return ws.elements
    .filter(isAgentWidget)
    .filter((a) => {
      const s: AgentStatus | undefined = status[a.id]
      return s === 'working' || s === 'waiting'
    })
    .map((a) => a.id)
}

// Pause = interrupt the current Claude Code turn with Esc; resume = tell it to
// continue. Agents we paused are remembered so "resume all" only nudges those.
const paused = new Set<string>()

export function isPaused(id: string): boolean {
  return paused.has(id)
}

/** Interrupt the given agents (default: every busy agent in the active tab). */
export function pauseAgents(ids?: string[]): number {
  const ws = useStore.getState().active()
  const targets = ids ?? (ws ? busyAgents(ws) : [])
  broadcast(targets, '\x1b')
  for (const id of targets) paused.add(id)
  return targets.length
}

/** Resume agents paused by pauseAgents (default: all of them). */
export function resumeAgents(ids?: string[]): number {
  const targets = (ids ?? [...paused]).filter((id) => paused.has(id))
  let n = 0
  for (const id of targets) {
    if (sendPrompt(id, 'continue')) n++
    paused.delete(id)
  }
  return n
}

export type TeamRole = {
  title: string
  model?: string
  agentPrompt?: string
}

/** The default 4-agent team: a lead, two builders and a reviewer. */
export const DEFAULT_TEAM_ROLES: TeamRole[] = [
  {
    title: 'lead',
    model: 'sonnet',
    agentPrompt:
      'You are the lead of this team. Wait for the first instruction. Then map the repo with subagents, consult the advisor, and split the work into non-overlapping file sets written as "@build-1: ..." and "@build-2: ...".',
  },
  {
    title: 'build-1',
    model: 'sonnet',
    agentPrompt:
      'You are build-1. Only edit the files the lead assigns you. Wait for instructions; when done, commit and end with "DONE: <summary>".',
  },
  {
    title: 'build-2',
    model: 'sonnet',
    agentPrompt:
      'You are build-2. Only edit the files the lead assigns you. Wait for instructions; when done, commit and end with "DONE: <summary>".',
  },
  {
    title: 'reviewer',
    model: 'opus',
    agentPrompt:
      'You are the reviewer. Do not edit files. When asked, run the tests and review git diff; report only real bugs with file:line and a reproducing input.',
  },
]

const CARD_W = 560
const CARD_H = 380
const GAP = 20
const PAD = 28
const TOP = 56

/** Next free team name in the active tab: "TEAM A", "TEAM B", … */
export function nextTeamName(ws: Workspace): string {
  const taken = new Set(teamsOf(ws).map((t) => slug(t.frame.title)))
  for (let i = 0; i < 26; i++) {
    const name = `TEAM ${String.fromCharCode(65 + i)}`
    if (!taken.has(slug(name))) return name
  }
  return `TEAM ${teamsOf(ws).length + 1}`
}

/**
 * Spawn a team centred at (cx, cy): agents laid out in a 2-column grid inside
 * a titled frame. Agent titles are prefixed with the team slug so mentions stay
 * unique across teams ("team-a/lead"). Returns the new frame id.
 */
export function spawnTeam(
  cx: number,
  cy: number,
  opts: { name?: string; roles?: TeamRole[] } = {},
): string | null {
  const store = useStore.getState()
  const ws = store.active()
  if (!ws) return null
  const roles = opts.roles ?? DEFAULT_TEAM_ROLES
  if (!roles.length) return null
  const name = opts.name ?? nextTeamName(ws)
  const cols = Math.min(2, roles.length)
  const rows = Math.ceil(roles.length / cols)
  const innerW = cols * CARD_W + (cols - 1) * GAP
  const innerH = rows * CARD_H + (rows - 1) * GAP
  const fw = innerW + PAD * 2
  const fh = innerH + TOP + PAD
  const fx = cx - fw / 2
  const fy = cy - fh / 2
  const dir = ws.dir
  const prefix = slug(name)
  const frame: FrameElement = {
    id: newId(),
    type: 'frame',
    x: fx,
    y: fy,
    w: fw,
    h: fh,
    title: name,
    color: '#d97757',
    z: 0,
  }
  const agents: WidgetElement[] = roles.map((r, i) => ({
    id: newId(),
    type: 'widget',
    kind: 'agent',
    x: fx + PAD + (i % cols) * (CARD_W + GAP),
    y: fy + TOP + Math.floor(i / cols) * (CARD_H + GAP),
    w: CARD_W,
    h: CARD_H,
    z: 0,
    title: `${prefix}/${r.title}`,
    ...(r.model ? { model: r.model } : {}),
    ...(r.agentPrompt ? { agentPrompt: r.agentPrompt } : {}),
    ...(dir ? { cwd: dir } : {}),
    sessionId: crypto.randomUUID(),
    cli: useSettings.getState().agentCli,
  }))
  store.beginHistory()
  store.addElements([frame, ...agents])
  store.setSelection([frame.id])
  return frame.id
}

/** Wrap the selected agents in a new titled team frame. Returns its id. */
export function groupSelectionAsTeam(name?: string): string | null {
  const store = useStore.getState()
  const ws = store.active()
  if (!ws) return null
  const sel = new Set(store.selection)
  const picked = ws.elements.filter((e): e is WidgetElement => sel.has(e.id) && isAgentWidget(e))
  if (!picked.length) return null
  const x0 = Math.min(...picked.map((a) => a.x)) - PAD
  const y0 = Math.min(...picked.map((a) => a.y)) - TOP
  const x1 = Math.max(...picked.map((a) => a.x + a.w)) + PAD
  const y1 = Math.max(...picked.map((a) => a.y + a.h)) + PAD
  const frame: FrameElement = {
    id: newId(),
    type: 'frame',
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    title: name ?? nextTeamName(ws),
    color: '#d97757',
    z: 0,
  }
  store.beginHistory()
  store.addElements([frame])
  store.sendToBack([frame.id])
  store.setSelection([frame.id])
  return frame.id
}
