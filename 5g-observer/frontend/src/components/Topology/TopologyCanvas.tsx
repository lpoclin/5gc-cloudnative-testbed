import { useEffect, useRef, useCallback, useMemo } from 'react'
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

// ─── 3GPP TS 23.501 layout positions ─────────────────────────────────────────
// Coordinate space: x = 0..1100, y = 0..920
// The canvas is fit on mount; Cytoscape handles viewport scaling.

const SBI_ROW1_Y  = 60
const SBI_ROW2_Y  = 210
const SBI_ROW3_Y  = 340  // UDR
const RAN_Y       = 530
const UPF_ROW1_Y  = 530  // iUPF same row as gNB
const UPF_ROW2_Y  = 720  // PSA-UPFs
const DN_Y        = 910

// Base X per NF type (single instance)
const BASE_X: Partial<Record<NFType | 'PSA_UPF', number>> = {
  NSSF:    60,
  NEF:     230,
  NRF:     520,
  PCF:     790,
  AUSF:    140,
  UDM:     360,
  UDR:     360,
  AMF:     520,
  SMF:     700,
  CHF:     870,
  UE:      100,
  gNB:     370,
  iUPF:    660,
  UPF:     660,
  PSA_UPF: 550,
  DN:      660,
  UNKNOWN: 1050,
}

const BASE_Y: Partial<Record<NFType | 'PSA_UPF', number>> = {
  NSSF: SBI_ROW1_Y, NEF: SBI_ROW1_Y, NRF: SBI_ROW1_Y, PCF: SBI_ROW1_Y,
  AUSF: SBI_ROW2_Y, UDM: SBI_ROW2_Y, AMF: SBI_ROW2_Y, SMF: SBI_ROW2_Y, CHF: SBI_ROW2_Y,
  UDR:  SBI_ROW3_Y,
  UE: RAN_Y, gNB: RAN_Y, iUPF: UPF_ROW1_Y, UPF: UPF_ROW1_Y,
  PSA_UPF: UPF_ROW2_Y,
  DN: DN_Y,
  UNKNOWN: SBI_ROW2_Y,
}

function isPSAUPF(node: TopologyNode): boolean {
  const n = node.podName.toLowerCase()
  return (node.nfType === 'UPF') && (n.includes('psa') || n.includes('psaupf'))
}

function effectiveType(node: TopologyNode): NFType | 'PSA_UPF' {
  return isPSAUPF(node) ? 'PSA_UPF' : node.nfType
}

function computePositions(nodes: TopologyNode[]): Map<string, { x: number; y: number }> {
  const groups = new Map<string, TopologyNode[]>()
  for (const n of nodes) {
    const k = effectiveType(n)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [type, group] of groups) {
    const bx = BASE_X[type as NFType] ?? 700
    const by = BASE_Y[type as NFType] ?? 400
    const total = group.length
    const spacing = total > 1 ? 160 : 0

    group.forEach((node, i) => {
      const offset = (i - (total - 1) / 2) * spacing
      positions.set(node.id, { x: bx + offset, y: by })
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
      style: { 'opacity': 1 } as cytoscape.Css.Edge,
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

  // Nodes
  for (const node of graph.nodes) {
    const pos = positions.get(node.id) ?? { x: 700, y: 400 }
    const plane = (['gNB', 'UE'] as NFType[]).includes(node.nfType)
      ? 'ran'
      : (['UPF', 'iUPF'] as NFType[]).includes(node.nfType)
        ? 'userplane'
        : node.nfType === 'DN' ? 'management' : 'sbi'

    const pStyle = PLANE_STYLE[plane as Plane]

    els.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.nfType === 'DN' ? 'DN / Internet' : `${node.nfType}\n${node.podName.split('-')[0]}`,
        icon: getNFIcon(node.nfType),
        borderColor: getNFColor(node.nfType),
        status: node.status.condition,
        restarts: node.status.restarts,
        plane,
        lineColor: pStyle.lineColor,
        // raw node data for click handler
        _node: node,
      },
      classes: node.nfType === 'DN' ? 'dn' : '',
      position: pos,
    })
  }

  // Edges
  for (const edge of graph.edges) {
    const pStyle = PLANE_STYLE[edge.plane] ?? PLANE_STYLE.management
    els.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.interface,
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

// ─── Main component ────────────────────────────────────────────────────────────
export default function TopologyCanvas({
  graph,
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  trafficEdgeIds,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const animFrameRef = useRef<number | undefined>(undefined)

  // Build positions once (stable between renders unless graph.nodes changes)
  const positions = useMemo(() => computePositions(graph.nodes), [graph.nodes])

  // ── Init Cytoscape ────────────────────────────────────────────────────────
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

    // Fit all nodes with padding
    cy.fit(cy.nodes(), 60)

    // ── Node click ──────────────────────────────────────────────────────────
    cy.on('tap', 'node', (e: EventObject) => {
      const node = e.target as NodeSingular
      const raw = node.data('_node') as TopologyNode
      if (raw) onNodeClick(raw)
    })

    // ── Edge click ──────────────────────────────────────────────────────────
    cy.on('tap', 'edge', (e: EventObject) => {
      const edge = e.target as EdgeSingular
      const rawEdge = edge.data('_edge') as TopologyEdge
      const sourceNode = graph.nodes.find(n => n.id === edge.data('source'))
      if (rawEdge && sourceNode) onEdgeClick(rawEdge, sourceNode)
    })

    // ── Hover: add .hover class ─────────────────────────────────────────────
    cy.on('mouseover', 'node, edge', (e: EventObject) => {
      e.target.addClass('hover')
    })
    cy.on('mouseout', 'node, edge', (e: EventObject) => {
      e.target.removeClass('hover')
    })

    // ── Background click: deselect ──────────────────────────────────────────
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) cy.elements().unselect()
    })

    return () => {
      cancelAnimationFrame(animFrameRef.current ?? 0)
      cy.destroy()
      cyRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update elements when graph changes (without destroying cy) ────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    const newPositions = computePositions(graph.nodes)
    const elements = buildElements(graph, newPositions)

    cy.batch(() => {
      // Remove old elements not in new set
      const newIds = new Set(elements.map(e => e.data.id as string))
      cy.elements().forEach(el => {
        if (!newIds.has(el.id())) el.remove()
      })

      // Add / update
      for (const el of elements) {
        const existing = cy.getElementById(el.data.id as string)
        if (existing.length > 0) {
          existing.data(el.data)
          if (el.group === 'nodes' && el.position) {
            existing.position(el.position)
          }
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
    if (selectedNodeId) {
      cy.getElementById(selectedNodeId).select()
    }
  }, [selectedNodeId])

  // ── Traffic animation (animated dash offset on active edges) ─────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    cy.edges().removeClass('traffic')
    trafficEdgeIds?.forEach(id => {
      cy.getElementById(id).addClass('traffic')
    })

    // Animate dash offset
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

  // ── Fit button handler ────────────────────────────────────────────────────
  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 60)
  }, [])

  return (
    <div className="relative w-full h-full bg-bg-primary">
      {/* Cytoscape container */}
      <div
        ref={containerRef}
        className="w-full h-full cytoscape-container"
        style={{ background: '#0a0e1a' }}
      />

      {/* Plane legend */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1.5 bg-bg-secondary/80 border border-border rounded-lg p-2.5 backdrop-blur-sm">
        <span className="label mb-0.5">Interfaces</span>
        {([
          ['sbi',       '#3b82f6', 'SBI (HTTP/2)'],
          ['userplane', '#22c55e', 'User Plane (GTP-U / N9)'],
          ['ran',       '#f97316', 'RAN (NGAP / N2 / N3)'],
          ['pfcp',      '#a855f7', 'PFCP (N4)'],
        ] as const).map(([, color, name]) => (
          <div key={name} className="flex items-center gap-2 text-xs text-slate-400">
            <div className="w-5 h-0.5 rounded" style={{ background: color }} />
            {name}
          </div>
        ))}
      </div>

      {/* Fit / reset button */}
      <button
        onClick={handleFit}
        title="Fit to view"
        className="absolute top-3 right-3 btn-secondary text-xs px-2 py-1"
      >
        ⊞ Fit
      </button>

      {/* Node count badge */}
      <div className="absolute top-3 left-3 text-xs text-slate-500 font-mono">
        {graph.nodes.length} NFs · {graph.edges.length} interfaces
      </div>
    </div>
  )
}
