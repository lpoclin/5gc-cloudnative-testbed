import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import cytoscape, { Core, ElementDefinition, EventObject, NodeSingular, EdgeSingular } from 'cytoscape'
import { useNavigate } from 'react-router-dom'
import type { TopologyGraph, TopologyNode, TopologyEdge } from '@/types/topology'

// ─── Props & internal types ────────────────────────────────────────────────────

interface Props {
  graph: TopologyGraph
  onNodeClick: (node: TopologyNode) => void
  onEdgeClick: (edge: TopologyEdge, sourceNode: TopologyNode) => void
  selectedNodeId?: string | null
  trafficEdgeIds?: Set<string>
  namespace?: string
}

interface NodeTip {
  node: TopologyNode
  pos: { x: number; y: number }
}

interface DotTip {
  node: TopologyNode
  iface: string
  pos: { x: number; y: number }
}

interface EndpointDot {
  x: number; y: number
  node: TopologyNode
  iface: string
  edge: TopologyEdge
  isActive: boolean
}

// ─── Colors ────────────────────────────────────────────────────────────────────

const BG          = '#0d1117'
const NODE_FILL   = '#e6edf3'
const NODE_BORDER = '#30363d'
const SIGNAL_CLR  = '#58a6ff'
const UP_CLR      = '#3fb950'
const MUTED       = '#8b949e'
const BADGE_OK    = '#3fb950'
const BADGE_WARN  = '#d29922'
const BADGE_ERR   = '#f85149'
const DOT_IDLE    = '#30363d'

// ─── 3GPP layout ───────────────────────────────────────────────────────────────

const SBI1_Y  = 60
const SBI2_Y  = 210
const SBI3_Y  = 340
const RAN_Y   = 500
const PSA_Y   = 680
const DN_Y    = 860

type ET = 'NSSF'|'NEF'|'NRF'|'PCF'|'AUSF'|'UDM'|'AMF'|'SMF'|'CHF'|'UDR'
        | 'UE'|'gNB'|'iUPF'|'UPF'|'PSA_UPF'|'DN'|'UNKNOWN'

const BASE_X: Partial<Record<ET,number>> = {
  NSSF:80, NEF:260, NRF:530, PCF:800,
  AUSF:150, UDM:380, AMF:530, SMF:700, CHF:870, UDR:380,
  UE:100, gNB:340, iUPF:640, UPF:530, PSA_UPF:530, DN:530, UNKNOWN:1050,
}
const BASE_Y: Partial<Record<ET,number>> = {
  NSSF:SBI1_Y, NEF:SBI1_Y, NRF:SBI1_Y, PCF:SBI1_Y,
  AUSF:SBI2_Y, UDM:SBI2_Y, AMF:SBI2_Y, SMF:SBI2_Y, CHF:SBI2_Y, UDR:SBI3_Y,
  UE:RAN_Y, gNB:RAN_Y, iUPF:RAN_Y, UPF:PSA_Y, PSA_UPF:PSA_Y, DN:DN_Y, UNKNOWN:SBI2_Y,
}

function et(n: TopologyNode): ET {
  if (n.nfType === 'UPF' && n.displayName.startsWith('PSA-UPF')) return 'PSA_UPF'
  return n.nfType as ET
}

function computePositions(
  nodes: TopologyNode[],
  saved?: Record<string,{x:number,y:number}>,
): Map<string,{x:number,y:number}> {
  const isULCL = nodes.some(n => n.nfType === 'iUPF')
  const groups = new Map<ET, TopologyNode[]>()
  const dns: TopologyNode[] = []
  for (const n of nodes) {
    if (n.nfType === 'DN') { dns.push(n); continue }
    const k = et(n)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }

  const pos = new Map<string,{x:number,y:number}>()
  if (saved) for (const n of nodes) if (saved[n.id]) pos.set(n.id, saved[n.id])

  for (const [type, group] of groups) {
    const bx = BASE_X[type] ?? 700
    const by = BASE_Y[type] ?? 400
    const sp = group.length > 1 ? 180 : 0
    group.forEach((n, i) => {
      if (pos.has(n.id)) return
      const off = (i - (group.length - 1) / 2) * sp
      pos.set(n.id, { x: bx + off, y: isULCL && type === 'UPF' ? PSA_Y : by })
    })
  }
  dns.forEach((n, i) => {
    if (pos.has(n.id)) return
    const off = (i - (dns.length - 1) / 2) * 200
    pos.set(n.id, { x: (BASE_X.DN ?? 530) + off, y: DN_Y })
  })
  return pos
}

// ─── Edge style by interface ────────────────────────────────────────────────────

function eStyle(iface: string): { lineColor:string; lineStyle:'solid'|'dashed'; width:number; opacity:number } {
  switch (iface) {
    case 'n1':  return { lineColor:'#f0f6fc', lineStyle:'solid',  width:0,   opacity:0    }
    case 'n2':  return { lineColor:SIGNAL_CLR,lineStyle:'solid',  width:2,   opacity:0.85 }
    case 'n3':  return { lineColor:UP_CLR,    lineStyle:'solid',  width:2,   opacity:0.85 }
    case 'n4':  return { lineColor:SIGNAL_CLR,lineStyle:'dashed', width:2,   opacity:0.85 }
    case 'n6':  return { lineColor:UP_CLR,    lineStyle:'solid',  width:2,   opacity:0.85 }
    case 'n9':  return { lineColor:UP_CLR,    lineStyle:'solid',  width:2,   opacity:0.85 }
    case 'sbi': return { lineColor:SIGNAL_CLR,lineStyle:'dashed', width:1.5, opacity:0.65 }
    default:    return { lineColor:NODE_BORDER,lineStyle:'dashed', width:1,   opacity:0.4  }
  }
}

function cni(iface: string): string {
  if (iface === 'eth0') return 'Cilium / eBPF'
  if (['n2','n3','n4','n6','n9'].includes(iface)) return 'Multus / ipvlan'
  if (iface === 'upfgtp') return 'kernel / gtp5g'
  if (iface === 'uesimtun0') return 'UERANSIM / TUN'
  return 'unknown'
}

// ─── Cytoscape stylesheet ────────────────────────────────────────────────────────

function buildStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': NODE_FILL,
        'border-color': NODE_BORDER,
        'border-width': 1.5,
        'label': 'data(label)',
        'color': BG,
        'font-size': 12,
        'font-weight': 'bold',
        'font-family': 'Inter, system-ui, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'width': 80,
        'height': 36,
        'shape': 'roundrectangle',
        'overlay-opacity': 0,
      } as cytoscape.Css.Node,
    },
    { selector: 'node.sm', style: { 'width': 70 } as cytoscape.Css.Node },
    {
      selector: 'node:selected',
      style: { 'border-color': SIGNAL_CLR, 'border-width': 2.5, 'background-color': '#d4e8ff' } as cytoscape.Css.Node,
    },
    {
      selector: 'node.hover',
      style: { 'border-color': SIGNAL_CLR, 'border-width': 2 } as cytoscape.Css.Node,
    },
    {
      selector: 'node[status = "CrashLoopBackOff"], node[status = "Error"], node[status = "OOMKilled"]',
      style: { 'border-color': BADGE_ERR, 'border-width': 2 } as cytoscape.Css.Node,
    },
    {
      selector: 'node[status = "Pending"], node[status = "Unknown"]',
      style: { 'border-color': BADGE_WARN } as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'none',
        'line-color': 'data(lineColor)',
        'line-style': 'data(lineStyle)',
        'line-dash-pattern': 'data(dashPattern)',
        'width': 'data(width)',
        'opacity': 'data(opacity)',
        'overlay-opacity': 0,
        'label': 'data(label)',
        'font-size': 9,
        'color': MUTED,
        'text-rotation': 'autorotate',
        'text-background-color': BG,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
      } as unknown as cytoscape.Css.Edge,
    },
    { selector: 'edge.hover',    style: { 'opacity': 1 } as cytoscape.Css.Edge },
    { selector: 'edge:selected', style: { 'opacity': 1, 'overlay-opacity': 0 } as cytoscape.Css.Edge },
    { selector: '.faded',        style: { 'opacity': 0.08 } as cytoscape.Css.Node & cytoscape.Css.Edge },
  ]
}

// ─── Cytoscape elements ──────────────────────────────────────────────────────────

function buildElements(
  graph: TopologyGraph,
  positions: Map<string,{x:number,y:number}>,
): ElementDefinition[] {
  const els: ElementDefinition[] = []

  for (const node of graph.nodes) {
    const pos = positions.get(node.id) ?? { x: 700, y: 400 }
    const sm = node.nfType === 'gNB' || node.nfType === 'UE' || node.nfType === 'DN'
    els.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.displayName,
        status: node.status.condition,
        restarts: node.status.restarts,
        _node: node,
      },
      classes: sm ? 'sm' : undefined,
      position: pos,
    })
  }

  for (const edge of graph.edges) {
    const s = eStyle(edge.interface)
    els.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label || edge.interface.toUpperCase(),
        lineColor: s.lineColor,
        lineStyle: s.lineStyle,
        dashPattern: s.lineStyle === 'dashed' ? [6, 4] : [1, 0],
        width: s.width,
        opacity: s.opacity,
        iface: edge.interface,
        _edge: edge,
      },
    })
  }
  return els
}

// ─── Canvas overlay ──────────────────────────────────────────────────────────────

function badgeColor(status: string, restarts: number): string {
  if (['CrashLoopBackOff','Error','OOMKilled'].includes(status)) return BADGE_ERR
  if (status === 'Pending' || status === 'Unknown') return BADGE_WARN
  if (restarts > 3) return BADGE_WARN
  return BADGE_OK
}

function drawArcs(
  ctx: CanvasRenderingContext2D,
  src: {x:number,y:number}, dst: {x:number,y:number},
  phase: number, active: boolean,
) {
  const angle = Math.atan2(dst.y - src.y, dst.x - src.x)
  const spread = Math.PI * 0.45

  for (let i = 0; i < 3; i++) {
    const p = ((phase + i / 3) % 1)
    const r = 12 + p * 30
    const a = (1 - p) * (active ? 0.85 : 0.2)
    ctx.save()
    ctx.translate(src.x, src.y)
    ctx.beginPath()
    ctx.arc(0, 0, r, angle - spread, angle + spread)
    ctx.strokeStyle = '#f0f6fc'
    ctx.globalAlpha = a
    ctx.lineWidth = active ? 1.5 : 1
    ctx.stroke()
    ctx.restore()
  }
}

function drawEndDot(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, color: string, active: boolean, t: number,
) {
  if (active) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4)
    ctx.beginPath()
    ctx.arc(x, y, 5 + pulse * 4, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.25 * (1 - pulse * 0.5)
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = BG
  ctx.lineWidth = 1.5
  ctx.stroke()
}

function runDraw(
  canvas: HTMLCanvasElement | null,
  cy: Core | null,
  t: number,
  traffic: Set<string>,
  dotsRef: { current: EndpointDot[] },
  nodeMap: Map<string, TopologyNode>,
) {
  if (!canvas || !cy) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const pan  = cy.pan()
  const zoom = cy.zoom()
  const toS  = (p: {x:number,y:number}) => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y })

  const dots: EndpointDot[] = []

  // Health badges
  cy.nodes().forEach(cn => {
    const p = cn.renderedPosition()
    const w = cn.renderedWidth()
    const h = cn.renderedHeight()
    const color = badgeColor(cn.data('status') as string, (cn.data('restarts') as number) ?? 0)
    const bx = p.x + w / 2 - 5
    const by = p.y + h / 2 - 5

    ctx.beginPath()
    ctx.arc(bx, by, 4, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = BG
    ctx.lineWidth = 1.5
    ctx.stroke()

    if (color !== BADGE_OK) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3)
      ctx.beginPath()
      ctx.arc(bx, by, 4 + pulse * 3, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.4 * (1 - pulse)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  })

  // Wireless arcs N1
  cy.edges().filter(e => e.data('iface') === 'n1').forEach(e => {
    const sp = (e.source() as NodeSingular).renderedPosition()
    const dp = (e.target() as NodeSingular).renderedPosition()
    const active = traffic.has(e.id())
    drawArcs(ctx, sp, dp, (t * 0.8) % 1, active)
    drawArcs(ctx, dp, sp, (t * 0.65 + 0.5) % 1, active)
  })

  // Traffic moving dots
  cy.edges().forEach(ce => {
    if (ce.data('iface') === 'n1') return
    if (!traffic.has(ce.id())) return
    const srcEp = toS(ce.sourceEndpoint())
    const dstEp = toS(ce.targetEndpoint())
    const lc = ce.data('lineColor') as string

    for (let i = 0; i < 3; i++) {
      const ph = ((t * 0.55 + i / 3) % 1)
      const x = srcEp.x + (dstEp.x - srcEp.x) * ph
      const y = srcEp.y + (dstEp.y - srcEp.y) * ph
      const alpha = Math.max(0, 1 - Math.abs(ph - 0.5) * 2.5)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = lc
      ctx.globalAlpha = alpha
      ctx.fill()
    }
    ctx.globalAlpha = 1
  })

  // Endpoint dots
  cy.edges().forEach(ce => {
    const iface = ce.data('iface') as string
    if (iface === 'n1' || iface === 'sbi') return
    const edgeData = ce.data('_edge') as TopologyEdge
    if (!edgeData) return

    const srcEp  = toS(ce.sourceEndpoint())
    const dstEp  = toS(ce.targetEndpoint())
    const lc     = ce.data('lineColor') as string
    const active = traffic.has(ce.id())
    const color  = active ? lc : DOT_IDLE

    const srcN = nodeMap.get(edgeData.source)
    const dstN = nodeMap.get(edgeData.target)

    if (srcN) {
      drawEndDot(ctx, srcEp.x, srcEp.y, color, active, t)
      dots.push({ x: srcEp.x, y: srcEp.y, node: srcN, iface, edge: edgeData, isActive: active })
    }
    if (dstN) {
      drawEndDot(ctx, dstEp.x, dstEp.y, color, active, t)
      dots.push({ x: dstEp.x, y: dstEp.y, node: dstN, iface, edge: edgeData, isActive: active })
    }
  })

  dotsRef.current = dots
}

// ─── Tooltip components ──────────────────────────────────────────────────────────

function condColor(c: string) {
  if (c === 'Running') return 'text-green-500'
  if (['CrashLoopBackOff','Error','OOMKilled'].includes(c)) return 'text-red-400'
  if (c === 'Pending') return 'text-yellow-400'
  return 'text-slate-400'
}

function NodeTipBox({ tip }: { tip: NodeTip }) {
  const n = tip.node
  const style: React.CSSProperties = {
    position: 'absolute',
    left: tip.pos.x + 14,
    top: Math.max(4, tip.pos.y - 10),
    zIndex: 50,
    pointerEvents: 'none',
    maxWidth: 280,
    background: '#161b22',
    border: `1px solid ${NODE_BORDER}`,
  }
  if (tip.pos.x > 800) { style.left = undefined; style.right = 14 }
  return (
    <div style={style} className="rounded-lg p-3 text-xs shadow-2xl">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-bold text-sm" style={{ color: '#e6edf3' }}>{n.displayName}</span>
        <span className={`font-medium ${condColor(n.status.condition)}`}>● {n.status.condition}</span>
      </div>
      <div className="font-mono mb-1.5" style={{ color: MUTED }}>Pod: {n.podName}</div>

      {n.interfaces.length > 0 && (
        <div className="space-y-0.5 mb-1.5">
          {n.interfaces.map(iface => (
            <div key={iface.interface} className="flex gap-2">
              <span className="w-20 shrink-0 font-mono" style={{ color: SIGNAL_CLR }}>
                {iface.interface}:
              </span>
              <span className="font-mono" style={{ color: '#e6edf3' }}>
                {iface.ips.join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-4 pt-1.5" style={{ borderTop: `1px solid ${NODE_BORDER}`, color: MUTED }}>
        {n.status.restarts > 0 && (
          <span style={{ color: BADGE_WARN }}>↺ {n.status.restarts} restarts</span>
        )}
        <span>Age: {n.age}</span>
        {n.nodeName && <span>Node: {n.nodeName}</span>}
      </div>
      <div className="mt-1.5" style={{ color: MUTED }}>[Click for logs &amp; metrics]</div>
    </div>
  )
}

function DotTipBox({ tip, onCapture }: { tip: DotTip; onCapture: () => void }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: tip.pos.x + 14,
    top: Math.max(4, tip.pos.y - 10),
    zIndex: 50,
    maxWidth: 260,
    background: '#161b22',
    border: `1px solid ${NODE_BORDER}`,
    pointerEvents: 'auto',
  }
  if (tip.pos.x > 800) { style.left = undefined; style.right = 14 }
  return (
    <div style={style} className="rounded-lg p-3 text-xs shadow-2xl">
      <div className="font-bold mb-0.5" style={{ color: '#e6edf3' }}>
        {tip.node.displayName} : {tip.iface}
      </div>
      <div className="font-mono mb-1.5" style={{ color: MUTED }}>
        {tip.node.interfaces.find(i => i.interface === tip.iface)?.ips[0] ?? ''}
      </div>
      <div className="mb-1" style={{ color: MUTED }}>CNI: {cni(tip.iface)}</div>
      <button
        onClick={onCapture}
        className="mt-1 w-full text-center rounded py-1 text-xs font-medium"
        style={{ background: '#1f6feb', color: '#e6edf3', pointerEvents: 'auto' }}
      >
        ▶ Live Capture
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────────

export default function TopologyCanvas({
  graph,
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  trafficEdgeIds,
  namespace = 'free5gc',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef   = useRef<HTMLCanvasElement>(null)
  const cyRef        = useRef<Core | null>(null)
  const dotsRef      = useRef<EndpointDot[]>([])
  const mousePos     = useRef({ x: 0, y: 0 })
  const nodeTipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dotTipTimer  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const trafficRef   = useRef(trafficEdgeIds ?? new Set<string>())

  const [nodeTip, setNodeTip] = useState<NodeTip | null>(null)
  const [dotTip,  setDotTip]  = useState<DotTip | null>(null)

  const navigate = useNavigate()

  const storageKey = `5g-observer-positions-${namespace}`

  // Keep trafficRef current without restarting RAF
  useEffect(() => { trafficRef.current = trafficEdgeIds ?? new Set() }, [trafficEdgeIds])

  const nodeMap = useMemo(() => {
    const m = new Map<string, TopologyNode>()
    for (const n of graph.nodes) m.set(n.id, n)
    return m
  }, [graph.nodes])

  // Load saved positions
  const savedPositions = useMemo<Record<string,{x:number,y:number}> | undefined>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? undefined }
    catch { return undefined }
  }, [storageKey])

  const positions = useMemo(
    () => computePositions(graph.nodes, savedPositions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes],
  )

  // ── Resize canvas overlay to match container ─────────────────────────────
  useEffect(() => {
    const canvas = overlayRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ro = new ResizeObserver(() => {
      canvas.width  = container.clientWidth
      canvas.height = container.clientHeight
    })
    ro.observe(container)
    canvas.width  = container.clientWidth
    canvas.height = container.clientHeight
    return () => ro.disconnect()
  }, [])

  // ── Continuous RAF animation loop ────────────────────────────────────────
  useEffect(() => {
    let raf: number
    const loop = (time: number) => {
      runDraw(overlayRef.current, cyRef.current, time / 1000, trafficRef.current, dotsRef, nodeMap)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [nodeMap])

  // ── Init Cytoscape ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const cy = cytoscape({
      container: containerRef.current,
      elements: buildElements(graph, positions),
      style: buildStylesheet(),
      layout: { name: 'preset' },
      minZoom: 0.25,
      maxZoom: 4,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })

    cyRef.current = cy
    cy.fit(cy.nodes(), 60)

    // Track mouse position relative to container
    const onMove = (e: MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect()
      if (r) mousePos.current = { x: e.clientX - r.left, y: e.clientY - r.top }

      // Dot hover detection
      const mx = mousePos.current.x
      const my = mousePos.current.y
      let hit: EndpointDot | null = null
      for (const d of dotsRef.current) {
        const dx = mx - d.x, dy = my - d.y
        if (Math.sqrt(dx*dx + dy*dy) < 9) { hit = d; break }
      }
      if (hit) {
        clearTimeout(dotTipTimer.current)
        const snap = { ...mousePos.current }
        const h = hit
        dotTipTimer.current = setTimeout(() => {
          setDotTip({ node: h.node, iface: h.iface, pos: snap })
          setNodeTip(null)
        }, 200)
      } else {
        clearTimeout(dotTipTimer.current)
        setDotTip(null)
      }
    }

    const onClick = (e: MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect()
      if (!r) return
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      for (const d of dotsRef.current) {
        const dx = mx - d.x, dy = my - d.y
        if (Math.sqrt(dx*dx + dy*dy) < 9) {
          navigate(`/captures?pod=${d.node.podName}&interface=${d.iface}`)
          return
        }
      }
    }

    containerRef.current.addEventListener('mousemove', onMove)
    containerRef.current.addEventListener('click', onClick)

    // Node events
    cy.on('tap', 'node', (e: EventObject) => {
      const raw = (e.target as NodeSingular).data('_node') as TopologyNode
      if (raw) onNodeClick(raw)
    })

    cy.on('mouseover', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).addClass('hover')
      clearTimeout(nodeTipTimer.current)
      const raw = (e.target as NodeSingular).data('_node') as TopologyNode
      if (!raw) return
      const snap = { ...mousePos.current }
      nodeTipTimer.current = setTimeout(() => setNodeTip({ node: raw, pos: snap }), 200)
    })

    cy.on('mouseout', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).removeClass('hover')
      clearTimeout(nodeTipTimer.current)
      setNodeTip(null)
    })

    cy.on('tap', 'edge', (e: EventObject) => {
      const raw = (e.target as EdgeSingular).data('_edge') as TopologyEdge
      const src = graph.nodes.find(n => n.id === (e.target as EdgeSingular).data('source'))
      if (raw && src) onEdgeClick(raw, src)
    })

    cy.on('mouseover', 'edge', (e: EventObject) => {
      ;(e.target as EdgeSingular).addClass('hover')
    })
    cy.on('mouseout', 'edge', (e: EventObject) => {
      ;(e.target as EdgeSingular).removeClass('hover')
    })

    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) { cy.elements().unselect(); setNodeTip(null) }
    })

    // Save positions on node drag end
    cy.on('dragfree', 'node', () => {
      const saved: Record<string,{x:number,y:number}> = {}
      cy.nodes().forEach(n => { saved[n.id()] = n.position() })
      try { localStorage.setItem(storageKey, JSON.stringify(saved)) } catch { /* quota */ }
    })

    return () => {
      clearTimeout(nodeTipTimer.current)
      clearTimeout(dotTipTimer.current)
      containerRef.current?.removeEventListener('mousemove', onMove)
      containerRef.current?.removeEventListener('click', onClick)
      cy.destroy()
      cyRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update elements without destroying cy ────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const newPos = computePositions(graph.nodes)
    const elements = buildElements(graph, newPos)

    cy.batch(() => {
      const newIds = new Set(elements.map(e => e.data.id as string))
      cy.elements().forEach(el => { if (!newIds.has(el.id())) el.remove() })
      for (const el of elements) {
        const ex = cy.getElementById(el.data.id as string)
        if (ex.length > 0) {
          ex.data(el.data)
          if (el.group === 'nodes' && el.position && !ex.grabbed()) ex.position(el.position)
        } else {
          cy.add(el)
        }
      }
    })
  }, [graph])

  // ── Selected highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().unselect()
    if (selectedNodeId) cy.getElementById(selectedNodeId).select()
  }, [selectedNodeId])

  // ── Reset layout ─────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    try { localStorage.removeItem(storageKey) } catch { /* ok */ }
    const cy = cyRef.current
    if (!cy) return
    const newPos = computePositions(graph.nodes)
    cy.batch(() => {
      cy.nodes().forEach(n => {
        const p = newPos.get(n.id())
        if (p) n.animate({ position: p } as Parameters<typeof n.animate>[0], { duration: 300 })
      })
    })
  }, [graph.nodes, storageKey])

  const handleFit = useCallback(() => { cyRef.current?.fit(undefined, 60) }, [])

  const isULCL = graph.nodes.some(n => n.nfType === 'iUPF')

  const handleCapture = useCallback((dot: DotTip) => {
    navigate(`/captures?pod=${dot.node.podName}&interface=${dot.iface}`)
  }, [navigate])

  return (
    <div className="relative w-full h-full" style={{ background: BG }}>
      {/* Cytoscape container */}
      <div ref={containerRef} className="w-full h-full" style={{ background: BG }} />

      {/* Canvas overlay — health badges, arcs, traffic dots, endpoint dots */}
      <canvas
        ref={overlayRef}
        className="absolute inset-0"
        style={{ pointerEvents: 'none', zIndex: 10 }}
      />

      {/* Node hover tooltip */}
      {nodeTip && !dotTip && <NodeTipBox tip={nodeTip} />}

      {/* Dot hover tooltip */}
      {dotTip && <DotTipBox tip={dotTip} onCapture={() => handleCapture(dotTip)} />}

      {/* Header info */}
      <div className="absolute top-3 left-3 flex items-center gap-2" style={{ zIndex: 20 }}>
        <span className="text-xs font-mono" style={{ color: MUTED }}>
          {graph.nodes.length} NFs · {graph.edges.length} links
        </span>
        {isULCL && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium"
            style={{ background: '#1f4d2e', color: UP_CLR, border: `1px solid #2d6a3f` }}>
            ULCL
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5" style={{ zIndex: 20 }}>
        <button
          onClick={handleReset}
          className="text-xs px-2 py-1 rounded border font-mono"
          style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, color: MUTED }}
          title="Reset layout to default positions"
        >
          ⊟ Reset
        </button>
        <button
          onClick={handleFit}
          className="text-xs px-2 py-1 rounded border font-mono"
          style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, color: MUTED }}
          title="Fit all nodes in view"
        >
          ⊞ Fit
        </button>
      </div>

      {/* Legend */}
      <div
        className="absolute bottom-4 left-4 rounded-lg p-2.5 text-xs"
        style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, zIndex: 20 }}
      >
        <div className="mb-1 font-medium" style={{ color: MUTED }}>Interfaces</div>
        {([
          [SIGNAL_CLR, 'Signaling (N2, SBI)', false],
          [SIGNAL_CLR, 'PFCP / N4', true],
          [UP_CLR,     'User plane (N3, N6, N9)', false],
          ['#f0f6fc',  'Wireless N1 (arcs)', false],
        ] as [string,string,boolean][]).map(([color, label, dashed]) => (
          <div key={label} className="flex items-center gap-2 mb-0.5">
            <svg width="20" height="8">
              {dashed
                ? <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2" strokeDasharray="4 3"/>
                : <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2"/>
              }
            </svg>
            <span style={{ color: MUTED }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
