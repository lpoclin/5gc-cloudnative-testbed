import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
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
  raw?: string  // base64-encoded raw bytes from tshark (if available)
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
  rawHex?: string  // hex string, populated only if raw bytes available
}

type ConnStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'error' | 'stopped'

// ─── Constants ────────────────────────────────────────────────────────────────

const RING_MAX  = 5_000
const PROTOCOLS = ['All', 'GTP-U', 'PFCP', 'HTTP/2', 'NGAP', 'SCTP', 'DNS', 'TCP', 'UDP'] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Relative time since capture start: "seconds.microseconds" per Wireshark format */
function fmtRelTime(tsNs: number, startNs: number): string {
  if (startNs === 0 || tsNs < startNs) return '0.000000'
  const deltaNs = tsNs - startNs
  const s  = Math.floor(deltaNs / 1_000_000_000)
  const us = Math.floor((deltaNs % 1_000_000_000) / 1_000)
  return `${s}.${String(us).padStart(6, '0')}`
}

/** Arrival time in HH:MM:SS.ffffff */
function fmtArrival(tsNs: number): string {
  const d  = new Date(tsNs / 1_000_000)
  const hh = d.getUTCHours().toString().padStart(2, '0')
  const mm = d.getUTCMinutes().toString().padStart(2, '0')
  const ss = d.getUTCSeconds().toString().padStart(2, '0')
  const us = Math.floor((tsNs % 1_000_000_000) / 1_000).toString().padStart(6, '0')
  return `${hh}:${mm}:${ss}.${us}`
}

/** Row background per protocol (dark theme tints per spec) */
function rowBg(proto: string, selected: boolean): string {
  if (selected) return '#1e3a5f'
  switch (proto) {
    case 'SCTP':   return 'rgba(234,179,8,0.15)'
    case 'GTP-U':  return 'rgba(34,197,94,0.15)'
    case 'HTTP/2': return 'rgba(168,85,247,0.15)'
    case 'HTTP':   return 'rgba(59,130,246,0.15)'
    case 'PFCP':   return 'rgba(59,130,246,0.15)'
    case 'TCP':    return 'rgba(255,255,255,0.04)'
    case 'ARP':    return 'rgba(6,182,212,0.15)'
    case 'UDP':    return 'rgba(249,115,22,0.10)'
    default:       return 'transparent'
  }
}

/** Protocol column text color */
function protoColor(p: string): string {
  switch (p) {
    case 'GTP-U':  return '#22c55e'
    case 'PFCP':   return '#3b82f6'
    case 'HTTP/2': return '#a855f7'
    case 'HTTP':   return '#3b82f6'
    case 'NGAP':   return '#eab308'
    case 'SCTP':   return '#eab308'
    case 'DNS':    return '#22c55e'
    case 'TCP':    return '#94a3b8'
    case 'UDP':    return '#f97316'
    case 'ARP':    return '#06b6d4'
    default:       return '#6b7280'
  }
}

/**
 * Returns the transport protocol that carries the given app protocol,
 * per RFC / 3GPP encapsulation specs.
 * Returns null when the protocol IS the transport (TCP, UDP, SCTP),
 * to avoid rendering a duplicate layer.
 */
function transportFor(proto: string): 'TCP' | 'UDP' | 'SCTP' | null {
  switch (proto.toUpperCase()) {
    case 'HTTP': case 'HTTP/2': case 'TLS': case 'HTTPS':
      return 'TCP'
    case 'GTP-U': case 'PFCP': case 'DNS': case 'DHCP': case 'VXLAN':
      return 'UDP'
    case 'NGAP': case 'S1AP': case 'X2AP': case 'M3AP':
      return 'SCTP'
    // Pure transport protocols: no separate carrier layer
    default:
      return null
  }
}

/** IP protocol number string for the network layer "Protocol:" field */
function ipProtoStr(transport: 'TCP' | 'UDP' | 'SCTP' | null, proto: string): string {
  if (transport === 'TCP'  || proto === 'TCP')  return 'TCP (6)'
  if (transport === 'UDP'  || proto === 'UDP')  return 'UDP (17)'
  if (transport === 'SCTP' || proto === 'SCTP') return 'SCTP (132)'
  return proto
}

// ─── Info-string heuristic parser ────────────────────────────────────────────

interface InfoField { key: string; value: string }

/**
 * Extracts protocol fields by heuristically parsing the tshark info string.
 * All returned fields are labeled "(from info)" in the UI — they are not from
 * raw packet bytes and may be incomplete.
 */
function parseInfoFields(protocol: string, info: string): InfoField[] {
  if (!info) return []
  const f = (key: string, value: string): InfoField => ({ key, value })
  const out: InfoField[] = []
  const p = protocol.toUpperCase()

  // ── TCP flags / seq / ack (also present in HTTP, HTTP/2 info from tshark) ──
  if (p === 'TCP' || p === 'HTTP' || p === 'HTTP/2') {
    const flags = info.match(/\[([A-Z]{2,3}(?:[,\s]+[A-Z]{2,3})*)\]/)
    if (flags) out.push(f('Flags', flags[1]))
    const seq = info.match(/\bSeq=(\d+)/)
    if (seq)   out.push(f('Sequence Number', seq[1]))
    const ack = info.match(/\bAck=(\d+)/)
    if (ack)   out.push(f('Acknowledgment Number', ack[1]))
    const win = info.match(/\bWin=(\d+)/)
    if (win)   out.push(f('Window', win[1]))
    const len = info.match(/\bLen=(\d+)/)
    if (len)   out.push(f('Data Length', len[1] + ' bytes'))
  }

  // ── HTTP/2 frame type / stream ──
  if (p === 'HTTP/2') {
    const frame = info.match(/\b(HEADERS|DATA|SETTINGS|PING|GOAWAY|RST_STREAM|WINDOW_UPDATE|PUSH_PROMISE|CONTINUATION)(?:\[(\d+)\])?/)
    if (frame) {
      out.push(f('Frame Type', frame[1]))
      if (frame[2]) out.push(f('Stream ID', frame[2]))
    }
    const status = info.match(/:status:\s*(\d+)/)
    if (status) out.push(f(':status', status[1]))
    const method = info.match(/:method:\s*(\S+)/)
    if (method) out.push(f(':method', method[1]))
    const path   = info.match(/:path:\s*(\S+)/)
    if (path)   out.push(f(':path', path[1]))
  }

  // ── SCTP chunk type (applies to SCTP and NGAP) ──
  if (p === 'SCTP' || p === 'NGAP' || p === 'S1AP' || p === 'X2AP') {
    const chunk = info.match(/\b(HEARTBEAT(?:_ACK)?|DATA|INIT(?:_ACK)?|SACK|SHUTDOWN(?:_ACK)?|COOKIE_ECHO|COOKIE_ACK|ERROR|ABORT)\b/)
    if (chunk) out.push(f('Chunk Type', chunk[1]))
    const clen = info.match(/\bLen=(\d+)/)
    if (clen)  out.push(f('Chunk Length', clen[1] + ' bytes'))
  }

  // ── GTP-U ──
  if (p === 'GTP-U') {
    const msg = info.match(/^(G-PDU|Echo Request|Echo Response|Supported Extension Headers Notification)/)
    if (msg)  out.push(f('Message Type', msg[1]))
    const teid = info.match(/\bTEID=0x([0-9a-fA-F]+)/i)
    if (teid) out.push(f('TEID', '0x' + teid[1].toUpperCase()))
    // Inner packet: "{IPv4} src → dst (proto)" from tshark
    const inner = info.match(/\{(IPv[46])\}\s+([\d.:a-fA-F]+)\s*[→>]\s*([\d.:a-fA-F]+)\s*\((\w+)\)/)
    if (inner) {
      out.push(f('Inner ' + inner[1] + ' Source', inner[2]))
      out.push(f('Inner ' + inner[1] + ' Destination', inner[3]))
      out.push(f('Inner Protocol', inner[4]))
    }
  }

  // ── PFCP ──
  if (p === 'PFCP') {
    const parts = info.split(/\s+Seq:/)
    if (parts[0]?.trim()) out.push(f('Message Type', parts[0].trim()))
    const seq  = info.match(/\bSeq:\s*(\d+)/)
    if (seq)   out.push(f('Sequence Number', seq[1]))
    const seid = info.match(/\bSEID:\s*(0x[\da-fA-F]+|\d+)/i)
    if (seid)  out.push(f('SEID', seid[1]))
  }

  // ── DNS ──
  if (p === 'DNS') {
    const isResp = /response/i.test(info)
    out.push(f('Message Type', isResp ? 'Standard query response' : 'Standard query'))
    const txId = info.match(/\b0x([0-9a-fA-F]{4})\b/)
    if (txId) out.push(f('Transaction ID', '0x' + txId[1].toUpperCase()))
    const q = info.match(/\b(A|AAAA|CNAME|PTR|MX|NS|SRV|TXT)\s+([\w._-]+)/)
    if (q) { out.push(f('Query Type', q[1])); out.push(f('Query Name', q[2])) }
    if (isResp) {
      const a4 = info.match(/\bA\s+([\d.]+)\s*$/)
      if (a4)   out.push(f('Answer', a4[1]))
      const a6 = info.match(/\bAAAA\s+([\da-fA-F:]+)\s*$/)
      if (a6)   out.push(f('Answer', a6[1]))
    }
  }

  // ── ARP ──
  if (p === 'ARP') {
    if (/request/i.test(info))      out.push(f('Opcode', 'Request (1)'))
    else if (/reply/i.test(info))   out.push(f('Opcode', 'Reply (2)'))
  }

  return out
}

/** base64 → lowercase hex string */
function base64ToHex(b64: string): string {
  try {
    const bin = atob(b64)
    return Array.from(bin, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  } catch { return '' }
}

// ─── Decode panel — protocol tree components ──────────────────────────────────

function Layer({
  label, sublabel, children, defaultOpen = true,
}: {
  label: string; sublabel?: string; children: ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="select-text">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-start gap-1.5 w-full px-2 py-0.5 text-left hover:bg-white/5"
      >
        <span className="mt-px shrink-0 text-[9px]" style={{ color: '#58a6ff' }}>
          {open ? '▼' : '▶'}
        </span>
        <span className="font-bold text-[11px]" style={{ color: '#79c0ff', fontFamily: 'Inter, system-ui, sans-serif' }}>
          {label}
          {sublabel && <span className="font-normal ml-1" style={{ color: '#8b949e' }}>{sublabel}</span>}
        </span>
      </button>
      {open && <div className="pl-5">{children}</div>}
    </div>
  )
}

function Field({ label, value, fromInfo }: { label: string; value: string; fromInfo?: boolean }) {
  return (
    <div className="flex gap-1 px-2 py-px text-[11px] hover:bg-white/5 select-text">
      <span className="shrink-0 font-medium"
        style={{ color: '#8b949e', minWidth: 190, fontFamily: 'Inter, system-ui, sans-serif' }}>
        {label}:
      </span>
      <span className="break-all font-mono" style={{ color: '#f0f6fc' }}>
        {value}
        {fromInfo && <span className="ml-1 text-[9px]" style={{ color: '#6e7681' }}>(from info)</span>}
      </span>
    </div>
  )
}

// ─── Decode tree ──────────────────────────────────────────────────────────────

function DecodeTree({ pkt, startNs }: { pkt: LivePacket; startNs: number }) {
  const isIPv6   = pkt.srcIP.includes(':')
  const ipVer    = isIPv6 ? '6' : '4'
  const proto    = pkt.protocol.toUpperCase()
  const transport = transportFor(pkt.protocol)   // null for TCP/UDP/SCTP themselves

  // Determine actual transport (for TCP/UDP/SCTP themselves, they are the transport)
  const actualTransport: 'TCP' | 'UDP' | 'SCTP' | null =
    proto === 'TCP'  ? 'TCP'  :
    proto === 'UDP'  ? 'UDP'  :
    proto === 'SCTP' ? 'SCTP' :
    transport

  const allFields    = parseInfoFields(pkt.protocol, pkt.info)

  // Partition fields: TCP-level vs SCTP-chunk-level vs app-level
  const tcpKeys   = new Set(['Flags', 'Sequence Number', 'Acknowledgment Number', 'Window', 'Data Length'])
  const sctpKeys  = new Set(['Chunk Type', 'Chunk Length'])
  const tcpFields  = allFields.filter(f => tcpKeys.has(f.key))
  const sctpFields = allFields.filter(f => sctpKeys.has(f.key))
  const appFields  = allFields.filter(f => !tcpKeys.has(f.key) && !sctpKeys.has(f.key))

  // Separate GTP-U inner fields
  const innerFields = appFields.filter(f => f.key.startsWith('Inner '))
  const gtpAppFields = appFields.filter(f => !f.key.startsWith('Inner ') && f.key !== 'Message Type' && f.key !== 'TEID')
  const gtpMsgField  = appFields.find(f => f.key === 'Message Type')
  const gtpTeidField = appFields.find(f => f.key === 'TEID')

  // True when the protocol has a distinct app layer above the transport
  const hasAppLayer = transport !== null

  return (
    <div className="font-mono text-[11px] overflow-y-auto h-full" style={{ background: '#0d1117' }}>

      {/* ── Frame ── */}
      <Layer label={`Frame ${pkt.no}: ${pkt.length} bytes on wire, ${pkt.length} bytes captured`}>
        <Field label="Arrival Time"   value={fmtArrival(pkt.ts)} />
        <Field label="Epoch Time"     value={(pkt.ts / 1e9).toFixed(9) + ' seconds'} />
        <Field label="Relative Time"  value={fmtRelTime(pkt.ts, startNs) + ' seconds'} />
        <Field label="Interface"      value={pkt.iface} />
        <Field label="Frame Length"   value={`${pkt.length} bytes (${pkt.length * 8} bits)`} />
        <Field label="Capture Length" value={`${pkt.length} bytes (${pkt.length * 8} bits)`} />
        <Field label="Pod"            value={pkt.pod} />
      </Layer>

      {/* ── Network layer ── */}
      <Layer
        label={`Internet Protocol Version ${ipVer},`}
        sublabel={`Src: ${pkt.srcIP}, Dst: ${pkt.dstIP}`}
      >
        <Field label="Version"             value={ipVer} />
        <Field label="Source Address"      value={pkt.srcIP} />
        <Field label="Destination Address" value={pkt.dstIP} />
        {actualTransport && (
          <Field label="Protocol" value={ipProtoStr(actualTransport, pkt.protocol)} />
        )}
      </Layer>

      {/* ── Transport layer ──
          For TCP/UDP/SCTP protocols the transport IS the protocol — show combined.
          For app protocols (GTP-U, HTTP/2, …), show transport ports then the app layer. */}
      {actualTransport === 'TCP' && (
        <Layer
          label="Transmission Control Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
          {tcpFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {actualTransport === 'UDP' && (
        <Layer
          label="User Datagram Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
        </Layer>
      )}

      {actualTransport === 'SCTP' && (
        <Layer
          label="Stream Control Transmission Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
          {/* SCTP chunk — only shown when SCTP is the top protocol OR for NGAP transport */}
          {sctpFields.length > 0 && (
            <Layer label={`SCTP Chunk: ${sctpFields.find(f => f.key === 'Chunk Type')?.value ?? 'DATA'}`}>
              {sctpFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
            </Layer>
          )}
        </Layer>
      )}

      {/* ── Application / tunneling layer (only when protocol ≠ transport) ── */}

      {/* GTP-U — 3GPP TS 29.281 */}
      {proto === 'GTP-U' && (
        <Layer label="GPRS Tunneling Protocol User Plane">
          <Field label="Version"       value="1" />
          <Field label="Protocol Type" value="GTP (1)" />
          {gtpMsgField  && <Field label="Message Type" value={gtpMsgField.value}  fromInfo />}
          {gtpTeidField && <Field label="TEID"         value={gtpTeidField.value} fromInfo />}
          {innerFields.length > 0 && (
            <Layer label="Encapsulated User Plane Packet" sublabel="(from info string)">
              {innerFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
              {gtpAppFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
            </Layer>
          )}
        </Layer>
      )}

      {/* PFCP — 3GPP TS 29.244 */}
      {proto === 'PFCP' && (
        <Layer label="Packet Forwarding Control Protocol">
          <Field label="Version" value="1" />
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {/* HTTP/2 — RFC 7540 / RFC 9113 */}
      {proto === 'HTTP/2' && (
        <Layer label="HyperText Transfer Protocol 2">
          {appFields.filter(f => !tcpKeys.has(f.key)).map(f =>
            <Field key={f.key} label={f.key} value={f.value} fromInfo />
          )}
          {pkt.info && !appFields.length && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* HTTP — RFC 7230 */}
      {(proto === 'HTTP') && hasAppLayer && (
        <Layer label="Hypertext Transfer Protocol">
          {appFields.filter(f => !tcpKeys.has(f.key)).map(f =>
            <Field key={f.key} label={f.key} value={f.value} fromInfo />
          )}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* NGAP / S1AP / X2AP — over SCTP */}
      {(proto === 'NGAP' || proto === 'S1AP' || proto === 'X2AP') && (
        <Layer label={
          proto === 'NGAP' ? 'Next Generation Application Protocol (NGAP)' :
          proto === 'S1AP' ? 'S1 Application Protocol (S1AP)' : 'X2 Application Protocol (X2AP)'
        }>
          {pkt.info && <Field label="Info" value={pkt.info} fromInfo />}
        </Layer>
      )}

      {/* DNS — RFC 1035 */}
      {proto === 'DNS' && (
        <Layer label="Domain Name System">
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {/* ARP — RFC 826 */}
      {proto === 'ARP' && (
        <Layer label="Address Resolution Protocol">
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* Generic fallback for unknown protocols */}
      {!['TCP','UDP','SCTP','HTTP','HTTP/2','GTP-U','PFCP','NGAP','S1AP','X2AP','DNS','ARP'].includes(proto) && (
        <Layer label={pkt.protocol}>
          {allFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}
    </div>
  )
}

// ─── sharkd protocol tree ─────────────────────────────────────────────────────

interface SharkdTreeNode {
  l:  string           // label (display string)
  t?: string           // type: 'proto' | 'url' | 'framenum' | ...
  f?: string           // Wireshark filter name (e.g. 'ip.src')
  s?: number           // severity
  h?: [number, number] // [start_byte, length] byte range
  e?: SharkdTreeNode[] // children
}

interface DecodeApiResponse {
  sharkd:  boolean
  result?: { tree: SharkdTreeNode[]; bytes: string }
  bytes?:  string  // raw hex when sharkd=false but bytes available
  error?:  string
}

/** Map filter-name prefix → layer color */
function nodeLayerColor(f?: string): string {
  if (!f) return '#8b949e'
  if (f === 'frame' || f.startsWith('frame.'))              return '#8b949e'
  if (f === 'eth'   || f.startsWith('eth.'))                return '#58a6ff'
  if (f === 'ip'    || f.startsWith('ip.')    ||
      f === 'ipv6'  || f.startsWith('ipv6.'))               return '#3fb950'
  if (f === 'tcp'   || f.startsWith('tcp.'))                return '#f97316'
  if (f === 'udp'   || f.startsWith('udp.'))                return '#f97316'
  if (f === 'sctp'  || f.startsWith('sctp.'))               return '#eab308'
  if (f === 'gtp'   || f.startsWith('gtp.')   ||
      f === 'gtp2'  || f.startsWith('gtp2.'))               return '#22c55e'
  if (f === 'pfcp'  || f.startsWith('pfcp.'))               return '#a855f7'
  if (f === 'http2' || f.startsWith('http2.') ||
      f === 'http'  || f.startsWith('http.'))               return '#06b6d4'
  if (f === 'nas_5gs' || f.startsWith('nas_5gs.') ||
      f === 'nas_eps' || f.startsWith('nas_eps.'))          return '#f43f5e'
  if (f === 'ngap'  || f.startsWith('ngap.')  ||
      f === 's1ap'  || f.startsWith('s1ap.'))               return '#fb923c'
  if (f === 'dns'   || f.startsWith('dns.'))                return '#34d399'
  return '#8b949e'
}

function SharkdNodeItem({
  node, depth, onFieldClick,
}: {
  node: SharkdTreeNode
  depth: number
  onFieldClick: (range: [number, number]) => void
}) {
  const hasChildren = (node.e?.length ?? 0) > 0
  const isProtoLayer = node.t === 'proto' || depth === 0

  // Top-level layers: collapse frame/eth/ip by default; expand transport+app
  const shouldOpenDefault = () => {
    if (depth !== 0) return true
    const f = (node.f ?? '').toLowerCase()
    return !['frame', 'eth', 'ip', 'ipv6', 'arp'].includes(f)
  }
  const [open, setOpen] = useState(shouldOpenDefault)

  const color = isProtoLayer ? nodeLayerColor(node.f) : '#e6edf3'
  const indent = depth * 12

  return (
    <div>
      <div
        onClick={() => {
          if (hasChildren) setOpen(v => !v)
          if (node.h) onFieldClick(node.h)
        }}
        title={node.f ?? undefined}
        className="flex items-start py-px hover:bg-white/5 cursor-pointer select-text text-[11px]"
        style={{ paddingLeft: 8 + indent }}
      >
        <span className="shrink-0 mr-1.5 mt-px text-[9px]" style={{ color: '#58a6ff', minWidth: 8 }}>
          {hasChildren ? (open ? '▼' : '▶') : ''}
        </span>
        <span style={{ color, fontWeight: isProtoLayer ? 'bold' : 'normal', fontFamily: 'JetBrains Mono, monospace' }}>
          {node.l}
        </span>
      </div>
      {hasChildren && open && (
        <SharkdSubTree nodes={node.e!} depth={depth + 1} onFieldClick={onFieldClick} />
      )}
    </div>
  )
}

function SharkdSubTree({ nodes, depth, onFieldClick }: {
  nodes: SharkdTreeNode[]; depth: number; onFieldClick: (r: [number, number]) => void
}) {
  return (
    <>
      {nodes.map((n, i) => (
        <SharkdNodeItem key={i} node={n} depth={depth} onFieldClick={onFieldClick} />
      ))}
    </>
  )
}

// ─── Hex dump panel (with optional byte-range highlight) ─────────────────────

function HexPanel({
  hexStr, highlight,
}: {
  hexStr?: string
  highlight?: [number, number] | null  // [start_byte, length]
}) {
  if (!hexStr) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] font-mono text-center px-4"
        style={{ color: '#6e7681', background: '#010409' }}>
        <div className="space-y-1">
          <div style={{ color: '#30363d', fontSize: 20 }}>⬡</div>
          <div>Raw bytes not available from tshark output</div>
          <div className="text-[10px]" style={{ color: '#30363d' }}>
            Upgrade api-server image to include tshark for sharkd decode
          </div>
        </div>
      </div>
    )
  }

  const bytes: number[] = []
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes.push(parseInt(hexStr.slice(i, i + 2), 16))
  }

  const hl = highlight  // [startByte, length]

  const rows: { offset: string; chunks: { hex: string; idx: number }[]; ascii: { ch: string; idx: number }[] }[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16)
    rows.push({
      offset: i.toString(16).padStart(4, '0'),
      chunks: chunk.map((b, j) => ({ hex: b.toString(16).padStart(2, '0') + (j === 7 ? '  ' : ' '), idx: i + j })),
      ascii:  chunk.map((b, j) => ({ ch: (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.', idx: i + j })),
    })
  }

  const inHl = (idx: number) =>
    hl != null && idx >= hl[0] && idx < hl[0] + hl[1]

  return (
    <div className="overflow-y-auto h-full text-[11px] font-mono" style={{ background: '#010409' }}>
      {rows.map(r => (
        <div key={r.offset}
          className="flex gap-3 px-3 py-px hover:bg-white/5 leading-5 whitespace-nowrap">
          <span style={{ color: '#6e7681', userSelect: 'none' }}>{r.offset}</span>
          <span style={{ letterSpacing: '0.03em' }}>
            {r.chunks.map(c => (
              <span key={c.idx}
                style={{ color: inHl(c.idx) ? '#e6edf3' : '#79c0ff',
                  background: inHl(c.idx) ? 'rgba(88,166,255,0.4)' : undefined }}>
                {c.hex}
              </span>
            ))}
          </span>
          <span>
            {r.ascii.map(a => (
              <span key={a.idx}
                style={{ color: inHl(a.idx) ? '#e6edf3' : '#56d364',
                  background: inHl(a.idx) ? 'rgba(88,166,255,0.4)' : undefined }}>
                {a.ch}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Decode panel container (resizable height + split tree/hex + sharkd fetch) ──

function DecodePanel({
  pkt, startNs, onClose,
}: {
  pkt: LivePacket; startNs: number; onClose: () => void
}) {
  const [panelH,    setPanelH]    = useState(300)
  const [splitPct,  setSplitPct]  = useState(55)
  const [decodeData, setDecodeData] = useState<DecodeApiResponse | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [highlight, setHighlight] = useState<[number, number] | null>(null)
  const hRef       = useRef<{ y0: number; h0: number } | null>(null)
  const sRef       = useRef<{ x0: number; pct0: number; w: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch sharkd decode whenever the selected packet (by ts) changes
  useEffect(() => {
    if (!pkt.pod || !pkt.iface || !pkt.ts) return
    let cancelled = false
    setLoading(true)
    setDecodeData(null)
    setHighlight(null)

    const url = `/api/packet/decode?pod=${encodeURIComponent(pkt.pod)}&interface=${encodeURIComponent(pkt.iface)}&ts=${pkt.ts}`
    fetch(url)
      .then(r => r.json() as Promise<DecodeApiResponse>)
      .then(d => { if (!cancelled) { setDecodeData(d); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [pkt.ts, pkt.pod, pkt.iface])

  // Panel height resize
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!hRef.current) return
      const next = Math.max(150, Math.min(Math.floor(window.innerHeight * 0.6),
        hRef.current.h0 + (hRef.current.y0 - e.clientY)))
      setPanelH(next)
    }
    const up = () => { hRef.current = null }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [])

  // Vertical split resize
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!sRef.current) return
      const pct = sRef.current.pct0 + ((e.clientX - sRef.current.x0) / sRef.current.w) * 100
      setSplitPct(Math.max(25, Math.min(75, pct)))
    }
    const up = () => { sRef.current = null }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [])

  // Determine tree + hex content
  const useSharkd  = decodeData?.sharkd && decodeData.result != null
  const hexStr     = useSharkd ? decodeData!.result!.bytes : (decodeData?.bytes ?? pkt.rawHex)
  const sharkdBadge = useSharkd
    ? <span className="text-[9px] px-1 rounded" style={{ background: '#1a3f1a', color: '#3fb950', border: '1px solid #2ea043' }}>sharkd</span>
    : decodeData && !decodeData.sharkd
      ? <span className="text-[9px] px-1 rounded" style={{ background: '#2a1a0a', color: '#d29922', border: '1px solid #9a6700' }}>basic decode</span>
      : null

  return (
    <div className="shrink-0 flex flex-col" style={{ height: panelH + 28, background: '#0d1117' }}>
      {/* Drag handle / header */}
      <div
        className="flex items-center justify-between px-3 shrink-0 cursor-ns-resize select-none"
        style={{ height: 28, background: '#161b22', borderTop: '2px solid #30363d' }}
        onMouseDown={e => { e.preventDefault(); hRef.current = { y0: e.clientY, h0: panelH } }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderTopColor = '#388bfd' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderTopColor = '#30363d' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold" style={{ color: '#58a6ff' }}>PACKET DECODE</span>
          <span className="text-[10px]" style={{ color: '#6e7681' }}>
            Frame {pkt.no} — {pkt.protocol} — {pkt.length} bytes — {fmtArrival(pkt.ts)}
          </span>
          {sharkdBadge}
          {loading && (
            <span className="text-[9px] animate-pulse" style={{ color: '#8b949e' }}>fetching…</span>
          )}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          onMouseDown={e => e.stopPropagation()}
          className="text-sm px-1 hover:text-red-400"
          style={{ color: '#6e7681' }}
        >
          ×
        </button>
      </div>

      {/* Tree | divider | hex */}
      <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden">

        {/* Protocol tree — sharkd or fallback */}
        <div style={{ width: `${splitPct}%`, minWidth: 0, overflow: 'hidden' }}>
          {loading ? (
            <div className="flex items-center justify-center h-full text-[11px] animate-pulse"
              style={{ color: '#8b949e', background: '#0d1117' }}>
              Waiting for sharkd…
            </div>
          ) : useSharkd ? (
            <div className="overflow-y-auto h-full" style={{ background: '#0d1117' }}>
              <SharkdSubTree
                nodes={decodeData!.result!.tree}
                depth={0}
                onFieldClick={r => setHighlight(r)}
              />
            </div>
          ) : (
            /* Fallback: info-string based tree */
            <DecodeTree pkt={pkt} startNs={startNs} />
          )}
        </div>

        {/* Draggable vertical divider */}
        <div
          className="shrink-0 cursor-ew-resize transition-colors"
          style={{ width: 4, background: '#30363d' }}
          onMouseDown={e => {
            e.preventDefault()
            sRef.current = { x0: e.clientX, pct0: splitPct, w: containerRef.current?.clientWidth ?? 800 }
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
        />

        {/* Hex dump */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <HexPanel hexStr={hexStr} highlight={highlight} />
        </div>
      </div>
    </div>
  )
}

// ─── WebSocket URL helper ─────────────────────────────────────────────────────

function wsUrl(pod: string, iface: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host  = import.meta.env.DEV ? `${location.hostname}:8080` : location.host
  return `${proto}://${host}/ws/packets?pod=${encodeURIComponent(pod)}&interface=${encodeURIComponent(iface)}`
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CapturePage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [pod,   setPod]   = useState(searchParams.get('pod')       ?? '')
  const [iface, setIface] = useState(searchParams.get('interface') ?? 'eth0')

  const [packets,   setPackets]   = useState<LivePacket[]>([])
  const [captureTs, setCaptureTs] = useState(0)   // nanoseconds ts of first captured packet
  const counterRef = useRef(0)

  const [paused,      setPaused]      = useState(false)
  const [protoFilter, setProtoFilter] = useState<string>('All')
  const [search,      setSearch]      = useState('')
  const [selectedNo,  setSelectedNo]  = useState<number | null>(null)

  const wsRef     = useRef<WebSocket | null>(null)
  const pausedRef = useRef(false)
  const bufferRef = useRef<LivePacket[]>([])

  const [status, setStatus] = useState<ConnStatus>('idle')
  const tableRef = useRef<HTMLDivElement>(null)

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
    setCaptureTs(0)
    counterRef.current = 0
    bufferRef.current  = []
    pausedRef.current  = false
    setPaused(false)
    setSelectedNo(null)

    const ws = new WebSocket(wsUrl(pod, iface))
    wsRef.current = ws

    ws.onopen  = () => setStatus('live')
    ws.onerror = () => setStatus('error')
    ws.onclose = () => setStatus(s => s === 'paused' ? 'paused' : 'stopped')

    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as { type: string; data: WirePkt | WirePkt[] }
      if (msg.type !== 'packets' && msg.type !== 'packet') return

      const items = Array.isArray(msg.data) ? msg.data : [msg.data]
      if (items.length === 0) return

      const parsed: LivePacket[] = items.map(p => ({
        no:       ++counterRef.current,
        ts:       p.ts,
        srcIP:    p.src_ip,
        dstIP:    p.dst_ip,
        srcPort:  p.src_port,
        dstPort:  p.dst_port,
        protocol: p.protocol,
        length:   p.length,
        info:     p.info,
        iface:    p.iface,
        pod:      p.pod,
        rawHex:   p.raw ? base64ToHex(p.raw) : undefined,
      }))

      // Record nanosecond timestamp of the first packet in this capture session
      setCaptureTs(prev => (prev === 0 && parsed.length > 0) ? parsed[0].ts : prev)

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
    count:            displayed.length,
    getScrollElement: () => tableRef.current,
    estimateSize:     () => 22,
    overscan:         30,
  })

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
    setCaptureTs(0)
    bufferRef.current  = []
    counterRef.current = 0
    setSelectedNo(null)
    wsRef.current?.send(JSON.stringify({ type: 'clear' }))
  }, [])

  // Selected packet — search full buffer so decode panel persists through filters
  const selectedPkt = useMemo(
    () => selectedNo !== null ? (packets.find(p => p.no === selectedNo) ?? null) : null,
    [selectedNo, packets],
  )

  // ── Status badge ──────────────────────────────────────────────────────────

  const statusBadge = () => {
    if (status === 'live') return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full font-bold text-xs tracking-widest"
        style={{ background: '#0d2a14', border: '2px solid #3fb950', color: '#3fb950' }}>
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: '#3fb950' }} />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5"
            style={{ background: '#3fb950' }} />
        </span>
        LIVE
      </span>
    )
    if (status === 'paused')     return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d2a0a', border: '1px solid #d29922', color: '#d29922' }}>⏸ PAUSED</span>
    if (status === 'connecting') return <span className="px-2 py-1 rounded text-xs font-bold animate-pulse" style={{ background: '#0d1f3c', border: '1px solid #388bfd', color: '#58a6ff' }}>Connecting…</span>
    if (status === 'error')      return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d0a0a', border: '1px solid #f85149', color: '#f85149' }}>ERROR</span>
    if (status === 'stopped')    return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#161b22', border: '1px solid #6e7681', color: '#6e7681' }}>STOPPED</span>
    return <span className="px-2 py-1 rounded text-xs" style={{ color: '#6e7681' }}>IDLE</span>
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full text-xs" style={{ background: '#0d1117', color: '#e6edf3' }}>

      {/* ── TOP BAR: [selectors] | [controls] | [exports] | [status] ──────── */}
      <div className="flex items-center gap-2 px-4 py-2 shrink-0"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>

        {/* LEFT — NF + interface selectors */}
        <select value={pod} onChange={e => setPod(e.target.value)}
          className="text-sm rounded px-2 py-1 outline-none shrink-0"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', maxWidth: 200 }}>
          <option value="">— Select NF —</option>
          {nodes.filter(n => n.nfType !== 'DN').map(n => (
            <option key={n.id} value={n.podName}>{n.displayName} · {n.podName}</option>
          ))}
        </select>

        <select value={iface} onChange={e => setIface(e.target.value)}
          className="text-sm rounded px-2 py-1 outline-none shrink-0"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}>
          {(nodeIfaces.length > 0 ? nodeIfaces : ['eth0']).map(i => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>

        <div className="w-px h-5 shrink-0" style={{ background: '#30363d' }} />

        {/* CENTER — capture controls */}
        <div className="flex items-center gap-1.5">
          {paused ? (
            <button onClick={handleResume} className="px-2 py-1 rounded text-xs"
              style={{ background: '#238636', color: '#f0f6fc', border: '1px solid #2ea043' }}>
              ▶ Resume
            </button>
          ) : (
            <button onClick={handlePause} className="px-2 py-1 rounded text-xs"
              style={{ background: '#21262d', color: '#e6edf3', border: '1px solid #30363d' }}>
              ⏸ Pause
            </button>
          )}
          <button onClick={handleClear} className="px-2 py-1 rounded text-xs"
            style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}>
            🗑 Clear
          </button>
        </div>

        <div className="w-px h-5 shrink-0" style={{ background: '#30363d' }} />

        {/* CENTER — export */}
        <div className="flex items-center gap-1">
          {(['30s', '5min', '1h'] as const).map(lbl => (
            <a
              key={lbl}
              href={pod && iface
                ? `/api/packets/export?pod=${encodeURIComponent(pod)}&interface=${encodeURIComponent(iface)}&duration=${lbl}`
                : undefined}
              download
              className="px-1.5 py-1 rounded text-xs"
              style={{
                background: '#21262d', color: pod ? '#8b949e' : '#4a4a4a',
                border: '1px solid #30363d', textDecoration: 'none',
                cursor: pod ? 'pointer' : 'not-allowed',
                pointerEvents: pod ? 'auto' : 'none',
              }}
              title={pod ? `Download pcap — last ${lbl}` : 'Select NF first'}
            >
              ⬇ {lbl}
            </a>
          ))}
        </div>

        <div className="flex-1" />

        {/* RIGHT — live status badge */}
        <div className="flex items-center shrink-0">{statusBadge()}</div>
      </div>

      {/* ── FILTER BAR ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
        {PROTOCOLS.map(p => (
          <button key={p} onClick={() => setProtoFilter(p)}
            className="px-2 py-0.5 rounded font-mono text-xs transition-colors"
            style={{
              background: protoFilter === p ? '#1f6feb' : '#161b22',
              color:      protoFilter === p ? '#e6edf3' : '#8b949e',
              border:    `1px solid ${protoFilter === p ? '#388bfd' : '#30363d'}`,
            }}>
            {p}
          </button>
        ))}
        <div className="flex-1" />
        <input type="text" placeholder="🔍 IP, info…" value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded px-2 py-0.5 outline-none text-xs w-44"
          style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }} />
      </div>

      {/* ── MAIN AREA ────────────────────────────────────────────────────────── */}
      {!pod ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: '#6e7681' }}>
          <span className="text-4xl opacity-20">📡</span>
          <span className="text-sm">Select a Network Function to start live capture</span>
          <span style={{ color: '#30363d' }}>or click an interface dot in the Topology view</span>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">

          {/* Column headers */}
          <div className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] uppercase shrink-0"
            style={{ background: '#161b22', color: '#6e7681', borderBottom: '1px solid #21262d' }}>
            <span className="w-10 shrink-0 text-right">No.</span>
            <span className="w-24 shrink-0">Time</span>
            <span className="w-36 shrink-0">Source</span>
            <span className="w-36 shrink-0">Destination</span>
            <span className="w-20 shrink-0">Protocol</span>
            <span className="w-12 shrink-0 text-right">Length</span>
            <span className="flex-1">Info</span>
          </div>

          {/* Virtualized packet rows */}
          <div ref={tableRef} className="flex-1 overflow-y-auto font-mono"
            style={{ background: '#0d1117' }}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(item => {
                const pkt        = displayed[item.index]!
                const color      = protoColor(pkt.protocol)
                const isSelected = pkt.no === selectedNo
                return (
                  <div
                    key={item.key}
                    onClick={() => setSelectedNo(prev => prev === pkt.no ? null : pkt.no)}
                    style={{
                      position:   'absolute',
                      top:        item.start,
                      width:      '100%',
                      height:     item.size,
                      background: rowBg(pkt.protocol, isSelected),
                      borderLeft: isSelected ? '3px solid #58a6ff' : '3px solid transparent',
                    }}
                    className="flex items-center gap-2 px-3 cursor-pointer hover:brightness-125"
                  >
                    <span className="w-10 shrink-0 text-right select-text"
                      style={{ color: '#6e7681' }}>{pkt.no}</span>
                    <span className="w-24 shrink-0 tabular-nums select-text"
                      style={{ color: '#8b949e' }}>{fmtRelTime(pkt.ts, captureTs)}</span>
                    <span className="w-36 shrink-0 truncate select-text">{pkt.srcIP}</span>
                    <span className="w-36 shrink-0 truncate select-text">{pkt.dstIP}</span>
                    <span className="w-20 shrink-0 font-bold select-text"
                      style={{ color }}>{pkt.protocol}</span>
                    <span className="w-12 shrink-0 text-right select-text"
                      style={{ color: '#6e7681' }}>{pkt.length}</span>
                    <span className="flex-1 truncate select-text"
                      style={{ color: '#c9d1d9' }}>{pkt.info}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Decode panel — shown when a row is selected */}
          {selectedPkt && (
            <DecodePanel
              pkt={selectedPkt}
              startNs={captureTs}
              onClose={() => setSelectedNo(null)}
            />
          )}
        </div>
      )}

      {/* ── STATUS BAR ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-4 py-1 shrink-0 font-mono"
        style={{ background: '#161b22', borderTop: '1px solid #30363d', color: '#8b949e' }}>
        <span>Pkts: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong></span>
        <span style={{ color: '#30363d' }}>│</span>
        <span>Shown: <strong style={{ color: '#e6edf3' }}>{displayed.length}</strong></span>
        <span style={{ color: '#30363d' }}>│</span>
        <span>Buf: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong>/5,000</span>
      </div>
    </div>
  )
}
