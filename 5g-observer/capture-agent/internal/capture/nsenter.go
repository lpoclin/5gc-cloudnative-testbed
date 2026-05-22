package capture

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

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

// CaptureResult is a decoded packet line from tshark.
type CaptureResult struct {
	Line string
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

		// Pipe tcpdump stdout → tshark stdin
		pipe, err := tcpdump.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tcpdump stdout pipe")
			return
		}
		tshark.Stdin = pipe

		tsharkOut, err := tshark.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tshark stdout pipe")
			return
		}

		if err := tcpdump.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tcpdump start")
			return
		}
		if err := tshark.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tshark start")
			tcpdump.Process.Kill()
			return
		}

		defer func() {
			tcpdump.Process.Kill()
			tshark.Process.Kill()
			tcpdump.Wait()
			tshark.Wait()
		}()

		scanner := bufio.NewScanner(tsharkOut)
		scanner.Buffer(make([]byte, 64*1024), 64*1024)
		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			case ch <- CaptureResult{Line: scanner.Text()}:
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
