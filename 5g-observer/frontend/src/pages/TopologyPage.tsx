import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import TopologyCanvas from '@/components/Topology/TopologyCanvas'
import SidePanel from '@/components/Topology/SidePanel'
import { TopologySkeleton } from '@/components/common/LoadingSkeleton'
import { useToast } from '@/components/common/Toast'
import { IconRefresh } from '@/components/common/icons'
import { api } from '@/services/api'
import { useTopology } from '@/hooks/useTopology'
import type { TopologyNode, TopologyEdge } from '@/types/topology'

// ─── Collapsible terminal panel ───────────────────────────────────────────────

function TerminalPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div
      className="shrink-0 border-t"
      style={{ borderColor: '#30363d', background: '#0d1117' }}
    >
      {/* Terminal header bar */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left"
        style={{ color: '#8b949e', background: '#161b22', borderBottom: open ? '1px solid #30363d' : 'none' }}
      >
        <span style={{ color: '#3fb950' }}>▶</span>
        <span className="font-mono">Terminal</span>
        <span className="ml-auto">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div
          className="flex items-center justify-center font-mono text-xs"
          style={{ height: 180, color: '#8b949e', background: '#0d1117' }}
        >
          <span>
            xterm.js terminal — install{' '}
            <code className="px-1 rounded" style={{ background: '#161b22', color: '#58a6ff' }}>
              xterm
            </code>{' '}
            to enable
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const [namespace, setNamespace]     = useState('free5gc')
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null)
  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  const [termOpen, setTermOpen]       = useState(false)
  const { push } = useToast()

  const { data: graph, isLoading, isError, refetch } = useTopology(namespace)

  const { data: namespaces = ['free5gc'] } = useQuery({
    queryKey: ['namespaces'],
    queryFn: api.topology.namespaces,
    staleTime: 60_000,
  })

  const handleNodeClick = useCallback((node: TopologyNode) => {
    setSelectedNode(node)
    setSidePanelOpen(true)
  }, [])

  const handleEdgeClick = useCallback((edge: TopologyEdge, sourceNode: TopologyNode) => {
    push('info', `${edge.label || edge.interface}: ${sourceNode.displayName} → capture coming soon`)
  }, [push])

  const handleClosePanel = useCallback(() => {
    setSidePanelOpen(false)
    setSelectedNode(null)
  }, [])

  const liveIndicator = !isLoading && !isError && !!graph


  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid #30363d', background: '#161b22' }}
      >
        <span className="text-xs shrink-0" style={{ color: '#8b949e' }}>Namespace</span>
        <select
          value={namespace}
          onChange={e => setNamespace(e.target.value)}
          className="rounded px-2 py-1 text-sm outline-none"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}
        >
          {namespaces.map(ns => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

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
              selectedNodeId={selectedNode?.id}
              namespace={namespace}
            />
          )}
        </div>

        {/* Side panel */}
        {sidePanelOpen && selectedNode && graph && (
          <div
            className="w-[440px] shrink-0 h-full"
            style={{ borderLeft: '1px solid #30363d' }}
          >
            <SidePanel
              node={selectedNode}
              allNodes={graph.nodes}
              onClose={handleClosePanel}
            />
          </div>
        )}
      </div>

      {/* Collapsible terminal panel */}
      <TerminalPanel open={termOpen} onToggle={() => setTermOpen(v => !v)} />
    </div>
  )
}
