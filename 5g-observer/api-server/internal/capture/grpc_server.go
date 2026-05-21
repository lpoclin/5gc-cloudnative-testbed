// Package capture implements the gRPC server that receives packet streams
// from capture-agent DaemonSets and fans them out to WebSocket subscribers.
package capture

import (
	"io"
	"net"
	"sync"

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

// Subscriber receives packets for a session.
type Subscriber chan []Packet

// Server implements pb.CaptureServiceServer and fans packets to subscribers.
type Server struct {
	pb.UnimplementedCaptureServiceServer
	mu   sync.RWMutex
	subs map[SessionKey][]Subscriber
}

func NewServer() *Server {
	return &Server{subs: make(map[SessionKey][]Subscriber)}
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

// publish sends a packet batch to all subscribers for the session key.
func (s *Server) publish(key SessionKey, pkts []Packet) {
	s.mu.RLock()
	subs := s.subs[key]
	s.mu.RUnlock()

	for _, sub := range subs {
		select {
		case sub <- pkts:
		default:
			// subscriber too slow — drop rather than block
		}
	}
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
