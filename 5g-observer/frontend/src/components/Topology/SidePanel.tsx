import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { useLogs, type LogLevel } from '@/hooks/useLogs'
import { IconX, IconChevronDown } from '@/components/common/icons'
import type { TopologyNode } from '@/types/topology'

// ─── Types ────────────────────────────────────────────────────────────────────
interface NfTab {
  node: TopologyNode
}

interface Props {
  node: TopologyNode
  allNodes: TopologyNode[]
  onClose: () => void
  onCaptureEdge?: (nodeId: string, iface: string) => void
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ node }: { node: TopologyNode }) {
  const { condition, restarts } = node.status
  const color =
    condition === 'Running' && restarts === 0
      ? 'bg-green-500'
      : condition === 'Running' && restarts > 0 && restarts <= 3
        ? 'bg-yellow-400'
        : condition === 'Running' && restarts > 3
          ? 'bg-orange-400'
          : condition === 'CrashLoopBackOff' || condition === 'Error' || condition === 'OOMKilled'
            ? 'bg-red-500'
            : 'bg-gray-500'

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={clsx('w-2 h-2 rounded-full inline-block', color)} />
      <span className="text-slate-300">{condition}</span>
      {restarts > 0 && (
        <span className="text-yellow-400 font-mono">{restarts}↺</span>
      )}
    </span>
  )
}

// ─── Log line rendering ───────────────────────────────────────────────────────

const FREE5GC_LOG_RE = /^(\S+Z)\s+\[(\w+)\]\[(\w+)\]\[(\w+)\]\s+(.*)$/

const LOG_LEVEL_COLORS: Record<string, string> = {
  INFO: '#56b6c2', DEBU: '#abb2bf', TRAC: '#5c6370', WARN: '#e5c07b', ERRO: '#e06c75', FATAL: '#c678dd',
}

function cleanRaw(raw: string): string {
  // Strip ANSI codes first
  let s = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '')
  // Only strip Loki prefix when the line has two timestamps (Loki prefix + raw log timestamp)
  if (/^\S+Z\s+\d{4}-\d{2}-\d{2}T/.test(s)) {
    s = s.replace(/^\S+Z\s+/, '')
  }
  return s.trim()
}

function renderMessage(msg: string) {
  const parts = [] as Array<string | React.JSX.Element>
  const re = /(\w+)(=)(\S*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(msg)) !== null) {
    if (m.index > last) parts.push(msg.slice(last, m.index))
    parts.push(<span key={`k${m.index}`} style={{ color: '#61afef' }}>{m[1]}</span>)
    parts.push(<span key={`eq${m.index}`} style={{ color: '#abb2bf' }}>=</span>)
    parts.push(<span key={`v${m.index}`} style={{ color: '#98c379' }}>{m[3]}</span>)
    last = m.index + m[0].length
  }
  if (last < msg.length) parts.push(msg.slice(last))
  return <>{parts}</>
}

function renderLogLine(raw: string) {
  const clean = cleanRaw(raw)
  const m = FREE5GC_LOG_RE.exec(clean)
  if (!m) return <span style={{ color: '#abb2bf' }}>{clean}</span>
  const [, ts, level, component, subsystem, message] = m
  const lc = LOG_LEVEL_COLORS[level] ?? '#abb2bf'
  return (
    <>
      <span style={{ color: '#56b6c2' }}>{ts.slice(11, 23)}</span>
      {' '}
      <span style={{ color: lc }}>[{level}]</span>
      <span style={{ color: '#abb2bf' }}>[{component}]</span>
      <span style={{ color: '#abb2bf' }}>[{subsystem}]</span>
      {' '}
      {renderMessage(message)}
    </>
  )
}

// ─── Single NF log column ─────────────────────────────────────────────────────
function NfLogColumn({
  node,
  onRemove,
}: {
  node: TopologyNode
  onRemove: () => void
}) {
  const logs = useLogs(node.namespace, node.podName, true)
  const parentRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<LogLevel>('all')

  const filtered = useMemo(() => {
    let lines = logs.lines
    if (level !== 'all') {
      lines = lines.filter(l => l.level === level || l.level === 'unknown')
    }
    if (search) {
      const s = search.toLowerCase()
      lines = lines.filter(l => l.raw.toLowerCase().includes(s))
    }
    return lines
  }, [logs.lines, level, search])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  })

  // Auto-scroll to bottom
  useEffect(() => {
    if (logs.autoScroll && filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
    }
  }, [filtered.length, logs.autoScroll, virtualizer])

  return (
    <div className="flex flex-col flex-1 min-w-0 border-r border-border last:border-0">
      {/* Column header */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-bg-secondary border-b border-border shrink-0">
        <span className="text-xs font-mono font-semibold text-blue-400 flex-1 truncate">
          {node.displayName} <span className="text-slate-500">·</span>{' '}
          <span className="text-slate-400 font-normal">{node.podName}</span>
        </span>
        <button
          onClick={onRemove}
          className="text-slate-600 hover:text-slate-300 shrink-0"
        >
          <IconX className="w-3 h-3" />
        </button>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-1 px-1.5 py-1 bg-bg-tertiary border-b border-border shrink-0">
        <input
          type="text"
          placeholder="filter…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-xs text-slate-300 placeholder-slate-600
                     outline-none border border-transparent focus:border-blue-600/50 rounded px-1 py-0.5"
        />
        <select
          value={level}
          onChange={e => setLevel(e.target.value as LogLevel)}
          className="text-xs bg-bg-secondary text-slate-400 border border-border rounded px-1 py-0.5 outline-none"
        >
          <option value="all">all</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
      </div>

      {/* Log lines */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto overflow-x-auto"
        style={{ background: '#0d1117', fontFamily: '"JetBrains Mono", "Cascadia Code", monospace', fontSize: 12 }}
        onMouseEnter={() => logs.setAutoScroll(false)}
        onMouseLeave={() => logs.setAutoScroll(true)}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => {
            const line = filtered[item.index]!
            return (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: item.start,
                  minWidth: '100%',
                  height: item.size,
                  lineHeight: 1.4,
                  padding: '2px 4px',
                  whiteSpace: 'nowrap',
                }}
              >
                {renderLogLine(line.raw)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Pod info section ─────────────────────────────────────────────────────────
function PodInfo({ node }: { node: TopologyNode }) {
  return (
    <div className="px-4 py-3 space-y-2 shrink-0 border-b border-border">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-base font-bold text-blue-400">{node.displayName}</span>
          <span className="text-slate-500 text-xs ml-2">{node.podName}</span>
        </div>
        <StatusBadge node={node} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-slate-500">Node</span>
          <span className="text-slate-300 ml-2 font-mono">{node.nodeName || '—'}</span>
        </div>
        <div>
          <span className="text-slate-500">Age</span>
          <span className="text-slate-300 ml-2">{node.age}</span>
        </div>
        <div className="col-span-2">
          <span className="text-slate-500">Image</span>
          <span className="text-slate-400 ml-2 font-mono text-[10px] break-all">{node.image}</span>
        </div>
      </div>

      {/* Interfaces */}
      <div className="space-y-0.5">
        {node.interfaces.map(iface => (
          <div key={iface.name} className="flex items-center gap-2 text-xs font-mono">
            <span
              className={clsx(
                'w-10 text-right shrink-0',
                iface.isDefault ? 'text-blue-400' : 'text-green-400',
              )}
            >
              {iface.interface}
            </span>
            <span className="text-slate-400">{iface.ips.join(', ') || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main SidePanel ───────────────────────────────────────────────────────────
export default function SidePanel({ node, allNodes, onClose, onCaptureEdge: _onCaptureEdge }: Props) {
  const [view, setView] = useState<'logs' | 'info'>('logs')
  const [tabs, setTabs] = useState<NfTab[]>([{ node }])
  const [addOpen, setAddOpen] = useState(false)

  // When primary node changes, reset tabs
  useEffect(() => {
    setTabs([{ node }])
  }, [node.id, node])

  const addNf = useCallback((n: TopologyNode) => {
    if (tabs.length >= 4) return
    if (tabs.some(t => t.node.id === n.id)) return
    setTabs(prev => [...prev, { node: n }])
    setAddOpen(false)
  }, [tabs])

  const removeNf = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.node.id !== id)
      return next.length > 0 ? next : prev
    })
  }, [])

  // Available NFs to add (not already in tabs)
  const available = useMemo(
    () => allNodes.filter(n => !tabs.some(t => t.node.id === n.id)),
    [allNodes, tabs],
  )

  return (
    <div className="flex flex-col h-full bg-bg-card border-l border-border animate-slide-in-right">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-sm font-semibold text-slate-200 flex-1">NF Detail</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('logs')}
            className={clsx('text-xs px-2 py-0.5 rounded', view === 'logs' ? 'bg-blue-600/20 text-blue-400' : 'text-slate-500 hover:text-slate-300')}
          >
            Logs
          </button>
          <button
            onClick={() => setView('info')}
            className={clsx('text-xs px-2 py-0.5 rounded', view === 'info' ? 'bg-blue-600/20 text-blue-400' : 'text-slate-500 hover:text-slate-300')}
          >
            Info
          </button>
        </div>
        <button onClick={onClose} className="text-slate-600 hover:text-slate-300">
          <IconX className="w-4 h-4" />
        </button>
      </div>

      {/* Pod info */}
      <PodInfo node={node} />

      {view === 'info' ? (
        /* Extended info view */
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
          <div>
            <div className="label mb-1">Labels</div>
            {Object.entries(node.labels).map(([k, v]) => (
              <div key={k} className="font-mono text-slate-400">
                <span className="text-blue-400">{k}</span>
                <span className="text-slate-600">=</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Logs view: multi-NF column layout */
        <div className="flex flex-col flex-1 min-h-0">
          {/* NF tabs bar */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-bg-tertiary shrink-0 overflow-x-auto">
            <span className="text-[10px] text-slate-600 shrink-0 mr-1">NF:</span>
            {tabs.map(t => (
              <span
                key={t.node.id}
                className={clsx(
                  'flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border',
                  t.node.id === node.id
                    ? 'border-blue-600/50 text-blue-400 bg-blue-600/10'
                    : 'border-border text-slate-400',
                )}
              >
                {t.node.displayName}
              </span>
            ))}

            {/* Add NF button */}
            {available.length > 0 && tabs.length < 4 && (
              <div className="relative">
                <button
                  onClick={() => setAddOpen(v => !v)}
                  className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400"
                >
                  + <IconChevronDown className="w-2.5 h-2.5" />
                </button>
                {addOpen && (
                  <div className="absolute top-full left-0 mt-1 z-30 bg-bg-secondary border border-border rounded shadow-xl min-w-max">
                    {available.map(n => (
                      <button
                        key={n.id}
                        onClick={() => addNf(n)}
                        className="block w-full text-left px-3 py-1.5 text-xs font-mono text-slate-300 hover:bg-bg-hover"
                      >
                        <span className="text-blue-400">{n.displayName}</span>{' '}
                        <span className="text-slate-500">{n.podName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Log columns */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {tabs.map(t => (
              <NfLogColumn
                key={t.node.id}
                node={t.node}
                onRemove={() => removeNf(t.node.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
