# Agent Browser MetaApp Rules

这个文件是 MetaApp 开发规范，不绑定 IDFramework，只绑定 Bot Browser / Agent Browser 的运行约定。

## 1. URI 约定

优先使用这些 Agent Internet URI：

```text
metaid://<globalMetaId-or-alias>
pin://<pinId>
pin://<pinId>?version=<historyIndex>
metaapp://<metaAppPinId>
metafile://<metafilePinId-or-reference>
map://<protocol>/pin/<pinId>
map://<protocol>/pin/<pinId>?version=<historyIndex>
map://simplemsg/conversation?peer=<globalMetaId>
```

只有普通外部网页才用 `https://...`。如果某个资源本来就有 Agent Internet URI，不要再退回 Web2 URL。

## 2. 打包资源路径

MetaApp ZIP 里的资源必须用相对路径。

- 正确：`assets/logo.png`
- 正确：`./assets/logo.png`
- 正确：`../shared/app.css`
- 错误：`/assets/logo.png`
- 错误：`/css/app.css`
- 错误：`/js/app.js`

原因很简单：MetaApp 在 Browser 里通常跑在 `/browser/metaapp/<pinId>` 这样的宿主路由下，`/assets/...` 会被当成宿主站点根路径，不会去读 ZIP 包内文件。

## 3. 静态链接

普通锚点就可以：

```html
<a href="metaid://idq1example">Open Bot Page</a>
<a href="pin://6ea8a0bd0bac9a9c6cf4e035e9ce0a18e3a89f390c355dcc43074010fbee7ee7i0">Open PIN</a>
<a href="metaapp://6ea8a0bd0bac9a9c6cf4e035e9ce0a18e3a89f390c355dcc43074010fbee7ee7i0">Open MetaApp</a>
```

Bot Browser 在服务 MetaApp HTML 时会自动注入链接拦截脚本：`metaid://`、`pin://`、`metaapp://`、`metafile://`、`map://` 锚点的点击会自动经宿主 Browser 导航，普通静态链接不需要任何额外脚本。只有当应用还要调用 bridge request API（`browser.actor.current`、`metaid.pin.write`、`metafile.upload`、`browser.llm.complete`、compose 流程）或需要程序化导航时，才需要下面这个 helper。

## 4. AgentBrowser Helper

把下面这段脚本放到 `body` 末尾一次：

```html
<script>
  (function () {
    var callbacks = {};
    var listeners = {};
    var nextId = 1;
    var bridge = window.AgentBrowser || {};

    bridge.navigate = bridge.navigate || function (uri) {
      window.parent.postMessage({
        type: 'agent-browser:navigate',
        version: 1,
        uri: String(uri || '')
      }, '*');
    };

    bridge.request = bridge.request || function (input) {
      var id = 'req-' + (nextId++);
      return new Promise(function (resolve, reject) {
        callbacks[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({
          type: 'agent-browser:request',
          version: 1,
          id: id,
          method: String(input && input.method || ''),
          params: input && input.params || {}
        }, '*');
      });
    };

    bridge.on = bridge.on || function (eventName, handler) {
      if (!listeners[eventName]) listeners[eventName] = [];
      listeners[eventName].push(handler);
      return function () {
        listeners[eventName] = (listeners[eventName] || []).filter(function (item) {
          return item !== handler;
        });
      };
    };

    window.addEventListener('message', function (event) {
      var data = event && event.data || {};
      if (data.type === 'agent-browser:response' && callbacks[data.id]) {
        var callback = callbacks[data.id];
        delete callbacks[data.id];
        if (data.ok) callback.resolve(data.result);
        else {
          var error = new Error(data.error && data.error.message || 'AgentBrowser request failed');
          error.code = data.error && data.error.code || 'bridge_error';
          callback.reject(error);
        }
      }
      if (data.type === 'agent-browser:event') {
        (listeners[data.event] || []).forEach(function (handler) {
          handler(data.payload);
        });
      }
    });

    window.AgentBrowser = bridge;
  }());

  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;

    var href = link.getAttribute('href') || '';
    if (!/^(metaid|pin|metaapp|metafile|map):\\/\\//i.test(href)) return;

    event.preventDefault();
    window.AgentBrowser.navigate(href);
  });
</script>
```

JavaScript 也可以直接跳转：

```html
<button type="button" id="open-profile">Open Profile</button>
<script>
  document.getElementById('open-profile').addEventListener('click', function () {
    window.AgentBrowser.navigate('metaid://idq1example');
  });
</script>
```

## 5. 当前 Actor

读取当前选中身份：

```js
const result = await window.AgentBrowser.request({ method: 'browser.actor.current' });
console.log(result.actor && result.actor.globalMetaId);
```

这个 actor 只应当被当成一个干净的 MetaID 身份快照，通常只有：

- `uri`
- `globalMetaId`
- `name`
- `avatarPinId`（可选）

不要假设这里会暴露钱包、宿主状态、Web2 avatar URL 或本地路由。

如果界面里要展示当前发帖身份，可以监听：

```js
window.AgentBrowser.on('browser.actor.changed', function (payload) {
  console.log(payload.actor && payload.actor.globalMetaId);
});
```

## 6. 写链

MetaApp 内部写 MetaID PIN，用 `metaid.pin.write`：

```js
await window.AgentBrowser.request({
  method: 'metaid.pin.write',
  params: {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json;utf-8',
    payload: {
      encoding: 'utf8',
      value: JSON.stringify({ content: 'hello Agent Internet' })
    },
    display: {
      title: 'Publish post',
      summary: 'hello Agent Internet'
    }
  }
});
```

约定：

- `create` 用绝对协议路径，比如 `/protocols/simplebuzz`
- `modify` / `revoke` 用 `@<pinId>`
- 如果传了 `originalId`，它必须和目标 pin 对得上
- `revoke` 可以用空 UTF-8 payload

## 7. 文件上传

大文件先用 `metafile.upload`，再把返回的 `metafile://...` 写进业务 pin：

```js
const upload = await window.AgentBrowser.request({
  method: 'metafile.upload',
  params: {
    source: { kind: 'host-picker', multiple: true },
    purpose: 'netdisk'
  }
});
```

不要让 MetaApp 直接拿到宿主本地路径。宿主如果不支持上传，应返回 bridge error，而不是泄露本地文件系统细节。

## 8. MetaFile 图片解析

Bot Browser 原生支持 `metafile://` 图片：静态 HTML 属性（`<img>`、`<video>`、`<audio>`、`<source>` 的 `src` / `srcset` / `poster`）可以直接写 `metafile://`，宿主在服务前会把它改写成可访问的内容 URL。改写只覆盖服务时已存在于 HTML 里的属性；**当 JavaScript 在运行时动态赋值图片（`img.src = ...`）时，改写不生效**，此时必须按下面的解析顺序把 MetaFile 引用解析成浏览器可访问的 URL。

### 解析顺序

1. 值已经是 `data:`、`blob:`、`http(s):` → 直接用
2. 值是 `metafile://<pinId>[.<ext>]`、裸 pin id、或已知 content path → 先抽出 pin id
3. 如果是头像且系统提供了 `manApiBaseUrl` → 用 `<manApiBaseUrl>/content/<pinId>`
4. 否则，如果系统提供了专用 MetaFile 图片 base → 用那个配置值
5. 否则回退到公共 fallback base：
   - 头像：`https://file.metaid.io/metafile-indexer/content/<pinId>`
   - 其它 MetaFile 图片：`https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/<pinId>`

**如果系统已经提供 `metafileContentBaseUrl` 或 `manApiBaseUrl`，以那些配置值为准；上面的公共 URL 只是 fallback。** 不要把公共地址硬编码在系统配置之上。

### helper 代码

```html
<script>
  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function extractMetafilePinId(value) {
    var raw = normalizeText(value);
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
      try {
        raw = new URL(raw).pathname || '';
      } catch {
        return '';
      }
    } else if (/^metafile:\/\//i.test(raw)) {
      raw = raw.slice('metafile://'.length);
    }
    raw = decodeURIComponent((raw.split(/[?#]/, 1)[0] || '').replace(/^\/+/, ''));
    raw = raw
      .replace(/^content\//i, '')
      .replace(/^metafile-indexer\/content\//i, '')
      .replace(/^metafile-indexer\/thumbnail\//i, '')
      .replace(/^metafile-indexer\/api\/v1\/files\/content\//i, '')
      .replace(/^metafile-indexer\/api\/v1\/files\/accelerate\/content\//i, '')
      .replace(/^metafile-indexer\/api\/v1\/users\/avatar\/accelerate\//i, '');
    var match = raw.match(/^([0-9a-f]{64}i0)(?:\.[a-z0-9][a-z0-9+.-]{0,31})?$/i);
    return match && match[1] ? match[1] : '';
  }

  function trimTrailingSlash(value) {
    return normalizeText(value).replace(/\/+$/, '');
  }

  function resolveMetaFileImageUrl(reference, options) {
    var raw = normalizeText(reference);
    if (!raw) return '';
    if (/^(data:|blob:|https?:)/i.test(raw)) return raw;
    var pinId = extractMetafilePinId(raw);
    if (!pinId) return '';
    var config = options || {};
    var fallbackMetafileBase = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
    var fallbackAvatarBase = 'https://file.metaid.io/metafile-indexer/content';
    if (config.kind === 'avatar') {
      var avatarBase = trimTrailingSlash(config.manApiBaseUrl);
      return (avatarBase ? avatarBase + '/content' : fallbackAvatarBase) + '/' + encodeURIComponent(pinId);
    }
    var metafileBase = trimTrailingSlash(config.metafileContentBaseUrl) || fallbackMetafileBase;
    return metafileBase + '/' + encodeURIComponent(pinId);
  }
</script>
```

## 9. Browser 私信 composer

MetaApp 可以让宿主打开**宿主拥有的私信确认流程**，但 MetaApp 本身**永远不直接发送消息**。两种 compose 方法都只是打开一个 Browser 拥有的确认对话框，用户必须亲自点击 Send 才会真正发出。

### owner 推导收件人（无参）

Bot homepage 上的普通 Message / Chat / Contact Bot / Send Message 按钮，调用**无参**的 `browser.privateChat.compose`，由 ABC 从当前 Bot Page owner 推导收件人：

```html
<button type="button" id="message-button">Message</button>
<script>
  document.getElementById('message-button').addEventListener('click', async function () {
    try {
      await window.AgentBrowser.request({ method: 'browser.privateChat.compose' });
    } catch (error) {
      console.error(error);
    }
  });
</script>
```

**不要**给 `browser.privateChat.compose` 传 `to` / `content` 参数——ABC 会忽略 iframe 传入的 params，这个方法不允许 MetaApp 自选收件人或预填消息。错误示例：

```js
// 错误：这个方法不接受 recipient / content
window.AgentBrowser.request({
  method: 'browser.privateChat.compose',
  params: { to: someGlobalMetaId, content: someMessage }
});
```

### 显式收件人或 MetaApp 自有消息输入

当 MetaApp 自己拥有消息输入框、或显式指定了收件人时，用 `browser.simplemsg.compose` 同时传 `to`（Global MetaID）和 `content`（非空）：

```js
async function openMessageConfirmation(to, content) {
  to = String(to || '').trim();
  content = String(content || '').trim();
  if (!to || !content) {
    throw new Error('A recipient and message are required.');
  }
  try {
    const result = await window.AgentBrowser.request({
      method: 'browser.simplemsg.compose',
      params: { to, content }
    });
    if (result && result.opened) {
      return { status: 'confirmation_opened' };
    }
    return { status: 'unavailable' };
  } catch (error) {
    if (error && error.code === 'unsupported_method') {
      return { status: 'unavailable' };
    }
    throw error;
  }
}
```

### 语义约束

- `{ opened: true }` 只表示确认对话框已打开，**不代表已发送**。反馈文案用“在 Browser 里确认并发送这条消息”，**不要**说“已发送”。
- `unavailable` 映射成普通的“此 Browser 暂不支持消息”反馈。
- `browser.simplemsg.compose` 的对话框已预填，`browser.privateChat.compose` 把消息输入留给用户。两种情况用户都必须亲自点 Browser 拥有的 Send 按钮。
- 宿主不支持某个 compose 方法时返回 `unsupported_method`，给普通不可用 / 错误反馈，**不要**回退到 `metaid.pin.write`、裸 PIN 写、或任何直连发送路径。
- `metaid.pin.write` 不是私信 API。MetaApp **不得**通过 `/protocols/simplemsg` 构造私信、解析 / 解析对端 chat 公钥、加密、签名、广播、绕过 Browser 确认或直接调用宿主发送路径——这些始终是宿主的职责。
- `map://simplemsg/conversation?peer=<globalMetaId>` 是**已有会话的导航 URI**，只用于“打开 / 查看会话”这种意图，**不要**用作发送按钮，也不要标成“在 IDChat 打开”或当成外部 Web 链接。

## 9.5 商业与社交受控唤起方法（REQ-E-01）

三个纯「UI 意图唤起」方法，MetaApp 用标准 `AgentBrowser.request` 调用；宿主会先弹**宿主原生确认卡**，用户点击确认后才分发下游事件。它们**永远不签名、不扣款、不发消息**——参数经 `commerceBridgeContract` 双端清洗，写链与支付始终是宿主的职责。

### `browser.commerce.askTwinToBuy`

买家在小店点「购买 / 议价 / 求购」时调用，宿主把购买意图交给用户自己的 AI（后续确认在 WS-D 的购买确认流里完成）：

```js
await window.AgentBrowser.request({
  method: 'browser.commerce.askTwinToBuy',
  params: {
    itemPinId: '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0', // 必填 64hex+iN
    collectionId: '77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0',
    collectionName: 'metabot-avatar',
    itemName: 'MetaBot Avatar - 金框墨镜 #1310',   // 必填
    tokenIndex: '1310',
    sellerGlobalMetaId: 'idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47', // 必填
    sellerName: '小林的Twin',
    priceMeMilli: 15000,          // 非负整数（milli-ME）
    priceCnyCents: 990,           // 非负整数（人民币分）
    mode: 'buy_me',               // 'buy_me' | 'negotiate' | 'inquire_unlisted'，默认 buy_me
    shopMetaAppPinId: '...'       // 可选 64hex+iN
  }
});
// 成功 → { opened: true }（确认卡已打开，不代表已付款）
// 取消 → error { code: 'user_cancelled' }
```

### `browser.social.addFriendPrompt`

```js
await window.AgentBrowser.request({
  method: 'browser.social.addFriendPrompt',
  params: { targetGlobalMetaId: 'idq1…', targetName: '小林', greeting: '你好' }
});
// 宿主确认后打开受控加好友/私聊流程 → { opened: true }
```

### `browser.commerce.openPromoPack`

**仅店主本人可用**（当前 Actor `globalMetaId` 必须等于 `shopOwnerGlobalMetaId`，否则返回 `{ code: 'forbidden' }`）：

```js
await window.AgentBrowser.request({
  method: 'browser.commerce.openPromoPack',
  params: {
    shopOwnerGlobalMetaId: 'idq1…',   // 必填
    shopOwnerName: '小林',
    shopSlogan: '一句话店招',
    shopMetaAppPinId: '...',
    featuredItems: [                  // 最多 6 项，海报取前 3
      { itemPinId: '…', itemName: '#1310 金框墨镜', coverUrl: 'metafile://…', priceMeMilli: 15000, priceCnyCents: 990 }
    ]
  }
});
// 成功弹出分销弹药包（海报 + 合规话术）→ { opened: true }
```

### 实现要点（宿主双端）

- Bot Browser：iframe 桥在 capture 阶段拦截这 3 个 method（ABC 会把未知 method 回 `unsupported_method`，必须 `stopImmediatePropagation` 抢先声明），中继给 `BotBrowserSurface`；中继只搬运参数，**权威清洗与确认 UI 全部在宿主渲染层**（`commerceBridgeContract.ts`）。
- Inline 气泡：`InlineMetaAppBlock` 直接走块内确认卡（kind `commerce`），语义一致。
- 其余 ABC 方法一律原样放行，不受影响。
- 展示口径：积分价 `⚡ X ME`（`priceMeMilli/1000`）、人民币参考价 `¥X.XX`（`priceCnyCents/100`）；**UI 禁止出现 SPACE/BTC 等加密货币计价**。

## 10. 安全边界

MetaApp 可以拿到的，是：

- Browser 内部导航
- 干净的 actor snapshot
- 宿主代写 `metaid.pin.write`
- 宿主代传 `metafile.upload`

MetaApp 不应该拿到的，是：

- wallet APIs
- 私钥
- 支付 API
- 本地文件路径
- 宿主内部路由
- 父 DOM 访问权

