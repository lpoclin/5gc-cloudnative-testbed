import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/services/api'
import { getWSManager, closeWSManager } from '@/services/websocket'
import type { TopologyGraph } from '@/types/topology'

const POLL_MS = 5_000
const DEBOUNCE_MS = 250

export function useTopology(namespace: string) {
  const queryClient = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const query = useQuery<TopologyGraph>({
    queryKey: ['topology', namespace],
    queryFn: () => api.topology.get(namespace),
    refetchInterval: POLL_MS,
    staleTime: DEBOUNCE_MS,
    retry: 3,
  })

  // Also subscribe to WebSocket push for immediate updates
  useEffect(() => {
    const wsUrl = `/ws/topology?namespace=${encodeURIComponent(namespace)}`
    const mgr = getWSManager(wsUrl)

    const handle = (data: TopologyGraph) => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        queryClient.setQueryData(['topology', namespace], data)
      }, DEBOUNCE_MS)
    }

    mgr.on<TopologyGraph>('topology', handle)
    return () => {
      mgr.off('topology', handle)
      closeWSManager(wsUrl)
      clearTimeout(debounceRef.current)
    }
  }, [namespace, queryClient])

  return query
}
