import { useCallback, useEffect, useReducer, useRef } from 'react'
import { WSManager } from '@/services/websocket'

export interface LogLine {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'unknown'
  message: string
  raw: string
}

export type LogLevel = 'all' | 'info' | 'warn' | 'error' | 'debug'

const MAX_LINES = 2_000

function parseLevel(raw: string): LogLine['level'] {
  const l = raw.toLowerCase()
  if (l.includes('"level":"error"') || l.includes('level=error') || l.includes(' ERROR ')) return 'error'
  if (l.includes('"level":"warn"') || l.includes('level=warn') || l.includes(' WARN ')) return 'warn'
  if (l.includes('"level":"debug"') || l.includes('level=debug') || l.includes(' DEBUG ')) return 'debug'
  if (l.includes('"level":"info"') || l.includes('level=info') || l.includes(' INFO ')) return 'info'
  return 'unknown'
}

function parseTimestamp(raw: string): string {
  // Try JSON log
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const t = obj.time ?? obj.timestamp ?? obj.ts ?? obj['@timestamp']
    if (typeof t === 'string') return t
    if (typeof t === 'number') return new Date(t * 1000).toISOString()
  } catch {}
  // Try syslog prefix: "2006-01-02T15:04:05Z ..."
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?\+?\d*)/)
  if (m) return m[1]
  return new Date().toISOString()
}

interface LogState {
  lines: LogLine[]
  search: string
  level: LogLevel
  autoScroll: boolean
  showTimestamps: boolean
}

type Action =
  | { type: 'APPEND'; lines: LogLine[] }
  | { type: 'CLEAR' }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_LEVEL'; level: LogLevel }
  | { type: 'SET_AUTO_SCROLL'; value: boolean }
  | { type: 'TOGGLE_TIMESTAMPS' }

function reducer(state: LogState, action: Action): LogState {
  switch (action.type) {
    case 'APPEND': {
      const merged = [...state.lines, ...action.lines]
      return { ...state, lines: merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged }
    }
    case 'CLEAR':
      return { ...state, lines: [] }
    case 'SET_SEARCH':
      return { ...state, search: action.search }
    case 'SET_LEVEL':
      return { ...state, level: action.level }
    case 'SET_AUTO_SCROLL':
      return { ...state, autoScroll: action.value }
    case 'TOGGLE_TIMESTAMPS':
      return { ...state, showTimestamps: !state.showTimestamps }
    default:
      return state
  }
}

const initial: LogState = {
  lines: [],
  search: '',
  level: 'all',
  autoScroll: true,
  showTimestamps: true,
}

export function useLogs(namespace: string, podName: string, enabled = true) {
  const [state, dispatch] = useReducer(reducer, initial)
  const mgrRef = useRef<WSManager | null>(null)

  useEffect(() => {
    if (!enabled || !namespace || !podName) return
    dispatch({ type: 'CLEAR' })

    const url = `/ws/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(podName)}`
    const mgr = new WSManager(url)
    mgrRef.current = mgr

    mgr.on<string | string[]>('*', (raw) => {
      const lines = Array.isArray(raw) ? raw : [String(raw)]
      const parsed: LogLine[] = lines.map(r => ({
        timestamp: parseTimestamp(r),
        level: parseLevel(r),
        message: r,
        raw: r,
      }))
      dispatch({ type: 'APPEND', lines: parsed })
    })

    mgr.connect()
    return () => {
      mgr.close()
      mgrRef.current = null
    }
  }, [namespace, podName, enabled])

  const getFiltered = useCallback((): LogLine[] => {
    let lines = state.lines
    if (state.level !== 'all') {
      lines = lines.filter(l => l.level === state.level || l.level === 'unknown')
    }
    if (state.search) {
      const s = state.search.toLowerCase()
      lines = lines.filter(l => l.raw.toLowerCase().includes(s))
    }
    return lines
  }, [state.lines, state.level, state.search])

  return {
    lines: state.lines,
    getFiltered,
    search: state.search,
    level: state.level,
    autoScroll: state.autoScroll,
    showTimestamps: state.showTimestamps,
    setSearch: (s: string) => dispatch({ type: 'SET_SEARCH', search: s }),
    setLevel: (l: LogLevel) => dispatch({ type: 'SET_LEVEL', level: l }),
    setAutoScroll: (v: boolean) => dispatch({ type: 'SET_AUTO_SCROLL', value: v }),
    toggleTimestamps: () => dispatch({ type: 'TOGGLE_TIMESTAMPS' }),
    clear: () => dispatch({ type: 'CLEAR' }),
  }
}
