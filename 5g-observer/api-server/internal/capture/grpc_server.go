// Package capture implements the gRPC server that receives packet streams
// from capture-agent DaemonSets and fans them out to WebSocket subscribers.
package capture

import (
	"io"
	"net"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"

	"github.com/lpoclin/5g-observer/api-server/internal/pb"
)

// Packet is a decoded network packet forwarded to WebSocket subscribers.
type Packet struct {
	TimestampNs   int64
	SrcIP         string
	DstIP         string
	SrcPort       uint32
	DstPort       uint32
	Protocol      string
	Length        uint32
	Info          string
	Raw           []byte
	InterfaceName string
	PodName       string
	Namespace     string
	Node          string
}

// SessionKey uniquely identifies a capture session.
type SessionKey struct {
	Node    string
	PodName string
	Iface   string
}

// wildcardKey matches packets for any node for a given pod+interface.
type wildcardKey struct {
	PodName string
	Iface   string
}

// Subscriber receives packets for a session.
type Subscriber chan []Packet

// statEntry records one batch of packets received at a point in time.
type statEntry struct {
	ts    time.Time
	pkts  int
	bytes int64
}

// Server implements pb.CaptureServiceServer and fans packets to subscribers.
type Server struct {
	pb.UnimplementedCaptureServiceServer
	mu           sync.RWMutex
	subs         map[SessionKey][]Subscriber
	wildcardSubs map[wildcardKey][]Subscriber

	// Rolling traffic stats — 3-second sliding window, keyed by pod+interface
	statsMu  sync.Mutex
	statsMap map[wildcardKey][]statEntry
}

func NewServer() *Server {
	return &Server{
		subs:         make(map[SessionKey][]Subscriber),
		wildcardSubs: make(map[wildcardKey][]Subscriber),
		statsMap:     make(map[wildcardKey][]statEntry),
	}
}

// recordStats appends a stat entry and prunes entries older than 3 seconds.
func (s *Server) recordStats(key wildcardKey, pkts []Packet) {
	var totalBytes int64
	for _, p := range pkts {
		totalBytes += int64(p.Length)
	}
	entry := statEntry{ts: time.Now(), pkts: len(pkts), bytes: totalBytes}
	cutoff := entry.ts.Add(-3 * time.Second)

	s.statsMu.Lock()
	prev := s.statsMap[key]
	// prune in-place then append
	keep := prev[:0]
	for _, e := range prev {
		if e.ts.After(cutoff) {
			keep = append(keep, e)
		}
	}
	s.statsMap[key] = append(keep, entry)
	s.statsMu.Unlock()
}

// TrafficStats returns the per-second packet rate and throughput (Mbps) for
// a given pod+interface averaged over a 2-second sliding window.
// Returns (0, 0) when no data has been received yet.
func (s *Server) TrafficStats(pod, iface string) (pps, throughputMbps float64) {
	const window = 2.0
	key := wildcardKey{PodName: pod, Iface: iface}
	cutoff := time.Now().Add(-time.Duration(window * float64(time.Second)))

	s.statsMu.Lock()
	entries := s.statsMap[key]
	var totalPkts int
	var totalBytes int64
	for _, e := range entries {
		if e.ts.After(cutoff) {
			totalPkts += e.pkts
			totalBytes += e.bytes
		}
	}
	s.statsMu.Unlock()

	if totalPkts == 0 {
		return 0, 0
	}
	pps = float64(totalPkts) / window
	throughputMbps = float64(totalBytes) * 8 / 1e6 / window
	return
}

// RegisterWildcardSubscriber subscribes to all packets for pod+iface, any node.
func (s *Server) RegisterWildcardSubscriber(pod, iface string) (Subscriber, func()) {
	key := wildcardKey{PodName: pod, Iface: iface}
	ch := make(Subscriber, 512)
	s.mu.Lock()
	s.wildcardSubs[key] = append(s.wildcardSubs[key], ch)
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		list := s.wildcardSubs[key]
		for i, sub := range list {
			if sub == ch {
				s.wildcardSubs[key] = append(list[:i], list[i+1:]...)
				break
			}
		}
		close(ch)
	}
}

// RegisterSubscriber registers a channel to receive packets for a session key.
// Returns an unsubscribe function.
func (s *Server) RegisterSubscriber(key SessionKey) (Subscriber, func()) {
	ch := make(Subscriber, 256)
	s.mu.Lock()
	s.subs[key] = append(s.subs[key], ch)
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		list := s.subs[key]
		for i, sub := range list {
			if sub == ch {
				s.subs[key] = append(list[:i], list[i+1:]...)
				break
			}
		}
		close(ch)
	}
}

// publish sends a packet batch to exact-key subscribers AND wildcard (pod+iface) subscribers.
// Also records traffic stats for the interface metrics endpoint.
func (s *Server) publish(key SessionKey, pkts []Packet) {
	wKey := wildcardKey{PodName: key.PodName, Iface: key.Iface}
	s.mu.RLock()
	subs  := s.subs[key]
	wSubs := s.wildcardSubs[wKey]
	s.mu.RUnlock()

	for _, sub := range subs {
		select { case sub <- pkts: default: }
	}
	for _, sub := range wSubs {
		select { case sub <- pkts: default: }
	}

	// Record in sliding-window stats for TrafficStats queries
	s.recordStats(wKey, pkts)
}

// StreamPackets receives packet batches from a capture-agent (client-streaming).
func (s *Server) StreamPackets(stream grpc.ClientStreamingServer[pb.PacketBatch, pb.Ack]) error {
	for {
		batch, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&pb.Ack{Ok: true})
		}
		if err != nil {
			return err
		}
		if len(batch.Packets) == 0 {
			continue
		}

		p0 := batch.Packets[0]
		key := SessionKey{Node: p0.Node, PodName: p0.PodName, Iface: p0.InterfaceName}

		pkts := make([]Packet, len(batch.Packets))
		for i, p := range batch.Packets {
			pkts[i] = Packet{
				TimestampNs:   p.TimestampNs,
				SrcIP:         p.SrcIp,
				DstIP:         p.DstIp,
				SrcPort:       p.SrcPort,
				DstPort:       p.DstPort,
				Protocol:      p.Protocol,
				Length:        p.Length,
				Info:          p.Info,
				Raw:           p.Raw,
				InterfaceName: p.InterfaceName,
				PodName:       p.PodName,
				Namespace:     p.Namespace,
				Node:          p.Node,
			}
		}
		s.publish(key, pkts)
	}
}

// Subscribe implements the server-streaming RPC used for external subscribers.
func (s *Server) Subscribe(req *pb.SubscribeRequest, stream grpc.ServerStreamingServer[pb.PacketBatch]) error {
	key := SessionKey{Node: req.Node, PodName: req.PodName, Iface: req.InterfaceName}
	ch, unsub := s.RegisterSubscriber(key)
	defer unsub()

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case pkts, ok := <-ch:
			if !ok {
				return nil
			}
			pbPkts := make([]*pb.Packet, len(pkts))
			for i, p := range pkts {
				pbPkts[i] = &pb.Packet{
					TimestampNs:   p.TimestampNs,
					SrcIp:         p.SrcIP,
					DstIp:         p.DstIP,
					SrcPort:       p.SrcPort,
					DstPort:       p.DstPort,
					Protocol:      p.Protocol,
					Length:        p.Length,
					Info:          p.Info,
					Raw:           p.Raw,
					InterfaceName: p.InterfaceName,
					PodName:       p.PodName,
					Namespace:     p.Namespace,
					Node:          p.Node,
				}
			}
			if err := stream.Send(&pb.PacketBatch{Packets: pbPkts}); err != nil {
				return err
			}
		}
	}
}

// ListenAndServe starts the gRPC listener on addr.
func (s *Server) ListenAndServe(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	pb.RegisterCaptureServiceServer(srv, s)
	log.Info().Str("addr", addr).Msg("capture gRPC server listening")
	return srv.Serve(lis)
}
