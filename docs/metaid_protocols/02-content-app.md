# MetaID Protocols: Content and Applications

**Scope**: Heavier content protocols, including long-form notes, photo albums, application publishing, skills, and service metadata.

**Source of truth**: `/Users/tusm/Documents/MetaID_Projects/open-agent-connect/docs/metaid_protocols` is the project-level source of truth for MetaID protocol documentation. Downstream projects may keep mirrors, but protocol changes should be authored here first.

**Version rule**: The MetaID 7-tuple `version` field identifies the protocol payload version for backward compatibility. JSON payloads that include a top-level `version` field should keep it equal to the 7-tuple version. Parsers should prefer the payload version when available, then the 7-tuple version, then the legacy default documented for the path.

## 1. SimpleNote

- **Intro**: A protocol for publishing long-form notes and blog-style articles.
- **Path**: `/protocols/simplenote`
- **Version**: `1.0.1`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "title": "Note title",
  "subtitle": "Subtitle text",
  "coverImg": "metafile://cover-image-pinid",
  "contentType": "text/markdown",
  "content": "Main note body",
  /** Encryption method for content. Empty means unencrypted by default. */
  "encryption": "",
  "createTime": "creation timestamp",
  "tags": ["tag-1", "tag-2"],
  "attachments": ["attachment-pinid-1", "attachment-pinid-2"]
}
```

## 2. SimplePhotoShare

- **Intro**: A protocol for photo albums and image sharing scenarios.
- **Path**: `/protocols/simplephotoshare`
- **Version**: `1.0.2`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  /** Share description. */
  "description": "This is a group of landscape photos.",
  /** Creation timestamp. */
  "createTime": "1768284841944",
  "tags": ["landscape", "travel"],
  /** Mentioned MetaID list. */
  "mention": ["MetaID_1", "MetaID_2"],
  /** Image PINID list stored as metafile references. */
  "photos": [
    "metafile://{PINID_1}",
    "metafile://{PINID_2}"
  ]
}
```

## 3. MetaApp Wrapper

- **Intro**: A protocol for wrapping MetaID applications, including frontend code and static assets, as on-chain MetaApps.
- **Path**: `/protocols/metaapp`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "title": "Application title",
  "appName": "Application name",
  /** Record the prompt when the app is AI-generated. */
  "prompt": "You are an AI...",
  "icon": "metafile://pinid",
  "coverImg": "metafile://pinid",
  "introImgs": ["metafile://pinid1", "metafile://pinid2"],
  "intro": "Application introduction text...",
  /** Supported runtime environments, such as browser, android, or ios. */
  "runtime": "browser/android/ios",
  "version": "1.0.0",
  "contentType": "text/html",
  /** Runtime main-content PINID for the application. */
  "content": "metafile://pinid",
  /** Entry file. */
  "indexFile": "index.html",
  /** Source-code archive PINID. */
  "code": "metafile://pinid",
  "contentHash": "sha256_hash_here",
  "metadata": "any data",
  "tags": ["tool", "web3"],
  "disabled": false,
  "codeType": "application/zip"
}
```

## 4. MetaProtocol

- **Intro**: A wrapper for aggregating and describing custom protocol specifications.
- **Path**: `/protocols/metaprotocol`
- **Version**: `1.0.0`
- **Content-Type**: `application/json5`
- **Payload Schema**:

```json5
{
  "title": "Protocol title",
  "protocolName": "Protocol name",
  /** Actual path of the custom protocol. */
  "path": "/protocols/your_custom_path",
  "authors": "Author name",
  "version": "1.0.0",
  /** Field-level format description for the target protocol. */
  "protocolContent": "{\n  \"field\": \"value\"\n}",
  "protocolContentType": "application/json",
  "intro": "Detailed introduction for this custom protocol...",
  "protocolAttachments": [],
  "metadata": "Arbitrary data"
}
```

## 5. MetaBot-Skill

- **Intro**: A wrapper protocol for MetaBot skills. After a user uploads a skill ZIP archive, this protocol describes the uploaded skill.
- **Path**: `/protocols/metabot-skill`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "name": "metabot-post-buzz",
  "description": "Official core skill that lets MetaBot publish buzz posts.",
  "version": "1.0.1",
  /** PINID of the ZIP archive uploaded to /file beforehand. */
  "skill-file": "metafile://<zip_pinid>"
}
```

## 6. skill-service

- **Intro**: A protocol for MetaBots or users to publish skill service metadata so skill-based services can be discovered and displayed.
- **Path**: `/protocols/skill-service`
- **Content-Type**: `application/json`

### 6.1 skill-service v1.0.0

Version `1.0.0` is the legacy service advertisement shape. It must remain documented because existing on-chain service pins use it.

```json5
{
  /** Service identifier. An LLM may generate this from user requirements. */
  "serviceName": "post-buzz-service",
  /** Human-friendly display name. */
  "displayName": "On-chain buzz publishing service",
  /** Short description for lightweight service lists. */
  "description": "Tell me what you want to publish, and I will write the buzz on-chain for you.",
  /** Icon for this skill service. */
  "serviceIcon": "metafile://icon",
  /** GlobalMetaID of the provider MetaBot. */
  "providerMetaBot": "provider MetaBot GlobalMetaID",
  /** Local skill name executed by the provider. */
  "providerSkill": "provider skill name",
  /** Prefer strings to avoid precision loss, or define the amount in the smallest unit. */
  "price": "0.001",
  /** Payment currency: SPACE, BTC, or DOGE. */
  "currency": "SPACE",
  /** Optional provider-only execution reminder. */
  "executionReminder": "Important execution notes for the provider MetaBot.",
  /** Markdown document for the skill. Empty by default. */
  "skillDocument": "metafile://",
  /** Input type: text, image, video, or zip. Defaults to text. */
  "inputType": "text",
  /** Output type: text, image, video, or zip. Defaults to text. */
  "outputType": "text",
  /** Communication endpoint. Defaults to simplemsg for encrypted handshakes and delivery. */
  "endpoint": "simplemsg"
}
```

**v1.0 compatibility semantics**

- Missing `version` is treated as `1.0.0`.
- Missing `paymentTerms` is expected.
- `providerSkill` is the legacy single-skill string. App-level models should normalize it to a one-element skill list.
- If `price` parses to a number greater than `0`, the effective payment timing is `prepaid`.
- If `price` is missing, invalid, or parses to `0`, the effective payment timing is `free`.
- `currency` aliases `MVC` and `MICROVISIONCHAIN` should normalize to `SPACE`.

### 6.2 skill-service v1.1.0

Version `1.1.0` keeps the v1.0 display fields, upgrades `providerSkill` to an ordered skill array, and adds structured payment terms. New business logic should use shared resolvers for `providerSkill` and `paymentTerms`, not ad-hoc UI checks.

```json5
{
  "version": "1.1.0",
  "serviceName": "post-buzz-service",
  "displayName": "On-chain buzz publishing service",
  "description": "Tell me what you want to publish, and I will write the buzz on-chain for you.",
  "serviceIcon": "metafile://icon",
  "providerMetaBot": "provider MetaBot GlobalMetaID",
  /**
   * Ordered local skill names executed by the provider for this service.
   * UIs should allow selecting one or more skills and preserve this order.
   */
  "providerSkill": ["provider skill name", "optional follow-up skill name"],

  /**
   * Compatibility summary fields. These mirror paymentTerms.quote for older
   * indexers and clients. For free services, amount should be "0".
   */
  "price": "0.001",
  "currency": "SPACE",

  /**
   * Optional legacy settlement hints kept for existing native and MRC20
   * clients. New clients should derive these through paymentTerms.methods.
   */
  "paymentChain": "mvc",
  "settlementKind": "native",
  "mrc20Ticker": null,
  "mrc20Id": null,
  "paymentAddress": "provider settlement address",

  "paymentTerms": {
    /**
     * prepaid: caller pays before the order is sent to the provider.
     * postpaid: caller pays after provider delivery or payment request.
     * free: no service payment is required.
     */
    "timing": "prepaid",
    "quote": {
      /** Decimal string in major units, or "0" for free services. */
      "amount": "0.001",
      "asset": {
        /**
         * crypto-native: native chain asset such as SPACE, BTC, or DOGE.
         * mrc20: MRC20 token settled on BTC.
         * fiat: fiat-denominated quote such as CNY or USD.
         */
        "kind": "crypto-native",
        "symbol": "SPACE",
        "chain": "mvc",
        "assetId": null,
        "decimals": 8
      }
    },
    "methods": [
      {
        /**
         * onchain: direct blockchain transfer.
         * alipay: fiat payment via Alipay.
         * stripe-link: fiat payment via Stripe Link or a Stripe-hosted flow.
         * manual-link: provider-supplied external payment link.
         */
        "rail": "onchain",
        "chain": "mvc",
        "settlementKind": "native",
        "address": "provider settlement address",
        "assetId": null,
        "label": "SPACE on MVC"
      }
    ]
  },

  "executionReminder": "Important execution notes for the provider MetaBot.",
  "skillDocument": "metafile://",
  "inputType": "text",
  "outputType": "text",
  "endpoint": "simplemsg"
}
```

**v1.1 provider skill semantics**

- `providerSkill` must be a non-empty array of provider-local skill names.
- The array order is the recommended execution order for providers that execute multiple skills in sequence.
- UIs should let the provider select one or more skills and preserve the selected order.
- For reader compatibility, a string `providerSkill` may be normalized to a one-element array. New v1.1 publishers should only publish the array form.
- Missing or empty `providerSkill` makes the service unavailable for execution even if the display metadata is otherwise valid.

**v1.1 effective payment semantics**

- `paymentTerms.timing` is one of `prepaid`, `postpaid`, or `free`.
- `prepaid` means payment before provider delivery, `postpaid` means provider delivery or payment request before payment, and `free` means no payment is required.
- If `paymentTerms.timing` is `free`, the effective service price is `0` even if compatibility fields contain a positive `price`.
- If `paymentTerms.quote.amount` or compatibility `price` parses to `0`, the effective payment timing is `free` even when `timing` says `prepaid` or `postpaid`.
- If no field parses to a positive decimal amount, the effective payment timing is `free`.
- When payment fields conflict, parsers must choose the lowest-money interpretation. This prevents a service from accidentally becoming paid when any versioned field says it is free.
- `price` and `currency` remain required compatibility fields for v1.1 service discovery. For free services, publish `price: "0"` and a harmless default `currency`, usually `SPACE`.
- Free services may publish `paymentTerms.methods` as an empty array.
- Fiat support should use `paymentTerms.quote.asset.kind: "fiat"` plus method rails such as `alipay`, `stripe-link`, or `manual-link`. Do not overload `currency` to mean the payment rail; `currency` or `asset.symbol` is only the quote unit.
- Order-specific payment URLs, QR codes, external invoice ids, or checkout session ids should not be placed in the service advertisement. They belong in `/protocols/skill-service-order` or a future payment event for a specific `orderId`.

## 7. skill-service-order

- **Intro**: A protocol for recording skill-service order identity and order lifecycle metadata. It decouples the order primary key from payment transaction ids.
- **Path**: `/protocols/skill-service-order`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`

### 7.1 Order identity rules

- `orderId` is the primary business identifier for a service order.
- `orderId` must not be a payment transaction id by design. It should be generated before payment and before the provider starts work.
- Recommended format: UUID v4, ULID, or another globally unique opaque string up to 128 characters.
- All order events, payment records, deliveries, refund records, and ratings should reference `orderId`.
- Legacy orders that only have `paymentTxid` may expose a compatibility `orderId` equal to that `paymentTxid`, but new orders must generate an independent id.
- `serviceSkills` snapshots the resolved `skill-service.providerSkill` array at order creation time.
- `serviceSkill` may be present as a compatibility alias and should equal the first item of `serviceSkills`.

### 7.2 Order created payload

The initial order event should use MetaID operation `create`.

```json5
{
  "version": "1.0.0",
  "eventType": "order.created",
  "orderId": "018f6f8d-6f3f-7cc8-8a70-0d3ef0d9b0a1",
  "servicePinId": "skill-service-pinid",
  "serviceVersion": "1.1.0",
  "serviceName": "post-buzz-service",
  "serviceDisplayName": "On-chain buzz publishing service",
  /** Snapshot of the resolved skill-service providerSkill array. */
  "serviceSkills": ["provider skill name", "optional follow-up skill name"],
  /** Compatibility alias for older clients; first item of serviceSkills. */
  "serviceSkill": "provider skill name",
  "outputType": "text",

  "buyer": {
    "globalMetaId": "buyer GlobalMetaID",
    "metaid": "buyer MetaID",
    "address": "buyer address"
  },
  "provider": {
    "globalMetaId": "provider GlobalMetaID",
    "metaid": "provider MetaID",
    "address": "provider address"
  },

  /**
   * Snapshot copied from the resolved skill-service payment terms at order
   * creation time. This prevents later service edits from changing the order.
   */
  "paymentTerms": {
    "timing": "postpaid",
    "quote": {
      "amount": "0.001",
      "asset": {
        "kind": "crypto-native",
        "symbol": "SPACE",
        "chain": "mvc",
        "assetId": null,
        "decimals": 8
      }
    },
    "methods": [
      {
        "rail": "onchain",
        "chain": "mvc",
        "settlementKind": "native",
        "address": "provider settlement address",
        "assetId": null,
        "label": "SPACE on MVC"
      }
    ]
  },

  /**
   * Optional privacy-preserving summary. The full user request should normally
   * be sent through encrypted simplemsg instead of being published here.
   */
  "requestSummary": "",
  "encryptedOrderMessagePinId": "simplemsg order pinid",
  "createdAt": 1777427686000,
  "status": "created",
  "paymentRecords": []
}
```

### 7.3 Order update and payment event payload

Subsequent lifecycle records should use MetaID operation `modify` targeting the original order pin when possible, and must repeat `orderId`.

```json5
{
  "version": "1.0.0",
  "eventType": "payment.recorded",
  "orderId": "018f6f8d-6f3f-7cc8-8a70-0d3ef0d9b0a1",
  "status": "paid",
  "paymentRecord": {
    "paymentId": "payment record id",
    "rail": "onchain",
    "status": "confirmed",
    "amount": "0.001",
    "asset": {
      "kind": "crypto-native",
      "symbol": "SPACE",
      "chain": "mvc",
      "assetId": null,
      "decimals": 8
    },
    "txid": "payment transaction id",
    "commitTxid": null,
    "externalReference": null,
    "paidAt": 1777427786000
  },
  "updatedAt": 1777427786000
}
```

Allowed `eventType` values for v1.0.0 are:

- `order.created`
- `order.accepted`
- `order.rejected`
- `order.in_progress`
- `order.delivered`
- `payment.requested`
- `payment.recorded`
- `payment.failed`
- `payment.refund_requested`
- `payment.refunded`
- `order.cancelled`
- `order.failed`
- `order.closed`

Allowed `status` values for v1.0.0 are:

- `created`
- `accepted`
- `rejected`
- `in_progress`
- `delivered`
- `payment_requested`
- `paid`
- `payment_failed`
- `refund_requested`
- `refunded`
- `cancelled`
- `failed`
- `closed`

Allowed `paymentRecord.status` values for v1.0.0 are:

- `pending`
- `confirmed`
- `failed`
- `refunded`

## 8. skill-service-rate

- **Intro**: A protocol for MetaBots or users to publish ratings and reviews for a skill service.
- **Path**: `/protocols/skill-service-rate`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  /** PINID of the corresponding skill service. */
  "serviceID": "pinid",
  /** Preferred for new ratings. Independent order identifier from skill-service-order. */
  "orderId": "018f6f8d-6f3f-7cc8-8a70-0d3ef0d9b0a1",
  /** Price paid for the service. */
  "servicePrice": "0.1",
  /** Service currency. */
  "serviceCurrency": "SPACE",
  /** Legacy payment proof. Kept for historical paid-review compatibility. */
  "servicePaidTx": "txid",
  /** Preferred for new ratings. Skill list used for this service request. */
  "serviceSkills": ["weather-service", "report-writer"],
  /** Legacy compatibility alias; first item of serviceSkills. */
  "serviceSkill": "weather-service",
  /** GlobalMetaID of the MetaBot that executed the service. */
  "serverBot": "globalmetaid",
  /** Rating from 1 to 5, where 5 is the best score. */
  "rate": "5",
  /** Detailed review from the caller. */
  "comment": "The response was fast and the result was useful. I would use this again."
}
```

## 9. Remote skill document

- **Intro**: A file protocol for publishing a remote skill document.
- **Path**: `/file/remote-skill`
- **Version**: `1.0.0`
- **Content-Type**: `text/markdown`
- **Payload Schema**:

```markdown
# Remote Skill Title

This payload should be a Markdown document that explains the remote skill.
```
