// Bottom-centre command bar for the team dashboard: quick action chips, a
// prompt input that routes text to teams/agents via @-mentions (or to the
// selected agents), @ autocomplete, and hold-space voice input where the
// webview supports the Web Speech API.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { viewCenter } from '../lib/view'
import { screenToWorld } from '../lib/geometry'
import type { Workspace } from '../lib/types'
import {
  groupSelectionAsTeam,
  isAgentWidget,
  mentionTargets,
  parseCommand,
  pauseAgents,
  resumeAgents,
  sendToAgents,
  slug,
  spawnTeam,
  teamsOf,
  type MentionTarget,
} from '../lib/teams'
import { IconClose } from './icons'

const HINT_KEY = 'ccanvas.cmdbar.hintDismissed'
const HOLD_MS = 250
const STATUS_MS = 3500
const NO_VOICE =
  'Voice not available in this webview — use OS dictation (macOS: press Fn twice, Windows: Win+H)'

// Minimal local typing of the Web Speech API: it isn't in TS's DOM lib and we
// don't want a dependency just for the types.
type SpeechAlt = { transcript: string }
type SpeechResult = { isFinal: boolean; length: number; [i: number]: SpeechAlt }
type SpeechEvent = { resultIndex: number; results: { length: number; [i: number]: SpeechResult } }
interface Recognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognizerCtor = new () => Recognizer

function speechCtor(): RecognizerCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function loadHintDismissed() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

function worldCenter() {
  return screenToWorld(viewCenter(), selectActive(useStore.getState()).camera)
}

/** The @token the caret sits in, if any: its start offset and typed prefix. */
function mentionAt(value: string, caret: number): { start: number; prefix: string } | null {
  const m = /(^|\s)@([^\s@]*)$/u.exec(value.slice(0, caret))
  if (!m) return null
  return { start: caret - m[2].length - 1, prefix: m[2] }
}

/** Agent ids the current selection points at: selected agents plus members of selected team frames. */
function selectedAgentIds(ws: Workspace, selection: string[]): string[] {
  const sel = new Set(selection)
  const ids: string[] = []
  for (const e of ws.elements) if (sel.has(e.id) && isAgentWidget(e)) ids.push(e.id)
  for (const t of teamsOf(ws))
    if (sel.has(t.frame.id)) for (const m of t.members) if (!ids.includes(m.id)) ids.push(m.id)
  return ids
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function CommandBar() {
  const ws = useStore(selectActive)
  const selection = useStore((s) => s.selection)
  const openPanel = useStore((s) => s.openPanel)
  const presenting = useStore((s) => s.presenting)

  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [pick, setPick] = useState(0)
  const [popupClosed, setPopupClosed] = useState(false)
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  const [listening, setListening] = useState(false)
  const [hintDismissed, setHintDismissed] = useState(loadHintDismissed)

  const inputRef = useRef<HTMLInputElement>(null)
  const statusTimer = useRef<number | undefined>(undefined)
  const holdTimer = useRef<number | undefined>(undefined)
  const holdPending = useRef(false)
  const recRef = useRef<Recognizer | null>(null)
  // text that was in the input when listening began; speech is appended to it
  const voiceBase = useRef('')
  const voiceFinal = useRef('')
  // set when listening is cut short by Enter (text already sent) or Escape
  // (user is leaving the bar): onend must then not restore the transcript or
  // pull focus back into the input
  const discardVoice = useRef(false)

  const hasVoice = useMemo(() => speechCtor() !== null, [])

  const flash = useCallback((text: string, tone: 'ok' | 'warn' = 'ok', ms = STATUS_MS) => {
    window.clearTimeout(statusTimer.current)
    setStatus({ text, tone })
    statusTimer.current = window.setTimeout(() => setStatus(null), ms)
  }, [])

  useEffect(
    () => () => {
      window.clearTimeout(statusTimer.current)
      window.clearTimeout(holdTimer.current)
      recRef.current?.abort()
    },
    [],
  )

  // Group only wraps directly selected agent widgets (groupSelectionAsTeam
  // ignores members of a selected frame), so the chip's enabled state must
  // follow that rule rather than selectedAgentIds, which is for routing sends
  const hasSelectedAgent = useMemo(
    () => selection.some((id) => isAgentWidget(ws.elements.find((e) => e.id === id))),
    [ws, selection],
  )

  // ---- @ autocomplete --------------------------------------------------
  const mention = focused && !popupClosed ? mentionAt(value, caret) : null
  const mentionPrefix = mention ? mention.prefix : null
  const suggestions: MentionTarget[] = useMemo(() => {
    if (mentionPrefix === null) return []
    const key = slug(mentionPrefix)
    // teams come first: mentionTargets already orders them that way
    return mentionTargets(ws)
      .filter((t) => slug(t.name).startsWith(key))
      .slice(0, 8)
  }, [ws, mentionPrefix])

  useEffect(() => setPick(0), [mentionPrefix])

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? value.length)

  const complete = (t: MentionTarget) => {
    if (!mention) return
    const insert = `@${slug(t.name)} `
    const next = value.slice(0, mention.start) + insert + value.slice(caret)
    const pos = mention.start + insert.length
    setValue(next)
    setCaret(pos)
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos))
  }

  // ---- sending -----------------------------------------------------------
  const submit = () => {
    const raw = value.trim()
    if (!raw) return
    const parsed = parseCommand(ws, raw)
    const unknown = parsed.unknown.map((u) => `@${u}`).join(' ')
    let ids = parsed.ids
    // Unresolved @tokens are most likely Claude Code @file references
    // ("@src/app.ts explain this"), so they stay in the text the agent gets
    let text = [unknown, parsed.text].filter(Boolean).join(' ')
    if (!parsed.resolved.length) {
      // no team/agent addressed: send the raw text to the selection
      text = raw
      ids = selectedAgentIds(ws, useStore.getState().selection)
      if (!ids.length) {
        flash(
          parsed.unknown.length ? `unknown ${unknown} — select agents or @ a team` : 'type @ to pick a team or agent',
          'warn',
        )
        return
      }
    } else if (!ids.length) {
      // the user addressed a team explicitly; never fall back to the selection
      flash(`${parsed.resolved.map((r) => `@${r}`).join(' ')} has no agents`, 'warn')
      return
    }
    if (parsed.resolved.length && !parsed.text) {
      flash('nothing to send — add a message after the mention', 'warn')
      return
    }
    const n = sendToAgents(ids, text)
    if (!n) {
      flash('no live agents', 'warn')
      return
    }
    flash(`sent to ${plural(n, 'agent')}`)
    setValue('')
    setCaret(0)
  }

  // ---- voice -------------------------------------------------------------
  const stopVoice = useCallback(() => {
    recRef.current?.stop()
  }, [])

  const startVoice = useCallback(() => {
    const Ctor = speechCtor()
    if (!Ctor) {
      flash(NO_VOICE, 'warn', 6000)
      return
    }
    if (recRef.current) return
    let rec: Recognizer
    try {
      rec = new Ctor()
    } catch {
      flash(NO_VOICE, 'warn', 6000)
      return
    }
    const base = inputRef.current?.value ?? ''
    voiceBase.current = base && !/\s$/.test(base) ? `${base} ` : base
    voiceFinal.current = ''
    discardVoice.current = false
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) voiceFinal.current += r[0].transcript
        else interim += r[0].transcript
      }
      setValue(voiceBase.current + voiceFinal.current + interim)
    }
    rec.onerror = (e) => {
      // 'no-speech' / 'aborted' are routine; anything else is worth saying
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
        flash('microphone permission denied', 'warn')
      else if (e.error !== 'no-speech' && e.error !== 'aborted') flash(`voice error: ${e.error}`, 'warn')
    }
    rec.onend = () => {
      recRef.current = null
      setListening(false)
      if (discardVoice.current) {
        discardVoice.current = false
        return
      }
      // keep only the final transcript so the user can edit it, then Enter
      const text = (voiceBase.current + voiceFinal.current).replace(/\s+$/, '')
      setValue(text)
      setCaret(text.length)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(text.length, text.length)
      })
    }
    try {
      rec.start()
    } catch {
      flash('could not start voice input', 'warn')
      return
    }
    recRef.current = rec
    setListening(true)
  }, [flash])

  const toggleVoice = () => {
    if (!hasVoice) {
      flash(NO_VOICE, 'warn', 6000)
      return
    }
    if (listening) stopVoice()
    else startVoice()
  }

  // a key released anywhere (focus may have moved) still ends a space-hold
  useEffect(() => {
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (holdPending.current) {
        holdPending.current = false
        window.clearTimeout(holdTimer.current)
        // short tap: type the space we held back
        const el = inputRef.current
        if (el && document.activeElement === el) {
          const s = el.selectionStart ?? el.value.length
          const t = el.selectionEnd ?? s
          const next = el.value.slice(0, s) + ' ' + el.value.slice(t)
          setValue(next)
          setCaret(s + 1)
          requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1))
        }
      } else if (recRef.current) {
        stopVoice()
      }
    }
    window.addEventListener('keyup', onUp)
    return () => window.removeEventListener('keyup', onUp)
  }, [stopVoice])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // keep canvas shortcuts (Delete, Escape, \ …) from seeing keys typed here
    e.stopPropagation()

    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (holdPending.current || recRef.current) {
        e.preventDefault() // swallow auto-repeat while holding to speak
        return
      }
      if (!e.repeat && value === '') {
        e.preventDefault()
        holdPending.current = true
        holdTimer.current = window.setTimeout(() => {
          holdPending.current = false
          if (hasVoice) startVoice()
          else flash(NO_VOICE, 'warn', 6000)
        }, HOLD_MS)
        return
      }
    }

    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setPick((p) => (p + d + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
        e.preventDefault()
        complete(suggestions[Math.min(pick, suggestions.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopupClosed(true)
        return
      }
    }

    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (recRef.current) {
        discardVoice.current = true
        recRef.current.abort()
      }
      submit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (recRef.current) {
        discardVoice.current = true
        recRef.current.abort()
      }
      inputRef.current?.blur()
    }
  }

  // ---- chip actions --------------------------------------------------------
  const newConsole = () => {
    const store = useStore.getState()
    const w = worldCenter()
    const id = store.spawnWidget('agent', w.x, w.y)
    store.setSelection([id])
    store.setActiveWidget(id)
    flash('new console')
  }

  const group = () => {
    const id = groupSelectionAsTeam()
    if (!id) {
      flash('select agents to group', 'warn')
      return
    }
    const frame = useStore
      .getState()
      .active()
      ?.elements.find((e) => e.id === id)
    flash(frame && frame.type === 'frame' ? `grouped as ${frame.title}` : 'grouped')
  }

  const presets = () => {
    const w = worldCenter()
    const id = spawnTeam(w.x, w.y)
    if (!id) {
      flash('could not spawn a team', 'warn')
      return
    }
    const frame = useStore
      .getState()
      .active()
      ?.elements.find((e) => e.id === id)
    flash(frame && frame.type === 'frame' ? `spawned ${frame.title}` : 'spawned team')
  }

  const pauseAll = () => {
    const n = pauseAgents()
    flash(n ? `paused ${plural(n, 'agent')}` : 'no live agents', n ? 'ok' : 'warn')
  }

  const resumeAll = () => {
    const n = resumeAgents()
    flash(n ? `resumed ${plural(n, 'agent')}` : 'nothing paused', n ? 'ok' : 'warn')
  }

  const toggleMemory = () => {
    const store = useStore.getState()
    store.setOpenPanel(store.openPanel === 'memory' ? null : 'memory')
  }

  const dismissHint = () => {
    setHintDismissed(true)
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      /* storage unavailable */
    }
  }

  const tryHint = () => {
    const text = '@team-a run the tests'
    setValue(text)
    setCaret(text.length)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(text.length, text.length)
    })
  }

  if (presenting) return null

  const showPopup = suggestions.length > 0

  return (
    <div className={`cmdbar${openPanel ? ' cmdbar--panel' : ''}`} onKeyDown={(e) => e.stopPropagation()}>
      {!hintDismissed && (
        <div className="cmdbar__hint">
          <button className="cmdbar__hint-text" onClick={tryHint} title="Fill the input with this example">
            Try <span className="cmdbar__hint-code">"@team-a run the tests"</span>
          </button>
          <button className="cmdbar__hint-x" onClick={dismissHint} title="Dismiss" aria-label="Dismiss hint">
            <IconClose size={10} />
          </button>
        </div>
      )}

      {status && (
        <div className={`cmdbar__status cmdbar__status--${status.tone}`} role="status">
          {status.text}
        </div>
      )}

      <div className="cmdbar__chips">
        <button className="cmdbar__chip" onClick={newConsole} title="New Claude agent at the centre of the view">
          New console
        </button>
        <button
          className="cmdbar__chip"
          onClick={group}
          disabled={!hasSelectedAgent}
          title={hasSelectedAgent ? 'Wrap the selected agents in a team frame' : 'Select one or more agents to group them'}
        >
          Group
        </button>
        <button className="cmdbar__chip" onClick={presets} title="Spawn a 4-agent team (lead, 2 builders, reviewer)">
          Presets
        </button>
        <button className="cmdbar__chip" onClick={pauseAll} title="Interrupt every working agent (Esc)">
          Pause all
        </button>
        <button className="cmdbar__chip" onClick={resumeAll} title="Tell paused agents to continue">
          Resume all
        </button>
        <button
          className={`cmdbar__chip${openPanel === 'memory' ? ' cmdbar__chip--on' : ''}`}
          onClick={toggleMemory}
          title="Toggle the memory panel"
        >
          Memory
        </button>
      </div>

      <div className="cmdbar__field-wrap">
        {showPopup && (
          <ul className="cmdbar__popup" role="listbox">
            {suggestions.map((t, i) => (
              <li
                key={`${t.kind}:${t.name}:${t.ids[0] ?? i}`}
                role="option"
                aria-selected={i === pick}
                className={`cmdbar__opt${i === pick ? ' cmdbar__opt--on' : ''}`}
                // mousedown, not click: keep focus (and the caret) in the input
                onMouseDown={(e) => {
                  e.preventDefault()
                  complete(t)
                }}
                onMouseEnter={() => setPick(i)}
              >
                <span className={`cmdbar__opt-kind cmdbar__opt-kind--${t.kind}`}>{t.kind}</span>
                <span className="cmdbar__opt-name">@{slug(t.name)}</span>
                {t.kind === 'team' && (
                  <span className="cmdbar__opt-count">{plural(t.ids.length, 'agent')}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className={`cmdbar__field${focused ? ' cmdbar__field--focus' : ''}`}>
          <button
            className={`cmdbar__orb${listening ? ' cmdbar__orb--live' : ''}${hasVoice ? '' : ' cmdbar__orb--off'}`}
            onClick={toggleVoice}
            title={hasVoice ? (listening ? 'Listening… click to stop' : 'Hold space (or click) to speak') : NO_VOICE}
            aria-label="Voice input"
          />
          <input
            ref={inputRef}
            className="cmdbar__input"
            value={value}
            placeholder={listening ? 'Listening…' : 'Hold space to speak · @ to direct…'}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setPopupClosed(false)
            }}
            onSelect={syncCaret}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true)
              syncCaret()
            }}
            onBlur={() => {
              setFocused(false)
              setPopupClosed(false)
            }}
          />
          <button
            className={`cmdbar__mic${listening ? ' cmdbar__mic--live' : ''}`}
            onClick={toggleVoice}
            title={hasVoice ? (listening ? 'Stop listening' : 'Speak') : NO_VOICE}
            aria-label={listening ? 'Stop voice input' : 'Start voice input'}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
              <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
            </svg>
          </button>
        </div>
      </div>

    </div>
  )
}
