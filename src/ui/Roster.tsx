import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { viewCenter } from '../lib/view'
import { useStore } from '../store/workspace'
import { useAgents, useDisplayStatus, sendPrompt, type AgentStatus } from '../lib/agents'
import {
  isPaused,
  parseCommand,
  pauseAgents,
  resumeAgents,
  sendToAgents,
  teamsOf,
} from '../lib/teams'
import { watchTranscriptSummary } from '../lib/transcript'
import type { WidgetElement, Workspace } from '../lib/types'
import { IconClose, IconBroadcast } from './icons'
import '../styles/agent-tools.css'


type Row = { agent: WidgetElement; tab: Workspace }

/** A roster section: one team frame on a tab, or the trailing "Ungrouped". */
type Section = { key: string; title: string; tab: Workspace | null; rows: Row[] }

const isBusy = (s: AgentStatus | undefined) => s === 'working' || s === 'waiting'

/** Group agents by team. An agent inside nested/overlapping frames is listed
 *  once, under the first team that holds it, so counts never double up. */
function sectionsOf(tabs: Workspace[]): Section[] {
  const teams: Section[] = []
  const loose: Row[] = []
  for (const tab of tabs) {
    const seen = new Set<string>()
    for (const t of teamsOf(tab)) {
      const rows: Row[] = []
      for (const m of t.members)
        if (!seen.has(m.id)) {
          seen.add(m.id)
          rows.push({ agent: m, tab })
        }
      teams.push({ key: t.frame.id, title: t.frame.title.trim(), tab, rows })
    }
    for (const e of tab.elements)
      if (e.type === 'widget' && e.kind === 'agent' && !seen.has(e.id)) loose.push({ agent: e, tab })
  }
  if (loose.length) teams.push({ key: 'ungrouped', title: 'Ungrouped', tab: null, rows: loose })
  return teams
}

// Inline styles: the roster's stylesheet (agent-tools.css) belongs to another
// part of the dashboard work, so the team header styles live here instead.
const S = {
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 9px 4px',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.06em',
    color: 'var(--ink-dim)',
  },
  headTitle: { color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase' },
  headBtn: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--ink-dim)',
    background: 'var(--panel-hi)',
    border: '1px solid var(--line)',
    borderRadius: 100,
    padding: '1px 8px',
    cursor: 'pointer',
  },
  paused: {
    fontSize: 10,
    color: 'var(--accent)',
    border: '1px solid var(--accent-line)',
    borderRadius: 4,
    padding: '0 5px',
    flexShrink: 0,
  },
  route: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--ink-dim)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  unknown: { color: 'var(--accent)' },
} satisfies Record<string, CSSProperties>

/** Each agent's latest reply, read from its session transcript. The terminal
 *  tail is full of TUI chrome (spinners, hints, box drawing), so it isn't used. */
function useLastMessages(rows: Row[]): Record<string, string> {
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const key = rows.map((r) => `${r.agent.id}:${r.agent.cwd}:${r.agent.sessionId}`).join('|')
  useEffect(() => {
    const offs = rows.map(({ agent }) =>
      watchTranscriptSummary(agent.cwd, agent.sessionId, (summary) => {
        // one readable line: first non-empty line, markdown markers dropped
        const line = summary?.lastReply
          ?.split('\n')
          .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
          .find(Boolean)
          ?.slice(0, 160)
        setMsgs((m) => {
          if (m[agent.id] === line) return m
          const next = { ...m }
          if (line) next[agent.id] = line
          else delete next[agent.id]
          return next
        })
      }),
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return msgs
}

// Mission-control list of every agent across all tabs: status, cost/turns, last
// line, click-to-focus, and a composer that sends to one agent or broadcasts to
// all. The spatial canvas is great for layout but poor at "is anything stuck?" —
// this is the at-scale answer.
function RosterDot({ id }: { id: string }) {
  const st = useDisplayStatus(id) ?? 'off'
  return (
    <span
      className={`agent-dot agent-dot--${st}`}
      title={st === 'done' ? 'just finished' : st}
    />
  )
}

export function Roster() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const switchTab = useStore((s) => s.switchTab)
  const setCamera = useStore((s) => s.setCamera)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const setOpenPanel = useStore((s) => s.setOpenPanel)

  const metrics = useAgents((s) => s.metrics)
  // the paused set in lib/teams isn't reactive; a status change (Esc → idle)
  // or a local tick after our own pause/resume re-renders the tags
  const status = useAgents((s) => s.status)
  const [, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)

  const [text, setText] = useState('')
  const [target, setTarget] = useState<string | null>(null) // agent id, or null = all

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const tab of tabs)
      for (const e of tab.elements)
        if (e.type === 'widget' && e.kind === 'agent') out.push({ agent: e, tab })
    return out
  }, [tabs])
  const lastMessage = useLastMessages(rows)
  const sections = useMemo(() => sectionsOf(tabs), [tabs])
  const activeTab = tabs.find((t) => t.id === activeTabId)

  // "@team-a fix it" routes by mention (resolved against the active tab, where
  // the user is looking); anything else keeps the focused-agent/all behaviour
  const mention = text.trimStart().startsWith('@') && activeTab ? parseCommand(activeTab, text) : null

  const focus = (row: Row) => {
    if (activeTabId !== row.tab.id) switchTab(row.tab.id)
    const cam = row.tab.camera
    const cx = row.agent.x + row.agent.w / 2
    const cy = row.agent.y + row.agent.h / 2
    setCamera({
      zoom: cam.zoom,
      x: viewCenter().x - cx * cam.zoom,
      y: viewCenter().y - cy * cam.zoom,
    })
    setSelection([row.agent.id])
    setActiveWidget(row.agent.id)
    bringToFront([row.agent.id])
    setTarget(row.agent.id)
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    if (mention) {
      if (!mention.ids.length || !mention.text) return
      if (sendToAgents(mention.ids, mention.text)) setText('')
      return
    }
    const ids = target ? [target] : rows.map((r) => r.agent.id)
    let delivered = 0
    for (const id of ids) if (sendPrompt(id, body)) delivered++
    if (delivered) setText('')
  }

  const targetLabel =
    target && rows.find((r) => r.agent.id === target)
      ? rows.find((r) => r.agent.id === target)!.agent.title
      : 'all agents'

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Agents</span>
        <span className="panel__badge">{rows.length}</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body">
        {rows.length === 0 && (
          <div className="panel__empty">No agents yet. Start one with ⌘⇧T.</div>
        )}
        {sections.map((sec) => {
          const ids = sec.rows.map((r) => r.agent.id)
          const busy = ids.filter((id) => isBusy(status[id]))
          const anyPaused = ids.some(isPaused)
          return (
            <div key={sec.key}>
              <div style={S.head}>
                <span style={S.headTitle}>{sec.title}</span>
                <span>
                  · {busy.length} running / {ids.length}
                </span>
                {sec.tab && sec.tab.id !== activeTabId && (
                  <span className="roster__tab">{sec.tab.name}</span>
                )}
                <span className="panel__spacer" />
                {busy.length > 0 && (
                  <button
                    style={S.headBtn}
                    title="Interrupt this team's running agents (Esc)"
                    onClick={() => {
                      pauseAgents(busy)
                      bump()
                    }}
                  >
                    Pause
                  </button>
                )}
                {anyPaused && (
                  <button
                    style={S.headBtn}
                    title="Tell this team's paused agents to continue"
                    onClick={() => {
                      resumeAgents(ids)
                      bump()
                    }}
                  >
                    Resume
                  </button>
                )}
              </div>
              {sec.rows.map((row) => {
                const m = metrics[row.agent.id]
                const ll = lastMessage[row.agent.id]
                return (
                  <div
                    key={row.agent.id}
                    className={`roster__row${target === row.agent.id ? ' roster__row--target' : ''}`}
                    onClick={() => focus(row)}
                  >
                    <RosterDot id={row.agent.id} />
                    <div className="roster__main">
                      <div className="roster__top">
                        <span className="roster__name">{row.agent.title}</span>
                        {isPaused(row.agent.id) && <span style={S.paused}>paused</span>}
                        {row.tab.id !== activeTabId && (
                          <span className="roster__tab">{row.tab.name}</span>
                        )}
                        {m && (m.turns > 0 || m.costUsd != null) && (
                          <span className="roster__meter">
                            {m.turns}t{m.costUsd != null ? ` · $${m.costUsd.toFixed(2)}` : ''}
                          </span>
                        )}
                      </div>
                      {ll && <div className="roster__last">{ll}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="panel__composer">
        {mention && (
          <div style={S.route}>
            {mention.ids.length > 0 && (
              <span>
                → {mention.resolved.map((r) => '@' + r).join(' ')} ({mention.ids.length} agent
                {mention.ids.length === 1 ? '' : 's'})
              </span>
            )}
            {mention.unknown.length > 0 && (
              <span style={S.unknown}>
                unknown: {mention.unknown.map((u) => '@' + u).join(' ')}
              </span>
            )}
          </div>
        )}
        <button
          className="composer__target"
          title="Toggle between the focused agent and broadcasting to all"
          onClick={() => setTarget(null)}
        >
          {target ? '→ ' : <IconBroadcast size={14} />}
          <span className="composer__target-name">{targetLabel}</span>
        </button>
        <textarea
          className="composer__input"
          placeholder={
            target ? 'Message this agent… (@team-a to direct)' : 'Broadcast to all agents… (@ to direct)'
          }
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className="composer__send"
          disabled={!text.trim() || (!!mention && (!mention.ids.length || !mention.text))}
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  )
}
