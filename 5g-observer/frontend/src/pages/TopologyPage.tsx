import { useState, useCallback, useRef, useEffect } from 'react'
import TopologyCanvas from '@/components/Topology/TopologyCanvas'
import SidePanel from '@/components/Topology/SidePanel'
import TerminalPanel from '@/components/Terminal/TerminalPanel'
import { TopologySkeleton } from '@/components/common/LoadingSkeleton'
import { useToast } from '@/components/common/Toast'
import { IconRefresh } from '@/components/common/icons'
import { useTopology } from '@/hooks/useTopology'
import type { TopologyNode, TopologyEdge } from '@/types/topology'

// multi-namespace support planned for v0.2
const namespace = 'free5gc'

interface NfTab {
  id: string
  node: TopologyNode
  view: 'logs' | 'info'
}

const SIDE_MIN = 400
const SIDE_MAX = 1600
const SIDE_DEFAULT = 800
const TERM_MIN = 150
const TERM_MAX = 500
const TERM_DEFAULT = 200

// Clear any previously-cached zero/invalid values so stale bad data doesn't persist.
;['5g-observer-sidepanel-width', '5g-observer-terminal-height'].forEach(k => {
  const raw = localStorage.getItem(k)
  if (raw !== null && (Number(raw) <= 0 || isNaN(Number(raw)))) localStorage.removeItem(k)
})

function getSaved(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return def
    const v = Number(raw)
    return (isNaN(v) || v <= 0) ? def : v
  } catch { return def }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const [nfTabs, setNfTabs] = useState<NfTab[]>([])
  const [activeNfTabId, setActiveNfTabId] = useState<string | null>(null)
  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  const [termOpen, setTermOpen]       = useState(true)
  const [sideWidth,   setSideWidth]   = useState(() => getSaved('5g-observer-sidepanel-width', SIDE_DEFAULT))
  const [termHeight,  setTermHeight]  = useState(() => getSaved('5g-observer-terminal-height', TERM_DEFAULT))
  const { push } = useToast()

  // ── Side panel drag ────────────────────────────────────────────────────────
  // DOM-direct updates during drag — setSideWidth called once on mouseup only.
  const sideCurrentWidthRef   = useRef(getSaved('5g-observer-sidepanel-width', SIDE_DEFAULT))
  const sidePanelContainerRef = useRef<HTMLDivElement>(null)
  const sideDragStart         = useRef<{ x: number; w: number } | null>(null)

  // Keep ref in sync when state changes externally (e.g. node click sets 800px)
  useEffect(() => { sideCurrentWidthRef.current = sideWidth }, [sideWidth])

  const onSideMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sideDragStart.current = { x: e.clientX, w: sideCurrentWidthRef.current }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sideDragStart.current) return
      const delta = sideDragStart.current.x - e.clientX   // dragging left handle: move left → wider
      const next  = Math.min(SIDE_MAX, Math.max(SIDE_MIN, sideDragStart.current.w + delta))
      sideCurrentWidthRef.current = next
      if (sidePanelContainerRef.current) sidePanelContainerRef.current.style.width = next + 'px'
    }
    const onUp = () => {
      if (!sideDragStart.current) return
      const w = sideCurrentWidthRef.current
      try { localStorage.setItem('5g-observer-sidepanel-width', String(w)) } catch { /* ok */ }
      sideDragStart.current = null
      setSideWidth(w)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // ── Terminal panel drag ────────────────────────────────────────────────────
  // termCurrentHeightRef tracks the live drag height without triggering re-renders.
  // setTermHeight is called exactly once on mouseup to sync React state.
  const termCurrentHeightRef = useRef(getSaved('5g-observer-terminal-height', TERM_DEFAULT))
  const terminalBodyRef      = useRef<HTMLDivElement>(null)
  const termDragStart        = useRef<{ y: number; h: number } | null>(null)

  const onTermMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    termDragStart.current = { y: e.clientY, h: termCurrentHeightRef.current }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!termDragStart.current) return
      const delta = termDragStart.current.y - e.clientY   // drag up → taller
      const next  = Math.min(TERM_MAX, Math.max(TERM_MIN, termDragStart.current.h + delta))
      termCurrentHeightRef.current = next
      if (terminalBodyRef.current) terminalBodyRef.current.style.height = next + 'px'
    }
    const onUp = () => {
      if (!termDragStart.current) return
      const h = termCurrentHeightRef.current
      try { localStorage.setItem('5g-observer-terminal-height', String(h)) } catch { /* ok */ }
      termDragStart.current = null
      setTermHeight(h)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const { data: graph, isLoading, isError, refetch } = useTopology(namespace)

  const handleNodeClick = useCallback((clickedNode: TopologyNode) => {
    const existing = nfTabs.find(t => t.id === clickedNode.id)
    if (existing) {
      setActiveNfTabId(clickedNode.id)
    } else {
      setNfTabs(prev => [...prev, { id: clickedNode.id, node: clickedNode, view: 'logs' }])
      setActiveNfTabId(clickedNode.id)
      setSidePanelOpen(true)
      setSideWidth(800)
    }
  }, [nfTabs])

  const handleTabClose = useCallback((closedId: string) => {
    const remaining = nfTabs.filter(t => t.id !== closedId)
    setNfTabs(remaining)
    if (remaining.length === 0) {
      setSidePanelOpen(false)
      setActiveNfTabId(null)
    } else if (activeNfTabId === closedId) {
      setActiveNfTabId(remaining[remaining.length - 1].id)
    }
  }, [nfTabs, activeNfTabId])

  const handleEdgeClick = useCallback((edge: TopologyEdge, sourceNode: TopologyNode) => {
    push('info', `${edge.label || edge.interface}: ${sourceNode.displayName} → capture coming soon`)
  }, [push])

  const handleClosePanel = useCallback(() => {
    setSidePanelOpen(false)
    setNfTabs([])
    setActiveNfTabId(null)
  }, [])

  const activeNode = nfTabs.find(t => t.id === activeNfTabId)?.node ?? null

  const liveIndicator = !isLoading && !isError && !!graph


  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid #30363d', background: '#161b22' }}
      >
        <span className="text-xs shrink-0" style={{ color: '#8b949e' }}>Namespace</span>
        <span
          className="rounded px-2 py-1 text-sm font-mono"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}
        >
          {namespace}
        </span>

        <div className="flex-1" />

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${liveIndicator ? 'animate-pulse' : ''}`}
            style={{ background: liveIndicator ? '#3fb950' : '#30363d' }}
          />
          <span style={{ color: '#8b949e' }}>{liveIndicator ? 'live' : 'loading'}</span>
        </div>

        <button
          onClick={() => refetch()}
          className="p-1.5 rounded"
          style={{ border: '1px solid #30363d', background: '#0d1117', color: '#8b949e' }}
          title="Refresh"
        >
          <IconRefresh className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Canvas */}
        <div className="flex-1 min-w-0 relative">
          {isLoading ? (
            <TopologySkeleton />
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: '#8b949e' }}>
              <span style={{ color: '#f85149' }}>Failed to load topology</span>
              <button
                onClick={() => refetch()}
                className="px-3 py-1 rounded text-xs"
                style={{ border: '1px solid #30363d', background: '#161b22', color: '#e6edf3' }}
              >
                Retry
              </button>
            </div>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: '#8b949e' }}>
              <span className="text-4xl opacity-30">⬡</span>
              <span>No NFs found in <strong style={{ color: '#e6edf3' }}>{namespace}</strong></span>
              <span className="text-xs">Waiting for pods to come online…</span>
            </div>
          ) : (
            <TopologyCanvas
              graph={graph}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              selectedNodeId={activeNfTabId ?? undefined}
              namespace={namespace}
              sidePanelOpen={sidePanelOpen}
            />
          )}
        </div>

        {/* Side panel with drag handle — always visible when graph is loaded */}
        {sidePanelOpen && graph && (
          <div
            ref={sidePanelContainerRef}
            className="shrink-0 h-full flex"
            style={{ width: sideWidth, borderLeft: '1px solid #30363d' }}
          >
            {/* Drag handle — left border */}
            <div
              onMouseDown={onSideMouseDown}
              className="w-1 shrink-0 cursor-ew-resize transition-colors"
              style={{ background: '#30363d' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
            />
            <div className="flex-1 min-w-0 h-full overflow-hidden">
              {activeNode ? (
                <SidePanel
                  node={activeNode}
                  allNodes={graph.nodes}
                  onClose={handleClosePanel}
                  tabs={nfTabs}
                  activeTabId={activeNfTabId}
                  onTabSelect={(id) => setActiveNfTabId(id)}
                  onTabClose={handleTabClose}
                />
              ) : (
                <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
                  <div className="flex items-center gap-2 px-3 py-2 shrink-0"
                    style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
                    <span className="text-sm font-semibold flex-1" style={{ color: '#e6edf3' }}>NF Detail</span>
                    <div className="flex items-center gap-1">
                      <span className="text-xs px-2 py-0.5 rounded"
                        style={{ color: '#58a6ff', background: 'rgba(31,111,235,0.12)' }}>Logs</span>
                      <span className="text-xs px-2 py-0.5 rounded" style={{ color: '#6e7681' }}>Info</span>
                    </div>
                  </div>
                  <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: '#6e7681' }}>
                    <span className="text-3xl opacity-20">◫</span>
                    <span className="text-xs text-center px-4">Select an NF to view logs</span>
                    <span className="text-[10px] text-center px-6" style={{ color: '#30363d' }}>
                      Click a node in the topology canvas
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Collapsible terminal panel with drag handle */}
      <div className="shrink-0">
        {termOpen && (
          <div
            onMouseDown={onTermMouseDown}
            className="w-full cursor-ns-resize transition-colors"
            style={{ height: 4, background: '#30363d' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
          />
        )}
        <TerminalPanel
          open={termOpen}
          onToggle={() => setTermOpen(v => !v)}
          height={termHeight}
          bodyRef={terminalBodyRef}
        />
      </div>
    </div>
  )
}
