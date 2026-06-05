package capture

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/rs/zerolog/log"
)

// findPodPID returns a PID inside the pod's network namespace.
//
// cgroupv2 + containerd: pod UIDs use hyphens but cgroup paths use underscores,
// e.g. UID a9f01084-6257-... → cgroup path kubepods-burstable-poda9f01084_6257_...
// containerID is the full container ID (containerd://SHA256); we use the first 12 chars
// to match the specific container cgroup and skip pause/sandbox containers.
func findPodPID(podUID, containerID string) (int, error) {
	// cgroupv2 encodes the pod UID with underscores instead of hyphens
	cgroupPodID := "pod" + strings.ReplaceAll(podUID, "-", "_")

	// Extract short container ID (first 12 chars after stripping scheme)
	containerIDFull := strings.TrimPrefix(containerID, "containerd://")
	containerIDFull  = strings.TrimPrefix(containerIDFull, "docker://")
	containerIDShort := ""
	if len(containerIDFull) >= 12 {
		containerIDShort = containerIDFull[:12]
	}

	procs, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, entry := range procs {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cgroup, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
		if err != nil {
			continue
		}
		cgroupStr := string(cgroup)

		// Match cgroupv2 (underscore UID) or cgroupv1 (hyphen UID)
		matchesPod := strings.Contains(cgroupStr, cgroupPodID) ||
			strings.Contains(cgroupStr, podUID)
		if !matchesPod {
			continue
		}
		// If we have a container ID, also verify it matches (skips pause containers)
		if containerIDShort != "" && !strings.Contains(cgroupStr, containerIDShort) {
			continue
		}
		// Skip kernel threads (no cmdline)
		cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		if len(cmdline) > 0 {
			return pid, nil
		}
	}
	return 0, fmt.Errorf("no PID found for pod UID %s", podUID)
}

// CaptureResult is a decoded packet line from tshark with raw frame bytes.
type CaptureResult struct {
	Line     string
	RawBytes []byte // raw Ethernet/IP frame bytes for sharkd decode; nil if unavailable
}

// RunCapture starts tcpdump | tshark in the pod network namespace.
// containerID is the containerd container ID (containerd://SHA256) used to
// disambiguate the main container from the pause/sandbox container in cgroupv2.
// Decoded lines are sent on the returned channel until ctx is cancelled.
func RunCapture(ctx context.Context, podUID, containerID, iface string) (<-chan CaptureResult, error) {
	pid, err := findPodPID(podUID, containerID)
	if err != nil {
		return nil, fmt.Errorf("find pod PID: %w", err)
	}

	netNS := fmt.Sprintf("/proc/%d/ns/net", pid)

	// Check netns file exists
	if _, err := os.Stat(netNS); err != nil {
		return nil, fmt.Errorf("netns %s not accessible: %w", netNS, err)
	}

	ch := make(chan CaptureResult, 512)

	go func() {
		defer close(ch)

		// Run: nsenter --net=<netns> -- tcpdump -i <iface> -w - |
		//      tshark -r - -T fields -e frame.time_epoch -e ip.src -e ip.dst
		//              -e tcp.srcport -e udp.srcport -e tcp.dstport -e udp.dstport
		//              -e _ws.col.Protocol -e frame.len -e _ws.col.Info

		tcpdumpArgs := []string{
			fmt.Sprintf("--net=%s", netNS),
			"--",
			"tcpdump",
			"-i", iface,
			"-w", "-",
			"--immediate-mode",
			"-s", "0",
		}

		tsharkArgs := []string{
			"-r", "-",
			"-l",
			"-T", "fields",
			"-e", "frame.time_epoch",
			"-e", "ip.src",
			"-e", "ip.dst",
			"-e", "tcp.srcport",
			"-e", "udp.srcport",
			"-e", "tcp.dstport",
			"-e", "udp.dstport",
			"-e", "_ws.col.Protocol",
			"-e", "frame.len",
			"-e", "_ws.col.Info",
			"-E", "separator=|",
		}

		// Find binaries
		nsenterBin, _ := exec.LookPath("nsenter")
		if nsenterBin == "" {
			nsenterBin = "/usr/bin/nsenter"
		}
		tsharkBin, _ := exec.LookPath("tshark")
		if tsharkBin == "" {
			tsharkBin = filepath.Join("/usr/bin", "tshark")
		}

		tcpdump := exec.CommandContext(ctx, nsenterBin, tcpdumpArgs...)
		tcpdump.Env = append(os.Environ())

		tshark := exec.CommandContext(ctx, tsharkBin, tsharkArgs...)
		tshark.Env = append(os.Environ())

		// tcpdump stdout → TeeReader → tshark stdin (fields text)
		//                            └→ pcapPipeW → pcapPipeR → parsePcapFrames (raw bytes)
		tcpdumpStdout, err := tcpdump.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tcpdump stdout pipe")
			return
		}

		tsharkOut, err := tshark.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tshark stdout pipe")
			return
		}

		// Split the raw pcap stream: one copy goes to tshark, another to pcap frame parser
		pcapPipeR, pcapPipeW := io.Pipe()
		teeR := io.TeeReader(tcpdumpStdout, pcapPipeW)
		tshark.Stdin = teeR

		rawCh := make(chan []byte, 512)
		var rawChOnce sync.Once
		closeRawCh := func() { rawChOnce.Do(func() { close(rawCh) }) }

		go func() {
			defer closeRawCh()
			defer pcapPipeR.Close()
			parsePcapFrames(ctx, pcapPipeR, rawCh)
		}()

		if err := tcpdump.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tcpdump start")
			pcapPipeW.Close()
			return
		}
		if err := tshark.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tshark start")
			tcpdump.Process.Kill()
			pcapPipeW.Close()
			return
		}

		defer func() {
			log.Debug().Str("uid", podUID).Str("iface", iface).Int("goroutines", runtime.NumGoroutine()).Msg("runcapture exiting, cleanup starting")
			tcpdump.Process.Kill()
			tshark.Process.Kill()
			pcapPipeW.Close()
			closeRawCh() // Fix 2: ensure rawCh is closed when main goroutine exits
			tcpdump.Wait()
			tshark.Wait()
			log.Debug().Str("uid", podUID).Str("iface", iface).Int("goroutines", runtime.NumGoroutine()).Msg("runcapture exited")
		}()

		scanner := bufio.NewScanner(tsharkOut)
		scanner.Buffer(make([]byte, 64*1024), 64*1024)
		for scanner.Scan() {
			// Receive raw bytes for this frame (same sequential order as tshark output)
			var rawBytes []byte
			select {
			case <-ctx.Done():
				return
			case rb, ok := <-rawCh:
				if ok {
					rawBytes = rb
				}
			}
			select {
			case <-ctx.Done():
				return
			case ch <- CaptureResult{Line: scanner.Text(), RawBytes: rawBytes}:
			}
		}
	}()

	return ch, nil
}

// ParseTsharkLine parses a tshark -T fields line with | separator.
// Fields order: time_epoch|src_ip|dst_ip|tcp_sport|udp_sport|tcp_dport|udp_dport|protocol|length|info
func ParseTsharkLine(line string) (map[string]string, bool) {
	parts := strings.Split(line, "|")
	if len(parts) < 9 {
		return nil, false
	}
	sport := parts[3]
	if sport == "" {
		sport = parts[4]
	}
	dport := parts[5]
	if dport == "" {
		dport = parts[6]
	}
	return map[string]string{
		"ts":       parts[0],
		"src_ip":   parts[1],
		"dst_ip":   parts[2],
		"src_port": sport,
		"dst_port": dport,
		"protocol": normalizeProtocol(parts[7]),
		"length":   parts[8],
		"info":     strings.Join(parts[9:], "|"),
	}, true
}

// epochStringToNs converts a tshark frame.time_epoch string such as
// "1779484323.482605934" to nanoseconds using pure integer arithmetic.
// No float64 conversion is used, so nanosecond precision is preserved exactly.
func epochStringToNs(epochStr string) int64 {
	parts := strings.SplitN(epochStr, ".", 2)
	sec, _ := strconv.ParseInt(parts[0], 10, 64)
	tsNs := sec * 1_000_000_000
	if len(parts) == 2 {
		frac := parts[1]
		for len(frac) < 9 {
			frac += "0"
		}
		frac = frac[:9] // truncate to exactly 9 digits (nanoseconds)
		nsec, _ := strconv.ParseInt(frac, 10, 64)
		tsNs += nsec
	}
	return tsNs
}

// parsePcapFrames reads a libpcap byte stream and sends raw packet bytes for
// each frame on rawCh.  Called in a goroutine alongside the tshark text parser;
// frames appear in the same sequential order as tshark output lines.
func parsePcapFrames(ctx context.Context, r io.Reader, rawCh chan<- []byte) {
	log.Debug().Msg("parsePcapFrames: starting")

	// pcap global header: 24 bytes
	// magic(4) versionMajor(2) versionMinor(2) thiszone(4) sigfigs(4) snaplen(4) network(4)
	var magic [4]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil {
		log.Error().Err(err).Msg("parsePcapFrames: failed to read magic bytes")
		return
	}
	magicNum := binary.LittleEndian.Uint32(magic[:])
	log.Debug().Uint32("magic", magicNum).Msg("parsePcapFrames: read magic")

	bigEndian := magicNum == 0xd4c3b2a1 || magicNum == 0x4d3cb2a1
	if magicNum != 0xa1b2c3d4 && magicNum != 0xa1b23c4d && !bigEndian {
		log.Warn().Uint32("magic", magicNum).Msg("parsePcapFrames: unrecognized magic, raw bytes unavailable")
		return
	}

	// Discard remaining 20 bytes of global header
	var rest [20]byte
	if _, err := io.ReadFull(r, rest[:]); err != nil {
		log.Error().Err(err).Msg("parsePcapFrames: failed to read global header")
		return
	}

	// Per-packet record: ts_sec(4) ts_usec(4) incl_len(4) orig_len(4) + data
	var hdr [16]byte
	frameCount := 0
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			log.Debug().Int("frames_read", frameCount).Msg("parsePcapFrames: done")
			return
		}
		var inclLen uint32
		if bigEndian {
			inclLen = binary.BigEndian.Uint32(hdr[8:12])
		} else {
			inclLen = binary.LittleEndian.Uint32(hdr[8:12])
		}
		data := make([]byte, inclLen)
		if _, err := io.ReadFull(r, data); err != nil {
			log.Error().Err(err).Uint32("expected_len", inclLen).Int("frame", frameCount+1).
				Msg("parsePcapFrames: failed to read frame data")
			return
		}
		frameCount++
		if frameCount <= 3 || frameCount%1000 == 0 {
			log.Debug().Int("frame", frameCount).Int("len", len(data)).Msg("parsePcapFrames: frame read")
		}
		select {
		case rawCh <- data:
		case <-ctx.Done():
			return
		}
	}
}

func normalizeProtocol(p string) string {
	upper := strings.ToUpper(strings.TrimSpace(p))
	switch {
	case strings.Contains(upper, "GTP"):
		return "GTP-U"
	case strings.Contains(upper, "PFCP"):
		return "PFCP"
	case strings.Contains(upper, "HTTP/2"), strings.Contains(upper, "HTTP2"):
		return "HTTP/2"
	case strings.Contains(upper, "NGAP"):
		return "NGAP"
	case strings.Contains(upper, "SCTP"):
		return "SCTP"
	case strings.Contains(upper, "NAS"):
		return "NAS"
	case strings.Contains(upper, "DNS"):
		return "DNS"
	case strings.Contains(upper, "TCP"):
		return "TCP"
	case strings.Contains(upper, "UDP"):
		return "UDP"
	default:
		return upper
	}
}
