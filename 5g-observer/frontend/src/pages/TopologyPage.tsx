import { useState, useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import TopologyCanvas from '@/components/Topology/TopologyCanvas'
import SidePanel from '@/components/Topology/SidePanel'
import { TopologySkeleton } from '@/components/common/LoadingSkeleton'
import { useToast } from '@/components/common/Toast'
import { IconRefresh } from '@/components/common/icons'
import { api } from '@/services/api'
import { useTopology } from '@/hooks/useTopology'
import type { TopologyNode, TopologyEdge } from '@/types/topology'

export default function TopologyPage() {
  const [namespace, setNamespace] = useState('free5gc')
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null)
  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  const { push } = useToast()

  const { data: graph, isLoading, isError, refetch } = useTopology(namespace)

  // Available namespaces
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
    // Edge click → could open capture; for now show toast
    push('info', `${edge.interface}: ${sourceNode.nfType} → click to capture (coming soon)`)
  }, [push])

  const handleClosePanel = useCallback(() => {
    setSidePanelOpen(false)
    setSelectedNode(null)
  }, [])

  const liveIndicator = !isLoading && !isError && graph

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-xs text-slate-500 shrink-0">Namespace</span>
        <select
          value={namespace}
          onChange={e => setNamespace(e.target.value)}
          className="bg-bg-card border border-border rounded px-2 py-1 text-sm text-slate-300 outline-none"
        >
          {namespaces.map(ns => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

        <div className="flex-1" />

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`w-2 h-2 rounded-full ${liveIndicator ? 'bg-green-400 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-slate-500">{liveIndicator ? 'live' : 'loading'}</span>
        </div>

        {/* Manual refresh */}
        <button
          onClick={() => refetch()}
          className="btn-secondary text-xs gap-1"
          title="Refresh"
        >
          <IconRefresh className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main content: canvas + optional side panel */}
      <div className="flex flex-1 min-h-0">
        {/* Canvas area */}
        <div className="flex-1 min-w-0 relative">
          {isLoading ? (
            <TopologySkeleton />
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
              <span className="text-red-400">Failed to load topology</span>
              <button onClick={() => refetch()} className="btn-secondary text-xs">
                Retry
              </button>
            </div>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2">
              <span className="text-4xl opacity-30">⬡</span>
              <span>No NFs found in namespace <strong className="text-slate-400">{namespace}</strong></span>
              <span className="text-xs">Waiting for pods to come online…</span>
            </div>
          ) : (
            <TopologyCanvas
              graph={graph}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              selectedNodeId={selectedNode?.id}
            />
          )}
        </div>

        {/* Side panel */}
        {sidePanelOpen && selectedNode && graph && (
          <div className="w-[440px] shrink-0 border-l border-border h-full">
            <SidePanel
              node={selectedNode}
              allNodes={graph.nodes}
              onClose={handleClosePanel}
            />
          </div>
        )}
      </div>
    </div>
  )
}
