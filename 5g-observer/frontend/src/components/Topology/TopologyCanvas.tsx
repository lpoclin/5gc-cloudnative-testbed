import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import cytoscape, {
  Core, ElementDefinition, EventObject,
  NodeSingular, EdgeSingular,
} from 'cytoscape'
import { getNFIcon, getNFColor } from '@/components/common/icons'
import type { TopologyGraph, TopologyNode, TopologyEdge, NFType, Plane } from '@/types/topology'

interface Props {
  graph: TopologyGraph
  onNodeClick: (node: TopologyNode) => void
  onEdgeClick: (edge: TopologyEdge, sourceNode: TopologyNode) => void
  selectedNodeId?: string | null
  trafficEdgeIds?: Set<string>
}

// ─── Tooltip state ────────────────────────────────────────────────────────────

interface TooltipState {
  type: 'node' | 'edge'
  node?: TopologyNode
  edge?: TopologyEdge
  pos: { x: number; y: number }
}

// ─── 3GPP TS 23.501 layout — horizontal left-to-right ─────────────────────────
// Coordinate space chosen to fit a 1100×960 viewport.
// SBI bus (top) → Control plane (middle) → RAN+User plane (bottom).

const SBI_ROW1_Y = 60    // NSSF, NEF, NRF, PCF — top SBI row
const SBI_ROW2_Y = 210   // AUSF, UDM, AMF, SMF, CHF — second SBI row
const SBI_ROW3_Y = 340   // UDR
const RAN_Y      = 500   // UE, gNB
const IUPF_Y     = 500   // iUPF same row as gNB (ULCL mode)
const PSA_UPF_Y  = 680   // PSA-UPFs (ULCL) or single UPF
const DN_Y       = 860   // Data networks

// Base X centres per NF type (single instance, multiple are spread ±spacing)
const BASE_X: Partial<Record<NFType | 'PSA_UPF', number>> = {
  NSSF:    80,
  NEF:     260,
  NRF:     530,
  PCF:     800,
  AUSF:    150,
  UDM:     370,
  AMF:     530,
  SMF:     700,
  CHF:     870,
  UDR:     370,
  UE:      100,
  gNB:     370,
  iUPF:    660,
  UPF:     530,   // single-UPF mode centre
  PSA_UPF: 530,   // PSA-UPFs in ULCL mode
  DN:      530,
  UNKNOWN: 1050,
}

const BASE_Y: Partial<Record<NFType | 'PSA_UPF', number>> = {
  NSSF: SBI_ROW1_Y, NEF: SBI_ROW1_Y, NRF: SBI_ROW1_Y, PCF: SBI_ROW1_Y,
  AUSF: SBI_ROW2_Y, UDM: SBI_ROW2_Y, AMF: SBI_ROW2_Y, SMF: SBI_ROW2_Y, CHF: SBI_ROW2_Y,
  UDR:  SBI_ROW3_Y,
  UE: RAN_Y, gNB: RAN_Y,
  iUPF: IUPF_Y,
  UPF:     PSA_UPF_Y,  // single-UPF mode
  PSA_UPF: PSA_UPF_Y,  // ULCL PSA-UPFs
  DN: DN_Y,
  UNKNOWN: SBI_ROW2_Y,
}

// A UPF node is a PSA-UPF when its display name starts with "PSA-UPF"
function isPSAUPF(node: TopologyNode): boolean {
  return node.nfType === 'UPF' && node.displayName.startsWith('PSA-UPF')
}

function effectiveType(node: TopologyNode): NFType | 'PSA_UPF' {
  return isPSAUPF(node) ? 'PSA_UPF' : node.nfType
}

function computePositions(nodes: TopologyNode[]): Map<string, { x: number; y: number }> {
  const isULCL = nodes.some(n => n.nfType === 'iUPF')

  // Group non-DN nodes by effective type
  const groups = new Map<string, TopologyNode[]>()
  const dnNodes: TopologyNode[] = []

  for (const n of nodes) {
    if (n.nfType === 'DN') {
      dnNodes.push(n)
      continue
    }
    const k = effectiveType(n)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }

  const positions = new Map<string, { x: number; y: number }>()

  for (const [type, group] of groups) {
    // In single-UPF mode, UPF sits centre; in ULCL it's PSA_UPF that's spread
    const bx = BASE_X[type as NFType] ?? 700
    const by = BASE_Y[type as NFType] ?? 400
    const total = group.length
    const spacing = total > 1 ? 170 : 0

    group.forEach((node, i) => {
      const offset = (i - (total - 1) / 2) * spacing
      positions.set(node.id, { x: bx + offset, y: isULCL && type === 'UPF' ? PSA_UPF_Y : by })
    })
  }

  // DN nodes: spread horizontally below UPF positions
  if (dnNodes.length === 1) {
    positions.set(dnNodes[0].id, { x: BASE_X['DN'] ?? 530, y: DN_Y })
  } else {
    const spacing = 200
    dnNodes.forEach((dn, i) => {
      const offset = (i - (dnNodes.length - 1) / 2) * spacing
      positions.set(dn.id, { x: (BASE_X['DN'] ?? 530) + offset, y: DN_Y })
    })
  }

  return positions
}

// ─── Edge plane styles ─────────────────────────────────────────────────────────

const PLANE_STYLE: Record<Plane, {
  lineColor: string
  lineStyle: 'solid' | 'dashed' | 'dotted'
  width: number
  dashPattern?: number[]
}> = {
  sbi:        { lineColor: '#3b82f6', lineStyle: 'dashed', width: 1.5, dashPattern: [6, 4] },
  userplane:  { lineColor: '#22c55e', lineStyle: 'solid',  width: 2.5 },
  ran:        { lineColor: '#f97316', lineStyle: 'solid',  width: 2   },
  pfcp:       { lineColor: '#a855f7', lineStyle: 'dashed', width: 1.5, dashPattern: [4, 3] },
  management: { lineColor: '#6b7280', lineStyle: 'dotted', width: 1   },
}

// ─── Cytoscape stylesheet ──────────────────────────────────────────────────────

function buildStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': '#151e35',
        'background-image': 'data(icon)',
        'background-fit': 'contain',
        'background-clip': 'none',
        'border-color': 'data(borderColor)',
        'border-width': 2,
        'label': 'data(label)',
        'color': '#94a3b8',
        'font-size': 10,
        'font-family': 'system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'width': 56,
        'height': 56,
        'shape': 'roundrectangle',
        'overlay-opacity': 0,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': '#60a5fa',
        'border-width': 3,
        'background-color': '#1e2d50',
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node.hover',
      style: {
        'border-color': '#e2e8f0',
        'border-width': 2.5,
        'background-color': '#1e2d50',
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node[status = "CrashLoopBackOff"], node[status = "Error"], node[status = "OOMKilled"]',
      style: { 'border-color': '#ef4444' } as cytoscape.Css.Node,
    },
    {
      selector: 'node[status = "Pending"], node[status = "Unknown"]',
      style: { 'border-color': '#6b7280' } as cytoscape.Css.Node,
    },
    {
      selector: 'node.dn',
      style: {
        'width': 70,
        'height': 44,
        'shape': 'ellipse',
      } as cytoscape.Css.Node,
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
        'opacity': 0.75,
        'overlay-opacity': 0,
        // Edge labels
        'label': 'data(label)',
        'font-size': 9,
        'color': '#64748b',
        'text-rotation': 'autorotate',
        'text-background-color': '#0a0e1a',
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
      } as unknown as cytoscape.Css.Edge,
    },
    {
      selector: 'edge:selected',
      style: {
        'opacity': 1,
        'width': 'mapData(width, 0, 4, 3, 6)',
        'overlay-opacity': 0,
      } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge.hover',
      style: { 'opacity': 1, 'color': '#cbd5e1' } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge.traffic',
      style: {
        'line-dash-pattern': [8, 4],
        'line-dash-offset': 0,
        'opacity': 1,
      } as cytoscape.Css.Edge,
    },
    {
      selector: '.faded',
      style: { 'opacity': 0.15 } as cytoscape.Css.Node & cytoscape.Css.Edge,
    },
  ]
}

// ─── Build Cytoscape elements ──────────────────────────────────────────────────

function buildElements(
  graph: TopologyGraph,
  positions: Map<string, { x: number; y: number }>,
): ElementDefinition[] {
  const els: ElementDefinition[] = []

  for (const node of graph.nodes) {
    const pos = positions.get(node.id) ?? { x: 700, y: 400 }
    const plane: Plane = (['gNB', 'UE'] as NFType[]).includes(node.nfType)
      ? 'ran'
      : (['UPF', 'iUPF'] as NFType[]).includes(node.nfType)
        ? 'userplane'
        : node.nfType === 'DN' ? 'management' : 'sbi'

    const pStyle = PLANE_STYLE[plane]

    els.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.displayName,
        icon: getNFIcon(node.nfType),
        borderColor: getNFColor(node.nfType),
        status: node.status.condition,
        restarts: node.status.restarts,
        plane,
        lineColor: pStyle.lineColor,
        _node: node,
      },
      classes: node.nfType === 'DN' ? 'dn' : '',
      position: pos,
    })
  }

  for (const edge of graph.edges) {
    const pStyle = PLANE_STYLE[edge.plane] ?? PLANE_STYLE.management
    els.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label || edge.interface.toUpperCase(),
        lineColor: pStyle.lineColor,
        lineStyle: pStyle.lineStyle,
        dashPattern: pStyle.dashPattern ?? [6, 6],
        width: pStyle.width,
        plane: edge.plane,
        _edge: edge,
      },
    })
  }

  return els
}

// ─── Tooltip helpers ───────────────────────────────────────────────────────────

function conditionColor(cond: string): string {
  switch (cond) {
    case 'Running':          return 'text-green-400'
    case 'CrashLoopBackOff': return 'text-red-400'
    case 'OOMKilled':        return 'text-red-500'
    case 'Error':            return 'text-red-400'
    case 'Pending':          return 'text-yellow-400'
    default:                 return 'text-slate-400'
  }
}

function NodeTooltip({ node, pos }: { node: TopologyNode; pos: { x: number; y: number } }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: pos.x + 14,
    top: pos.y - 10,
    zIndex: 50,
    pointerEvents: 'none',
    maxWidth: 260,
  }
  // Flip left when too close to right edge
  if (pos.x > 800) style.left = undefined, style.right = '14px'

  return (
    <div style={style} className="bg-bg-secondary/95 border border-border rounded-lg p-3 shadow-xl text-xs backdrop-blur-sm">
      <div className="font-semibold text-sm text-text-primary mb-0.5">{node.displayName}</div>
      <div className="text-slate-400 font-mono mb-1 truncate">{node.podName}</div>

      <div className="flex items-center gap-2 mb-1">
        <span className={conditionColor(node.status.condition)}>{node.status.condition}</span>
        {node.status.restarts > 0 && (
          <span className="text-red-400">{node.status.restarts} restart{node.status.restarts > 1 ? 's' : ''}</span>
        )}
      </div>

      {node.interfaces.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {node.interfaces.map(iface => (
            <div key={iface.interface} className="flex gap-1.5">
              <span className="text-slate-500 shrink-0">{iface.interface || 'eth'}</span>
              <span className="text-slate-300 font-mono truncate">{iface.ips.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1.5 pt-1.5 border-t border-border/50 flex flex-col gap-0.5 text-slate-500">
        {node.nodeName && <span>node: {node.nodeName}</span>}
        <span>age: {node.age}</span>
      </div>
    </div>
  )
}

function EdgeTooltip({ edge, pos }: { edge: TopologyEdge; pos: { x: number; y: number } }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: pos.x + 14,
    top: pos.y - 10,
    zIndex: 50,
    pointerEvents: 'none',
    maxWidth: 220,
  }
  if (pos.x > 800) style.left = undefined, style.right = '14px'

  return (
    <div style={style} className="bg-bg-secondary/95 border border-border rounded-lg p-3 shadow-xl text-xs backdrop-blur-sm">
      <div className="font-semibold text-sm text-text-primary mb-0.5">{edge.label || edge.interface.toUpperCase()}</div>
      <div className="text-slate-400 capitalize mb-1">{edge.plane} plane</div>
      {edge.srcIP && (
        <div className="font-mono text-slate-300">{edge.srcIP} → {edge.dstIP}</div>
      )}
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function TopologyCanvas({
  graph,
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  trafficEdgeIds,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef        = useRef<Core | null>(null)
  const animFrameRef = useRef<number | undefined>(undefined)
  const mousePos     = useRef({ x: 0, y: 0 })
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const positions = useMemo(() => computePositions(graph.nodes), [graph.nodes])

  // ── Init Cytoscape ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const cy = cytoscape({
      container: containerRef.current,
      elements: buildElements(graph, positions),
      style: buildStylesheet(),
      layout: { name: 'preset' },
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })

    cyRef.current = cy
    cy.fit(cy.nodes(), 60)

    // Track raw mouse position inside the container
    const onMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        mousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      }
    }
    containerRef.current.addEventListener('mousemove', onMouseMove)

    // ── Node interactions ──────────────────────────────────────────────────
    cy.on('tap', 'node', (e: EventObject) => {
      const raw = (e.target as NodeSingular).data('_node') as TopologyNode
      if (raw) onNodeClick(raw)
    })

    cy.on('mouseover', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).addClass('hover')
      clearTimeout(tooltipTimer.current)
      const raw = (e.target as NodeSingular).data('_node') as TopologyNode
      if (!raw) return
      const snap = { ...mousePos.current }
      tooltipTimer.current = setTimeout(() => {
        setTooltip({ type: 'node', node: raw, pos: snap })
      }, 200)
    })

    cy.on('mouseout', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).removeClass('hover')
      clearTimeout(tooltipTimer.current)
      setTooltip(null)
    })

    // ── Edge interactions ──────────────────────────────────────────────────
    cy.on('tap', 'edge', (e: EventObject) => {
      const rawEdge = (e.target as EdgeSingular).data('_edge') as TopologyEdge
      const sourceNode = graph.nodes.find(n => n.id === (e.target as EdgeSingular).data('source'))
      if (rawEdge && sourceNode) onEdgeClick(rawEdge, sourceNode)
    })

    cy.on('mouseover', 'edge', (e: EventObject) => {
      ;(e.target as EdgeSingular).addClass('hover')
      clearTimeout(tooltipTimer.current)
      const raw = (e.target as EdgeSingular).data('_edge') as TopologyEdge
      if (!raw) return
      const snap = { ...mousePos.current }
      tooltipTimer.current = setTimeout(() => {
        setTooltip({ type: 'edge', edge: raw, pos: snap })
      }, 200)
    })

    cy.on('mouseout', 'edge', (e: EventObject) => {
      ;(e.target as EdgeSingular).removeClass('hover')
      clearTimeout(tooltipTimer.current)
      setTooltip(null)
    })

    // ── Background tap: deselect ───────────────────────────────────────────
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) cy.elements().unselect()
    })

    return () => {
      clearTimeout(tooltipTimer.current)
      cancelAnimationFrame(animFrameRef.current ?? 0)
      containerRef.current?.removeEventListener('mousemove', onMouseMove)
      cy.destroy()
      cyRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update elements when graph changes ────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    const newPositions = computePositions(graph.nodes)
    const elements = buildElements(graph, newPositions)

    cy.batch(() => {
      const newIds = new Set(elements.map(e => e.data.id as string))
      cy.elements().forEach(el => { if (!newIds.has(el.id())) el.remove() })

      for (const el of elements) {
        const existing = cy.getElementById(el.data.id as string)
        if (existing.length > 0) {
          existing.data(el.data)
          if (el.group === 'nodes' && el.position) existing.position(el.position)
        } else {
          cy.add(el)
        }
      }
    })
  }, [graph])

  // ── Selected node highlight ───────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().unselect()
    if (selectedNodeId) cy.getElementById(selectedNodeId).select()
  }, [selectedNodeId])

  // ── Traffic animation ─────────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    cy.edges().removeClass('traffic')
    trafficEdgeIds?.forEach(id => cy.getElementById(id).addClass('traffic'))

    let offset = 0
    const animate = () => {
      offset = (offset - 1.5) % 100
      cy.edges('.traffic').style('line-dash-offset', offset)
      animFrameRef.current = requestAnimationFrame(animate)
    }

    if (trafficEdgeIds && trafficEdgeIds.size > 0) {
      animFrameRef.current = requestAnimationFrame(animate)
    }

    return () => cancelAnimationFrame(animFrameRef.current ?? 0)
  }, [trafficEdgeIds])

  // ── Fit button ────────────────────────────────────────────────────────────
  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 60)
  }, [])

  const isULCL = graph.nodes.some(n => n.nfType === 'iUPF')

  return (
    <div className="relative w-full h-full bg-bg-primary">
      {/* Cytoscape canvas */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ background: '#0a0e1a' }}
      />

      {/* Hover tooltips */}
      {tooltip?.type === 'node' && tooltip.node && (
        <NodeTooltip node={tooltip.node} pos={tooltip.pos} />
      )}
      {tooltip?.type === 'edge' && tooltip.edge && (
        <EdgeTooltip edge={tooltip.edge} pos={tooltip.pos} />
      )}

      {/* Topology mode badge */}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <span className="text-xs text-slate-500 font-mono">
          {graph.nodes.length} NFs · {graph.edges.length} links
        </span>
        {isULCL && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/50">
            ULCL
          </span>
        )}
      </div>

      {/* Plane legend */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1.5 bg-bg-secondary/80 border border-border rounded-lg p-2.5 backdrop-blur-sm">
        <span className="text-xs text-slate-500 font-medium mb-0.5">Interfaces</span>
        {([
          ['sbi',       '#3b82f6', 'SBI (HTTP/2)'],
          ['userplane', '#22c55e', 'User plane (GTP-U)'],
          ['ran',       '#f97316', 'RAN (NGAP / NAS)'],
          ['pfcp',      '#a855f7', 'PFCP (N4)'],
        ] as const).map(([, color, name]) => (
          <div key={name} className="flex items-center gap-2 text-xs text-slate-400">
            <div className="w-5 h-0.5 rounded" style={{ background: color }} />
            {name}
          </div>
        ))}
      </div>

      {/* Fit button */}
      <button
        onClick={handleFit}
        title="Fit to view"
        className="absolute top-3 right-3 btn-secondary text-xs px-2 py-1"
      >
        ⊞ Fit
      </button>
    </div>
  )
}
