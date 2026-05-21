package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ─── Model types ──────────────────────────────────────────────────────────────

type NFType string

const (
	NFTypeNRF     NFType = "NRF"
	NFTypeAMF     NFType = "AMF"
	NFTypeSMF     NFType = "SMF"
	NFTypeAUSF    NFType = "AUSF"
	NFTypeUDM     NFType = "UDM"
	NFTypeUDR     NFType = "UDR"
	NFTypePCF     NFType = "PCF"
	NFTypeNSSF    NFType = "NSSF"
	NFTypeCHF     NFType = "CHF"
	NFTypeNEF     NFType = "NEF"
	NFTypeUPF     NFType = "UPF"
	NFTypeIUPF    NFType = "iUPF"
	NFTypeGNB     NFType = "gNB"
	NFTypeUE      NFType = "UE"
	NFTypeDN      NFType = "DN"
	NFTypeUnknown NFType = "UNKNOWN"
)

type Plane string

const (
	PlaneSBI        Plane = "sbi"
	PlaneUserPlane  Plane = "userplane"
	PlaneRAN        Plane = "ran"
	PlanePFCP       Plane = "pfcp"
	PlaneManagement Plane = "management"
)

type PodPhase string
type PodCondition string

const (
	PodPhaseRunning   PodPhase = "Running"
	PodPhasePending   PodPhase = "Pending"
	PodPhaseFailed    PodPhase = "Failed"
	PodPhaseUnknown   PodPhase = "Unknown"
)

const (
	CondRunning          PodCondition = "Running"
	CondCrashLoopBackOff PodCondition = "CrashLoopBackOff"
	CondOOMKilled        PodCondition = "OOMKilled"
	CondError            PodCondition = "Error"
	CondPending          PodCondition = "Pending"
	CondUnknown          PodCondition = "Unknown"
)

type PodStatus struct {
	Phase     PodPhase     `json:"phase"`
	Ready     bool         `json:"ready"`
	Condition PodCondition `json:"condition"`
	Restarts  int32        `json:"restarts"`
}

type NetworkInterface struct {
	Name      string   `json:"name"`
	Interface string   `json:"interface"`
	IPs       []string `json:"ips"`
	MAC       string   `json:"mac,omitempty"`
	IsDefault bool     `json:"isDefault"`
}

type TopologyNode struct {
	ID         string            `json:"id"`
	PodName    string            `json:"podName"`
	Namespace  string            `json:"namespace"`
	NFType     NFType            `json:"nfType"`
	NodeName   string            `json:"nodeName"`
	Status     PodStatus         `json:"status"`
	Interfaces []NetworkInterface `json:"interfaces"`
	Age        string            `json:"age"`
	Image      string            `json:"image"`
	Labels     map[string]string `json:"labels"`
}

type TopologyEdge struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Target    string `json:"target"`
	Interface string `json:"interface"`
	Plane     Plane  `json:"plane"`
	SrcIP     string `json:"srcIP,omitempty"`
	DstIP     string `json:"dstIP,omitempty"`
}

type TopologyGraph struct {
	Nodes     []TopologyNode `json:"nodes"`
	Edges     []TopologyEdge `json:"edges"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// ─── Network-status annotation types ─────────────────────────────────────────

type netStatus struct {
	Name      string   `json:"name"`
	Interface string   `json:"interface"`
	IPs       []string `json:"ips"`
	MAC       string   `json:"mac"`
	Default   bool     `json:"default"`
}

// ─── Topology discovery ───────────────────────────────────────────────────────

func BuildTopology(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) (*TopologyGraph, error) {
	var nodes []TopologyNode

	for _, ns := range namespaces {
		pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list pods in %s: %w", ns, err)
		}
		for _, pod := range pods.Items {
			node := podToNode(&pod)
			if node != nil {
				nodes = append(nodes, *node)
			}
		}
	}

	// Add virtual DN node if user-plane NFs exist
	hasUPF := false
	for _, n := range nodes {
		if n.NFType == NFTypeUPF || n.NFType == NFTypeIUPF {
			hasUPF = true
			break
		}
	}
	if hasUPF {
		nodes = append(nodes, TopologyNode{
			ID:        "dn",
			PodName:   "data-network",
			Namespace: "virtual",
			NFType:    NFTypeDN,
			NodeName:  "",
			Status: PodStatus{
				Phase:     PodPhaseRunning,
				Ready:     true,
				Condition: CondRunning,
			},
			Interfaces: []NetworkInterface{},
			Age:        "∞",
			Image:      "",
			Labels:     map[string]string{},
		})
	}

	edges := buildEdges(nodes)

	return &TopologyGraph{
		Nodes:     nodes,
		Edges:     edges,
		UpdatedAt: time.Now(),
	}, nil
}

// ─── Pod → TopologyNode ───────────────────────────────────────────────────────

func podToNode(pod *corev1.Pod) *TopologyNode {
	// Skip completed/evicted pods
	if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
		return nil
	}

	ifaces := parseNetworkStatus(pod.Annotations)
	nfType := detectNFType(pod, ifaces)
	status := podStatus(pod)
	age := time.Since(pod.CreationTimestamp.Time).Round(time.Second).String()

	img := ""
	if len(pod.Spec.Containers) > 0 {
		img = pod.Spec.Containers[0].Image
	}

	return &TopologyNode{
		ID:         string(pod.UID),
		PodName:    pod.Name,
		Namespace:  pod.Namespace,
		NFType:     nfType,
		NodeName:   pod.Spec.NodeName,
		Status:     status,
		Interfaces: ifaces,
		Age:        age,
		Image:      img,
		Labels:     pod.Labels,
	}
}

func parseNetworkStatus(annotations map[string]string) []NetworkInterface {
	raw, ok := annotations["k8s.v1.cni.cncf.io/network-status"]
	if !ok {
		// fallback: synthesise from pod IP
		return nil
	}

	var statuses []netStatus
	if err := json.Unmarshal([]byte(raw), &statuses); err != nil {
		return nil
	}

	ifaces := make([]NetworkInterface, 0, len(statuses))
	for _, s := range statuses {
		ifaces = append(ifaces, NetworkInterface{
			Name:      s.Name,
			Interface: s.Interface,
			IPs:       s.IPs,
			MAC:       s.MAC,
			IsDefault: s.Default,
		})
	}
	return ifaces
}

func podStatus(pod *corev1.Pod) PodStatus {
	var restarts int32
	var ready bool

	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if cs.Ready {
			ready = true
		}
	}

	condition := CondUnknown
	switch pod.Status.Phase {
	case corev1.PodRunning:
		condition = CondRunning
		// Check for specific conditions
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil {
				switch cs.State.Waiting.Reason {
				case "CrashLoopBackOff":
					condition = CondCrashLoopBackOff
				case "OOMKilled":
					condition = CondOOMKilled
				case "Error":
					condition = CondError
				}
			}
			if cs.LastTerminationState.Terminated != nil &&
				cs.LastTerminationState.Terminated.Reason == "OOMKilled" {
				condition = CondOOMKilled
			}
		}
	case corev1.PodPending:
		condition = CondPending
	case corev1.PodFailed:
		condition = CondError
	}

	phase := PodPhase(pod.Status.Phase)
	if phase == "" {
		phase = PodPhaseUnknown
	}

	return PodStatus{
		Phase:     phase,
		Ready:     ready,
		Condition: condition,
		Restarts:  restarts,
	}
}

// ─── NF type detection ────────────────────────────────────────────────────────

var nfNameMap = []struct {
	keywords []string
	nfType   NFType
}{
	{[]string{"nrf"}, NFTypeNRF},
	{[]string{"ausf"}, NFTypeAUSF},
	{[]string{"udm"}, NFTypeUDM},
	{[]string{"udr"}, NFTypeUDR},
	{[]string{"nssf"}, NFTypeNSSF},
	{[]string{"chf"}, NFTypeCHF},
	{[]string{"nef"}, NFTypeNEF},
	{[]string{"pcf"}, NFTypePCF},
	{[]string{"amf"}, NFTypeAMF},
	{[]string{"smf"}, NFTypeSMF},
	// iUPF before UPF (more specific)
	{[]string{"iupf", "i-upf"}, NFTypeIUPF},
	{[]string{"upf", "psa"}, NFTypeUPF},
	{[]string{"gnb", "gnode", "gnodeb"}, NFTypeGNB},
	{[]string{"ue", "uesim"}, NFTypeUE},
}

func detectNFType(pod *corev1.Pod, ifaces []NetworkInterface) NFType {
	// Check labels first (more reliable)
	labelKeys := []string{"app", "app.kubernetes.io/name", "nf-type", "nf"}
	for _, k := range labelKeys {
		if v, ok := pod.Labels[k]; ok {
			if t := matchNFName(strings.ToLower(v)); t != NFTypeUnknown {
				return t
			}
		}
	}

	// Fall back to pod name
	name := strings.ToLower(pod.Name)

	// iUPF detection by interface combination: has n3 AND n9 (no n6, or n6 as fallback)
	ifaceNames := make(map[string]bool)
	for _, iface := range ifaces {
		ifaceNames[iface.Interface] = true
	}
	if strings.Contains(name, "upf") {
		if ifaceNames["n9"] && ifaceNames["n3"] && !ifaceNames["n6"] {
			return NFTypeIUPF
		}
	}

	return matchNFName(name)
}

func matchNFName(name string) NFType {
	for _, entry := range nfNameMap {
		for _, kw := range entry.keywords {
			if strings.Contains(name, kw) {
				return entry.nfType
			}
		}
	}
	return NFTypeUnknown
}

// ─── Edge building ────────────────────────────────────────────────────────────

func buildEdges(nodes []TopologyNode) []TopologyEdge {
	// Index by NF type
	byType := make(map[NFType][]TopologyNode)
	for _, n := range nodes {
		byType[n.NFType] = append(byType[n.NFType], n)
	}

	var edges []TopologyEdge

	short := func(id string) string {
		if len(id) > 8 {
			return id[:8]
		}
		return id
	}
	addEdge := func(src, dst TopologyNode, iface string, plane Plane) {
		edges = append(edges, TopologyEdge{
			ID:        fmt.Sprintf("e-%s-%s-%s", short(src.ID), short(dst.ID), iface),
			Source:    src.ID,
			Target:    dst.ID,
			Interface: iface,
			Plane:     plane,
		})
	}

	// ── N2: AMF ↔ gNB ────────────────────────────────────────────────────────
	for _, amf := range byType[NFTypeAMF] {
		for _, gnb := range byType[NFTypeGNB] {
			addEdge(amf, gnb, "n2", PlaneRAN)
		}
	}

	// ── N3: gNB → iUPF (ULCL) or gNB → UPF (single) ────────────────────────
	iupfs := byType[NFTypeIUPF]
	upfs  := byType[NFTypeUPF]

	for _, gnb := range byType[NFTypeGNB] {
		if len(iupfs) > 0 {
			// ULCL topology: gNB connects to iUPF(s)
			for _, iupf := range iupfs {
				addEdge(gnb, iupf, "n3", PlaneUserPlane)
			}
		} else {
			// Single/branching UPF: gNB connects directly to UPF(s)
			for _, upf := range upfs {
				addEdge(gnb, upf, "n3", PlaneUserPlane)
			}
		}
	}

	// ── N4: SMF ↔ all UPFs (PFCP) ────────────────────────────────────────────
	for _, smf := range byType[NFTypeSMF] {
		for _, iupf := range iupfs {
			addEdge(smf, iupf, "n4", PlanePFCP)
		}
		for _, upf := range upfs {
			addEdge(smf, upf, "n4", PlanePFCP)
		}
	}

	// ── N9: iUPF → PSA-UPFs ──────────────────────────────────────────────────
	if len(iupfs) > 0 {
		for _, iupf := range iupfs {
			for _, upf := range upfs {
				addEdge(iupf, upf, "n9", PlaneUserPlane)
			}
		}
	}

	// ── N6: PSA-UPFs → DN (or single UPF → DN) ──────────────────────────────
	dnsNodes := byType[NFTypeDN]
	if len(dnsNodes) > 0 {
		dn := dnsNodes[0]
		targetUPFs := upfs
		if len(iupfs) == 0 {
			// single UPF topology: UPF connects to DN
			targetUPFs = upfs
		}
		for _, upf := range targetUPFs {
			addEdge(upf, dn, "n6", PlaneUserPlane)
		}
	}

	// ── SBI: NRF ↔ all CP NFs ────────────────────────────────────────────────
	sbiTypes := []NFType{NFTypeAMF, NFTypeSMF, NFTypeAUSF, NFTypeUDM, NFTypeUDR,
		NFTypePCF, NFTypeNSSF, NFTypeCHF, NFTypeNEF}
	for _, nrf := range byType[NFTypeNRF] {
		for _, nfType := range sbiTypes {
			for _, nf := range byType[nfType] {
				edges = append(edges, TopologyEdge{
					ID:        fmt.Sprintf("e-sbi-%s-%s", nrf.ID[:8], nf.ID[:8]),
					Source:    nrf.ID,
					Target:    nf.ID,
					Interface: "sbi",
					Plane:     PlaneSBI,
				})
			}
		}
	}

	return edges
}
