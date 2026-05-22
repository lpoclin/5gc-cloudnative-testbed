import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'

// ─── Types ───────────────────────────────────────────────────────────────────

interface WirePkt {
  ts: number
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  protocol: string
  length: number
  info: string
  iface: string
  pod: string
  ns: string
  node: string
}

interface LivePacket {
  no: number
  ts: number
  srcIP: string
  dstIP: string
  srcPort: number
  dstPort: number
  protocol: string
  length: number
  info: string
  iface: string
  pod: string
}

type ConnStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'error' | 'stopped'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RING_MAX = 5_000
const PROTOCOLS = ['All', 'GTP-U', 'PFCP', 'HTTP/2', 'NGAP', 'SCTP', 'DNS', 'TCP', 'UDP'] as const

function fmtTime(tsNs: number): string {
  return new Date(tsNs / 1e6).toISOString().substring(11, 23)
}

function protoColor(p: string): string {
  if (p === 'GTP-U')  return '#f97316'
  if (p === 'PFCP')   return '#a855f7'
  if (p === 'HTTP/2') return '#3b82f6'
  if (p === 'NGAP' || p === 'SCTP') return '#eab308'
  if (p === 'DNS')    return '#22c55e'
  return '#6b7280'
}

function wsUrl(pod: string, iface: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host  = import.meta.env.DEV ? `${location.hostname}:8080` : location.host
  return `${proto}://${host}/ws/packets?pod=${encodeURIComponent(pod)}&interface=${encodeURIComponent(iface)}`
}

// ─── Decode panel ─────────────────────────────────────────────────────────────

function DecodeLayer({
  label, fields, defaultOpen = true,
}: {
  label: string
  fields: [string, string | number][]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-3 py-0.5 text-left hover:bg-white/5"
        style={{ color: '#58a6ff' }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▼' : '▶'}</span>
        <span className="font-bold text-[11px]">{label}</span>
      </button>
      {open && (
        <div className="pl-7 pr-3 pb-1">
          {fields.map(([k, v]) => (
            <div key={k} className="flex gap-2 py-px text-[11px]">
              <span className="shrink-0" style={{ color: '#8b949e', minWidth: 130 }}>{k}:</span>
              <span className="break-all" style={{ color: '#e6edf3' }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DecodePanel({ pkt }: { pkt: LivePacket }) {
  const isIPv6 = pkt.srcIP.includes(':')
  const ipVer  = isIPv6 ? 'IPv6' : 'IPv4'
  const transport =
    ['TCP', 'HTTP/2'].includes(pkt.protocol) ? 'TCP' :
    ['SCTP', 'NGAP'].includes(pkt.protocol) ? 'SCTP' : 'UDP'

  return (
    <div
      className="font-mono overflow-y-auto shrink-0"
      style={{ height: 180, background: '#0d1117', borderTop: '2px solid #388bfd' }}
    >
      <div className="flex items-center gap-2 px-3 py-1 sticky top-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
        <span className="text-[10px] font-bold" style={{ color: '#58a6ff' }}>PACKET DECODE</span>
        <span className="text-[10px]" style={{ color: '#6e7681' }}>Frame #{pkt.no}</span>
      </div>

      <DecodeLayer label="Frame" fields={[
        ['Arrival Time', fmtTime(pkt.ts)],
        ['Interface',    pkt.iface],
        ['Length',       `${pkt.length} bytes`],
        ['Pod',          pkt.pod],
      ]} />

      <DecodeLayer label={ipVer} fields={[
        ['Source Address',      pkt.srcIP],
        ['Destination Address', pkt.dstIP],
        ['Next Protocol',       transport],
      ]} />

      <DecodeLayer label={transport} fields={[
        ['Source Port',      pkt.srcPort  ? String(pkt.srcPort)  : '—'],
        ['Destination Port', pkt.dstPort  ? String(pkt.dstPort)  : '—'],
      ]} />

      {pkt.info && (
        <DecodeLayer label={pkt.protocol} fields={[
          ['Info', pkt.info],
        ]} />
      )}
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CapturePage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Selection
  const [pod,   setPod]   = useState(searchParams.get('pod')       ?? '')
  const [iface, setIface] = useState(searchParams.get('interface') ?? 'eth0')

  // Packet buffer
  const [packets, setPackets] = useState<LivePacket[]>([])
  const counterRef = useRef(0)

  // Display state
  const [paused,      setPaused]      = useState(false)
  const [protoFilter, setProtoFilter] = useState<string>('All')
  const [search,      setSearch]      = useState('')
  const [selectedNo,  setSelectedNo]  = useState<number | null>(null)

  // Refs for WS lifetime and paused buffer (avoid stale closures)
  const wsRef        = useRef<WebSocket | null>(null)
  const pausedRef    = useRef(false)
  const bufferRef    = useRef<LivePacket[]>([])

  // UI
  const [status, setStatus] = useState<ConnStatus>('idle')
  const tableRef = useRef<HTMLDivElement>(null)

  // Topology nodes for NF selector
  const { data: nodes = [] } = useQuery({
    queryKey: ['topology-nodes-any'],
    queryFn:  () => api.topology.get('free5gc').then(g => g.nodes),
    staleTime: 30_000,
  })

  const selectedNode = nodes.find(n => n.podName === pod)
  const nodeIfaces   = selectedNode?.interfaces.map(i => i.interface) ?? []

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    if (!pod || !iface) { setStatus('idle'); return }

    setStatus('connecting')
    setPackets([])
    counterRef.current = 0
    bufferRef.current  = []
    pausedRef.current  = false
    setPaused(false)

    const ws = new WebSocket(wsUrl(pod, iface))
    wsRef.current = ws

    ws.onopen  = () => setStatus('live')
    ws.onerror = () => setStatus('error')
    ws.onclose = () => setStatus(s => s === 'paused' ? 'paused' : 'stopped')

    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as { type: string; data: WirePkt | WirePkt[] }
      if (msg.type !== 'packets' && msg.type !== 'packet') return

      const items = Array.isArray(msg.data) ? msg.data : [msg.data]
      const parsed: LivePacket[] = items.map(p => ({
        no: ++counterRef.current,
        ts: p.ts, srcIP: p.src_ip, dstIP: p.dst_ip,
        srcPort: p.src_port, dstPort: p.dst_port,
        protocol: p.protocol, length: p.length,
        info: p.info, iface: p.iface, pod: p.pod,
      }))

      if (pausedRef.current) {
        bufferRef.current = [...bufferRef.current, ...parsed].slice(-RING_MAX)
      } else {
        setPackets(prev => {
          const next = [...prev, ...parsed]
          return next.length > RING_MAX ? next.slice(-RING_MAX) : next
        })
      }
    }

    return () => { ws.close(); wsRef.current = null }
  }, [pod, iface])

  // Update URL params when selection changes
  useEffect(() => {
    const p = new URLSearchParams()
    if (pod)   p.set('pod', pod)
    if (iface) p.set('interface', iface)
    setSearchParams(p, { replace: true })
  }, [pod, iface, setSearchParams])

  // ── Filtered view ─────────────────────────────────────────────────────────

  const displayed = useMemo(() => {
    let list = packets
    if (protoFilter !== 'All') list = list.filter(p => p.protocol === protoFilter)
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(p =>
        p.srcIP.includes(s) || p.dstIP.includes(s) ||
        p.info.toLowerCase().includes(s) || p.protocol.toLowerCase().includes(s),
      )
    }
    return list
  }, [packets, protoFilter, search])

  // ── Virtual scroll ────────────────────────────────────────────────────────

  const virtualizer = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => tableRef.current,
    estimateSize: () => 22,
    overscan: 30,
  })

  // Auto-scroll when not paused
  useEffect(() => {
    if (!paused && displayed.length > 0) {
      virtualizer.scrollToIndex(displayed.length - 1, { align: 'end' })
    }
  }, [displayed.length, paused, virtualizer])

  // ── Controls ──────────────────────────────────────────────────────────────

  const handlePause = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
    setStatus('paused')
  }, [])

  const handleResume = useCallback(() => {
    const buf = bufferRef.current
    bufferRef.current = []
    pausedRef.current = false
    setPaused(false)

    if (buf.length > 0) {
      setPackets(prev => {
        const next = [...prev, ...buf]
        return next.length > RING_MAX ? next.slice(-RING_MAX) : next
      })
    }
    setStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'live' : 'stopped')
  }, [])

  const handleClear = useCallback(() => {
    setPackets([])
    bufferRef.current  = []
    counterRef.current = 0
    wsRef.current?.send(JSON.stringify({ type: 'clear' }))
  }, [])

  const selectedPkt = selectedNo !== null
    ? displayed.find(p => p.no === selectedNo) ?? null
    : null

  // ── Render ────────────────────────────────────────────────────────────────

  const statusBadge = () => {
    if (status === 'live') return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full font-bold text-xs tracking-widest"
        style={{ background: '#0d2a14', border: '2px solid #3fb950', color: '#3fb950' }}>
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: '#3fb950' }}/>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5"
            style={{ background: '#3fb950' }}/>
        </span>
        LIVE
      </span>
    )
    if (status === 'paused')     return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d2a0a', border: '1px solid #d29922', color: '#d29922' }}>⏸ PAUSED</span>
    if (status === 'connecting') return <span className="px-2 py-1 rounded text-xs font-bold animate-pulse" style={{ background: '#0d1f3c', border: '1px solid #388bfd', color: '#58a6ff' }}>Connecting…</span>
    if (status === 'error')      return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d0a0a', border: '1px solid #f85149', color: '#f85149' }}>ERROR</span>
    if (status === 'stopped')    return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#1a1a1a', border: '1px solid #6e7681', color: '#6e7681' }}>STOPPED</span>
    return <span className="px-2 py-1 rounded text-xs" style={{ color: '#6e7681' }}>IDLE</span>
  }

  return (
    <div className="flex flex-col h-full text-xs" style={{ background: '#0d1117', color: '#e6edf3' }}>

      {/* ── TOP BAR ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>

        {/* NF selector */}
        <select
          value={pod}
          onChange={e => setPod(e.target.value)}
          className="text-sm rounded px-2 py-1 outline-none"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', maxWidth: 220 }}
        >
          <option value="">— Select NF —</option>
          {nodes.filter(n => n.nfType !== 'DN').map(n => (
            <option key={n.id} value={n.podName}>
              {n.displayName} · {n.podName}
            </option>
          ))}
        </select>

        {/* Interface selector */}
        <select
          value={iface}
          onChange={e => setIface(e.target.value)}
          className="text-sm rounded px-2 py-1 outline-none"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}
        >
          {(nodeIfaces.length > 0 ? nodeIfaces : ['eth0']).map(i => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>

        <div className="flex-1" />

        {/* Live indicator — Fix 8: prominent animated badge */}
        <div className="flex items-center">{statusBadge()}</div>
      </div>

      {/* ── FILTER BAR ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
        {PROTOCOLS.map(p => (
          <button
            key={p}
            onClick={() => setProtoFilter(p)}
            className="px-2 py-0.5 rounded font-mono transition-colors"
            style={{
              background: protoFilter === p ? '#1f6feb' : '#161b22',
              color:      protoFilter === p ? '#e6edf3' : '#8b949e',
              border:    `1px solid ${protoFilter === p ? '#388bfd' : '#30363d'}`,
            }}
          >
            {p}
          </button>
        ))}
        <div className="flex-1" />
        <input
          type="text"
          placeholder="🔍 IP, info…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded px-2 py-0.5 outline-none w-44"
          style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }}
        />
      </div>

      {/* ── PACKET TABLE ────────────────────────────────────────────────────── */}
      {!pod ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: '#6e7681' }}>
          <span className="text-4xl opacity-20">📡</span>
          <span className="text-sm">Select a Network Function to start live capture</span>
          <span style={{ color: '#30363d' }}>or click an interface dot in the Topology view</span>
        </div>
      ) : (
        <>
          {/* Table header */}
          <div className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] uppercase shrink-0"
            style={{ background: '#161b22', color: '#6e7681', borderBottom: '1px solid #21262d' }}>
            <span className="w-10 shrink-0 text-right">#</span>
            <span className="w-24 shrink-0">Time</span>
            <span className="w-32 shrink-0">Source</span>
            <span className="w-32 shrink-0">Destination</span>
            <span className="w-20 shrink-0">Protocol</span>
            <span className="w-12 shrink-0 text-right">Len</span>
            <span className="flex-1">Info</span>
          </div>

          <div className="flex flex-col flex-1 min-h-0">
            <div ref={tableRef} className="flex-1 overflow-y-auto font-mono"
              style={{ background: '#0d1117' }}>
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map(item => {
                  const pkt = displayed[item.index]!
                  const color = protoColor(pkt.protocol)
                  const isSelected = pkt.no === selectedNo
                  return (
                    <div
                      key={item.key}
                      onClick={() => setSelectedNo(prev => prev === pkt.no ? null : pkt.no)}
                      style={{
                        position: 'absolute', top: item.start, width: '100%', height: item.size,
                        background: isSelected ? '#1c2d4a' : undefined,
                        borderLeft: isSelected ? '2px solid #388bfd' : '2px solid transparent',
                      }}
                      className="flex items-center gap-2 px-3 hover:bg-white/5 cursor-pointer"
                    >
                      <span className="w-10 shrink-0 text-right" style={{ color: '#6e7681' }}>{pkt.no}</span>
                      <span className="w-24 shrink-0" style={{ color: '#8b949e' }}>{fmtTime(pkt.ts)}</span>
                      <span className="w-32 shrink-0 truncate">{pkt.srcIP}{pkt.srcPort ? `:${pkt.srcPort}` : ''}</span>
                      <span className="w-32 shrink-0 truncate">{pkt.dstIP}{pkt.dstPort ? `:${pkt.dstPort}` : ''}</span>
                      <span className="w-20 shrink-0 font-bold" style={{ color }}>{pkt.protocol}</span>
                      <span className="w-12 shrink-0 text-right" style={{ color: '#6e7681' }}>{pkt.length}</span>
                      <span className="flex-1 truncate" style={{ color: '#c9d1d9' }}>{pkt.info}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Fix 2: Packet decode panel — appears when a row is selected */}
            {selectedPkt && <DecodePanel pkt={selectedPkt} />}
          </div>
        </>
      )}

      {/* ── BOTTOM BAR ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-4 py-1.5 shrink-0"
        style={{ background: '#161b22', borderTop: '1px solid #30363d' }}>

        {/* Left: controls */}
        <div className="flex items-center gap-1.5">
          {paused ? (
            <button onClick={handleResume} className="px-2 py-0.5 rounded"
              style={{ background: '#238636', color: '#f0f6fc', border: '1px solid #2ea043' }}>
              ▶ Resume
            </button>
          ) : (
            <button onClick={handlePause} className="px-2 py-0.5 rounded"
              style={{ background: '#21262d', color: '#e6edf3', border: '1px solid #30363d' }}>
              ⏸ Pause
            </button>
          )}
          <button onClick={handleClear} className="px-2 py-0.5 rounded"
            style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}>
            🗑 Clear
          </button>
        </div>

        {/* Center: export placeholders */}
        <div className="flex items-center gap-1">
          <span style={{ color: '#6e7681' }}>Export:</span>
          {(['Last 30s', 'Last 5min', 'Last 1h'] as const).map(lbl => (
            <button key={lbl} className="px-1.5 py-0.5 rounded"
              style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}
              title="pcap export coming soon"
            >
              ⬇ {lbl}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Right: stats */}
        <div className="flex items-center gap-3" style={{ color: '#8b949e' }}>
          <span>Pkts: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong></span>
          <span>Shown: <strong style={{ color: '#e6edf3' }}>{displayed.length}</strong></span>
          <span>Buf: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong>/5,000</span>
        </div>
      </div>
    </div>
  )
}
