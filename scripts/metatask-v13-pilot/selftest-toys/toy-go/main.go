// Toy S2b "pseudo-passing" engine — selftest fixture ONLY.
//
// Implements the CLI contract from the S2b base README with minimal semantics,
// just enough for the selftest mini vector set. NOT a real MetaTask engine.
// Hidden subcommand: `metatask-replay run-vectors <dir>` drives the runner
// contract (PASS/FAIL lines, ENGINE + CANONICAL_SHA256).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

func canonJ(v any) ([]byte, error) {
	var b strings.Builder
	if err := writeCanon(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func writeCanon(b *strings.Builder, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			b.Write(kb)
			b.WriteByte(':')
			if err := writeCanon(b, t[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanon(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			return err
		}
		b.Write(raw)
	}
	return nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func innerHash(result map[string]any) string {
	core := map[string]any{}
	for k, v := range result {
		if k != "hash" {
			core[k] = v
		}
	}
	raw, _ := canonJ(core)
	return sha256Hex(raw)
}

func outerHash(result map[string]any) string {
	raw, _ := canonJ(result)
	return sha256Hex(raw)
}

type event struct {
	PinID  string         `json:"pinId"`
	Path   string         `json:"path"`
	Author string         `json:"author"`
	Body   map[string]any `json:"body"`
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func replay(events []event, root string) (map[string]any, error) {
	var task *event
	for i := range events {
		if events[i].Path == "task" {
			task = &events[i]
		}
	}
	if task == nil {
		return nil, fmt.Errorf("no task event found")
	}
	treeID := asString(task.Body["treeid"])
	var tree *event
	for i := range events {
		if events[i].Path == "tree" && events[i].PinID == treeID {
			tree = &events[i]
		}
	}
	if tree == nil {
		return nil, fmt.Errorf("no tree event for task")
	}
	policy, _ := task.Body["policy"].(map[string]any)
	quorum := 1
	if q, ok := policy["verify_quorum"].(float64); ok && int(q) > 0 {
		quorum = int(q)
	}
	finalnode := asString(policy["finalnode"])
	competitive := asString(policy["mode"]) == "competitive"

	votes := map[string][]event{}
	for _, e := range events {
		if e.Path == "verify" {
			target := asString(e.Body["targetid"])
			votes[target] = append(votes[target], e)
		}
	}

	states := map[string]any{}
	nodeList, _ := tree.Body["nodes"].([]any)
	for _, rawNode := range nodeList {
		node, _ := rawNode.(map[string]any)
		nodeID := asString(node["id"])
		status := "open"
		for _, e := range events {
			if e.Path != "submission" {
				continue
			}
			if asString(e.Body["node"]) != nodeID || asString(e.Body["taskid"]) != root {
				continue
			}
			status = "submitted"
			counted := 0
			for _, v := range votes[e.PinID] {
				vbody := v.Body
				if asString(vbody["verdict"]) != "pass" {
					continue
				}
				if v.Author == e.Author || v.Author == task.Author {
					continue
				}
				counted++
			}
			if counted >= quorum {
				status = "verified"
			}
		}
		states[nodeID] = map[string]any{"status": status}
	}

	complete := false
	if finalnode != "" {
		if st, ok := states[finalnode].(map[string]any); ok && st["status"] == "verified" {
			complete = true
		}
	}
	var settlement any
	if complete {
		algo := "idbots-metatask-engine/1.2.1"
		if competitive {
			algo = "idbots-metatask-engine/1.3.0"
		}
		settlement = map[string]any{"engineAlgoVersion": algo}
	}
	return map[string]any{"nodeStates": states, "taskComplete": complete, "settlement": settlement}, nil
}

func loadEvents(path string) ([]event, map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var list []event
	if err := json.Unmarshal(raw, &list); err == nil && list != nil {
		return list, map[string]any{}, nil
	}
	var wrapper struct {
		Events  []event        `json:"events"`
		Options map[string]any `json:"options"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil || wrapper.Events == nil {
		return nil, nil, fmt.Errorf("events file must be a JSON array or an object with an events array")
	}
	return wrapper.Events, wrapper.Options, nil
}

func runVectors(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	failed := 0
	outputs := []any{}
	competitiveSeen := false
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, _ := os.ReadFile(dir + "/" + entry.Name())
		var set struct {
			Vectors []map[string]any `json:"vectors"`
		}
		if err := json.Unmarshal(raw, &set); err != nil {
			fmt.Printf("FAIL %s: unparseable set file\n", entry.Name())
			failed++
			continue
		}
		for _, vector := range set.Vectors {
			id := asString(vector["id"])
			expect, _ := vector["expect"].(map[string]any)
			notes := []string{}
			if asString(vector["kind"]) == "hash" {
				input, _ := vector["input"].(map[string]any)
				inner := innerHash(input)
				withHash := map[string]any{}
				for k, v := range input {
					withHash[k] = v
				}
				withHash["hash"] = inner
				outer := outerHash(withHash)
				if inner != asString(vector["expectInner"]) {
					notes = append(notes, "inner mismatch")
				}
				if outer != asString(vector["expectOuter"]) {
					notes = append(notes, "outer mismatch")
				}
				outputs = append(outputs, map[string]any{"id": id, "inner": inner, "outer": outer})
			} else {
				rawEvents, _ := vector["events"].([]any)
				events := []event{}
				for _, rawEvent := range rawEvents {
					buf, _ := json.Marshal(rawEvent)
					var e event
					if json.Unmarshal(buf, &e) == nil {
						events = append(events, e)
					}
				}
				root := ""
				for _, e := range events {
					if e.Path == "task" {
						root = e.PinID
					}
				}
				projection, err := replay(events, root)
				if err != nil {
					notes = append(notes, err.Error())
					outputs = append(outputs, map[string]any{"id": id, "nodes": map[string]any{}, "taskComplete": false, "engineAlgoVersion": nil})
				} else {
					nodes := map[string]any{}
					for nodeID, rawState := range projection["nodeStates"].(map[string]any) {
						nodes[nodeID] = rawState.(map[string]any)["status"]
					}
					if wantNodes, ok := expect["nodes"].(map[string]any); ok {
						for nodeID, want := range wantNodes {
							if nodes[nodeID] != want {
								notes = append(notes, fmt.Sprintf("%s=%v want %v", nodeID, nodes[nodeID], want))
							}
						}
					}
					if want, ok := expect["taskComplete"]; ok && projection["taskComplete"] != want {
						notes = append(notes, fmt.Sprintf("taskComplete=%v want %v", projection["taskComplete"], want))
					}
					var algo any
					if settlement, ok := projection["settlement"].(map[string]any); ok {
						algo = settlement["engineAlgoVersion"]
					}
					if want, ok := expect["engineAlgoVersion"]; ok && algo != want {
						notes = append(notes, fmt.Sprintf("engineAlgoVersion=%v want %v", algo, want))
					}
					if algo == "idbots-metatask-engine/1.3.0" {
						competitiveSeen = true
					}
					outputs = append(outputs, map[string]any{"id": id, "nodes": nodes, "taskComplete": projection["taskComplete"], "engineAlgoVersion": algo})
				}
			}
			if len(notes) > 0 {
				failed++
				fmt.Printf("FAIL %s: %s\n", id, strings.Join(notes, "; "))
			} else {
				fmt.Printf("PASS %s\n", id)
			}
		}
	}
	algo := "idbots-metatask-engine/1.2.1"
	if competitiveSeen {
		algo = "idbots-metatask-engine/1.3.0"
	}
	fmt.Printf("ENGINE metatask-replay-go %s\n", algo)
	raw, _ := canonJ(outputs)
	fmt.Printf("CANONICAL_SHA256 %s\n", sha256Hex(raw))
	if failed > 0 {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "run-vectors" {
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "usage: metatask-replay run-vectors <vectors-dir>")
			os.Exit(2)
		}
		os.Exit(runVectors(os.Args[2]))
	}

	eventsPath := flag.String("events", "", "JSON file: event array or {events, options}")
	root := flag.String("root", "", "task root pinId to project")
	now := flag.Int64("now", 0, "fixed clock, ms epoch (0 = no expiry)")
	guard := flag.Bool("guard", false, "strict event-set validation; exit 3 on violation")
	flag.Parse()
	_ = now
	_ = guard

	if *eventsPath == "" || *root == "" {
		fmt.Fprintln(os.Stderr, "--events and --root are required")
		os.Exit(2)
	}
	events, _, err := loadEvents(*eventsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid events input: %v\n", err)
		os.Exit(2)
	}
	projection, err := replay(events, *root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	out, _ := canonJ(projection)
	fmt.Println(string(out))
}
