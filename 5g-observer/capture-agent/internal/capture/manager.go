package capture

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/lpoclin/5g-observer/capture-agent/internal/discovery"
	agentgrpc "github.com/lpoclin/5g-observer/capture-agent/internal/grpc"
	"github.com/lpoclin/5g-observer/capture-agent/internal/pb"
)

const ringCapacity = 5_000

// sessionKey uniquely identifies one capture session.
type sessionKey struct {
	podUID string
	iface  string
}

type session struct {
	cancel  context.CancelFunc
	ring    *RingBuffer
	podName string
	ns      string
	node    string
}

// Manager manages one capture goroutine per (pod, interface).
type Manager struct {
	mu       sync.Mutex
	sessions map[sessionKey]*session
	grpc     *agentgrpc.Client
}

func NewManager(g *agentgrpc.Client) *Manager {
	return &Manager{
		sessions: make(map[sessionKey]*session),
		grpc:     g,
	}
}

// Reconcile starts missing captures and stops stale ones based on current pod list.
func (m *Manager) Reconcile(ctx context.Context, pods []discovery.PodInfo) {
	desired := make(map[sessionKey]discovery.PodInfo)
	for _, pod := range pods {
		for _, iface := range pod.Interfaces {
			desired[sessionKey{podUID: pod.UID, iface: iface}] = pod
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop stale sessions
	for key, sess := range m.sessions {
		if _, ok := desired[key]; !ok {
			log.Info().Str("uid", key.podUID[:8]).Str("iface", key.iface).Msg("stopping capture")
			sess.cancel()
			delete(m.sessions, key)
		}
	}

	// Start new sessions
	for key, pod := range desired {
		if _, ok := m.sessions[key]; ok {
			continue
		}
		sessCtx, cancel := context.WithCancel(ctx)
		ring := NewRingBuffer(ringCapacity)
		sess := &session{
			cancel:  cancel,
			ring:    ring,
			podName: pod.Name,
			ns:      pod.Namespace,
			node:    pod.NodeName,
		}
		m.sessions[key] = sess

		go m.runCapture(sessCtx, key, pod, sess)
	}
}

func (m *Manager) runCapture(ctx context.Context, key sessionKey, pod discovery.PodInfo, sess *session) {
	log.Info().
		Str("pod", pod.Name).
		Str("ns", pod.Namespace).
		Str("iface", key.iface).
		Msg("capture session starting")

	ch, err := RunCapture(ctx, key.podUID, pod.ContainerID, key.iface)
	if err != nil {
		log.Error().Err(err).Str("pod", pod.Name).Str("iface", key.iface).Msg("capture start failed")
		return
	}

	sessionID := SessionID(pod.Namespace, pod.Name, key.iface)
	var batch []*pb.Packet
	flushTicker := time.NewTicker(100 * time.Millisecond)
	defer flushTicker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		m.grpc.BackoffRetry(ctx, sessionID, batch)
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-flushTicker.C:
			flush()
		case result, ok := <-ch:
			if !ok {
				flush()
				return
			}
			fields, ok := ParseTsharkLine(result.Line)
			if !ok {
				continue
			}
			// Use integer arithmetic to preserve nanosecond precision — no float64 conversion.
			tsNs := epochStringToNs(fields["ts"])
			length, _ := strconv.ParseUint(fields["length"], 10, 32)
			sport, _ := strconv.ParseUint(fields["src_port"], 10, 32)
			dport, _ := strconv.ParseUint(fields["dst_port"], 10, 32)

			raw := RawPacket{
				TimestampNs: tsNs,
				SrcIP:       fields["src_ip"],
				DstIP:       fields["dst_ip"],
				SrcPort:     uint32(sport),
				DstPort:     uint32(dport),
				Protocol:    fields["protocol"],
				Length:      uint32(length),
				Info:        fields["info"],
				Raw:         result.RawBytes,
			}
			sess.ring.Push(raw)

			batch = append(batch, &pb.Packet{
				TimestampNs:   raw.TimestampNs,
				SrcIp:         raw.SrcIP,
				DstIp:         raw.DstIP,
				SrcPort:       raw.SrcPort,
				DstPort:       raw.DstPort,
				Protocol:      raw.Protocol,
				Length:        raw.Length,
				Info:          raw.Info,
				Raw:           raw.Raw,
				InterfaceName: key.iface,
				PodName:       pod.Name,
				Namespace:     pod.Namespace,
				Node:          pod.NodeName,
			})

			if len(batch) >= 50 {
				flush()
			}
		}
	}
}

// StopAll cancels all active sessions.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sess := range m.sessions {
		sess.cancel()
	}
}

// SessionID builds a stable session ID string.
func SessionID(ns, pod, iface string) string {
	return fmt.Sprintf("%s/%s/%s", ns, pod, iface)
}
