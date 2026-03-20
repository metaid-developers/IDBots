# man-p2p Go Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create man-p2p, a Go-based MetaID PIN indexer with embedded libp2p P2P sync, by merging MAN (primary) + meta-file-system user-info features + new P2P layer.

**Architecture:** man-p2p runs as a standalone Go binary managed as a subprocess by IDBots Electron. It exposes a local HTTP API on :7281 that mirrors the existing manapi.metaid.io response envelope (`{ code: 1, message: "ok", data: {...} }`). The P2P layer uses go-libp2p with Kademlia DHT for peer discovery and GossipSub for real-time PIN broadcast.

**Tech Stack:** Go 1.24, go-libp2p, PebbleDB (16-shard), gin HTTP framework, ZMQ (mempool), multi-chain (BTC/MVC/DOGE)

**Important Notes:**
- MAN convention: `respond.ApiSuccess(1, "ok", data)` — success code is `1`, not `0`
- MAN API route group prefix: `/api` — all JSON API routes are under `/api/*`
- MAN already has: `pin.MetaIdInfo` struct, `MetaidInfoDB` PebbleDB, `handleMetaIdInfo()`, routes `/api/info/address/:address` and `/api/info/metaid/:metaId`
- MAN already defines `--config` flag in `common/config.go` line 243 — do NOT reuse this name

---

## Task 1a: Copy MAN and Rename Module

**Goal:** Create the man-p2p directory from MAN, update module name.

- [ ] Create the project directory and copy MAN source tree:
  ```bash
  mkdir -p /Users/tusm/Documents/MetaID_Projects/man-p2p
  rsync -av --exclude='.git' --exclude='dist/' --exclude='test_build/' \
    /Users/tusm/Documents/MetaID_Projects/man/ \
    /Users/tusm/Documents/MetaID_Projects/man-p2p/
  ```
- [ ] Update module name in `go.mod` from `manindexer` to `man-p2p`, fix all internal imports, and tidy:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  sed -i '' 's/^module manindexer/module man-p2p/' go.mod
  find . -name '*.go' | xargs sed -i '' 's|"manindexer/|"man-p2p/|g'
  go mod tidy
  ```
- [ ] Bump Go toolchain in `go.mod` to `go 1.24`.
- [ ] Verify compilation:
  ```bash
  go build ./...
  ```
  Expected: builds without errors. If there are import issues from the sed, fix them manually.
- [ ] Initialize git repo and commit:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  git init && git add . && git commit -m "chore: copy MAN base, rename module to man-p2p"
  ```


## Task 1b: Disable MRC20

**Goal:** Disable MRC20 routes and indexing. Keep code but don't execute.

- [ ] Disable MRC20 HTTP routes in `api/webapi.go` — comment out the mrc20/mrc721 `r.GET` lines (do NOT delete):
  ```go
  // MRC20 routes disabled in man-p2p phase 1 — asset parsing not enabled this phase
  // r.GET("/mrc20/info/:id", mrc20Info)
  // r.GET("/mrc20/holders/:id/:page", mrc20Holders)
  // ... etc
  ```
- [ ] Disable MRC20 catch-up indexer in `app.go` — comment out `man.Mrc20CatchUpRun()` and `Mrc20Only` stat goroutines:
  ```go
  // man.Mrc20CatchUpRun() // disabled in man-p2p phase 1
  ```
- [ ] Verify compilation and existing tests pass:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go build ./...
  go test ./... -short -count=1
  ```
- [ ] Commit:
  ```bash
  git add -A && git commit -m "feat: disable MRC20 routes and indexing for phase 1"
  ```


## Task 2: Extend Existing User-Info with Address Lookup

**Goal:** MAN already has `pin.MetaIdInfo`, `MetaidInfoDB`, and `handleMetaIdInfo()`. But it stores user info keyed by MetaID only. We need to add a secondary address→MetaID index so the spec endpoint `GET /api/info/address/:address` can look up user info by address (MAN's existing handler at `btc_jsonapi.go:242` may already work — verify and extend if needed).

**Reuse, do NOT duplicate:** `pin.MetaIdInfo` (pin/pin.go:126), `MetaidInfoDB` (pebblestore/store.go:44), `handleMetaIdInfo()` (man/metaidInfo.go:7).

**Reference:** meta-file-system stores user info indexed by both address and metaid. MAN only indexes by metaid.

- [ ] Check existing `getInfoByAddress` handler in `api/btc_jsonapi.go:242-255`. Read the handler code to understand how it resolves address to MetaIdInfo. If it already works (e.g., uses AddressDB to find metaid then looks up MetaidInfoDB), this task may only need the chatpubkey path detection fix below.
- [ ] Check if `handleMetaIdInfo()` in `man/metaidInfo.go` processes `/info/chatpubkey` path. MAN's `metaIdInfoParse` (in same file) handles `name`, `avatar`, `bio`, but verify `chatpubkey`/`chatPublicKey` path is handled. If missing, add it:
  ```go
  // In metaIdInfoParse, add case for chatpubkey path
  case strings.HasPrefix(lower, "/info/chatpubkey"),
       strings.HasPrefix(lower, "/info/chatpublickey"):
      info.ChatPubKey = string(pinNode.ContentBody)
  ```
- [ ] Write test to verify chatpubkey is indexed (add to existing test file or create `man/metaidInfo_test.go`):
  ```go
  func TestChatPubKeyParsed(t *testing.T) {
      pinNode := &pin.PinInscription{
          MetaId:      "test-metaid",
          Address:     "1TestAddr",
          Path:        "/info/chatpubkey",
          ContentBody: []byte("02abc123...publickey"),
      }
      metaIdData := make(map[string]*pin.MetaIdInfo)
      metaIdInfoParse(pinNode, "", &metaIdData)
      info, ok := metaIdData["test-metaid"]
      if !ok || info.ChatPubKey != "02abc123...publickey" {
          t.Errorf("chatpubkey not parsed: %+v", info)
      }
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./man/... -run TestChatPubKeyParsed -v
  ```
- [ ] Commit:
  ```bash
  git add man/metaidInfo.go man/metaidInfo_test.go
  git commit -m "feat: ensure chatpubkey path is indexed in MetaIdInfo"
  ```


## Task 3: User-Info API Alias Routes

**Goal:** The spec requires `/api/v1/users/info/metaid/{metaId}` and `/api/v1/users/info/address/{address}` to match what IDBots expects. MAN already has `/api/info/metaid/:metaId` and `/api/info/address/:address`. Add alias routes that delegate to the existing handlers.

- [ ] Write test `api/userinfo_alias_test.go`:
  ```go
  func TestUserInfoAliasRoutes(t *testing.T) {
      r := setupTestRouter()

      // Test metaid alias
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/api/v1/users/info/metaid/test-metaid", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)

      // Test address alias
      w2 := httptest.NewRecorder()
      req2, _ := http.NewRequest("GET", "/api/v1/users/info/address/1TestAddr", nil)
      r.ServeHTTP(w2, req2)
      assert.Equal(t, 200, w2.Code)
  }
  ```
- [ ] Add alias routes in `api/btc_jsonapi.go` (inside `btcJsonApi` function, after existing routes):
  ```go
  // Alias routes for IDBots compatibility (spec section 5.2)
  v1 := r.Group("/api/v1")
  v1.Use(CorsMiddleware())
  v1.GET("/users/info/metaid/:metaId", getInfoByMetaId)     // delegates to existing handler
  v1.GET("/users/info/address/:address", getInfoByAddress)   // delegates to existing handler
  ```
- [ ] Run test:
  ```bash
  go test ./api/... -run TestUserInfoAliasRoutes -v
  ```
- [ ] Commit:
  ```bash
  git add api/btc_jsonapi.go api/userinfo_alias_test.go
  git commit -m "feat: add /api/v1/users/info/* alias routes for IDBots"
  ```


## Task 4: Health Endpoint

**Goal:** `GET /health` returns `{"status":"ok","version":"..."}` for subprocess health checking.

- [ ] Create `common/version.go`:
  ```go
  package common
  var Version = "0.1.0" // injected via -ldflags at build time
  ```
- [ ] Write test `api/health_test.go`:
  ```go
  func TestHealthEndpoint(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/health", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)
      assert.Contains(t, w.Body.String(), "ok")
  }
  ```
- [ ] Add in `api/webapi.go`:
  ```go
  r.GET("/health", func(ctx *gin.Context) {
      ctx.JSON(200, gin.H{"status": "ok", "version": common.Version})
  })
  ```
- [ ] Run test:
  ```bash
  go test ./api/... -run TestHealthEndpoint -v
  ```
- [ ] Commit:
  ```bash
  git add common/version.go api/webapi.go api/health_test.go
  git commit -m "feat: add /health endpoint"
  ```


## Task 5: P2P Config Loading

**Goal:** Define `P2PSyncConfig` struct, load from `--p2p-config` flag (NOT `--config` — that's already taken by MAN). Add `--data-dir` flag for PebbleDB path.

- [ ] Create `p2p/config.go`:
  ```go
  // p2p/config.go
  package p2p

  import (
      "encoding/json"
      "os"
      "sync"
  )

  type P2PSyncConfig struct {
      SyncMode           string   `json:"p2p_sync_mode"`
      SelectiveAddresses []string `json:"p2p_selective_addresses"`
      SelectivePaths     []string `json:"p2p_selective_paths"`
      BlockAddresses     []string `json:"p2p_block_addresses"`
      BlockPaths         []string `json:"p2p_block_paths"`
      MaxContentSizeKB   int64    `json:"p2p_max_content_size_kb"`
      BootstrapNodes     []string `json:"p2p_bootstrap_nodes"`
      EnableRelay        bool     `json:"p2p_enable_relay"`
      StorageLimitGB     float64  `json:"p2p_storage_limit_gb"`
  }

  var (
      currentConfig P2PSyncConfig
      configPath    string
      configMu      sync.RWMutex
  )

  func LoadConfig(path string) error {
      configPath = path
      return ReloadConfig()
  }

  func ReloadConfig() error {
      if configPath == "" {
          return nil // no config file provided, use defaults
      }
      data, err := os.ReadFile(configPath)
      if err != nil {
          return err
      }
      var cfg P2PSyncConfig
      if err := json.Unmarshal(data, &cfg); err != nil {
          return err
      }
      configMu.Lock()
      currentConfig = cfg
      configMu.Unlock()
      return nil
  }

  func GetConfig() P2PSyncConfig {
      configMu.RLock()
      defer configMu.RUnlock()
      return currentConfig
  }
  ```
- [ ] Add `--p2p-config` and `--data-dir` flags in `app.go` (BEFORE `common.InitConfig` call, which calls `flag.Parse()`):
  ```go
  var p2pConfigFile string
  var p2pDataDir string
  // Register flags before any flag.Parse() call
  flag.StringVar(&p2pConfigFile, "p2p-config", "", "path to p2p sync config JSON file")
  flag.StringVar(&p2pDataDir, "data-dir", "", "path to PebbleDB data directory (overrides config)")
  ```
  After flag parsing and config init:
  ```go
  if p2pConfigFile != "" {
      if err := p2p.LoadConfig(p2pConfigFile); err != nil {
          log.Printf("warn: failed to load p2p config: %v", err)
      }
  }
  ```
- [ ] Write test `p2p/config_test.go`:
  ```go
  func TestLoadConfig(t *testing.T) {
      cfg := `{
          "p2p_sync_mode": "selective",
          "p2p_selective_addresses": ["1A2B3C"],
          "p2p_max_content_size_kb": 512,
          "p2p_storage_limit_gb": 10,
          "p2p_enable_relay": true
      }`
      f, _ := os.CreateTemp("", "p2p-config-*.json")
      f.WriteString(cfg)
      f.Close()
      defer os.Remove(f.Name())

      if err := LoadConfig(f.Name()); err != nil {
          t.Fatal(err)
      }
      got := GetConfig()
      if got.SyncMode != "selective" {
          t.Errorf("expected selective, got %s", got.SyncMode)
      }
      if got.MaxContentSizeKB != 512 {
          t.Errorf("expected 512, got %d", got.MaxContentSizeKB)
      }
  }

  // helper used by other p2p tests
  func writeTempConfig(t *testing.T, jsonStr string) string {
      t.Helper()
      f, err := os.CreateTemp("", "p2p-config-*.json")
      if err != nil {
          t.Fatal(err)
      }
      f.WriteString(jsonStr)
      f.Close()
      t.Cleanup(func() { os.Remove(f.Name()) })
      return f.Name()
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestLoadConfig -v
  ```
- [ ] Commit:
  ```bash
  git add p2p/config.go p2p/config_test.go app.go
  git commit -m "feat: P2PSyncConfig struct, --p2p-config and --data-dir flags"
  ```


## Task 6: p2p/host.go — libp2p Node

**Goal:** Initialize a go-libp2p host with persistent ed25519 identity, Kademlia DHT, bootstrap node connections.

- [ ] Add go-libp2p dependencies:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go get github.com/libp2p/go-libp2p@latest
  go get github.com/libp2p/go-libp2p-kad-dht@latest
  go get github.com/libp2p/go-libp2p-pubsub@latest
  go mod tidy
  ```
- [ ] Create `p2p/host.go`:
  ```go
  package p2p

  import (
      "context"
      "crypto/rand"
      "encoding/hex"
      "fmt"
      "os"
      "path/filepath"

      "github.com/libp2p/go-libp2p"
      dht "github.com/libp2p/go-libp2p-kad-dht"
      "github.com/libp2p/go-libp2p/core/crypto"
      "github.com/libp2p/go-libp2p/core/host"
      "github.com/libp2p/go-libp2p/core/peer"
      "github.com/multiformats/go-multiaddr"
  )

  var (
      Node   host.Host
      KadDHT *dht.IpfsDHT
  )

  func InitHost(ctx context.Context, dataDir string) error {
      privKey, err := loadOrCreateIdentity(dataDir)
      if err != nil {
          return fmt.Errorf("identity: %w", err)
      }

      Node, err = libp2p.New(
          libp2p.Identity(privKey),
          libp2p.ListenAddrStrings("/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0"),
          libp2p.NATPortMap(),
      )
      if err != nil {
          return fmt.Errorf("libp2p.New: %w", err)
      }

      KadDHT, err = dht.New(ctx, Node, dht.Mode(dht.ModeAuto))
      if err != nil {
          return fmt.Errorf("dht.New: %w", err)
      }
      if err := KadDHT.Bootstrap(ctx); err != nil {
          return fmt.Errorf("dht.Bootstrap: %w", err)
      }

      go connectBootstrapNodes(ctx)
      return nil
  }

  func connectBootstrapNodes(ctx context.Context) {
      cfg := GetConfig()
      for _, addrStr := range cfg.BootstrapNodes {
          ma, err := multiaddr.NewMultiaddr(addrStr)
          if err != nil {
              continue
          }
          pi, err := peer.AddrInfoFromP2pAddr(ma)
          if err != nil {
              continue
          }
          _ = Node.Connect(ctx, *pi)
      }
  }

  func loadOrCreateIdentity(dataDir string) (crypto.PrivKey, error) {
      keyPath := filepath.Join(dataDir, "identity.key")
      if data, err := os.ReadFile(keyPath); err == nil {
          b, err := hex.DecodeString(string(data))
          if err == nil {
              return crypto.UnmarshalPrivateKey(b)
          }
      }
      priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
      if err != nil {
          return nil, err
      }
      b, err := crypto.MarshalPrivateKey(priv)
      if err != nil {
          return nil, err
      }
      _ = os.MkdirAll(dataDir, 0700)
      _ = os.WriteFile(keyPath, []byte(hex.EncodeToString(b)), 0600)
      return priv, nil
  }

  // CloseHost shuts down the libp2p node gracefully.
  func CloseHost() error {
      if Node != nil {
          return Node.Close()
      }
      return nil
  }
  ```
- [ ] Write test `p2p/host_test.go`:
  ```go
  func TestInitHost(t *testing.T) {
      dir := t.TempDir()
      ctx, cancel := context.WithCancel(context.Background())
      defer cancel()

      if err := InitHost(ctx, dir); err != nil {
          t.Fatal(err)
      }
      defer CloseHost()

      if Node == nil {
          t.Fatal("Node is nil")
      }
      if Node.ID() == "" {
          t.Fatal("empty peer ID")
      }
      if KadDHT == nil {
          t.Fatal("KadDHT is nil")
      }

      // Identity persists across restarts
      id1 := Node.ID()
      CloseHost()
      if err := InitHost(ctx, dir); err != nil {
          t.Fatal(err)
      }
      if Node.ID() != id1 {
          t.Errorf("identity changed: %s != %s", Node.ID(), id1)
      }
  }
  ```
- [ ] Run test:
  ```bash
  go test ./p2p/... -run TestInitHost -v -timeout 30s
  ```
- [ ] Commit:
  ```bash
  git add p2p/host.go p2p/host_test.go go.mod go.sum
  git commit -m "feat: p2p/host.go — libp2p node with persistent identity and Kademlia DHT"
  ```


## Task 7: p2p/gossip.go — GossipSub

**Goal:** Subscribe to `metaid-pins` topic. Publish PIN metadata on new local PINs. Forward received announcements to sync handler.

- [ ] Create `p2p/gossip.go`:
  ```go
  package p2p

  import (
      "context"
      "encoding/json"
      "log"

      pubsub "github.com/libp2p/go-libp2p-pubsub"
  )

  const TopicName = "metaid-pins"

  type PinAnnouncement struct {
      PinId     string `json:"pinId"`
      Path      string `json:"path"`
      Address   string `json:"address"`
      Confirmed bool   `json:"confirmed"`
      SizeBytes int64  `json:"sizeBytes"`
      PeerID    string `json:"peerId"`
  }

  var (
      PS    *pubsub.PubSub
      topic *pubsub.Topic
      sub   *pubsub.Subscription
  )

  func InitGossip(ctx context.Context) error {
      var err error
      PS, err = pubsub.NewGossipSub(ctx, Node)
      if err != nil {
          return err
      }
      topic, err = PS.Join(TopicName)
      if err != nil {
          return err
      }
      sub, err = topic.Subscribe()
      if err != nil {
          return err
      }
      go receiveLoop(ctx)
      return nil
  }

  func PublishPin(ctx context.Context, ann PinAnnouncement) error {
      ann.PeerID = Node.ID().String()
      data, err := json.Marshal(ann)
      if err != nil {
          return err
      }
      return topic.Publish(ctx, data)
  }

  func receiveLoop(ctx context.Context) {
      for {
          msg, err := sub.Next(ctx)
          if err != nil {
              return
          }
          if msg.ReceivedFrom == Node.ID() {
              continue
          }
          var ann PinAnnouncement
          if err := json.Unmarshal(msg.Data, &ann); err != nil {
              log.Printf("gossip: bad message from %s: %v", msg.ReceivedFrom, err)
              continue
          }
          HandleIncomingAnnouncement(ctx, ann)
      }
  }
  ```
- [ ] Create stub `p2p/sync.go` so gossip.go compiles (full implementation in Task 9):
  ```go
  package p2p

  import "context"

  // HandleIncomingAnnouncement is called by gossip receiveLoop.
  // Stub — full implementation in Task 9.
  func HandleIncomingAnnouncement(ctx context.Context, ann PinAnnouncement) {
      // TODO: implement in Task 9
  }
  ```
- [ ] Verify compilation:
  ```bash
  go build ./p2p/...
  ```
- [ ] Commit:
  ```bash
  git add p2p/gossip.go p2p/sync.go
  git commit -m "feat: p2p/gossip.go — GossipSub PIN announcement + sync.go stub"
  ```


## Task 8: p2p/subscription.go — Sync Filter

**Goal:** Implement self/selective/full mode filtering and blocklist. **Blocklist overrides allowlist.** MaxContentSizeKB is NOT checked here — it's handled in sync.go to allow metadata-only storage for oversized PINs.

- [ ] Create `p2p/subscription.go`:
  ```go
  package p2p

  import (
      "path/filepath"
      "strings"
  )

  // ShouldSync returns true if the PIN announcement passes the sync filter.
  // MaxContentSizeKB is NOT checked here — oversized PINs still sync (metadata only).
  func ShouldSync(ann PinAnnouncement) bool {
      cfg := GetConfig()

      // Blocklist (highest priority — overrides allowlist)
      if isBlocked(ann, cfg) {
          return false
      }

      switch cfg.SyncMode {
      case "full":
          return true
      case "self":
          return isOwnAddress(ann.Address)
      case "selective":
          return isInSelectiveList(ann, cfg)
      default:
          return false
      }
  }

  func isBlocked(ann PinAnnouncement, cfg P2PSyncConfig) bool {
      for _, addr := range cfg.BlockAddresses {
          if addr == ann.Address {
              return true
          }
      }
      for _, pattern := range cfg.BlockPaths {
          if matched, _ := filepath.Match(pattern, ann.Path); matched {
              return true
          }
      }
      // NOTE: MaxContentSizeKB is NOT checked here.
      // Oversized PINs pass the filter but get metadata-only storage in sync.go.
      return false
  }

  func isInSelectiveList(ann PinAnnouncement, cfg P2PSyncConfig) bool {
      for _, addr := range cfg.SelectiveAddresses {
          if addr == ann.Address {
              return true
          }
      }
      for _, pattern := range cfg.SelectivePaths {
          if matched, _ := filepath.Match(pattern, ann.Path); matched {
              return true
          }
          if !strings.Contains(pattern, "*") && strings.HasPrefix(ann.Path, pattern) {
              return true
          }
      }
      return false
  }

  var OwnAddresses []string

  func isOwnAddress(address string) bool {
      for _, a := range OwnAddresses {
          if a == address {
              return true
          }
      }
      return false
  }
  ```
- [ ] Write test `p2p/subscription_test.go`:
  ```go
  func TestBlocklistOverridesAllowlist(t *testing.T) {
      _ = LoadConfig(writeTempConfig(t, `{
          "p2p_sync_mode": "selective",
          "p2p_selective_addresses": ["1AllowedAddr"],
          "p2p_block_addresses": ["1AllowedAddr"]
      }`))
      ann := PinAnnouncement{PinId: "p1", Address: "1AllowedAddr", Path: "/info/name"}
      if ShouldSync(ann) {
          t.Error("blocked address should not sync even if in selective list")
      }
  }

  func TestSelectivePathMatch(t *testing.T) {
      _ = LoadConfig(writeTempConfig(t, `{
          "p2p_sync_mode": "selective",
          "p2p_selective_paths": ["/info/*"]
      }`))
      ann := PinAnnouncement{PinId: "p2", Address: "1Addr", Path: "/info/name", SizeBytes: 50}
      if !ShouldSync(ann) {
          t.Error("/info/name should match /info/* pattern")
      }
  }

  func TestOversizedPinStillPassesFilter(t *testing.T) {
      _ = LoadConfig(writeTempConfig(t, `{
          "p2p_sync_mode": "full",
          "p2p_max_content_size_kb": 100
      }`))
      // 200KB PIN in full mode — should pass filter (metadata-only handled in sync.go)
      ann := PinAnnouncement{PinId: "p3", Address: "1Addr", Path: "/info/name", SizeBytes: 200 * 1024}
      if !ShouldSync(ann) {
          t.Error("oversized PIN should pass filter in full mode (metadata-only handled in sync.go)")
      }
  }
  ```
- [ ] Run test:
  ```bash
  go test ./p2p/... -run "TestBlocklist|TestSelective|TestOversized" -v
  ```
- [ ] Commit:
  ```bash
  git add p2p/subscription.go p2p/subscription_test.go
  git commit -m "feat: p2p/subscription.go — self/selective/full filter, blocklist priority"
  ```


## Task 9: p2p/sync.go — Content Pull (Full Implementation)

**Goal:** Replace the stub with full content pull via libp2p stream protocol. Handle MaxContentSizeKB: oversized PINs get metadata-only storage.

- [ ] Replace `p2p/sync.go` with full implementation:
  ```go
  package p2p

  import (
      "bufio"
      "context"
      "encoding/json"
      "fmt"
      "io"
      "log"

      "github.com/libp2p/go-libp2p/core/network"
      "github.com/libp2p/go-libp2p/core/peer"
      "github.com/libp2p/go-libp2p/core/protocol"
  )

  const SyncProtocol = protocol.ID("/metaid/pin-sync/1.0.0")

  type PinRequest struct {
      PinId string `json:"pinId"`
  }

  type PinResponse struct {
      PinId     string `json:"pinId"`
      Path      string `json:"path"`
      Address   string `json:"address"`
      Confirmed bool   `json:"confirmed"`
      Content   []byte `json:"content"`
      Error     string `json:"error,omitempty"`
  }

  // GetPinFn is set by the caller (app.go) to read PINs from PebbleDB.
  var GetPinFn func(pinId string) (*PinResponse, error)

  // StorePinFn is set by the caller to write full PIN data to PebbleDB.
  var StorePinFn func(resp *PinResponse) error

  // StorePinMetadataOnlyFn writes PIN metadata without content (content_fetched=false).
  var StorePinMetadataOnlyFn func(ann PinAnnouncement) error

  func RegisterSyncHandler() {
      Node.SetStreamHandler(SyncProtocol, func(s network.Stream) {
          defer s.Close()
          var req PinRequest
          if err := json.NewDecoder(s).Decode(&req); err != nil {
              return
          }
          resp, err := GetPinFn(req.PinId)
          if err != nil {
              resp = &PinResponse{PinId: req.PinId, Error: err.Error()}
          }
          json.NewEncoder(s).Encode(resp)
      })
  }

  func FetchPin(ctx context.Context, peerID peer.ID, pinId string) (*PinResponse, error) {
      s, err := Node.NewStream(ctx, peerID, SyncProtocol)
      if err != nil {
          return nil, fmt.Errorf("open stream to %s: %w", peerID, err)
      }
      defer s.Close()

      if err := json.NewEncoder(s).Encode(PinRequest{PinId: pinId}); err != nil {
          return nil, err
      }
      s.CloseWrite()

      var resp PinResponse
      if err := json.NewDecoder(bufio.NewReader(s)).Decode(&resp); err != nil && err != io.EOF {
          return nil, err
      }
      if resp.Error != "" {
          return nil, fmt.Errorf("peer error: %s", resp.Error)
      }
      return &resp, nil
  }

  func HandleIncomingAnnouncement(ctx context.Context, ann PinAnnouncement) {
      // Check storage limit
      if storageLimitReached.Load() {
          return
      }

      // Check sync filter (blocklist + mode)
      if !ShouldSync(ann) {
          return
      }

      // MaxContentSizeKB: oversized PINs get metadata-only storage
      cfg := GetConfig()
      if cfg.MaxContentSizeKB > 0 && ann.SizeBytes > cfg.MaxContentSizeKB*1024 {
          if StorePinMetadataOnlyFn != nil {
              if err := StorePinMetadataOnlyFn(ann); err != nil {
                  log.Printf("sync: store metadata-only for %s failed: %v", ann.PinId, err)
              }
          }
          return
      }

      // Fetch full content from announcing peer
      peerID, err := peer.Decode(ann.PeerID)
      if err != nil {
          log.Printf("sync: invalid peer ID %s: %v", ann.PeerID, err)
          return
      }
      resp, err := FetchPin(ctx, peerID, ann.PinId)
      if err != nil {
          log.Printf("sync: fetch %s from %s failed: %v", ann.PinId, peerID, err)
          return
      }
      if StorePinFn != nil {
          if err := StorePinFn(resp); err != nil {
              log.Printf("sync: store %s failed: %v", ann.PinId, err)
          }
      }
  }
  ```
- [ ] Write test `p2p/sync_test.go` — two separate libp2p hosts, node A serves, node B fetches:
  ```go
  func TestContentPull(t *testing.T) {
      ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
      defer cancel()

      // Node A: start host and serve PINs
      dirA := t.TempDir()
      if err := InitHost(ctx, dirA); err != nil {
          t.Fatal(err)
      }
      nodeA := Node
      GetPinFn = func(pinId string) (*PinResponse, error) {
          if pinId == "pin001" {
              return &PinResponse{PinId: "pin001", Path: "/info/name",
                  Address: "1Addr", Confirmed: true, Content: []byte("Alice")}, nil
          }
          return nil, fmt.Errorf("not found")
      }
      RegisterSyncHandler()

      // Node B: separate host
      dirB := t.TempDir()
      nodeB, err := libp2p.New(libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
      if err != nil {
          t.Fatal(err)
      }
      defer nodeB.Close()
      nodeB.Connect(ctx, peer.AddrInfo{ID: nodeA.ID(), Addrs: nodeA.Addrs()})
      time.Sleep(500 * time.Millisecond)

      // Fetch from node B using nodeB's stream
      s, err := nodeB.NewStream(ctx, nodeA.ID(), SyncProtocol)
      if err != nil {
          t.Fatal(err)
      }
      json.NewEncoder(s).Encode(PinRequest{PinId: "pin001"})
      s.CloseWrite()
      var resp PinResponse
      json.NewDecoder(s).Decode(&resp)
      s.Close()

      if string(resp.Content) != "Alice" {
          t.Errorf("expected Alice, got %s", resp.Content)
      }
  }
  ```
- [ ] Run test:
  ```bash
  go test ./p2p/... -run TestContentPull -v -timeout 30s
  ```
- [ ] Commit:
  ```bash
  git add p2p/sync.go p2p/sync_test.go
  git commit -m "feat: p2p/sync.go — content pull via libp2p stream, metadata-only for oversized PINs"
  ```


## Task 10: p2p/relay.go — NAT Traversal

**Goal:** AutoNAT, hole punching, relay client, mDNS local discovery.

- [ ] Create `p2p/relay.go`:
  ```go
  package p2p

  import (
      "context"
      "log"

      "github.com/libp2p/go-libp2p"
      "github.com/libp2p/go-libp2p/core/host"
      "github.com/libp2p/go-libp2p/core/peer"
      "github.com/libp2p/go-libp2p/p2p/discovery/mdns"
  )

  func NATOptions() []libp2p.Option {
      cfg := GetConfig()
      opts := []libp2p.Option{
          libp2p.EnableNATService(),
          libp2p.EnableHolePunching(),
      }
      if cfg.EnableRelay {
          relayAddrs := parseRelayAddrs(cfg.BootstrapNodes)
          if len(relayAddrs) > 0 {
              opts = append(opts, libp2p.EnableAutoRelayWithStaticRelays(relayAddrs))
          }
      }
      return opts
  }

  func parseRelayAddrs(addrs []string) []peer.AddrInfo {
      var result []peer.AddrInfo
      for _, a := range addrs {
          pi, err := peer.AddrInfoFromString(a)
          if err == nil {
              result = append(result, *pi)
          }
      }
      return result
  }

  type mdnsNotifee struct{ h host.Host }

  func (n *mdnsNotifee) HandlePeerFound(pi peer.AddrInfo) {
      log.Printf("mdns: discovered peer %s", pi.ID)
      _ = n.h.Connect(context.Background(), pi)
  }

  func InitMDNS(ctx context.Context) {
      svc := mdns.NewMdnsService(Node, "metaid-p2p", &mdnsNotifee{h: Node})
      if err := svc.Start(); err != nil {
          log.Printf("mdns: start failed: %v", err)
          return
      }
      go func() {
          <-ctx.Done()
          svc.Close()
      }()
  }
  ```
- [ ] Update `p2p/host.go` `InitHost` to include NAT options:
  ```go
  natOpts := NATOptions()
  allOpts := append([]libp2p.Option{
      libp2p.Identity(privKey),
      libp2p.ListenAddrStrings("/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0"),
      libp2p.NATPortMap(),
  }, natOpts...)
  Node, err = libp2p.New(allOpts...)
  ```
  And after DHT bootstrap, add:
  ```go
  go InitMDNS(ctx)
  ```
- [ ] Write test `p2p/relay_test.go`:
  ```go
  func TestMDNSDiscovery(t *testing.T) {
      if testing.Short() {
          t.Skip("mDNS test skipped in short mode")
      }
      ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
      defer cancel()

      dir1 := t.TempDir()
      if err := InitHost(ctx, dir1); err != nil {
          t.Fatal(err)
      }
      nodeA := Node

      // Start second node with mDNS
      nodeB, _ := libp2p.New(libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
      defer nodeB.Close()
      svc := mdns.NewMdnsService(nodeB, "metaid-p2p", &mdnsNotifee{h: nodeB})
      svc.Start()
      defer svc.Close()

      deadline := time.Now().Add(8 * time.Second)
      for time.Now().Before(deadline) {
          if len(nodeA.Network().Peers()) > 0 || len(nodeB.Network().Peers()) > 0 {
              return // success
          }
          time.Sleep(500 * time.Millisecond)
      }
      t.Error("mDNS did not discover peer within timeout")
  }
  ```
- [ ] Run test:
  ```bash
  go test ./p2p/... -run TestMDNSDiscovery -v -timeout 20s
  ```
- [ ] Commit:
  ```bash
  git add p2p/relay.go p2p/relay_test.go p2p/host.go
  git commit -m "feat: p2p/relay.go — AutoNAT, hole punch, relay client, mDNS"
  ```


## Task 11: Storage Limit Monitor

**Goal:** Periodic goroutine (60s) walks data dir, sums file sizes. When limit reached, stop P2P sync. Also provides `GetStatus()` and `GetPeers()` for API layer.

- [ ] Create `p2p/storage.go`:
  ```go
  package p2p

  import (
      "context"
      "io/fs"
      "log"
      "path/filepath"
      "sync/atomic"
      "time"
  )

  var (
      storageUsedBytes    atomic.Int64
      storageLimitReached atomic.Bool
  )

  func StartStorageMonitor(ctx context.Context, dataDir string) {
      go func() {
          ticker := time.NewTicker(60 * time.Second)
          defer ticker.Stop()
          checkStorage(dataDir)
          for {
              select {
              case <-ctx.Done():
                  return
              case <-ticker.C:
                  checkStorage(dataDir)
              }
          }
      }()
  }

  func checkStorage(dataDir string) {
      var total int64
      _ = filepath.WalkDir(dataDir, func(_ string, d fs.DirEntry, err error) error {
          if err != nil || d.IsDir() {
              return nil
          }
          info, err := d.Info()
          if err == nil {
              total += info.Size()
          }
          return nil
      })
      storageUsedBytes.Store(total)

      cfg := GetConfig()
      limitBytes := int64(cfg.StorageLimitGB * 1024 * 1024 * 1024)
      if limitBytes > 0 && total >= limitBytes {
          if !storageLimitReached.Load() {
              log.Printf("storage: limit reached (%.2f GB, limit %.2f GB) — P2P sync paused",
                  float64(total)/(1<<30), cfg.StorageLimitGB)
          }
          storageLimitReached.Store(true)
      } else {
          storageLimitReached.Store(false)
      }
  }

  func GetStatus() map[string]interface{} {
      peerCount := 0
      if Node != nil {
          peerCount = len(Node.Network().Peers())
      }
      return map[string]interface{}{
          "peerCount":           peerCount,
          "syncProgress":        0.0,
          "dataSource":          "p2p",
          "storageLimitReached": storageLimitReached.Load(),
          "storageUsedBytes":    storageUsedBytes.Load(),
      }
  }

  func GetPeers() []string {
      if Node == nil {
          return []string{}
      }
      peers := Node.Network().Peers()
      ids := make([]string, len(peers))
      for i, p := range peers {
          ids[i] = p.String()
      }
      return ids
  }
  ```
- [ ] Write test `p2p/storage_test.go`:
  ```go
  func TestStorageLimitEnforcement(t *testing.T) {
      dir := t.TempDir()
      os.WriteFile(filepath.Join(dir, "data.bin"), make([]byte, 1024), 0644)

      _ = LoadConfig(writeTempConfig(t, `{"p2p_storage_limit_gb": 0.000001}`))
      checkStorage(dir)
      if !storageLimitReached.Load() {
          t.Error("expected storageLimitReached=true")
      }

      _ = LoadConfig(writeTempConfig(t, `{"p2p_storage_limit_gb": 100}`))
      checkStorage(dir)
      if storageLimitReached.Load() {
          t.Error("expected storageLimitReached=false after raising limit")
      }
  }
  ```
- [ ] Run test:
  ```bash
  go test ./p2p/... -run TestStorageLimitEnforcement -v
  ```
- [ ] Commit:
  ```bash
  git add p2p/storage.go p2p/storage_test.go
  git commit -m "feat: storage limit monitor — pause P2P sync when limit reached"
  ```


## Task 12: P2P API Endpoints (Config Reload + Status + Peers)

**Goal:** Now that p2p package is complete, add the HTTP endpoints that depend on it.

- [ ] Create `api/p2p_api.go`:
  ```go
  package api

  import (
      "man-p2p/api/respond"
      "man-p2p/p2p"

      "github.com/gin-gonic/gin"
  )

  func RegisterP2PRoutes(r *gin.Engine) {
      r.POST("/api/config/reload", configReload)
      r.GET("/api/p2p/status", p2pStatus)
      r.GET("/api/p2p/peers", p2pPeers)
  }

  func configReload(ctx *gin.Context) {
      if err := p2p.ReloadConfig(); err != nil {
          ctx.JSON(500, gin.H{"error": err.Error()})
          return
      }
      ctx.JSON(200, gin.H{"status": "reloaded"})
  }

  func p2pStatus(ctx *gin.Context) {
      ctx.JSON(200, respond.ApiSuccess(1, "ok", p2p.GetStatus()))
  }

  func p2pPeers(ctx *gin.Context) {
      ctx.JSON(200, respond.ApiSuccess(1, "ok", p2p.GetPeers()))
  }
  ```
- [ ] Register routes in `api/webapi.go` — call `RegisterP2PRoutes(r)` after other route registrations.
- [ ] Write test `api/p2p_api_test.go`:
  ```go
  func TestP2PStatusEndpoint(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/api/p2p/status", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)
      assert.Contains(t, w.Body.String(), "peerCount")
  }

  func TestConfigReloadEndpoint(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("POST", "/api/config/reload", nil)
      r.ServeHTTP(w, req)
      // May return 200 or 500 depending on config state; assert not 404
      assert.NotEqual(t, 404, w.Code)
  }
  ```
- [ ] Run tests:
  ```bash
  go test ./api/... -run "TestP2PStatus|TestConfigReload" -v
  ```
- [ ] Commit:
  ```bash
  git add api/p2p_api.go api/p2p_api_test.go api/webapi.go
  git commit -m "feat: add P2P status, peers, config-reload HTTP endpoints"
  ```


## Task 13: Integration Wiring in app.go

**Goal:** Wire all P2P components together in the main entry point.

- [ ] In `app.go`, after existing `man.InitAdapter()` and `api.Start()` calls, add P2P initialization:
  ```go
  // P2P initialization
  ctx, cancel := context.WithCancel(context.Background())
  defer cancel()

  if p2pConfigFile != "" {
      if err := p2p.LoadConfig(p2pConfigFile); err != nil {
          log.Printf("warn: p2p config load failed: %v", err)
      }
  }

  dataDir := p2pDataDir
  if dataDir == "" {
      dataDir = "./man_p2p_data"
  }
  os.MkdirAll(dataDir, 0700)

  if err := p2p.InitHost(ctx, dataDir); err != nil {
      log.Printf("warn: p2p host init failed: %v", err)
  } else {
      if err := p2p.InitGossip(ctx); err != nil {
          log.Printf("warn: p2p gossip init failed: %v", err)
      }
      p2p.RegisterSyncHandler()
      p2p.StartStorageMonitor(ctx, dataDir)
      log.Printf("P2P node started: %s", p2p.Node.ID())
  }
  ```
- [ ] Hook PIN indexing to publish via GossipSub. In `man/indexer_pebble.go` (or wherever `SetAllPins` is called), after writing PINs to PebbleDB:
  ```go
  // After SetAllPins, broadcast new PINs via P2P
  for _, pinNode := range pinList {
      ann := p2p.PinAnnouncement{
          PinId:     pinNode.Id,
          Path:      pinNode.Path,
          Address:   pinNode.Address,
          Confirmed: pinNode.GenesisHeight > 0,
          SizeBytes: int64(pinNode.ContentLength),
      }
      p2p.PublishPin(context.Background(), ann)
  }
  ```
- [ ] Wire storage functions:
  ```go
  p2p.GetPinFn = func(pinId string) (*p2p.PinResponse, error) {
      data := PebbleStore.Database.GetPinByKey(pinId)
      if data == nil {
          return nil, fmt.Errorf("not found")
      }
      // unmarshal and return as PinResponse
      var pinNode pin.PinInscription
      json.Unmarshal(data, &pinNode)
      return &p2p.PinResponse{
          PinId: pinNode.Id, Path: pinNode.Path,
          Address: pinNode.Address, Confirmed: pinNode.GenesisHeight > 0,
          Content: pinNode.ContentBody,
      }, nil
  }
  ```
- [ ] Verify the binary compiles and starts:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go build -o dist/man-p2p .
  ./dist/man-p2p --help
  ```
- [ ] Commit:
  ```bash
  git add app.go man/indexer_pebble.go
  git commit -m "feat: wire P2P components in app.go, publish PINs via GossipSub"
  ```


## Task 14: Cross-Platform Build

**Goal:** Makefile for all 4 platform targets.

- [ ] Create `Makefile`:
  ```makefile
  BINARY  := man-p2p
  VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
  LDFLAGS := -ldflags "-X man-p2p/common.Version=$(VERSION) -s -w"
  DIST    := dist

  .PHONY: all clean

  all: build-darwin-arm64 build-darwin-amd64 build-windows-amd64 build-linux-amd64

  build-darwin-arm64:
  	@mkdir -p $(DIST)
  	GOOS=darwin GOARCH=arm64 CGO_ENABLED=1 \
  	  go build $(LDFLAGS) -o $(DIST)/$(BINARY)-darwin-arm64 .

  build-darwin-amd64:
  	@mkdir -p $(DIST)
  	GOOS=darwin GOARCH=amd64 CGO_ENABLED=1 \
  	  go build $(LDFLAGS) -o $(DIST)/$(BINARY)-darwin-amd64 .

  build-windows-amd64:
  	@mkdir -p $(DIST)
  	GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc \
  	  go build $(LDFLAGS) -o $(DIST)/$(BINARY)-win32-x64.exe .

  build-linux-amd64:
  	@mkdir -p $(DIST)
  	GOOS=linux GOARCH=amd64 CGO_ENABLED=1 \
  	  go build $(LDFLAGS) -o $(DIST)/$(BINARY)-linux-x64 .

  clean:
  	rm -rf $(DIST)
  ```
- [ ] Add `dist/` to `.gitignore`.
- [ ] Verify native build:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  make build-darwin-arm64
  ls -lh dist/
  ```
- [ ] Commit:
  ```bash
  git add Makefile .gitignore
  git commit -m "feat: cross-platform Makefile for darwin/windows/linux builds"
  ```

---

## File Map

All paths relative to `/Users/tusm/Documents/MetaID_Projects/man-p2p/`:

| File | Task | Description |
|------|------|-------------|
| `go.mod` | 1a | Module `man-p2p`, Go 1.24 |
| `app.go` | 1b, 5, 13 | Entry point, flags, P2P wiring |
| `common/version.go` | 4 | `var Version string` |
| `man/metaidInfo.go` | 2 | chatpubkey path detection (verify/extend) |
| `man/metaidInfo_test.go` | 2 | chatpubkey parsing test |
| `api/btc_jsonapi.go` | 3 | `/api/v1/users/info/*` alias routes |
| `api/userinfo_alias_test.go` | 3 | Alias route tests |
| `api/webapi.go` | 4, 12 | Health endpoint, P2P route registration |
| `api/health_test.go` | 4 | Health test |
| `api/p2p_api.go` | 12 | Config reload, P2P status/peers |
| `api/p2p_api_test.go` | 12 | P2P API tests |
| `p2p/config.go` | 5 | P2PSyncConfig, LoadConfig, ReloadConfig |
| `p2p/config_test.go` | 5 | Config loading tests + `writeTempConfig` helper |
| `p2p/host.go` | 6, 10 | libp2p host, DHT, identity, NAT options |
| `p2p/host_test.go` | 6 | Host init tests |
| `p2p/gossip.go` | 7 | GossipSub publish/receive |
| `p2p/subscription.go` | 8 | Sync filter (blocklist, no size check here) |
| `p2p/subscription_test.go` | 8 | Filter tests (including oversized-passes-filter) |
| `p2p/sync.go` | 7 (stub), 9 (full) | Content pull, metadata-only for oversized |
| `p2p/sync_test.go` | 9 | Two-node content pull test |
| `p2p/relay.go` | 10 | AutoNAT, hole punch, relay, mDNS |
| `p2p/relay_test.go` | 10 | mDNS discovery test |
| `p2p/storage.go` | 11 | Storage monitor, GetStatus, GetPeers |
| `p2p/storage_test.go` | 11 | Storage limit test |
| `Makefile` | 14 | Cross-platform build |
