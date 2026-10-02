// Command metatask-replay is the MetaTask replay engine, Go implementation (S2b).
//
// Contract: see README.md (CLI flags, stdout canonJ projection, exit codes).
// This base is a SKELETON: flag parsing is wired, the replay is TODO.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

// canonJ renders canonical JSON per the MetaTask protocol: object keys
// sorted, no whitespace, no HTML escaping.
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

// replay folds the event set into the canonical projection.
//
// TODO(S2b): implement the MetaTask v1.2.1 + v1.3 competitive semantics:
// tree fold (amends), claim/release cycles, submissions, verify quorum,
// challenges, deps/parentrefs, chain-validity, winning-chain settlement.
func replay(events []any, root string, now int64, guard bool) (map[string]any, error) {
	return nil, fmt.Errorf("replay is not implemented yet — this is the S2b base skeleton")
}

func main() {
	eventsPath := flag.String("events", "", "JSON file: event array or {events, options}")
	root := flag.String("root", "", "task root pinId to project")
	now := flag.Int64("now", 0, "fixed clock, ms epoch (0 = no expiry)")
	guard := flag.Bool("guard", false, "strict event-set validation; exit 3 on violation")
	flag.Parse()

	if *eventsPath == "" || *root == "" {
		fmt.Fprintln(os.Stderr, "--events and --root are required")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*eventsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid events input: %v\n", err)
		os.Exit(2)
	}
	var events []any
	if err := json.Unmarshal(raw, &events); err != nil {
		var wrapper struct {
			Events []any `json:"events"`
		}
		if err2 := json.Unmarshal(raw, &wrapper); err2 != nil || wrapper.Events == nil {
			fmt.Fprintln(os.Stderr, "invalid events input: not an array or {events} object")
			os.Exit(2)
		}
		events = wrapper.Events
	}

	projection, err := replay(events, *root, *now, *guard)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	out, err := canonJ(projection)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println(string(out))
}
