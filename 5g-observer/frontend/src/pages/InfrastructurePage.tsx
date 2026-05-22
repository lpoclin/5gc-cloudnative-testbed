import { useQuery } from '@tanstack/react-query'
import NodeCards from '@/components/Infrastructure/NodeCards'
import ClusterGauges from '@/components/Infrastructure/ClusterGauges'
import TimeSeriesChart from '@/components/Infrastructure/TimeSeriesChart'
import EventsTable from '@/components/Infrastructure/EventsTable'
import { NodeCardSkeleton, Skeleton } from '@/components/common/LoadingSkeleton'
import { api } from '@/services/api'
import type { ClusterMetrics, ClusterInfo, K8sNode, NamespaceStats } from '@/types/k8s'

// ─── Stack panel ──────────────────────────────────────────────────────────────

function StackCard({ node, info }: { node: K8sNode; info: ClusterInfo }) {
  const cni = [info.cniPrimary, info.cniSecondary].filter(Boolean).join(' + ') || '—'
  return (
    <div
      className="rounded-lg p-3 text-xs space-y-1"
      style={{ background: '#161b22', border: '1px solid #30363d' }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-bold text-sm" style={{ color: '#e6edf3' }}>{node.name}</span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
          style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}
        >
          {node.role}
        </span>
      </div>
      {([
        ['kernel',      node.kernelVersion],
        ['OS',          node.osImage],
        ['runtime',     node.containerRuntime],
        ['arch',        node.architecture],
        ['kubelet',     node.kubeletVersion],
        ['CPU',         `${node.cpuCores} cores`],
        ['RAM',         `${node.totalMemoryGiB} GiB`],
        ['CNI',         cni],
        ['Hypervisor',  info.hypervisor || '—'],
      ] as [string, string][]).map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="w-20 shrink-0 font-mono" style={{ color: '#8b949e' }}>{label}:</span>
          <span className="font-mono break-all" style={{ color: '#c9d1d9' }}>{value || '—'}</span>
        </div>
      ))}
    </div>
  )
}

const REFETCH = 10_000

export default function InfrastructurePage() {
  const { data: nodes = [], isLoading: nodesLoading } = useQuery({
    queryKey: ['nodes'],
    queryFn: api.nodes.list,
    refetchInterval: REFETCH,
  })

  const { data: clusterInfo } = useQuery<ClusterInfo>({
    queryKey: ['cluster-info'],
    queryFn: api.clusterInfo.get,
    staleTime: 300_000,
  })

  const defaultClusterInfo: ClusterInfo = { hypervisor: '', cniPrimary: 'Cilium', cniSecondary: '' }

  const { data: metrics } = useQuery<ClusterMetrics>({
    queryKey: ['metrics-cluster'],
    queryFn: api.metrics.cluster,
    refetchInterval: REFETCH,
  })

  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => api.events.list(),
    refetchInterval: REFETCH,
  })

  const { data: nsStats = [] } = useQuery<NamespaceStats[]>({
    queryKey: ['namespace-stats'],
    queryFn: api.namespaceStats.list,
    refetchInterval: REFETCH,
  })

  const defaultMetrics: ClusterMetrics = {
    cpuPercent: 0, memoryPercent: 0,
    podsRunning: 0, podsTotal: 0,
    nodesReady: 0, nodesTotal: 0,
    pvcsTotal: 0, pvcsBound: 0,
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto p-4 space-y-4">
        {/* Summary gauges */}
        {metrics ? (
          <ClusterGauges metrics={metrics} />
        ) : (
          <div className="flex gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-28" />
            ))}
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* Nodes */}
          <div>
            <div className="label mb-2">Nodes</div>
            {nodesLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <NodeCardSkeleton key={i} />)}
              </div>
            ) : (
              <NodeCards nodes={nodes} />
            )}
          </div>

          {/* Right column */}
          <div className="space-y-4">
            {/* Time-series charts */}
            <TimeSeriesChart />

            {/* Namespace stats */}
            <div className="card p-4">
              <div className="label mb-3">Namespaces</div>
              {nsStats.length === 0 ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="space-y-1">
                  {nsStats.map(ns => (
                    <div key={ns.namespace} className="flex items-center gap-3 text-xs">
                      <span className="font-mono text-slate-300 w-28 truncate">{ns.namespace}</span>
                      <span className="text-green-400 font-mono w-12">{ns.running}●</span>
                      {ns.pending > 0 && (
                        <span className="text-yellow-400 font-mono w-12">{ns.pending}⚡</span>
                      )}
                      {ns.failed > 0 && (
                        <span className="text-red-400 font-mono w-12">{ns.failed}✗</span>
                      )}
                      {ns.restarting > 0 && (
                        <span className="text-orange-400 font-mono w-12">{ns.restarting}↺</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent events */}
            <div className="card p-4">
              <div className="label mb-2">Recent Events</div>
              <EventsTable events={events.slice(0, 50)} />
            </div>
          </div>
        </div>

        {/* Node stack info */}
        {nodes.length > 0 && (
          <div className="card p-4">
            <div className="label mb-3">Node Stack</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {nodes.map(node => (
                <StackCard key={node.name} node={node} info={clusterInfo ?? defaultClusterInfo} />
              ))}
            </div>
          </div>
        )}

        {/* PVCs (TODO: wire to API) */}
        <div className="card p-4">
          <div className="label mb-2">Persistent Volume Claims</div>
          <div className="text-xs text-slate-600">Loading PVCs…</div>
        </div>
      </div>
    </div>
  )
}
