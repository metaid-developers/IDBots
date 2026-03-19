# man-p2p Go Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create man-p2p, a Go-based MetaID PIN indexer with embedded libp2p P2P sync, by merging MAN (primary) + meta-file-system user-info features + new P2P layer.

**Architecture:** man-p2p runs as a standalone Go binary managed as a subprocess by IDBots Electron. It exposes a local HTTP API on :7281 that mirrors the existing manapi.metaid.io response envelope. The P2P layer uses go-libp2p with Kademlia DHT for peer discovery and GossipSub for real-time PIN broadcast.

**Tech Stack:** Go 1.24, go-libp2p, PebbleDB (16-shard), gin HTTP framework, ZMQ (mempool), multi-chain (BTC/MVC/DOGE)

---

## Task 1: Project Scaffold

**Goal:** Create the man-p2p directory, copy MAN as base, disable MRC20 routes, verify tests pass.

- [ ] Create the project directory and copy MAN source tree (exclude build artifacts):
  ```bash
  mkdir -p /Users/tusm/Documents/MetaID_Projects/man-p2p
  rsync -av --exclude='.git' --exclude='dist/' --exclude='test_build/' \
    /Users/tusm/Documents/MetaID_Projects/man/ \
    /Users/tusm/Documents/MetaID_Projects/man-p2p/
  ```
- [ ] Update module name in `go.mod` from `manindexer` to `man-p2p`, then fix all internal imports and tidy:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  sed -i '' 's/^module manindexer/module man-p2p/' go.mod
  find . -name '*.go' | xargs sed -i '' 's|"manindexer/|"man-p2p/|g'
  go mod tidy
  ```
- [ ] Bump Go toolchain in `go.mod` to `go 1.24`.
- [ ] Disable MRC20 HTTP routes in `api/webapi.go` — comment out the mrc20/mrc721 `r.GET` lines (do NOT delete):
  ```go
  // MRC20 routes disabled in man-p2p phase 1 — asset parsing not enabled this phase
  // r.GET("/mrc20/info/:id", mrc20Info)
  // r.GET("/mrc20/holders/:id/:page", mrc20Holders)
  // r.GET("/mrc20/history/:id/:page", mrc20History)
  // r.GET("/mrc20/address/:id/:address/:page", mrc20AddressHistory)
  // r.GET("/mrc20/:page", mrc20List)
  // r.GET("/mrc721/:page", mrc721List)
  // r.GET("/mrc721/item/list/:name/:page", mrc721ItemList)
  ```
- [ ] Disable MRC20 catch-up indexer in `app.go` — comment out `man.Mrc20CatchUpRun()` and the `Mrc20Only` stat goroutines:
  ```go
  // man.Mrc20CatchUpRun() // disabled in man-p2p phase 1
  ```
- [ ] Verify the project compiles and existing tests pass:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go build ./...
  go test ./... -short -count=1
  ```
- [ ] Initialize git repo and commit:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  git init && git add .
  git commit -m "feat: scaffold man-p2p from MAN base, disable MRC20"
  ```


## Task 2: Port User-Info Indexing from meta-file-system

**Goal:** Add PebbleDB collections for user info (avatar, name, chatpubkey), replacing the Redis-backed approach in meta-file-system with pure PebbleDB. Index user info when processing PIN paths `/info/name`, `/info/avatar`, `/info/chatpubkey`.

**Reference source:** `/Users/tusm/Documents/MetaID_Projects/meta-file-system/service/indexer_service/indexer_service.go` (lines ~731-762, ~1397-1434) and `/Users/tusm/Documents/MetaID_Projects/meta-file-system/model/indexer_user_info.go`.

- [ ] Create `pebblestore/userinfo.go` — define the UserInfo struct and PebbleDB key scheme:
  ```go
  // pebblestore/userinfo.go
  package pebblestore

  // UserInfo holds indexed user identity fields for a MetaID address.
  type UserInfo struct {
      GlobalMetaId       string `json:"globalMetaId"`
      Address            string `json:"address"`
      Name               string `json:"name"`
      NamePinId          string `json:"namePinId"`
      Avatar             string `json:"avatar"`       // raw content or path
      AvatarPinId        string `json:"avatarPinId"`
      ChatPublicKey      string `json:"chatPublicKey"`
      ChatPublicKeyPinId string `json:"chatPublicKeyPinId"`
      BlockHeight        int64  `json:"blockHeight"`
      Timestamp          int64  `json:"timestamp"`
  }

  // Key scheme: "userinfo:<address>" → JSON(UserInfo)
  // Secondary index: "userinfo:metaid:<globalMetaId>" → address (for metaid lookup)
  func userInfoKey(address string) []byte {
      return []byte("userinfo:" + address)
  }
  func userInfoMetaIdKey(globalMetaId string) []byte {
      return []byte("userinfo:metaid:" + globalMetaId)
  }
  ```
- [ ] Add `UserInfoDB *pebble.DB` field to the `Database` struct in `pebblestore/store.go` and open it in `NewDataBase()` at path `<basePath>/userinfo/`.
- [ ] Implement `SetUserInfo`, `GetUserInfoByAddress`, `GetUserInfoByMetaId` methods in `pebblestore/userinfo.go`:
  ```go
  func (db *Database) SetUserInfo(info UserInfo) error { /* marshal + batch write key + metaid index */ }
  func (db *Database) GetUserInfoByAddress(address string) (*UserInfo, error) { /* get + unmarshal */ }
  func (db *Database) GetUserInfoByMetaId(globalMetaId string) (*UserInfo, error) {
      // look up address via metaid index, then call GetUserInfoByAddress
  }
  ```
- [ ] Add path detection helpers in `man/metaidInfo.go` (mirrors meta-file-system logic):
  ```go
  func isNamePath(path string) bool {
      return strings.HasPrefix(path, "/info/name")
  }
  func isAvatarPath(path string) bool {
      return strings.HasPrefix(path, "/info/avatar")
  }
  func isChatPubKeyPath(path string) bool {
      lower := strings.ToLower(path)
      return strings.HasPrefix(lower, "/info/chatpubkey") ||
          strings.HasPrefix(lower, "/info/chatpublickey")
  }
  ```
- [ ] In the PIN indexing loop (`man/man_function.go` or `man/indexer_pebble.go`), after writing a PIN to PebbleDB, call `indexUserInfo(pin)` when the path matches:
  ```go
  func indexUserInfo(p *pin.PinInscription) {
      // load existing UserInfo for p.Address (or create new)
      // update the relevant field (Name/Avatar/ChatPublicKey) + PinId
      // call PebbleStore.Database.SetUserInfo(info)
  }
  ```
- [ ] Write test `pebblestore/userinfo_test.go`:
  ```go
  func TestIndexUserName(t *testing.T) {
      db := openTempDB(t)
      info := UserInfo{
          GlobalMetaId: "abc123", Address: "1TestAddr",
          Name: "Alice", NamePinId: "pin001",
      }
      if err := db.SetUserInfo(info); err != nil {
          t.Fatal(err)
      }
      got, err := db.GetUserInfoByAddress("1TestAddr")
      if err != nil || got.Name != "Alice" {
          t.Fatalf("expected Alice, got %+v, err %v", got, err)
      }
      got2, err := db.GetUserInfoByMetaId("abc123")
      if err != nil || got2.Name != "Alice" {
          t.Fatalf("metaid lookup failed: %+v, err %v", got2, err)
      }
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./pebblestore/... -run TestIndexUserName -v
  ```
- [ ] Commit:
  ```bash
  git add pebblestore/userinfo.go pebblestore/userinfo_test.go man/metaidInfo.go man/man_function.go
  git commit -m "feat: port user-info indexing (name/avatar/chatpubkey) to PebbleDB"
  ```


## Task 3: New HTTP Endpoints

**Goal:** Implement all HTTP endpoints required by the spec. Response envelope matches manapi.metaid.io: `{"code":0,"message":"ok","data":{...}}`. Write test first, then implement.

**Existing MAN routes to reuse:** `/api/pin/:numberOrId`, `/api/pin/path/list`, `/api/address/pin/list/:address`, `/api/info/address/:address`, `/api/info/metaid/:metaId` — these already exist in `api/btc_jsonapi.go`. The new endpoints below either add missing ones or adjust paths to match the spec contract.

### 3a: Address + content endpoints

- [ ] Write test `api/endpoints_test.go` for `GET /address/pin/list/{address}`:
  ```go
  func TestGetPinListByAddress(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/api/address/pin/list/1TestAddr?cursor=0&size=10", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)
      var resp ApiResponse
      json.Unmarshal(w.Body.Bytes(), &resp)
      assert.Equal(t, 0, resp.Code)
  }
  ```
- [ ] Verify `GET /api/address/pin/list/:address` already exists in `api/btc_jsonapi.go` (`getPinListByAddress` handler). Confirm it accepts `cursor`, `size`, `path` query params and returns the standard envelope. Adjust if needed.
- [ ] Write test for `GET /content/{pinId}` — expects raw bytes response:
  ```go
  func TestGetContent(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/content/testpin001", nil)
      r.ServeHTTP(w, req)
      // 200 or 404 depending on test data; assert no 500
      assert.NotEqual(t, 500, w.Code)
  }
  ```
- [ ] Verify `GET /content/:number` exists in `api/webapi.go` (`content` handler). Ensure it returns raw bytes with correct `Content-Type` header from PIN metadata.

### 3b: User info endpoints

- [ ] Write test for `GET /api/v1/users/info/metaid/{metaId}`:
  ```go
  func TestGetUserInfoByMetaId(t *testing.T) {
      r := setupTestRouter()
      // seed a UserInfo in test DB
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/api/v1/users/info/metaid/abc123", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)
      var resp ApiResponse
      json.Unmarshal(w.Body.Bytes(), &resp)
      assert.Equal(t, 0, resp.Code)
  }
  ```
- [ ] Add route group in `api/btc_jsonapi.go`:
  ```go
  v1 := r.Group("/api/v1")
  v1.Use(CorsMiddleware())
  v1.GET("/users/info/metaid/:metaId", getUserInfoByMetaId)
  v1.GET("/users/info/address/:address", getUserInfoByAddress)
  ```
- [ ] Implement handlers in `api/userinfo_api.go`:
  ```go
  func getUserInfoByMetaId(ctx *gin.Context) {
      info, err := man.PebbleStore.Database.GetUserInfoByMetaId(ctx.Param("metaId"))
      if err != nil {
          ctx.JSON(200, respond.ApiSuccess(0, "not found", nil))
          return
      }
      ctx.JSON(200, respond.ApiSuccess(0, "ok", info))
  }
  func getUserInfoByAddress(ctx *gin.Context) {
      info, err := man.PebbleStore.Database.GetUserInfoByAddress(ctx.Param("address"))
      if err != nil {
          ctx.JSON(200, respond.ApiSuccess(0, "not found", nil))
          return
      }
      ctx.JSON(200, respond.ApiSuccess(0, "ok", info))
  }
  ```

### 3c: Health, config reload, P2P status endpoints

- [ ] Write test for `GET /health`:
  ```go
  func TestHealth(t *testing.T) {
      r := setupTestRouter()
      w := httptest.NewRecorder()
      req, _ := http.NewRequest("GET", "/health", nil)
      r.ServeHTTP(w, req)
      assert.Equal(t, 200, w.Code)
      assert.Contains(t, w.Body.String(), "ok")
  }
  ```
- [ ] Add health endpoint in `api/webapi.go`:
  ```go
  r.GET("/health", func(ctx *gin.Context) {
      ctx.JSON(200, gin.H{"status": "ok", "version": Version})
  })
  ```
  Define `var Version = "0.1.0"` in `common/version.go`.
- [ ] Write test for `POST /api/config/reload` — expects 200 with `{"status":"reloaded"}`.
- [ ] Implement `POST /api/config/reload` handler in `api/p2p_api.go`:
  ```go
  func configReload(ctx *gin.Context) {
      if err := p2p.ReloadConfig(); err != nil {
          ctx.JSON(500, gin.H{"error": err.Error()})
          return
      }
      ctx.JSON(200, gin.H{"status": "reloaded"})
  }
  ```
- [ ] Write test for `GET /api/p2p/status` — expects JSON with `peerCount`, `syncProgress`, `dataSource`, `storageLimitReached`, `storageUsedBytes` fields.
- [ ] Implement `GET /api/p2p/status` and `GET /api/p2p/peers` in `api/p2p_api.go`:
  ```go
  func p2pStatus(ctx *gin.Context) {
      ctx.JSON(200, respond.ApiSuccess(0, "ok", p2p.GetStatus()))
  }
  func p2pPeers(ctx *gin.Context) {
      ctx.JSON(200, respond.ApiSuccess(0, "ok", p2p.GetPeers()))
  }
  ```
- [ ] Register all new routes in `api/btc_jsonapi.go` (or a new `api/p2p_api.go` init function called from `webapi.go`):
  ```go
  r.POST("/api/config/reload", configReload)
  r.GET("/api/p2p/status", p2pStatus)
  r.GET("/api/p2p/peers", p2pPeers)
  ```
- [ ] Run all API tests:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./api/... -v -count=1
  ```
- [ ] Commit:
  ```bash
  git add api/
  git commit -m "feat: add user-info, health, p2p status, config-reload HTTP endpoints"
  ```


## Task 4: P2P Config Loading

**Goal:** Define `P2PSyncConfig` struct matching the JSON schema from the spec, load from `--config` flag on startup, support hot reload via `/api/config/reload`.

- [ ] Create `p2p/config.go`:
  ```go
  // p2p/config.go
  package p2p

  import (
      "encoding/json"
      "os"
      "sync"
  )

  // P2PSyncConfig mirrors the JSON schema stored in IDBots SQLite kv table key "p2p_config".
  type P2PSyncConfig struct {
      SyncMode           string   `json:"p2p_sync_mode"`            // "self" | "selective" | "full"
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

  // LoadConfig reads the config JSON file at path and stores it.
  func LoadConfig(path string) error {
      configPath = path
      return ReloadConfig()
  }

  // ReloadConfig re-reads the config file from the last loaded path.
  func ReloadConfig() error {
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

  // GetConfig returns a copy of the current config (safe for concurrent reads).
  func GetConfig() P2PSyncConfig {
      configMu.RLock()
      defer configMu.RUnlock()
      return currentConfig
  }
  ```
- [ ] Add `--config` flag in `app.go` (or `common/flags.go`):
  ```go
  var p2pConfigFile string
  flag.StringVar(&p2pConfigFile, "config", "", "path to p2p config JSON file")
  flag.Parse()
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
      if len(got.SelectiveAddresses) != 1 || got.SelectiveAddresses[0] != "1A2B3C" {
          t.Errorf("unexpected addresses: %v", got.SelectiveAddresses)
      }
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
  git commit -m "feat: P2PSyncConfig struct, --config flag, hot reload"
  ```


## Task 5: p2p/host.go — libp2p Node

**Goal:** Initialize a go-libp2p host with a persistent ed25519 identity, set up Kademlia DHT, and connect to bootstrap nodes from config.

- [ ] Add go-libp2p dependencies to `go.mod`:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go get github.com/libp2p/go-libp2p@v0.38.0
  go get github.com/libp2p/go-libp2p-kad-dht@v0.28.0
  go get github.com/libp2p/go-libp2p-pubsub@v0.12.0
  go mod tidy
  ```
- [ ] Create `p2p/host.go`:
  ```go
  // p2p/host.go
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
      Node    host.Host
      KadDHT  *dht.IpfsDHT
  )

  // InitHost starts the libp2p host. dataDir is the man-p2p data directory.
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

  // loadOrCreateIdentity loads ed25519 key from dataDir/identity.key or generates a new one.
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
      if Node == nil {
          t.Fatal("Node is nil")
      }
      if Node.ID() == "" {
          t.Fatal("empty peer ID")
      }
      if KadDHT == nil {
          t.Fatal("KadDHT is nil")
      }
      // identity persists across restarts
      id1 := Node.ID()
      Node.Close()
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
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestInitHost -v -timeout 30s
  ```
- [ ] Commit:
  ```bash
  git add p2p/host.go p2p/host_test.go go.mod go.sum
  git commit -m "feat: p2p/host.go — libp2p node with persistent identity and Kademlia DHT"
  ```


## Task 6: p2p/gossip.go — GossipSub

**Goal:** Subscribe to the `metaid-pins` topic. On new PIN indexed locally, publish PIN metadata. On receive, pass to subscription filter.

- [ ] Create `p2p/gossip.go`:
  ```go
  // p2p/gossip.go
  package p2p

  import (
      "context"
      "encoding/json"
      "log"

      pubsub "github.com/libp2p/go-libp2p-pubsub"
  )

  const TopicName = "metaid-pins"

  // PinAnnouncement is the message published over GossipSub.
  // It contains only metadata — content bytes are fetched separately via stream.
  type PinAnnouncement struct {
      PinId     string `json:"pinId"`
      Path      string `json:"path"`
      Address   string `json:"address"`
      Confirmed bool   `json:"confirmed"`
      SizeBytes int64  `json:"sizeBytes"`
      PeerID    string `json:"peerId"` // announcing peer's libp2p peer ID
  }

  var (
      PS    *pubsub.PubSub
      topic *pubsub.Topic
      sub   *pubsub.Subscription
  )

  // InitGossip sets up GossipSub on the existing Node.
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

  // PublishPin broadcasts a PIN announcement to the network.
  func PublishPin(ctx context.Context, ann PinAnnouncement) error {
      ann.PeerID = Node.ID().String()
      data, err := json.Marshal(ann)
      if err != nil {
          return err
      }
      return topic.Publish(ctx, data)
  }

  // receiveLoop reads incoming announcements and passes them to the subscription filter.
  func receiveLoop(ctx context.Context) {
      for {
          msg, err := sub.Next(ctx)
          if err != nil {
              return
          }
          if msg.ReceivedFrom == Node.ID() {
              continue // skip own messages
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
- [ ] Write test `p2p/gossip_test.go` — two in-process nodes, publish on one, receive on other:
  ```go
  func TestGossipPubSub(t *testing.T) {
      ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
      defer cancel()

      // Start node A
      dir1 := t.TempDir()
      if err := InitHost(ctx, dir1); err != nil {
          t.Fatal(err)
      }
      nodeA := Node
      if err := InitGossip(ctx); err != nil {
          t.Fatal(err)
      }

      // Start node B (separate host + gossip)
      nodeB, psB, subB := startSecondNode(t, ctx, nodeA.Addrs())

      // Give mesh time to form
      time.Sleep(2 * time.Second)

      ann := PinAnnouncement{PinId: "pin001", Path: "/info/name", Address: "1Addr", Confirmed: true}
      if err := PublishPin(ctx, ann); err != nil {
          t.Fatal(err)
      }

      // Receive on node B
      msg, err := subB.Next(ctx)
      if err != nil {
          t.Fatal(err)
      }
      var got PinAnnouncement
      json.Unmarshal(msg.Data, &got)
      if got.PinId != "pin001" {
          t.Errorf("expected pin001, got %s", got.PinId)
      }
      _ = nodeB; _ = psB
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestGossipPubSub -v -timeout 30s
  ```
- [ ] Commit:
  ```bash
  git add p2p/gossip.go p2p/gossip_test.go
  git commit -m "feat: p2p/gossip.go — GossipSub PIN announcement publish/receive"
  ```


## Task 7: p2p/subscription.go — Sync Filter

**Goal:** Implement self/selective/full mode filtering and blocklist enforcement. Blocklist overrides allowlist.

- [ ] Create `p2p/subscription.go`:
  ```go
  // p2p/subscription.go
  package p2p

  import (
      "path/filepath"
      "strings"
  )

  // ShouldSync returns true if the given PIN announcement should be synced locally.
  // Blocklist always takes priority over allowlist.
  func ShouldSync(ann PinAnnouncement) bool {
      cfg := GetConfig()

      // Blocklist check (highest priority)
      if isBlocked(ann, cfg) {
          return false
      }

      switch cfg.SyncMode {
      case "full":
          return true
      case "self":
          // Only sync PINs from our own MetaBot addresses.
          // OwnAddresses is populated at startup from the MetaBot wallet.
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
      if cfg.MaxContentSizeKB > 0 && ann.SizeBytes > cfg.MaxContentSizeKB*1024 {
          return true
      }
      return false
  }

  func isInSelectiveList(ann PinAnnouncement, cfg P2PSyncConfig) bool {
      for _, addr := range cfg.SelectiveAddresses {
          if addr == ann.Address {
              return true
          }
      }
      for _, pattern := range cfg.SelectivePaths {
          // Support glob patterns like "/info/*"
          if matched, _ := filepath.Match(pattern, ann.Path); matched {
              return true
          }
          // Also support prefix match for patterns without wildcards
          if !strings.Contains(pattern, "*") && strings.HasPrefix(ann.Path, pattern) {
              return true
          }
      }
      return false
  }

  // OwnAddresses holds the local MetaBot addresses for "self" mode.
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
  func TestSelectiveModeFilter(t *testing.T) {
      // Load a selective config
      _ = LoadConfig(writeTempConfig(t, `{
          "p2p_sync_mode": "selective",
          "p2p_selective_addresses": ["1AllowedAddr"],
          "p2p_selective_paths": ["/info/*"],
          "p2p_block_addresses": ["1AllowedAddr"],
          "p2p_max_content_size_kb": 100
      }`))

      // Blocklist overrides allowlist
      ann := PinAnnouncement{PinId: "p1", Address: "1AllowedAddr", Path: "/info/name", SizeBytes: 100}
      if ShouldSync(ann) {
          t.Error("blocked address should not sync even if in selective list")
      }

      // Allowed by path
      _ = LoadConfig(writeTempConfig(t, `{
          "p2p_sync_mode": "selective",
          "p2p_selective_paths": ["/info/*"],
          "p2p_max_content_size_kb": 100
      }`))
      ann2 := PinAnnouncement{PinId: "p2", Address: "1OtherAddr", Path: "/info/name", SizeBytes: 50}
      if !ShouldSync(ann2) {
          t.Error("path /info/name should match /info/* pattern")
      }

      // Exceeds size limit
      ann3 := PinAnnouncement{PinId: "p3", Address: "1OtherAddr", Path: "/info/name", SizeBytes: 200*1024}
      if ShouldSync(ann3) {
          t.Error("oversized content should be blocked")
      }
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestSelectiveModeFilter -v
  ```
- [ ] Commit:
  ```bash
  git add p2p/subscription.go p2p/subscription_test.go
  git commit -m "feat: p2p/subscription.go — self/selective/full filter with blocklist priority"
  ```


## Task 8: p2p/sync.go — Content Pull

**Goal:** When a filtered PIN announcement arrives, fetch the full PIN data from the announcing peer via a libp2p stream using a simple request/response protocol.

- [ ] Create `p2p/sync.go`:
  ```go
  // p2p/sync.go
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

  // PinRequest is sent by the requesting node.
  type PinRequest struct {
      PinId string `json:"pinId"`
  }

  // PinResponse is returned by the serving node.
  type PinResponse struct {
      PinId     string `json:"pinId"`
      Path      string `json:"path"`
      Address   string `json:"address"`
      Confirmed bool   `json:"confirmed"`
      Content   []byte `json:"content"`   // raw content bytes
      Error     string `json:"error,omitempty"`
  }

  // RegisterSyncHandler registers the server-side stream handler on the local node.
  // It serves PIN data from the local PebbleDB.
  func RegisterSyncHandler(getPinFn func(pinId string) (*PinResponse, error)) {
      Node.SetStreamHandler(SyncProtocol, func(s network.Stream) {
          defer s.Close()
          var req PinRequest
          if err := json.NewDecoder(s).Decode(&req); err != nil {
              return
          }
          resp, err := getPinFn(req.PinId)
          if err != nil {
              resp = &PinResponse{PinId: req.PinId, Error: err.Error()}
          }
          json.NewEncoder(s).Encode(resp)
      })
  }

  // FetchPin opens a stream to peerID and requests the PIN data.
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

  // HandleIncomingAnnouncement is called by gossip.go receiveLoop.
  // It applies the subscription filter and fetches content if needed.
  func HandleIncomingAnnouncement(ctx context.Context, ann PinAnnouncement) {
      if !ShouldSync(ann) {
          return
      }
      peerID, err := peer.Decode(ann.PeerID)
      if err != nil {
          log.Printf("sync: invalid peer ID %s: %v", ann.PeerID, err)
          return
      }
      cfg := GetConfig()
      if cfg.MaxContentSizeKB > 0 && ann.SizeBytes > cfg.MaxContentSizeKB*1024 {
          // Store metadata only, mark content_fetched=false
          storePinMetadataOnly(ann)
          return
      }
      resp, err := FetchPin(ctx, peerID, ann.PinId)
      if err != nil {
          log.Printf("sync: fetch %s from %s failed: %v", ann.PinId, peerID, err)
          return
      }
      storePinData(resp)
  }

  // storePinData and storePinMetadataOnly are stubs — implemented in Task 2 integration.
  func storePinData(resp *PinResponse)       { /* write to PebbleDB */ }
  func storePinMetadataOnly(ann PinAnnouncement) { /* write metadata, content_fetched=false */ }
  ```
- [ ] Write test `p2p/sync_test.go` — node A serves a PIN, node B fetches it:
  ```go
  func TestContentPull(t *testing.T) {
      ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
      defer cancel()

      // Node A: serve
      dirA := t.TempDir()
      if err := InitHost(ctx, dirA); err != nil {
          t.Fatal(err)
      }
      nodeA := Node
      RegisterSyncHandler(func(pinId string) (*PinResponse, error) {
          if pinId == "pin001" {
              return &PinResponse{PinId: "pin001", Path: "/info/name",
                  Address: "1Addr", Confirmed: true, Content: []byte("Alice")}, nil
          }
          return nil, fmt.Errorf("not found")
      })

      // Node B: fetch
      nodeB := startBareNode(t, ctx)
      nodeB.Connect(ctx, peer.AddrInfo{ID: nodeA.ID(), Addrs: nodeA.Addrs()})
      time.Sleep(500 * time.Millisecond)

      // Temporarily swap Node to nodeB for FetchPin
      origNode := Node
      Node = nodeB
      resp, err := FetchPin(ctx, nodeA.ID(), "pin001")
      Node = origNode

      if err != nil {
          t.Fatal(err)
      }
      if string(resp.Content) != "Alice" {
          t.Errorf("expected Alice, got %s", resp.Content)
      }
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestContentPull -v -timeout 30s
  ```
- [ ] Commit:
  ```bash
  git add p2p/sync.go p2p/sync_test.go
  git commit -m "feat: p2p/sync.go — content pull via libp2p stream protocol"
  ```


## Task 9: p2p/relay.go — NAT Traversal

**Goal:** Enable AutoNAT, hole punching, relay client, and mDNS local discovery.

- [ ] Create `p2p/relay.go`:
  ```go
  // p2p/relay.go
  package p2p

  import (
      "context"
      "log"

      "github.com/libp2p/go-libp2p"
      "github.com/libp2p/go-libp2p/p2p/discovery/mdns"
      "github.com/libp2p/go-libp2p/p2p/net/swarm"
      "github.com/libp2p/go-libp2p/core/host"
      "github.com/libp2p/go-libp2p/core/peer"
  )

  // InitNAT adds NAT traversal options to the libp2p host builder.
  // Call this by passing the returned options to libp2p.New() in host.go.
  func NATOptions() []libp2p.Option {
      cfg := GetConfig()
      opts := []libp2p.Option{
          libp2p.EnableNATService(),
          libp2p.EnableHolePunching(),
      }
      if cfg.EnableRelay {
          opts = append(opts, libp2p.EnableAutoRelayWithStaticRelays(parseRelayAddrs(cfg.BootstrapNodes)))
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

  // mdnsNotifee handles mDNS peer discovery events.
  type mdnsNotifee struct{ h host.Host }

  func (n *mdnsNotifee) HandlePeerFound(pi peer.AddrInfo) {
      log.Printf("mdns: discovered peer %s", pi.ID)
      _ = n.h.Connect(context.Background(), pi)
  }

  // InitMDNS starts mDNS discovery for local network peers.
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
- [ ] Update `p2p/host.go` `InitHost` to include NAT options and call `InitMDNS`:
  ```go
  natOpts := NATOptions()
  allOpts := append([]libp2p.Option{
      libp2p.Identity(privKey),
      libp2p.ListenAddrStrings("/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0"),
      libp2p.NATPortMap(),
  }, natOpts...)
  Node, err = libp2p.New(allOpts...)
  // ...
  go InitMDNS(ctx)
  ```
- [ ] Write test `p2p/relay_test.go` — mDNS discovers peer on loopback:
  ```go
  func TestMDNSDiscovery(t *testing.T) {
      if testing.Short() {
          t.Skip("mDNS test skipped in short mode")
      }
      ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
      defer cancel()

      // Start two nodes on the same machine
      dir1, dir2 := t.TempDir(), t.TempDir()
      if err := InitHost(ctx, dir1); err != nil {
          t.Fatal(err)
      }
      nodeA := Node
      InitMDNS(ctx)

      nodeB := startBareNodeWithMDNS(t, ctx, dir2)

      // Wait for mDNS to connect them
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
- [ ] Run test (not in short mode):
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestMDNSDiscovery -v -timeout 20s
  ```
- [ ] Commit:
  ```bash
  git add p2p/relay.go p2p/relay_test.go p2p/host.go
  git commit -m "feat: p2p/relay.go — AutoNAT, hole punching, relay client, mDNS"
  ```


## Task 10: Storage Limit Enforcement

**Goal:** Periodic goroutine (every 60s) walks the data directory, sums file sizes. When limit is reached, set `storageLimitReached=true` in status and stop accepting P2P sync.

- [ ] Create `p2p/storage.go`:
  ```go
  // p2p/storage.go
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

  // StartStorageMonitor starts a goroutine that checks storage usage every 60s.
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
              log.Printf("storage: limit reached (%.2f GB used, limit %.2f GB) — P2P sync paused",
                  float64(total)/(1<<30), cfg.StorageLimitGB)
          }
          storageLimitReached.Store(true)
      } else {
          storageLimitReached.Store(false)
      }
  }

  // GetStatus returns the current P2P node status for the /api/p2p/status endpoint.
  func GetStatus() map[string]interface{} {
      return map[string]interface{}{
          "peerCount":           len(Node.Network().Peers()),
          "syncProgress":        0.0, // TODO: implement progress tracking
          "dataSource":          "p2p",
          "storageLimitReached": storageLimitReached.Load(),
          "storageUsedBytes":    storageUsedBytes.Load(),
      }
  }

  // GetPeers returns the list of connected peer IDs.
  func GetPeers() []string {
      peers := Node.Network().Peers()
      ids := make([]string, len(peers))
      for i, p := range peers {
          ids[i] = p.String()
      }
      return ids
  }
  ```
- [ ] Update `p2p/sync.go` `HandleIncomingAnnouncement` to check `storageLimitReached` before syncing:
  ```go
  func HandleIncomingAnnouncement(ctx context.Context, ann PinAnnouncement) {
      if storageLimitReached.Load() {
          return // storage full, skip sync
      }
      if !ShouldSync(ann) {
          return
      }
      // ... rest of fetch logic
  }
  ```
- [ ] Write test `p2p/storage_test.go`:
  ```go
  func TestStorageLimitEnforcement(t *testing.T) {
      dir := t.TempDir()
      // Write 11 GB worth of fake size by mocking — instead write a small file
      // and set a tiny limit to trigger the condition
      os.WriteFile(filepath.Join(dir, "data.bin"), make([]byte, 1024), 0644)

      // Set limit to 0.000001 GB (1 KB) to trigger immediately
      _ = LoadConfig(writeTempConfig(t, `{"p2p_storage_limit_gb": 0.000001}`))
      checkStorage(dir)

      if !storageLimitReached.Load() {
          t.Error("expected storageLimitReached=true after exceeding limit")
      }

      // Raise limit — should clear the flag
      _ = LoadConfig(writeTempConfig(t, `{"p2p_storage_limit_gb": 100}`))
      checkStorage(dir)
      if storageLimitReached.Load() {
          t.Error("expected storageLimitReached=false after raising limit")
      }
  }
  ```
- [ ] Run test:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  go test ./p2p/... -run TestStorageLimitEnforcement -v
  ```
- [ ] Wire `StartStorageMonitor` into `app.go` startup after `InitHost`:
  ```go
  p2p.StartStorageMonitor(ctx, dataDir)
  ```
- [ ] Commit:
  ```bash
  git add p2p/storage.go p2p/storage_test.go p2p/sync.go app.go
  git commit -m "feat: storage limit monitor — pause P2P sync when PebbleDB exceeds limit"
  ```


## Task 11: Cross-Platform Build

**Goal:** Makefile targets for all four platforms, CI-friendly via GOOS/GOARCH, output to `dist/`.

- [ ] Create `Makefile` at `/Users/tusm/Documents/MetaID_Projects/man-p2p/Makefile`:
  ```makefile
  # Makefile for man-p2p cross-platform builds
  BINARY   := man-p2p
  VERSION  := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
  LDFLAGS  := -ldflags "-X man-p2p/common.Version=$(VERSION) -s -w"
  DIST     := dist

  .PHONY: all build-darwin-arm64 build-darwin-amd64 build-windows-amd64 build-linux-amd64 clean

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

  > **Note on CGO:** go-libp2p and PebbleDB require CGO. For cross-compilation, install the appropriate cross-compiler toolchain:
  > - Windows: `brew install mingw-w64` (macOS) or `apt install gcc-mingw-w64` (Linux)
  > - Linux from macOS: use a Docker container with `golang:1.24` + `gcc`
  > - macOS from Linux: requires macOS SDK (use GitHub Actions `macos-latest` runner)

- [ ] Add `dist/` to `.gitignore`:
  ```bash
  echo "dist/" >> /Users/tusm/Documents/MetaID_Projects/man-p2p/.gitignore
  ```
- [ ] Verify native build works:
  ```bash
  cd /Users/tusm/Documents/MetaID_Projects/man-p2p
  make build-darwin-arm64   # or build-darwin-amd64 depending on host
  ls -lh dist/
  ```
- [ ] Verify the binary starts and prints help/version:
  ```bash
  ./dist/man-p2p-darwin-arm64 --help
  ```
- [ ] Commit:
  ```bash
  git add Makefile .gitignore
  git commit -m "feat: cross-platform Makefile for darwin/windows/linux builds"
  ```

---

## Integration Wiring Checklist

After all tasks are complete, wire the components together in `app.go`:

- [ ] Parse `--data-dir` and `--config` flags
- [ ] Call `p2p.LoadConfig(configPath)`
- [ ] Call `p2p.InitHost(ctx, dataDir)`
- [ ] Call `p2p.InitGossip(ctx)`
- [ ] Call `p2p.InitMDNS(ctx)`
- [ ] Call `p2p.StartStorageMonitor(ctx, dataDir)`
- [ ] Register sync handler: `p2p.RegisterSyncHandler(getPinFromPebble)`
- [ ] Hook PIN indexing loop to call `p2p.PublishPin(ctx, ann)` after writing to PebbleDB
- [ ] Verify `GET /health` returns 200 when binary is running
- [ ] Verify `GET /api/p2p/status` returns correct peer count after connecting to bootstrap nodes

---

## File Map

All paths relative to `/Users/tusm/Documents/MetaID_Projects/man-p2p/`:

| File | Task | Description |
|------|------|-------------|
| `go.mod` | 1 | Module `man-p2p`, Go 1.24 |
| `app.go` | 1, 4, 10 | Entry point, flag parsing, startup wiring |
| `common/version.go` | 3c | `var Version string` |
| `pebblestore/userinfo.go` | 2 | UserInfo PebbleDB CRUD |
| `pebblestore/userinfo_test.go` | 2 | UserInfo tests |
| `man/metaidInfo.go` | 2 | Path detection helpers |
| `api/userinfo_api.go` | 3b | `/api/v1/users/info/*` handlers |
| `api/p2p_api.go` | 3c | `/health`, `/api/p2p/*`, `/api/config/reload` |
| `api/endpoints_test.go` | 3 | HTTP endpoint tests |
| `p2p/config.go` | 4 | P2PSyncConfig, LoadConfig, ReloadConfig |
| `p2p/config_test.go` | 4 | Config loading tests |
| `p2p/host.go` | 5 | libp2p host, DHT, identity |
| `p2p/host_test.go` | 5 | Host init tests |
| `p2p/gossip.go` | 6 | GossipSub publish/receive |
| `p2p/gossip_test.go` | 6 | Two-node gossip test |
| `p2p/subscription.go` | 7 | Sync filter (self/selective/full + blocklist) |
| `p2p/subscription_test.go` | 7 | Filter tests |
| `p2p/sync.go` | 8 | Content pull via libp2p stream |
| `p2p/sync_test.go` | 8 | Content pull test |
| `p2p/relay.go` | 9 | AutoNAT, hole punch, relay, mDNS |
| `p2p/relay_test.go` | 9 | mDNS discovery test |
| `p2p/storage.go` | 10 | Storage monitor, GetStatus, GetPeers |
| `p2p/storage_test.go` | 10 | Storage limit test |
| `Makefile` | 11 | Cross-platform build targets |
