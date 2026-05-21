import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import PacketTable from '@/components/PacketCapture/PacketTable'
import HexDump from '@/components/PacketCapture/HexDump'
import FilterBar from '@/components/PacketCapture/FilterBar'
import CaptureControls from '@/components/PacketCapture/CaptureControls'
import { IconX } from '@/components/common/icons'
import { usePacketCapture } from '@/hooks/usePacketCapture'
import { api } from '@/services/api'
import type { Packet } from '@/types/packet'

const RING_MAX = 5_000

export default function CapturePage() {
  const capture = usePacketCapture()
  const [selectedPkt, setSelectedPkt] = useState<Packet | null>(null)
  const [selectedPktIdx, setSelectedPktIdx] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Per-tab selectors
  const [nodeSelect, setNodeSelect] = useState('')
  const [ifaceSelect, setIfaceSelect] = useState('eth0')

  const { data: nodes = [] } = useQuery({
    queryKey: ['topology-nodes-any'],
    queryFn: () => api.topology.get('free5gc').then(g => g.nodes),
    staleTime: 30_000,
  })

  const sessionId = capture.selected
  const session = sessionId ? capture.getSession(sessionId) : undefined
  const filter = sessionId ? capture.getFilter(sessionId) : {}
  const allPackets = sessionId ? capture.getFilteredPackets(sessionId) : []

  const handleStart = useCallback(() => {
    const n = nodes.find(n => n.id === nodeSelect)
    if (!n) return
    capture.startCapture(n.podName, n.namespace, n.nodeName, ifaceSelect)
  }, [nodeSelect, ifaceSelect, nodes, capture])

  const handleSelect = useCallback((idx: number, pkt: Packet) => {
    setSelectedPkt(pkt)
    setSelectedPktIdx(idx)
  }, [])

  const tabs = Array.from(capture.sessions.keys())

  return (
    <div className="flex flex-col h-full">
      {/* Capture tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-bg-secondary border-b border-border shrink-0 overflow-x-auto">
        {tabs.map(id => {
          const s = capture.sessions.get(id)!
          const isActive = id === sessionId
          return (
            <button
              key={id}
              onClick={() => capture.selectSession(id)}
              className={clsx(
                'flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded border transition-colors shrink-0',
                isActive
                  ? 'border-blue-600/50 bg-blue-600/10 text-blue-300'
                  : 'border-border text-slate-400 hover:text-slate-200',
              )}
            >
              <span className={clsx(
                'w-1.5 h-1.5 rounded-full',
                s.status === 'active' ? 'bg-green-400 animate-pulse'
                : s.status === 'paused' ? 'bg-yellow-400'
                : s.status === 'connecting' ? 'bg-blue-400 animate-pulse'
                : 'bg-slate-600',
              )} />
              {s.podName.split('-')[0]}:{s.interfaceName}
              <span
                className="text-slate-600 hover:text-red-400"
                onClick={e => { e.stopPropagation(); capture.stopCapture(id) }}
              >
                <IconX className="w-3 h-3" />
              </span>
            </button>
          )
        })}
        <button
          className="text-xs px-2 py-0.5 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 shrink-0"
          onClick={() => capture.selectSession(null)}
        >
          + Add
        </button>
      </div>

      {/* Controls */}
      <CaptureControls
        session={session}
        allNodes={nodes}
        selectedNode={nodeSelect}
        selectedIface={ifaceSelect}
        onNodeChange={setNodeSelect}
        onIfaceChange={setIfaceSelect}
        onStart={handleStart}
        onStop={() => sessionId && capture.stopCapture(sessionId)}
        onPause={() => sessionId && capture.pauseCapture(sessionId)}
        onResume={() => sessionId && capture.resumeCapture(sessionId)}
        onClear={() => sessionId && capture.clearCapture(sessionId)}
      />

      {/* Filter bar */}
      <FilterBar
        filter={filter}
        onChange={f => sessionId && capture.setFilter(sessionId, f)}
        packetCount={session?.packetCount ?? 0}
        displayCount={allPackets.length}
        dropped={0}
        bufferCount={session?.packetCount ?? 0}
        bufferMax={RING_MAX}
        isLive={session?.status === 'active'}
      />

      {/* No session */}
      {!sessionId && (
        <div className="flex-1 flex items-center justify-center text-slate-600 flex-col gap-3">
          <span className="text-5xl opacity-20">⬡</span>
          <span className="text-sm">Select an NF and interface, then click Start</span>
          <span className="text-xs">or click an edge in the Topology view</span>
        </div>
      )}

      {/* Capture view */}
      {sessionId && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Packet table: top 60% */}
          <div className="flex-[3] min-h-0 border-b border-border">
            <PacketTable
              packets={allPackets}
              selectedIdx={selectedPktIdx}
              onSelect={handleSelect}
              autoScroll={autoScroll && session?.status === 'active'}
            />
          </div>

          {/* Hex dump: bottom 40% */}
          <div className="flex-[2] min-h-0">
            <HexDump packet={selectedPkt} />
          </div>
        </div>
      )}
    </div>
  )
}
